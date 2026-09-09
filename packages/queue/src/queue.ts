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

/**
 * `receipt-email` — D-44's notification queue, the third stage after
 * `receipt-ingest` -> `receipt-extract`. `emailWorker.ts` processes it.
 *
 * A separate queue rather than a step inside extraction, for a reason worth
 * stating at the enqueue site too: a mail relay must never be in the retry
 * path of a job that spends money. See `pipeline/email.ts`'s header.
 */
export const RECEIPT_EMAIL_QUEUE_NAME = "receipt-email";

let sharedReceiptEmailQueue: Queue | undefined;

export function getReceiptEmailQueue(redisUrl: string): Queue {
  if (!sharedReceiptEmailQueue) {
    sharedReceiptEmailQueue = new Queue(RECEIPT_EMAIL_QUEUE_NAME, {
      connection: getRedisConnection(redisUrl),
      defaultJobOptions: {
        // More attempts than the other two queues, and a longer first delay.
        // A relay is a third party with its own rate limits and maintenance
        // windows, and unlike an Anthropic call a retry here costs nothing.
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        // BOTH must be `count: 0`, and the failure half is the one that bites.
        //
        // BullMQ's `addStandardJob` returns early — reporting SUCCESS — the
        // moment a job hash with the same id already exists, and
        // `moveToFinished` only deletes that hash when the retention count is
        // zero. Retaining failures would therefore leave
        // `bull:receipt-email:<receiptId>:auto` resident forever after a
        // terminal failure, and every later enqueue for that receipt would be
        // a silent no-op that throws nothing for the caller to catch.
        //
        // That is not hypothetical: turn the project toggle on before
        // configuring SMTP and every receipt uploaded in that window fails
        // with `SMTP_NOT_CONFIGURED`. Retaining those hashes would mean that
        // once SMTP is configured, those receipts can NEVER auto-email —
        // including via re-extract, which is the obvious remedy and the whole
        // reason `receipt_email_sent_at` exists. The durable record of a
        // failure is the log line in `emailWorker.ts`'s `failed` handler, not
        // the Redis-resident job.
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    });
  }
  return sharedReceiptEmailQueue;
}

/**
 * Job ids for `receipt-email`. NOT the bare `receiptId` the other two queues
 * use.
 *
 * Those queues dedup on `receiptId` because a second render or a second
 * extraction of the same receipt is waste. A second EMAIL is a feature — the
 * on-demand send exists precisely to send one again. With
 * `removeOnComplete: {count: 0}` the completed job's id is freed, but a job
 * still resident (waiting, active, or mid-backoff) would silently swallow the
 * re-send, and BullMQ reports that as success.
 *
 * So: the automatic send gets a stable id, because sending it twice is the one
 * thing the whole `receipt_email_sent_at` marker exists to prevent; an
 * on-demand send gets none at all, so every request is its own job.
 */
export function autoEmailJobId(receiptId: string): string {
  return `${receiptId}:auto`;
}
