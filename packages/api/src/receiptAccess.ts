import "server-only";

import { and, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { projectMembers, projects, receiptItems, receipts, users } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";
import { runSanityChecks } from "@ledgerly/shared/receiptValidation";

import type { Tx } from "./audit";
import { lockScopedProject, scopedProjects } from "./scope";

/**
 * packages/api/src/receiptAccess.ts — the receipt authorization spine
 * (Phase 7).
 *
 * `receipts.delete` and `receipts.reextract` each carried a verbatim copy of
 * the same ~35-line gate. Phase 7 adds six more mutations that need exactly
 * that gate, and copy number eight is where one of them gets it subtly wrong.
 * This is the same extraction `routers/members.ts` already made for its own
 * three mutations (`loadManageContext`).
 *
 * Nothing here is a new policy. It is the existing policy, written once.
 */

/**
 * The needs-review predicate, defined ONCE.
 *
 * Two things depend on this being a single definition. First, correctness:
 * `extraction_status` is `'partial'` if and only if `validation_flags` is
 * non-empty, so a receipt with unread fields but clean arithmetic is still
 * `'ok'` — checking status alone silently misses the largest bucket in the
 * queue. Second, the planner: `receipts_needs_review_idx` is a PARTIAL index,
 * and Postgres only uses one when the query's WHERE clause implies the index
 * predicate. Any call site that rephrases this — even equivalently — risks
 * dropping to a sequential scan with nothing failing to announce it.
 *
 * Five call sites share it: `receipts.reviewQueue`, `receipts.list`'s
 * `needsReview` filter, `projects.list`, `projects.stats`, `admin.overview`.
 */
/**
 * The merchant-name search, as ONE predicate shared by `receipts.list` and the
 * export (D-47).
 *
 * Shared for the same reason `NEEDS_REVIEW_SQL` is: `export/filters.ts` states
 * the invariant that an export's filter semantics mirror the list's exactly,
 * and two copies of a LIKE pattern is precisely how that stops being true —
 * quietly, in whichever one was not updated.
 *
 * `%` and `_` are escaped because a person typing either into a search box
 * means the character, not the operator: unescaped, a search for "50%" matches
 * every receipt in the project.
 */
export function merchantMatchesSql(query: string) {
  const escaped = query.replace(/[\\%_]/g, (match) => `\\${match}`);
  return ilike(receipts.merchantName, `%${escaped}%`);
}

export const NEEDS_REVIEW_SQL = sql`(${receipts.missingFields} <> '{}' OR ${receipts.extractionStatus} <> 'ok')`;

/**
 * The permission matrix (docs/SCHEMA.md §Permission matrix) as a SQL
 * expression, for **display only**.
 *
 *   manage scope (floor `full`)          -> may edit any receipt
 *   add scope (floor `read_add`) + own   -> may edit their own
 *
 * Expressed as scope composition rather than a hand-rolled membership read,
 * so it cannot drift from `scopedProjects`. It gives `list`/`get`/
 * `reviewQueue` a per-row `canEdit` for the price of nothing — no extra
 * query, no N+1.
 *
 * THIS MUST NEVER BE THE ENFORCEMENT. It cannot do the in-transaction role
 * re-read that `loadEditableReceipt` does, so it is judged against a role
 * resolved from the JWT at request entry. It decides whether to render a
 * button; `loadEditableReceipt` decides whether the button works.
 */
export function canEditSql(user: AuthUser) {
  // Mirrors `loadEditableReceipt` + `assertMayEditReceipt` exactly:
  //
  //   the project is reachable at "add"          (the gate the mutation uses)
  //   AND ( reachable at "manage"                (floor `full`, plus either owner)
  //         OR the caller uploaded this receipt ) (the "own only" cell)
  //
  // The outer "add" is load-bearing and was the bug: `scopedProjects` EXCLUDES
  // archived projects at "add" and INCLUDES them at "manage" (scope.ts). A
  // bare "manage" branch therefore reported `canEdit: true` for receipts in an
  // archived project, so the UI rendered the full editing surface and every
  // save returned NOT_FOUND — which reads as "this receipt does not exist"
  // rather than "this project is archived".
  return sql<boolean>`(
    ${receipts.projectId} in ${scopedProjects(user, "add")}
    and (
      ${receipts.projectId} in ${scopedProjects(user, "manage")}
      or ${receipts.uploadedBy} = ${user.id}
    )
  )`;
}

export type EditableReceipt = {
  receipt: typeof receipts.$inferSelect;
  project: typeof projects.$inferSelect;
  isInstanceOwner: boolean;
  isProjectOwner: boolean;
  callerIsFull: boolean;
};

/**
 * Loads a receipt for mutation, having proved the caller may reach it.
 *
 * The five statements below are in this order for reasons documented at
 * length in `scope.ts` and `routers/receipts.ts`; the ordering is the
 * security property, not an implementation detail:
 *
 *  1. Unlocked read of `project_id` only. Learns where the receipt lives
 *     without locking anything.
 *  2. `lockScopedProject(..., "add")` — check -> lock -> re-check, three
 *     separate statements. This is what stops an unauthorized caller from
 *     queueing on a lock for a row they have no rights to (a timing oracle
 *     and a connection-pinning DoS, both found in the task 4.8 review).
 *     `"add"` also excludes archived projects for free, which is how
 *     "archived projects are read-only" holds here without a second check.
 *  3. Re-read the receipt under the project lock. Closes the window between
 *     (1) and (2). `.for("update")` additionally protects the read-modify-
 *     write on `missing_fields`/`dismissed_fields` against any future path
 *     that reaches a receipt without taking the project lock first.
 *  4. Re-read the caller's OWN role inside the transaction. `ctx.user.role`
 *     came from the JWT at request entry and is stale if an admin demoted
 *     this user since (finding M-5).
 *  5. Read the caller's project membership, only if they are neither the
 *     instance owner nor the project owner.
 *
 * Lock order is always projects -> receipts -> receipt_items, everywhere in
 * this package, so no call site introduces a deadlock cycle.
 *
 * Every unauthorized exit is a bare NOT_FOUND, preserving 404-not-403.
 */
export async function loadEditableReceipt(
  tx: Tx,
  receiptId: string,
  user: AuthUser,
): Promise<EditableReceipt> {
  const [precheck] = await tx
    .select({ projectId: receipts.projectId })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), isNull(receipts.deletedAt)))
    .limit(1);
  if (!precheck) throw new TRPCError({ code: "NOT_FOUND" });

  const project = await lockScopedProject(tx, precheck.projectId, user, "add");

  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), isNull(receipts.deletedAt)))
    .limit(1)
    .for("update");
  if (!receipt) throw new TRPCError({ code: "NOT_FOUND" });

  const [caller] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const isInstanceOwner = caller?.role === "owner";
  const isProjectOwner = project.ownerId === user.id;

  let callerIsFull = false;
  if (!isInstanceOwner && !isProjectOwner) {
    const [membership] = await tx
      .select({ permission: projectMembers.permission })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, receipt.projectId), eq(projectMembers.userId, user.id)),
      )
      .limit(1);
    callerIsFull = membership?.permission === "full";
  }

  return { receipt, project, isInstanceOwner, isProjectOwner, callerIsFull };
}

