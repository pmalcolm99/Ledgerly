import { parseMoney } from "./money";

/**
 * packages/shared/src/receiptValidation.ts — sanity checks (task 6.7,
 * ARCHITECTURE.md §6.3).
 *
 * ## Acknowledgement
 *
 * Some receipts genuinely do not reconcile, and no amount of correcting will
 * make them. A discounted receipt whose printed subtotal already has the
 * discount applied, read by a model that then subtracts it again, produces an
 * `arithmetic_mismatch_items` that is real arithmetic on wrong data — and the
 * user cannot fix it without inventing a line item that is not on the paper.
 *
 * `acknowledgedFlags` is that escape hatch, and it is the reason the return
 * value is computed from the FILTERED list. See the field's own comment.
 *
 * Never fails the receipt — each check independently sets
 * `extraction_status='partial'` and appends a flag to `validation_flags`,
 * because CLAUDE.md requires extraction to always save *something*. Money
 * comparisons go through `parseMoney` (integer cents), never float
 * arithmetic, matching D-21.
 *
 * MOVED HERE IN PHASE 7 from `packages/queue/src/pipeline/validate.ts`, which
 * is now a one-line re-export so `extract.ts` and `validate.test.ts` are
 * untouched and remain the regression net for this logic.
 *
 * Why it had to move: `receipts.update` recomputes `validation_flags` when a
 * user corrects a total — without that, fixing the arithmetic leaves the
 * `arithmetic_mismatch_total` badge on the row permanently — and
 * `packages/api` cannot import `@ledgerly/queue`, because queue already
 * depends on api and that edge would be circular (trpc.ts's
 * `EnqueueReceiptExtract` comment describes the same constraint, solved there
 * by injection). This function is pure and imports only `./money`, so
 * `packages/shared` is the one place both callers can reach.
 */

/**
 * Every flag the sanity checks can raise, as a runtime list.
 *
 * A const array rather than a bare union, for the same reason
 * `MISSING_FIELD_TOKENS` is one: `receipts.acknowledgeValidationFlag` needs a
 * `z.enum` of exactly these, and deriving the type from the list means a flag
 * added below is automatically acknowledgeable rather than silently
 * un-clearable — which is the bug this whole mechanism exists to fix.
 */
export const VALIDATION_FLAGS = [
  "arithmetic_mismatch_total",
  "arithmetic_mismatch_items",
  "date_in_future",
  "date_too_old",
  /**
   * Two independent reads of the receipt disagreed about the date (D-47).
   *
   * Not "the date looks old" — a receipt uploaded three weeks after the
   * purchase is completely ordinary, and flagging every one of those would
   * train people to dismiss the flag without reading it. The trigger is
   * disagreement: `extract.ts` re-reads when the date is more than a week old,
   * and two independent reads landing on the same date is strong evidence the
   * receipt really says that. A misread rarely repeats itself identically.
   */
  "date_unconfirmed",
] as const;

export type ValidationFlag = (typeof VALIDATION_FLAGS)[number];

/**
 * Narrows a value read out of `validation_flags`/`acknowledged_flags`.
 *
 * Those are `text[]`, so anything the database holds arrives as a plain
 * string — including a flag written by a version of this app that knew about
 * one this one does not. Such a value is shown but not offered as actionable,
 * rather than crashing the page or being silently coerced into a flag the
 * server would reject. `isMissingFieldToken` exists for the same reason.
 */
export function isValidationFlag(value: string): value is ValidationFlag {
  return (VALIDATION_FLAGS as readonly string[]).includes(value);
}

export type ValidationInput = {
  subtotal: string | null;
  salesTax: string | null;
  tip: string | null;
  total: string | null;
  transactionDate: string | null; // ISO YYYY-MM-DD
  items: { lineTotal: string | null }[];
  /**
   * An order-level credit, negative, applied after the subtotal is struck
   * (D-47). `null` or absent means none, which is how every receipt extracted
   * before this existed keeps exactly the arithmetic it had.
   */
  transactionDiscount?: string | null;
  /** The printed prices already include tax, so a zero `salesTax` is the right
   *  answer rather than a gap. */
  taxIncluded?: boolean;
  /** Set by the pipeline when a second read disagreed about the date. Passed
   *  through rather than re-derived — see `receipts.date_unconfirmed`. */
  dateUnconfirmed?: boolean;
  /**
   * Flags the user has looked at and asserted are correct anyway.
   *
   * Filtered out of the RESULT rather than skipped during the checks, so the
   * checks stay a pure function of the numbers and there is one place — here —
   * where an acknowledgement takes effect. Both callers (the extraction
   * pipeline and `recomputeReceiptDerivedState`) get the same rule for free,
   * which is the whole reason this function lives in `shared`.
   *
   * This is what makes an acknowledgement mean something: a receipt whose only
   * remaining complaint has been acknowledged comes back `ok`, and `ok` is what
   * `NEEDS_REVIEW_SQL` reads to let it out of the review queue. Without the
   * status following the filtered flags, acknowledging would hide the badge
   * and leave the receipt in the queue forever — which is the bug it exists to
   * fix, moved somewhere less visible.
   */
  acknowledgedFlags?: readonly string[];
};

