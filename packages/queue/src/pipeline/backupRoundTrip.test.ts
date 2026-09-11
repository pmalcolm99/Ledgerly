import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { backups, receiptItems, receipts } from "@ledgerly/db/schema";

import { countRows, runBackup, type BackupDeps, type BackupManifest } from "./backup";

const execFileAsync = promisify(execFile);

/**
 * packages/queue/src/pipeline/backupRoundTrip.test.ts — the restore drill, as a
 * standing test.
 *
 * Phase 9's gate is a restore drill against a scratch database, and that drill
 * was run by hand in the session that built this (`docs/private/`). This file
 * exists so the gate does not decay back into a hypothesis the moment that
 * session ends: it takes a REAL `pg_dump` of the test database and restores it
 * into a freshly created scratch database **by running `scripts/restore.sh`**,
 * then asserts the row counts equal the manifest — and separately that the
 * script REFUSES a damaged archive and a manifest shape it does not
 * understand, which are the outcomes that actually protect anyone.
 *
 * Skipped when the client tools are absent, or when `pg_dump` is OLDER than the
 * server — it refuses that combination outright rather than producing a partial
 * dump, so the skip is the honest outcome. Both are normal states on a dev
 * machine; `docker/Dockerfile` installs `postgresql17-client` alongside the
 * postgres 17 it talks to, so production is never in either.
 *
 * The skip is announced on stderr rather than being silent. A verification that
 * quietly stops running is precisely the failure mode this phase exists to
 * prevent, and it would be absurd for the drill itself to have it.
 *
 * The scratch database is created and dropped here rather than reusing the
 * suite's, following `apps/web/e2e/prepare-db.ts` — including its refusal to
 * proceed if `DATABASE_URL` is pointed at the database this drops. Cheap, and
 * the failure it prevents is unrecoverable.
 */

const SCRATCH_DB = "ledgerly_restore_drill";

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function clientMajor(): number | null {
  try {
    // "pg_dump (PostgreSQL) 17.11" -> 17
    const out = execFileSync("pg_dump", ["--version"], { encoding: "utf8" });
    const match = /(\d+)/.exec(out.replace(/^\D+/, ""));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function serverMajor(base: string): Promise<number | null> {
  const client = new Client({ connectionString: base });
  await client.connect();
  try {
    // `SELECT current_setting(...) AS v`, not `SHOW server_version` — SHOW
    // names its column after the setting, so reading `.v` off it yields
    // undefined and this function quietly returns null. It did exactly that in
    // CI: the guard below never fired, and three tests failed on a version
    // mismatch they were written to skip.
    const result = await client.query<{ v: string }>(
      "SELECT current_setting('server_version') AS v",
    );
    const match = /^(\d+)/.exec(result.rows[0]?.v ?? "");
    return match ? Number(match[1]) : null;
  } finally {
    await client.end();
  }
}

const toolsPresent = hasBinary("pg_dump") && hasBinary("pg_restore") && hasBinary("tar");

function baseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required (D-18).");
  if (process.env.DATABASE_URL === url) {
    throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL (D-18).");
  }
  if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === `/${SCRATCH_DB}`) {
    throw new Error(`DATABASE_URL points at ${SCRATCH_DB}, which this test drops.`);
  }
  return url;
}

