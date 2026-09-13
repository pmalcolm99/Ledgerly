import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";
import { RECEIPT_SORTS } from "@ledgerly/shared/receiptSort";
import type { ReceiptSort } from "@ledgerly/shared/receiptSort";

import { appRouter } from "../root";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/receiptSort.test.ts — the project page's orderings
 * and search (D-47).
 *
 * THE ASSERTION THIS FILE EXISTS FOR is the page walk. A keyset cursor that
 * disagrees with its own ORDER BY does not throw — it silently skips or repeats
 * rows at a page boundary, and the only way to see it is to walk every page and
 * compare against the whole set. That is exactly the class of bug D-46's review
 * found in `admin.logs`, and there are now six orderings to get wrong instead
 * of one.
 *
 * The fixtures deliberately include NULLs in both sort columns and a repeated
 * merchant name: the null block and the tie are where a keyset predicate breaks.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

const ctxFor = (user: AuthUser): Context => ({ db, user });

/**
 * Nine receipts: three with no date, two sharing a merchant name, one with no
 * merchant at all. `created_at` is set explicitly so `added_*` has something
 * deterministic to order by.
 */
async function seed(projectId: string): Promise<number> {
  const rows = [
    { merchantName: "Ace Hardware", transactionDate: "2026-03-01" },
    { merchantName: "Bunnings", transactionDate: "2026-01-15" },
    { merchantName: "Ace Hardware", transactionDate: "2026-02-01" },
    { merchantName: "Zeller Fuel", transactionDate: "2026-04-10" },
    { merchantName: null, transactionDate: "2026-02-20" },
    { merchantName: "Ace Hardware", transactionDate: null },
    { merchantName: "Mitre 10", transactionDate: null },
    { merchantName: null, transactionDate: null },
    { merchantName: "Bunnings", transactionDate: "2026-01-15" },
  ];

  let index = 0;
  for (const row of rows) {
    await db.insert(receipts).values({
      projectId,
      merchantName: row.merchantName,
      transactionDate: row.transactionDate,
      extractionStatus: "ok",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    });
    index += 1;
  }
  return rows.length;
}

async function project() {
  const { project: p, users } = await createTestProjectWithMembers(db, {
    ownerKey: "sorter",
    members: [],
  });
  return { projectId: p.id, user: users.sorter! as unknown as AuthUser };
}

/** Walks every page and returns the ids in the order they were handed out. */
async function walk(
  caller: ReturnType<typeof appRouter.createCaller>,
  projectId: string,
  sort: ReceiptSort,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let page = await caller.receipts.list({ projectId, sort, limit });
  seen.push(...page.items.map((i) => i.id));
  let guard = 0;
  while (page.nextCursor && guard < 50) {
    page = await caller.receipts.list({ projectId, sort, limit, cursor: page.nextCursor });
    seen.push(...page.items.map((i) => i.id));
    guard += 1;
  }
  return seen;
}