/**
 * The "own only" half of the matrix: `read_add` may edit and delete its own
 * receipts, `full` and above may edit anyone's. An escalation guard *beyond*
 * the scope gate, in the same shape `members.ts` uses — `scopedProjects`
 * authorizes the project, this decides which row within it.
 */
export function assertMayEditReceipt(access: EditableReceipt, userId: string): void {
  if (access.isInstanceOwner || access.isProjectOwner || access.callerIsFull) return;
  if (access.receipt.uploadedBy === userId) return;
  throw new TRPCError({ code: "FORBIDDEN" });
}

/**
 * Re-exported from `packages/shared/src/receiptFields.ts`, which is where the
 * token list lives so the pipeline, this package, and the UI share exactly one
 * definition. See that file for why `tip` is absent and `items` has no column.
 */
export {
  MISSING_FIELD_BY_COLUMN,
  MISSING_FIELD_TOKENS,
  isMissingFieldToken,
} from "@ledgerly/shared/receiptFields";
export type { EditableReceiptColumn, MissingFieldToken } from "@ledgerly/shared/receiptFields";

/**
 * Recomputes everything about a receipt that is derived from its own fields
 * and its items, and writes it back. Called after every field edit, every
 * dismissal, and every line-item change — one rule, one place, so the five
 * call sites cannot drift.
 *
 * Must be called inside the transaction that already holds the project lock
 * (i.e. after `loadEditableReceipt`), because it is a read-modify-write.
 *
 * Three derived things:
 *
 *  - **the `items` token**: present exactly when the receipt has no line
 *    items, unless the user dismissed it.
 *  - **`validation_flags` / `extraction_status`**: re-run of the same sanity
 *    checks extraction uses, minus anything in `acknowledged_flags`. Without
 *    this, a user who corrects a mistyped total keeps the
 *    `arithmetic_mismatch_total` badge forever — the receipt now adds up and
 *    the app still says it doesn't. Guarded to `ok`/`partial` only: `pending`
 *    and `failed` are pipeline states, and a field edit has no business
 *    asserting a receipt finished extracting.
 *  - **`reviewed_at`**: derived, never set directly, so there is exactly one
 *    definition of "this receipt has left the review queue" and no second
 *    source of truth to disagree with the badge.
 */
/**
 * What changed about a receipt's review state, so the caller can act on it
 * AFTER the transaction commits (D-47).
 *
 * Returned rather than acted on here, because the one action anyone wants —
 * enqueueing the held receipt email — must not happen inside the transaction.
 * An email queued against a transaction that then rolls back is an email
 * nobody can recall, which is the same rule `worker.ts` follows for the
 * automatic send and the reason `recordEvent` takes a `Database` and not a
 * `Tx`.
 */
