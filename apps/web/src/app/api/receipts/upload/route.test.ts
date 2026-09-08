import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
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

/**
 * apps/web/src/app/api/receipts/upload/route.test.ts — task 5.1/5.2/5.9
 * acceptance.
 *
 * `@ledgerly/db/client`'s `getDb` is mocked so that BOTH this route's own
 * queries (via injected `deps.db`, see route.ts) AND the identity
 * resolution `requireAuthRoute` performs internally (packages/auth's
 * `resolveUserForIdentity`, which calls the real, un-injectable `getDb()`)
 * land in the SAME test database (D-18 -- tests must never touch
 * `DATABASE_URL`). `@ledgerly/auth/cloudflareAccess`'s `verifyAccessJwt` is
 * mocked so a request can authenticate as a specific pre-created test user
 * by sending that user's `cfAccessSub` (set by `mkTestUser`/
 * `createTestProjectWithMembers` as `sub-<key>`) as a literal bearer value
 * in the `Cf-Access-Jwt-Assertion` header -- never a real JWT.
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

const { handleUpload } = await import("./handler");

let uploadsDir: string;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-upload-route-test-"));
});

afterEach(async () => {
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await getCleanPool().end();
});

function testEnv() {
  return { ...getEnv(), UPLOADS_DIR: uploadsDir, REDIS_URL: process.env.TEST_REDIS_URL ?? "" };
}

function authHeaders(sub: string): Headers {
  return new Headers({ "cf-access-jwt-assertion": sub });
}

async function jpegFile(name: string, opts?: { width?: number; height?: number }): Promise<File> {
  const bytes = await sharp({
    create: {
      width: opts?.width ?? 100,
      height: opts?.height ?? 80,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .jpeg()
    .toBuffer();
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

function requestFor(projectId: string, files: File[], sub: string): Request {
  const formData = new FormData();
  formData.set("projectId", projectId);
  for (const file of files) formData.append("files", file);
  return new Request("http://localhost/api/receipts/upload", {
    method: "POST",
    headers: authHeaders(sub),
    body: formData,
  });
}

describe("POST /api/receipts/upload -- authorization", () => {
  it("returns 403 with no identity at all", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner1", members: [] });
    const formData = new FormData();
    formData.set("projectId", project.id);
    formData.append("files", await jpegFile("a.jpg"));
    const request = new Request("http://localhost/api/receipts/upload", {
      method: "POST",
      body: formData,
    });

    const response = await handleUpload(request, { db, env: testEnv() });
    expect(response.status).toBe(403);
  });

  it("returns 404 for a user with no relationship to the project (not 403)", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner2", members: [] });
    // A pre-existing, already-onboarded user with no membership row on this
    // project at all -- distinct from an unseen `sub`, which would instead
    // hit JIT provisioning's first-owner election on a freshly truncated
    // test database and fail earlier at the onboarding check.
    await mkTestUser(db, "stranger");
    const request = requestFor(project.id, [await jpegFile("a.jpg")], "sub-stranger");

    const response = await handleUpload(request, { db, env: testEnv() });
    expect(response.status).toBe(404);
  });

  it("returns 404 for a read-only member (below read_add)", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner3",
      members: [{ key: "reader", permission: "read" }],
    });
    const request = requestFor(project.id, [await jpegFile("a.jpg")], "sub-reader");

    const response = await handleUpload(request, { db, env: testEnv() });
    expect(response.status).toBe(404);
  });

  it("accepts a read_add member", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner4",
      members: [{ key: "adder", permission: "read_add" }],
    });
    const request = requestFor(project.id, [await jpegFile("a.jpg")], "sub-adder");

    const response = await handleUpload(request, { db, env: testEnv() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results[0]?.ok).toBe(true);
  });
});

describe("POST /api/receipts/upload -- guards, before any decode", () => {
  it("rejects an oversized file without creating a receipt row", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner5", members: [] });
    const bigFile = new File([new Uint8Array(10)], "big.jpg", { type: "image/jpeg" });
    const request = requestFor(project.id, [bigFile], "sub-owner5");

    const response = await handleUpload(request, {
      db,
      env: { ...testEnv(), MAX_UPLOAD_BYTES: 5 },
    });
    const body = (await response.json()) as { results: Array<{ ok: boolean; error?: string }> };
    expect(body.results[0]).toMatchObject({ ok: false, error: "FILE_TOO_LARGE" });

    const rows = await db.select().from(receipts).where(eq(receipts.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects a file whose magic bytes don't match any accepted type, regardless of claimed Content-Type/filename", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner6", members: [] });
    const notAnImage = new File(
      [new TextEncoder().encode("<html>not a photo</html>")],
      "receipt.jpg",
      {
        type: "image/jpeg",
      },
    );
    const request = requestFor(project.id, [notAnImage], "sub-owner6");

    const response = await handleUpload(request, { db, env: testEnv() });
    const body = (await response.json()) as { results: Array<{ ok: boolean; error?: string }> };
    expect(body.results[0]).toMatchObject({ ok: false, error: "UNRECOGNIZED_OR_MISLABELED_TYPE" });

    const rows = await db.select().from(receipts).where(eq(receipts.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects an image over the megapixel cap without creating a receipt row", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner7", members: [] });
    const file = await jpegFile("huge.jpg", { width: 2000, height: 2000 });
    const request = requestFor(project.id, [file], "sub-owner7");

    // 2000x2000 = 4MP; cap it at 1MP so this fixture-sized (but real,
    // decodable) JPEG trips the guard without needing a multi-gigapixel
    // file.
    const response = await handleUpload(request, {
      db,
      env: { ...testEnv(), MAX_UPLOAD_MEGAPIXELS: 1 },
    });
    const body = (await response.json()) as { results: Array<{ ok: boolean; error?: string }> };
    expect(body.results[0]).toMatchObject({ ok: false, error: "IMAGE_TOO_LARGE_MEGAPIXELS" });

    const rows = await db.select().from(receipts).where(eq(receipts.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  it("accepts a good file, creates a pending receipt, and stages the raw bytes", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner8", members: [] });
    const request = requestFor(project.id, [await jpegFile("good.jpg")], "sub-owner8");

    const response = await handleUpload(request, { db, env: testEnv() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<{ ok: boolean; receiptId?: string }> };
    expect(body.results[0]?.ok).toBe(true);
    const receiptId = body.results[0]?.receiptId;
    expect(receiptId).toBeTruthy();

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId!));
    expect(row?.extractionStatus).toBe("pending");

    const stagedPath = path.join(uploadsDir, project.id, receiptId!, "staging.bin");
    await expect(fs.access(stagedPath)).resolves.toBeUndefined();
  });
});

describe("POST /api/receipts/upload -- partial batch success", () => {
  it("rejects only the bad file in a batch; the rest still upload", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner9", members: [] });
    const good = await jpegFile("good.jpg");
    const bad = new File([new TextEncoder().encode("garbage")], "bad.jpg", { type: "image/jpeg" });
    const request = requestFor(project.id, [good, bad], "sub-owner9");

    const response = await handleUpload(request, { db, env: testEnv() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ filename: string; ok: boolean; error?: string }>;
    };
    expect(body.results).toHaveLength(2);
    expect(body.results.find((r) => r.filename === "good.jpg")?.ok).toBe(true);
    expect(body.results.find((r) => r.filename === "bad.jpg")).toMatchObject({
      ok: false,
      error: "UNRECOGNIZED_OR_MISLABELED_TYPE",
    });

    const rows = await db.select().from(receipts).where(eq(receipts.projectId, project.id));
    expect(rows).toHaveLength(1);
  });
});

describe("POST /api/receipts/upload -- rate limiting", () => {
  it("returns 429 once the per-user limit is exceeded, charging the whole batch atomically", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner10",
      members: [],
    });
    const env = { ...testEnv(), UPLOAD_RATE_LIMIT_PER_MIN: 1 };

    const first = await handleUpload(
      requestFor(project.id, [await jpegFile("a.jpg")], "sub-owner10"),
      {
        db,
        env,
      },
    );
    expect(first.status).toBe(200);

    const second = await handleUpload(
      requestFor(project.id, [await jpegFile("b.jpg")], "sub-owner10"),
      {
        db,
        env,
      },
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });

  it("returns 413, not 429, for a batch whose file count alone exceeds the limit -- it could never fit", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner10b",
      members: [],
    });
    const env = { ...testEnv(), UPLOAD_RATE_LIMIT_PER_MIN: 1 };

    const response = await handleUpload(
      requestFor(project.id, [await jpegFile("a.jpg"), await jpegFile("b.jpg")], "sub-owner10b"),
      { db, env },
    );
    expect(response.status).toBe(413);
  });
});

describe("POST /api/receipts/upload -- request-size guards (H-1)", () => {
  it("returns 413 for a Content-Length far beyond any plausible batch, before touching the body", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner11",
      members: [],
    });
    const formData = new FormData();
    formData.set("projectId", project.id);
    formData.append("files", await jpegFile("a.jpg"));
    const body = formData;
    const request = new Request("http://localhost/api/receipts/upload", {
      method: "POST",
      headers: new Headers({
        "cf-access-jwt-assertion": "sub-owner11",
        // Lie about Content-Length to prove the check reads the header,
        // not the actual body size -- this is exactly the case the guard
        // exists to catch cheaply, before formData() ever runs.
        "content-length": String(100 * 1024 * 1024 * 1024),
      }),
      body,
    });

    const response = await handleUpload(request, { db, env: testEnv() });
    expect(response.status).toBe(413);
  });

  it("returns 413 for more files than MAX_FILES_PER_BATCH", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner12",
      members: [],
    });
    const files = await Promise.all(Array.from({ length: 61 }, (_, i) => jpegFile(`f${i}.jpg`)));
    const request = requestFor(project.id, files, "sub-owner12");

    const response = await handleUpload(request, {
      db,
      env: { ...testEnv(), UPLOAD_RATE_LIMIT_PER_MIN: 1000 },
    });
    expect(response.status).toBe(413);

    const rows = await db.select().from(receipts).where(eq(receipts.projectId, project.id));
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/receipts/upload -- persistence failure handling (H-2)", () => {
  it("marks the receipt failed, rather than leaving it pending with no record, when staging the file fails", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner13",
      members: [],
    });
    // UPLOADS_DIR points at a path that is itself a FILE, not a
    // directory -- every write underneath it fails with ENOTDIR, so this
    // exercises the same failure class as a real disk/permission error
    // without needing to fake the filesystem.
    const blockingFile = path.join(uploadsDir, "not-a-directory");
    await fs.writeFile(blockingFile, "x");
    const request = requestFor(project.id, [await jpegFile("a.jpg")], "sub-owner13");

    const response = await handleUpload(request, {
      db,
      env: { ...testEnv(), UPLOADS_DIR: blockingFile },
    });
    expect(response.status).toBe(200); // the request itself is well-formed
    const body = (await response.json()) as { results: Array<{ ok: boolean; error?: string }> };
    expect(body.results[0]).toMatchObject({ ok: false, error: "INTERNAL_ERROR" });

    const rows = await db.select().from(receipts).where(eq(receipts.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.extractionStatus).toBe("failed");
    expect(rows[0]?.extractionError).toBe("UPLOAD_PERSISTENCE_FAILED");
  });
});
