import "server-only";

import { Worker } from "bullmq";
import sharp from "sharp";

import { getRedisConnection } from "./redis";
import { RECEIPT_EXTRACT_QUEUE_NAME } from "./queue";

/**
 * Minimal Phase 2 scaffolding (D-19: scaffolding ported now, the real
 * pipeline body is Phase 6). `apps/web/instrumentation.ts` imports this
 * module through the `@ledgerly/queue/worker` package subpath — that
 * subpath import, plus this file's own top-level imports of `sharp` and
 * `bullmq` (which pulls in `ioredis`), is what makes all three packages
 * reachable from the Next.js build graph and land in
 * `.next/standalone/node_modules` — task 2.8's explicit acceptance
 * criterion (ARCHITECTURE.md §8.1 notes this is the same file-tracing
 * caveat that bit Forkd's dynamically-imported `playwright-core`).
 *
 * Nothing here connects to Redis at import time — only `startWorkers()`,
 * below, does that, and Phase 2's `instrumentation.ts` does not call it.
 * Phase 6 task 6.1 replaces the processor stub with the real
 * receipt-extract pipeline and wires `startWorkers()` into
 * `instrumentation.ts`'s `register()`.
 */

/** Touches the real sharp binding (rather than only the type import) so it
 * is not eligible for dead-code elimination before the build's file tracer
 * ever sees it used. */
export function sharpRuntimeVersions(): Record<string, string> {
  return sharp.versions;
}

let started = false;

export async function startWorkers(redisUrl: string): Promise<void> {
  if (started) return;
  started = true;

  // autorun: false — constructed but not yet processing. Phase 6 replaces
  // this processor and flips autorun on alongside the graceful-shutdown
  // wiring D-19 calls for.
  new Worker(
    RECEIPT_EXTRACT_QUEUE_NAME,
    async () => {
      throw new Error("receipt-extract worker is not implemented yet (Phase 6, D-19).");
    },
    { connection: getRedisConnection(redisUrl), autorun: false },
  );
}
