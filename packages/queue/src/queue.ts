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
 *
 * **The separator is a hyphen, and it is not a style choice.** BullMQ builds
 * its Redis keys as `bull:<queue>:<jobId>` and REJECTS a custom id containing
 * `:` — `add()` throws `Custom Id cannot contain :`. This function returned
 * `${receiptId}:auto` from the day it was written, so every automatic enqueue
 * threw, and `worker.ts` catches enqueue failures on purpose (a Redis hiccup
 * must not fail an extraction that has already been paid for). The result was
 * a feature that had never once worked, in a way nothing surfaced: manual
 * sends were fine because they pass no id at all, and the only trace was one
 * `console.error` per receipt in the container log.
 *
 * `assertUsableJobId` below is what stops the next id from doing it again.
 */
export function autoEmailJobId(receiptId: string): string {
  return assertUsableJobId(`${receiptId}-auto`);
}

/**
 * Rejects a job id BullMQ will refuse, at the point it is built rather than at
 * the point it is added.
 *
 * The failure this guards is not "the job errors" — it is "the job is never
 * created and the caller has already decided that enqueue failures are not
 * worth failing over". Anything that turns that into a loud, immediate,
 * testable throw is worth the three lines.
 */
export function assertUsableJobId(jobId: string): string {
  if (jobId.includes(":")) {
    throw new Error(
      `BullMQ job ids cannot contain ":" (got "${jobId}") — it is the Redis key separator.`,
    );
  }
  return jobId;
}

/**
 * `backup` — Phase 9's queue, and the third of the three D-08 reserved (the
 * second, `export`, stayed unbuilt: D-37 streams exports from a Route Handler
 * instead, so this is the only one still owed).
 *
 * Carries both kinds of backup. A manual one is added by `admin.createBackup`
 * against a row it has already inserted; a scheduled one is produced by the
 * job scheduler below, which supplies no row and lets `backupWorker.ts` create
 * one. Same processor either way — a scheduled backup that behaves differently
 * from the one you tested by hand is not a backup you have tested.
 */
export const BACKUP_QUEUE_NAME = "backup";

let sharedBackupQueue: Queue | undefined;

export function getBackupQueue(redisUrl: string): Queue {
  if (!sharedBackupQueue) {
    sharedBackupQueue = new Queue(BACKUP_QUEUE_NAME, {
      connection: getRedisConnection(redisUrl),
      defaultJobOptions: {
        // Two, not three. A retry is worth having for a database that was
        // briefly unreachable, but a backup is expensive in wall time and disk
        // and most of its failure modes (no space, a missing binary, a bad
        // password) are not helped by repeating them — those are thrown as
        // non-retryable `BackupError`s and stop after one attempt regardless.
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        // Both `count: 0`, for the reason spelled out on the receipt-email
        // queue above: a retained job hash makes a later `add` with the same id
        // a silent success that runs nothing. Manual backups use the row id as
        // the job id, and the scheduler reuses its own id on every tick, so
        // this queue would hit that bug on its second scheduled run.
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    });
  }
  return sharedBackupQueue;
}

/**
 * The one repeatable job in the app (task 9.3).
 *
 * A single fixed scheduler id, so `upsertJobScheduler` REPLACES the schedule
 * rather than accumulating one scheduler per cron string ever configured.
 * That is the whole reason the admin screen can change the cron and have it
 * take effect without a restart: reconciliation is an upsert against a known
 * id, not a diff over a set.
 */
export const BACKUP_SCHEDULER_ID = "nightly-backup";

export async function upsertBackupSchedule(redisUrl: string, cron: string): Promise<void> {
  await getBackupQueue(redisUrl).upsertJobScheduler(
    BACKUP_SCHEDULER_ID,
    { pattern: cron },
    { name: "scheduled-backup", data: { kind: "scheduled" } },
  );
}

export async function removeBackupSchedule(redisUrl: string): Promise<void> {
  await getBackupQueue(redisUrl).removeJobScheduler(BACKUP_SCHEDULER_ID);
}

/**
 * When the scheduler will next fire, straight from Redis.
 *
 * Deliberately read from BullMQ rather than computed from the stored cron: the
 * question the admin screen has to answer is not "what would this cron do" but
 * "is a backup actually going to happen". Those differ precisely when
 * something is wrong — a configured cron with no registered scheduler — and
 * that is the case worth surfacing, so `null` here is a finding, not a blank.
 */
export async function getBackupScheduleState(
  redisUrl: string,
): Promise<{ registered: boolean; pattern: string | null; nextRunAt: Date | null }> {
  const scheduler = await getBackupQueue(redisUrl).getJobScheduler(BACKUP_SCHEDULER_ID);
  if (!scheduler) return { registered: false, pattern: null, nextRunAt: null };
  return {
    registered: true,
    pattern: scheduler.pattern ?? null,
    nextRunAt: typeof scheduler.next === "number" ? new Date(scheduler.next) : null,
  };
}
