import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { UnrecoverableError, Worker, type Job } from "bullmq";
import { and, eq, isNull } from "drizzle-orm";
import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";
import { backups } from "@ledgerly/db/schema";
import { resolveBackupSchedule } from "@ledgerly/api/backupSchedule";
import { recordEvent } from "@ledgerly/api/events";
import type { Database } from "@ledgerly/db";

import { getRedisConnection } from "./redis";
import { BACKUP_QUEUE_NAME, removeBackupSchedule, upsertBackupSchedule } from "./queue";
import {
  BackupError,
  clearBackupWorkspace,
  pruneLogs,
  runBackup,
  type BackupDeps,
  type BackupJobData,
} from "./pipeline/backup";

/**
 * packages/queue/src/backupWorker.ts — the `backup` worker (Phase 9).
 *
 * Mirrors `worker.ts` and `emailWorker.ts`. Three things are specific to this
 * queue and each of them exists because a backup system that fails silently is
 * worse than none:
 *
 * 1. **This queue has a durable row to write.** An email failure writes nothing
 *    (the receipt is the record); a backup failure writes `status='failed'` and
 *    a reason onto its `backups` row, because "the backup did not happen" is
 *    itself the thing an operator needs to be able to see later.
 * 2. **The row is created here for a scheduled run.** A manual backup's row
 *    already exists — `admin.createBackup` inserts it so the screen shows
 *    `running` the moment the button is pressed. A scheduled run has nobody
 *    watching, so the row is created on first attempt and written back onto the
 *    job with `updateData`, which is what lets the `failed` handler below know
 *    which row to mark.
 * 3. **The boot sweep reconciles the schedule as well as the rows.** A cron
 *    stored in `app_config` with no job scheduler registered in Redis is a
 *    stored intention with no effect — the exact silent failure — and Redis is
 *    not in the backup, so after a `redis_data` loss it is the normal state
 *    rather than an exotic one.
 * 4. **The worker does not start until that sweep has finished.** It is the
 *    only worker in the app built `autorun: false`, because its sweep deletes
 *    files and rewrites rows that a job starting a millisecond earlier would
 *    already be using.
 *
 * The single `pg_dump` is invoked through an injected `execFile` wrapper (see
 * `pipeline/backup.ts`), for the same reason the Anthropic client and the mail
 * transport are injected: the interesting failures are testable without the
 * real thing.
 */

const execFileAsync = promisify(execFile);

let sharedBackupWorker: Worker<BackupJobData> | undefined;

/**
 * `execFile`, narrowed to what `pipeline/backup.ts` asks for.
 *
 * `maxBuffer` is raised because `pg_dump` writes notices to stderr and, more to
 * the point, `tar -cv` prints one line per archived file — that listing is how
 * the manifest counts images, and the default 1 MB cap would turn a successful
 * backup of a few thousand receipts into a rejected promise. 16 MB is roughly
 * 200,000 paths. The dump and the tarball themselves never come through this
 * buffer — both go to a file, precisely so a multi-gigabyte database is never
 * held in the worker's memory.
 */