export type ValidationResult = {
  status: "ok" | "partial";
  validationFlags: ValidationFlag[];
};

const MIN_DATE = "2000-01-01";
// ARCHITECTURE.md §6.3 thresholds.
const TOTAL_TOLERANCE_CENTS = 2; // $0.02
const ITEMS_TOLERANCE_CENTS = 100; // $1.00

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Whether the line items add up to the subtotal, within the same tolerance the
 * `arithmetic_mismatch_items` check uses.
 *
 * Exported so the extraction pipeline can ask the question BEFORE it persists,
 * and offer the model a corrective retry — `runSanityChecks` answers it after
 * the fact, which is too late to do anything about.
 *
 * `null` when the question does not apply: no subtotal, or no priced items.
 * A receipt with nothing to compare is not a receipt that failed to reconcile.
 */
export function itemsReconcile(input: {
  subtotal: string | null;
  items: { lineTotal: string | null }[];
}): { reconciles: boolean; itemsCents: number; subtotalCents: number } | null {
  if (input.subtotal === null) return null;
  const lineTotals = input.items
    .map((item) => item.lineTotal)
    .filter((value): value is string => value !== null);
  if (lineTotals.length === 0) return null;

  const subtotalCents = parseMoney(input.subtotal);
  const itemsCents = lineTotals.reduce((sum, value) => sum + parseMoney(value), 0);
  return {
    reconciles: Math.abs(itemsCents - subtotalCents) <= ITEMS_TOLERANCE_CENTS,
    itemsCents,
    subtotalCents,
  };
}

export function runSanityChecks(input: ValidationInput): ValidationResult {
  const flags: ValidationFlag[] = [];

  if (input.subtotal !== null && input.salesTax !== null && input.total !== null) {
    const subtotalCents = parseMoney(input.subtotal);
    const salesTaxCents = parseMoney(input.salesTax);
    // D-47: an order-level credit sits between the subtotal and the total —
    //   items -> subtotal -> + discount -> + tax + tip -> total
    // — so it belongs in this check and deliberately NOT in the items check
    // below. Stored negative, so this is an addition. Absent means zero, which
    // is what makes this a no-op for every pre-existing receipt.
    const discountCents =
      input.transactionDiscount != null ? parseMoney(input.transactionDiscount) : 0;
    // Review finding L-4: ARCHITECTURE.md §6.3 states this check as
    // `subtotal + sales_tax - total`, but a tipped receipt (restaurants,
    // the exact case tip/`receipts.tip` exists for) legitimately has
    // `total = subtotal + sales_tax + tip` -- omitting tip here flagged
    // every tipped receipt as a false-positive arithmetic mismatch. `tip`
    // is 0 when not printed, so this is a superset of the documented
    // check, not a behavior change for untipped receipts.
    const tipCents = input.tip !== null ? parseMoney(input.tip) : 0;
    const totalCents = parseMoney(input.total);
    if (
      Math.abs(subtotalCents + discountCents + salesTaxCents + tipCents - totalCents) >
      TOTAL_TOLERANCE_CENTS
    ) {
      flags.push("arithmetic_mismatch_total");
    }
  }

  if (input.subtotal !== null) {
    const lineTotals = input.items
      .map((item) => item.lineTotal)
      .filter((value): value is string => value !== null);
    if (lineTotals.length > 0) {
      const subtotalCents = parseMoney(input.subtotal);
      const sumCents = lineTotals.reduce((sum, value) => sum + parseMoney(value), 0);
      if (Math.abs(sumCents - subtotalCents) > ITEMS_TOLERANCE_CENTS) {
        flags.push("arithmetic_mismatch_items");
      }
    }
  }

  // Not gated on `transactionDate` being non-null: a second read that returned
  // no date at all, where the first read did, is exactly the disagreement this
  // records.
  if (input.dateUnconfirmed === true) {
    flags.push("date_unconfirmed");
  }

  if (input.transactionDate !== null) {
    if (input.transactionDate > todayIso()) {
      flags.push("date_in_future");
    } else if (input.transactionDate < MIN_DATE) {
      flags.push("date_too_old");
    }
  }

  const acknowledged = new Set(input.acknowledgedFlags ?? []);
  const effective = flags.filter((flag) => !acknowledged.has(flag));

  return { status: effective.length > 0 ? "partial" : "ok", validationFlags: effective };
}
