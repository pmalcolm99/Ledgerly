import "server-only";

import { parseMoney } from "@ledgerly/shared/money";
import { displayNameOf } from "@ledgerly/shared/personName";

import type { ExportItemRow, ExportReceiptRow } from "./query";

/**
 * packages/api/src/export/rows.ts — the column definitions and the one place
 * a database value becomes a cell value.
 *
 * The two sheets are two GRAINS, and keeping them apart is the whole point of
 * this phase. `docs/Ledgerly_Project_Plan.md` §1.7:
 *
 *   > Receipt-level totals live only on sheet 2. Repeating `total` on every
 *   > line item row is how spreadsheet exports quietly triple people's
 *   > deductions when someone drags a SUM down the column.
 *
 * `LINE_ITEM_COLUMNS` therefore contains no `subtotal`, `sales_tax`, `tip` or
 * `total`, and both `workbook.test.ts` and `csv.test.ts` assert their absence
 * BY HEADER NAME, against `RECEIPT_GRAIN_HEADERS` below. That assertion is not
 * decoration: a well-meaning future change that adds a "handy" total column to
 * sheet 1 would reintroduce exactly the bug, and it would look like an
 * improvement in review.
 *
 * Both sheets and the CSV are built from these definitions, so a header can
 * never drift from the value written beneath it.
 */

/** How a value should be typed in a spreadsheet cell. XLSX turns these into
 *  real numbers/dates with number formats; CSV turns them into text that
 *  Excel re-parses to the same thing. */
export type CellType = "text" | "money" | "date" | "quantity" | "int" | "bool";

export type ExportColumn = {
  /** The header string. Matches the brief §1.7 exactly — task 8.2's
   *  acceptance criterion is a literal match, so these are not adjustable
   *  for taste. */
  header: string;
  type: CellType;
  width: number;
};

export const LINE_ITEM_COLUMNS: readonly ExportColumn[] = [
  { header: "project_name", type: "text", width: 24 },
  { header: "receipt_id", type: "text", width: 38 },
  { header: "transaction_date", type: "date", width: 14 },
  { header: "merchant", type: "text", width: 28 },
  { header: "category", type: "text", width: 22 },
  { header: "item_description", type: "text", width: 40 },
  { header: "quantity", type: "quantity", width: 10 },
  { header: "unit_price", type: "money", width: 12 },
  { header: "line_total", type: "money", width: 12 },
  { header: "card_last4", type: "text", width: 11 },
  { header: "uploaded_by", type: "text", width: 22 },
  { header: "receipt_notes", type: "text", width: 34 },
  { header: "image_filename", type: "text", width: 46 },
] as const;

export const RECEIPT_COLUMNS: readonly ExportColumn[] = [
  { header: "receipt_id", type: "text", width: 38 },
  { header: "transaction_date", type: "date", width: 14 },
  { header: "merchant", type: "text", width: 28 },
  { header: "subtotal", type: "money", width: 12 },
  { header: "sales_tax", type: "money", width: 12 },
  { header: "total", type: "money", width: 12 },
  { header: "card_last4", type: "text", width: 11 },
  { header: "item_count", type: "int", width: 11 },
  { header: "payment_method", type: "text", width: 18 },
  { header: "uploaded_by", type: "text", width: 22 },
  { header: "needs_review", type: "bool", width: 13 },
] as const;

/** The headers that must never appear on the line-item sheet. Named here so
 *  the rule is a value the test imports, not a list retyped in a test file
 *  where it can quietly fall out of step. */
export const RECEIPT_GRAIN_HEADERS = ["subtotal", "sales_tax", "tip", "total"] as const;

/** A cell value in its native JS type. `null` renders blank everywhere —
 *  never `0`, never `"—"`: a missing total and a zero total are different
 *  facts and a spreadsheet is exactly where that difference gets summed. */
export type CellValue = string | number | Date | boolean | null;

