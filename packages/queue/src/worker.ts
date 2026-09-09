import "server-only";

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";
import { receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";

import { getRedisConnection } from "./redis";
import { RECEIPT_EXTRACT_QUEUE_NAME, getReceiptExtractQueue } from "./queue";
import { ExtractError, processReceiptExtraction } from "./pipeline/extract";
import type { ExtractJobData } from "./pipeline/extract";

/**
 * packages/queue/src/worker.ts — the real `receipt-extract` worker
 * (task 6.1, D-19). Was a stub through Phase 5 (`autorun: false`, always
 * threw); now delegates to `pipeline/extract.ts`'s
 * `processReceiptExtraction`, mirroring `ingestWorker.ts`'s shape:
 * `autorun: true`, concurrency from `AI_CONCURRENCY` (a DIFFERENT knob
 * from `INGEST_CONCURRENCY` — see `packages/config/src/env.ts`'s own
 * comment on that), a `"failed"` handler that only writes terminal
 * `extraction_status='failed'` once BullMQ's attempts are exhausted, and a
 * startup reconciliation sweep.
 *
 * The Anthropic client is constructed here (not inside `pipeline/extract.ts`,
 * which takes it as an injected dependency for testability) with
 * `maxRetries: 0` — retry/backoff is expressed at the BullMQ queue level
 * (`queue.ts`'s `defaultJobOptions`), not layered under the SDK's own
 * retry too. `ANTHROPIC_API_KEY` is read only here, inside
 * `packages/queue` — never imported into `apps/web` client code, never
 * logged (CLAUDE.md hard rule).
 */

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Same D-08 reconciliation principle as `ingestWorker.ts`'s
 * `reconcilePendingReceipts`, filtering `receipts_pending_idx` the OTHER
 * direction: that sweep re-enqueues receipts with NO render yet
 * (`imageKey IS NULL`, ingest never ran or never finished); this one
 * re-enqueues receipts whose render exists (`imageKey IS NOT NULL`, ingest
 * finished) but are still `pending` with no recent activity — extraction
 * never ran or got stuck.
 */
async function reconcilePendingExtractions(db: Database, redisUrl: string): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stale = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.extractionStatus, "pending"),
        isNotNull(receipts.imageKey),
        isNull(receipts.deletedAt),
        lt(receipts.updatedAt, staleBefore),
      ),
    );

  if (stale.length === 0) return;

  console.warn(
    `[ledgerly] reconciling ${stale.length} stale pending receipt(s) with a render but no ` +
      `recent extraction activity -- re-enqueuing receipt-extract`,
  );
  const queue = getReceiptExtractQueue(redisUrl);
  for (const row of stale) {
    // jobId: receiptId -- harmless no-op if a job for this receipt is
    // still genuinely active, same reasoning as ingestWorker.ts's sweep.
    await queue.add("extract", { receiptId: row.id }, { jobId: row.id });
  }
}

let sharedExtractWorker: Worker<ExtractJobData> | undefined;

export async function startWorkers(redisUrl: string): Promise<Worker<ExtractJobData>> {
  if (sharedExtractWorker) return sharedExtractWorker;

  const env = getEnv();
  const db = getDb();
  const anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });

  const worker = new Worker<ExtractJobData>(
    RECEIPT_EXTRACT_QUEUE_NAME,
    async (job: Job<ExtractJobData>) => {
      try {
        await processReceiptExtraction(
          {
            db,
            anthropicClient,
            uploadsDir: env.UPLOADS_DIR,
            maxMegapixels: env.MAX_UPLOAD_MEGAPIXELS,
            modelPass1: env.AI_MODEL_PASS1,
            modelPass2: env.AI_MODEL_PASS2,
            escalateBelow: env.AI_ESCALATE_BELOW,
          },
          job.data,
        );
      } catch (error) {
        // M-4: a 400/401/403/404 from Anthropic (a malformed request, a
        // bad/revoked API key, no model access) cannot succeed on retry --
        // burning all 3 attempts with exponential backoff between them
        // only delays the receipt landing in the review queue. BullMQ
        // skips remaining retries for any error it recognizes as
        // `UnrecoverableError` regardless of `attemptsMade`; the reason
        // code rides along as `.message` so the "failed" handler below
        // still recovers it.
        if (error instanceof ExtractError && !error.retryable) {
          throw new UnrecoverableError(error.reason);
        }
        throw error;
      }
    },
    {
      connection: getRedisConnection(redisUrl),
      concurrency: env.AI_CONCURRENCY,
      autorun: true,
    },
  );

  worker.on("failed", (job, error) => {
    void (async () => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      const isUnrecoverable = error?.name === "UnrecoverableError";
      // An UnrecoverableError short-circuits BullMQ's own retry decision
      // regardless of `attemptsMade` (it may fire on the very first
      // attempt) -- without this check, a non-retryable failure on
      // attempt 1 of 3 would be mistaken for "still has retries left" and
      // never get its terminal DB write.
      if (!isUnrecoverable && job.attemptsMade < attempts) return;

      const reason =
        error instanceof ExtractError
          ? error.reason
          : isUnrecoverable && error.message
            ? error.message
            : "AI_EXTRACTION_FAILED";
      try {
        await db
          .update(receipts)
          // L-2: a receipt soft-deleted while its extraction job was
          // queued/running must not have its status rewritten by this
          // handler -- same liveness predicate `extract.ts`'s own
          // persistence transaction composes.
          .set({ extractionStatus: "failed", extractionError: reason, updatedAt: new Date() })
          .where(and(eq(receipts.id, job.data.receiptId), isNull(receipts.deletedAt)));
      } catch (dbError) {
        // Never let a failure to record the failure escape as an
        // unhandled rejection out of a BullMQ event handler. Images and
        // the receipt row are untouched regardless -- CLAUDE.md's "never
        // lose an upload to an API failure" holds even if this write
        // fails; an operator reading logs can still recover by hand.
        console.error(
          `[ledgerly] failed to record extraction failure for receipt ${job.data.receiptId}:`,
          dbError,
        );
      }
    })();
  });

  sharedExtractWorker = worker;

  await reconcilePendingExtractions(db, redisUrl);

  return worker;
}
