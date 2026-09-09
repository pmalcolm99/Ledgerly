import "server-only";

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";
import { resolveAiKey } from "@ledgerly/api/aiKey";
import { receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";

import { getRedisConnection } from "./redis";
import {
  RECEIPT_EXTRACT_QUEUE_NAME,
  autoEmailJobId,
  getReceiptEmailQueue,
  getReceiptExtractQueue,
} from "./queue";
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

  /**
   * The API key is resolved PER JOB, not once at startup.
   *
   * Since D-39 the key can be set from the admin screen into `app_config`,
   * which means a client constructed at boot would keep using a key the
   * operator has since replaced — and the symptom would be "I saved the key
   * and extraction still fails", with a restart as the undocumented fix.
   * Resolving per job costs one indexed row read and a decrypt.
   *
   * The `Anthropic` client itself is still cached, keyed on the resolved
   * secret: building one per job would discard its connection pool on every
   * receipt. The cache holds exactly one entry, so a key change drops the
   * old client rather than accumulating one per key ever seen.
   */
  let cached: { key: string; client: Anthropic } | undefined;

  async function anthropicForJob(): Promise<Anthropic> {
    const { apiKey, source } = await resolveAiKey(db, env.MASTER_KEY, env.ANTHROPIC_API_KEY);
    if (source === "undecryptable") {
      // A stored key exists but MASTER_KEY cannot read it. Its own reason
      // code, not the generic one: the fix is "restore the right MASTER_KEY,
      // or clear the row", which is nothing like "go and set a key".
      throw new ExtractError("ANTHROPIC_KEY_UNDECRYPTABLE", { retryable: false });
    }
    if (!apiKey) {
      // Non-retryable: no amount of backoff produces a key. The receipt
      // lands in the review queue with its images intact, and the reason
      // code tells the operator exactly which screen fixes it.
      throw new ExtractError("ANTHROPIC_KEY_NOT_CONFIGURED", { retryable: false });
    }
    if (cached?.key !== apiKey) {
      cached = { key: apiKey, client: new Anthropic({ apiKey, maxRetries: 0 }) };
      console.log(`[ledgerly] Anthropic client initialised from ${source}`);
    }
    return cached.client;
  }

  const worker = new Worker<ExtractJobData>(
    RECEIPT_EXTRACT_QUEUE_NAME,
    async (job: Job<ExtractJobData>) => {
      try {
        await processReceiptExtraction(
          {
            db,
            anthropicClient: await anthropicForJob(),
            uploadsDir: env.UPLOADS_DIR,
            maxMegapixels: env.MAX_UPLOAD_MEGAPIXELS,
            modelPass1: env.AI_MODEL_PASS1,
            modelPass2: env.AI_MODEL_PASS2,
            escalateBelow: env.AI_ESCALATE_BELOW,
          },
          job.data,
        );

        // D-44. AFTER extraction returns, and deliberately outside its
        // persistence transaction — an email that succeeds against a
        // transaction that then rolls back is an email nobody can recall.
        //
        // Nothing here is allowed to fail this job. Extraction has already
        // committed and already been paid for; a Redis hiccup while queueing a
        // NOTIFICATION must not throw it back into a retry that would spend
        // two more Anthropic calls to reproduce a result already in the
        // database. The email queue's own retries are the recovery path, and
        // if the enqueue itself is lost, the missing email is the whole cost.
        //
        // Whether an email is actually wanted is decided at send time, by the
        // project's `email_receipts` setting and the `receipt_email_sent_at`
        // marker (pipeline/email.ts) — not here. Reading the setting at this
        // point would mean a setting toggled off after upload still sent.
        try {
          await getReceiptEmailQueue(redisUrl).add(
            "email",
            { receiptId: job.data.receiptId, reason: "auto" },
            { jobId: autoEmailJobId(job.data.receiptId) },
          );
        } catch (enqueueError) {
          console.error(
            `[ledgerly] failed to enqueue receipt email for ${job.data.receiptId}:`,
            enqueueError,
          );
        }
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

      // The terminal failure, logged with the underlying error attached.
      //
      // `AI_EXTRACTION_FAILED` is the fallback for anything that is NOT an
      // `ExtractError` — a constraint violation on persist, a bug in the
      // mapping, a driver error. Those are precisely the failures whose
      // reason code says nothing useful, and until now the only record of
      // what actually happened was discarded here. A receipt can burn three
      // paid API calls and leave an operator with a five-word status and no
      // way to find out why.
      //
      // The stack is included only for the non-`ExtractError` case: an
      // `ExtractError`'s reason IS the diagnosis, and `logProviderError` in
      // extract.ts has already logged the provider's side of it.
      if (error instanceof ExtractError) {
        console.error(
          `[ledgerly] extraction failed receipt=${job.data.receiptId} reason=${reason}`,
        );
      } else {
        console.error(
          `[ledgerly] extraction failed receipt=${job.data.receiptId} reason=${reason} — ` +
            "unclassified, so the underlying error follows:",
          error,
        );
      }

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
