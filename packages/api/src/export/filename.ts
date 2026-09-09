import "server-only";

import { slugifyOr } from "@ledgerly/shared/slug";

import type { ExportFormat } from "./filters";

/**
 * packages/api/src/export/filename.ts — `<project-slug>_<YYYY-MM-DD>.<ext>`.
 *
 * The filename is interpolated into a `Content-Disposition` header, so it is
 * the one string in this feature where a project name reaches a protocol
 * that has its own quoting rules. It is safe because `slugifyOr` cannot emit
 * anything outside `[a-z0-9-]` and the date cannot be anything but digits and
 * dashes — header injection is unrepresentable rather than escaped, the same
 * property D-23 gives filesystem paths. `slug.test.ts` asserts it directly
 * against hostile names.
 */

export const CONTENT_TYPE: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

/**
 * The date is UTC, not the server's local day. A self-hosted instance and
 * the person reading the file are usually in the same timezone, but "usually"
 * is how two exports taken minutes apart end up claiming different dates —
 * and the header block already carries the exact instant.
 */
export function exportFilename(projectName: string, format: ExportFormat, at: Date): string {
  const slug = slugifyOr(projectName, "project");
  const date = at.toISOString().slice(0, 10);
  return `${slug}_${date}.${format}`;
}

/** `Content-Disposition` for a download. Always `attachment`: a browser
 *  rendering a CSV inline is not a useful outcome for a file someone is
 *  about to open in Excel. */
export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}
