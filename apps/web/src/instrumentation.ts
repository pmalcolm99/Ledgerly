/**
 * Next.js instrumentation entrypoint — `register()` runs once per server
 * runtime instance this app starts (ARCHITECTURE.md §7.1, D-14).
 *
 * The `NEXT_RUNTIME === "nodejs"` guard is a platform necessity, not a
 * feature flag: `@ledgerly/config/env` imports Node built-ins (`buffer`)
 * and `server-only`, neither of which is available when Next.js bundles
 * this file for the Edge Runtime (Phase 3's `proxy.ts` middleware will run
 * there). Without the guard, the edge bundle would fail to even evaluate.
 * Within the nodejs runtime — the one that actually serves every request in
 * this app, since the edge runtime only ever runs the auth perimeter check
 * — the import is unconditional: no feature flag, no try/catch, nothing
 * that could silently skip it. That is what makes this a startup guard
 * (D-05: `DEV_AUTH_BYPASS` + `NODE_ENV=production` refuses to boot) rather
 * than a request-time check — the process does not exist in the unsafe
 * state, because this import throws and exits non-zero before the server
 * ever starts listening.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // CALLED, not merely imported. `getEnv()` is lazy so that route
    // modules can import config without a `next build` needing production
    // secrets; invoking it here is what keeps D-05/D-14 a startup guard —
    // a misconfigured process throws and exits non-zero before the server
    // ever listens, rather than failing later on some unlucky route.
    // Imported once and reused below (for startIngestWorker) — getEnv()
    // is itself cached after the first call, so calling it twice would
    // have been harmless, but there's no reason to.
    const { getEnv } = await import("@ledgerly/config/env");
    let env: ReturnType<typeof getEnv>;
    try {
      env = getEnv();
    } catch (error) {
      // Without this, a throw here becomes an `unhandledRejection` that
      // Next logs and then survives: the process keeps running, binds a
      // port, and serves 500s forever. `restart: always` does not help,
      // because the container never exits. D-05 says the process must not
      // *exist* in the unsafe state, so make that literally true.
      console.error("[ledgerly] FATAL: invalid configuration — refusing to start.");
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    // Both workers have real processors and run with `autorun: true`:
    // receipt-ingest (Phase 5, packages/queue/src/pipeline/ingest.ts) and
    // receipt-extract (Phase 6, packages/queue/src/pipeline/extract.ts).
    // Their subpath imports are also what makes sharp, bullmq, and
    // ioredis reachable from the build's file trace — task 2.8's
    // acceptance criterion (`.next/standalone/node_modules` must contain
    // all three, ARCHITECTURE.md §8.1) — as a byproduct of genuinely using
    // them, not as a dummy touch.
    const { startWorkers } = await import("@ledgerly/queue/worker");
    const extractWorker = await startWorkers(env.REDIS_URL);

    const { startIngestWorker } = await import("@ledgerly/queue/ingestWorker");
    const ingestWorker = await startIngestWorker(env.REDIS_URL);

    // D-44's third stage. Separate from receipt-extract on purpose: a mail
    // relay must never sit in the retry path of a job that spends money.
    const { startEmailWorker } = await import("@ledgerly/queue/emailWorker");
    const emailWorker = await startEmailWorker(env.REDIS_URL);

    // Phase 9's backup worker. Its own queue rather than a step anywhere
    // else, and its boot sweep is what reconciles the nightly schedule from
    // `app_config` into Redis — Redis is not in any backup, so after a
    // `redis_data` loss an unregistered scheduler is the normal state.
    const { startBackupWorker } = await import("@ledgerly/queue/backupWorker");
    const backupWorker = await startBackupWorker(env.REDIS_URL);

    // D-19's graceful-shutdown wiring: stop accepting new jobs and let
    // in-flight ones finish on SIGTERM/SIGINT, rather than the process
    // being killed mid-job (`docker stop`, a rolling deploy).
    const { registerGracefulShutdown } = await import("@ledgerly/queue");
    registerGracefulShutdown(
      [extractWorker, ingestWorker, emailWorker, backupWorker],
      env.REDIS_URL,
    );
  }
}
