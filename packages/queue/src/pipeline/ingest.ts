import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import { extensionForType, sniffFileType } from "@ledgerly/shared/fileSniff";
import {
  deleteReceiptFile,
  readReceiptFile,
  receiptFilePath,
  renameReceiptFile,
  writeReceiptFile,
} from "@ledgerly/api/storage";

import { rasterizePdfFirstPage, renderDisplayAndThumb } from "./render";

/**
 * packages/queue/src/pipeline/ingest.ts — the `receipt-ingest` per-job
 * processor body (task 5.10, ARCHITECTURE.md §5's "Processing queue"
 * section). Deliberately Worker-agnostic (no BullMQ/Redis import here) so
 * it's directly unit-testable; `ingestWorker.ts` wraps this in an actual
 * BullMQ `Worker`.
 *
 * Retry-safety, precisely: `staging.bin` is consumed (renamed/deleted)
 * ONLY AFTER the `receipts` row is successfully updated with the new
 * render extensions — never before. An earlier version consumed it first,
 * which meant any failure between that consumption and the DB write (a
 * connection blip, a pool exhaustion) left a retry with no staged bytes to
 * re-process, throwing `STAGING_FILE_MISSING` on an ingest that had
 * actually succeeded (review finding H-3). The row itself is also checked
 * for "already ingested" at the top, so a retry that reaches this function
 * again after a fully successful prior run (e.g. the DB write committed
 * but the subsequent `receipt-extract` enqueue in `ingestWorker.ts`
 * failed, triggering a BullMQ retry of the whole job) is a fast, safe
 * no-op rather than redoing work or erroring on a staging file that's
 * already gone.
 */

export type IngestJobData = { receiptId: string };

/** Thrown on any failure. `reason` is a stable code -- `ingestWorker.ts`'s
 * `worker.on("failed", ...)` handler writes it to `receipts.extraction_error`
 * only once BullMQ's retries are exhausted, never mid-retry. The `message`
 * deliberately never embeds a filesystem path or other detail: BullMQ
 * persists `Error.message` as the job's `failedReason` in Redis, which can
 * surface in a queue-inspection UI (review finding, LOW) -- any detail
 * beyond the stable `reason` code is logged server-side instead. */
export class IngestError extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "IngestError";
    this.reason = reason;
  }
}

export type ProcessReceiptIngestDeps = {
  db: Database;
  uploadsDir: string;
  retainOriginals: boolean;
  /** Enforced at decode time too, not just the upload route's header
   * probe -- review finding M-1: without this, every actual `sharp`
   * decode used its own ~268MP default limit regardless of the
   * operator-configured `MAX_UPLOAD_MEGAPIXELS`. */
  maxMegapixels: number;
};

