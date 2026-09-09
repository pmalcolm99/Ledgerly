import "server-only";

import { PassThrough } from "node:stream";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { categories, projects, users } from "@ledgerly/db/schema";
import { displayNameOf } from "@ledgerly/shared/personName";
import type { AuthUser } from "@ledgerly/auth";
import type { Database } from "@ledgerly/db";

import { recordAudit } from "../audit";
import { auditOwnerOverrideIfApplicable } from "../routers/projects";
import { scopedProjects } from "../scope";
import { writeCsv } from "./csv";
import { CONTENT_TYPE, contentDisposition, exportFilename } from "./filename";
import { MAX_EXPORT_RECEIPTS, exportPreflight } from "./query";
import { buildExportSource } from "./source";
import { writeWorkbook } from "./workbook";
import type { ExportFilters, ExportFormat } from "./filters";

export * from "./filters";
export { MAX_EXPORT_RECEIPTS, EXPORT_BATCH_SIZE } from "./query";
export { LINE_ITEM_COLUMNS, RECEIPT_COLUMNS, RECEIPT_GRAIN_HEADERS } from "./rows";
export { SHEET_LINE_ITEMS, SHEET_RECEIPTS, SHEET_SUMMARY } from "./workbook";
export { exportFilename, contentDisposition, CONTENT_TYPE } from "./filename";
export { UTF8_BOM } from "./csv";
export { buildExportSource } from "./source";
export { writeCsv } from "./csv";
export { writeWorkbook } from "./workbook";

/**
 * packages/api/src/export/index.ts — the one entry point.
 *
 * Lives in `packages/api`, not `packages/queue/src/pipeline/export.ts` as
 * `docs/PHASES.md` 8.1 names it. There is no export queue job (D-37): the
 * export streams from a Route Handler, `apps/web` cannot import
 * `@ledgerly/queue` outside `instrumentation.ts`, and `queue` already depends
 * on `api`, so `api` is the only package this can live in.
 *
 * Framework-agnostic on purpose. It hands back a Node `Readable` plus the
 * headers a download needs; `apps/web` turns that into a `Response`. That
 * keeps every decision in this file testable without a `Request`.
 */

/** Failures a caller is expected to turn into an HTTP status. Every message
 *  here is safe to return verbatim — none of them says anything about data
 *  the caller could not already see. */
export class ExportError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ExportError";
    this.status = status;
  }
}

export type StartExportInput = {
  db: Database;
  user: AuthUser;
  projectId: string;
  format: ExportFormat;
  filters: ExportFilters;
  /** Injectable so the reproducibility test can hold it fixed. */
  now?: Date;
  batchSize?: number;
  /** The request's abort signal, threaded into the paging loop. See
   *  `source.ts` — `stream.destroyed` covers a cancelled read, this covers a
   *  reader that stalls without disconnecting. */
  signal?: AbortSignal;
};

export type StartedExport = {
  stream: PassThrough;
  filename: string;
  contentType: string;
  contentDisposition: string;
  receiptCount: number;
};

/**
 * Authorizes, audits, and begins streaming an export.
 *
 * Returns as soon as the first bytes are on their way — the writer runs
 * detached, feeding the returned stream. That is what makes this a stream
 * rather than a buffer, and it is why every failure that a caller could
 * plausibly need to render as a status code has to happen BEFORE this
 * returns: once the response is committed, the only honest way to report a
 * failure is to destroy the stream, which reaches the user as a truncated
 * download rather than an error page.
 */
