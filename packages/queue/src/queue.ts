import "server-only";

import { Queue } from "bullmq";

import { getRedisConnection } from "./redis";

/**
 * `receipt-extract` — Phase 6's AI-extraction queue. The job name matches
 * ARCHITECTURE.md §5's pipeline description; the payload type and the
 * processor that consumes it are Phase 6 scope (packages/queue/src/worker.ts
 * still stubs the processor, `autorun: false`). Phase 5's `receipt-ingest`
 * worker (ingestWorker.ts) enqueues onto this queue on successful ingest —
 * jobs will sit here unprocessed until Phase 6 flips that worker's autorun
 * on. Expected, not a bug.
 */
export const RECEIPT_EXTRACT_QUEUE_NAME = "receipt-extract";

let sharedReceiptExtractQueue: Queue | undefined;

export function getReceiptExtractQueue(redisUrl: string): Queue {
  if (!sharedReceiptExtractQueue) {
    sharedReceiptExtractQueue = new Queue(RECEIPT_EXTRACT_QUEUE_NAME, {
      connection: getRedisConnection(redisUrl),
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
