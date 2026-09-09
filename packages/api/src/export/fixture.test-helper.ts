import type { PassThrough } from "node:stream";

import ExcelJS from "exceljs";
import { and, eq, isNull } from "drizzle-orm";
import { categories, receiptItems, receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";

/**
 * packages/api/src/export/fixture.test-helper.ts — a project whose books
 * actually balance.
 *
 * The reconciliation assertion is only meaningful against data that ought to
 * reconcile, so this builds receipts the way a correct extraction would:
 * `subtotal` is exactly the sum of the line totals, and `total` is exactly
 * `subtotal + sales_tax + tip`. All of it in integer cents, because a fixture
 * generated with floating-point arithmetic would fail the very assertion it
 * exists to support and the failure would look like a bug in the exporter.
 *
 * Shared by the workbook, CSV and permission suites rather than copied into
 * each — three fixtures that drift apart would let one suite pass against
 * data another suite proves is wrong.
 */

export type SeedOptions = {
  /** Receipts to create. The phase gate asks for at least 20. */
  count?: number;
  /** Give one receipt a `card_last4` with a leading zero, one a null total,
   *  one no line items, one no transaction date. Off for suites that want a
   *  uniformly clean set. */
  includeEdgeCases?: boolean;
};

export type SeededReceipt = {
  id: string;
  transactionDate: string | null;
  subtotalCents: number;
  salesTaxCents: number;
  tipCents: number;
  totalCents: number;
  lineCents: number[];
};

/** Deterministic, so a failure is reproducible. `mulberry32`, the same PRNG
 *  `money.test.ts` adopted after review finding L-8. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export async function seedExportFixture(
  db: Database,
  projectId: string,
  uploadedBy: string,
  options: SeedOptions = {},
): Promise<SeededReceipt[]> {
  const count = options.count ?? 22;
  const edge = options.includeEdgeCases ?? true;
  const random = mulberry32(20260909);

  const categoryRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(isNull(categories.deletedAt))
    .limit(6);

  const seeded: SeededReceipt[] = [];

  for (let index = 0; index < count; index += 1) {
    // A receipt with no items at all, so the "receipts with no line items"
    // path is exercised rather than assumed.
    const itemless = edge && index === count - 1;
    const itemCount = itemless ? 0 : 1 + Math.floor(random() * 4);

    const lineCents: number[] = [];
    for (let line = 0; line < itemCount; line += 1) {
      lineCents.push(100 + Math.floor(random() * 40_000));
    }

    const subtotalCents = lineCents.reduce((sum, cents) => sum + cents, 0);
    const salesTaxCents = Math.round(subtotalCents * 0.0875);
    const tipCents = edge && index % 7 === 3 ? Math.round(subtotalCents * 0.18) : 0;
    const totalCents = subtotalCents + salesTaxCents + tipCents;

    // Dates walk backwards from a fixed day so the keyset ordering is
    // exercised with real ties as well as distinct dates.
    const day = 1 + (index % 20);
    const transactionDate = edge && index === 0 ? null : `2026-03-${String(day).padStart(2, "0")}`;

    // One receipt whose total never came back, so `receiptsMissingTotal` and
    // the blank-money-cell path are both covered.
    const missingTotal = edge && index === 1;

    const [row] = await db
      .insert(receipts)
      .values({
        projectId,
        uploadedBy,
        merchantName: `Merchant ${String(index).padStart(2, "0")}`,
        transactionDate,
        subtotal: money(subtotalCents),
        salesTax: money(salesTaxCents),
        tip: tipCents === 0 ? null : money(tipCents),
        total: missingTotal ? null : money(totalCents),
        currency: "USD",
        // The leading-zero case task 8.4 names. `char(4)` with a digits-only
        // CHECK, so "0042" is a value the database can and does hold.
        cardLast4: edge && index === 2 ? "0042" : "4321",
        paymentMethod: index % 2 === 0 ? "Visa" : "Cash",
        userNotes: index % 5 === 0 ? `Note for receipt ${index}` : null,
        imageKey: "webp",
        thumbKey: "webp",
        extractionStatus: "ok",
      })
      .returning({ id: receipts.id });
    if (!row) throw new Error("fixture: receipt insert returned nothing");

    for (let line = 0; line < itemCount; line += 1) {
      const category = categoryRows[line % Math.max(categoryRows.length, 1)];
      const cents = lineCents[line] ?? 0;
      await db.insert(receiptItems).values({
        receiptId: row.id,
        // Every fourth item is left uncategorised, which is a real state
        // (`category_id` is nullable) and gives the summary an "(Unassigned)"
        // bucket to render.
        categoryId: line % 4 === 3 ? null : (category?.id ?? null),
        lineNo: line + 1,
        description: `Item ${line + 1} on receipt ${index}`,
        quantity: line % 3 === 0 ? "1.500" : "2.000",
        unitPrice: money(cents),
        lineTotal: money(cents),
      });
    }

    seeded.push({
      id: row.id,
      transactionDate,
      subtotalCents,
      salesTaxCents,
      tipCents,
      totalCents: missingTotal ? 0 : totalCents,
      lineCents,
    });
  }

  return seeded;
}

/** Soft-deletes one receipt, so a suite can prove the export excludes it. */
export async function softDeleteReceipt(db: Database, receiptId: string): Promise<void> {
  await db
    .update(receipts)
    .set({ deletedAt: new Date() })
    .where(and(eq(receipts.id, receiptId), isNull(receipts.deletedAt)));
}

/**
 * Drains an export stream and reads the workbook back.
 *
 * The cast is the one in this codebase that is a third-party defect rather
 * than a shortcut: `exceljs/index.d.ts` line 1 declares a GLOBAL
 * `interface Buffer extends ArrayBuffer {}`, which merges with @types/node's
 * `Buffer<ArrayBuffer>` into a type nothing can actually satisfy — not
 * `Buffer.concat`'s result, not `Buffer.alloc`'s, not a real `ArrayBuffer`.
 * `xlsx.load` accepts all three at runtime. Confining the cast to this one
 * helper keeps every suite that reads a workbook back honest about why it is
 * there, instead of each growing its own unexplained `as`.
 */
export async function loadWorkbook(stream: PassThrough): Promise<ExcelJS.Workbook> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

/** Drains a stream to the end without parsing it. Every test must consume
 *  the stream it starts: `startProjectExport` returns while its writer is
 *  still paging the database, and an abandoned stream leaves those queries
 *  in flight for the next test's `withCleanDatabase()` TRUNCATE to deadlock
 *  against. */
export async function drainStream(stream: PassThrough): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).byteLength;
  return bytes;
}
