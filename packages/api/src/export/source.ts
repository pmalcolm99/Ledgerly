import "server-only";

import type { AuthUser } from "@ledgerly/auth";
import type { Database } from "@ledgerly/db";

import { describeFilters } from "./filters";
import type { ExportFilters, FilterLabels } from "./filters";
import {
  EXPORT_BATCH_SIZE,
  fetchItemsForReceipts,
  fetchReceiptPage,
  groupItemsByReceipt,
} from "./query";
import type { ExportItemRow, ExportReceiptRow, ReceiptCursor } from "./query";

/**
 * packages/api/src/export/source.ts — what the two writers consume.
 *
 * The XLSX and CSV writers differ in everything except where their rows come
 * from, so the paging loop lives here once. It is an async iterable of PAGES
 * rather than of rows: the writers apply backpressure per page, and a
 * per-row iterable would make that a per-row check for no benefit.
 *
 * Everything a writer needs about the export as a whole — project name, who
 * ran it, when, under what filter, in what currency — is resolved once,
 * eagerly, before the first page. A writer never touches the database.
 */

export type ExportReceiptWithItems = {
  receipt: ExportReceiptRow;
  items: ExportItemRow[];
};

export type ExportSource = {
  projectName: string;
  exportedAt: Date;
  exportedBy: string;
  filterDescription: string;
  currencies: string[];
  pages(): AsyncIterable<ExportReceiptWithItems[]>;
};

export type BuildSourceInput = {
  db: Database;
  user: AuthUser;
  projectId: string;
  projectName: string;
  filters: ExportFilters;
  filterLabels: FilterLabels;
  currencies: string[];
  exportedAt: Date;
  exportedBy: string;
  /** Overridable so a test can prove the paging loop actually pages rather
   *  than trusting that it would at 500. */
  batchSize?: number;
  /** The request's signal. A client that disconnects aborts it, which stops
   *  the paging loop; without it a stalled reader parks the writer, and the
   *  page it is holding, until the process is restarted (review finding M-2).
   *  `stream.destroyed` catches a cancelled read, but a reader that simply
   *  stops reading never destroys anything. */
  signal?: AbortSignal;
};

export function buildExportSource(input: BuildSourceInput): ExportSource {
  const batchSize = input.batchSize ?? EXPORT_BATCH_SIZE;

  async function* pages(): AsyncIterable<ExportReceiptWithItems[]> {
    let cursor: ReceiptCursor | null = null;

    for (;;) {
      if (input.signal?.aborted) return;

      const receipts = await fetchReceiptPage(
        input.db,
        input.user,
        input.projectId,
        input.filters,
        cursor,
        batchSize,
      );
      if (receipts.length === 0) return;

      const items = await fetchItemsForReceipts(
        input.db,
        input.user,
        receipts.map((r) => r.id),
      );
      const byReceipt = groupItemsByReceipt(items);

      yield receipts.map((receipt) => ({
        receipt,
        items: byReceipt.get(receipt.id) ?? [],
      }));

      // A short page means the table is exhausted; a full one might not be,
      // so the loop always makes one more round trip that returns nothing.
      // That extra query is cheaper than getting the boundary wrong and
      // silently truncating someone's tax export at a page edge.
      if (receipts.length < batchSize) return;

      const last = receipts[receipts.length - 1];
      if (!last) return;
      cursor = { transactionDate: last.transactionDate, id: last.id };
    }
  }

  return {
    projectName: input.projectName,
    exportedAt: input.exportedAt,
    exportedBy: input.exportedBy,
    filterDescription: describeFilters(input.filters, input.filterLabels),
    currencies: input.currencies,
    pages,
  };
}