export async function processReceiptIngest(
  deps: ProcessReceiptIngestDeps,
  data: IngestJobData,
): Promise<void> {
  const { db, uploadsDir, retainOriginals, maxMegapixels } = deps;
  const { receiptId } = data;

  const [receipt] = await db
    .select({
      id: receipts.id,
      projectId: receipts.projectId,
      deletedAt: receipts.deletedAt,
      imageKey: receipts.imageKey,
    })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .limit(1);

  if (!receipt) {
    // Receipts are soft-deleted only (routers/receipts.ts) -- a truly
    // missing row means something is badly wrong upstream, not a
    // transient condition worth retrying toward.
    throw new IngestError("RECEIPT_NOT_FOUND");
  }
  if (receipt.deletedAt) {
    // A legitimate race: the user deleted the receipt while this job sat
    // queued. Nothing left to do -- not a failure.
    return;
  }
  if (receipt.imageKey) {
    // Already ingested by a prior attempt (H-3: a retry can legitimately
    // reach here after a fully successful run, if only the subsequent
    // receipt-extract enqueue failed). Nothing left to do.
    return;
  }

  const { projectId } = receipt;
  const stagingPath = receiptFilePath(uploadsDir, projectId, receiptId, "staging", "bin");

  let stagedBytes: Buffer;
  try {
    stagedBytes = await readReceiptFile(stagingPath);
  } catch {
    console.error(`[ledgerly] receipt ${receiptId}: staged upload missing at ${stagingPath}`);
    throw new IngestError("STAGING_FILE_MISSING");
  }

  // Re-sniffed from bytes, never trusted from job data -- the upload
  // route already sniffed this file once to pass its own guard chain;
  // sniffing again here means this job never depends on job-data fidelity
  // surviving a retry or a Redis restart.
  const sniffedType = sniffFileType(stagedBytes);
  if (!sniffedType) {
    throw new IngestError("IMAGE_DECODE_FAILED");
  }

  let sourceForRender: Buffer;
  if (sniffedType === "pdf") {
    const rasterized = await rasterizePdfFirstPage(stagedBytes);
    if (!rasterized.ok) {
      throw new IngestError(
        rasterized.reason === "unavailable" ? "PDFTOPPM_UNAVAILABLE" : "PDF_RASTERIZATION_FAILED",
      );
    }
    sourceForRender = rasterized.bytes;
  } else {
    // JPEG/PNG/WebP/TIFF/HEIC all decode directly through sharp (D-11) --
    // no separate rasterization step.
    sourceForRender = stagedBytes;
  }

  let renders: Awaited<ReturnType<typeof renderDisplayAndThumb>>;
  try {
    renders = await renderDisplayAndThumb(sourceForRender, receiptId, maxMegapixels);
  } catch (error) {
    console.error(`[ledgerly] receipt ${receiptId}: decode failed:`, error);
    throw new IngestError("IMAGE_DECODE_FAILED");
  }

  const displayPath = receiptFilePath(uploadsDir, projectId, receiptId, "display", "webp");
  const thumbPath = receiptFilePath(uploadsDir, projectId, receiptId, "thumb", "webp");
  try {
    await writeReceiptFile(displayPath, renders.display);
    await writeReceiptFile(thumbPath, renders.thumb);
  } catch (error) {
    console.error(`[ledgerly] receipt ${receiptId}: writing renders failed:`, error);
    throw new IngestError("RENDER_WRITE_FAILED");
  }

  const originalExt = retainOriginals ? extensionForType(sniffedType) : null;

  // The DB write happens BEFORE staging is touched (H-3) -- `staging.bin`
  // stays valid for a retry until the row itself proves the run finished.
  // The WHERE clause re-checks `deletedAt IS NULL`: a `receipts.delete`
  // landing between this job's start and this write (it already checked
  // `deletedAt` once, at the top) must not resurrect a row the user just
  // deleted, or leave orphaned renders with no corresponding DB state.
  const updated = await db
    .update(receipts)
    .set({
      imageKey: "webp",
      thumbKey: "webp",
      originalKey: originalExt,
      updatedAt: new Date(),
    })
    .where(and(eq(receipts.id, receiptId), isNull(receipts.deletedAt)))
    .returning({ id: receipts.id });

  if (updated.length === 0) {
    // Deleted concurrently, between the top-of-function check and here.
    // The renders just written are orphaned -- clean them up rather than
    // leaving files with no DB row pointing at them. Best-effort: a
    // failure here is a disk-space leak, not a correctness bug (the same
    // reasoning routers/receipts.ts's `deleteReceiptDir` call already
    // uses).
    await deleteReceiptFile(displayPath).catch(() => {});
    await deleteReceiptFile(thumbPath).catch(() => {});
    return;
  }

  // Only AFTER the DB write commits: consume the staged upload. A failure
  // here (rename/delete) is logged but not thrown -- the ingest itself
  // already succeeded and is recorded as such; a lingering `staging.bin`
  // is a disk-space leak, not a lost receipt.
  try {
    if (retainOriginals && originalExt) {
      await renameReceiptFile(
        stagingPath,
        receiptFilePath(uploadsDir, projectId, receiptId, "original", originalExt),
      );
    } else {
      await deleteReceiptFile(stagingPath);
    }
  } catch (error) {
    console.error(`[ledgerly] receipt ${receiptId}: failed to consume staged upload:`, error);
  }
}
