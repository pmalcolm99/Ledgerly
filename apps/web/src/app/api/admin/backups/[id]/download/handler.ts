import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { and, eq, isNull } from "drizzle-orm";
import { AuthError, isOnboarded, requireAuthRoute } from "@ledgerly/auth";
import { buildAccessDeniedResponse } from "@ledgerly/auth/response";
import type { Env } from "@ledgerly/config/env";
import { backups } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import { recordAudit } from "@ledgerly/api/audit";

/**
 * apps/web/src/app/api/admin/backups/[id]/download/handler.ts — streams a
 * finished backup archive to its owner (Phase 9, D-45).
 *
 * Split out of route.ts for the same reason every other handler in this app is:
 * Next's route type-checker rejects any named export from a `route.ts` besides
 * the recognised HTTP-method and config exports, so this could not be exported
 * from there for tests to call.
 *
 * A Route Handler rather than tRPC, because tRPC speaks JSON over superjson and
 * cannot stream a binary body — the same reason upload, image serving and
 * export are Route Handlers.
 *
 * ## Why this is a download of an existing file, not a backup being made
 *
 * The archive is produced by the `backup` queue and finalised on the volume
 * before anything can be downloaded (D-45: the manifest checksums the dump, so
 * the dump has to exist before the archive can be described). That makes this
 * the *images* handler's shape rather than the *export* handler's: the artefact
 * has a known size, so it sends `content-length`, and a client that disconnects
 * halfway costs nothing — the backup is still on disk and still downloadable.
 *
 * ## Failure shape
 *
 * **403 for no valid identity at all**, matching the app-wide D-24 convention.
 * **404 for everything else** — not onboarded, not the instance owner, no such
 * backup, a soft-deleted one, a row with no artefact, or a file that has since
 * been pruned. A non-owner must not be able to learn from this endpoint how
 * many backups exist or when they ran, so "you are not the owner" and "there is
 * no such backup" are deliberately the same response.
 */

function notFound(): Response {
  return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
}

/** `route.ts`'s `GET` binds this to the real `getDb()`/`getEnv()`; the logic
 *  lives here against injected deps so tests can point it at the test database
 *  and a temp `BACKUPS_DIR` (D-18). */
export async function handleBackupDownload(
  request: Request,
  id: string,
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

  if (!isOnboarded(user)) return notFound();
  // The only authorization this endpoint has, and it is deliberately the same
  // gate `ownerProcedure` applies to every other procedure on the admin
  // screen. A backup archive is the entire database: there is no partial
  // read of it to scope to a project membership.
  if (user.role !== "owner") return notFound();

  // A malformed id must not reach the query as a cast error — `backups.id` is
  // uuid-typed and pg rejects a non-uuid with a 22P02 that would surface as a
  // 500 rather than the 404 this endpoint owes.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return notFound();
  }

  const [row] = await db
    .select({
      id: backups.id,
      path: backups.path,
      sizeBytes: backups.sizeBytes,
      status: backups.status,
    })
    .from(backups)
    .where(and(eq(backups.id, id), isNull(backups.deletedAt)))
    .limit(1);
  // `path` is never returned to a client by any procedure (see `admin.backups`)
  // — this is the only place it is read, and it is read from the row rather
  // than taken from the request.
  if (!row?.path || row.status !== "complete") return notFound();

  // Defence in depth, not input validation: `path` is written by
  // `pipeline/backup.ts` from `BACKUPS_DIR` and never from anything a user
  // supplies. It is asserted anyway because the cost is one `realpath` and the
  // failure it would catch — a row edited in the database, or a symlink planted
  // in the backups volume — is "stream any file the process can read".
  let resolved: string;
  try {
    resolved = await fs.realpath(row.path);
    const root = await fs.realpath(env.BACKUPS_DIR);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      console.error(`[ledgerly] refusing to serve backup ${row.id}: path escapes BACKUPS_DIR`);
      return notFound();
    }
  } catch {
    // The row claims a file that is gone. Retention unlinks before it
    // soft-deletes precisely so this state is visible rather than the reverse
    // (pipeline/backup.ts's `pruneBackups`), and 404 is the honest answer.
    return notFound();
  }

  let size: number;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return notFound();
    // The row's `size_bytes` is what the job recorded; this is what is on disk
    // now. Trust the disk — a wrong `content-length` makes the browser truncate
    // the file at it, which would produce a corrupt archive that looks fine.
    size = stat.size;
  } catch {
    return notFound();
  }

  // Before the first byte, in its own transaction: the download itself writes
  // nothing, and `recordAudit`'s contract is that it shares the transaction of
  // the write it documents — here there is none. Same reasoning as
  // `startProjectExport`.
  await db.transaction(async (tx) => {
    await recordAudit(tx, {
      actorUserId: user.id,
      action: "backup.downloaded",
      entityType: "backup",
      entityId: row.id,
      // No path. The whole point of keeping it out of `admin.backups` is that a
      // host filesystem path is infrastructure detail; an append-only log that
      // records it is the same disclosure with a longer half-life.
      metadata: { via: "api.admin.backups.download", sizeBytes: size },
    });
  });

  const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream;

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(size),
      // The basename is generated by `archiveBasename` from a timestamp — no
      // user-supplied text reaches this header, so there is nothing to escape.
      "content-disposition": `attachment; filename="${path.basename(resolved)}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
