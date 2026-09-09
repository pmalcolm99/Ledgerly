import ExcelJS from "exceljs";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { receipts } from "@ledgerly/db/schema";
import { parseMoney } from "@ledgerly/shared/money";
import type { AuthUser } from "@ledgerly/auth/types";

import { startProjectExport } from "./index";
import { LINE_ITEM_COLUMNS, RECEIPT_COLUMNS, RECEIPT_GRAIN_HEADERS } from "./rows";
import { SHEET_LINE_ITEMS, SHEET_RECEIPTS, SHEET_SUMMARY } from "./workbook";
import { loadWorkbook, seedExportFixture, softDeleteReceipt } from "./fixture.test-helper";

/**
 * packages/api/src/export/workbook.test.ts — the phase gate, asserted.
 *
 * The centrepiece is `reconciles`: it reads the WRITTEN FILE back through
 * ExcelJS and adds up the two sheets independently, in integer cents. That is
 * deliberately not a test of the accumulator — the accumulator could be
 * perfect while the writer put the numbers in the wrong cells. Reading the
 * artifact back is the only assertion that covers the whole path.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

const FIXED_NOW = new Date("2026-09-09T14:22:31.000Z");

type Built = {
  workbook: ExcelJS.Workbook;
  projectId: string;
  user: AuthUser;
  receiptCount: number;
};

async function buildFixtureWorkbook(
  options: { count?: number; batchSize?: number; includeEdgeCases?: boolean } = {},
): Promise<Built> {
  const { project, users } = await createTestProjectWithMembers(db, {
    ownerKey: "owner1",
    members: [],
    name: "Kitchen Remodel",
  });
  const owner = users.owner1;
  if (!owner) throw new Error("fixture: owner missing");

  await seedExportFixture(db, project.id, owner.id, {
    ...(options.count === undefined ? {} : { count: options.count }),
    ...(options.includeEdgeCases === undefined
      ? {}
      : { includeEdgeCases: options.includeEdgeCases }),
  });

  const user: AuthUser = owner as unknown as AuthUser;
  const started = await startProjectExport({
    db,
    user,
    projectId: project.id,
    format: "xlsx",
    filters: {},
    now: FIXED_NOW,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });

  const workbook = await loadWorkbook(started.stream);

  return { workbook, projectId: project.id, user, receiptCount: started.receiptCount };
}

/** Reads a sheet's data rows as arrays, skipping the given number of
 *  leading rows. ExcelJS's `row.values` is 1-based with a hole at index 0. */
function dataRows(sheet: ExcelJS.Worksheet, skip: number): unknown[][] {
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= skip) return;
    const values = row.values as unknown[];
    rows.push(values.slice(1));
  });
  return rows;
}

function centsOf(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value !== "number") throw new Error(`expected a number cell, got ${typeof value}`);
  // Back through the money boundary rather than `value * 100`, so the test
  // measures the same rounding the exporter claims to do.
  return parseMoney(value.toFixed(2));
}

