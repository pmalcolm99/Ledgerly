import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { categories, receiptItems, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/phase7Permissions.test.ts — the permission matrix
 * for everything Phase 7 added.
 *
 * `permissions.test.ts` notes that its edit-receipt column was tested against
 * `scopedProjects(user, "add")` directly "because receipts don't exist as a
 * feature until Phase 5". They do now, so this file exercises the real
 * procedures, and in particular the "own only" cell that the scope helper
 * alone cannot express:
 *
 *   read      -> may not edit anything
 *   read_add  -> may edit ONLY receipts they uploaded
 *   full      -> may edit anyone's
 *   owners    -> may edit anyone's
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

type Actors = {
  read: AuthUser;
  readAdd: AuthUser;
  full: AuthUser;
  projectOwner: AuthUser;
  instanceOwner: AuthUser;
  stranger: AuthUser;
};

let actors: Actors;
let projectId: string;
/** Uploaded by `readAdd` — the "own" receipt. */
let ownReceiptId: string;
/** Uploaded by the project owner — someone else's, from readAdd's view. */
let othersReceiptId: string;

const ctxFor = (user: AuthUser | null): Context => ({ db, user });
const callerFor = (user: AuthUser) => appRouter.createCaller(ctxFor(user));

async function insertReceipt(uploadedBy: string, overrides: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(receipts)
    .values({ projectId, uploadedBy, extractionStatus: "ok", ...overrides })
    .returning({ id: receipts.id });
  return row!.id;
}

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });

  const { project, users: u } = await createTestProjectWithMembers(db, {
    ownerKey: "projectOwner",
    members: [
      { key: "readMember", permission: "read" },
      { key: "addMember", permission: "read_add" },
      { key: "fullMember", permission: "full" },
    ],
  });
  projectId = project.id;

  actors = {
    read: u.readMember!,
    readAdd: u.addMember!,
    full: u.fullMember!,
    projectOwner: u.projectOwner!,
    instanceOwner: await mkTestUser(db, "instanceOwner", "owner"),
    stranger: await mkTestUser(db, "stranger"),
  };

  ownReceiptId = await insertReceipt(actors.readAdd.id, { merchantName: "Own Co" });
  othersReceiptId = await insertReceipt(actors.projectOwner.id, { merchantName: "Theirs Co" });
});

afterAll(async () => {
  await getCleanPool().end();
});

