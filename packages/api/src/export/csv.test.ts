import { PassThrough } from "node:stream";

import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { receiptItems, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { UTF8_BOM } from "./csv";
import { startProjectExport } from "./index";
import { LINE_ITEM_COLUMNS, RECEIPT_GRAIN_HEADERS } from "./rows";
import { seedExportFixture } from "./fixture.test-helper";

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

async function collect(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function exportCsv(now: Date, projectName = "Kitchen Remodel"): Promise<string> {
  const { project, users } = await createTestProjectWithMembers(db, {
    ownerKey: "owner1",
    members: [],
    name: projectName,
  });
  const owner = users.owner1;
  if (!owner) throw new Error("owner missing");
  await seedExportFixture(db, project.id, owner.id, { count: 6 });

  const started = await startProjectExport({
    db,
    user: owner as unknown as AuthUser,
    projectId: project.id,
    format: "csv",
    filters: {},
    now,
  });
  return collect(started.stream);
}

describe("CSV export", () => {
  it("opens with a UTF-8 BOM so Excel does not mangle non-ASCII", async () => {
    const csv = await exportCsv(new Date("2026-09-09T14:22:31.000Z"));
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
  });

  it("emits the line-item sheet only, header block included", async () => {
    const csv = await exportCsv(new Date("2026-09-09T14:22:31.000Z"));
    const lines = csv.slice(UTF8_BOM.length).split("\r\n");

    expect(lines[0]).toBe("Ledgerly export — Kitchen Remodel");
    expect(lines[1]).toContain("Exported 2026-09-09T14:22:31.000Z by ");
    expect(lines[2]).toBe("Filters: none");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe(LINE_ITEM_COLUMNS.map((c) => c.header).join(","));

    // Sheet 2's grain must not appear in it. Compared as parsed header
    // NAMES, not substrings — `line_total` contains "total" and a substring
    // assertion here would either false-positive or have to be weakened
    // until it proved nothing.
    const headers = (lines[4] ?? "").split(",");
    for (const forbidden of RECEIPT_GRAIN_HEADERS) {
      expect(headers).not.toContain(forbidden);
    }
    expect(headers).toContain("line_total");
  });

  /**
   * Task 8.4's acceptance criterion, and D-38's trade-off made visible.
   * Excel strips the leading zero from `0042` and from `"0042"` alike on a
   * double-click open; `="0042"` is the only form that survives.
   */
  it("writes card_last4 so Excel keeps the leading zero", async () => {
    const csv = await exportCsv(new Date("2026-09-09T14:22:31.000Z"));
    expect(csv).toContain('"=""0042"""');
    // The non-zero-leading case stays a plain value — the escape is applied
    // only where a leading zero is actually possible.
    expect(csv).toContain(",4321,");
  });

  it("writes dates as bare ISO and money as plain decimals", async () => {
    const csv = await exportCsv(new Date("2026-09-09T14:22:31.000Z"));
    const body = csv.split("\r\n").slice(5).filter(Boolean);
    const first = body[0];
    if (!first) throw new Error("no data rows");

    const cells = first.split(",");
    // transaction_date is column 3 (1-based) and no row in the fixture has a
    // comma in project_name/receipt_id, so a naive split is safe here.
    expect(cells[2]).toMatch(/^2026-03-\d{2}$/);
    // No currency symbol and no thousands separator — either turns a number
    // Excel can sum into text it cannot.
    expect(csv).not.toContain("$");
    const lineTotalIndex = LINE_ITEM_COLUMNS.findIndex((c) => c.header === "line_total");
    expect(cells[lineTotalIndex]).toMatch(/^\d+\.\d{2}$/);
  });

  /**
   * CSV formula injection (review finding H-1).
   *
   * The merchant line is READ OFF A PHOTOGRAPH by the model and stored
   * unconstrained; `item_description` and `receipt_notes` are free text any
   * `read_add` member can set. A spreadsheet evaluates any cell whose text
   * starts with `=`, `+`, `-` or `@` when it opens a CSV, and quoting is not
   * a mitigation — D-38 exists precisely because Excel re-parses the contents
   * of a quoted field.
   */
  it("neutralizes a formula in any free-text column", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner1",
      members: [],
      name: "Kitchen Remodel",
    });
    const owner = users.owner1;
    if (!owner) throw new Error("owner missing");

    const [receipt] = await db
      .insert(receipts)
      .values({
        projectId: project.id,
        uploadedBy: owner.id,
        // Exactly what a crafted receipt image would put here.
        merchantName: "=cmd|'/c calc'!A0",
        userNotes: "@SUM(A1:A9)",
        transactionDate: "2026-03-04",
        subtotal: "10.00",
        salesTax: "1.00",
        total: "11.00",
        extractionStatus: "ok",
      })
      .returning({ id: receipts.id });
    if (!receipt) throw new Error("insert failed");

    await db.insert(receiptItems).values({
      receiptId: receipt.id,
      lineNo: 1,
      description: "+441234567890",
      quantity: "1.000",
      unitPrice: "10.00",
      lineTotal: "10.00",
    });

    const started = await startProjectExport({
      db,
      user: owner as unknown as AuthUser,
      projectId: project.id,
      format: "csv",
      filters: {},
      now: new Date("2026-09-09T14:22:31.000Z"),
    });
    const csv = await collect(started.stream);

    // Each dangerous value is present, and each is prefixed so no spreadsheet
    // will evaluate it.
    expect(csv).toContain(`'=cmd|`);
    expect(csv).toContain(`'@SUM(A1:A9)`);
    expect(csv).toContain(`'+441234567890`);

    // And no data cell begins with a bare formula lead. The header block's own
    // rows are literals starting with "Ledgerly"/"Exported"/"Filters".
    for (const line of csv.split("\r\n").slice(5)) {
      if (line === "" || line.startsWith("#")) continue;
      for (const cell of line.split(",")) {
        expect(cell.replace(/^"/, "")).not.toMatch(/^[=+\-@]/);
      }
    }
  });

  /**
   * A truncated CSV is a syntactically valid CSV — every complete line before
   * the cut is still a well-formed record — so unlike the XLSX path there is
   * nothing about the file itself that says it is short. The terminal row is
   * what makes that detectable (review finding L-2).
   */
  it("ends with a row naming the line-item count", async () => {
    const csv = await exportCsv(new Date("2026-09-09T14:22:31.000Z"));
    const lines = csv.trimEnd().split("\r\n");
    const last = lines[lines.length - 1] ?? "";

    expect(last).toMatch(/^# end of export: \d+ line items$/);

    const claimed = Number(/(\d+)/.exec(last)?.[1]);
    // Data rows: everything after the 5-row header block, minus the blank
    // separator and the terminal row themselves.
    const dataRows = lines.slice(5).filter((l) => l !== "" && !l.startsWith("#"));
    expect(dataRows).toHaveLength(claimed);
  });

  /**
   * Task 8.5: two exports of the same filter are byte-identical apart from
   * the timestamp. Asserted literally for CSV — for XLSX the same claim is
   * relaxed to content-identical, because a zip container embeds entry
   * timestamps and asserting bytes there would be asserting something untrue.
   */
  it("is byte-identical across two runs apart from the timestamp line", async () => {
    const first = await exportCsv(new Date("2026-09-09T14:22:31.000Z"));
    await withCleanDatabase();
    db = drizzle(getCleanPool(), { schema });
    const second = await exportCsv(new Date("2027-01-02T03:04:05.000Z"));

    const strip = (csv: string): string[] => {
      const lines = csv.split("\r\n");
      // Line 2 (index 1) is the timestamp line, the one permitted difference.
      // Receipt ids are server-generated uuids and differ between the two
      // seeded databases, so they are normalised out — the assertion is
      // about the shape and ordering of the file, which is what
      // reproducibility means here.
      return lines
        .filter((_, index) => index !== 1)
        .map((line) =>
          line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"),
        );
    };

    expect(strip(second)).toEqual(strip(first));
  });
});
