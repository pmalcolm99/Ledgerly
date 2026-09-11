import "server-only";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { appTableNames } from "@ledgerly/db/tables";
import { appEvents, auditLog, backups } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/**
 * packages/queue/src/pipeline/backup.ts — producing one backup archive
 * (Phase 9, ARCHITECTURE.md §8.3, docs/PHASES.md 9.1-9.4).
 *
 * BullMQ-free and dependency-injected, exactly like `pipeline/email.ts`: the
 * worker builds the real capabilities, this module names them structurally.
 * `run` is `execFile`-shaped so the interesting failures — a missing binary, a
 * dump that dies half-written — are testable without a postgres.
 *
 * ## The two properties that shape everything below
 *
 * **A backup that fails silently is worse than none**, because it manufactures
 * confidence. So every failure is loud: a reason code on the `backups` row, a
 * `console.error` from the worker's `failed` handler, and a visible `failed`
 * status in the admin view. Nothing here swallows an error to keep the job
 * green.
 *
 * **A backup that has never been restored is a hypothesis.** So the archive is
 * self-describing: `manifest.json` carries the schema version, per-table row
 * counts, the image count, and a SHA-256 of every member file, and
 * `scripts/restore.sh` refuses to proceed when the recomputed checksums
 * disagree. The manifest is not documentation; it is what makes the restore
 * verifiable.
 *
 * ## Why the archive is assembled on disk and never streamed to a client
 *
 * The manifest checksums the dump, so the dump has to be finalised before the
 * archive can be described — a tee-while-writing design would have to either
 * omit the checksums or lie about them. The download is therefore a separate
 * route over a finished artifact (D-45), which also means a client that
 * disconnects mid-download cannot damage the on-disk copy.
 *
 * ## `.part` and rename
 *
 * `docker-compose.yml` sets `stop_grace_period: 30s`, and a `pg_dump` of a
 * real instance with images can outlive that — SIGKILL mid-`tar` is a
 * reachable state, not a theoretical one. The archive is therefore written
 * under a `.part` name and renamed only after `tar` exits 0, so a truncated
 * file can never be mistaken for a backup. The worker's boot sweep removes
 * leftovers.
 */

/** `execFile`-shaped, injected so tests never shell out. Rejects on a
 *  non-zero exit, which is what every call site here relies on.
 *
 *  Returns both streams because `tar -cv` reports the files it archived — to
 *  stdout under GNU tar, to stderr under BSD tar — and that listing is how the
 *  manifest's image count is derived. Counting the directory separately would
 *  describe a different instant than the archive. */
export type RunCommand = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type BackupJobData = {
  kind: "manual" | "scheduled";
  /**
   * The `backups` row this job writes to. A manual backup's row is created by
   * `admin.createBackup` so the admin screen shows `running` the instant the
   * button is pressed; a scheduled run has nobody watching, so `backupWorker`
   * creates the row and writes the id back onto the job. Either way it is set
   * by the time `runBackup` is called.
   */
  backupId?: string | null;
};

export type BackupDeps = {
  db: Database;
  backupsDir: string;
  uploadsDir: string;
  includeImages: boolean;
  retentionDays: number;
  /** Logs keep their own clock from backups' — same default, separate knob,
   *  because one is about disk and the other about how far back questions can
   *  be answered. */
  logRetentionDays: number;
  /** Only ever parsed for connection parameters. See `pgEnvAndFlags` — the
   *  password reaches `pg_dump` through the environment, never through argv. */
  databaseUrl: string;
  run: RunCommand;
  now?: () => Date;
};

/** Mirrors `EmailError`/`ExtractError`: a stable reason code, and whether a
 *  retry could possibly help. A missing binary cannot be fixed by waiting; a
 *  dump that failed against a momentarily-unreachable database can. */
export class BackupError extends Error {
  readonly retryable: boolean;
  readonly reason: string;

