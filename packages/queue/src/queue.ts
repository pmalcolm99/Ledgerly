import "server-only";

import { Queue } from "bullmq";

import { getRedisConnection } from "./redis";

/**
 * `receipt-extract` — the AI-extraction queue (Phase 6, ARCHITECTURE.md
 * §6). `packages/queue/src/worker.ts` processes it via
 * `pipeline/extract.ts`'s `processReceiptExtraction`, `autorun: true`.
 * Phase 5's `receipt-ingest` worker (ingestWorker.ts) enqueues onto this
 * queue on successful ingest.
 */
export const RECEIPT_EXTRACT_QUEUE_NAME = "receipt-extract";

let sharedReceiptExtractQueue: Queue | undefined;

export function getReceiptExtractQueue(redisUrl: string): Queue {
  if (!sharedReceiptExtractQueue) {
    sharedReceiptExtractQueue = new Queue(RECEIPT_EXTRACT_QUEUE_NAME, {
      connection: getRedisConnection(redisUrl),
      defaultJobOptions: {
        // Task 6.9: backoff on 429/529, 3 attempts, then `failed` with
        // images intact. Same convention as getReceiptIngestQueue below --
        // expressed at the queue level so `worker.ts`'s `"failed"` handler
        // can read `job.opts.attempts` to decide whether retries are
        // exhausted, and so the Anthropic client itself is constructed
        // with `maxRetries: 0` (no double retry layer).
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        // BullMQ's own default keeps every completed/failed job in Redis
        // indefinitely. Every enqueue onto this queue uses `jobId:
        // receiptId` for dedup (both the receipt-ingest handoff and
        // receipts.reextract) -- without this, a completed job's record
        // would still occupy that id, and re-adding the SAME jobId for a
        // manual re-extract would silently no-op instead of running
        // (BullMQ never re-runs an existing job id). Removing immediately
        // on completion/failure keeps the id free for reuse; the durable
        // record of what happened is `receipts.extraction_error`/
        // `extraction_raw`/`ai_usage`, not the Redis-resident job.
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    });
  }
  return sharedReceiptExtractQueue;
}

/**
 * `receipt-ingest` — Phase 5's render-pipeline queue (task 5.10,
 * ARCHITECTURE.md §5's "Processing queue" section). The upload Route
 * Handler enqueues here after a receipt row is created
 * (`extraction_status='pending'`); `ingestWorker.ts` processes it and, on
 * success, enqueues `receipt-extract` above. Distinct from that queue —
 * ingest (rasterize/orient/strip/render) and AI extraction are sequential
 * stages, not the same stage.
 */
export const RECEIPT_INGEST_QUEUE_NAME = "receipt-ingest";

let sharedReceiptIngestQueue: Queue | undefined;

export function getReceiptIngestQueue(redisUrl: string): Queue {
  if (!sharedReceiptIngestQueue) {
    sharedReceiptIngestQueue = new Queue(RECEIPT_INGEST_QUEUE_NAME, {
      connection: getRedisConnection(redisUrl),
      defaultJobOptions: {
        // Every enqueue site gets this without repeating it -- ingestWorker.ts's
        // `worker.on("failed", ...)` reads `job.opts.attempts` to decide
        // whether retries are exhausted.
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      },
    });
  }
  return sharedReceiptIngestQueue;
}