export async function startProjectExport(input: StartExportInput): Promise<StartedExport> {
  const { db, user, projectId, format, filters } = input;
  const exportedAt = input.now ?? new Date();

  // Authorization is `scopedProjects(user, "read")` composed into the lookup
  // itself. "read" deliberately includes archived projects (scope.ts) — an
  // archived project is exactly the one someone exports for their taxes.
  //
  // A project the caller may not see is indistinguishable from one that does
  // not exist: `NOT_FOUND`, never `FORBIDDEN`, so this is not an existence
  // oracle for other people's projects.
  const [project] = await db
    .select({ id: projects.id, name: projects.name, ownerId: projects.ownerId })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        isNull(projects.deletedAt),
        inArray(projects.id, scopedProjects(user, "read")),
      ),
    )
    .limit(1);
  if (!project) throw new ExportError(404, "Not found.");

  const { receiptCount, currencies } = await exportPreflight(db, user, projectId, filters);
  if (receiptCount > MAX_EXPORT_RECEIPTS) {
    throw new ExportError(
      413,
      `This export covers ${receiptCount} receipts, above the ${MAX_EXPORT_RECEIPTS} limit. Narrow the date range and try again.`,
    );
  }

  const filterLabels = await resolveFilterLabels(db, filters);

  // Audited BEFORE a byte leaves. An export is data leaving the system
  // (`docs/SCHEMA.md`'s audit bullet names exports explicitly), and a stream
  // that fails halfway has still disclosed whatever it already sent — so the
  // log entry cannot be conditional on the stream completing.
  //
  // Its own transaction, because the export itself writes nothing and
  // `recordAudit`'s contract is that it shares the transaction of the write
  // it documents. Here there is none.
  await db.transaction(async (tx) => {
    await recordAudit(tx, {
      actorUserId: user.id,
      action: "export.generated",
      entityType: "project",
      entityId: project.id,
      // Ids, dates and a format — no email, no display name, no merchant.
      // `audit.ts` is explicit that a row names the identity, not the person.
      metadata: { format, filters, via: "api.projects.export" },
    });
    await auditOwnerOverrideIfApplicable(
      tx,
      user,
      project,
      "export.generated",
      "api.projects.export",
    );
  });

  const source = buildExportSource({
    db,
    user,
    projectId,
    projectName: project.name,
    filters,
    filterLabels,
    currencies,
    exportedAt,
    // `email: null`, like `resolveFilterLabels` below and `rows.ts`'s
    // `uploaderName`. `displayNameOf` falls back to the address, and
    // `display_name` is nullable for everyone — so without this the header
    // line carries the exporter's own address into a file that gets forwarded
    // to an accountant. Three call sites, one policy: this export names
    // identities, never addresses.
    exportedBy: displayNameOf({ ...user, email: null }),
    ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const stream = new PassThrough();
  // A `PassThrough` with no `error` listener turns `destroy(error)` into an
  // unhandled `'error'` event, which Node treats as an uncaught exception and
  // exits on. That is reachable: `writeWorkbook` is async, so its body runs
  // synchronously as far as its first `await` (constructing the writer, the
  // header block, the first row commits), and a throw in that prologue reaches
  // the catch below BEFORE this function has returned — i.e. before any
  // consumer exists to receive the error. The real failure is already reported
  // by the `console.error` below and by the truncated transfer; this listener
  // exists only so the emit is handled.
  stream.on("error", () => {});

  // Detached on purpose: awaiting it here would buffer the entire workbook
  // before the response headers were even sent. `destroy(error)` is the only
  // failure channel left once the body has started, and it surfaces to the
  // client as a truncated transfer — which is the correct outcome, because a
  // silently short spreadsheet of tax data is far worse than a failed one.
  void (async () => {
    try {
      if (format === "csv") await writeCsv(stream, source);
      else await writeWorkbook({ stream, source });
      // Both writers return early when the consumer has gone away, and
      // `end()` on a destroyed stream raises ERR_STREAM_DESTROYED — an
      // unhandled rejection out of a detached task, for the entirely normal
      // event of a user cancelling a download.
      if (!stream.destroyed) stream.end();
    } catch (error) {
      console.error(`[ledgerly] export failed for project ${project.id}:`, error);
      stream.destroy(error instanceof Error ? error : new Error("export failed"));
    }
  })();

  const filename = exportFilename(project.name, format, exportedAt);

  return {
    stream,
    filename,
    contentType: CONTENT_TYPE[format],
    contentDisposition: contentDisposition(filename),
    receiptCount,
  };
}

/**
 * Resolves the two id-valued filters to names for the header block.
 *
 * Neither lookup is an authorization decision — categories are instance-wide
 * (D-20) and the user directory is already readable (D-33), and both ids came
 * back through a filter that has already been applied under the caller's own
 * scope. A missing row is a label, not an error: a category deleted after the
 * filter was set still has to render as something.
 */
async function resolveFilterLabels(
  db: Database,
  filters: ExportFilters,
): Promise<{ categoryName?: string | null; uploaderName?: string | null }> {
  const labels: { categoryName?: string | null; uploaderName?: string | null } = {};

  if (filters.categoryId) {
    const [row] = await db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.id, filters.categoryId))
      .limit(1);
    labels.categoryName = row?.name ?? null;
  }

  if (filters.uploadedBy) {
    const [row] = await db
      .select({
        displayName: users.displayName,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.id, filters.uploadedBy))
      .limit(1);
    // Deliberately no `email` in the fallback chain: this string is written
    // into a file that gets emailed to an accountant, and a filter on a
    // colleague should not disclose their address.
    labels.uploaderName = row ? displayNameOf({ ...row, email: null }) : null;
  }

  return labels;
}
