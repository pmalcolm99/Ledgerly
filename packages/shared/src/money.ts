// packages/shared/src/money.ts — D-21. The only place `numeric(12,2)` <->
// integer-cents conversion is written. Postgres `numeric` columns are read
// by Drizzle as strings; this module is the sole boundary between that
// string representation and the integer-cents representation the
// application does arithmetic in. Pure and isomorphic — see index.ts's
// header comment and eslintRestrictedImports.test.ts: this package must
// never import a Node built-in or a server-only dependency.

const NUMERIC_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Accounting sign notation -> a canonical leading-minus decimal.
 *
 * Receipts do not agree on how to print a credit. Costco prints the sign
 * AFTER the amount (`12.34-`); accounting software and many invoices wrap it
 * in parentheses (`(12.34)`); the rest use a leading minus. `parseMoney`
 * accepts only the last of those — correctly, since it is D-21's boundary to
 * the `numeric(12,2)` column and must stay strict — so the other two parsed
 * as nothing and the field silently became null. A dropped credit does not
 * just lose a line: its absence inflates `sum(items)` and raises a FALSE
 * `arithmetic_mismatch_items` on a receipt that actually balanced.
 *
 * This is the one place that translation is written, so model output
 * (`pipeline/normalize.ts`) and hand-typed input (`api/src/inputs.ts`) can
 * never disagree about whether a Costco credit is a credit.
 *
 * Deliberately narrow. Anything ambiguous — a sign both inside and outside
 * the parentheses, two trailing minuses — is returned untouched so
 * `parseMoney` rejects it, rather than guessed at. Inventing a sign for a
 * money value is worse than refusing to read it.
 *
 * U+2212 MINUS SIGN is folded to ASCII `-` on the way in: it is what an OCR
 * pass returns for a typeset minus, and it means exactly one thing here.
 */
export function canonicalizeMoneySign(raw: string): string {
  const original = raw.trim();
  let value = original.replace(/\u2212/g, "-");
  let negative = false;

  const parenthesized = /^\((.*)\)$/.exec(value);
  if (parenthesized) {
    negative = true;
    value = (parenthesized[1] ?? "").trim();
  }

  if (value.endsWith("-")) {
    // Parentheses AND a trailing minus is not a notation anyone prints.
    // Reading it as a double negative would be a guess.
    if (negative) return original;
    negative = true;
    value = value.slice(0, -1).trim();
  }

  if (!negative) return value;
  // Already signed inside the wrapper — ambiguous, so leave it to be rejected.
  if (value.startsWith("-") || value.startsWith("+")) return original;
  return `-${value}`;
}

/**
 * `numeric(12,2)` holds 12 significant digits with 2 after the decimal —
 * a max magnitude of 9999999999.99, i.e. 999999999999 cents. This module
 * is the sole boundary to that column type (D-21), so it is the one place
 * that range is enforced, rather than each caller discovering it via a
 * `22003` (`numeric_value_out_of_range`) at insert time (task 4.8 review
 * finding L-5).
 */
/** The largest magnitude `numeric(12,2)` can hold, in cents. Exported
 *  since Phase 8: the export's summary accumulator guards its running totals
 *  against the bound that actually binds (this one) rather than against
 *  `Number.isSafeInteger`, which is ~90x higher and could never fire first. */
export const NUMERIC_12_2_MAX_CENTS = 999_999_999_999;

function assertWithinNumeric12_2(cents: bigint | number, source: string): void {
  const abs = typeof cents === "bigint" ? (cents < 0n ? -cents : cents) : Math.abs(cents);
  const max = typeof cents === "bigint" ? BigInt(NUMERIC_12_2_MAX_CENTS) : NUMERIC_12_2_MAX_CENTS;
  if (abs > max) {
    throw new Error(`Value exceeds numeric(12,2)'s range: ${source}`);
  }
}

/**
 * Parses a `numeric(12,2)`-shaped string (as Drizzle returns it) into
 * integer cents. Throws on anything that isn't a valid decimal with at most
 * two fractional digits — callers should not pre-validate, this is the
 * validation.
 */
export function parseMoney(numeric: string): number {
  const trimmed = numeric.trim();
  const match = NUMERIC_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid money string: ${JSON.stringify(numeric)}`);
  }

  // `whole` always matches (the regex's second group is `\d+`, not
  // optional); the fallback exists only to satisfy noUncheckedIndexedAccess.
  const [, sign, whole = "0", frac = ""] = match;
  const paddedFrac = frac.padEnd(2, "0");
  // BigInt here guards against overflow while assembling the integer from
  // string digits — a numeric(12,2) can hold amounts whose cents value
  // could in principle approach the Number safe-integer boundary. Ordinary
  // arithmetic on the resulting cents values never needs BigInt: 12 digits
  // of precision minus 2 for cents is comfortably under 2^53.
  const cents = BigInt(whole) * 100n + BigInt(paddedFrac);
  const signed = sign ? -cents : cents;

  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Money value out of safe integer range: ${numeric}`);
  }
  assertWithinNumeric12_2(signed, numeric);

  return Number(signed);
}

/**
 * Formats integer cents back into a `numeric(12,2)`-compatible string —
 * always two fractional digits, no thousands separator (that's a display
 * concern for a formatting helper elsewhere, not this module).
 */
export function formatMoney(cents: number): string {
  // isSafeInteger, not isInteger (task 4.8 review finding L-4): isInteger
  // passes for values like 2**60, where Math.floor(abs / 100) is no longer
  // provably exact — the guarantee this function makes should be enforced,
  // not assumed of whatever the caller passes in.
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`formatMoney expects a safe integer number of cents, got ${cents}`);
  }
  assertWithinNumeric12_2(cents, String(cents));

  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * Adds two `numeric` strings and returns a `numeric` string, going through
 * integer cents so floating point never enters the calculation. `0.1 + 0.2
 * !== 0.3` is a float problem because 0.1 and 0.2 aren't exactly
 * representable in binary; `10 + 20` has no such problem because integers
 * up to 2^53 are exact in IEEE-754 double precision.
 */
export function addMoney(a: string, b: string): string {
  return formatMoney(parseMoney(a) + parseMoney(b));
}
