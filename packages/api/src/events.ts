import "server-only";

import { appEvents } from "@ledgerly/db/schema";
import { getEnv } from "@ledgerly/config/env";
import type { Database } from "@ledgerly/db";
import { scrubLuhnSequences } from "@ledgerly/shared/scrub";
import type { EventCategory, EventLevel } from "@ledgerly/shared/events";

/**
 * packages/api/src/events.ts — the one place `app_events` is inserted into
 * (D-46). `audit.ts`'s sibling, and deliberately its opposite in two ways.
 *
 * ## Why this exists
 *
 * Diagnosing the automatic receipt email took two rounds and eventually
 * reading container logs over someone's shoulder, because the only record
 * that an email was skipped, failed, or never queued was a `console.error`.
 * `emailWorker.ts` said so outright: *"No database write … the log is the
 * whole record of it."* That reasoning was right about not marking the
 * receipt and wrong about there being nowhere else to put it.
 *
 * ## The two inversions of `recordAudit`
 *
 * **1. A `Database`, never a `Tx`.** `recordAudit` must share the transaction
 * of the write it documents. An event must not be in one at all: an
 * "extraction failed" row written inside the transaction that then rolls back
 * vanishes along with the failure it exists to describe.
 *
 * **2. It cannot throw.** Every insert is wrapped and a failure is swallowed
 * to `console.error`. A job that has already spent money on an Anthropic call
 * must not be failed by a logging insert — that would be the D-44 lesson
 * (never put a notification in the retry path of a job that costs money)
 * repeated with a different dependency. Callers therefore never need to
 * `await` this defensively or wrap it themselves.
 *
 * ## What may go in `metadata`
 *
 * `audit.ts`'s policy applies unchanged: ids, never addresses, never secrets,
 * never model output or receipt images. An email's recipient is a `toUserId`;
 * the Logs UI resolves the address by join at read time. D-44's "the recipient
 * is a user id, never an address" holds here too — a log is a worse place to
 * park PII than a mutation is, because it is kept for its own sake.
 */

/** Re-exported so server callers have one import, but DEFINED in
 *  `packages/shared` — this file is `server-only`, and the Logs tab's filter
 *  chips are a client component. */
export {
  EVENT_CATEGORIES,
  EVENT_LEVELS,
  type EventCategory,
  type EventLevel,
} from "@ledgerly/shared/events";

export type AppEventEntry = {
  level: EventLevel;
  category: EventCategory;
  /** A stable code, `"<area>.<past_tense_verb>"` — `"email.skipped"`. Matched
   *  on by the UI's label table, so it is an identifier, not a sentence. */
  event: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Everything stored in `metadata`, made safe to put in front of a browser.
 *
 * Several callers store a raw `error.message` — an unclassified extraction
 * failure, a failed backup, a rejected enqueue — because for those the reason
 * code says nothing and the underlying text is the whole diagnosis. That text
 * is not ours: a pg error quotes the row that violated a constraint, and a
 * filesystem error quotes an absolute path.
 *
 * Two passes, applied centrally so no call site has to remember:
 *
 *  - **Luhn scrub**, the same one the extraction pipeline uses before it
 *    persists model output. `scrubLuhnSequences` walks objects and arrays, so
 *    the whole metadata blob goes through it, not just the fields that happen
 *    to be named `error` today.
 *  - **Directory redaction.** `UPLOADS_DIR` and `BACKUPS_DIR` are host paths
 *    this app deliberately keeps out of client-visible surfaces —
 *    `admin.backups` withholds `backups.path` for exactly this reason, and it
 *    would be strange to withhold it there and then leak it through an ENOENT
 *    message here.
 */
function safeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubLuhnSequences(metadata).scrubbed;
  let env: { UPLOADS_DIR: string; BACKUPS_DIR: string };
  try {
    env = getEnv();
  } catch {
    // No parsed config (a test, a misconfigured boot). The Luhn scrub above
    // still applied; path redaction is the part that needs the config.
    return scrubbed;
  }
  // Recursive, to match `scrubLuhnSequences` beside it. No emitter nests its
  // metadata today, so a shallow pass leaks nothing yet — which is exactly what
  // makes the asymmetry a trap: the next emitter to add a nested object would
  // get the card scrub and silently not the path redaction.
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value
        .split(env.UPLOADS_DIR)
        .join("<uploads>")
        .split(env.BACKUPS_DIR)
        .join("<backups>");
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    }
    return value;
  };
  return redact(scrubbed) as Record<string, unknown>;
}

/**
 * Which build produced a log line is the first question anyone asks of one,
 * and it was the question that cost real time this session. Stamped onto
 * every row rather than left to each call site to remember.
 *
 * Read from `process.env` here rather than from `apps/web`'s inlined
 * constants, because this package is also reached from the worker process,
 * where Next's build-time substitution does not apply. `APP_GIT_SHA` is set on
 * the runner image by `docker/Dockerfile`.
 */
function buildStamp(): Record<string, string> {
  const sha = process.env.APP_GIT_SHA;
  return sha ? { appGitSha: sha.slice(0, 7) } : {};
}

/**
 * Writes exactly one `app_events` row, and never fails the caller.
 *
 * Not `await`-critical: callers may `void` it. It is still `async` so a caller
 * that does want to order a read after it can.
 */
export async function recordEvent(db: Database, entry: AppEventEntry): Promise<void> {
  try {
    await db.insert(appEvents).values({
      level: entry.level,
      category: entry.category,
      event: entry.event,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: safeMetadata({ ...buildStamp(), ...(entry.metadata ?? {}) }),
    });
  } catch (error) {
    // The one place in this file that can be reached by a failure, and it must
    // stop here. If the log cannot be written, the log line about not being
    // able to write the log is genuinely all there is.
    console.error(`[ledgerly] could not record event ${entry.event}:`, error);
  }
}
