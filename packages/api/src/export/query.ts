import "server-only";

import { and, asc, desc, eq, exists, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { categories, receiptItems, receipts, users } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth";
import type { Database } from "@ledgerly/db";

import { NEEDS_REVIEW_SQL, receiptIsReadable } from "../receiptAccess";
import type { ExportFilters } from "./filters";

/**
 * packages/api/src/export/query.ts — the export's read path.
 *
 * Two queries, called in a loop: a keyset page of receipts, then that page's
 * line items. Everything the three sheets need comes out of those two, in one
 * pass — see `workbook.ts` for why a single pass is what makes the sheets
 * reconcile by construction rather than by luck.
 *
 * The filter block is a deliberate mirror of `routers/receipts.ts`'s `list`
 * (its lines 104-136), down to the correlated `EXISTS` for `categoryId` and
 * the verbatim `NEEDS_REVIEW_SQL`. Two rules make that mirroring matter:
 *
 *  - `NEEDS_REVIEW_SQL` must be embedded as the shared `SQL` object, not
 *    retyped, or the partial index `receipts_needs_review_idx` stops
 *    matching and the planner silently loses it.
 *  - The category filter selects RECEIPTS that contain a matching item, not
 *    the matching items themselves. That is what `list` does, so the export
 *    covers exactly the receipts that were on screen — and because every
 *    item of every selected receipt is then written, sheet 2's totals still
 *    reconcile against sheet 1's line totals. Filtering items here instead
 *    would silently break the reconciliation the whole phase exists to
 *    guarantee.
 */

/** Rows per keyset page. Not a user-facing limit — the loop runs until the
 *  project is exhausted — just the size of the working set held at once. */
export const EXPORT_BATCH_SIZE = 500;

/**
 * Refuses to start an export whose receipt-grain buffer would be unbounded
 * in practice. Line items stream and never accumulate; the sheet-2 rows do
 * accumulate, at roughly 200 bytes each, so this caps that at a few tens of
 * megabytes rather than letting a pathological project OOM the server.
 */
export const MAX_EXPORT_RECEIPTS = 50_000;

export type ExportReceiptRow = {
  id: string;
  projectId: string;
  transactionDate: string | null;
  merchantName: string | null;
  subtotal: string | null;
  salesTax: string | null;
  tip: string | null;
  total: string | null;
  currency: string;
  cardLast4: string | null;
  paymentMethod: string | null;
  userNotes: string | null;
  imageKey: string | null;
  needsReview: boolean;
  itemCount: number;
  uploaderDisplayName: string | null;
  uploaderFirstName: string | null;
  uploaderLastName: string | null;
};

export type ExportItemRow = {
  receiptId: string;
  lineNo: number;
  description: string;
  categoryName: string | null;
  quantity: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
};

export type ReceiptCursor = { transactionDate: string | null; id: string };

/**
 * The filter predicates, built once per page. Identical in shape and order to
 * `list`'s, so a future change to one is visibly a change to the other.
 */
function filterConditions(db: Database, user: AuthUser, projectId: string, filters: ExportFilters) {
  const conditions = [
    eq(receipts.projectId, projectId),
    // The project-scope + liveness predicate, composed into the row query
    // itself rather than trusted from a preceding probe (ARCHITECTURE.md
    // §4.3, CLAUDE.md's "authorization at the query layer" hard rule).
    receiptIsReadable(user),
  ];

  if (filters.from) conditions.push(gte(receipts.transactionDate, filters.from));
  if (filters.to) conditions.push(lte(receipts.transactionDate, filters.to));
  if (filters.uploadedBy) conditions.push(eq(receipts.uploadedBy, filters.uploadedBy));
  if (filters.needsReview) conditions.push(NEEDS_REVIEW_SQL);

  if (filters.categoryId) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(receiptItems)
          .where(
            and(
              eq(receiptItems.receiptId, receipts.id),
              eq(receiptItems.categoryId, filters.categoryId),
            ),
          ),
      ),
    );
  }

  return conditions;
}

export type ExportPreflight = {
  receiptCount: number;
  /** The distinct currencies in the filtered set. D-17: totals are summed
   *  without regard to currency, which is correct only while there is one.
   *  The workbook needs this BEFORE it writes a cell, to choose a number
   *  format and to say so in the header block if the set is mixed. */
  currencies: string[];
};

/**
 * One cheap query, run before a single byte of a workbook exists, that
 * answers both "is this export too large to buffer receipt-grain rows for"
 * and "what currency should money cells be formatted in".
 */
export async function exportPreflight(
  db: Database,
  user: AuthUser,
  projectId: string,
  filters: ExportFilters,
): Promise<ExportPreflight> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      currencies: sql<string[]>`coalesce(array_agg(distinct ${receipts.currency}), '{}')`,
    })
    .from(receipts)
    .where(and(...filterConditions(db, user, projectId, filters)));

  return {
    receiptCount: row?.n ?? 0,
    // `char(3)` is blank-padded by Postgres on some paths; trim so a format
    // lookup never misses on "USD ".
    currencies: (row?.currencies ?? []).map((c) => c.trim()).filter((c) => c !== ""),
  };
}

/**
 * One keyset page, ordered `(transaction_date DESC NULLS LAST, id DESC)` —
 * the ordering `receipts_project_date_idx` is built for and the one the
 * dashboard list already uses, so an export reads in the order the user saw.
 *
 * Keyset, not OFFSET, for the same reason `list` is: an offset walked across
 * a live table duplicates and skips rows. It cannot do either here; the only
 * way to move a row out from under this loop is to edit a not-yet-read
 * receipt's `transaction_date` mid-export, which is not worth holding a pool
 * connection open in a REPEATABLE READ transaction for the whole duration of
 * a client's download to prevent.
 */
