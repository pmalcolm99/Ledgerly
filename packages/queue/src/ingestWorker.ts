import "server-only";

import { and, eq, isNull, lt } from "drizzle-orm";
import { Worker, type Job } from "bullmq";
import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";
import { receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";

import { getRedisConnection } from "./redis";
import { RECEIPT_INGEST_QUEUE_NAME, getReceiptExtractQueue, getReceiptIngestQueue } from "./queue";
import { IngestError, processReceiptIngest } from "./pipeline/ingest";
import type { IngestJobData } from "./pipeline/ingest";

/**
 * packages/queue/src/ingestWorker.ts — the real `receipt-ingest` worker
 * (task 5.10). Unlike `worker.ts`'s Phase 6 stub, this one actually runs:
 * `autorun: true`, concurrency from `INGEST_CONCURRENCY`.
 *
 * On success, enqueues `receipt-extract` — that queue's own worker
 * (`worker.ts`) stays `autorun: false` until Phase 6, so the job just sits
 * there. Expected (see queue.ts's comment). Enqueued with `jobId:
 * receiptId` so a retried `receipt-ingest` job (e.g. this enqueue itself
 * failed and the whole job retried) can't create a second `receipt-extract`
 * job for the same receipt — BullMQ treats adding a job with an id that
 * already exists as a no-op rather than a duplicate.
 *
 * On failure, BullMQ retries per `getReceiptIngestQueue`'s
 * `defaultJobOptions` (3 attempts, exponential backoff). `worker.on`
 * ("failed", ...) below marks a receipt `extraction_status='failed'` once
 * `job.attemptsMade` reaches the configured attempt count.
 * `pipeline/ingest.ts`'s `processReceiptIngest` never writes failure state
 * itself; it only throws.
 *
 * That "failed" handler is a fast path, not the only backstop: BullMQ's
 * exact event semantics for a job that STALLS (worker process killed or
 * blocked past its lock renewal) rather than throwing are not something
 * this code relies on getting exactly right (review finding M-6). Instead,
 * `reconcilePendingReceipts`, run once at startup, is the durable
 * guarantee: any receipt still `pending` with no render and no recent
 * activity gets a fresh `receipt-ingest` job. Same D-08 principle Phase 6
 * documents for its own queue, applied here for this one — CLAUDE.md's
 * "never silently drop an upload" needs to hold regardless of which BullMQ
 * failure path a given crash happens to take.
 */

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

async function reconcilePendingReceipts(db: Database, redisUrl: string): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stale = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.extractionStatus, "pending"),
        isNull(receipts.imageKey),
        isNull(receipts.deletedAt),
        lt(receipts.createdAt, staleBefore),
      ),
    );

  if (stale.length === 0) return;

  console.warn(
    `[ledgerly] reconciling ${stale.length} stale pending receipt(s) with no render and no ` +
      `recent activity -- re-enqueuing receipt-ingest`,
  );
  const queue = getReceiptIngestQueue(redisUrl);
  for (const row of stale) {
    // jobId: receiptId -- if a job for this receipt is still genuinely
    // active/waiting (this sweep is merely being cautious, not certain
    // it's actually lost), this is a harmless no-op rather than a
    // duplicate concurrent processor.
    await queue.add("ingest", { receiptId: row.id }, { jobId: row.id });
  }
}

let sharedIngestWorker: Worker<IngestJobData> | undefined;

export async function startIngestWorker(redisUrl: string): Promise<Worker<IngestJobData>> {
  if (sharedIngestWorker) return sharedIngestWorker;

  const env = getEnv();
  const db = getDb();

  const worker = new Worker<IngestJobData>(
    RECEIPT_INGEST_QUEUE_NAME,
    async (job: Job<IngestJobData>) => {
      await processReceiptIngest(
        {
          db,
          uploadsDir: env.UPLOADS_DIR,
          retainOriginals: env.RETAIN_ORIGINALS,
          maxMegapixels: env.MAX_UPLOAD_MEGAPIXELS,
        },
        job.data,
      );
      await getReceiptExtractQueue(redisUrl).add(
        "extract",
        { receiptId: job.data.receiptId },
        { jobId: job.data.receiptId },
      );
    },
    {
      connection: getRedisConnection(redisUrl),
      concurrency: env.INGEST_CONCURRENCY,
      autorun: true,
    },
  );

  worker.on("failed", (job, error) => {
    void (async () => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < attempts) return; // still has retries left -- not final yet

      const reason = error instanceof IngestError ? error.reason : "INGEST_FAILED";
      try {
        await db
          .update(receipts)
          .set({ extractionStatus: "failed", extractionError: reason, updatedAt: new Date() })
          .where(eq(receipts.id, job.data.receiptId));
      } catch (dbError) {
        // Never let a failure to record the failure escape as an
        // unhandled rejection out of a BullMQ event handler. The staged
        // upload is untouched regardless -- CLAUDE.md's "never silently
        // drop an upload" holds even if this particular write fails; an
        // operator reading logs can still recover the receipt by hand.
        console.error(
          `[ledgerly] failed to record ingest failure for receipt ${job.data.receiptId}:`,
          dbError,
        );
      }
    })();
  });

  sharedIngestWorker = worker;

  await reconcilePendingReceipts(db, redisUrl);

  return worker;
}
