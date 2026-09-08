import "server-only";

import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

/**
 * packages/api/src/storage.ts — receipt image storage (task 5.7, D-23).
 *
 * Layout: `${uploadsDir}/<project_id>/<receipt_id>/{display,thumb,
 * original,staging}.<ext>`. `uploadsDir` is passed in by the caller
 * (normally `getEnv().UPLOADS_DIR`) rather than read from `@ledgerly/config`
 * here, so every function in this file is testable against a plain temp
 * directory with no environment coupling.
 *
 * Every path this module produces is built from that root plus two UUIDs
 * (`projectId`, `receiptId`) the CALLER must already have resolved from a
 * database row — never from a raw client-supplied string. `assertUuid`
 * below is a backstop, not the mechanism: the real guarantee is that
 * nothing in this file has any parameter an attacker's `../../etc/passwd`
 * or a crafted filename could flow into. Path traversal is unrepresentable,
 * not merely rejected.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`storage.ts: ${label} is not a UUID: ${JSON.stringify(value)}`);
  }
}

export type ReceiptFileKind = "display" | "thumb" | "original" | "staging";

const BASENAME: Record<ReceiptFileKind, string> = {
  display: "display",
  thumb: "thumb",
  original: "original",
  staging: "staging",
};

/** The directory holding every render for one receipt. */
export function receiptDir(uploadsDir: string, projectId: string, receiptId: string): string {
  assertUuid(projectId, "projectId");
  assertUuid(receiptId, "receiptId");
  return path.join(uploadsDir, projectId, receiptId);
}

/**
 * Full path for one render. `display`/`thumb` are always `.webp`
 * (ARCHITECTURE.md §5, the pipeline's fixed encode format); `original`/
 * `staging` take the extension of whatever `sniffFileType` decided the
 * upload actually is — never the client's claimed filename.
 */
export function receiptFilePath(
  uploadsDir: string,
  projectId: string,
  receiptId: string,
  kind: ReceiptFileKind,
  ext: string,
): string {
  if (!/^[a-z0-9]{1,8}$/i.test(ext)) {
    throw new Error(`storage.ts: refusing non-alphanumeric extension: ${JSON.stringify(ext)}`);
  }
  return path.join(receiptDir(uploadsDir, projectId, receiptId), `${BASENAME[kind]}.${ext}`);
}

/** Writes a render, creating the receipt's directory if this is its first
 * file. */
export async function writeReceiptFile(filePath: string, data: Buffer | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

export async function readReceiptFile(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}

export async function receiptFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Never throws on a missing file — a caller checking "did this render get
 * produced" already has its own existence check; this is for cleanup. */
export async function deleteReceiptFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

/** Same-filesystem rename — used to promote a `staging.<ext>` upload into a
 * permanent `original.<ext>` when `RETAIN_ORIGINALS=true` (cheap, atomic on
 * a single volume; both live under the same receipt directory). */
export async function renameReceiptFile(from: string, to: string): Promise<void> {
  await fs.rename(from, to);
}

export async function fileSizeBytes(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

/**
 * A Node readable stream over a render. The image-serving route uses this
 * instead of `readReceiptFile` (review finding M-8): reading the whole
 * file into a `Buffer` and then copying it again into a `Uint8Array` costs
 * roughly 2x the file's size in memory per in-flight request, with no
 * concurrency bound — for a retained original near `MAX_UPLOAD_BYTES`
 * that's meaningful. Streaming keeps memory bounded to one chunk at a
 * time regardless of file size or concurrent request count.
 */
export function receiptFileReadStream(filePath: string): ReturnType<typeof createReadStream> {
  return createReadStream(filePath);
}

/**
 * Deletes an entire receipt's image directory. `routers/receipts.ts` calls
 * this ONLY after the receipt's database row is confirmed soft-deleted and
 * that transaction has committed — deleting files first and then failing
 * to commit the DB row would be data loss (images gone for a receipt that
 * visually never got deleted); this ordering makes a failure here merely
 * an orphaned directory, not a lost receipt. `force: true` means a receipt
 * whose ingest job never produced any files (deleted before processing
 * finished) is a valid, unsurprising case to delete from.
 */
export async function deleteReceiptDir(
  uploadsDir: string,
  projectId: string,
  receiptId: string,
): Promise<void> {
  await fs.rm(receiptDir(uploadsDir, projectId, receiptId), { recursive: true, force: true });
}