  constructor(reason: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(reason, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "BackupError";
    this.retryable = opts.retryable ?? true;
    this.reason = reason;
  }
}

export type ManifestFile = { name: string; bytes: number; sha256: string };

export type BackupManifest = {
  manifestVersion: 1;
  app: "ledgerly";
  createdAt: string;
  kind: "manual" | "scheduled";
  schema: {
    /** Rows in `drizzle.__drizzle_migrations` — what is ACTUALLY applied to
     *  the database being dumped, not what the repo happens to contain.
     *  `null` when the table is absent, which means the database was not
     *  built by our migrator and a restore should say so rather than guess. */
    appliedMigrations: number | null;
    latestHash: string | null;
    latestAppliedAt: string | null;
  };
  /** Per-table row counts, every table in the schema (`appTableNames()`). */
  tables: Record<string, number>;
  /** What is IN the archive. `count: 0` with `included: false` means the
   *  images were deliberately left out, not that there are none — see
   *  `uploadsOnDisk` for that distinction, which is the one a restore needs. */
  images: { included: boolean; count: number; bytes: number };
  /** What was on disk at backup time, recorded even when images are excluded,
   *  so a db-only archive still says what it did not take. */
  uploadsOnDisk: { count: number; bytes: number };
  files: ManifestFile[];
  totalBytes: number;
};

export type BackupResult = {
  backupId: string;
  archivePath: string;
  sizeBytes: number;
  archiveSha256: string;
  manifest: BackupManifest;
  pruned: number;
};

const STAGING_DIR_NAME = ".staging";
const DUMP_FILE = "db.dump";
const UPLOADS_TAR = "uploads.tar";
const MANIFEST_FILE = "manifest.json";

/** 2 hours. Long enough for a genuinely large instance, short enough that a
 *  wedged child does not hold the single backup worker slot forever. */
const PG_DUMP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TAR_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Connection parameters for a libpq child process.
 *
 * The password goes in the child's environment and the rest in argv, rather
 * than passing the whole `postgres://user:pass@host/db` URI as one argument.
 * argv is world-readable through `/proc/<pid>/cmdline` for the lifetime of the
 * process, so a URI there puts the database password in front of anything that
 * can run `ps` inside the container. `PGPASSWORD` is not perfect either, but it
 * is not readable by another user's `ps`.
 */
export function pgEnvAndFlags(databaseUrl: string): {
  flags: string[];
  env: NodeJS.ProcessEnv;
} {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new BackupError("DATABASE_URL_UNPARSEABLE", { retryable: false });
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new BackupError("DATABASE_URL_UNPARSEABLE", { retryable: false });

  const flags = ["-h", url.hostname, "-p", url.port || "5432", "-d", database];
  if (url.username) flags.push("-U", decodeURIComponent(url.username));

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  // Honoured so a deployment that requires TLS to its database does not have
  // to discover that backups are the one client that ignores the setting.
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  // A backup must never be the reason a request hangs; fail and retry instead.
  env.PGCONNECT_TIMEOUT = "15";
  return { flags, env };
}

/** Whether `candidate` resolves inside `root`, lexically. Used by the prune
 *  sweep before it deletes; the download route does the stronger `realpath`
 *  version, because it also has to defeat a symlink. */
function isInside(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  // Streamed, never `readFile` — `uploads.tar` is the whole image tree and can
  // be gigabytes.
  await streamPipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function fileBytes(file: string): Promise<number> {
  return (await fs.stat(file)).size;
}

/** Regular files and total bytes under a directory tree.
 *
 *  Only regular files, and that has to match how a restore counts them:
 *  `scripts/restore.sh` verifies with `find -type f`, so counting a symlink or
 *  a socket here would make a byte-perfect restore report a mismatch. Symlinks
 *  are not followed either — `storage.ts` writes UUID-derived paths and creates
 *  none, so one appearing is an anomaly, not something to recurse into. */
export async function measureTree(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        count += 1;
        bytes += (await fs.stat(full)).size;
      }
    }
  }
  await walk(dir);
  return { count, bytes };
}