export type RecomputeResult = {
  /** The receipt this result is about. Carried here so the caller can act on
   *  it after the transaction, where the ids that were in scope inside it are
   *  not. */
  receiptId: string | null;
  /** The receipt has just gone from having something outstanding to having
   *  nothing outstanding. False when it was already clear — this is an EDGE,
   *  not a level, so a second edit to an already-clear receipt does not
   *  re-trigger anything. */
  becameClear: boolean;
};

export async function recomputeReceiptDerivedState(
  tx: Tx,
  receiptId: string,
): Promise<RecomputeResult> {
  const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
  if (!receipt) throw new TRPCError({ code: "NOT_FOUND" });

  const items = await tx
    .select({ lineTotal: receiptItems.lineTotal })
    .from(receiptItems)
    .where(eq(receiptItems.receiptId, receiptId));

  const dismissed = new Set(receipt.dismissedFields);
  const missing = new Set(receipt.missingFields);

  if (items.length === 0 && !dismissed.has("items")) missing.add("items");
  else missing.delete("items");

  // Only the two states a user edit may legitimately move between.
  const recomputable = receipt.extractionStatus === "ok" || receipt.extractionStatus === "partial";
  let validationFlags = receipt.validationFlags;
  let extractionStatus = receipt.extractionStatus;

  if (recomputable) {
    const result = runSanityChecks({
      subtotal: receipt.subtotal,
      salesTax: receipt.salesTax,
      tip: receipt.tip,
      total: receipt.total,
      transactionDate: receipt.transactionDate,
      // Passed THROUGH, not re-derived. `transactionDiscount` is an edited
      // value like any other money field, but `taxIncluded` and
      // `dateUnconfirmed` are facts about how the receipt was READ — whether
      // two passes agreed on the date, whether the prices were tax-inclusive —
      // and both readings are long gone by the time a user edits a field. A
      // recompute that re-derived them would quietly clear a flag nobody
      // resolved (D-47).
      transactionDiscount: receipt.transactionDiscount,
      taxIncluded: receipt.taxIncluded,
      dateUnconfirmed: receipt.dateUnconfirmed,
      items,
      // Without this the recompute puts an acknowledged flag straight back,
      // and every acknowledgement would last exactly until the next edit.
      acknowledgedFlags: receipt.acknowledgedFlags,
    });
    validationFlags = result.validationFlags;
    extractionStatus = result.status;
  }

  const nextMissing = [...missing];
  const isClear = nextMissing.length === 0 && validationFlags.length === 0;
  // The BEFORE state, read from the row this function was handed at the top.
  // An edge rather than a level: acting on `isClear` alone would re-fire on
  // every subsequent edit of a receipt that was already settled.
  const wasClear = receipt.missingFields.length === 0 && receipt.validationFlags.length === 0;

  await tx
    .update(receipts)
    .set({
      missingFields: nextMissing,
      validationFlags,
      extractionStatus,
      // Set when the receipt leaves the queue, cleared when a later edit puts
      // it back. A timestamp that only ever moves forward would claim a
      // receipt was reviewed while it is visibly sitting in the queue.
      reviewedAt: isClear ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(receipts.id, receiptId));

  return { receiptId, becameClear: isClear && !wasClear };
}

/**
 * Releases a held automatic receipt email, if this edit is what finished the
 * review (D-47).
 *
 * Called AFTER the transaction commits, never inside it — see `RecomputeResult`.
 * Every failure is swallowed to a console line for the same reason the
 * extraction worker swallows its enqueue: the user's edit has already
 * succeeded and been committed, and a Redis hiccup while queueing a
 * NOTIFICATION must not turn a successful save into an error toast. The cost
 * of losing it is one email that does not arrive, and the next edit to the
 * receipt will try again.
 */
export async function releaseHeldEmail(
  ctx: { enqueueAutoReceiptEmail?: (params: { receiptId: string }) => Promise<void> },
  result: RecomputeResult,
): Promise<void> {
  if (!result.becameClear || result.receiptId === null || !ctx.enqueueAutoReceiptEmail) return;
  const receiptId = result.receiptId;
  try {
    await ctx.enqueueAutoReceiptEmail({ receiptId });
  } catch (error) {
    console.error(`[ledgerly] could not release the held email for ${receiptId}:`, error);
  }
}

/**
 * Composable liveness + scope predicate for any read of `receipts` at a given
 * level. Exists so no read path can forget one of the three clauses — the
 * project scope, the receipt's own soft-delete, and (for writes) the
 * project's.
 */
export function receiptIsReadable(user: AuthUser) {
  return and(isNull(receipts.deletedAt), inArray(receipts.projectId, scopedProjects(user, "read")));
}
