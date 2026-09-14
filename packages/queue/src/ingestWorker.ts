import "server-only";

import { and, eq, isNull, lt } from "drizzle-orm";
import { Worker, type Job } from "bullmq";
import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";
import { receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import { deleteReceiptFile, receiptFilePath } from "@ledgerly/api/storage";

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

      // Read the project in its own statement, BEFORE the status write.
      //
      // Taking it from the UPDATE's RETURNING made the cleanup below
      // conditional on that write succeeding, so a connection blip left the
      // raw upload on disk with nothing to come back for it. These are two
      // independent obligations -- record the failure, and discard the
      // staged bytes -- and they should fail independently.
      let projectId: string | null = null;
      try {
        const [row] = await db
          .select({ projectId: receipts.projectId })
          .from(receipts)
          .where(eq(receipts.id, job.data.receiptId))
          .limit(1);
        projectId = row?.projectId ?? null;
      } catch (lookupError) {
        console.error(
          `[ledgerly] receipt ${job.data.receiptId}: could not read the project for staging cleanup:`,
          lookupError,
        );
      }

      try {
        await db
          .update(receipts)
          .set({ extractionStatus: "failed", extractionError: reason, updatedAt: new Date() })
          .where(eq(receipts.id, job.data.receiptId));
      } catch (dbError) {
        // Never let a failure to record the failure escape as an
        // unhandled rejection out of a BullMQ event handler. An operator
        // reading logs can still recover the receipt by hand.
        console.error(
          `[ledgerly] failed to record ingest failure for receipt ${job.data.receiptId}:`,
          dbError,
        );
      }

      // Phase 10a finding F-8: discard the staged upload now that this
      // receipt is terminally failed.
      //
      // `staging.bin` is the upload EXACTLY as it arrived -- full EXIF,
      // including the GPS tag a phone writes, which for a receipt photo is
      // usually the user's home or workplace. It is consumed on the success
      // path (renamed to `original.<ext>` or deleted, ingest.ts), but the
      // failure path used to leave it, and nothing ever came back for it:
      // `reconcilePendingReceipts` below only re-enqueues rows still
      // `pending`, so a row already marked `failed` is never revisited. The
      // file was immortal, and `BACKUP_INCLUDE_IMAGES` would carry it into
      // every archive thereafter.
      //
      // This does not weaken CLAUDE.md's "never silently drop an upload":
      // the receipt row survives, `extraction_status='failed'` and
      // `extraction_error` record exactly what happened, and the user sees
      // it in the review queue. What is dropped is an unreadable blob that
      // no code path could ever have used again -- and it is not silent,
      // because the log line below says so.
      if (projectId !== null) {
        try {
          await deleteReceiptFile(
            receiptFilePath(env.UPLOADS_DIR, projectId, job.data.receiptId, "staging", "bin"),
          );
          console.warn(
            `[ledgerly] receipt ${job.data.receiptId}: ingest failed (${reason}); staged upload discarded`,
          );
        } catch (unlinkError) {
          // A leftover file is a disk-space and privacy leak, not a
          // correctness bug -- the same reasoning ingest.ts uses for its
          // own cleanup. Log it and move on.
          console.error(
            `[ledgerly] receipt ${job.data.receiptId}: failed to discard staged upload:`,
            unlinkError,
          );
        }
      }
    })();
  });

  sharedIngestWorker = worker;

  await reconcilePendingReceipts(db, redisUrl);

  return worker;
}
