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
 * apps/web/src/app/api/images/[...key]/handler.ts — authenticated image
 * serving (task 5.8, D-23).
 *
 * Split out of route.ts because Next.js's route type-checker rejects any
 * named export from a route.ts file besides the recognized HTTP-method/
 * config exports -- `handleImageGet` can't live there once it needs to be
 * exported for tests to call directly.
 *
 * URL shape: `/api/images/<receiptId>/<kind>`, `kind` one of
 * display/thumb/original. Those segments are used ONLY to look up a
 * receipt row and pick which DB column to read -- the actual filesystem
 * path is always re-derived server-side from that row's own `projectId`/
 * `id` (storage.ts's `receiptFilePath`), never from the URL directly. This
 * is the concrete mechanism behind "path traversal is unrepresentable by
 * construction" (D-23) -- nothing here ever passes a URL segment to `fs`.
 *
 * Failure shape, resolved deliberately with the user before writing this
 * file: **403 for no valid identity at all** (matches the app-wide D-24
 * byte-identical-403 convention -- this isn't a receipt-existence
 * question), **404 for every other failure** -- unonboarded, malformed
 * key, nonexistent receipt, wrong project, no membership, or a render
 * column that's still null (not yet processed / not retained). All of
 * those are indistinguishable on purpose: this endpoint must never be an
 * existence oracle for another user's receipts.
 *
 * `original` is additionally restricted to the uploader or a `manage`-level
 * member (full/project owner/instance owner) — review finding M-3.
 * `display`/`thumb` strip EXIF (GPS included) by construction
 * (render.ts), but `original` is D-09's deliberately "untouched bytes",
 * which means a retained original can carry the uploader's GPS
 * coordinates. `display`/`thumb` stay at the general `read` floor;
 * `original` does not.
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

  // Deliberately 404, not the app-wide 403 -- see the module comment.
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
      // `original` is the untouched upload (D-09) -- less frequently
      // viewed than display/thumb and more sensitive (M-3), so it's
      // offered as a download rather than rendered inline.
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
