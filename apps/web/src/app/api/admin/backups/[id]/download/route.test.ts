import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCleanPool, mkTestUser, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { auditLog, backups, users } from "@ledgerly/db/schema";
import { getEnv } from "@ledgerly/config/env";

/**
 * apps/web/src/app/api/admin/backups/[id]/download/route.test.ts — Phase 9.
 *
 * The endpoint hands over the entire database in one file, so the assertions
 * that matter are the refusals. In particular: a non-owner and a nonexistent
 * backup must be **indistinguishable**, or this becomes an oracle telling any
 * signed-in user how many backups exist and when they ran.
 *
 * `getDb` and `verifyAccessJwt` are mocked exactly as the images route's suite
 * does — see its header for why.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@ledgerly/db/client", () => ({
  getDb: () => db,
  getPool: () => {
    throw new Error("getPool() should not be called in this test suite");
  },
}));

vi.mock("@ledgerly/auth/cloudflareAccess", () => ({
  verifyAccessJwt: vi.fn(async (token: string | null) => {
    if (!token) return { ok: false, reason: "missing_token" };
    return {
      ok: true,
      identity: {
        sub: token,
        email: `${token}@example.com`,
        name: "Test User",
        issuedAt: 0,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    };
  }),
  currentAccessConfig: vi.fn(() => ({ aud: "test-aud", teamDomain: "test.cloudflareaccess.com" })),
}));

const { handleBackupDownload } = await import("./handler");

let backupsDir: string;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
  backupsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-backup-route-test-"));
});

afterEach(async () => {
  await fs.rm(backupsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await getCleanPool().end();
});

function testEnv() {
  return { ...getEnv(), BACKUPS_DIR: backupsDir };
}

function requestWith(sub: string | null): Request {
  const headers = sub ? new Headers({ "cf-access-jwt-assertion": sub }) : new Headers();
  return new Request("http://localhost/api/admin/backups/x/download", { headers });
}

/** The instance owner. `mkTestUser` creates a plain user; the role is what
 *  this endpoint gates on. */
async function mkOwner(key: string): Promise<void> {
  const user = await mkTestUser(db, key);
  await db.update(users).set({ role: "owner" }).where(eq(users.id, user.id));
}

async function completedBackup(
  opts: { contents?: string; deletedAt?: Date; pathOverride?: string | null } = {},
): Promise<{ id: string; file: string }> {
  const file = path.join(backupsDir, "ledgerly-backup-20260909T120000Z.tgz");
  await fs.writeFile(file, opts.contents ?? "fake-archive-bytes");
  const [row] = await db
    .insert(backups)
    .values({
      kind: "manual",
      status: "complete",
      path: opts.pathOverride === undefined ? file : opts.pathOverride,
      sizeBytes: (opts.contents ?? "fake-archive-bytes").length,
      finishedAt: new Date(),
      deletedAt: opts.deletedAt ?? null,
    })
    .returning({ id: backups.id });
  return { id: row!.id, file };
}

