import "server-only";

import { Queue } from "bullmq";

import { getRedisConnection } from "./redis";

/**
 * Minimal Phase 2 scaffolding — see redis.ts. The `receipt-extract` job
 * name matches ARCHITECTURE.md §5's pipeline description; the job payload
 * type and the processor that consumes it are Phase 5/6 scope.
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