export async function fetchReceiptPage(
  db: Database,
  user: AuthUser,
  projectId: string,
  filters: ExportFilters,
  cursor: ReceiptCursor | null,
  limit: number = EXPORT_BATCH_SIZE,
): Promise<ExportReceiptRow[]> {
  const conditions = filterConditions(db, user, projectId, filters);

  if (cursor) {
    if (cursor.transactionDate === null) {
      // Already inside the trailing NULL-date bucket.
      conditions.push(
        and(isNull(receipts.transactionDate), lt(receipts.id, cursor.id)) ?? sql`true`,
      );
    } else {
      conditions.push(
        or(
          lt(receipts.transactionDate, cursor.transactionDate),
          and(eq(receipts.transactionDate, cursor.transactionDate), lt(receipts.id, cursor.id)),
          // NULLS LAST: the whole null bucket sorts after any real date.
          isNull(receipts.transactionDate),
        ) ?? sql`true`,
      );
    }
  }

  const rows = await db
    .select({
      id: receipts.id,
      projectId: receipts.projectId,
      transactionDate: receipts.transactionDate,
      merchantName: receipts.merchantName,
      subtotal: receipts.subtotal,
      salesTax: receipts.salesTax,
      tip: receipts.tip,
      total: receipts.total,
      currency: receipts.currency,
      cardLast4: receipts.cardLast4,
      paymentMethod: receipts.paymentMethod,
      userNotes: receipts.userNotes,
      imageKey: receipts.imageKey,
      // The same expression the review queue filters on, so the column and
      // the filter can never disagree about what "needs review" means.
      needsReview: sql<boolean>`${NEEDS_REVIEW_SQL}`,
      // Correlated subquery, not a join: joining receipt_items to get a
      // count multiplies the receipt row per item and forces a GROUP BY that
      // discards the ordered index scan the keyset LIMIT depends on.
      //
      // Columns are written out QUALIFIED because drizzle renders
      // `${table.column}` UNQUALIFIED inside a `sql` template — see
      // routers/projects.ts's `receiptRollups` for the transcript proving it.
      itemCount: sql<number>`(
        select count(*)::int from ${receiptItems}
        where "receipt_items"."receipt_id" = "receipts"."id"
      )`,
      // No `users.email`. The export must not be able to fall back to an
      // address for a user with no display name — see rows.ts's
      // `uploaderName`. Not selecting it makes that unrepresentable rather
      // than a rule the mapper has to remember.
      uploaderDisplayName: users.displayName,
      uploaderFirstName: users.firstName,
      uploaderLastName: users.lastName,
    })
    .from(receipts)
    // LEFT: `receipts.uploaded_by` is ON DELETE SET NULL, so an upload whose
    // uploader was removed is still a real receipt with real money on it.
    .leftJoin(users, eq(users.id, receipts.uploadedBy))
    .where(and(...conditions))
    .orderBy(sql`${receipts.transactionDate} DESC NULLS LAST`, desc(receipts.id))
    .limit(limit);

  return rows;
}

/**
 * Every line item belonging to the given receipts, in a single query, ordered
 * so the caller can walk it alongside the receipt page without sorting.
 *
 * LEFT join to categories: an uncategorised item is a real item with real
 * money on it, and `category_id` is nullable by design (`docs/SCHEMA.md`).
 * A soft-deleted category still resolves — the join has no liveness
 * predicate on purpose, because an export must be able to name the category
 * an item actually carries, not blank it out because the taxonomy moved on.
 */
export async function fetchItemsForReceipts(
  db: Database,
  user: AuthUser,
  receiptIds: string[],
): Promise<ExportItemRow[]> {
  if (receiptIds.length === 0) return [];

  return (
    db
      .select({
        receiptId: receiptItems.receiptId,
        lineNo: receiptItems.lineNo,
        description: receiptItems.description,
        categoryName: categories.name,
        quantity: receiptItems.quantity,
        unitPrice: receiptItems.unitPrice,
        lineTotal: receiptItems.lineTotal,
      })
      .from(receiptItems)
      // The scope is composed into THIS statement, not inherited from the page
      // query that produced `receiptIds`.
      //
      // Those ids are already scoped, so this is not closing a live hole — it is
      // the house rule (CLAUDE.md: "every project query composes with
      // scopedProjects"), and Phase 7's review flagged precisely this shape in
      // `members.list`: a row query whose enforcement sat in a preceding
      // statement, "not exploitable but exactly the shape `receipts.get` and
      // `projects.stats` refuse". A caller passing ids from somewhere else later
      // is the failure this forecloses, and the inner join is on the receipt
      // row this query needs to exist anyway.
      .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
      .leftJoin(categories, eq(categories.id, receiptItems.categoryId))
      .where(and(inArray(receiptItems.receiptId, receiptIds), receiptIsReadable(user)))
      .orderBy(asc(receiptItems.receiptId), asc(receiptItems.lineNo))
  );
}

/** Groups a flat item page by receipt id, preserving `line_no` order. */
export function groupItemsByReceipt(items: ExportItemRow[]): Map<string, ExportItemRow[]> {
  const byReceipt = new Map<string, ExportItemRow[]>();
  for (const item of items) {
    const existing = byReceipt.get(item.receiptId);
    if (existing) existing.push(item);
    else byReceipt.set(item.receiptId, [item]);
  }
  return byReceipt;
}
