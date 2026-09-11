/**
 * packages/shared/src/events.ts — the log event vocabulary.
 *
 * In `shared` rather than `api` because the Logs tab's filter chips need these
 * names in a CLIENT component, and `packages/api/src/events.ts` begins with
 * `import "server-only"` — importing it from the browser bundle throws at
 * build time. This is the same split `receiptFields.ts` and `receiptValidation.ts`
 * already make for exactly the same reason: the vocabulary is shared, the
 * writer is not.
 *
 * Kept in step with the `event_level` / `event_category` pg enums by
 * `packages/db/src/schema/enums.ts`; a mismatch is a failed insert, which is
 * loud.
 */

export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/**
 * Every value here has at least one emitter. `auth` was in the plan and is not
 * here, because both of its candidate events — a re-linked identity and an
 * identity conflict — are things a PERSON did and were already `audit_log`
 * rows; a second copy in `app_events` would be duplicate vocabulary and an
 * always-empty filter chip. Adding it back is a one-line migration on the day
 * an auth event exists that is not an audit row.
 */
export const EVENT_CATEGORIES = ["extraction", "email", "backup", "upload", "system"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];
