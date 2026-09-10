import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { auditLog, receiptItems, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/validationFlags.test.ts — acknowledging a validation
 * flag.
 *
 * ## The bug this covers
 *
 * `validation_flags` had no dismissal path at all. `dismissMissingField`
 * handles `missing_fields`; nothing handled these. A flag could only be cleared
 * by editing the numbers until they agreed — and on a receipt that genuinely
 * does not reconcile, that means inventing data.
 *
 * The reported case, reproduced below: a discounted receipt whose printed
 * subtotal already has the discount applied, read by a model that subtracts it
 * a second time. The items and the total agree with each other; only the
 * subtotal is wrong, and it is wrong on the paper as far as the user can tell.
 *
 * The assertion that matters is not "the badge disappears" — it is that the
 * receipt actually LEAVES the review queue, because hiding the warning while
 * leaving `extraction_status='partial'` would move the bug rather than fix it.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

/**
 * The Safelite receipt, to the cent.
 *
 * items 942.02 + tax 52.31 = total 994.33 — those three agree. The subtotal
 * reads 907.03, exactly one 34.99 discount lower than the items sum, so BOTH
 * arithmetic checks trip and neither is the user's fault.
 */
async function discountedReceipt(): Promise<{ id: string; user: AuthUser }> {
  const { project, users } = await createTestProjectWithMembers(db, {
    ownerKey: "owner",
    members: [],
  });
  const [receipt] = await db
    .insert(receipts)
    .values({
      projectId: project.id,
      uploadedBy: users.owner!.id,
      extractionStatus: "partial",
      merchantName: "Safelite AutoGlass",
      subtotal: "907.03",
      salesTax: "52.31",
      total: "994.33",
      transactionDate: "2026-09-01",
      imageKey: "webp",
      validationFlags: ["arithmetic_mismatch_total", "arithmetic_mismatch_items"],
    })
    .returning({ id: receipts.id });

  await db.insert(receiptItems).values([
    { receiptId: receipt!.id, lineNo: 1, description: "Windshield", lineTotal: "977.01" },
    { receiptId: receipt!.id, lineNo: 2, description: "WIPER DISCOUNT", lineTotal: "-34.99" },
  ]);

  return { id: receipt!.id, user: users.owner as unknown as AuthUser };
}

const ctxFor = (user: AuthUser): Context => ({ db, user });

describe("acknowledgeValidationFlag", () => {
  it("clears the flag AND lets the receipt out of the review queue", async () => {
    const { id, user } = await discountedReceipt();
    const caller = appRouter.createCaller(ctxFor(user));

    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });
    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row!.validationFlags).toEqual([]);
    expect(row!.acknowledgedFlags.sort()).toEqual([
      "arithmetic_mismatch_items",
      "arithmetic_mismatch_total",
    ]);
    // The point of the whole exercise: `NEEDS_REVIEW_SQL` reads
    // `extraction_status <> 'ok'`, so without this the receipt stays in the
    // queue with its warning hidden — the bug moved somewhere less visible.
    expect(row!.extractionStatus).toBe("ok");
    expect(row!.reviewedAt).not.toBeNull();
  });

  it("acknowledging one flag leaves the other standing", async () => {
    const { id, user } = await discountedReceipt();
    const caller = appRouter.createCaller(ctxFor(user));

    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row!.validationFlags).toEqual(["arithmetic_mismatch_total"]);
    expect(row!.extractionStatus).toBe("partial");
  });

  /** The failure mode that made the naive fix wrong: `receipts.update`
   *  recomputes the flags, so an acknowledgement that is not subtracted there
   *  lasts exactly until the next edit. */
  it("survives a later field edit, which recomputes the flags", async () => {
    const { id, user } = await discountedReceipt();
    const caller = appRouter.createCaller(ctxFor(user));

    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });
    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" });
    await caller.receipts.update({ id, merchantName: "Safelite AutoGlass Ltd" });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row!.validationFlags).toEqual([]);
    expect(row!.extractionStatus).toBe("ok");
  });

  it("is idempotent", async () => {
    const { id, user } = await discountedReceipt();
    const caller = appRouter.createCaller(ctxFor(user));
    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });
    await expect(
      caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" }),
    ).resolves.toBeTruthy();

    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row!.acknowledgedFlags).toEqual(["arithmetic_mismatch_items"]);
  });

  it("audits who acknowledged what", async () => {
    const { id, user } = await discountedReceipt();
    await appRouter
      .createCaller(ctxFor(user))
      .receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "receipt.flag_acknowledged"));
    expect(row!.entityId).toBe(id);
    expect(row!.metadata).toMatchObject({
      flag: "arithmetic_mismatch_items",
      via: "receipts.acknowledgeValidationFlag",
    });
  });

  it("refuses a flag that is not a real one", async () => {
    const { id, user } = await discountedReceipt();
    await expect(
      appRouter
        .createCaller(ctxFor(user))
        // @ts-expect-error -- the enum is the point; this asserts the runtime guard.
        .receipts.acknowledgeValidationFlag({ id, flag: "not_a_flag" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("unacknowledgeValidationFlag", () => {
  it("puts the flag back when the numbers still fail", async () => {
    const { id, user } = await discountedReceipt();
    const caller = appRouter.createCaller(ctxFor(user));

    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });
    await caller.receipts.unacknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row!.acknowledgedFlags).toEqual([]);
    expect(row!.validationFlags).toContain("arithmetic_mismatch_items");
    expect(row!.extractionStatus).toBe("partial");
  });

  /** An acknowledgement is not a claim that the flag is gone forever — if the
   *  user later corrects the subtotal, the check passes on its own and undoing
   *  must not resurrect a warning that is no longer true. */
  it("does not resurrect a flag the corrected numbers no longer raise", async () => {
    const { id, user } = await discountedReceipt();
    const caller = appRouter.createCaller(ctxFor(user));

    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });
    await caller.receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" });
    // The real subtotal, the one the model should have read.
    await caller.receipts.update({ id, subtotal: "942.02" });
    await caller.receipts.unacknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_items" });
    await caller.receipts.unacknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row!.validationFlags).toEqual([]);
    expect(row!.extractionStatus).toBe("ok");
  });

  it("is idempotent", async () => {
    const { id, user } = await discountedReceipt();
    await expect(
      appRouter
        .createCaller(ctxFor(user))
        .receipts.unacknowledgeValidationFlag({ id, flag: "date_in_future" }),
    ).resolves.toBeTruthy();
  });
});