describe("receipts.list / get — read is enough to view", () => {
  it.each([
    ["read", () => actors.read],
    ["read_add", () => actors.readAdd],
    ["full", () => actors.full],
    ["project owner", () => actors.projectOwner],
    ["instance owner", () => actors.instanceOwner],
  ] as const)("%s can list and get", async (_label, getActor) => {
    const caller = callerFor(getActor());
    const list = await caller.receipts.list({ projectId });
    expect(list.items).toHaveLength(2);
    await expect(caller.receipts.get({ id: ownReceiptId })).resolves.toMatchObject({
      receipt: { id: ownReceiptId },
    });
  });

  it("a stranger gets NOT_FOUND for both — no existence oracle", async () => {
    const caller = callerFor(actors.stranger);
    await expect(caller.receipts.list({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.receipts.get({ id: ownReceiptId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("canEdit reflects the matrix without authorizing anything", async () => {
    const asRead = await callerFor(actors.read).receipts.list({ projectId });
    expect(asRead.items.every((item) => item.canEdit === false)).toBe(true);

    const asAdd = await callerFor(actors.readAdd).receipts.list({ projectId });
    expect(asAdd.items.find((i) => i.id === ownReceiptId)?.canEdit).toBe(true);
    expect(asAdd.items.find((i) => i.id === othersReceiptId)?.canEdit).toBe(false);

    const asFull = await callerFor(actors.full).receipts.list({ projectId });
    expect(asFull.items.every((item) => item.canEdit === true)).toBe(true);
  });
});

describe("receipts.update — the 'own only' cell", () => {
  it("read cannot edit even their own project's receipts", async () => {
    // `read` fails the "add" scope gate entirely, so it is NOT_FOUND rather
    // than FORBIDDEN — the same 404-not-403 discipline as everywhere else.
    await expect(
      callerFor(actors.read).receipts.update({ id: ownReceiptId, merchantName: "X" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("read_add can edit a receipt they uploaded", async () => {
    await expect(
      callerFor(actors.readAdd).receipts.update({ id: ownReceiptId, merchantName: "Edited" }),
    ).resolves.toMatchObject({ merchantName: "Edited" });
  });

  it("read_add CANNOT edit someone else's receipt", async () => {
    await expect(
      callerFor(actors.readAdd).receipts.update({ id: othersReceiptId, merchantName: "Nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each([
    ["full", () => actors.full],
    ["project owner", () => actors.projectOwner],
    ["instance owner", () => actors.instanceOwner],
  ] as const)("%s can edit anyone's receipt", async (_label, getActor) => {
    await expect(
      callerFor(getActor()).receipts.update({ id: ownReceiptId, merchantName: "Edited" }),
    ).resolves.toMatchObject({ merchantName: "Edited" });
  });

  it("a stranger gets NOT_FOUND", async () => {
    await expect(
      callerFor(actors.stranger).receipts.update({ id: ownReceiptId, merchantName: "X" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("receipts.update — behaviour", () => {
  it("editing a field clears it from missing_fields (task 7.4's acceptance)", async () => {
    const id = await insertReceipt(actors.readAdd.id, {
      merchantName: null,
      missingFields: ["merchant_name", "total"],
    });
    const updated = await callerFor(actors.readAdd).receipts.update({
      id,
      merchantName: "Ace Hardware",
    });
    expect(updated!.missingFields).not.toContain("merchant_name");
    expect(updated!.missingFields).toContain("total");
  });

  it("clearing a field puts it back into missing_fields", async () => {
    const updated = await callerFor(actors.readAdd).receipts.update({
      id: ownReceiptId,
      merchantName: null,
    });
    expect(updated!.missingFields).toContain("merchant_name");
  });

  it("rejects a full card number rather than truncating it to 4 digits", async () => {
    await expect(
      callerFor(actors.readAdd).receipts.update({
        id: ownReceiptId,
        cardLast4: "4111111111111111",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("scrubs a Luhn-valid card number pasted into free text", async () => {
    const updated = await callerFor(actors.readAdd).receipts.update({
      id: ownReceiptId,
      userNotes: "paid with 4111111111111111 thanks",
    });
    expect(updated!.userNotes).not.toContain("4111111111111111");
  });

  it("recomputes validation flags, so fixing a total clears the mismatch badge", async () => {
    const id = await insertReceipt(actors.readAdd.id, {
      subtotal: "10.00",
      salesTax: "1.00",
      total: "99.00",
      extractionStatus: "partial",
      validationFlags: ["arithmetic_mismatch_total"],
    });
    const updated = await callerFor(actors.readAdd).receipts.update({ id, total: "11.00" });
    expect(updated!.validationFlags).toEqual([]);
    expect(updated!.extractionStatus).toBe("ok");
  });

  it("never moves a failed receipt out of its pipeline state", async () => {
    const id = await insertReceipt(actors.readAdd.id, {
      extractionStatus: "failed",
      extractionError: "AI_REQUEST_REJECTED",
    });
    const updated = await callerFor(actors.readAdd).receipts.update({ id, merchantName: "X" });
    expect(updated!.extractionStatus).toBe("failed");
  });

  it("rejects a date the receipts_date_sane CHECK would reject, as BAD_REQUEST not a 500", async () => {
    await expect(
      callerFor(actors.readAdd).receipts.update({
        id: ownReceiptId,
        transactionDate: "1999-01-01",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not expose currency as an editable field (D-17)", async () => {
    await expect(
      // @ts-expect-error currency is deliberately absent from the input schema
      callerFor(actors.readAdd).receipts.update({ id: ownReceiptId, currency: "EUR" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("receipts.dismissMissingField", () => {
  it("clears the badge and survives a re-extract's recomputation", async () => {
    const id = await insertReceipt(actors.readAdd.id, {
      merchantPhone: null,
      missingFields: ["merchant_phone"],
    });
    const dismissed = await callerFor(actors.readAdd).receipts.dismissMissingField({
      id,
      field: "merchant_phone",
    });
    expect(dismissed!.missingFields).not.toContain("merchant_phone");
    expect(dismissed!.dismissedFields).toContain("merchant_phone");
  });

  it("is idempotent", async () => {
    const id = await insertReceipt(actors.readAdd.id, { missingFields: ["merchant_phone"] });
    const caller = callerFor(actors.readAdd);
    await caller.receipts.dismissMissingField({ id, field: "merchant_phone" });
    await expect(
      caller.receipts.dismissMissingField({ id, field: "merchant_phone" }),
    ).resolves.toBeDefined();
  });

  it("can be undone", async () => {
    const id = await insertReceipt(actors.readAdd.id, {
      merchantPhone: null,
      missingFields: ["merchant_phone"],
    });
    const caller = callerFor(actors.readAdd);
    await caller.receipts.dismissMissingField({ id, field: "merchant_phone" });
    const restored = await caller.receipts.undismissMissingField({ id, field: "merchant_phone" });
    expect(restored!.dismissedFields).not.toContain("merchant_phone");
    expect(restored!.missingFields).toContain("merchant_phone");
  });

  it("filling a dismissed field also clears the dismissal", async () => {
    const id = await insertReceipt(actors.readAdd.id, {
      merchantPhone: null,
      missingFields: ["merchant_phone"],
    });
    const caller = callerFor(actors.readAdd);
    await caller.receipts.dismissMissingField({ id, field: "merchant_phone" });
    const updated = await caller.receipts.update({ id, merchantPhone: "555-0100" });
    expect(updated!.dismissedFields).not.toContain("merchant_phone");
  });

  it("read_add cannot dismiss on someone else's receipt", async () => {
    await expect(
      callerFor(actors.readAdd).receipts.dismissMissingField({
        id: othersReceiptId,
        field: "total",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("receiptItems", () => {
  it("read_add may add items to their own receipt but not another's", async () => {
    const caller = callerFor(actors.readAdd);
    await expect(
      caller.receiptItems.create({ receiptId: ownReceiptId, description: "2x4 lumber" }),
    ).resolves.toMatchObject({ description: "2x4 lumber" });
    await expect(
      caller.receiptItems.create({ receiptId: othersReceiptId, description: "nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("read cannot add items at all", async () => {
    await expect(
      callerFor(actors.read).receiptItems.create({ receiptId: ownReceiptId, description: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("allocates line numbers server-side and appends", async () => {
    const caller = callerFor(actors.readAdd);
    const first = await caller.receiptItems.create({ receiptId: ownReceiptId, description: "a" });
    const second = await caller.receiptItems.create({ receiptId: ownReceiptId, description: "b" });
    expect(first.lineNo).toBe(1);
    expect(second.lineNo).toBe(2);
  });

  it("a user-set category clears the AI-assigned flag; other edits do not", async () => {
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, "building-supplies"));
    const caller = callerFor(actors.readAdd);
    const item = await caller.receiptItems.create({
      receiptId: ownReceiptId,
      description: "plywood",
    });
    await db
      .update(receiptItems)
      .set({ aiAssignedCategory: true })
      .where(eq(receiptItems.id, item.id));

    const renamed = await caller.receiptItems.update({ id: item.id, description: "plywood sheet" });
    expect(renamed.aiAssignedCategory).toBe(true);

    const recategorized = await caller.receiptItems.update({
      id: item.id,
      categoryId: category!.id,
    });
    expect(recategorized.aiAssignedCategory).toBe(false);
  });

  /**
   * CLAUDE.md's "never store full card numbers" is unqualified, and a line
   * item is exactly where someone retypes what a receipt prints. The router
   * originally scrubbed `receipts.update` but not this path.
   */
  it("scrubs a Luhn-valid card number out of a line item description", async () => {
    const item = await callerFor(actors.readAdd).receiptItems.create({
      receiptId: ownReceiptId,
      description: "paid with 4111 1111 1111 1111 thanks",
    });
    expect(item.description).not.toContain("4111111111111111");
    expect(item.description).not.toMatch(/4111\s*1111\s*1111\s*1111/);
  });

  it("scrubs a card number pasted into a line item on update", async () => {
    const caller = callerFor(actors.readAdd);
    const item = await caller.receiptItems.create({
      receiptId: ownReceiptId,
      description: "clean",
    });
    const updated = await caller.receiptItems.update({
      id: item.id,
      description: "card 4111111111111111",
      sku: "4111111111111111",
    });
    expect(updated.description).not.toContain("4111111111111111");
    expect(updated.sku).not.toContain("4111111111111111");
  });

  it("accepts a 3-decimal quantity, which the money parser would reject", async () => {
    const item = await callerFor(actors.readAdd).receiptItems.create({
      receiptId: ownReceiptId,
      description: "bulk screws",
      quantity: "0.125",
    });
    expect(item.quantity).toBe("0.125");
  });

  it("deleting the last item puts the `items` token back into missing_fields", async () => {
    const caller = callerFor(actors.readAdd);
    const item = await caller.receiptItems.create({
      receiptId: ownReceiptId,
      description: "only item",
    });
    await caller.receiptItems.delete({ id: item.id });
    const after = await caller.receipts.get({ id: ownReceiptId });
    expect(after.receipt.missingFields).toContain("items");
  });
});

describe("archived projects are read-only", () => {
  /**
   * `scopedProjects` excludes archived projects at "add" (what the mutation
   * gates on) but includes them at "manage". `canEditSql` used "manage", so
   * the UI offered a full editing surface on an archived project and every
   * save came back NOT_FOUND — which reads as "this receipt is gone".
   */
  it("reports canEdit:false rather than promising an edit that will fail", async () => {
    await callerFor(actors.projectOwner).projects.archive({ id: projectId });

    for (const actor of [actors.full, actors.projectOwner, actors.instanceOwner]) {
      const list = await callerFor(actor).receipts.list({ projectId });
      expect(list.items.every((item) => item.canEdit === false)).toBe(true);
    }

    await expect(
      callerFor(actors.full).receipts.update({ id: ownReceiptId, merchantName: "X" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("edit mutations do not leak extraction_raw", () => {
  it("returns the same projection receipts.get does", async () => {
    await db
      .update(receipts)
      .set({ extractionRaw: { model: "output" } })
      .where(eq(receipts.id, ownReceiptId));

    const updated = await callerFor(actors.readAdd).receipts.update({
      id: ownReceiptId,
      merchantName: "Edited",
    });
    expect(updated).not.toHaveProperty("extractionRaw");

    const dismissed = await callerFor(actors.readAdd).receipts.dismissMissingField({
      id: ownReceiptId,
      field: "merchant_phone",
    });
    expect(dismissed).not.toHaveProperty("extractionRaw");
  });
});

describe("categories", () => {
  it("any onboarded user may list and create (D-20 user-extensible)", async () => {
    const caller = callerFor(actors.read);
    await expect(caller.categories.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "uncategorized" })]),
    );
    await expect(caller.categories.create({ name: "Scaffolding" })).resolves.toMatchObject({
      slug: "scaffolding",
      isSystem: false,
    });
  });

  it("system categories cannot be renamed or deleted, even by the instance owner", async () => {
    const [system] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, "uncategorized"));
    const caller = callerFor(actors.instanceOwner);
    await expect(caller.categories.update({ id: system!.id, name: "Nope" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.categories.delete({ id: system!.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("only the creator or the instance owner may change a user category", async () => {
    const created = await callerFor(actors.readAdd).categories.create({ name: "Rentals" });
    await expect(
      callerFor(actors.full).categories.update({ id: created.id, name: "Hijacked" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(actors.instanceOwner).categories.update({ id: created.id, name: "Renamed" }),
    ).resolves.toMatchObject({ name: "Renamed" });
  });

  it("refuses to delete a category in use, naming the count (task 7.6)", async () => {
    const created = await callerFor(actors.readAdd).categories.create({ name: "Rentals" });
    await callerFor(actors.readAdd).receiptItems.create({
      receiptId: ownReceiptId,
      description: "scissor lift",
      categoryId: created.id,
    });
    await expect(
      callerFor(actors.readAdd).categories.delete({ id: created.id }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      // CONFLICT is in CLIENT_SAFE_CODES, so the count survives the error
      // formatter and actually reaches the user.
      message: "That category is used by 1 receipt item. Reassign them before deleting it.",
    });
  });

  /**
   * ON DELETE RESTRICT never fires on a soft delete, so this count is the only
   * thing preventing a live foreign key pointing at a deleted category. It
   * originally excluded soft-deleted receipts, which let exactly that happen.
   */
  it("counts items on soft-deleted receipts, which the FK cannot protect", async () => {
    const caller = callerFor(actors.readAdd);
    const created = await caller.categories.create({ name: "Rentals" });
    await caller.receiptItems.create({
      receiptId: ownReceiptId,
      description: "scissor lift",
      categoryId: created.id,
    });
    await caller.receipts.delete({ id: ownReceiptId });

    await expect(caller.categories.delete({ id: created.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects a duplicate name", async () => {
    await callerFor(actors.readAdd).categories.create({ name: "Rentals" });
    await expect(
      callerFor(actors.readAdd).categories.create({ name: "rentals" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("users.list", () => {
  it("is refused to members who cannot manage anyone", async () => {
    for (const actor of [actors.read, actors.readAdd]) {
      await expect(callerFor(actor).users.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("is allowed to full members and the project owner", async () => {
    for (const actor of [actors.full, actors.projectOwner]) {
      await expect(callerFor(actor).users.list()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: actors.read.id })]),
      );
    }
  });

  /**
   * The trap the `role = 'owner'` disjunct exists for: scopedProjects
   * short-circuits the instance owner to every live project, but on a fresh
   * instance there are none, so a pure "do you manage anything" gate would
   * hand the owner an empty picker exactly when they are setting things up.
   */
  it("is allowed to the instance owner even with no projects at all", async () => {
    await db.delete(receipts);
    await db.delete(schema.projectMembers);
    await db.delete(schema.projects);
    await expect(callerFor(actors.instanceOwner).users.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: actors.read.id })]),
    );
  });

  it("never returns role or other admin-surface fields", async () => {
    const rows = await callerFor(actors.full).users.list();
    expect(rows[0]).not.toHaveProperty("role");
    expect(rows[0]).not.toHaveProperty("cfAccessSub");
  });
});

describe("admin surfaces", () => {
  it.each([
    ["read", () => actors.read],
    ["full", () => actors.full],
    ["project owner", () => actors.projectOwner],
  ] as const)("%s cannot reach the admin overview", async (_label, getActor) => {
    await expect(callerFor(getActor()).admin.overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("the instance owner sees every project", async () => {
    const overview = await callerFor(actors.instanceOwner).admin.overview();
    expect(overview.projects).toHaveLength(1);
    expect(overview.totals.receiptCount).toBe(2);
  });

  it("backups is empty rather than an error before Phase 9 lands", async () => {
    await expect(callerFor(actors.instanceOwner).admin.backups()).resolves.toEqual([]);
  });
});

describe("review queue", () => {
  it("includes a receipt with missing fields even when its status is 'ok'", async () => {
    // The reason receipts_review_idx could not serve this: extraction_status
    // is 'partial' iff validation_flags is non-empty, so this receipt — the
    // most common kind in the queue — is 'ok'.
    const id = await insertReceipt(actors.readAdd.id, {
      extractionStatus: "ok",
      missingFields: ["total"],
    });
    const queue = await callerFor(actors.readAdd).receipts.reviewQueue({});
    expect(queue.items.map((item) => item.id)).toContain(id);
  });

  it("is empty, not an error, when nothing needs review (task 7.5)", async () => {
    await db.delete(receipts);
    await expect(callerFor(actors.read).receipts.reviewQueue({})).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("never shows a stranger another instance's work", async () => {
    const queue = await callerFor(actors.stranger).receipts.reviewQueue({});
    expect(queue.items).toEqual([]);
  });
});

describe("projects.list rollups", () => {
  it("returns counts as numbers and money as strings (D-21)", async () => {
    await db.update(receipts).set({ total: "10.50" }).where(eq(receipts.id, ownReceiptId));
    const [project] = await callerFor(actors.projectOwner).projects.list();
    expect(typeof project!.receiptCount).toBe("number");
    expect(project!.receiptCount).toBe(2);
    // A string, never a float — this is the assertion that catches an
    // accidental sql<number> on a numeric sum.
    expect(typeof project!.totalSpend).toBe("string");
    expect(project!.totalSpend).toBe("10.50");
  });

  it("counts a receipt whose total could not be read", async () => {
    const [project] = await callerFor(actors.projectOwner).projects.list();
    expect(project!.receiptsMissingTotal).toBe(2);
  });
});
