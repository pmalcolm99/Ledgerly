import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { auditLog, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";
import { receiptFilePath, writeReceiptFile } from "@ledgerly/api/storage";

import { appRouter } from "../root";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/receipts.test.ts — `receipts.delete`
 * acceptance: the own-only matrix mirroring `members.test.ts`'s pattern,
 * NOT_FOUND-not-FORBIDDEN on a nonexistent/already-deleted receipt, the
 * audit row, and that the image directory is actually removed.
 *
 * `UPLOADS_DIR` is set once, before any procedure call, to a temp
 * directory -- `packages/config`'s `getEnv()` caches on first call within
 * this file's isolated module registry, so this must happen before the
 * router's first `getEnv()` invocation, not per-test.
 */

let uploadsDir: string;

beforeAll(async () => {
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-receipts-router-test-"));
  process.env.UPLOADS_DIR = uploadsDir;
});

afterAll(async () => {
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxFor = (user: AuthUser | null): Context => ({ db, user });

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

async function insertReceipt(projectId: string, uploadedBy: string | null): Promise<string> {
  const [row] = await db
    .insert(receipts)
    .values({
      projectId,
      uploadedBy,
      extractionStatus: "pending",
      imageKey: "webp",
      thumbKey: "webp",
    })
    .returning({ id: receipts.id });
  if (!row) throw new Error("failed to insert test receipt");
  await writeReceiptFile(
    receiptFilePath(uploadsDir, projectId, row.id, "display", "webp"),
    Buffer.from("x"),
  );
  return row.id;
}

describe("receipts.delete -- own-only matrix", () => {
  it("a read_add member can delete their OWN receipt", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner1",
      members: [{ key: "adder", permission: "read_add" }],
    });
    const receiptId = await insertReceipt(project.id, users.adder!.id);
    const caller = appRouter.createCaller(ctxFor(users.adder!));

    const result = await caller.receipts.delete({ id: receiptId });
    expect(result.id).toBe(receiptId);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.deletedAt).not.toBeNull();
  });

  it("a read_add member CANNOT delete another user's receipt (FORBIDDEN)", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner2",
      members: [
        { key: "adder", permission: "read_add" },
        { key: "otherAdder", permission: "read_add" },
      ],
    });
    const receiptId = await insertReceipt(project.id, users.otherAdder!.id);
    const caller = appRouter.createCaller(ctxFor(users.adder!));

    await expect(caller.receipts.delete({ id: receiptId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a full member can delete ANY receipt in the project", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner3",
      members: [
        { key: "full", permission: "full" },
        { key: "adder", permission: "read_add" },
      ],
    });
    const receiptId = await insertReceipt(project.id, users.adder!.id);
    const caller = appRouter.createCaller(ctxFor(users.full!));

    const result = await caller.receipts.delete({ id: receiptId });
    expect(result.id).toBe(receiptId);
  });

  it("the project owner can delete any receipt", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner4",
      members: [{ key: "adder", permission: "read_add" }],
    });
    const receiptId = await insertReceipt(project.id, users.adder!.id);
    const caller = appRouter.createCaller(ctxFor(users.owner4!));

    const result = await caller.receipts.delete({ id: receiptId });
    expect(result.id).toBe(receiptId);
  });

  it("the instance owner can delete any receipt", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner5",
      members: [{ key: "adder", permission: "read_add" }],
    });
    const receiptId = await insertReceipt(project.id, users.adder!.id);
    const instanceOwner = await mkTestUser(db, "instance-owner", "owner");
    const caller = appRouter.createCaller(ctxFor(instanceOwner));

    const result = await caller.receipts.delete({ id: receiptId });
    expect(result.id).toBe(receiptId);
  });

  it("a read-only member cannot delete at all (NOT_FOUND -- fails the scope gate, not the escalation guard)", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner6",
      members: [{ key: "reader", permission: "read" }],
    });
    const receiptId = await insertReceipt(project.id, users.reader!.id);
    const caller = appRouter.createCaller(ctxFor(users.reader!));

    await expect(caller.receipts.delete({ id: receiptId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("a user with no relationship to the project gets NOT_FOUND", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner7",
      members: [],
    });
    const receiptId = await insertReceipt(project.id, users.owner7!.id);
    const stranger = await mkTestUser(db, "stranger");
    const caller = appRouter.createCaller(ctxFor(stranger));

    await expect(caller.receipts.delete({ id: receiptId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("receipts.delete -- other behavior", () => {
  it("NOT_FOUND for a nonexistent receipt id", async () => {
    const { users } = await createTestProjectWithMembers(db, { ownerKey: "owner8", members: [] });
    const caller = appRouter.createCaller(ctxFor(users.owner8!));

    await expect(
      caller.receipts.delete({ id: "99999999-9999-9999-9999-999999999999" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("NOT_FOUND on a second delete of the same receipt", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner9",
      members: [],
    });
    const receiptId = await insertReceipt(project.id, users.owner9!.id);
    const caller = appRouter.createCaller(ctxFor(users.owner9!));

    await caller.receipts.delete({ id: receiptId });
    await expect(caller.receipts.delete({ id: receiptId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("writes exactly one receipt.deleted audit row", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner10",
      members: [],
    });
    const receiptId = await insertReceipt(project.id, users.owner10!.id);
    const caller = appRouter.createCaller(ctxFor(users.owner10!));

    await caller.receipts.delete({ id: receiptId });

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, receiptId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("receipt.deleted");
    expect(rows[0]?.actorUserId).toBe(users.owner10!.id);
  });

  it("deletes the image directory only after the DB transaction commits", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner11",
      members: [],
    });
    const receiptId = await insertReceipt(project.id, users.owner11!.id);
    const displayPath = receiptFilePath(uploadsDir, project.id, receiptId, "display", "webp");
    await expect(fs.access(displayPath)).resolves.toBeUndefined();

    const caller = appRouter.createCaller(ctxFor(users.owner11!));
    await caller.receipts.delete({ id: receiptId });

    await expect(fs.access(displayPath)).rejects.toThrow();
  });
});
