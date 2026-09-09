import "server-only";

import { NUMERIC_12_2_MAX_CENTS, parseMoney } from "@ledgerly/shared/money";

import type { ExportItemRow, ExportReceiptRow } from "./query";

/**
 * packages/api/src/export/summary.ts — the "Summary" sheet's accumulator.
 *
 * Everything here is integer cents (D-21). Not one figure on this sheet is
 * computed by adding floats, because the reconciliation block below is the
 * artifact's own claim that the export is arithmetically sound, and a
 * reconciliation computed in floating point can be off by a cent and say so.
 *
 * It accumulates during the SAME single pass that writes sheets 1 and 2, so
 * the summary cannot disagree with the sheets it summarises — a separate
 * aggregate query would be a second read of a moving table.
 *
 * Two things this sheet deliberately does NOT do:
 *
 *  - It does not apportion tax or tip pro-rata across categories.
 *    `routers/projects.ts` already states the reason for the dashboard and it
 *    applies with more force to a tax record: an unallocated remainder is a
 *    fact, an invented per-category share is a fabrication.
 *  - It does not hide the gap between the two grains. `sum(line_total)` and
 *    `sum(total)` differ by tax, tip, and every receipt whose items were
 *    never extracted. The reconciliation block prints both and the delta.
 */

/** The `Unassigned` bucket is NOT the seeded `Uncategorized` system category
 *  — an item with a null `category_id` and an item explicitly filed under
 *  "Uncategorized" are different states, and both can appear on one sheet.
 *  Matches the dashboard's `byCategory` treatment. */
export const UNASSIGNED_CATEGORY = "(Unassigned)";
export const UNDATED_MONTH = "(No date)";

type CategoryBucket = { itemCount: number; spendCents: number };
type MonthBucket = { receiptCount: number; totalCents: number };

export type SummaryTotals = {
  receiptCount: number;
  itemCount: number;
  /** Receipts that produced no sheet-1 rows at all. The single most useful
   *  number for explaining why the two grains do not add up. */
  receiptsWithNoItems: number;
  /** `sum` skips NULLs, so without this the total silently understates
   *  whenever a receipt's total could not be read and nothing says so. */
  receiptsMissingTotal: number;
  lineTotalCents: number;
  salesTaxCents: number;
  tipCents: number;
  totalCents: number;
};

export type SummaryResult = {
  byCategory: { name: string; itemCount: number; spendCents: number }[];
  byMonth: { month: string; receiptCount: number; totalCents: number }[];
  totals: SummaryTotals;
  /** `line_total + sales_tax + tip - total`. Zero on a clean export; the
   *  export is not "wrong" when it is nonzero, but the user is entitled to
   *  see it rather than discover it by summing a column themselves. */
  reconciliationDeltaCents: number;
};

/**
 * Sums stay in `Number`, which is exact for integers below 2^53 — but that is
 * not the bound that binds. Every total on the summary sheet is rendered
 * through `formatMoney`, and `money.ts` refuses anything above
 * `NUMERIC_12_2_MAX_CENTS` ($9,999,999,999.99). Guarding on
 * `Number.isSafeInteger` would therefore have been a check that could never
 * fire: `formatMoney` throws roughly 90x earlier. Guarding on the real
 * ceiling makes the message true and the failure attributable.
 *
 * It still throws rather than saturating. Wrong-and-quiet is the one outcome
 * a tax export must never have — a truncated download is recoverable, a
 * spreadsheet that silently lost a digit is not.
 */
function addCents(running: number, delta: number): number {
  const sum = running + delta;
  if (!Number.isSafeInteger(sum) || Math.abs(sum) > NUMERIC_12_2_MAX_CENTS) {
    throw new Error("export: aggregate exceeds the numeric(12,2) range money.ts can format");
  }
  return sum;
}

function cents(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return parseMoney(value);
}

export class SummaryAccumulator {
  private readonly categories = new Map<string, CategoryBucket>();
  private readonly months = new Map<string, MonthBucket>();
  private readonly totals: SummaryTotals = {
    receiptCount: 0,
    itemCount: 0,
    receiptsWithNoItems: 0,
    receiptsMissingTotal: 0,
    lineTotalCents: 0,
    salesTaxCents: 0,
    tipCents: 0,
    totalCents: 0,
  };

  /** Called once per receipt, with that receipt's own items. */
  add(receipt: ExportReceiptRow, items: ExportItemRow[]): void {
    this.totals.receiptCount += 1;
    if (items.length === 0) this.totals.receiptsWithNoItems += 1;
    if (receipt.total === null) this.totals.receiptsMissingTotal += 1;

    this.totals.salesTaxCents = addCents(this.totals.salesTaxCents, cents(receipt.salesTax));
    this.totals.tipCents = addCents(this.totals.tipCents, cents(receipt.tip));
    this.totals.totalCents = addCents(this.totals.totalCents, cents(receipt.total));

    const month = receipt.transactionDate ? receipt.transactionDate.slice(0, 7) : UNDATED_MONTH;
    const monthBucket = this.months.get(month) ?? { receiptCount: 0, totalCents: 0 };
    monthBucket.receiptCount += 1;
    monthBucket.totalCents = addCents(monthBucket.totalCents, cents(receipt.total));
    this.months.set(month, monthBucket);

    for (const item of items) {
      this.totals.itemCount += 1;
      const lineCents = cents(item.lineTotal);
      this.totals.lineTotalCents = addCents(this.totals.lineTotalCents, lineCents);

      const name = item.categoryName ?? UNASSIGNED_CATEGORY;
      const bucket = this.categories.get(name) ?? { itemCount: 0, spendCents: 0 };
      bucket.itemCount += 1;
      bucket.spendCents = addCents(bucket.spendCents, lineCents);
      this.categories.set(name, bucket);
    }
  }

  /**
   * Both orderings break ties on the name/month so two exports of the same
   * data produce the same sheet — task 8.5's reproducibility criterion would
   * otherwise fail on nothing but `Map` insertion order.
   */
  result(): SummaryResult {
    const byCategory = [...this.categories.entries()]
      .map(([name, bucket]) => ({ name, ...bucket }))
      .sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));

    const byMonth = [...this.months.entries()]
      .map(([month, bucket]) => ({ month, ...bucket }))
      // Ascending by month, with the undated bucket pinned last rather than
      // sorted into the middle of the calendar by its parenthesis.
      .sort((a, b) => {
        if (a.month === UNDATED_MONTH) return 1;
        if (b.month === UNDATED_MONTH) return -1;
        return a.month.localeCompare(b.month);
      });

    return {
      byCategory,
      byMonth,
      totals: { ...this.totals },
      reconciliationDeltaCents:
        this.totals.lineTotalCents +
        this.totals.salesTaxCents +
        this.totals.tipCents -
        this.totals.totalCents,
    };
  }
}