async function runCommand(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    env: opts.env,
    timeout: opts.timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function backupDeps(db: Database): Omit<BackupDeps, "run"> & { run: typeof runCommand } {
  const env = getEnv();
  return {
    db,
    backupsDir: env.BACKUPS_DIR,
    uploadsDir: env.UPLOADS_DIR,
    includeImages: env.BACKUP_INCLUDE_IMAGES,
    retentionDays: env.BACKUP_RETENTION_DAYS,
    logRetentionDays: env.LOG_RETENTION_DAYS,
    databaseUrl: env.DATABASE_URL,
    run: runCommand,
  };
}

/**
 * Everything that has to be true before this worker can be trusted, checked
 * once at boot.
 *
 * Deliberately awaited before `startBackupWorker` returns, matching
 * `reconcilePendingExtractions`: if the schedule cannot be reconciled the
 * process should say so during startup, not on the first night nothing happens.
 * The one exception is the log sweep at the end, which is housekeeping rather
 * than a precondition and is left running in the background.
 */
async function reconcileBackups(db: Database, redisUrl: string): Promise<void> {
  const env = getEnv();

  // (1) A backup cannot survive a restart — there is no partial state to
  // resume, and the archive is written under `.part` precisely so a killed one
  // leaves nothing usable. Any row still `running` is therefore a row whose
  // process is gone.
  const interrupted = await db
    .update(backups)
    .set({ status: "failed", error: "INTERRUPTED", finishedAt: new Date() })
    .where(and(eq(backups.status, "running"), isNull(backups.deletedAt)))
    .returning({ id: backups.id });
  if (interrupted.length > 0) {
    console.warn(`[ledgerly] marked ${interrupted.length} interrupted backup(s) failed at startup`);
    await recordEvent(db, {
      level: "warn",
      category: "backup",
      event: "backup.interrupted",
      metadata: { count: interrupted.length },
    });
  }

  // (2) Debris from those same kills. Safe here and nowhere else: the worker
  // is constructed but not yet running (`autorun: false`), so nothing is
  // holding a staging directory open.
  try {
    const removed = await clearBackupWorkspace(env.BACKUPS_DIR);
    if (removed > 0) {
      console.warn(`[ledgerly] removed ${removed} partial backup archive(s) at startup`);
    }
  } catch (error) {
    console.error("[ledgerly] could not clean the backup workspace:", error);
  }

  // (4) The schedule. `app_config` is the source of truth (D-45) and Redis is
  // a cache of it that no backup restores, so this runs on every boot rather
  // than only when the setting changes.
  //
  // Deliberately BEFORE the log sweep below: registering the schedule is the
  // step whose absence is a silent failure, and it must not queue behind
  // housekeeping.
  try {
    const { schedule, source } = await resolveBackupSchedule(db, env.MASTER_KEY);
    if (schedule) {
      await upsertBackupSchedule(redisUrl, schedule.cron);
      console.log(`[ledgerly] scheduled backup registered cron="${schedule.cron}"`);
    } else {
      await removeBackupSchedule(redisUrl);
      // WARN, not log. "No scheduled backups" is a legitimate configuration and
      // also what a broken one looks like, so it is worth one line in the log
      // either way — with the reason, since `undecryptable` and `none` need
      // completely different fixes.
      console.warn(`[ledgerly] no scheduled backup is registered (schedule source: ${source})`);
      // The exact silent failure Phase 9 was built to prevent, and one the
      // admin card can only show while someone is looking at it.
      await recordEvent(db, {
        level: source === "undecryptable" ? "error" : "warn",
        category: "backup",
        event: "backup.schedule_unregistered",
        metadata: { source },
      });
    }
  } catch (error) {
    console.error("[ledgerly] could not reconcile the backup schedule:", error);
  }

  // (5) Log retention. Also run by the backup job; the boot sweep is what makes
  // it independent of a backup schedule existing at all — an instance that
  // never backs up is exactly the one whose tables grow unwatched.
  //
  // NOT awaited. The batching inside `pruneLogs` bounds each statement, not the
  // loop, and the first sweep on an instance that has been running since Phase
  // 4 with no retention has a long backlog to work through. Nothing above waits
  // on it and neither should the worker's readiness.
  void pruneLogs({ db, retentionDays: env.LOG_RETENTION_DAYS }).catch((error: unknown) => {
    console.error("[ledgerly] log retention sweep failed at startup:", error);
  });
}

/**
 * Resolves the `backups` row this job writes to, creating one for a scheduled
 * run and resetting it on a retry.
 *
 * The `updateData` call is what makes the id available to the `failed` handler,
 * which only ever sees `job`. Without it a scheduled backup that failed
 * terminally would leave a row stuck at `running` until the next restart.
 */
async function ensureBackupRow(db: Database, job: Job<BackupJobData>): Promise<string> {
  const env = getEnv();
  const existing = job.data.backupId;
  if (existing) {
    // A retry: the previous attempt may have written `failed`. Put it back to
    // `running` so the admin view reflects the attempt in progress rather than
    // the one that already lost.
    await db
      .update(backups)
      .set({ status: "running", error: null, finishedAt: null })
      .where(eq(backups.id, existing));
    return existing;
  }
  const [row] = await db
    .insert(backups)
    .values({
      kind: job.data.kind,
      status: "running",
      dbIncluded: true,
      imagesIncluded: env.BACKUP_INCLUDE_IMAGES,
    })
    .returning({ id: backups.id });
  if (!row) throw new BackupError("BACKUP_ROW_INSERT_FAILED", { retryable: false });
  await job.updateData({ ...job.data, backupId: row.id });
  return row.id;
}

export async function startBackupWorker(redisUrl: string): Promise<Worker<BackupJobData>> {
  if (sharedBackupWorker) return sharedBackupWorker;

  const db = getDb();

  const worker = new Worker<BackupJobData>(
    BACKUP_QUEUE_NAME,
    async (job: Job<BackupJobData>) => {
      const backupId = await ensureBackupRow(db, job);
      try {
        const result = await runBackup(backupDeps(db), { ...job.data, backupId });
        console.log(
          `[ledgerly] backup complete id=${result.backupId} kind=${job.data.kind} ` +
            `bytes=${result.sizeBytes} images=${result.manifest.images.count} ` +
            `pruned=${result.pruned}`,
        );
        await recordEvent(db, {
          level: "info",
          category: "backup",
          event: "backup.complete",
          entityType: "backup",
          entityId: result.backupId,
          metadata: {
            kind: job.data.kind,
            sizeBytes: result.sizeBytes,
            images: result.manifest.images.count,
            pruned: result.pruned,
          },
        });
      } catch (error) {
        if (error instanceof BackupError && !error.retryable) {
          throw new UnrecoverableError(error.reason);
        }
        throw error;
      }
    },
    {
      connection: getRedisConnection(redisUrl),
      // One. Two concurrent `pg_dump`s of the same database compete for the
      // same disk and the same connection pool to produce two archives nobody
      // asked for, and the staging directory is per-backup only so a crash
      // cannot confuse them — not so they can run together.
      concurrency: 1,
      // NOT autorun, unlike the other three workers, and this is the one place
      // it matters. A job left waiting in Redis by a `docker stop` is picked up
      // the instant the worker starts, so an autorunning worker would be
      // mid-`pg_dump` while `reconcileBackups` below deletes the staging
      // directory out from under it and marks its row `INTERRUPTED`. The sweep
      // is only safe on the premise that nothing is running — so make that
      // literally true, then start.
      autorun: false,
    },
  );

  worker.on("failed", (job, error) => {
    void (async () => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      const isUnrecoverable = error?.name === "UnrecoverableError";
      // Retries left: leave the row `running`, which is the truth — another
      // attempt is coming.
      if (!isUnrecoverable && job.attemptsMade < attempts) return;

      const reason =
        error instanceof BackupError
          ? error.reason
          : isUnrecoverable && error.message
            ? error.message
            : "BACKUP_FAILED";
      console.error(`[ledgerly] backup gave up id=${job.data.backupId ?? "?"} reason=${reason}`);
      await recordEvent(db, {
        level: "error",
        category: "backup",
        event: "backup.failed",
        entityType: "backup",
        entityId: job.data.backupId ?? null,
        metadata: {
          reason,
          kind: job.data.kind,
          ...(reason === "BACKUP_FAILED"
            ? { error: error instanceof Error ? error.message : String(error) }
            : {}),
        },
      });
      // The reason codes that say nothing are exactly the ones whose cause was
      // being thrown away, so log the underlying error for that case — the
      // lesson from Phase 6's `AI_EXTRACTION_FAILED` archaeology.
      if (reason === "BACKUP_FAILED") {
        console.error("[ledgerly] underlying backup error:", error);
      }

      const backupId = job.data.backupId;
      if (!backupId) return;
      try {
        await db
          .update(backups)
          .set({ status: "failed", error: reason, finishedAt: new Date() })
          .where(eq(backups.id, backupId));
      } catch (dbError) {
        // Must not escape as an unhandled rejection — the same guard
        // `worker.ts`'s handler carries.
        console.error(`[ledgerly] could not mark backup ${backupId} failed:`, dbError);
      }
    })();
  });

  sharedBackupWorker = worker;
  await reconcileBackups(db, redisUrl);
  // Only now. See `autorun: false` above.
  worker.run().catch((error: unknown) => {
    console.error("[ledgerly] the backup worker stopped:", error);
  });
  return worker;
}