/**
 * How many regular files a `tar -tf` listing contains.
 *
 * Read back from the finished archive rather than counted while writing it, and
 * that is not incidental. `tar -cv`'s create-time listing is NOT portable: GNU
 * tar writes `./a/` for a directory and BSD tar writes `a ./a` with no trailing
 * slash, so a directory/file test over it silently over-counts on one of the
 * two — which is exactly the kind of platform-dependent wrongness a manifest
 * must not contain. `tar -tf` is byte-identical on both (verified against GNU
 * tar in an alpine container and BSD tar on macOS): every directory ends in
 * `/`, every file does not.
 *
 * It costs one extra sequential read of a file that was just written, next to
 * the SHA-256 pass that reads it anyway.
 *
 * Excluding directories matches `measureTree` and `scripts/restore.sh`'s
 * `find -type f`, so all three agree by construction.
 */
export function countArchivedFiles(listing: string): number {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/")).length;
}

/**
 * Anything that can run SQL — the pool, or a transaction pinned to one
 * connection. The counts must run inside the SAME transaction that exported the
 * snapshot `pg_dump` is reading, so this cannot be narrowed to `Database`.
 */
type Queryable = Pick<Database, "execute">;

/**
 * Per-table row counts in ONE query, so every count shares one snapshot.
 *
 * Counting table by table would let a concurrent upload land between two
 * counts and produce a manifest whose numbers cannot all be true at once —
 * and the manifest's whole job is to be the thing a restore is checked
 * against. A set of counts that disagree with each other is worse than none.
 *
 * One query is necessary and not sufficient: see `runBackup`, which runs this
 * inside the transaction whose exported snapshot `pg_dump` is reading, so the
 * counts describe the same instant as the dump they are checked against.
 */
export async function countRows(db: Queryable): Promise<Record<string, number>> {
  const names = appTableNames();
  for (const name of names) {
    // These come from our own drizzle schema, not from input. Asserted anyway,
    // because this is the one place a table name is interpolated into SQL text
    // and the assertion costs nothing.
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
      throw new BackupError("TABLE_NAME_UNSAFE", { retryable: false });
    }
  }
  const unions = names
    .map((name) => `SELECT '${name}' AS table_name, count(*)::bigint AS n FROM "${name}"`)
    .join(" UNION ALL ");
  const result = await db.execute(sql.raw(unions));
  const counts: Record<string, number> = {};
  for (const row of result.rows as { table_name: string; n: string | number }[]) {
    counts[row.table_name] = Number(row.n);
  }
  return counts;
}

/**
 * What the migrator has actually applied, read from drizzle's own bookkeeping
 * table (`packages/db/src/migrate.ts` passes no `migrationsTable`, so this is
 * the default location).
 *
 * `created_at` there is a bigint of epoch milliseconds, not a timestamp.
 */
export async function readSchemaVersion(db: Queryable): Promise<BackupManifest["schema"]> {
  const exists = await db.execute(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (!(exists.rows[0] as { present: boolean } | undefined)?.present) {
    return { appliedMigrations: null, latestHash: null, latestAppliedAt: null };
  }
  const result = await db.execute(
    sql`SELECT count(*)::int AS applied,
               (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1) AS hash,
               (SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1) AS created_at
          FROM drizzle.__drizzle_migrations`,
  );
  const row = result.rows[0] as
    { applied: number; hash: string | null; created_at: string | number | null } | undefined;
  const createdAt = row?.created_at == null ? null : Number(row.created_at);
  return {
    appliedMigrations: row?.applied ?? 0,
    latestHash: row?.hash ?? null,
    latestAppliedAt:
      createdAt === null || Number.isNaN(createdAt) ? null : new Date(createdAt).toISOString(),
  };
}

/**
 * `2026-09-09T14:32:05.123Z` -> `ledgerly-backup-20260909T143205Z-a1b2c3d4`.
 *
 * Colons are legal in a POSIX filename but make the archive miserable to handle
 * on Windows and in half of all shell one-liners, and an operator will be
 * handling these by hand on the worst day of their year.
 *
 * The row id's first eight characters are appended for two reasons. The
 * timestamp has one-second resolution and `fs.rename` overwrites silently, so
 * two backups starting in the same second would clobber each other's archive
 * AND its sidecar without a word. And it makes an archive found loose on a
 * volume traceable back to the row that describes it, which is exactly the
 * situation someone is in when they are reading filenames by hand.
 */
export function archiveBasename(at: Date, backupId: string): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `ledgerly-backup-${stamp}-${backupId.slice(0, 8)}`;
}

