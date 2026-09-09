import "server-only";

import type { Writable } from "node:stream";

import ExcelJS from "exceljs";

import { formatMoney } from "@ledgerly/shared/money";

import {
  DATE_FORMAT,
  QUANTITY_FORMAT,
  TEXT_FORMAT,
  headerBlock,
  headerRowIndex,
  moneyFormat,
} from "./format";
import { LINE_ITEM_COLUMNS, RECEIPT_COLUMNS, lineItemRow, receiptRow } from "./rows";
import type { CellType, CellValue, ExportColumn } from "./rows";
import { SummaryAccumulator } from "./summary";
import type { ExportSource } from "./source";

/** ExcelJS declares the streaming writer as a class inside a namespace; this
 *  alias is the only way to name its instance type in a signature. */
type WorkbookWriter = InstanceType<typeof ExcelJS.stream.xlsx.WorkbookWriter>;

/**
 * packages/api/src/export/workbook.ts — the XLSX writer.
 *
 * ## Why one pass
 *
 * The obvious implementation reads the receipts twice: once to write the
 * line-item sheet, once to write the receipt sheet. It is also wrong. The two
 * reads see two different snapshots of a live table, so the sheets can
 * disagree — and "the Receipts total equals the Line Items sum plus tax" is
 * the entire acceptance criterion for this phase.
 *
 * So there is exactly one pass. For each page of receipts:
 *
 *   - its line items are written to sheet 1 and committed, which frees them;
 *   - its eleven receipt-grain scalars are pushed onto an array;
 *   - the summary accumulates from the same rows.
 *
 * The unbounded dimension — line items, of which a project has tens of
 * thousands — never accumulates. The bounded one does, at roughly 200 bytes
 * a receipt, and `MAX_EXPORT_RECEIPTS` caps it. Both sheets and the summary
 * therefore derive from ONE read of each row and cannot disagree.
 *
 * ## Streaming
 *
 * `WorkbookWriter` writes into the caller's stream as it goes.
 * `useSharedStrings` is off deliberately: the shared-string table lives for
 * the life of the workbook, which is precisely the unbounded buffer this is
 * avoiding. `useStyles` is on because number formats and frozen panes are
 * not decoration here — a date stored as text is a date Excel cannot pivot.
 *
 * `row.commit()` on every row is what actually releases it. A row that is
 * added and never committed stays in memory, and the streaming property
 * becomes a comment rather than a behaviour.
 */

/** Sheet names. Load-bearing: the header block and the reconciliation note
 *  both refer to them by name, and a user reading the file is being told
 *  which grain they are looking at. */
export const SHEET_LINE_ITEMS = "Line Items";
export const SHEET_RECEIPTS = "Receipts";
export const SHEET_SUMMARY = "Summary";

function applyFormat(cell: ExcelJS.Cell, type: CellType, money: string): void {
  switch (type) {
    case "money":
      cell.numFmt = money;
      break;
    case "date":
      cell.numFmt = DATE_FORMAT;
      break;
    case "quantity":
      cell.numFmt = QUANTITY_FORMAT;
      break;
    case "text":
      // Forces Excel to leave a value alone rather than "helpfully" reading
      // it as a number. `card_last4` is the one that matters: "0042" is a
      // string in a `char(4)` column and must not become 42.
      cell.numFmt = TEXT_FORMAT;
      break;
    case "int":
    case "bool":
      break;
  }
}

function writeRow(
  sheet: ExcelJS.Worksheet,
  values: CellValue[],
  columns: readonly ExportColumn[],
  money: string,
): void {
  const row = sheet.addRow(values);
  columns.forEach((column, index) => {
    const value = values[index];
    // A blank cell carries no format. Formatting a null would render an
    // empty cell as "$0.00" in some Excel versions, which is the difference
    // between "no total was extracted" and "this receipt cost nothing".
    if (value === null || value === undefined) return;
    applyFormat(row.getCell(index + 1), column.type, money);
  });
  row.commit();
}

function headerRow(sheet: ExcelJS.Worksheet, columns: readonly ExportColumn[]): void {
  const row = sheet.addRow(columns.map((c) => c.header));
  row.font = { bold: true };
  row.commit();
}

/**
 * Applies backpressure between pages.
 *
 * Without this the DB feeds the zip encoder as fast as Postgres can serve,
 * and a slow client turns the `PassThrough`'s buffer into the very
 * "whole workbook in memory" this design exists to avoid. One `drain` wait
 * per page is enough; the pages are large enough that the check is free.
 *
 * It resolves on `close` and `error` as well as `drain`. A client that
 * disconnects mid-download destroys the stream, and a `drain` that is only
 * ever going to arrive from a reader that has gone away is a promise that
 * never settles — leaking this writer, its pending queries, and the pool
 * connection they run on, for the life of the process.
 */
