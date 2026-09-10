import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import { appTableNames } from "@ledgerly/db/tables";
import * as schema from "@ledgerly/db/schema";
import { backups, receipts } from "@ledgerly/db/schema";

import {
  BackupError,
  archiveBasename,
  clearBackupWorkspace,
  countArchivedFiles,
  countRows,
  measureTree,
  pgEnvAndFlags,
  pruneBackups,
  readSchemaVersion,
  runBackup,
  type BackupDeps,
  type BackupManifest,
} from "./backup";

/**
 * `pg_dump` and `tar` are injected (`deps.run`), so almost everything here runs
 * with a fake and no postgres client tools. The one suite that needs the real
 * binaries is the round-trip in `backupRoundTrip.test.ts`; this file uses a fake
 * `run` that writes plausible bytes, which is what lets the checksum, manifest
 * and retention assertions be exact rather than approximate.
 */
function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let backupsDir: string;
let uploadsDir: string;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
  backupsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-backup-test-"));
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-uploads-test-"));
});

afterEach(async () => {
  await fs.rm(backupsDir, { recursive: true, force: true });
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await getCleanPool().end();
});

/**
 * Stands in for `pg_dump` and `tar`.
 *
 * `pg_dump` writes the bytes it was told to write to the path in `-f`; `tar -cf`
 * and `tar -czf` write a file listing their inputs. Not a real archive — the
 * suite never extracts one here — but real files with real sizes, which is what
 * the checksums and `size_bytes` assertions need.
 */