describe("receipts.list — ordering", () => {
  it("defaults to newest purchase first, as it did before there was a choice", async () => {
    const { projectId, user } = await project();
    await seed(projectId);

    const page = await appRouter.createCaller(ctxFor(user)).receipts.list({ projectId });
    const dates = page.items.map((i) => i.transactionDate);
    // Non-null dates descending, then the null block at the end.
    const nonNull = dates.filter((d): d is string => d !== null);
    expect([...nonNull].sort((a, b) => b.localeCompare(a))).toEqual(nonNull);
    expect(dates.slice(nonNull.length).every((d) => d === null)).toBe(true);
  });

  it("orders by merchant name in both directions, nulls last", async () => {
    const { projectId, user } = await project();
    await seed(projectId);
    const caller = appRouter.createCaller(ctxFor(user));

    const asc = await caller.receipts.list({ projectId, sort: "name_asc" });
    const ascNames = asc.items.map((i) => i.merchantName).filter((n): n is string => n !== null);
    expect([...ascNames].sort((a, b) => a.localeCompare(b))).toEqual(ascNames);
    expect(asc.items.at(-1)?.merchantName).toBeNull();

    const desc = await caller.receipts.list({ projectId, sort: "name_desc" });
    const descNames = desc.items.map((i) => i.merchantName).filter((n): n is string => n !== null);
    expect([...descNames].sort((a, b) => b.localeCompare(a))).toEqual(descNames);
    // NULLS LAST in BOTH directions — an unreadable merchant is the least
    // useful thing to lead a list with, whichever way it is sorted.
    expect(desc.items.at(-1)?.merchantName).toBeNull();
  });

  it("orders by date added", async () => {
    const { projectId, user } = await project();
    await seed(projectId);
    const caller = appRouter.createCaller(ctxFor(user));

    const recent = await caller.receipts.list({ projectId, sort: "added_desc" });
    const times = recent.items.map((i) => i.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const first = await caller.receipts.list({ projectId, sort: "added_asc" });
    expect(first.items[0]!.id).toBe(recent.items.at(-1)!.id);
  });

  /** THE ASSERTION THIS FILE EXISTS FOR. */
  it.each(RECEIPT_SORTS)("pages through every row exactly once: %s", async (sort) => {
    const { projectId, user } = await project();
    const total = await seed(projectId);
    const caller = appRouter.createCaller(ctxFor(user));

    // A page size that does not divide the row count, so a boundary lands
    // mid-run rather than tidily between groups.
    const seen = await walk(caller, projectId, sort, 2);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  /** The page walk must agree with the single-page answer, or paging quietly
   *  reorders the list as the user scrolls. */
  it.each(RECEIPT_SORTS)("pages in the same order as one whole page: %s", async (sort) => {
    const { projectId, user } = await project();
    await seed(projectId);
    const caller = appRouter.createCaller(ctxFor(user));

    const whole = await caller.receipts.list({ projectId, sort, limit: 100 });
    const paged = await walk(caller, projectId, sort, 2);
    expect(paged).toEqual(whole.items.map((i) => i.id));
  });

  it("stops offering a cursor on the last page", async () => {
    const { projectId, user } = await project();
    await seed(projectId);
    const page = await appRouter
      .createCaller(ctxFor(user))
      .receipts.list({ projectId, limit: 100 });
    expect(page.nextCursor).toBeNull();
  });
});

describe("receipts.list — search", () => {
  it("matches a fragment of the merchant name, case-insensitively", async () => {
    const { projectId, user } = await project();
    await seed(projectId);
    const caller = appRouter.createCaller(ctxFor(user));

    const page = await caller.receipts.list({ projectId, q: "ace hard" });
    expect(page.items).toHaveLength(3);
    expect(page.items.every((i) => i.merchantName === "Ace Hardware")).toBe(true);
  });

  /** A `%` in a search box is a character someone typed, not an operator.
   *  Unescaped it matches every row, which is the opposite of searching. */
  it("treats a wildcard character as a literal", async () => {
    const { projectId, user } = await project();
    await db.insert(receipts).values({
      projectId,
      merchantName: "50% Off Store",
      extractionStatus: "ok",
    });
    await seed(projectId);
    const caller = appRouter.createCaller(ctxFor(user));

    const page = await caller.receipts.list({ projectId, q: "50%" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.merchantName).toBe("50% Off Store");
  });

  it("combines with a sort and still pages correctly", async () => {
    const { projectId, user } = await project();
    await seed(projectId);
    const caller = appRouter.createCaller(ctxFor(user));

    let page = await caller.receipts.list({ projectId, q: "ace", sort: "date_asc", limit: 2 });
    const seen = page.items.map((i) => i.id);
    while (page.nextCursor) {
      page = await caller.receipts.list({
        projectId,
        q: "ace",
        sort: "date_asc",
        limit: 2,
        cursor: page.nextCursor,
      });
      seen.push(...page.items.map((i) => i.id));
    }
    expect(new Set(seen).size).toBe(3);
  });

  it("returns nothing rather than everything for a search that matches nothing", async () => {
    const { projectId, user } = await project();
    await seed(projectId);
    const page = await appRouter
      .createCaller(ctxFor(user))
      .receipts.list({ projectId, q: "no such merchant" });
    expect(page.items).toEqual([]);
  });
});
