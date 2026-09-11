import { and, eq, inArray } from "drizzle-orm";
import { AuthError, isOnboarded, requireAuthRoute } from "@ledgerly/auth";
import { buildAccessDeniedResponse } from "@ledgerly/auth/response";
import type { Env } from "@ledgerly/config/env";
import { projects, receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import { recordEvent } from "@ledgerly/api/events";
import { checkUploadRateLimit } from "@ledgerly/api/rateLimit";
import { scopedProjects } from "@ledgerly/api/scope";
import { receiptFilePath, writeReceiptFile } from "@ledgerly/api/storage";
import {
  exceedsMegapixelCap,
  probeImageDimensions,
  probePdfPageDimensionsAtDpi,
} from "@ledgerly/queue/pipeline/render";
import { getReceiptIngestQueue } from "@ledgerly/queue/queue";
import { getRedisConnection } from "@ledgerly/queue/redis";
import { sniffFileType } from "@ledgerly/shared/fileSniff";

/**
 * apps/web/src/app/api/receipts/upload/handler.ts — the upload endpoint's
 * actual logic (task 5.1, ARCHITECTURE.md §5).
 *
 * Split out of route.ts because Next.js's route type-checker rejects any
 * named export from a route.ts file besides the recognized HTTP-method/
 * config exports -- `handleUpload` can't live there once it needs to be
 * exported for tests to call directly.
 *
 * A Route Handler, not a tRPC procedure -- it streams multipart bytes, and
 * `request.formData()` is how Next.js 15 parses that natively (no external
 * multipart library). Route Handlers sit outside any layout/tRPC gate
 * (packages/auth/src/identity.ts's `requireAuthRoute` doc comment), so
 * this file independently re-verifies identity and composes
 * `scopedProjects` itself, exactly like `protectedProcedure` does for tRPC
 * callers.
 *
 * Guard order per file, all BEFORE any image/PDF decode (task 5.2):
 * size -> magic-byte sniff -> megapixel/PDF-page-size. A file that fails
 * any guard never gets a receipt row at all -- only files that pass every
 * guard are persisted and enqueued. One bad file in a batch is rejected
 * individually; the rest still upload (a 40-photo camera-roll import
 * shouldn't be voided by one corrupt photo).
 *
 * The `MAX_UPLOAD_BYTES` guard rejects a single oversized FILE before any
 * decode, but `request.formData()` itself must buffer the entire request
 * BODY first — Next.js Route Handlers have no built-in cap on that. Review
 * finding H-1: an unbounded body (or an unbounded file count) is a DoS
 * surface the per-file guard alone doesn't close. Two guards run before
 * `formData()` is ever called: a `Content-Length` ceiling
 * (`MAX_UPLOAD_BYTES * MAX_FILES_PER_BATCH`, generous but finite) and — as
 * soon as it's parsed — a hard `MAX_FILES_PER_BATCH` cap on file count.
 *
 * `route.ts`'s `POST` is a thin binding onto real `getDb()`/`getEnv()`;
 * `handleUpload` here carries the actual logic against injected `db`/
 * `env`, so tests can point it at the test database and test Redis (D-18
 * -- tests must never touch `DATABASE_URL`/the real `REDIS_URL`) without
 * needing to mutate process env vars or reach for module mocking.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generous enough for the brief's own "40-photo camera roll" scenario with
// headroom, small enough to bound worst-case per-request work. Not an env
// var -- this is a request-shape sanity bound, not an operator tuning knob.
const MAX_FILES_PER_BATCH = 60;

type FileResult =
  | { filename: string; ok: true; receiptId: string }
  | { filename: string; ok: false; error: string };

export async function handleUpload(
  request: Request,
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

  if (!isOnboarded(user)) {
    return Response.json({ error: "onboarding_required" }, { status: 403 });
  }

  // H-1: reject an oversized BODY before `formData()` buffers all of it.
  // A generous ceiling (not a precise per-file check -- multipart framing
  // overhead means this is only ever a loose upper bound) that still turns
  // an unbounded-size request into a cheap, immediate rejection.
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(contentLength) &&
    contentLength > env.MAX_UPLOAD_BYTES * MAX_FILES_PER_BATCH
  ) {
    return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "invalid_multipart_body" }, { status: 400 });
  }

  const projectId = formData.get("projectId");
  if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) {
    return Response.json({ error: "projectId_required" }, { status: 400 });
  }

  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "no_files" }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_BATCH) {
    return Response.json({ error: "TOO_MANY_FILES" }, { status: 413 });
  }

  // Authorization: read_add ("add") or higher. A plain unlocked scope
  // check -- nothing here mutates the `projects` row itself, only inserts
  // into `receipts`, so `lockScopedProject` isn't needed (see its own doc
  // comment on when a lock is required). Not-found and not-authorized are
  // indistinguishable, both a 404 -- same convention as every other
  // project-scoped read in this app.
  const [authorized] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), inArray(projects.id, scopedProjects(user, "add"))))
    .limit(1);
  if (!authorized) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Per-user upload rate limit -- whole-batch cost, atomic (rateLimit.ts).
  // A batch whose own file count exceeds the per-minute limit can never be
  // admitted no matter how long the caller waits -- that's a permanent
  // rejection (413), not a transient one (429).
  if (files.length > env.UPLOAD_RATE_LIMIT_PER_MIN) {
    return Response.json({ error: "BATCH_EXCEEDS_RATE_LIMIT" }, { status: 413 });
  }
  const redis = getRedisConnection(env.REDIS_URL);
  const rateLimit = await checkUploadRateLimit(
    redis,
    user.id,
    files.length,
    env.UPLOAD_RATE_LIMIT_PER_MIN,
  );
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rateLimit.retryAfterSeconds) } },
    );
  }

  // Sequential, not `Promise.all` -- review findings H-1/H-2: unbounded
  // concurrent decodes of every file in a batch is its own resource
  // spike, and `Promise.all` rejecting on the FIRST error would lose the
  // per-file results (and receipt ids) of every file that already
  // succeeded. `processOneFile` itself never throws (it catches and
  // reports `ok:false` for anything that goes wrong past the guard
  // stage), so this loop can't be aborted by one bad file either way.
  const results: FileResult[] = [];
  for (const file of files) {
    results.push(await processOneFile(file, { db, env, projectId, userId: user.id }));
  }

  return Response.json({ results }, { status: 200 });
}

async function processOneFile(
  file: File,
  ctx: { db: Database; env: Env; projectId: string; userId: string },
): Promise<FileResult> {
  const filename = file.name || "unnamed";

  // Size, before the arrayBuffer() copy -- `File.size` is already known
  // from formData()'s own multipart parsing, so this check costs nothing
  // extra and skips allocating+copying an oversized file's bytes at all.
  if (file.size > ctx.env.MAX_UPLOAD_BYTES) {
    return { filename, ok: false, error: "FILE_TOO_LARGE" };
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Magic-byte sniff -- authoritative. The client's Content-Type and this
  // filename are never consulted anywhere in this guard chain.
  const sniffedType = sniffFileType(bytes);
  if (!sniffedType) {
    return { filename, ok: false, error: "UNRECOGNIZED_OR_MISLABELED_TYPE" };
  }

  // Megapixel guard -- header-only, before any decode (task 5.2).
  if (sniffedType === "pdf") {
    const probe = await probePdfPageDimensionsAtDpi(bytes);
    if (probe.ok) {
      if (exceedsMegapixelCap(probe.dimensions, ctx.env.MAX_UPLOAD_MEGAPIXELS)) {
        return { filename, ok: false, error: "PDF_PAGE_TOO_LARGE" };
      }
    } else if (probe.reason !== "unavailable") {
      // "unavailable" (pdfinfo missing, dev-only) skips the guard, already
      // logged inside probePdfPageDimensionsAtDpi. A definitive parse
      // failure against a file that already passed the "%PDF-" magic-byte
      // check means the PDF itself is malformed -- reject rather than
      // hand it to the ingest worker to fail later.
      return { filename, ok: false, error: "PDF_UNREADABLE" };
    }
  } else {
    const dimensions = await probeImageDimensions(bytes);
    if (!dimensions) {
      return { filename, ok: false, error: "UNRECOGNIZED_OR_MISLABELED_TYPE" };
    }
    if (exceedsMegapixelCap(dimensions, ctx.env.MAX_UPLOAD_MEGAPIXELS)) {
      return { filename, ok: false, error: "IMAGE_TOO_LARGE_MEGAPIXELS" };
    }
  }

  // Every guard passed -- persist. Only files that reach this point ever
  // get a receipt row. H-2: everything from here on is wrapped so a
  // failure never throws out of this function (which would abort the
  // whole batch's response) -- it degrades to `ok:false` for this one
  // file, and if a row already exists by the time something fails, that
  // row is marked `failed` rather than left permanently `pending` with no
  // record of what happened (CLAUDE.md: never silently drop an upload).
  let receiptId: string | undefined;
  try {
    const [row] = await ctx.db
      .insert(receipts)
      .values({ projectId: ctx.projectId, uploadedBy: ctx.userId, extractionStatus: "pending" })
      .returning({ id: receipts.id });
    if (!row) return { filename, ok: false, error: "INTERNAL_ERROR" };
    receiptId = row.id;

    // Staged extension-less ("staging.bin") -- the ingest worker re-sniffs
    // the bytes itself rather than trusting job data to survive a retry.
    await writeReceiptFile(
      receiptFilePath(ctx.env.UPLOADS_DIR, ctx.projectId, row.id, "staging", "bin"),
      bytes,
    );
    // jobId: row.id -- if this same request is somehow retried at a layer
    // above this handler, re-adding the job is a no-op rather than a
    // second concurrent processor for the same receipt.
    await getReceiptIngestQueue(ctx.env.REDIS_URL).add(
      "ingest",
      { receiptId: row.id },
      { jobId: row.id },
    );

    return { filename, ok: true, receiptId: row.id };
  } catch (error) {
    console.error(`[ledgerly] upload persistence failed for "${filename}":`, error);
    // The upload half of D-46. The caller is told only "INTERNAL_ERROR" — an
    // upload response is not the place to explain a disk or Redis failure — so
    // without this row the reason exists nowhere the owner can reach. The
    // filename is the user's own and is what makes the row identifiable; the
    // raw message is scrubbed centrally by `recordEvent`.
    await recordEvent(ctx.db, {
      level: "error",
      category: "upload",
      event: "upload.persist_failed",
      entityType: "receipt",
      entityId: receiptId,
      metadata: { filename, error: error instanceof Error ? error.message : String(error) },
    });
    if (receiptId) {
      // The row exists (insert succeeded) but staging or enqueue failed --
      // record that rather than leaving a `pending` row with no job and
      // no error, which would sit forever with no operator-visible signal.
      await ctx.db
        .update(receipts)
        .set({ extractionStatus: "failed", extractionError: "UPLOAD_PERSISTENCE_FAILED" })
        .where(eq(receipts.id, receiptId))
        .catch(async (updateError: unknown) => {
          console.error(`[ledgerly] failed to mark receipt ${receiptId} failed:`, updateError);
          // The worse of the two failures: the receipt is now stuck as
          // `pending` with no job behind it, which looks to the user like an
          // upload that is simply taking a while and will never finish.
          await recordEvent(ctx.db, {
            level: "error",
            category: "upload",
            event: "upload.status_write_failed",
            entityType: "receipt",
            entityId: receiptId,
            metadata: {
              error: updateError instanceof Error ? updateError.message : String(updateError),
            },
          });
        });
    }
    return { filename, ok: false, error: "INTERNAL_ERROR" };
  }
}