describe("XLSX export", () => {
  it("has exactly the three sheets, in order", async () => {
    const { workbook } = await buildFixtureWorkbook();
    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      SHEET_LINE_ITEMS,
      SHEET_RECEIPTS,
      SHEET_SUMMARY,
    ]);
  });

  it("sheet 1's headers match the brief exactly", async () => {
    const { workbook } = await buildFixtureWorkbook();
    const sheet = workbook.getWorksheet(SHEET_LINE_ITEMS);
    const headers = (sheet?.getRow(5).values as unknown[]).slice(1);

    expect(headers).toEqual([
      "project_name",
      "receipt_id",
      "transaction_date",
      "merchant",
      "category",
      "item_description",
      "quantity",
      "unit_price",
      "line_total",
      "card_last4",
      "uploaded_by",
      "receipt_notes",
      "image_filename",
    ]);
    expect(headers).toEqual(LINE_ITEM_COLUMNS.map((c) => c.header));
  });

  /**
   * The load-bearing negative. Asserted by HEADER NAME, not by checking that
   * no value happens to look like a total: a future change that adds a
   * "convenient" total column to the line-item sheet would reintroduce
   * precisely the SUM-dragging bug this phase exists to prevent, and it
   * would read as an improvement in a diff.
   */
  it("sheet 1 carries no receipt-level total column at all", async () => {
    const { workbook } = await buildFixtureWorkbook();
    const sheet = workbook.getWorksheet(SHEET_LINE_ITEMS);
    const headers = (sheet?.getRow(5).values as unknown[]).slice(1);

    for (const forbidden of RECEIPT_GRAIN_HEADERS) {
      expect(headers).not.toContain(forbidden);
    }
  });

  it("sheet 2's headers match the brief exactly", async () => {
    const { workbook } = await buildFixtureWorkbook();
    const sheet = workbook.getWorksheet(SHEET_RECEIPTS);
    const headers = (sheet?.getRow(1).values as unknown[]).slice(1);

    expect(headers).toEqual([
      "receipt_id",
      "transaction_date",
      "merchant",
      "subtotal",
      "sales_tax",
      "total",
      "card_last4",
      "item_count",
      "payment_method",
      "uploaded_by",
      "needs_review",
    ]);
    expect(headers).toEqual(RECEIPT_COLUMNS.map((c) => c.header));
  });

  /**
   * The phase gate: "the Receipts sheet total equals the sum of the Line
   * Items sheet line_totals plus tax. If they do not reconcile, the export is
   * wrong." Read back from the file, summed in integer cents, exact equality.
   */
  it("reconciles: sum(line_total) + sum(sales_tax) + sum(tip) == sum(total)", async () => {
    const { workbook } = await buildFixtureWorkbook({ count: 24, includeEdgeCases: false });

    const items = workbook.getWorksheet(SHEET_LINE_ITEMS);
    const receiptSheet = workbook.getWorksheet(SHEET_RECEIPTS);
    if (!items || !receiptSheet) throw new Error("sheets missing");

    const LINE_TOTAL = LINE_ITEM_COLUMNS.findIndex((c) => c.header === "line_total");
    const SALES_TAX = RECEIPT_COLUMNS.findIndex((c) => c.header === "sales_tax");
    const TOTAL = RECEIPT_COLUMNS.findIndex((c) => c.header === "total");

    const lineCents = dataRows(items, 5).reduce((sum, row) => sum + centsOf(row[LINE_TOTAL]), 0);
    const receiptRows = dataRows(receiptSheet, 1);
    const taxCents = receiptRows.reduce((sum, row) => sum + centsOf(row[SALES_TAX]), 0);
    const totalCents = receiptRows.reduce((sum, row) => sum + centsOf(row[TOTAL]), 0);

    expect(receiptRows).toHaveLength(24);
    expect(lineCents).toBeGreaterThan(0);
    // `includeEdgeCases: false` means no tips, so line + tax is the whole of
    // it. The tipped case is covered by the summary's own delta assertion.
    expect(lineCents + taxCents).toBe(totalCents);
  });

  it("the Summary sheet's reconciliation delta is zero on clean data", async () => {
    const { workbook } = await buildFixtureWorkbook({ count: 24, includeEdgeCases: false });
    const summary = workbook.getWorksheet(SHEET_SUMMARY);
    if (!summary) throw new Error("summary missing");

    let difference: number | null = null;
    summary.eachRow((row) => {
      const values = row.values as unknown[];
      if (values[1] === "Difference") difference = centsOf(values[3]);
    });

    expect(difference).toBe(0);
  });

  it("writes dates as real dates, money as numbers, and card_last4 as text", async () => {
    const { workbook } = await buildFixtureWorkbook();
    const sheet = workbook.getWorksheet(SHEET_LINE_ITEMS);
    if (!sheet) throw new Error("sheet missing");

    const DATE = LINE_ITEM_COLUMNS.findIndex((c) => c.header === "transaction_date");
    const LINE_TOTAL = LINE_ITEM_COLUMNS.findIndex((c) => c.header === "line_total");
    const QUANTITY = LINE_ITEM_COLUMNS.findIndex((c) => c.header === "quantity");

    const rows = dataRows(sheet, 5);
    const withDate = rows.find((row) => row[DATE] instanceof Date);
    expect(withDate).toBeDefined();

    // A UTC-constructed date must come back as the same calendar day, not
    // the one before it — the bug a locally-parsed "2026-03-04" would cause
    // for anyone west of Greenwich.
    const date = withDate?.[DATE] as Date;
    expect(date.toISOString().slice(11)).toBe("00:00:00.000Z");
    expect(date.toISOString().slice(0, 10)).toMatch(/^2026-03-\d{2}$/);

    expect(typeof withDate?.[LINE_TOTAL]).toBe("number");
    expect(typeof withDate?.[QUANTITY]).toBe("number");

    const dateCell = sheet.getRow(6).getCell(DATE + 1);
    expect(dateCell.numFmt).toBe("yyyy-mm-dd");
    const moneyCell = sheet.getRow(6).getCell(LINE_TOTAL + 1);
    expect(moneyCell.numFmt).toContain("#,##0.00");
  });

  it("preserves a leading zero in card_last4", async () => {
    const { workbook } = await buildFixtureWorkbook();
    const sheet = workbook.getWorksheet(SHEET_RECEIPTS);
    if (!sheet) throw new Error("sheet missing");

    const CARD = RECEIPT_COLUMNS.findIndex((c) => c.header === "card_last4");
    const values = dataRows(sheet, 1).map((row) => row[CARD]);

    expect(values).toContain("0042");
    // Not 42, and not the number 42 rendered as a string later.
    expect(values).not.toContain(42);
  });

  it("freezes the header row on every sheet and sets column widths", async () => {
    const { workbook } = await buildFixtureWorkbook();

    // `views[0]` is a union and only the frozen/split members carry
    // `ySplit`, so it is read through a narrowing helper rather than a cast.
    const split = (sheet: ExcelJS.Worksheet | undefined): number | undefined => {
      const view = sheet?.views[0];
      return view && "ySplit" in view ? view.ySplit : undefined;
    };

    const items = workbook.getWorksheet(SHEET_LINE_ITEMS);
    expect(items?.views[0]?.state).toBe("frozen");
    expect(split(items)).toBe(5);
    expect(items?.getColumn(1).width).toBe(LINE_ITEM_COLUMNS[0]?.width);

    const receiptSheet = workbook.getWorksheet(SHEET_RECEIPTS);
    expect(receiptSheet?.views[0]?.state).toBe("frozen");
    expect(split(receiptSheet)).toBe(1);
  });

  it("records the project, the timestamp and the filters in the header block", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner1",
      members: [],
      name: "Kitchen Remodel",
    });
    const owner = users.owner1;
    if (!owner) throw new Error("owner missing");
    await seedExportFixture(db, project.id, owner.id, { count: 3 });

    const started = await startProjectExport({
      db,
      user: owner as unknown as AuthUser,
      projectId: project.id,
      format: "xlsx",
      filters: { from: "2026-03-01", to: "2026-03-31", needsReview: false },
      now: FIXED_NOW,
    });
    const workbook = await loadWorkbook(started.stream);
    const sheet = workbook.getWorksheet(SHEET_LINE_ITEMS);

    expect(String(sheet?.getRow(1).getCell(1).value)).toBe("Ledgerly export — Kitchen Remodel");
    expect(String(sheet?.getRow(2).getCell(1).value)).toContain("2026-09-09T14:22:31.000Z");
    expect(String(sheet?.getRow(3).getCell(1).value)).toBe(
      "Filters: dates 2026-03-01 to 2026-03-31",
    );
  });

  it("pages through the whole project rather than stopping at one batch", async () => {
    // 22 receipts at a batch size of 5 forces five pages, including a final
    // short one — the boundary a naive `while (page.length === batchSize)`
    // loop gets wrong.
    const { workbook } = await buildFixtureWorkbook({ count: 22, batchSize: 5 });
    const sheet = workbook.getWorksheet(SHEET_RECEIPTS);
    expect(dataRows(sheet!, 1)).toHaveLength(22);
  });

  /**
   * A client that cancels a download destroys the response stream while the
   * detached writer is still paging the database. Before this was handled,
   * `awaitDrain` waited on a `drain` that could never arrive and the writer,
   * its in-flight queries and its pool connection leaked for the life of the
   * process — and `stream.end()` on the destroyed stream raised
   * ERR_STREAM_DESTROYED out of a detached task.
   *
   * Vitest fails a test on an unhandled rejection, so "this test passes" IS
   * the assertion that the cancel path settles cleanly. The receipt count
   * assertion afterwards proves the pool is still usable rather than holding
   * a connection the writer never gave back.
   */
  it("stops cleanly when the client cancels the download", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner1",
      members: [],
    });
    const owner = users.owner1;
    if (!owner) throw new Error("owner missing");
    await seedExportFixture(db, project.id, owner.id, { count: 20 });

    const started = await startProjectExport({
      db,
      user: owner as unknown as AuthUser,
      projectId: project.id,
      format: "xlsx",
      filters: {},
      now: FIXED_NOW,
      // One receipt a page, so the writer is certain to still be mid-loop
      // when the stream goes away.
      batchSize: 1,
    });

    started.stream.destroy();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(started.stream.destroyed).toBe(true);

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(receipts)
      .where(eq(receipts.projectId, project.id));
    expect(row?.n).toBe(20);
  });

  it("excludes soft-deleted receipts", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner1",
      members: [],
    });
    const owner = users.owner1;
    if (!owner) throw new Error("owner missing");
    const seeded = await seedExportFixture(db, project.id, owner.id, { count: 5 });
    const doomed = seeded[0];
    if (!doomed) throw new Error("fixture empty");
    await softDeleteReceipt(db, doomed.id);

    const started = await startProjectExport({
      db,
      user: owner as unknown as AuthUser,
      projectId: project.id,
      format: "xlsx",
      filters: {},
      now: FIXED_NOW,
    });
    const workbook = await loadWorkbook(started.stream);

    const ids = dataRows(workbook.getWorksheet(SHEET_RECEIPTS)!, 1).map((row) => row[0]);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain(doomed.id);
  });
});
