import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { receipts } from "@ledgerly/db/schema";
import { getEnv } from "@ledgerly/config/env";
import { receiptFilePath, writeReceiptFile } from "@ledgerly/api/storage";

/**
 * apps/web/src/app/api/images/[...key]/route.test.ts — task 5.8
 * acceptance: another user's receipt id returns 404, identical to a
 * nonexistent id; no identity at all returns 403. See
 * ../../receipts/upload/route.test.ts's header comment for why `getDb`
 * and `verifyAccessJwt` are mocked this way.
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

const { handleImageGet } = await import("./handler");

let uploadsDir: string;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-images-route-test-"));
});

afterEach(async () => {
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await getCleanPool().end();
});

function testEnv() {
  return { ...getEnv(), UPLOADS_DIR: uploadsDir };
}

function requestWith(sub: string | null): Request {
  const headers = sub ? new Headers({ "cf-access-jwt-assertion": sub }) : new Headers();
  return new Request("http://localhost/api/images/x", { headers });
}

async function insertProcessedReceipt(projectId: string): Promise<string> {
  const [row] = await db
    .insert(receipts)
    .values({ projectId, extractionStatus: "pending", imageKey: "webp", thumbKey: "webp" })
    .returning({ id: receipts.id });
  if (!row) throw new Error("failed to insert test receipt");
  await writeReceiptFile(
    receiptFilePath(uploadsDir, projectId, row.id, "display", "webp"),
    Buffer.from("fake-webp-bytes"),
  );
  return row.id;
}

describe("GET /api/images/[...key] -- 403 vs 404 boundary", () => {
  it("returns 403 with no identity at all", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner1", members: [] });
    const receiptId = await insertProcessedReceipt(project.id);

    const response = await handleImageGet(requestWith(null), [receiptId, "display"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(403);
  });

  it("returns 404, not 403, for an authenticated user with no access to the receipt", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner2", members: [] });
    const receiptId = await insertProcessedReceipt(project.id);
    await mkTestUser(db, "stranger");

    const response = await handleImageGet(requestWith("sub-stranger"), [receiptId, "display"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("returns byte-identical 404s for a nonexistent id and another user's real receipt id", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner3", members: [] });
    const realReceiptId = await insertProcessedReceipt(project.id);
    await mkTestUser(db, "stranger2");

    const forReal = await handleImageGet(requestWith("sub-stranger2"), [realReceiptId, "display"], {
      db,
      env: testEnv(),
    });
    const forFake = await handleImageGet(
      requestWith("sub-stranger2"),
      ["99999999-9999-9999-9999-999999999999", "display"],
      { db, env: testEnv() },
    );

    expect(forReal.status).toBe(404);
    expect(forFake.status).toBe(404);
    expect(await forReal.text()).toBe(await forFake.text());
    expect([...forReal.headers.entries()]).toEqual([...forFake.headers.entries()]);
  });

  it("returns 404 for a malformed key (wrong segment count)", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner4", members: [] });
    const receiptId = await insertProcessedReceipt(project.id);

    const response = await handleImageGet(requestWith("sub-owner4"), [receiptId], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("returns 404 for a render that hasn't been produced yet (null column)", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner5", members: [] });
    const [row] = await db
      .insert(receipts)
      .values({ projectId: project.id, extractionStatus: "pending" }) // no imageKey/thumbKey/originalKey
      .returning({ id: receipts.id });

    const response = await handleImageGet(requestWith("sub-owner5"), [row!.id, "display"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/images/[...key] -- success", () => {
  it("streams the display render for a member with read access", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner6",
      members: [{ key: "reader", permission: "read" }],
    });
    const receiptId = await insertProcessedReceipt(project.id);

    const response = await handleImageGet(requestWith("sub-reader"), [receiptId, "display"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(await response.text()).toBe("fake-webp-bytes");
  });

  it("returns 404 when the DB row exists but the file on disk is gone", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner7", members: [] });
    const receiptId = await insertProcessedReceipt(project.id);
    await fs.rm(receiptFilePath(uploadsDir, project.id, receiptId, "display", "webp"));

    const response = await handleImageGet(requestWith("sub-owner7"), [receiptId, "display"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("excludes a soft-deleted receipt's images", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner8", members: [] });
    const receiptId = await insertProcessedReceipt(project.id);
    await db.update(receipts).set({ deletedAt: new Date() }).where(eq(receipts.id, receiptId));

    const response = await handleImageGet(requestWith("sub-owner8"), [receiptId, "display"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("sets streaming/security headers -- content-length, nosniff, inline disposition, long cache", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner9", members: [] });
    const receiptId = await insertProcessedReceipt(project.id);

    const response = await handleImageGet(requestWith("sub-owner9"), [receiptId, "display"], {
      db,
      env: testEnv(),
    });
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength("fake-webp-bytes")),
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="receipt.webp"');
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400, must-revalidate");
  });
});

describe("GET /api/images/[...key] -- original access restriction (M-3)", () => {
  async function insertReceiptWithOriginal(
    projectId: string,
    uploadedBy: string | null,
  ): Promise<string> {
    const [row] = await db
      .insert(receipts)
      .values({ projectId, uploadedBy, extractionStatus: "pending", originalKey: "jpg" })
      .returning({ id: receipts.id });
    if (!row) throw new Error("failed to insert test receipt");
    await writeReceiptFile(
      receiptFilePath(uploadsDir, projectId, row.id, "original", "jpg"),
      Buffer.from("raw-original-bytes"),
    );
    return row.id;
  }

  it("lets the uploader fetch their own original", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner10",
      members: [{ key: "adder", permission: "read_add" }],
    });
    const receiptId = await insertReceiptWithOriginal(project.id, users.adder!.id);

    const response = await handleImageGet(requestWith("sub-adder"), [receiptId, "original"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="receipt.jpg"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("blocks a different read_add member from another member's original (404, not 403)", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner11",
      members: [
        { key: "adder", permission: "read_add" },
        { key: "otherAdder", permission: "read_add" },
      ],
    });
    const receiptId = await insertReceiptWithOriginal(project.id, users.otherAdder!.id);

    const response = await handleImageGet(requestWith("sub-adder"), [receiptId, "original"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(404);
  });

  it("blocks a plain read member from anyone's original, even though they can read display/thumb", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner12",
      members: [{ key: "reader", permission: "read" }],
    });
    const receiptId = await insertReceiptWithOriginal(project.id, users.owner12!.id);

    const original = await handleImageGet(requestWith("sub-reader"), [receiptId, "original"], {
      db,
      env: testEnv(),
    });
    expect(original.status).toBe(404);
  });

  it("lets a full member fetch any receipt's original in the project", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner13",
      members: [
        { key: "full", permission: "full" },
        { key: "adder", permission: "read_add" },
      ],
    });
    const receiptId = await insertReceiptWithOriginal(project.id, users.adder!.id);

    const response = await handleImageGet(requestWith("sub-full"), [receiptId, "original"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(200);
  });

  it("lets the project owner fetch any receipt's original", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner14",
      members: [{ key: "adder", permission: "read_add" }],
    });
    const receiptId = await insertReceiptWithOriginal(project.id, users.adder!.id);

    const response = await handleImageGet(requestWith("sub-owner14"), [receiptId, "original"], {
      db,
      env: testEnv(),
    });
    expect(response.status).toBe(200);
  });
});