describe("authorization", () => {
  /**
   * The same two-shaped refusal `dismissMissingField` has, and the shapes are
   * deliberate (`phase7Permissions.test.ts` pins the equivalents):
   *
   *  - `read` cannot reach the receipt at edit scope at all, so it gets
   *    NOT_FOUND — telling a read-only member "FORBIDDEN" would confirm the
   *    receipt exists, which is what the 404-not-403 convention avoids.
   *  - `read_add` CAN reach it, and is refused on ownership, which is a
   *    permission answer rather than an existence one.
   */
  async function flaggedReceipt() {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [
        { key: "reader", permission: "read" },
        { key: "adder", permission: "read_add" },
      ],
    });
    const [receipt] = await db
      .insert(receipts)
      .values({
        projectId: project.id,
        uploadedBy: users.owner!.id,
        extractionStatus: "partial",
        subtotal: "10.00",
        salesTax: "1.00",
        total: "99.00",
        validationFlags: ["arithmetic_mismatch_total"],
      })
      .returning({ id: receipts.id });
    return { id: receipt!.id, users };
  }

  it("a read-only member gets NOT_FOUND, not a confirmation the receipt exists", async () => {
    const { id, users } = await flaggedReceipt();
    await expect(
      appRouter
        .createCaller(ctxFor(users.reader as unknown as AuthUser))
        .receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("read_add is refused on someone else's receipt", async () => {
    const { id, users } = await flaggedReceipt();
    await expect(
      appRouter
        .createCaller(ctxFor(users.adder as unknown as AuthUser))
        .receipts.acknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the same two refusals apply to undoing an acknowledgement", async () => {
    const { id, users } = await flaggedReceipt();
    await expect(
      appRouter
        .createCaller(ctxFor(users.reader as unknown as AuthUser))
        .receipts.unacknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      appRouter
        .createCaller(ctxFor(users.adder as unknown as AuthUser))
        .receipts.unacknowledgeValidationFlag({ id, flag: "arithmetic_mismatch_total" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
