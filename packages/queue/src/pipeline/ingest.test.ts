import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { receipts } from "@ledgerly/db/schema";
import { receiptFileExists, receiptFilePath, writeReceiptFile } from "@ledgerly/api/storage";

import { IngestError, processReceiptIngest } from "./ingest";

let db: ReturnType<typeof drizzle<typeof schema>>;
let uploadsDir: string;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-ingest-test-"));
});

afterEach(async () => {
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await getCleanPool().end();
});

async function insertPendingReceipt(projectId: string): Promise<string> {
  const [row] = await db
    .insert(receipts)
    .values({ projectId, extractionStatus: "pending" })
    .returning({ id: receipts.id });
  if (!row) throw new Error("failed to insert test receipt");
  return row.id;
}

async function stageJpeg(
  projectId: string,
  receiptId: string,
  opts?: { width?: number; height?: number },
) {
  const bytes = await sharp({
    create: {
      width: opts?.width ?? 3000,
      height: opts?.height ?? 2000,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .jpeg()
    .toBuffer();
  await writeReceiptFile(
    receiptFilePath(uploadsDir, projectId, receiptId, "staging", "bin"),
    bytes,
  );
}

describe("processReceiptIngest -- success path", () => {
  it("produces display + thumb renders and records the extensions on the receipt", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner1", members: [] });
    const receiptId = await insertPendingReceipt(project.id);
    await stageJpeg(project.id, receiptId);

    await processReceiptIngest(
      { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
      { receiptId },
    );

    const displayPath = receiptFilePath(uploadsDir, project.id, receiptId, "display", "webp");
    const thumbPath = receiptFilePath(uploadsDir, project.id, receiptId, "thumb", "webp");
    expect(await receiptFileExists(displayPath)).toBe(true);
    expect(await receiptFileExists(thumbPath)).toBe(true);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.imageKey).toBe("webp");
    expect(row?.thumbKey).toBe("webp");
    expect(row?.originalKey).toBeNull();
    // extraction_status is untouched by ingest success -- it's Phase 6's
    // vocabulary, not this pipeline's.
    expect(row?.extractionStatus).toBe("pending");
  });

  it("deletes the staged upload when RETAIN_ORIGINALS is false", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner2", members: [] });
    const receiptId = await insertPendingReceipt(project.id);
    await stageJpeg(project.id, receiptId);
    const stagingPath = receiptFilePath(uploadsDir, project.id, receiptId, "staging", "bin");

    await processReceiptIngest(
      { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
      { receiptId },
    );

    expect(await receiptFileExists(stagingPath)).toBe(false);
  });

  it("promotes the staged upload to original.<ext> when RETAIN_ORIGINALS is true", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner3", members: [] });
    const receiptId = await insertPendingReceipt(project.id);
    await stageJpeg(project.id, receiptId);
    const stagingPath = receiptFilePath(uploadsDir, project.id, receiptId, "staging", "bin");

    await processReceiptIngest(
      { db, uploadsDir, retainOriginals: true, maxMegapixels: 100 },
      { receiptId },
    );

    expect(await receiptFileExists(stagingPath)).toBe(false);
    const originalPath = receiptFilePath(uploadsDir, project.id, receiptId, "original", "jpg");
    expect(await receiptFileExists(originalPath)).toBe(true);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.originalKey).toBe("jpg");
  });

  it("is retry-safe -- a second run after a fully successful first run is a no-op, even with staging already gone", async () => {
    // H-3: a retry can legitimately reach processReceiptIngest again after
    // a prior run already succeeded (e.g. only the SUBSEQUENT
    // receipt-extract enqueue failed, in ingestWorker.ts, triggering a
    // whole-job retry). The row's imageKey being set is what makes that
    // safe -- not staging.bin still existing, which by this point never
    // does (RETAIN_ORIGINALS=false deletes it; true renames it away).
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner4", members: [] });
    const receiptId = await insertPendingReceipt(project.id);
    await stageJpeg(project.id, receiptId);

    await processReceiptIngest(
      { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
      { receiptId },
    );
    const stagingPath = receiptFilePath(uploadsDir, project.id, receiptId, "staging", "bin");
    expect(await receiptFileExists(stagingPath)).toBe(false); // confirms staging is genuinely gone

    await expect(
      processReceiptIngest(
        { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
        { receiptId },
      ),
    ).resolves.toBeUndefined();
  });

  it("does not touch the receipt again once already ingested (checked before reading staging)", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner4b",
      members: [],
    });
    const receiptId = await insertPendingReceipt(project.id);
    // Simulate "already ingested by a prior attempt" directly, without a
    // real render pass, to prove the early-return happens strictly before
    // any staging file is read.
    await db
      .update(receipts)
      .set({ imageKey: "webp", thumbKey: "webp" })
      .where(eq(receipts.id, receiptId));

    await expect(
      processReceiptIngest(
        { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
        { receiptId },
      ),
    ).resolves.toBeUndefined();
  });

  it("returns without error for a receipt that was soft-deleted while queued", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner5", members: [] });
    const receiptId = await insertPendingReceipt(project.id);
    await stageJpeg(project.id, receiptId);
    await db.update(receipts).set({ deletedAt: new Date() }).where(eq(receipts.id, receiptId));

    await expect(
      processReceiptIngest(
        { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
        { receiptId },
      ),
    ).resolves.toBeUndefined();

    // No renders should have been produced for a deleted receipt -- the
    // staged upload is still sitting there untouched (nothing ran), but
    // display/thumb were never written.
    expect(
      await receiptFileExists(
        receiptFilePath(uploadsDir, project.id, receiptId, "display", "webp"),
      ),
    ).toBe(false);
  });
});

describe("processReceiptIngest -- failure path", () => {
  it("throws IngestError(RECEIPT_NOT_FOUND) for a nonexistent receipt", async () => {
    await expect(
      processReceiptIngest(
        { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
        { receiptId: "99999999-9999-9999-9999-999999999999" },
      ),
    ).rejects.toMatchObject({ reason: "RECEIPT_NOT_FOUND" });
  });

  it("throws IngestError(STAGING_FILE_MISSING) when the staged upload is gone", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner6", members: [] });
    const receiptId = await insertPendingReceipt(project.id);
    // No stageJpeg() call -- nothing was ever staged.

    const error = await processReceiptIngest(
      { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
      { receiptId },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).reason).toBe("STAGING_FILE_MISSING");
  });

  it("throws IngestError(IMAGE_DECODE_FAILED) for staged bytes that no longer sniff as a known type", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner7", members: [] });
    const receiptId = await insertPendingReceipt(project.id);
    await writeReceiptFile(
      receiptFilePath(uploadsDir, project.id, receiptId, "staging", "bin"),
      Buffer.from("not an image"),
    );

    const error = await processReceiptIngest(
      { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
      { receiptId },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).reason).toBe("IMAGE_DECODE_FAILED");
  });

  it("leaves the receipt row untouched on failure -- worker.on('failed') owns the DB write, not this function", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner8", members: [] });
    const receiptId = await insertPendingReceipt(project.id);

    await processReceiptIngest(
      { db, uploadsDir, retainOriginals: false, maxMegapixels: 100 },
      { receiptId },
    ).catch(() => {});

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.extractionStatus).toBe("pending");
    expect(row?.extractionError).toBeNull();
  });
});
