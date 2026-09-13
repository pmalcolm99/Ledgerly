/**
 * packages/shared/src/emailGate.ts — when the automatic receipt email waits
 * (D-47).
 *
 * ## Why this is one function in `shared` rather than two in two packages
 *
 * It shipped as two: `emailIsHeldForReview` in `packages/queue` decided whether
 * to send, and `recomputeReceiptDerivedState` in `packages/api` decided whether
 * to re-enqueue. They used different rules — `validationFlags.length > 0`
 * versus `flags AND missing fields both empty` — and coincided only under the
 * STRICTER gate, which is not the default.
 *
 * The result was that under the shipped default a receipt with any unread
 * field was held forever: clearing the last warning removed the hold condition
 * but never triggered the release, and the receipt detail page said "the
 * automatic email is waiting until these are resolved" while the warnings it
 * pointed at were already gone. Most real receipts have at least one unread
 * field, so that was the common case rather than an edge.
 *
 * The lesson is the ordinary one about predicates that must agree: two copies
 * of "is this receipt settled" is one copy too many. The send path and the
 * release path now call this, and the release is defined as the EDGE across
 * it — held before, not held after — rather than as a separate idea of
 * clearness that happens to look similar.
 */

export const EMAIL_GATES = ["flags", "flags_and_missing"] as const;
export type EmailGate = (typeof EMAIL_GATES)[number];

export const DEFAULT_EMAIL_GATE: EmailGate = "flags";

/** Just enough of a receipt to answer the question. A structural type rather
 *  than the row, so both the queue's loaded receipt and the API's recompute
 *  snapshot satisfy it without either importing the other's shape. */
export type ReviewState = {
  validationFlags: readonly string[];
  missingFields: readonly string[];
};

/**
 * Whether an automatic send waits for a human.
 *
 * Deliberately NOT `NEEDS_REVIEW_SQL`. That predicate includes
 * `extraction_status <> 'ok'`, which covers `pending` and `failed` — states
 * where there is nothing for a person to resolve and the email should simply
 * never come. This asks a narrower question: is there something outstanding
 * that a person is expected to act on.
 *
 *  - `flags` — warnings only. A receipt can be complete and correct with a
 *    field genuinely blank, so a missing `card_last4` does not hold up mail.
 *  - `flags_and_missing` — the strictest reading of "static, complete and
 *    correct", at the cost of receipts sitting unsent over a field nobody
 *    cares about.
 */
export function emailIsHeldForReview(receipt: ReviewState, gate: EmailGate): boolean {
  if (receipt.validationFlags.length > 0) return true;
  return gate === "flags_and_missing" && receipt.missingFields.length > 0;
}

/**
 * Whether this edit is the one that finished the review.
 *
 * An EDGE, not a level. Firing on "is not held" alone would re-enqueue on every
 * subsequent edit of an already-settled receipt, leaving `already_sent` as the
 * only thing between a receipt and a second email — a thin place to put that
 * guarantee.
 */
export function reviewJustFinished(
  before: ReviewState,
  after: ReviewState,
  gate: EmailGate,
): boolean {
  return emailIsHeldForReview(before, gate) && !emailIsHeldForReview(after, gate);
}
