/**
 * apps/web/src/lib/receiptFilters.ts — the one URL-to-filter mapping.
 *
 * The dashboard reads these five parameters, `Filters.tsx` writes them, and
 * Phase 8's export button forwards them. That is three call sites for one
 * mapping, and the mapping has a trap in it: the URL says `category` while
 * `receipts.list` says `categoryId`. A third open-coded copy of that
 * translation is exactly how an export quietly stops matching the list it was
 * launched from.
 *
 * Takes a raw query string rather than a `useSearchParams()` value on
 * purpose, so it can be called with `window.location.search` from inside an
 * event handler — the rule `Filters.tsx` is built around (task 7.7): read the
 * live query string at call time, never from a render-time closure.
 */

/** The parameters an export forwards, in a fixed order so a generated URL is
 *  stable. Anything else in the address bar is deliberately dropped. */
export const FILTER_PARAMS = ["from", "to", "category", "uploadedBy", "needsReview"] as const;

export type ReceiptFilters = {
  from: string | undefined;
  to: string | undefined;
  categoryId: string | undefined;
  uploadedBy: string | undefined;
  needsReview: true | undefined;
};

type SearchLike = string | URLSearchParams | { get(key: string): string | null };

function reader(search: SearchLike): { get(key: string): string | null } {
  return typeof search === "string" ? new URLSearchParams(search) : search;
}

/** The filter set in `receipts.list`'s own naming. `undefined`, not `null` or
 *  `""`, for an absent filter — that is what the tRPC input treats as
 *  "unfiltered". */
export function parseReceiptFilters(search: SearchLike): ReceiptFilters {
  const params = reader(search);
  return {
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    categoryId: params.get("category") || undefined,
    uploadedBy: params.get("uploadedBy") || undefined,
    needsReview: params.get("needsReview") === "1" ? true : undefined,
  };
}

/** True when any filter is active — the dashboard's empty state says
 *  something different depending on it. */
export function hasAnyFilter(filters: ReceiptFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}

/**
 * The query string for an export download, built from the live URL. Only the
 * five known parameters are forwarded, so a stray `utm_source` never reaches
 * the server or the audit log, and the order is fixed so the same filter
 * always produces the same URL.
 */
export function exportSearch(search: SearchLike, format: "xlsx" | "csv"): string {
  const params = reader(search);
  const next = new URLSearchParams();
  for (const key of FILTER_PARAMS) {
    const value = params.get(key);
    if (value) next.set(key, value);
  }
  next.set("format", format);
  return next.toString();
}

/** The full download URL for a project's export. */
export function exportUrl(projectId: string, search: SearchLike, format: "xlsx" | "csv"): string {
  return `/api/projects/${encodeURIComponent(projectId)}/export?${exportSearch(search, format)}`;
}
