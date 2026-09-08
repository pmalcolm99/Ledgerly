// packages/shared/src/money.ts — D-21. The only place `numeric(12,2)` <->
// integer-cents conversion is written. Postgres `numeric` columns are read
// by Drizzle as strings; this module is the sole boundary between that
// string representation and the integer-cents representation the
// application does arithmetic in. Pure and isomorphic — see index.ts's
// header comment and eslintRestrictedImports.test.ts: this package must
// never import a Node built-in or a server-only dependency.

const NUMERIC_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * `numeric(12,2)` holds 12 significant digits with 2 after the decimal —
 * a max magnitude of 9999999999.99, i.e. 999999999999 cents. This module
 * is the sole boundary to that column type (D-21), so it is the one place
 * that range is enforced, rather than each caller discovering it via a
 * `22003` (`numeric_value_out_of_range`) at insert time (task 4.8 review
 * finding L-5).
 */
const NUMERIC_12_2_MAX_CENTS = 999_999_999_999;

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
