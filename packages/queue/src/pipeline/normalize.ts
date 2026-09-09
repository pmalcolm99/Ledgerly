import { formatMoney, parseMoney } from "@ledgerly/shared/money";

/**
 * packages/queue/src/pipeline/normalize.ts — turns a model-returned string
 * field into either a canonical value to persist, or null (added to
 * `missing_fields` by the caller) when it doesn't actually parse. The
 * model is instructed to return clean values, but this is the layer that
 * never trusts that instruction was followed — every function here is
 * total (never throws) and defends the DB columns it feeds:
 * `transaction_date`'s `receipts_date_sane` CHECK, `transaction_time`'s
 * `time` type, `quantity`'s `numeric(12,3)` range (review finding H-3 —
 * a regex-only format check let calendar-invalid dates/times and
 * out-of-range quantities reach a column write, aborting the whole
 * extraction transaction instead of degrading to null + missing_fields,
 * per ARCHITECTURE.md §6.3's "extraction never fails" rule).
 *
 * ## Every input here is `string | null | undefined`, and that is deliberate
 *
 * These take model output. The `RecordReceiptInput` TYPE says each field is
 * `string | null`, but the tool schema's `required` list did not cover them,
 * so a model that simply omitted a field produced `undefined` — and a
 * `raw === null` guard does not catch `undefined`. The result was
 * `TypeError: Cannot read properties of undefined (reading 'replace')`,
 * thrown after a successful, billed API call, surfacing as the generic
 * `AI_EXTRACTION_FAILED` and retried twice more.
 *
 * The schema is fixed too (schema.ts), but these signatures are the layer
 * that must hold REGARDLESS of what the schema says, because the whole point
 * of this file is to not trust the model's output shape. A missing field is
 * the same fact as a null one: no value. Both become null.
 */

/** `numeric(12,2)` money field: strips stray `$`/`,`/whitespace a model
 * might emit despite instructions, parses via `parseMoney` (D-21's sole
 * numeric<->cents boundary, which already enforces the numeric(12,2)
 * range), and re-formats to canonicalize (e.g. "12.3" -> "12.30"). Null or
 * unparseable becomes null. */
export function normalizeMoney(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  try {
    return formatMoney(parseMoney(cleaned));
  } catch {
    return null;
  }
}

// receipt_items.quantity is numeric(12,3) -- 12 significant digits, 3
// after the decimal, so a max magnitude of 999999999.999. A model
// returning something absurd (a hallucinated huge number, or noise) must
// degrade to null rather than overflow the column at insert time.
const QUANTITY_MAX_MAGNITUDE = 999_999_999.999;

/** `numeric(12,3)` quantity: one more fractional digit than `parseMoney`
 * accepts (not a money column), so this is a plain decimal-string
 * validator with its own magnitude bound, not routed through money.ts. */
export function normalizeQuantity(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw.trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(cleaned)) return null;
  return Math.abs(Number(cleaned)) <= QUANTITY_MAX_MAGNITUDE ? cleaned : null;
}

/**
 * Calendar-valid ISO date, not just format-shaped -- `"2026-13-45"`
 * matches a naive `\d{4}-\d{2}-\d{2}` regex but is not a real date, and
 * `receipts.transaction_date` is a real `date` column that would reject it
 * at write time. Round-trips through `Date.UTC` and rejects anything that
 * doesn't come back exactly (catches Feb 30, month 13, etc.).
 */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const [, y, m, d] = match as unknown as [string, string, string, string];
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return roundTrips ? raw : null;
}

/**
 * Calendar-valid time, not just format-shaped -- `"99:99"` matches a naive
 * `\d{2}:\d{2}` regex but `receipts.transaction_time` is a real `time`
 * column that would reject it.
 */
export function normalizeTime(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return null;
  const [, h, mi, s] = match as unknown as [string, string, string, string | undefined];
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  return hour <= 23 && minute <= 59 && second <= 59 ? raw : null;
}

/**
 * `record_receipt`'s `confidence` field is required (not nullable in the
 * tool schema) and strict mode's own `type: "number"` constraint should
 * guarantee a finite number in range -- but D-12 is still Provisional on
 * whether strict mode holds for every field shape (task 6.3), so this
 * clamps rather than trusts: any non-finite or out-of-range value becomes
 * `0` (the most conservative reading -- it forces escalation rather than
 * silently treating garbage as high confidence) instead of violating
 * `receipts_confidence_range`'s CHECK constraint.
 */
export function normalizeConfidence(raw: unknown): number {
  // Deliberately a hard reject to 0, not a clamp to the nearest bound: a
  // value outside [0,1] (e.g. a model reporting "95" as a percentage) is
  // evidence the field can't be trusted at all, not evidence it meant
  // "maximally confident" — defaulting to 0 forces escalation (the
  // conservative outcome) rather than silently treating garbage as a
  // clean, high-confidence pass-1 result.
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return 0;
  return raw;
}