/**
 * Produces one backup archive and records it on its `backups` row.
 *
 * Throws `BackupError` on failure and leaves the row for the worker's `failed`
 * handler to mark terminal — the same division of labour as extraction, where
 * the pipeline decides WHAT went wrong and the worker decides whether there
 * are attempts left.
 */
export async function runBackup(deps: BackupDeps, data: BackupJobData): Promise<BackupResult> {
  const backupId = data.backupId;
  if (!backupId) throw new BackupError("BACKUP_ROW_MISSING", { retryable: false });
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  const staging = path.join(deps.backupsDir, STAGING_DIR_NAME, backupId);
  // A retry lands here with the previous attempt's half-written files still in
  // place. Start from empty rather than reasoning about which of them are
  // salvageable.
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  try {
    const dumpPath = path.join(staging, DUMP_FILE);
    const { flags, env } = pgEnvAndFlags(deps.databaseUrl);

    /**
     * The dump and the numbers that describe it, from ONE snapshot.
     *
     * This is the property the manifest lives or dies on. `pg_dump` takes its
     * own repeatable-read snapshot; counting rows afterwards, in a separate
     * transaction, describes the database as it was minutes LATER. On a
     * nightly backup of a live instance that is not a corner case — one receipt
     * uploaded while the dump runs and `receipts`, `receipt_items`, `ai_usage`
     * and `audit_log` all read high.
     *
     * The consequence lands at the worst possible moment: weeks later, mid
     * recovery, `scripts/restore.sh` reports four mismatches and refuses to
     * call a byte-perfect restore verified — after it has already overwritten
     * the target. The operator's only remaining signal is one they have just
     * been taught to distrust.
     *
     * So: open one REPEATABLE READ transaction, export its snapshot, hand that
     * snapshot to `pg_dump` with `--snapshot`, and count inside the same
     * transaction. The manifest and the dump are then the same instant by
     * construction rather than by luck. The transaction stays open for the
     * whole dump, which pins one connection — exactly what `pg_dump` does to
     * its own connection anyway.
     */
    const { tables, schema } = await deps.db.transaction(
      async (tx) => {
        const exported = await tx.execute(sql`SELECT pg_export_snapshot() AS id`);
        const snapshotId = (exported.rows[0] as { id?: string } | undefined)?.id;
        if (!snapshotId) throw new BackupError("SNAPSHOT_EXPORT_FAILED", { retryable: true });

        try {
          await deps.run(
            "pg_dump",
            [
              // `--format=custom` is what `pg_restore --clean --if-exists`
              // needs (D-45); `--no-owner`/`--no-privileges` are what let the
              // same archive restore into a scratch database owned by a
              // different role, which is exactly what the drill does.
              "--format=custom",
              "--no-owner",
              "--no-privileges",
              `--snapshot=${snapshotId}`,
              ...flags,
              "-f",
              dumpPath,
            ],
            { env, timeout: PG_DUMP_TIMEOUT_MS },
          );
        } catch (error) {
          if (isEnoent(error)) {
            // `postgresql17-client` ships in the runner image
            // (docker/Dockerfile), so in production this means the image is
            // wrong, not the database. Not retryable: no amount of waiting
            // installs a binary.
            throw new BackupError("PG_DUMP_NOT_FOUND", { retryable: false, cause: error });
          }
          throw new BackupError("PG_DUMP_FAILED", { cause: error });
        }

        return {
          tables: await countRows(tx),
          schema: await readSchemaVersion(tx),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    const uploadsOnDisk = await measureTree(deps.uploadsDir);
    let images = { included: false, count: 0, bytes: 0 };
    if (deps.includeImages) {
      const tarPath = path.join(staging, UPLOADS_TAR);
      // `measureTree` tolerates a missing uploads directory and `tar` does not,
      // so without this an instance that has never had an upload — the
      // entrypoint creates the directory, but nothing else does — would fail
      // EVERY backup with `UPLOADS_TAR_FAILED` the moment images were turned
      // on. An empty tar is the honest archive of an empty tree.
      await fs.mkdir(deps.uploadsDir, { recursive: true });
      let listing: string;
      try {
        // No gzip on this inner tar: every file under it is an already-
        // compressed WebP or JPEG, so a compression pass over them buys
        // approximately nothing and costs real minutes on a large instance.
        // `-C` so the archive holds relative paths and can be restored to a
        // different uploads directory (which is what the drill does).
        await deps.run("tar", ["-cf", tarPath, "-C", deps.uploadsDir, "."], {
          timeout: TAR_TIMEOUT_MS,
        });
        // The image count comes from the ARCHIVE, not from a second walk of the
        // directory — for the same reason the row counts share the dump's
        // snapshot. A file landing between a walk and the tar would put a
        // number in the manifest that the archive does not support, and a
        // restore would then report a mismatch on a perfect archive at the
        // worst possible moment.
        listing = (await deps.run("tar", ["-tf", tarPath], { timeout: TAR_TIMEOUT_MS })).stdout;
      } catch (error) {
        if (isEnoent(error)) {
          throw new BackupError("TAR_NOT_FOUND", { retryable: false, cause: error });
        }
        throw new BackupError("UPLOADS_TAR_FAILED", { cause: error });
      }
      images = {
        included: true,
        count: countArchivedFiles(listing),
        // Bytes stay the directory measurement: a `-tf` listing carries no
        // sizes, and this figure is descriptive rather than something a restore
        // is checked against.
        bytes: uploadsOnDisk.bytes,
      };
    }

    const members = [DUMP_FILE, ...(deps.includeImages ? [UPLOADS_TAR] : [])];
    const files: ManifestFile[] = [];
    for (const name of members) {
      const full = path.join(staging, name);
      files.push({ name, bytes: await fileBytes(full), sha256: await sha256File(full) });
    }

    const manifest: BackupManifest = {
      manifestVersion: 1,
      app: "ledgerly",
      createdAt: startedAt.toISOString(),
      kind: data.kind,
      schema,
      tables,
      images,
      uploadsOnDisk,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    };
    await fs.writeFile(
      path.join(staging, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );

    const archivePath = path.join(deps.backupsDir, `${archiveBasename(startedAt, backupId)}.tgz`);
    const partPath = `${archivePath}.part`;
    await fs.rm(partPath, { force: true });
    try {
      // gzip on the OUTER archive, even though `db.dump` arrives already
      // zlib-compressed from pg_dump's custom format and `uploads.tar` holds
      // pre-compressed images. It earns little on this content; it is here
      // because `.tgz` is the shape every operator and every runbook expects,
      // and `manifest.json` does compress. If backup duration ever becomes the
      // complaint, this is the line to revisit — not the checksums.
      await deps.run("tar", ["-czf", partPath, "-C", staging, "."], { timeout: TAR_TIMEOUT_MS });
    } catch (error) {
      await fs.rm(partPath, { force: true });
      if (isEnoent(error)) {
        throw new BackupError("TAR_NOT_FOUND", { retryable: false, cause: error });
      }
      throw new BackupError("ARCHIVE_TAR_FAILED", { cause: error });
    }
    await fs.rename(partPath, archivePath);

    const sizeBytes = await fileBytes(archivePath);
    const archiveSha256 = await sha256File(archivePath);
    // A sidecar rather than a line in the manifest, because the manifest is
    // INSIDE the file it would be checksumming. `scripts/restore.sh` verifies
    // the members against the manifest; this is for verifying the archive
    // itself after it has been copied somewhere else, which is the operation
    // that actually corrupts backups.
    await fs.writeFile(
      `${archivePath}.sha256`,
      `${archiveSha256}  ${path.basename(archivePath)}\n`,
    );

    await deps.db
      .update(backups)
      .set({
        status: "complete",
        path: archivePath,
        sizeBytes,
        dbIncluded: true,
        imagesIncluded: deps.includeImages,
        // The row's manifest is `manifest.json` PLUS `archiveSha256`, which
        // cannot appear inside the file it describes. Documented here because
        // "the row mirrors the manifest" is otherwise almost true, and almost
        // true is how a restore check ends up comparing the wrong fields.
        manifest: { ...manifest, archiveSha256 },
        error: null,
        finishedAt: now(),
      })
      .where(eq(backups.id, backupId));

    // Deliberately after the row is `complete` and OUTSIDE anything that can
    // fail this job. Retention is housekeeping; letting it throw here would
    // make BullMQ retry a backup that has already succeeded, and
    // `ensureBackupRow` would repoint the same row at a second archive —
    // leaving the first on the volume with no row referencing it, invisible to
    // both `pruneBackups` (which walks rows) and `clearBackupWorkspace` (which
    // only removes `.part`). Silent, unbounded growth of the one volume whose
    // job is to have room for the next backup.
    //
    // Two sweeps, two `try`s. Sharing one would mean an `EACCES` unlinking a
    // single stale archive silently cancels log retention for the night — and
    // the boot sweep only covers that up if somebody restarts the container.
    // They are independent chores; a failure in one is not news about the
    // other.
    let pruned = 0;
    try {
      pruned = await pruneBackups(deps);
    } catch (error) {
      console.error("[ledgerly] backup retention sweep failed:", error);
    }
    try {
      await pruneLogs({ db: deps.db, retentionDays: deps.logRetentionDays, now: deps.now });
    } catch (error) {
      console.error("[ledgerly] log retention sweep failed:", error);
    }
    return { backupId, archivePath, sizeBytes, archiveSha256, manifest, pruned };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Retention (task 9.4): soft-delete and unlink anything older than
 * `BACKUP_RETENTION_DAYS`.
 *
 * **Unlink first, then set `deleted_at`.** A crash between the two then leaves
 * a row claiming a file that is gone — visible in the admin view, which
 * already computes `hasArtifact` from `path IS NOT NULL`, and harmless. The
 * other order leaves a file no row admits to: invisible, never pruned again,
 * and it fills the disk. Given a choice between an inconsistency you can see
 * and one you cannot, take the one you can see.
 *
 * Failed rows are pruned on the same clock as successful ones. They are
 * history, and history has the same retention.
 */
export async function pruneBackups(deps: BackupDeps): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - deps.retentionDays * 24 * 60 * 60 * 1000);
  const stale = await deps.db
    .select({ id: backups.id, path: backups.path })
    .from(backups)
    .where(and(isNull(backups.deletedAt), lt(backups.startedAt, cutoff)));

  let pruned = 0;
  for (const row of stale) {
    if (row.path) {
      // The same containment assertion the download route makes, in the
      // direction that matters more: that one refuses to READ a file outside
      // the volume, this one is about to DELETE one. `path` is written by this
      // module and never by a user, so reaching this needs a row edited in the
      // database — which is precisely the case a guard is for.
      if (!isInside(row.path, deps.backupsDir)) {
        console.error(
          `[ledgerly] refusing to prune ${row.path}: it is outside BACKUPS_DIR. ` +
            "Soft-deleting the row and leaving the file alone.",
        );
      } else {
        try {
          await fs.rm(row.path, { force: true });
        } catch (error) {
          // Loud, and then move on. A file we cannot remove must not stop the
          // rest of the sweep — that would let one bad row park retention
          // forever and quietly fill the volume.
          console.error(`[ledgerly] backup prune could not unlink ${row.path}:`, error);
          continue;
        }
        // Its own try. The archive is already gone by here, so a sidecar that
        // will not unlink must NOT skip the soft-delete below — that would
        // leave a row pointing at a file that no longer exists, which every
        // later sweep would retry and fail on identically, and the row would
        // never be pruned.
        try {
          await fs.rm(`${row.path}.sha256`, { force: true });
        } catch (error) {
          console.error(`[ledgerly] backup prune left a sidecar behind for ${row.path}:`, error);
        }
      }
    }
    await deps.db
      .update(backups)
      .set({ deletedAt: now(), path: null })
      .where(eq(backups.id, row.id));
    pruned += 1;
  }
  if (pruned > 0) {
    console.log(`[ledgerly] pruned ${pruned} backup(s) older than ${deps.retentionDays} days`);
  }
  return pruned;
}

/**
 * Retention for the Logs tab (D-46).
 *
 * Lives here, beside `pruneBackups`, because it is the same kind of chore on
 * the same clock and because the backup job is the one thing that already runs
 * nightly. Called from the job AND from the worker's boot sweep — an instance
 * with no backup schedule configured would otherwise never prune at all, which
 * is exactly the instance least likely to notice a table growing.
 *
 * Deletes rather than soft-deletes: unlike a backup row, a log line that has
 * aged out has no artifact to reconcile against and nothing to be visible
 * *about*. A tombstone would just be a smaller log line kept forever.
 *
 * **Batched, and counted without `RETURNING`.** The first sweep after this
 * ships is the expensive one: an instance that has been running since Phase 4
 * with no retention at all deletes its entire historical backlog at once. A
 * single unbounded `DELETE` would hold row locks against concurrent
 * `recordAudit` inserts for the whole of it, and `.returning({ id })` — used
 * here only to call `.length` — would ship every one of those UUIDs back over
 * the wire to be counted. `rowCount` is the same number for none of the cost.
 */
const PRUNE_BATCH = 10_000;

export async function pruneLogs(deps: {
  db: Database;
  retentionDays: number;
  now?: () => Date;
}): Promise<{ events: number; audit: number }> {
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - deps.retentionDays * 24 * 60 * 60 * 1000);

  /**
   * `ctid IN (SELECT ctid ... LIMIT n)` rather than a plain `DELETE ... LIMIT`,
   * which postgres does not have. Loops until a pass deletes nothing, so each
   * statement's locks are held for a bounded time and a long backlog is cleared
   * in steps instead of one transaction.
   */
  async function deleteInBatches(table: PgTable, column: PgColumn): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await deps.db.execute(sql`
        DELETE FROM ${table}
         WHERE ctid IN (
           SELECT ctid FROM ${table} WHERE ${column} < ${cutoff} LIMIT ${PRUNE_BATCH}
         )
      `);
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < PRUNE_BATCH) return total;
    }
  }

  // No `sql.raw` anywhere: the table and column are interpolated as drizzle
  // objects, so they are quoted identifiers rather than pasted text, and the
  // cutoff — the only value that varies — is a bound parameter.
  const events = await deleteInBatches(appEvents, appEvents.at);
  const audit = await deleteInBatches(auditLog, auditLog.createdAt);

  if (events > 0 || audit > 0) {
    console.log(
      `[ledgerly] pruned ${events} event(s) and ${audit} audit row(s) ` +
        `older than ${deps.retentionDays} days`,
    );
  }
  return { events, audit };
}

/** Leftovers from a process killed mid-archive. Called by the worker at boot,
 *  where it is the only moment it is unambiguously safe: nothing is running,
 *  so anything here is debris by definition. */
export async function clearBackupWorkspace(backupsDir: string): Promise<number> {
  let removed = 0;
  await fs.rm(path.join(backupsDir, STAGING_DIR_NAME), { recursive: true, force: true });
  let entries;
  try {
    entries = await fs.readdir(backupsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return 0;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".part")) {
      await fs.rm(path.join(backupsDir, entry.name), { force: true });
      removed += 1;
    }
  }
  return removed;
}
