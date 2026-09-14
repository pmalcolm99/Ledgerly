import { Readable } from "node:stream";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { AuthError, isOnboarded, requireAuthRoute } from "@ledgerly/auth";
import { buildAccessDeniedResponse } from "@ledgerly/auth/response";
import type { Env } from "@ledgerly/config/env";
import { receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import { scopedProjects } from "@ledgerly/api/scope";
import { fileSizeBytes, receiptFilePath, receiptFileReadStream } from "@ledgerly/api/storage";

/**
 * `original` is the retained upload. Since Phase 10a (F-10) it is the
 * original PIXELS, not the original BYTES: EXIF -- including the GPS tag a
 * phone stamps onto a receipt photo -- is stripped before the file is
 * stored. For JPEG, PNG and WebP the image data is bit-identical to the
 * upload; a HEIC that cannot be re-encoded in its own format is stored as a
 * quality-100 JPEG and `original_key` records `jpg` to match.
 *
 * It is still the most sensitive of the three renditions -- full resolution,
 * and the only one a person would think to exfiltrate -- so it keeps the
 * tighter gate below (uploader or a `manage`-level member) and the
 * no-store/attachment headers, rather than being served like a thumbnail.
 *
 * Path traversal is impossible by construction (D-23), and that is worth
 * stating because the route takes `[...key]`: the URL segments only ever
 * select a receipt id and a rendition NAME, and the filesystem path is
 * re-derived from the DB row's own `projectId`/`id` UUIDs. No segment
 * reaches `path.join`.
 *
 * The logic lives here rather than in `route.ts` because Next.js's route
 * type-checker rejects any named export from a `route.ts` besides the
 * recognised HTTP-method/config exports, and tests need to call this
 * directly.
 */

const KIND_TO_COLUMN = {
  display: "imageKey",
  thumb: "thumbKey",
  original: "originalKey",
} as const;

type Kind = keyof typeof KIND_TO_COLUMN;

function isKind(value: string): value is Kind {
  return value === "display" || value === "thumb" || value === "original";
}

const MIME_BY_EXT: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  tiff: "image/tiff",
  pdf: "application/pdf",
};

function notFound(): Response {
  return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
}

/** `route.ts`'s `GET` is a thin binding onto real `getDb()`/`getEnv()`;
 * this carries the actual logic against injected `db`/`env` so tests can
 * point it at the test database and a temp `UPLOADS_DIR` (D-18). */
export async function handleImageGet(
  request: Request,
  key: string[],
  deps: { db: Database; env: Env },
): Promise<Response> {
  const { db, env } = deps;

  let user;
  try {
    user = await requireAuthRoute(request);
  } catch (error) {
    if (error instanceof AuthError) return buildAccessDeniedResponse("no_identity");
    throw error;
  }

  // Deliberately 404, not the app-wide 403. An un-onboarded caller is
  // authenticated but has no business knowing whether a given receipt id
  // exists, and 403 would tell them -- the same not-found-means-not-yours
  // convention every project-scoped read in this app uses.
  if (!isOnboarded(user)) return notFound();

  if (key.length !== 2) return notFound();
  const [receiptId, kindParam] = key;
  if (!receiptId || !kindParam || !isKind(kindParam)) return notFound();

  const [row] = await db
    .select({
      id: receipts.id,
      projectId: receipts.projectId,
      uploadedBy: receipts.uploadedBy,
      imageKey: receipts.imageKey,
      thumbKey: receipts.thumbKey,
      originalKey: receipts.originalKey,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.id, receiptId),
        isNull(receipts.deletedAt),
        inArray(receipts.projectId, scopedProjects(user, "read")),
      ),
    )
    .limit(1);
  if (!row) return notFound();

  if (kindParam === "original" && row.uploadedBy !== user.id) {
    const [manageRow] = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          eq(receipts.id, receiptId),
          inArray(receipts.projectId, scopedProjects(user, "manage")),
        ),
      )
      .limit(1);
    if (!manageRow) return notFound();
  }

  const ext = row[KIND_TO_COLUMN[kindParam]];
  if (!ext) return notFound(); // render not produced yet, or not retained

  let size: number;
  let filePath: string;
  try {
    filePath = receiptFilePath(env.UPLOADS_DIR, row.projectId, row.id, kindParam, ext);
    size = await fileSizeBytes(filePath);
  } catch {
    // The DB row says this render exists but the file is gone (or `ext`
    // was somehow not a clean extension) -- still just 404, no detail.
    return notFound();
  }

  const stream = Readable.toWeb(receiptFileReadStream(filePath)) as ReadableStream;

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": MIME_BY_EXT[ext] ?? "application/octet-stream",
      "content-length": String(size),
      // Both defensive: this endpoint serves whatever bytes a user
      // uploaded, sniffed only well enough to know it's a JPEG/PNG/WebP/
      // TIFF/HEIC/PDF -- not that it's SAFE to render. `nosniff` stops a
      // browser from reinterpreting the body as something more dangerous
      // than the declared content-type; `Content-Security-Policy:
      // sandbox` defuses script execution if this response is ever
      // opened as a top-level navigation rather than via <img src>.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      // `original` is the retained upload -- full resolution, less
      // frequently viewed than display/thumb and more sensitive (M-3), so
      // it's offered as a download rather than rendered inline. Its EXIF,
      // GPS included, is stripped before storage (F-10); it is the original
      // PIXELS, not the original bytes.
      "content-disposition":
        kindParam === "original"
          ? `attachment; filename="receipt.${ext}"`
          : `inline; filename="receipt.${ext}"`,
      // display/thumb are immutable once written (a new upload gets a new
      // receipt id) and safe to cache client-side once fetched -- a real
      // win for a PWA's grid views. `original` stays no-store, matching
      // its more sensitive/less-frequent-access treatment above.
      "cache-control":
        kindParam === "original" ? "private, no-store" : "private, max-age=86400, must-revalidate",
    },
  });
}
