import { parseMoney } from "./money";

/**
 * packages/shared/src/receiptValidation.ts — sanity checks (task 6.7,
 * ARCHITECTURE.md §6.3).
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

export type ValidationFlag =
  "arithmetic_mismatch_total" | "arithmetic_mismatch_items" | "date_in_future" | "date_too_old";

export type ValidationInput = {
  subtotal: string | null;
  salesTax: string | null;
  tip: string | null;
  total: string | null;
  transactionDate: string | null; // ISO YYYY-MM-DD
  items: { lineTotal: string | null }[];
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

export function runSanityChecks(input: ValidationInput): ValidationResult {
  const flags: ValidationFlag[] = [];

  if (input.subtotal !== null && input.salesTax !== null && input.total !== null) {
    const subtotalCents = parseMoney(input.subtotal);
    const salesTaxCents = parseMoney(input.salesTax);
    // Review finding L-4: ARCHITECTURE.md §6.3 states this check as
    // `subtotal + sales_tax - total`, but a tipped receipt (restaurants,
    // the exact case tip/`receipts.tip` exists for) legitimately has
    // `total = subtotal + sales_tax + tip` -- omitting tip here flagged
    // every tipped receipt as a false-positive arithmetic mismatch. `tip`
    // is 0 when not printed, so this is a superset of the documented
    // check, not a behavior change for untipped receipts.
    const tipCents = input.tip !== null ? parseMoney(input.tip) : 0;
    const totalCents = parseMoney(input.total);
    if (Math.abs(subtotalCents + salesTaxCents + tipCents - totalCents) > TOTAL_TOLERANCE_CENTS) {
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

  if (input.transactionDate !== null) {
    if (input.transactionDate > todayIso()) {
      flags.push("date_in_future");
    } else if (input.transactionDate < MIN_DATE) {
      flags.push("date_too_old");
    }
  }

  return { status: flags.length > 0 ? "partial" : "ok", validationFlags: flags };
}
