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

/**
 * `Content-Disposition` for a download.
 *
 * `attachment` by default: a browser rendering a CSV inline is not a useful
 * outcome for a file someone is about to open in Excel.
 *
 * `inline` exists for exactly one caller — an installed PWA that is going to
 * read the bytes itself and hand them to the OS (D-49). WebKit routes an
 * `attachment` response into its download machinery before the JavaScript that
 * asked for it can see it, so in a standalone app, where there is no download
 * UI to route it to, the `fetch` rejects outright. Asking for `inline` keeps
 * the response in the page, where the caller wanted it all along.
 *
 * The filename travels either way, so the client does not have to invent one
 * and the two dispositions cannot disagree about it.
 */
export function contentDisposition(
  filename: string,
  kind: "attachment" | "inline" = "attachment",
): string {
  return `${kind}; filename="${filename}"`;
}
