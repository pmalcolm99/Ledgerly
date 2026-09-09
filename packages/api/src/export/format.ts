import "server-only";

/**
 * packages/api/src/export/format.ts — number formats and the header block.
 *
 * Split out of `workbook.ts` so the CSV writer can share the header block
 * verbatim. Task 8.4 says the CSV "emits the line-item sheet only"; sharing
 * the block is how that stays literally true instead of approximately true.
 */

export const DATE_FORMAT = "yyyy-mm-dd";
export const QUANTITY_FORMAT = "#,##0.###";
export const TEXT_FORMAT = "@";

/** Currency symbols for the currencies a self-hosted instance plausibly
 *  meets. Anything else falls through to the ISO code, which is still a
 *  correct, sortable, summable money format — just a less pretty one. */
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  CAD: "$",
  AUD: "$",
  NZD: "$",
  GBP: "£",
  EUR: "€",
  JPY: "¥",
};

/**
 * The `numFmt` money cells carry.
 *
 * A mixed-currency set gets a bare numeric format with no symbol at all
 * (D-17): totals are summed without regard to currency, which is correct
 * only while there is one, and stamping "$" onto a column that also contains
 * euros would dress a meaningless number up as a meaningful one. The header
 * block says so in words on the same sheet.
 */
export function moneyFormat(currencies: string[]): string {
  if (currencies.length !== 1) return "#,##0.00";
  const code = currencies[0] ?? "";
  const symbol = CURRENCY_SYMBOL[code];
  return symbol ? `"${symbol}"#,##0.00` : `"${code} "#,##0.00`;
}

export type HeaderBlockInput = {
  projectName: string;
  exportedAt: Date;
  exportedBy: string;
  filterDescription: string;
  currencies: string[];
};

/**
 * The three metadata rows above sheet 1's headers, plus the blank separator.
 * Returned as rows of strings so both writers emit the identical block.
 *
 * This is task 8.5's whole mechanism: an export six months old still says
 * which filter produced it and when, so it can be reproduced rather than
 * guessed at. Everything in it except the timestamp is deterministic, which
 * is what makes "two exports of the same filter differ only in the
 * timestamp" an assertion a test can make.
 */
export function headerBlock(input: HeaderBlockInput): string[][] {
  const mixed =
    input.currencies.length > 1
      ? `  ·  MIXED CURRENCIES (${input.currencies.join(", ")}) — totals are not meaningful`
      : "";

  return [
    [`Ledgerly export — ${input.projectName}`],
    [`Exported ${input.exportedAt.toISOString()} by ${input.exportedBy}${mixed}`],
    [`Filters: ${input.filterDescription}`],
    [],
  ];
}

/** The 1-based row the sheet-1 column headers land on, and therefore the
 *  freeze split. Derived from the block that was actually written rather
 *  than hardcoded, so adding a metadata row cannot silently unfreeze the
 *  header row or leave the freeze one line off. */
export function headerRowIndex(block: string[][]): number {
  return block.length + 1;
}
