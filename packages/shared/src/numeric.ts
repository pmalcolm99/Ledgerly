/**
 * packages/shared/src/numeric.ts — the non-money `numeric` columns.
 *
 * `money.ts` is scale-2 by construction: its pattern rejects a third
 * fractional digit, and its cents conversion assumes 2dp. Two columns in the
 * schema are neither money nor scale-2, and passing either to `parseMoney`
 * throws on perfectly valid data:
 *
 *   receipt_items.quantity        numeric(12,3)   e.g. "0.125"
 *   receipts.extraction_confidence numeric(4,3)   e.g. "0.875"
 *
 * They get their own helpers rather than a loosened money regex, because
 * loosening `money.ts` would silently start accepting sub-cent money.
 */

const QUANTITY_PATTERN = /^(-)?(\d+)(?:\.(\d{1,3}))?$/;

/** Validates and normalizes a user-entered quantity to `numeric(12,3)`'s
 *  shape. Throws on anything else — this is the validation, callers do not
 *  pre-check. */
export function parseQuantityInput(raw: string): string {
  const trimmed = raw.trim();
  const match = QUANTITY_PATTERN.exec(trimmed);
  if (!match) throw new Error(`Invalid quantity: ${JSON.stringify(raw)}`);

  const [, sign, whole, fraction = ""] = match;
  if (whole !== undefined && whole.length > 9) {
    throw new Error(`Value exceeds numeric(12,3)'s range: ${JSON.stringify(raw)}`);
  }
  return `${sign ?? ""}${whole ?? "0"}.${fraction.padEnd(3, "0")}`;
}

/**
 * Renders a stored quantity for a table cell. Postgres returns
 * `numeric(12,3)` fully padded (`"2.000"`), which reads as spurious precision
 * on a receipt line that just said "2".
 */
export function formatQuantityDisplay(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "";
  const trimmed = value.trim();
  if (!trimmed.includes(".")) return trimmed;
  const stripped = trimmed.replace(/0+$/, "").replace(/\.$/, "");
  return stripped === "" || stripped === "-" ? "0" : stripped;
}

/** `extraction_confidence` as a whole-number percentage, or null. Confidence
 *  is a display-only signal, so a float here is harmless and deliberate. */
export function formatConfidencePercent(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}
