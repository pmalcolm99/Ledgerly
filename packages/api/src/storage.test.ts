import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteReceiptDir,
  deleteReceiptFile,
  fileSizeBytes,
  receiptDir,
  receiptFileExists,
  receiptFilePath,
  readReceiptFile,
  renameReceiptFile,
  writeReceiptFile,
} from "./storage";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const RECEIPT_ID = "22222222-2222-2222-2222-222222222222";

let uploadsDir: string;

beforeEach(async () => {
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-storage-test-"));
});

afterEach(async () => {
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

describe("receiptDir / receiptFilePath", () => {
  it("builds the documented layout", () => {
    expect(receiptDir(uploadsDir, PROJECT_ID, RECEIPT_ID)).toBe(
      path.join(uploadsDir, PROJECT_ID, RECEIPT_ID),
    );
    expect(receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "display", "webp")).toBe(
      path.join(uploadsDir, PROJECT_ID, RECEIPT_ID, "display.webp"),
    );
  });

  it("rejects a non-UUID projectId rather than building a path from it", () => {
    expect(() => receiptDir(uploadsDir, "../../etc", RECEIPT_ID)).toThrow(/not a UUID/);
  });

  it("rejects a non-UUID receiptId", () => {
    expect(() => receiptDir(uploadsDir, PROJECT_ID, "..%2F..%2Fetc")).toThrow(/not a UUID/);
  });

  it("rejects a traversal attempt disguised as an extension", () => {
    expect(() =>
      receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "original", "../../etc/passwd"),
    ).toThrow(/extension/);
  });
});

describe("write/read/delete round trip", () => {
  it("writes, reads back, and deletes a file", async () => {
    const filePath = receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "display", "webp");
    await writeReceiptFile(filePath, Buffer.from("fake-webp-bytes"));

    expect(await receiptFileExists(filePath)).toBe(true);
    expect((await readReceiptFile(filePath)).toString()).toBe("fake-webp-bytes");
    expect(await fileSizeBytes(filePath)).toBe(Buffer.byteLength("fake-webp-bytes"));

    await deleteReceiptFile(filePath);
    expect(await receiptFileExists(filePath)).toBe(false);
  });

  it("creates the receipt directory on first write", async () => {
    const filePath = receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "thumb", "webp");
    await writeReceiptFile(filePath, Buffer.from("x"));
    const stat = await fs.stat(receiptDir(uploadsDir, PROJECT_ID, RECEIPT_ID));
    expect(stat.isDirectory()).toBe(true);
  });

  it("deleting a missing file never throws", async () => {
    const filePath = receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "original", "jpg");
    await expect(deleteReceiptFile(filePath)).resolves.toBeUndefined();
  });
});

describe("renameReceiptFile", () => {
  it("promotes staging.<ext> to original.<ext>", async () => {
    const staging = receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "staging", "heic");
    const original = receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "original", "heic");
    await writeReceiptFile(staging, Buffer.from("raw-upload-bytes"));

    await renameReceiptFile(staging, original);

    expect(await receiptFileExists(staging)).toBe(false);
    expect((await readReceiptFile(original)).toString()).toBe("raw-upload-bytes");
  });
});

describe("deleteReceiptDir", () => {
  it("removes every render for a receipt", async () => {
    const dir = receiptDir(uploadsDir, PROJECT_ID, RECEIPT_ID);
    await writeReceiptFile(
      receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "display", "webp"),
      Buffer.from("a"),
    );
    await writeReceiptFile(
      receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "thumb", "webp"),
      Buffer.from("b"),
    );

    await deleteReceiptDir(uploadsDir, PROJECT_ID, RECEIPT_ID);

    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("never throws for a receipt directory that was never created", async () => {
    await expect(
      deleteReceiptDir(uploadsDir, PROJECT_ID, "33333333-3333-3333-3333-333333333333"),
    ).resolves.toBeUndefined();
  });

  it("leaves other receipts in the same project untouched", async () => {
    const otherReceiptId = "44444444-4444-4444-4444-444444444444";
    const kept = receiptFilePath(uploadsDir, PROJECT_ID, otherReceiptId, "display", "webp");
    await writeReceiptFile(kept, Buffer.from("keep-me"));
    await writeReceiptFile(
      receiptFilePath(uploadsDir, PROJECT_ID, RECEIPT_ID, "display", "webp"),
      Buffer.from("x"),
    );

    await deleteReceiptDir(uploadsDir, PROJECT_ID, RECEIPT_ID);

    expect(await receiptFileExists(kept)).toBe(true);
  });
});
