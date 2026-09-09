import "server-only";

import type { Writable } from "node:stream";

import { formatMoney } from "@ledgerly/shared/money";

import { headerBlock } from "./format";
import { LINE_ITEM_COLUMNS, lineItemRow } from "./rows";
import type { CellValue } from "./rows";
import type { ExportSource } from "./source";

/**
 * packages/api/src/export/csv.ts — the CSV writer.
 *
 * Task 8.4: "CSV emits sheet 1 only". Taken literally — the same metadata
 * block, the same blank separator, the same headers, the same rows, from the
 * same row builder. A CSV that dropped the block would be a different sheet
 * that happened to share column names, and it would not be reproducible.
 *
 * Everything below exists to survive one specific hostile reader: Excel
 * opening a `.csv` by double-click, which is what a user of this app will
 * actually do.
 */

/**
 * Excel assumes the system's legacy code page for a `.csv` unless the file
 * opens with a UTF-8 BOM. Without it a merchant name like "Café Rio" arrives
 * as mojibake in exactly the export someone is filing with their taxes.
 */
export const UTF8_BOM = "﻿";

/** RFC 4180 quoting: double the quotes, wrap anything containing a quote, a
 *  comma, or a line break. */
function quote(value: string): string {
  if (!/["\r\n,]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The characters Excel, LibreOffice and Google Sheets treat as the start of a
 * formula when they open a CSV. `\t` and `\r` are here because a leading
 * control character can be stripped by the parser, promoting the NEXT
 * character to first position.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Neutralizes CSV formula injection.
 *
 * A spreadsheet opening a `.csv` evaluates any cell whose text begins with
 * `=`, `+`, `-` or `@`. Seven of sheet 1's columns are free text that this app
 * does not control: `merchant`, `item_description` and `receipt_notes` are the
 * dangerous ones, because **a merchant line is read off a photograph by the
 * model** (`pipeline/schema.ts` types it as an unconstrained string, and the
 * Luhn scrub only touches digits). A receipt printed with
 * `=cmd|'/c calc'!A0` on it would otherwise be extracted verbatim, stored, and
 * written into a file D-38 says a user will double-click open in Excel.
 *
 * Quoting is NOT a mitigation. D-38 exists because Excel re-parses the
 * contents of a quoted CSV field — that is why `"0042"` still loses its zero —
 * so `"=HYPERLINK(...)"` is still evaluated.
 *
 * The fix is the OWASP one: a leading apostrophe, which every spreadsheet
 * treats as "the rest of this cell is text". Some versions render the
 * apostrophe and some absorb it, so the cost is a possible cosmetic artifact
 * on the handful of cells that need it — against a formula executing on open.
 *
 * The `="..."` form used for `card_last4` below is deliberately NOT reused
 * here: an Excel string literal caps at 255 characters, and
 * `item_description` and `receipt_notes` are `text` columns that routinely
 * exceed it.
 */
function neutralize(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/**
 * `card_last4` is `char(4)` and "0042" is a legitimate value. Excel strips
 * the leading zero from a bare `0042` AND from a quoted `"0042"` on a
 * double-click open; the `="0042"` form is the only one that survives it,
 * which is what task 8.4's acceptance criterion asks for. It reaches a
 * non-Excel reader as the literal text `="0042"`, and that trade is recorded
 * as D-38 rather than left as a surprise.
 *
 * Applied only where a leading zero is actually possible — a four-digit
 * `char(4)` column — so the file is not littered with formula escapes. The
 * pattern is anchored and bounded, so no free-text field can reach it.
 */
function textCell(value: string): string {
  if (/^0\d{1,7}$/.test(value)) return `"=""${value}"""`;
  return quote(neutralize(value));
}

/**
 * A cell in CSV. Money is the plain decimal — no currency symbol, no
 * thousands separator — because a `$` or a `,` turns a number Excel could
 * sum into text it cannot. Dates are bare ISO, which Excel parses as a date
 * and, unlike `MM/DD/YY`, is unambiguous everywhere.
 */
function serialize(value: CellValue, type: (typeof LINE_ITEM_COLUMNS)[number]["type"]): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    // Back through `money.ts` so the written text is the exact 2dp decimal
    // the database held, never a float's shortest round-trip rendering.
    if (type === "money") return formatMoney(Math.round(value * 100));
    return String(value);
  }
  return type === "text" ? textCell(value) : quote(value);
}

function csvLine(cells: string[]): string {
  return `${cells.join(",")}\r\n`;
}

/**
 * `write` that respects backpressure, so a slow client cannot make the
 * process buffer the whole file — and that gives up if the reader has gone
 * away, rather than awaiting a `drain` that can never arrive.
 */
async function push(stream: Writable, chunk: string): Promise<void> {
  if (stream.destroyed) return;
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

/**
 * Writes the line-item sheet as CSV and resolves once the last row is
 * handed to the stream. Does not end the stream — the caller owns that, the
 * same way it does for the workbook writer.
 */
export async function writeCsv(stream: Writable, source: ExportSource): Promise<void> {
  const block = headerBlock({
    projectName: source.projectName,
    exportedAt: source.exportedAt,
    exportedBy: source.exportedBy,
    filterDescription: source.filterDescription,
    currencies: source.currencies,
  });

  let head = UTF8_BOM;
  for (const row of block) {
    // The block's own text is a set of literals, but it interpolates a
    // project name and a category name. Neither can currently START a cell,
    // so this is belt-and-braces — and it stays correct if the block's
    // wording is ever rearranged so that one of them can.
    head += csvLine(row.map((cell) => quote(neutralize(cell))));
  }
  head += csvLine(LINE_ITEM_COLUMNS.map((column) => column.header));
  await push(stream, head);

  let rows = 0;
  for await (const page of source.pages()) {
    if (stream.destroyed) return;
    let chunk = "";
    for (const { receipt, items } of page) {
      for (const item of items) {
        const values = lineItemRow(source.projectName, receipt, item);
        chunk += csvLine(
          LINE_ITEM_COLUMNS.map((column, index) => serialize(values[index] ?? null, column.type)),
        );
        rows += 1;
      }
    }
    if (chunk !== "") await push(stream, chunk);
  }

  // A terminal row, because a truncated CSV is a SYNTACTICALLY VALID CSV.
  //
  // The XLSX path is self-protecting: cut a zip anywhere and it will not open.
  // Cut a CSV anywhere and every complete line before the cut is still a
  // well-formed record, so a download that failed halfway looks exactly like a
  // smaller project — and the user's only signal is whatever the browser
  // decided to say about a failed transfer. Given that this file is a tax
  // record, a reader deserves to be able to tell. If this line is absent, the
  // file is incomplete.
  if (stream.destroyed) return;
  await push(stream, `${csvLine([])}${csvLine([`# end of export: ${rows} line items`])}`);
}