function fakeRun(opts: { dumpBytes?: string; failOn?: string; enoentOn?: string } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const tarContents = new Map<string, string>();
  // Params annotated rather than inferred: `vi.fn` widens the callback's
  // signature, so `args` arrives as implicitly-any without them.
  const run: BackupDeps["run"] = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (opts.enoentOn === file) {
      const error = new Error(`spawn ${file} ENOENT`) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    if (opts.failOn === file) throw new Error(`${file} exited 1`);
    if (file === "pg_dump") {
      const target = args[args.indexOf("-f") + 1];
      await fs.writeFile(target!, opts.dumpBytes ?? "PGDMP-fake-dump-contents");
      return { stdout: "", stderr: "" };
    }
    if (file === "tar") {
      // `-tf` reads a tarball back. The fake remembers what the matching `-cf`
      // was told to archive, so the image count is derived from the same thing
      // a real tar would report rather than from a stub that always agrees.
      if (args[0] === "-tf") {
        return { stdout: tarContents.get(args[1]!) ?? "", stderr: "" };
      }
      const flag = args.findIndex((arg) => arg === "-cf" || arg === "-czf");
      const target = args[flag + 1]!;
      await fs.writeFile(target, `fake-tar-of ${args.join(" ")}`);
      if (args[flag] === "-cf") {
        const root = args[args.indexOf("-C") + 1]!;
        const lines = ["./"];
        const walk = async (dir: string, prefix: string): Promise<void> => {
          for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const rel = `${prefix}${entry.name}`;
            if (entry.isDirectory()) {
              lines.push(`${rel}/`);
              await walk(path.join(dir, entry.name), `${rel}/`);
            } else {
              lines.push(rel);
            }
          }
        };
        await walk(root, "./");
        tarContents.set(target, `${lines.join("\n")}\n`);
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${file}`);
  });
  return { run, calls };
}

function deps(overrides: Partial<BackupDeps> = {}): BackupDeps {
  return {
    db,
    backupsDir,
    uploadsDir,
    includeImages: false,
    retentionDays: 30,
    databaseUrl: "postgres://u:p@localhost:5432/ledgerly_test",
    run: fakeRun().run,
    ...overrides,
  };
}

async function newBackupRow(kind: "manual" | "scheduled" = "manual"): Promise<string> {
  const [row] = await db.insert(backups).values({ kind, status: "running" }).returning({
    id: backups.id,
  });
  return row!.id;
}

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

/** Archives and half-written archives, ignoring the reusable `.staging`
 *  workspace directory — which `runBackup` deliberately leaves in place and
 *  `clearBackupWorkspace` removes at boot. */
async function archivesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

describe("pgEnvAndFlags", () => {
  it("keeps the password out of argv and puts it in the environment", () => {
    const { flags, env } = pgEnvAndFlags("postgres://ledger:s3cr3t@db:5432/ledgerly");
    // The assertion that matters: argv is world-readable through /proc, so a
    // password anywhere in `flags` would be a disclosure to anything that can
    // run `ps` in the container.
    expect(flags.join(" ")).not.toContain("s3cr3t");
    expect(flags).toEqual(["-h", "db", "-p", "5432", "-d", "ledgerly", "-U", "ledger"]);
    expect(env.PGPASSWORD).toBe("s3cr3t");
  });

  it("percent-decodes credentials and passes sslmode through", () => {
    const { flags, env } = pgEnvAndFlags(
      "postgres://us%40er:p%2Fss@host:6543/db%2Dname?sslmode=require",
    );
    expect(flags).toContain("us@er");
    expect(flags).toContain("db-name");
    expect(env.PGPASSWORD).toBe("p/ss");
    expect(env.PGSSLMODE).toBe("require");
  });

  it("refuses a URL with no database name", () => {
    expect(() => pgEnvAndFlags("postgres://u:p@host:5432/")).toThrow(BackupError);
    expect(() => pgEnvAndFlags("not a url")).toThrow(BackupError);
  });
});

describe("countRows", () => {
  it("counts every table in the schema, not a hand-written subset", async () => {
    const counts = await countRows(db);
    // The manifest's value depends on this covering the whole schema — a table
    // silently missing from the count would let a restore "verify" while
    // ignoring it.
    expect(Object.keys(counts).sort()).toEqual(appTableNames());
    expect(Object.keys(counts)).toContain("backups");
    // withCleanDatabase() re-seeds instance_state and the 13 system categories.
    expect(counts.categories).toBe(13);
    expect(counts.instance_state).toBe(1);
    expect(counts.receipts).toBe(0);
  });

  it("reflects rows that were actually inserted", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    await db.insert(receipts).values([
      { projectId: project.id, uploadedBy: users.owner!.id, extractionStatus: "pending" },
      { projectId: project.id, uploadedBy: users.owner!.id, extractionStatus: "ok" },
    ]);
    const counts = await countRows(db);
    expect(counts.receipts).toBe(2);
    expect(counts.projects).toBe(1);
  });
});

describe("readSchemaVersion", () => {
  it("reports what the migrator has actually applied", async () => {
    const version = await readSchemaVersion(db);
    // The test database is migrated by scripts/test-db.sh, so this is a real
    // reading rather than a fixture.
    expect(version.appliedMigrations).toBeGreaterThan(0);
    expect(version.latestHash).toMatch(/^[0-9a-f]{6,}$/);
    expect(version.latestAppliedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(version.latestAppliedAt!))).toBe(false);
  });
});

describe("measureTree", () => {
  it("counts files recursively and reports zero for a missing directory", async () => {
    await fs.mkdir(path.join(uploadsDir, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(uploadsDir, "a", "one.webp"), "12345");
    await fs.writeFile(path.join(uploadsDir, "a", "b", "two.webp"), "678");
    expect(await measureTree(uploadsDir)).toEqual({ count: 2, bytes: 8 });
    expect(await measureTree(path.join(uploadsDir, "nope"))).toEqual({ count: 0, bytes: 0 });
  });
});

describe("archiveBasename", () => {
  it("produces a filename with no colons in it, tagged with the row id", () => {
    const name = archiveBasename(
      new Date("2026-09-09T14:32:05.123Z"),
      "a1b2c3d4-dead-beef-0000-000000000000",
    );
    expect(name).toBe("ledgerly-backup-20260909T143205Z-a1b2c3d4");
    expect(name).not.toContain(":");
  });

  /** One-second resolution plus `fs.rename`'s silent overwrite would let two
   *  backups in the same second clobber each other's archive AND sidecar. */
  it("differs for two backups starting in the same second", () => {
    const at = new Date("2026-09-09T14:32:05.000Z");
    expect(archiveBasename(at, "11111111-0000-0000-0000-000000000000")).not.toBe(
      archiveBasename(at, "22222222-0000-0000-0000-000000000000"),
    );
  });
});

describe("runBackup", () => {
  it("writes an archive, a sidecar checksum, and a manifest that describes both", async () => {
    const backupId = await newBackupRow();
    const { run, calls } = fakeRun();
    const result = await runBackup(deps({ run }), { kind: "manual", backupId });

    // The archive exists under BACKUPS_DIR and the `.part` name is gone.
    expect(path.dirname(result.archivePath)).toBe(backupsDir);
    await expect(fs.stat(result.archivePath)).resolves.toBeTruthy();
    await expect(fs.stat(`${result.archivePath}.part`)).rejects.toThrow();

    // The sidecar carries the archive's real checksum.
    const sidecar = await fs.readFile(`${result.archivePath}.sha256`, "utf8");
    expect(sidecar).toContain(await sha256Of(result.archivePath));
    expect(sidecar).toContain(path.basename(result.archivePath));
    expect(result.archiveSha256).toBe(await sha256Of(result.archivePath));

    // The manifest describes what is in the archive.
    const manifest = result.manifest;
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.kind).toBe("manual");
    expect(manifest.files.map((f) => f.name)).toEqual(["db.dump"]);
    expect(manifest.tables.categories).toBe(13);
    expect(manifest.schema.appliedMigrations).toBeGreaterThan(0);
    expect(manifest.totalBytes).toBe(manifest.files[0]!.bytes);

    // pg_dump was invoked in the custom format a `pg_restore --clean` needs.
    const dump = calls.find((c) => c.file === "pg_dump")!;
    expect(dump.args).toContain("--format=custom");
    expect(dump.args).toContain("--no-owner");
    expect(dump.args).toContain("--no-privileges");
  });

  /**
   * The manifest's counts must describe the SAME INSTANT as the dump.
   *
   * Without `--snapshot`, pg_dump takes its own snapshot and the counts run
   * afterwards in a separate transaction — so a single upload landing during a
   * nightly backup puts numbers in the manifest that the dump does not support.
   * The bill arrives weeks later, mid-recovery, when `restore.sh` refuses to
   * call a byte-perfect restore verified and the operator is left with the one
   * signal they have just been taught to distrust.
   */
  it("hands pg_dump the snapshot the row counts are taken in", async () => {
    const backupId = await newBackupRow();
    const { run, calls } = fakeRun();
    await runBackup(deps({ run }), { kind: "manual", backupId });

    const dump = calls.find((c) => c.file === "pg_dump")!;
    const snapshot = dump.args.find((arg) => arg.startsWith("--snapshot="));
    expect(snapshot).toBeDefined();
    // A real exported snapshot id, not a placeholder — `NNNN-NNNN-N`.
    expect(snapshot).toMatch(/^--snapshot=[0-9A-F]+-[0-9A-F]+-\d+$/i);
  });

  it("derives the image count from the archive, not from a second walk", async () => {
    await fs.mkdir(path.join(uploadsDir, "proj", "receipt"), { recursive: true });
    await fs.writeFile(path.join(uploadsDir, "proj", "receipt", "display.webp"), "a");
    await fs.writeFile(path.join(uploadsDir, "proj", "receipt", "thumb.webp"), "b");
    const { run, calls } = fakeRun();
    const result = await runBackup(deps({ run, includeImages: true }), {
      kind: "manual",
      backupId: await newBackupRow(),
    });
    // Read back with `-tf` rather than counted while writing: `tar -cv`'s
    // create-time listing is not portable (GNU marks directories with a
    // trailing slash, BSD does not), so counting it would over-count on one of
    // the two platforms.
    expect(calls.some((c) => c.file === "tar" && c.args[0] === "-tf")).toBe(true);
    expect(result.manifest.images.count).toBe(2);
  });

  it("records the terminal row exactly, including the manifest and archive checksum", async () => {
    const backupId = await newBackupRow();
    const result = await runBackup(deps(), { kind: "manual", backupId });

    const [row] = await db.select().from(backups).where(eq(backups.id, backupId));
    expect(row!.status).toBe("complete");
    expect(row!.path).toBe(result.archivePath);
    expect(row!.sizeBytes).toBe((await fs.stat(result.archivePath)).size);
    expect(row!.dbIncluded).toBe(true);
    expect(row!.imagesIncluded).toBe(false);
    expect(row!.error).toBeNull();
    expect(row!.finishedAt).not.toBeNull();

    // The row's manifest is manifest.json PLUS archiveSha256, which cannot be
    // inside the file it checksums.
    const stored = row!.manifest as BackupManifest & { archiveSha256: string };
    expect(stored.archiveSha256).toBe(result.archiveSha256);
    expect(stored.tables).toEqual(result.manifest.tables);
  });

  it("excludes images by default and includes them when the flag is set", async () => {
    await fs.mkdir(path.join(uploadsDir, "p"), { recursive: true });
    await fs.writeFile(path.join(uploadsDir, "p", "display.webp"), "aaaa");
    await fs.writeFile(path.join(uploadsDir, "p", "thumb.webp"), "bb");

    const excluded = await runBackup(deps(), { kind: "manual", backupId: await newBackupRow() });
    expect(excluded.manifest.images).toEqual({ included: false, count: 0, bytes: 0 });
    expect(excluded.manifest.files.map((f) => f.name)).toEqual(["db.dump"]);
    // Recorded even when excluded, so a db-only archive still says what it did
    // NOT take — the distinction a restore needs.
    expect(excluded.manifest.uploadsOnDisk).toEqual({ count: 2, bytes: 6 });

    const included = await runBackup(deps({ includeImages: true }), {
      kind: "scheduled",
      backupId: await newBackupRow("scheduled"),
    });
    expect(included.manifest.images).toEqual({ included: true, count: 2, bytes: 6 });
    expect(included.manifest.files.map((f) => f.name)).toEqual(["db.dump", "uploads.tar"]);
    expect(included.manifest.kind).toBe("scheduled");
  });

  /** `measureTree` tolerates a missing uploads directory; `tar` does not. An
   *  instance that has never had an upload must still be able to back up. */
  it("backs up successfully when the uploads directory does not exist yet", async () => {
    const missing = path.join(uploadsDir, "never-created");
    const backupId = await newBackupRow();
    const result = await runBackup(deps({ uploadsDir: missing, includeImages: true }), {
      kind: "scheduled",
      backupId,
    });
    expect(result.manifest.images).toEqual({ included: true, count: 0, bytes: 0 });
    expect(result.manifest.files.map((f) => f.name)).toEqual(["db.dump", "uploads.tar"]);
    const [row] = await db.select().from(backups).where(eq(backups.id, backupId));
    expect(row!.status).toBe("complete");
  });

  it("checksums each member file against its real contents", async () => {
    const backupId = await newBackupRow();
    const result = await runBackup(deps({ run: fakeRun({ dumpBytes: "known-bytes" }).run }), {
      kind: "manual",
      backupId,
    });
    const dumpEntry = result.manifest.files.find((f) => f.name === "db.dump")!;
    expect(dumpEntry.bytes).toBe("known-bytes".length);
    expect(dumpEntry.sha256).toBe(createHash("sha256").update("known-bytes").digest("hex"));
  });

  it("leaves no archive and no staging directory when pg_dump fails", async () => {
    const backupId = await newBackupRow();
    const { run } = fakeRun({ failOn: "pg_dump" });
    await expect(runBackup(deps({ run }), { kind: "manual", backupId })).rejects.toMatchObject({
      name: "BackupError",
      reason: "PG_DUMP_FAILED",
      // Retryable: the database may simply have been unreachable for a moment.
      retryable: true,
    });
    // Nothing half-written left behind. A truncated file that looks like a
    // backup is worse than no file.
    expect(await archivesIn(backupsDir)).toEqual([]);
  });

  it("treats a missing binary as non-retryable", async () => {
    const backupId = await newBackupRow();
    const { run } = fakeRun({ enoentOn: "pg_dump" });
    await expect(runBackup(deps({ run }), { kind: "manual", backupId })).rejects.toMatchObject({
      reason: "PG_DUMP_NOT_FOUND",
      // No amount of waiting installs postgresql17-client.
      retryable: false,
    });
  });

  it("removes the .part file when the final tar fails, so nothing looks complete", async () => {
    const backupId = await newBackupRow();
    // pg_dump succeeds, the inner tar is never reached (images off), the outer
    // archive tar fails.
    const { run } = fakeRun({ failOn: "tar" });
    await expect(runBackup(deps({ run }), { kind: "manual", backupId })).rejects.toMatchObject({
      reason: "ARCHIVE_TAR_FAILED",
    });
    expect(await archivesIn(backupsDir)).toEqual([]);
  });

  it("refuses to run without a row to write to", async () => {
    await expect(runBackup(deps(), { kind: "manual", backupId: null })).rejects.toMatchObject({
      reason: "BACKUP_ROW_MISSING",
      retryable: false,
    });
  });

  it("starts from empty on a retry rather than reusing a previous attempt's files", async () => {
    const backupId = await newBackupRow();
    // Plant debris where the previous attempt's staging directory would be.
    const staging = path.join(backupsDir, ".staging", backupId);
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "db.dump"), "stale-half-written-dump");

    const result = await runBackup(deps({ run: fakeRun({ dumpBytes: "fresh" }).run }), {
      kind: "manual",
      backupId,
    });
    expect(result.manifest.files.find((f) => f.name === "db.dump")!.bytes).toBe(5);
  });
});

describe("pruneBackups", () => {
  it("prunes past the retention window and leaves anything inside it", async () => {
    const now = new Date("2026-09-09T00:00:00Z");
    const at = (daysAgo: number): Date => new Date(now.getTime() - daysAgo * 86_400_000);

    const oldFile = path.join(backupsDir, "old.tgz");
    await fs.writeFile(oldFile, "old");
    await fs.writeFile(`${oldFile}.sha256`, "old");
    const youngFile = path.join(backupsDir, "young.tgz");
    await fs.writeFile(youngFile, "young");

    const [old] = await db
      .insert(backups)
      .values({ kind: "scheduled", status: "complete", path: oldFile, startedAt: at(31) })
      .returning({ id: backups.id });
    const [young] = await db
      .insert(backups)
      .values({ kind: "scheduled", status: "complete", path: youngFile, startedAt: at(29) })
      .returning({ id: backups.id });

    const pruned = await pruneBackups(deps({ now: () => now }));
    expect(pruned).toBe(1);

    // The file is gone AND the row is soft-deleted with no path — the two must
    // agree or the admin view offers a download of nothing.
    await expect(fs.stat(oldFile)).rejects.toThrow();
    await expect(fs.stat(`${oldFile}.sha256`)).rejects.toThrow();
    const [oldRow] = await db.select().from(backups).where(eq(backups.id, old!.id));
    expect(oldRow!.deletedAt).not.toBeNull();
    expect(oldRow!.path).toBeNull();

    await expect(fs.stat(youngFile)).resolves.toBeTruthy();
    const [youngRow] = await db.select().from(backups).where(eq(backups.id, young!.id));
    expect(youngRow!.deletedAt).toBeNull();
  });

  /** The download route refuses to READ a file outside the volume; this is the
   *  same guard in the direction that matters more, since prune DELETES. */
  it("refuses to unlink a path outside BACKUPS_DIR, but still soft-deletes the row", async () => {
    const now = new Date("2026-09-09T00:00:00Z");
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-elsewhere-"));
    try {
      const outside = path.join(elsewhere, "not-a-backup.tgz");
      await fs.writeFile(outside, "should survive");
      const [row] = await db
        .insert(backups)
        .values({
          kind: "manual",
          status: "complete",
          path: outside,
          startedAt: new Date(now.getTime() - 40 * 86_400_000),
        })
        .returning({ id: backups.id });

      expect(await pruneBackups(deps({ now: () => now }))).toBe(1);
      // The file is untouched...
      expect(await fs.readFile(outside, "utf8")).toBe("should survive");
      // ...and the row is still retired, so the sweep cannot get stuck on it.
      const [after] = await db.select().from(backups).where(eq(backups.id, row!.id));
      expect(after!.deletedAt).not.toBeNull();
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("prunes a failed row that never produced a file", async () => {
    const now = new Date("2026-09-09T00:00:00Z");
    const [failed] = await db
      .insert(backups)
      .values({
        kind: "scheduled",
        status: "failed",
        error: "PG_DUMP_FAILED",
        path: null,
        startedAt: new Date(now.getTime() - 40 * 86_400_000),
      })
      .returning({ id: backups.id });
    expect(await pruneBackups(deps({ now: () => now }))).toBe(1);
    const [row] = await db.select().from(backups).where(eq(backups.id, failed!.id));
    expect(row!.deletedAt).not.toBeNull();
  });

  it("runs as part of a successful backup", async () => {
    const stale = path.join(backupsDir, "stale.tgz");
    await fs.writeFile(stale, "stale");
    await db.insert(backups).values({
      kind: "scheduled",
      status: "complete",
      path: stale,
      startedAt: new Date(Date.now() - 90 * 86_400_000),
    });
    const result = await runBackup(deps(), { kind: "manual", backupId: await newBackupRow() });
    expect(result.pruned).toBe(1);
    await expect(fs.stat(stale)).rejects.toThrow();
  });
});

describe("countArchivedFiles", () => {
  it("counts regular files and excludes directories", () => {
    // Real `tar -tf` output shape, identical on GNU and BSD tar.
    expect(countArchivedFiles("./\n./a/\n./a/one.webp\n./a/b/\n./a/b/two.webp\n")).toBe(2);
  });

  it("is zero for an empty archive", () => {
    expect(countArchivedFiles("./\n")).toBe(0);
    expect(countArchivedFiles("")).toBe(0);
  });
});

describe("clearBackupWorkspace", () => {
  it("removes .part archives and the staging tree, and nothing else", async () => {
    await fs.mkdir(path.join(backupsDir, ".staging", "abc"), { recursive: true });
    await fs.writeFile(path.join(backupsDir, ".staging", "abc", "db.dump"), "x");
    await fs.writeFile(path.join(backupsDir, "ledgerly-backup-1.tgz.part"), "half");
    await fs.writeFile(path.join(backupsDir, "ledgerly-backup-2.tgz"), "whole");
    await fs.writeFile(path.join(backupsDir, "ledgerly-backup-2.tgz.sha256"), "sum");

    expect(await clearBackupWorkspace(backupsDir)).toBe(1);
    // `.staging` is gone too — the assertion is over the whole directory here,
    // not just its files, because that is what the boot sweep is for.
    expect((await fs.readdir(backupsDir)).sort()).toEqual([
      "ledgerly-backup-2.tgz",
      "ledgerly-backup-2.tgz.sha256",
    ]);
  });

  it("is a no-op against a directory that does not exist", async () => {
    expect(await clearBackupWorkspace(path.join(backupsDir, "nope"))).toBe(0);
  });
});

describe("the production image's binaries", () => {
  // Not a skip-if-absent test: `docker/Dockerfile` installs postgresql17-client
  // and tar, and a dev machine without them is normal. This only records which
  // of them this environment has, so a failure in the round-trip suite is
  // attributable rather than mysterious.
  it("reports whether pg_dump and tar are available here", () => {
    expect(typeof hasBinary("pg_dump")).toBe("boolean");
    expect(hasBinary("tar")).toBe(true);
  });
});
