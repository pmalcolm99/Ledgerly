import "server-only";

import { z } from "zod";

/**
 * packages/api/src/export/filters.ts — the export's query-string contract.
 *
 * Deliberately named for the URL, not the API. The dashboard writes its
 * filter state into the address bar as `from`/`to`/`category`/`uploadedBy`/
 * `needsReview` (`apps/web/src/components/Filters.tsx`), and the Export
 * button forwards that live query string verbatim rather than rebuilding it.
 * So `category`, not `categoryId`, is the wire name here; the mapping to
 * `receipts.list`'s input shape happens once, below.
 *
 * The filter set and its semantics mirror `routers/receipts.ts`'s `list`
 * exactly, including its `to >= from` refine. An export that filtered
 * differently from the list it was launched from would be worse than no
 * export at all: the user would reconcile against numbers they never saw.
 */

export const EXPORT_FORMATS = ["xlsx", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Parsed, validated filters, in the API's own naming. */
export type ExportFilters = {
  from?: string;
  to?: string;
  categoryId?: string;
  uploadedBy?: string;
  needsReview?: boolean;
};

/**
 * `needsReview` is the string "1" in the URL, because that is what the toggle
 * writes (`Filters.tsx`) and a URL is not a place to be clever about
 * booleans. Anything else — absent, "0", "false", "yes" — is false.
 *
 * Deliberately `z.string()` and not `z.literal("1")`: the client's own
 * `parseReceiptFilters` reads this as `value === "1"`, so a URL carrying
 * `needsReview=0` means "off" on the dashboard. A schema that REJECTED it
 * would make that same URL a 400 from the export button — the two halves of
 * one feature disagreeing about what a filter means, which is exactly the
 * drift `receiptFilters.ts` exists to prevent.
 */
const querySchema = z
  .object({
    format: z.enum(EXPORT_FORMATS),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    category: z.string().uuid().optional(),
    uploadedBy: z.string().uuid().optional(),
    needsReview: z.string().optional(),
  })
  .refine((v) => !v.from || !v.to || v.to >= v.from, {
    message: "End date must be on or after the start date.",
    path: ["to"],
  });

export type ParsedExportQuery = {
  format: ExportFormat;
  filters: ExportFilters;
};

export class ExportQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportQueryError";
  }
}

/**
 * Reads the five known parameters and ignores everything else. Ignoring
 * rather than rejecting is deliberate: a URL that has picked up a `utm_*` or
 * a stale param from an older build should still export, and the parameters
 * that DO reach the query are each independently validated, so nothing is
 * softened by being permissive about the ones that do not.
 *
 * Throws `ExportQueryError` with a message safe to return to the client —
 * it says only which parameter is malformed, never anything about the data.
 */
export function parseExportQuery(search: URLSearchParams): ParsedExportQuery {
  const raw = {
    format: search.get("format") ?? "xlsx",
    from: search.get("from") || undefined,
    to: search.get("to") || undefined,
    category: search.get("category") || undefined,
    uploadedBy: search.get("uploadedBy") || undefined,
    needsReview: search.get("needsReview") || undefined,
  };

  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join(".") || "query";
    throw new ExportQueryError(`Invalid export parameter: ${field}.`);
  }

  const { format, from, to, category, uploadedBy, needsReview } = parsed.data;
  // Mirrors the client's `value === "1"` exactly.
  const wantsReview = needsReview === "1";
  return {
    format,
    filters: {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(category ? { categoryId: category } : {}),
      ...(uploadedBy ? { uploadedBy } : {}),
      ...(wantsReview ? { needsReview: true } : {}),
    },
  };
}

/** Names for the filter values that are ids, resolved by the caller so this
 *  module stays free of database access. */
export type FilterLabels = {
  categoryName?: string | null;
  uploaderName?: string | null;
};

/**
 * The human-readable filter line written into the header block of sheet 1
 * and the CSV — the thing that makes an export reproducible six months later
 * (task 8.5). Ids are included alongside their resolved names because a
 * category can be renamed and the id is what actually reproduces the query.
 *
 * Deterministic in field order, which is what lets the "two exports of the
 * same filter differ only in the timestamp" test be an equality assertion.
 */
export function describeFilters(filters: ExportFilters, labels: FilterLabels = {}): string {
  const parts: string[] = [];

  if (filters.from && filters.to) parts.push(`dates ${filters.from} to ${filters.to}`);
  else if (filters.from) parts.push(`dates from ${filters.from}`);
  else if (filters.to) parts.push(`dates through ${filters.to}`);

  if (filters.categoryId) {
    parts.push(`category ${labels.categoryName ?? "(deleted)"} [${filters.categoryId}]`);
  }
  if (filters.uploadedBy) {
    parts.push(`uploaded by ${labels.uploaderName ?? "(unknown)"} [${filters.uploadedBy}]`);
  }
  if (filters.needsReview) parts.push("needs review only");

  return parts.length === 0 ? "none" : parts.join("; ");
}