/**
 * `numeric(12,2)` string to a spreadsheet number.
 *
 * Routed through `parseMoney` (D-21) rather than `Number()`: it is the only
 * place in the codebase that decides what a money string means, it rejects a
 * third decimal place instead of silently rounding, and it throws on garbage
 * rather than producing `NaN` — a `NaN` here would reach a cell and become a
 * silently wrong tax figure.
 *
 * The `/ 100` at the end is the single float in the whole path, and it is the
 * same double Excel itself would store had a human typed the number in.
 */
export function moneyNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  return parseMoney(value) / 100;
}

/** `numeric(12,3)`. Deliberately NOT through `money.ts` — `parseMoney`'s
 *  pattern rejects a third fractional digit, and quantity legitimately has
 *  one (receipts sell things by weight). */
export function quantityNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A `date` column to a real spreadsheet date.
 *
 * Built with `Date.UTC`, never `new Date("2026-03-04")`. The string form is
 * parsed as UTC midnight, and ExcelJS serialises via UTC-based arithmetic, so
 * a locally-constructed date in a negative-offset zone lands on the previous
 * day in the file. Verified by round-tripping a written workbook back through
 * `xlsx.load` in `workbook.test.ts`.
 */
export function dateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

/**
 * The `image_filename` column.
 *
 * There is no filename column in the schema — `receipts.image_key` holds only
 * the render's extension, and every display render is literally named
 * `display.webp`. A bare basename would therefore be the same string on every
 * row and identify nothing. What is actually useful in an export is the path
 * RELATIVE TO `UPLOADS_DIR`, which is what locates the image inside a backup
 * archive (ARCHITECTURE.md §5, §8.3). Blank when no render exists yet.
 */
export function imageFilename(receipt: ExportReceiptRow): string | null {
  if (!receipt.imageKey) return null;
  return `${receipt.projectId}/${receipt.id}/display.${receipt.imageKey}`;
}

/**
 * The uploader's name, or "Unknown user" — never their email address.
 *
 * `displayNameOf`'s fallback chain ends at `email`, and `display_name` is
 * nullable for everyone while `first_name`/`last_name` are nullable until
 * onboarding, so passing the email through would put a colleague's address in
 * thousands of cells. `resolveFilterLabels` in index.ts already refuses to do
 * that for the single header line, on the grounds that this file gets emailed
 * to an accountant; the same reasoning applies with far more force to a column
 * that repeats on every row. One policy, both places.
 */
export function uploaderName(receipt: ExportReceiptRow): string {
  return displayNameOf({
    displayName: receipt.uploaderDisplayName,
    firstName: receipt.uploaderFirstName,
    lastName: receipt.uploaderLastName,
    email: null,
  });
}

/** One sheet-1 row. Ordered to match `LINE_ITEM_COLUMNS` exactly. */
export function lineItemRow(
  projectName: string,
  receipt: ExportReceiptRow,
  item: ExportItemRow,
): CellValue[] {
  return [
    projectName,
    receipt.id,
    dateValue(receipt.transactionDate),
    receipt.merchantName,
    item.categoryName,
    item.description,
    quantityNumber(item.quantity),
    moneyNumber(item.unitPrice),
    moneyNumber(item.lineTotal),
    receipt.cardLast4,
    uploaderName(receipt),
    receipt.userNotes,
    imageFilename(receipt),
  ];
}

/** One sheet-2 row. Ordered to match `RECEIPT_COLUMNS` exactly. */
export function receiptRow(receipt: ExportReceiptRow): CellValue[] {
  return [
    receipt.id,
    dateValue(receipt.transactionDate),
    receipt.merchantName,
    moneyNumber(receipt.subtotal),
    moneyNumber(receipt.salesTax),
    moneyNumber(receipt.total),
    receipt.cardLast4,
    receipt.itemCount,
    receipt.paymentMethod,
    uploaderName(receipt),
    receipt.needsReview,
  ];
}
