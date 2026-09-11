import "server-only";

import { auditLog } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";

/**
 * packages/api/src/audit.ts — the one place `audit_log` is inserted into
 * (task 4.7). Generalizes the pattern `routers/admin.ts`'s `relinkAccount`
 * wrote inline before this file existed; new call sites should use
 * `recordAudit`, not a fresh `tx.insert(auditLog).values({...})`.
 *
 * `docs/SCHEMA.md` §audit_log: append-only, `actor_user_id`, `action`,
 * `entity_type`, `entity_id`, `metadata` jsonb, `created_at`. `action` and
 * `entity_type` are free-text by design — a typo costs a mislabelled log
 * line, not a failed migration.
 */

/** The transaction type `ctx.db.transaction(async (tx) => ...)` hands its
 * callback — derived structurally so this file never needs to import a
 * drizzle-orm internal type directly. Exported for other modules (e.g.
 * `routers/members.ts`'s `loadManageContext`) that need to type a `tx`
 * parameter of their own rather than inlining a second copy of this. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AuditEntry = {
  actorUserId: string;
  /** `"<entity>.<past_tense_verb>"`, e.g. `"project.archived"`. */
  action: string;
  entityType: string;
  entityId: string | null;
  /** Free-form context for reconstructing what happened. Never receipt
   * images, model output, or secrets (`docs/SCHEMA.md`) — and, per the
   * existing `user.sub_relinked` precedent, no email or other PII beyond
   * ids: the audit row names the identity, not the person.
   *
   * **Now load-bearing for display, not only for storage.** Since D-46 the
   * Logs tab returns `audit_log.metadata` to the owner's browser verbatim, and
   * unlike `app_events` there is no `safeMetadata()` between this object and
   * that screen — `recordAudit` writes inside the caller's transaction and has
   * no scrubbing pass of its own. What goes in here is what is rendered. */
  metadata?: Record<string, unknown>;
};

/**
 * Writes exactly one `audit_log` row. Must be called with the SAME `tx` as
 * the mutating write it documents — never a separate transaction, or a
 * crash between the two leaves an audit row with no matching effect, or a
 * real effect with no audit row. Task 4.7's acceptance criterion ("each
 * audited action produces exactly one row") depends on this discipline at
 * every call site, not on anything this function itself can enforce.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata ?? {},
  });
}