async function awaitDrain(stream: Writable): Promise<void> {
  if (!stream.writableNeedDrain || stream.destroyed) return;
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

export type WriteWorkbookInput = {
  stream: Writable;
  source: ExportSource;
};

/**
 * Writes the three-sheet workbook into `stream` and resolves once the last
 * byte has been handed to it. The caller is responsible for the stream's own
 * lifecycle — see `index.ts`, which destroys it with the error if this
 * rejects so a truncated download fails loudly rather than arriving as a
 * corrupt file.
 */
export async function writeWorkbook({ stream, source }: WriteWorkbookInput): Promise<void> {
  const money = moneyFormat(source.currencies);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: false,
  });
  // Fixed, not `new Date()`: the export's timestamp belongs in the header
  // block where a human can read it, and pinning these keeps two exports of
  // the same filter as close to identical as a zip container allows.
  workbook.created = source.exportedAt;
  workbook.modified = source.exportedAt;
  workbook.creator = "Ledgerly";

  const block = headerBlock({
    projectName: source.projectName,
    exportedAt: source.exportedAt,
    exportedBy: source.exportedBy,
    filterDescription: source.filterDescription,
    currencies: source.currencies,
  });

  const lineItems = workbook.addWorksheet(SHEET_LINE_ITEMS, {
    // `views` is a getter-only property on a streaming worksheet — it can
    // only be set here, at construction.
    views: [{ state: "frozen", ySplit: headerRowIndex(block) }],
  });
  // Width only, never `header`: giving a column a `header` makes ExcelJS
  // emit its own header row before anything else, which would push the
  // metadata block below the headers it is supposed to introduce.
  lineItems.columns = LINE_ITEM_COLUMNS.map((c) => ({ width: c.width }));

  for (const row of block) {
    lineItems.addRow(row).commit();
  }
  headerRow(lineItems, LINE_ITEM_COLUMNS);

  const summary = new SummaryAccumulator();
  const receiptRows: CellValue[][] = [];

  for await (const page of source.pages()) {
    // The consumer disconnected. Stop reading rather than paging through the
    // rest of the project into a stream nobody is holding the other end of.
    //
    // Returning here abandons the WorkbookWriter mid-zip without calling
    // `workbook.commit()`. That is safe in THIS configuration — no `filename`
    // option, so the zip lives only in memory and is collectable — but it
    // would orphan a temp file per cancelled download if anyone ever switches
    // this to the file-backed mode.
    if (stream.destroyed) return;
    for (const { receipt, items } of page) {
      for (const item of items) {
        writeRow(
          lineItems,
          lineItemRow(source.projectName, receipt, item),
          LINE_ITEM_COLUMNS,
          money,
        );
      }
      receiptRows.push(receiptRow(receipt));
      summary.add(receipt, items);
    }
    await awaitDrain(stream);
  }

  await lineItems.commit();

  const receiptSheet = workbook.addWorksheet(SHEET_RECEIPTS, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  receiptSheet.columns = RECEIPT_COLUMNS.map((c) => ({ width: c.width }));
  headerRow(receiptSheet, RECEIPT_COLUMNS);
  for (const values of receiptRows) {
    if (stream.destroyed) return;
    writeRow(receiptSheet, values, RECEIPT_COLUMNS, money);
    await awaitDrain(stream);
  }
  await receiptSheet.commit();

  await writeSummary(workbook, summary, money);

  await workbook.commit();
}

/** Column layout for the summary's three blocks. */
const SUMMARY_COLUMNS = [{ width: 34 }, { width: 14 }, { width: 16 }];

async function writeSummary(
  workbook: WorkbookWriter,
  accumulator: SummaryAccumulator,
  money: string,
): Promise<void> {
  const { byCategory, byMonth, totals, reconciliationDeltaCents } = accumulator.result();

  const sheet = workbook.addWorksheet(SHEET_SUMMARY, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = SUMMARY_COLUMNS;

  const title = (text: string): void => {
    const row = sheet.addRow([text]);
    row.font = { bold: true };
    row.commit();
  };
  const blank = (): void => {
    sheet.addRow([]).commit();
  };
  const moneyRow = (label: string, middle: number | string | null, cents: number): void => {
    const row = sheet.addRow([label, middle, Number(formatMoney(cents))]);
    row.getCell(3).numFmt = money;
    row.commit();
  };

  title("Spend by category");
  const categoryHeader = sheet.addRow(["category", "item_count", "spend"]);
  categoryHeader.font = { bold: true };
  categoryHeader.commit();
  for (const bucket of byCategory) {
    moneyRow(bucket.name, bucket.itemCount, bucket.spendCents);
  }
  moneyRow("TOTAL (line items)", totals.itemCount, totals.lineTotalCents);

  blank();
  title("Spend by month");
  const monthHeader = sheet.addRow(["month", "receipt_count", "total"]);
  monthHeader.font = { bold: true };
  monthHeader.commit();
  for (const bucket of byMonth) {
    moneyRow(bucket.month, bucket.receiptCount, bucket.totalCents);
  }
  moneyRow("TOTAL (receipts)", totals.receiptCount, totals.totalCents);

  blank();
  title("Reconciliation");
  // Spelled out rather than left implicit: this block is the export's own
  // claim to be arithmetically sound, and a reader who does not know that
  // tax and tip are unallocated will read the gap as an error.
  sheet
    .addRow(["Line-item spend plus tax and tip should equal the receipt totals. Tax and tip are"])
    .commit();
  sheet
    .addRow(["deliberately NOT apportioned across categories — an unallocated remainder is a"])
    .commit();
  sheet.addRow(["fact; a per-category share of it would be an invention."]).commit();
  blank();
  moneyRow("Sum of line_total (sheet 1)", null, totals.lineTotalCents);
  moneyRow("Sum of sales_tax", null, totals.salesTaxCents);
  moneyRow("Sum of tip", null, totals.tipCents);
  moneyRow("Sum of total (sheet 2)", null, totals.totalCents);
  moneyRow("Difference", null, reconciliationDeltaCents);
  blank();
  sheet.addRow(["Receipts exported", totals.receiptCount]).commit();
  sheet.addRow(["Line items exported", totals.itemCount]).commit();
  sheet.addRow(["Receipts with no line items", totals.receiptsWithNoItems]).commit();
  sheet.addRow(["Receipts with no total", totals.receiptsMissingTotal]).commit();

  await sheet.commit();
}
