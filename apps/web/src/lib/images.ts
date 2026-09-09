/**
 * Receipt image URLs.
 *
 * `/api/images/<receiptId>/<kind>` re-derives the filesystem path server-side
 * from the receipt row, so nothing user-supplied ever reaches `fs` (D-23).
 * These are authenticated routes, never static assets, which is also why the
 * service worker must never cache them.
 *
 * Both `thumb` and `display` 404 until ingest has finished writing the
 * renders — a freshly uploaded receipt has no image for a second or two. The
 * capture flow keeps its local object-URL preview until the real thumb loads,
 * rather than flashing a broken image.
 */
export type ImageKind = "thumb" | "display" | "original";

export function receiptImageUrl(receiptId: string, kind: ImageKind): string {
  return `/api/images/${receiptId}/${kind}`;
}
