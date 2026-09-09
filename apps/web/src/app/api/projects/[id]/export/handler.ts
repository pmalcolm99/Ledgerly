import { Readable } from "node:stream";

import { AuthError, isOnboarded, requireAuthRoute } from "@ledgerly/auth";
import { buildAccessDeniedResponse } from "@ledgerly/auth/response";
import {
  ExportError,
  ExportQueryError,
  parseExportQuery,
  startProjectExport,
} from "@ledgerly/api/export";
import { checkExportRateLimit } from "@ledgerly/api/rateLimit";
import type { RateLimitRedis } from "@ledgerly/api/rateLimit";
import type { Database } from "@ledgerly/db";

/**
 * apps/web/src/app/api/projects/[id]/export/handler.ts — the export download
 * (Phase 8, D-37).
 *
 * A Route Handler rather than a tRPC procedure, for the same reason the
 * upload is one: tRPC speaks JSON over superjson and cannot stream a binary
 * body. Route Handlers sit outside any layout or tRPC gate
 * (`packages/auth/src/identity.ts`'s `requireAuthRoute` doc comment), so this
 * file re-verifies identity itself and lets `packages/api`'s export module
 * compose `scopedProjects` — exactly what `protectedProcedure` does for a
 * tRPC caller.
 *
 * ## Failure shape
 *
 * Mirrors `api/images/[...key]/handler.ts`, which resolved this deliberately:
 * **403 for no valid identity at all** (the app-wide D-24 byte-identical
 * 403), **404 for a project the caller may not see**, indistinguishable from
 * one that does not exist. A 403 here would turn the endpoint into an
 * existence oracle for other people's project ids.
 *
 * 400 is reserved for a malformed request the caller can fix (a bad date, an
 * unknown format) — that is not an existence signal, since it is decided
 * before any lookup happens.
 *
 * ## Why nothing is cached
 *
 * `no-store`, and the service worker never intercepts `/api/*` anyway. An
 * export is a point-in-time snapshot of financial data under a filter; a
 * cached copy served to a later request would be both stale and a
 * cross-user disclosure risk on a shared device.
 *
 * ## Why a GET has a rate limit and an audit row
 *
 * This is a `GET`, so a third-party page can trigger it cross-site with the
 * Access cookie attached. Nothing reaches the attacker — no CORS headers, and
 * the response is an attachment — but it does cost a full project read and
 * writes an `export.generated` row. So: the rate limit below caps the damage,
 * and an `export.generated` row should be read as "an export was requested by
 * this identity", not as proof the user intended one (review finding L-4).
 */

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleExportGet(
  request: Request,
  projectId: string,
  deps: { db: Database; rateLimitRedis?: RateLimitRedis },
): Promise<Response> {
  const { db } = deps;

  let user;
  try {
    user = await requireAuthRoute(request);
  } catch (error) {
    if (error instanceof AuthError) return buildAccessDeniedResponse("no_identity");
    throw error;
  }

  // 404, not the app-wide 403 — see the module comment.
  if (!isOnboarded(user)) return plain(404, "Not found.");

  let parsed;
  try {
    parsed = parseExportQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof ExportQueryError) return plain(400, error.message);
    throw error;
  }

  // Before the project lookup, so a rate-limited caller learns nothing about
  // whether the project exists.
  if (deps.rateLimitRedis) {
    const limit = await checkExportRateLimit(deps.rateLimitRedis, user.id);
    if (!limit.allowed) {
      return new Response("Too many exports. Try again shortly.", {
        status: 429,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": String(limit.retryAfterSeconds),
        },
      });
    }
  }

  let started;
  try {
    started = await startProjectExport({
      db,
      user,
      projectId,
      format: parsed.format,
      filters: parsed.filters,
      // Aborted when the client goes away, which stops the paging loop rather
      // than leaving the detached writer holding a page of rows and a whole
      // workbook until the process restarts.
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof ExportError) return plain(error.status, error.message);
    throw error;
  }

  // No `content-length`: the workbook is generated as it is sent and its size
  // is genuinely unknown until the last byte. A wrong length would be worse
  // than none — the browser would truncate the file at it.
  return new Response(Readable.toWeb(started.stream) as ReadableStream, {
    status: 200,
    headers: {
      "content-type": started.contentType,
      "content-disposition": started.contentDisposition,
      // The filename is a slug and a date by construction
      // (`packages/shared/src/slug.ts`), so no project name can break out of
      // the quoted header value.
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