function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function onMaintenanceDb<T>(base: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: withDatabase(base, "postgres") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function recreateScratchDatabase(base: string): Promise<string> {
  await onMaintenanceDb(base, async (client) => {
    // A connection left open by a previous run makes DROP DATABASE fail.
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [SCRATCH_DB],
    );
    await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await client.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  return withDatabase(base, SCRATCH_DB);
}

const realRun: BackupDeps["run"] = async (file, args, opts) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    env: opts.env,
    timeout: opts.timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const RESTORE_SCRIPT = path.join(REPO_ROOT, "scripts", "restore.sh");

/**
 * Runs `scripts/restore.sh` and returns everything it printed.
 *
 * Running the shipped script rather than reimplementing it is the whole point:
 * the script's header claims "the thing that gets tested and the thing an
 * operator reaches for at 2am are the same file", and an earlier version of
 * this test called `pg_restore` directly, which made that false and left the
 * script's manifest validation, refusals and argument handling with no coverage
 * at all.
 *
 * Invoked from a directory that is NOT the repo root, deliberately: the script
 * `cd`s to the repo root early, and a relative `--uploads-dir` used to resolve
 * against that rather than the caller's shell — quietly emptying and
 * repopulating the wrong directory while reporting the restore verified.
 *
 * Refusals exit non-zero and are the interesting cases, so the output is
 * returned rather than the rejection rethrown; callers assert on it.
 */
async function runRestoreScript(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(RESTORE_SCRIPT, args, {
      cwd: os.tmpdir(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return `${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.message ?? ""}`;
  }
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let backupsDir: string;
let uploadsDir: string;

if (!toolsPresent) {
  console.warn(
    "[ledgerly] SKIPPING the backup round-trip drill: pg_dump/pg_restore/tar are " +
      "not on PATH. Install postgresql-client to run it.",
  );
}

describe.skipIf(!toolsPresent)("backup → restore round trip", () => {
  let versionsCompatible = true;

  beforeAll(async () => {
    const base = baseUrl();
    const client = clientMajor();
    const server = await serverMajor(base);
    // pg_dump refuses a server newer than itself ("aborting because of server
    // version mismatch") rather than producing anything, so this combination
    // cannot be tested — it can only be reported.
    if (client !== null && server !== null && client < server) {
      versionsCompatible = false;
      console.warn(
        `[ledgerly] SKIPPING the backup round-trip drill: pg_dump is ${client} and the ` +
          `server is ${server}; pg_dump refuses a newer server. Install ` +
          `postgresql-client-${server} to run it.`,
      );
    }
  });

  beforeEach(async () => {
    await withCleanDatabase();
    db = drizzle(getCleanPool(), { schema });
    backupsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-drill-backups-"));
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-drill-uploads-"));
  });

  afterEach(async () => {
    await fs.rm(backupsDir, { recursive: true, force: true });
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await getCleanPool().end();
    try {
      await onMaintenanceDb(baseUrl(), async (client) => {
        await client.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
          [SCRATCH_DB],
        );
        await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
      });
    } catch {
      // A leftover scratch database is untidy, not a failure — and this runs
      // after every assertion, so it cannot hide a real error.
    }
  });

  it("restores into a scratch database with row counts matching the manifest", async (ctx) => {
    if (!versionsCompatible) return ctx.skip();
    // Data with enough shape that a restore losing one table would be visible:
    // two projects, a member, receipts across statuses, and line items.
    const first = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [{ key: "reader", permission: "read" }],
      name: "drill-one",
    });
    const second = await createTestProjectWithMembers(db, {
      ownerKey: "second",
      members: [],
      name: "drill-two",
    });
    const inserted = await db
      .insert(receipts)
      .values([
        {
          projectId: first.project.id,
          uploadedBy: first.users.owner!.id,
          extractionStatus: "ok",
          merchantName: "Drill Hardware",
          total: "123.45",
        },
        {
          projectId: first.project.id,
          uploadedBy: first.users.owner!.id,
          extractionStatus: "partial",
          merchantName: "Second Merchant",
        },
        {
          projectId: second.project.id,
          uploadedBy: second.users.second!.id,
          extractionStatus: "pending",
        },
      ])
      .returning({ id: receipts.id });
    await db.insert(receiptItems).values([
      { receiptId: inserted[0]!.id, description: "Timber", lineTotal: "100.00", lineNo: 1 },
      { receiptId: inserted[0]!.id, description: "Screws", lineTotal: "23.45", lineNo: 2 },
    ]);

    // A populated uploads tree, so the image half of the archive is exercised
    // rather than assumed.
    await fs.mkdir(path.join(uploadsDir, first.project.id, inserted[0]!.id), { recursive: true });
    await fs.writeFile(
      path.join(uploadsDir, first.project.id, inserted[0]!.id, "display.webp"),
      "not-really-a-webp-but-a-real-file",
    );
    await fs.writeFile(
      path.join(uploadsDir, first.project.id, inserted[0]!.id, "thumb.webp"),
      "thumb",
    );

    const [row] = await db
      .insert(backups)
      .values({ kind: "manual", status: "running" })
      .returning({ id: backups.id });

    const expectedCounts = await countRows(db);

    const result = await runBackup(
      {
        db,
        backupsDir,
        uploadsDir,
        includeImages: true,
        retentionDays: 30,
        logRetentionDays: 90,
        databaseUrl: baseUrl(),
        run: realRun,
      },
      { kind: "manual", backupId: row!.id },
    );

    // The manifest describes the database it was taken from.
    expect(result.manifest.images).toEqual({ included: true, count: 2, bytes: 38 });
    expect(result.manifest.tables).toEqual(expectedCounts);
    expect(result.manifest.schema.appliedMigrations).toBeGreaterThan(0);

    const extracted = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-drill-extract-"));
    try {
      await execFileAsync("tar", ["-xzf", result.archivePath, "-C", extracted]);
      expect((await fs.readdir(extracted)).sort()).toEqual([
        "db.dump",
        "manifest.json",
        "uploads.tar",
      ]);
      const onDisk = JSON.parse(
        await fs.readFile(path.join(extracted, "manifest.json"), "utf8"),
      ) as BackupManifest;
      // The manifest inside the archive is the one the row mirrors — the row
      // additionally carries `archiveSha256`, which cannot be inside the file
      // it checksums.
      expect(onDisk.tables).toEqual(result.manifest.tables);

      const scratchUrl = await recreateScratchDatabase(baseUrl());
      const restoredUploads = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-drill-restored-"));
      const restoreOutput = await runRestoreScript([
        result.archivePath,
        "--database-url",
        scratchUrl,
        "--uploads-dir",
        restoredUploads,
        "--yes",
      ]);
      // The script's own verification has to have PASSED, not merely printed
      // something. Its per-table lines are the same check this test then makes
      // independently below, so a regression in either is visible.
      expect(restoreOutput).toContain("restore verified against the manifest");
      expect(restoreOutput).not.toContain("MISMATCH");

      // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
      const restored = new Client({ connectionString: scratchUrl });
      await restored.connect();
      try {
        const restoredDb = drizzle(restored, { schema });
        expect(await countRows(restoredDb)).toEqual(result.manifest.tables);

        // Not just the counts: a receipt's money and text survive intact.
        const check = await restored.query<{ total: string; items: string }>(
          `SELECT r.total::text AS total,
                  (SELECT count(*) FROM receipt_items i WHERE i.receipt_id = r.id)::text AS items
             FROM receipts r WHERE r.merchant_name = 'Drill Hardware'`,
        );
        expect(check.rows).toHaveLength(1);
        expect(check.rows[0]!.total).toBe("123.45");
        expect(check.rows[0]!.items).toBe("2");
      } finally {
        await restored.end();
      }

      // The images landed where `--uploads-dir` said, with their bytes intact.
      try {
        const restoredFile = path.join(
          restoredUploads,
          first.project.id,
          inserted[0]!.id,
          "display.webp",
        );
        expect(await fs.readFile(restoredFile, "utf8")).toBe("not-really-a-webp-but-a-real-file");
      } finally {
        await fs.rm(restoredUploads, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(extracted, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * The refusals, against the real script.
   *
   * These matter more than the happy path. The Phase 9 review demonstrated that
   * a manifest whose `files`/`tables` keys had been renamed — a plausible
   * future `manifestVersion: 2` — made both verification loops iterate zero
   * times, leaving their counters at zero, and the script printed "restore
   * verified against the manifest" having verified nothing at all, after
   * overwriting the target.
   */
  it("refuses an archive whose manifest it does not understand", async (ctx) => {
    if (!versionsCompatible) return ctx.skip();
    const [row] = await db
      .insert(backups)
      .values({ kind: "manual", status: "running" })
      .returning({ id: backups.id });
    const result = await runBackup(
      {
        db,
        backupsDir,
        uploadsDir,
        includeImages: false,
        retentionDays: 30,
        logRetentionDays: 90,
        databaseUrl: baseUrl(),
        run: realRun,
      },
      { kind: "manual", backupId: row!.id },
    );

    const work = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-drill-bad-"));
    try {
      await execFileAsync("tar", ["-xzf", result.archivePath, "-C", work]);
      const manifestPath = path.join(work, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      // A shape from the future: same data, different key names, higher version.
      manifest.manifestVersion = 2;
      manifest.members = manifest.files;
      manifest.tableCounts = manifest.tables;
      delete manifest.files;
      delete manifest.tables;
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      const badArchive = path.join(backupsDir, "from-the-future.tgz");
      await execFileAsync("tar", ["-czf", badArchive, "-C", work, "."]);

      const scratchUrl = await recreateScratchDatabase(baseUrl());
      const output = await runRestoreScript([badArchive, "--database-url", scratchUrl, "--yes"]);

      expect(output).toContain("version");
      // The precise thing being asserted: it must NOT claim success.
      expect(output).not.toContain("restore verified against the manifest");
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses a damaged archive rather than restoring it", async (ctx) => {
    if (!versionsCompatible) return ctx.skip();
    const [row] = await db
      .insert(backups)
      .values({ kind: "manual", status: "running" })
      .returning({ id: backups.id });
    const result = await runBackup(
      {
        db,
        backupsDir,
        uploadsDir,
        includeImages: false,
        retentionDays: 30,
        logRetentionDays: 90,
        databaseUrl: baseUrl(),
        run: realRun,
      },
      { kind: "manual", backupId: row!.id },
    );

    const work = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-drill-corrupt-"));
    try {
      await execFileAsync("tar", ["-xzf", result.archivePath, "-C", work]);
      const dumpPath = path.join(work, "db.dump");
      const bytes = await fs.readFile(dumpPath);
      // One byte, in the middle. The archive still unpacks; only the checksum
      // knows. (`noUncheckedIndexedAccess` is on, hence the explicit read.)
      const at = Math.floor(bytes.length / 2);
      bytes[at] = (bytes[at] ?? 0) ^ 0xff;
      await fs.writeFile(dumpPath, bytes);
      const corrupted = path.join(backupsDir, "corrupted.tgz");
      await execFileAsync("tar", ["-czf", corrupted, "-C", work, "."]);

      const scratchUrl = await recreateScratchDatabase(baseUrl());
      // `--force` too, to pin that it does NOT cover a damaged archive — it
      // covers a non-empty target, and conflating the two would let a single
      // flag wave past both.
      const output = await runRestoreScript([
        corrupted,
        "--database-url",
        scratchUrl,
        "--force",
        "--yes",
      ]);

      expect(output).toContain("MISMATCH");
      expect(output).toContain("--ignore-checksum");
      expect(output).not.toContain("restore verified against the manifest");
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});