describe("GET /api/admin/backups/[id]/download — who gets in", () => {
  it("returns 403 with no identity at all", async () => {
    await mkOwner("owner");
    const backup = await completedBackup();
    const response = await handleBackupDownload(requestWith(null), backup.id, {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(403);
  });

  /**
   * The assertion this endpoint exists to satisfy. A member must not be able to
   * tell "you are not the owner" from "there is no such backup" — otherwise
   * probing ids reveals how many backups this instance has.
   */
  it("gives a non-owner the same 404 as a nonexistent backup", async () => {
    await mkOwner("owner");
    await mkTestUser(db, "member");
    const backup = await completedBackup();

    const asMember = await handleBackupDownload(requestWith("sub-member"), backup.id, {
      db,
      env: testEnv(),
    });
    const missing = await handleBackupDownload(
      requestWith("sub-member"),
      "00000000-0000-4000-8000-000000000000",
      { db, env: testEnv() },
    );

    expect(asMember.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await asMember.text()).toBe(await missing.text());
  });

  it("serves the archive to the owner with an accurate content-length", async () => {
    await mkOwner("owner");
    const backup = await completedBackup({ contents: "twenty-bytes-here!!!" });

    const response = await handleBackupDownload(requestWith("sub-owner"), backup.id, {
      db,
      env: testEnv(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("20");
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="ledgerly-backup-20260909T120000Z.tgz"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("twenty-bytes-here!!!");
  });

  it("sends the size on disk, not the size the row recorded", async () => {
    await mkOwner("owner");
    const backup = await completedBackup({ contents: "abc" });
    // A row claiming a different size than the file. A wrong content-length
    // makes the browser truncate at it, producing a corrupt archive that looks
    // like it downloaded fine.
    await db.update(backups).set({ sizeBytes: 999_999 }).where(eq(backups.id, backup.id));

    const response = await handleBackupDownload(requestWith("sub-owner"), backup.id, {
      db,
      env: testEnv(),
    });
    expect(response.headers.get("content-length")).toBe("3");
  });

  it("audits the download before the first byte, with no path in the metadata", async () => {
    await mkOwner("owner");
    const backup = await completedBackup();
    await handleBackupDownload(requestWith("sub-owner"), backup.id, { db, env: testEnv() });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "backup.downloaded"));
    expect(row!.entityType).toBe("backup");
    expect(row!.entityId).toBe(backup.id);
    // The whole point of keeping `path` out of `admin.backups` is that a host
    // filesystem path is infrastructure detail; an append-only log recording it
    // is the same disclosure with a longer half-life.
    expect(JSON.stringify(row!.metadata)).not.toContain(backupsDir);
  });
});

describe("GET /api/admin/backups/[id]/download — rows that cannot be served", () => {
  it("404s a soft-deleted backup", async () => {
    await mkOwner("owner");
    const backup = await completedBackup({ deletedAt: new Date() });
    const response = await handleBackupDownload(requestWith("sub-owner"), backup.id, {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("404s a row whose file retention has already unlinked", async () => {
    await mkOwner("owner");
    const backup = await completedBackup();
    await fs.rm(backup.file);
    const response = await handleBackupDownload(requestWith("sub-owner"), backup.id, {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("404s a row with no artifact at all", async () => {
    await mkOwner("owner");
    const backup = await completedBackup({ pathOverride: null });
    const response = await handleBackupDownload(requestWith("sub-owner"), backup.id, {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("404s a backup that is still running or has failed", async () => {
    await mkOwner("owner");
    const file = path.join(backupsDir, "half.tgz");
    await fs.writeFile(file, "half");
    for (const status of ["running", "failed"] as const) {
      const [row] = await db
        .insert(backups)
        .values({ kind: "manual", status, path: file })
        .returning({ id: backups.id });
      const response = await handleBackupDownload(requestWith("sub-owner"), row!.id, {
        db,
        env: testEnv(),
      });
      expect(response.status).toBe(404);
    }
  });

  it("404s a malformed id rather than letting pg raise a cast error", async () => {
    await mkOwner("owner");
    const response = await handleBackupDownload(requestWith("sub-owner"), "not-a-uuid", {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  /**
   * Defence in depth. `path` is written by the pipeline from `BACKUPS_DIR` and
   * never from anything a user supplies, so reaching this requires a row edited
   * in the database — but the failure it prevents is "stream any file the
   * process can read", which is worth one realpath.
   */
  it("404s a row whose path points outside BACKUPS_DIR", async () => {
    await mkOwner("owner");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-elsewhere-"));
    try {
      const escaped = path.join(outside, "secrets.tgz");
      await fs.writeFile(escaped, "should never be served");
      const [row] = await db
        .insert(backups)
        .values({ kind: "manual", status: "complete", path: escaped })
        .returning({ id: backups.id });

      const response = await handleBackupDownload(requestWith("sub-owner"), row!.id, {
        db,
        env: testEnv(),
      });
      expect(response.status).toBe(404);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("404s a symlink inside BACKUPS_DIR that points outside it", async () => {
    await mkOwner("owner");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-elsewhere-"));
    try {
      const secret = path.join(outside, "secret.txt");
      await fs.writeFile(secret, "should never be served");
      const link = path.join(backupsDir, "innocent.tgz");
      await fs.symlink(secret, link);
      const [row] = await db
        .insert(backups)
        .values({ kind: "manual", status: "complete", path: link })
        .returning({ id: backups.id });

      const response = await handleBackupDownload(requestWith("sub-owner"), row!.id, {
        db,
        env: testEnv(),
      });
      expect(response.status).toBe(404);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
