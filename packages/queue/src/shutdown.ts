import "server-only";

import type { Worker } from "bullmq";
import { getPool } from "@ledgerly/db/client";

import { getRedisConnection } from "./redis";

/**
 * packages/queue/src/shutdown.ts — graceful worker shutdown (D-19).
 * Nothing in this repo handled `SIGTERM`/`SIGINT` before Phase 6;
 * `worker.ts`'s old stub comment called this out as still owed. One
 * handler for every BullMQ worker the process runs: stop accepting new
 * jobs, let in-flight ones finish (`Worker.close()`'s own contract), then
 * close the shared pg pool and Redis connection (review finding L-7 — an
 * earlier version called `process.exit()` straight after `Worker.close()`,
 * leaving both open; harmless in that the process is exiting either way,
 * but sloppy and it skipped Next's own HTTP-server drain by never letting
 * the event loop go idle first), then exit. Registered once — a second
 * `docker stop` sending a repeat signal during the grace period does not
 * double-run this.
 *
 * `docker-compose.yml`'s `webapp` service sets `stop_grace_period` (L-7)
 * so an in-flight Sonnet extraction (which can run tens of seconds) has
 * room to finish before Docker escalates to SIGKILL rather than being cut
 * off mid-call.
 */

let registered = false;

export function registerGracefulShutdown(workers: Worker[], redisUrl: string): void {
  if (registered) return;
  registered = true;

  const shutdown = (signal: string): void => {
    console.log(`[ledgerly] received ${signal}, closing ${workers.length} worker(s)...`);
    void Promise.all(workers.map((worker) => worker.close()))
      .then(async () => {
        console.log("[ledgerly] workers closed cleanly, closing pg pool and Redis connection...");
        await Promise.allSettled([getPool().end(), getRedisConnection(redisUrl).quit()]);
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("[ledgerly] error while closing workers:", error);
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
