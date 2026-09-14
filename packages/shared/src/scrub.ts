/**
 * packages/shared/src/scrub.ts — the Luhn scrub (task 6.6,
 * ARCHITECTURE.md §6.3, CLAUDE.md hard rule).
 *
 * "Scan all model output for any 13-19 digit sequence that passes a Luhn
 * check and strip it before anything is persisted." This runs BEFORE the
 * tool-input object is parsed into the internal receipt DTO and BEFORE
 * `extraction_raw` is stored — callers must scrub first, then parse the
 * *returned* (scrubbed) value, never the original. An unredacted PAN must
 * never exist in a variable used for persistence, logging, or field
 * mapping, even transiently.
 *
 * It is ALSO the only guard on free text a person types: routers/receipts.ts
 * and routers/receiptItems.ts run it over `userNotes` and item edits, which
 * reach the CSV/XLSX export and the backup archive. Anything this function
 * misses is stored in cleartext. Phase 10a finding F-23 was exactly that.
 */

const REDACTION_MARKER = "[REDACTED-CARD-NUMBER]";
const MIN_PAN_DIGITS = 13;
const MAX_PAN_DIGITS = 19;

/** Standard Luhn checksum over an array of digit VALUES (not characters). */
function passesLuhn(digits: readonly number[]): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits[i]!;
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Decade bases for the Unicode decimal-digit sets a receipt might plausibly
 * carry. Unicode guarantees each Nd set is ten contiguous code points
 * starting at its own zero, so `value = codePoint - base`.
 *
 * Phase 10a finding F-23: the previous implementation relied on
 * `normalize("NFKC")` alone, which folds FULLWIDTH digits (U+FF10-FF19) to
 * ASCII but does NOT fold Arabic-Indic, Devanagari, Thai or any other
 * script's digits — so `٤١١١١١١١١١١١١١١١` passed through untouched. This
 * table is an explicit, auditable enumeration rather than a clever walk
 * over `\p{Nd}`: two adjacent decades from different scripts would defeat
 * the clever version silently, and silence is the failure mode that got us
 * here.
 */
const DIGIT_DECADE_BASES = [
  0x0030, // ASCII
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Persian)
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0x17e0, // Khmer
  0x1810, // Mongolian
  0xff10, // Fullwidth (NFKC normally folds these; belt and braces)
] as const;

/** The digit VALUE of a single-code-point string, or null if it is not one. */
function decimalDigitValue(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  for (const base of DIGIT_DECADE_BASES) {
    if (cp >= base && cp <= base + 9) return cp - base;
  }
  return null;
}

/**
 * Separators are classified in two tiers, and the tier decides how much
 * benefit of the doubt a span gets.
 *
 * BASIC -- whitespace and every dash form. These have always joined digits
 * (the pre-F-23 pattern was `[\d\s-]`), a line-wrapped card depends on it,
 * and nothing in this domain groups unrelated numbers with a dash.
 *
 * EXTENDED -- `.` `/` `\` `*` `_` `|` and the dot-like marks. These are the
 * separators F-23 added, and they are the dangerous ones, because `.` is
 * also the decimal point in every price on every receipt. Joining across
 * them unconditionally turned "Items: 12.99 4.50 3.25 8.75 1.99 6.20" into
 * one 18-digit region, and a sliding Luhn window over 18 digits finds a
 * "valid" span with probability ~99%. A user typing a price list into a
 * receipt note watched it become [REDACTED-CARD-NUMBER], irreversibly and
 * with no warning.
 *
 * So a candidate span that crosses an EXTENDED separator must also LOOK
 * like a written card number -- see `spanIsPlausible`.
 */
const BASIC_SEPARATORS = new Set<string>([
  "-", // ASCII hyphen-minus
  "\u2010", // hyphen
  "\u2011", // non-breaking hyphen
  "\u2012", // figure dash
  "\u2013", // en dash
  "\u2014", // em dash
  "\u2015", // horizontal bar
  "\u2212", // minus sign
  // Whitespace is handled by the `\s` test in `separatorKind`, which already
  // covers NBSP, narrow NBSP and thin space -- listing them as literals would
  // put invisible characters into the source for no gain.
]);

const EXTENDED_SEPARATORS = new Set<string>([
  ".",
  "/",
  "\\",
  "*",
  "_",
  "|",
  "\u00b7", // middle dot
  "\u2022", // bullet
  "\u2027", // hyphenation point
]);

// Deliberately in NEITHER set: "," and ":". Both are far more common as
// ordinary group separators -- thousands in a money amount, fields in a
// time -- than as card separators, and every separator F-23 demonstrated as
// leaking is covered without them.

/** The shortest run of digits a written card number groups into. */
const MIN_PLAUSIBLE_GROUP = 3;

type SeparatorKind = 0 | 1 | 2; // 0 = not a separator, 1 = basic, 2 = extended

function separatorKind(ch: string): SeparatorKind {
  if (EXTENDED_SEPARATORS.has(ch)) return 2;
  if (BASIC_SEPARATORS.has(ch) || /\s/.test(ch)) return 1;
  return 0;
}

/**
 * Does the text between `start` and `end` (code-point indexes, inclusive)
 * look like ONE written card number rather than a list of separate ones?
 *
 * A span joined only by whitespace or dashes is accepted outright -- that is
 * how cards have always been matched here, and narrowing it would be a
 * regression. A span that crosses an EXTENDED separator has to earn it:
 *
 *  - exactly ONE distinct extended separator character. A real card is
 *    written "4111.1111.1111.1111", never "4111.1111/1111*1111". A price
 *    list mixes "." with spaces, so it fails here first.
 *  - every digit group at least `MIN_PLAUSIBLE_GROUP` long. Cards group in
 *    4s (or 4-6-5 for Amex); money always ends in a 2-digit cents group, so
 *    "12.99 4.50" fails on the "99" and the "4".
 *
 * Checked per CANDIDATE SPAN, not per region, and that distinction matters:
 * judging a whole region would miss the card in "order 12 card
 * 4111.1111.1111.1111", where the region carries a 2-digit group that is
 * nothing to do with the number.
 */
function spanIsPlausible(
  cps: readonly string[],
  digitVals: readonly (number | null)[],
  sepKinds: readonly SeparatorKind[],
  start: number,
  end: number,
): boolean {
  const extendedUsed = new Set<string>();
  const groups: number[] = [];
  let run = 0;

  for (let i = start; i <= end; i++) {
    if (digitVals[i] !== null) {
      run += 1;
      continue;
    }
    if (run > 0) {
      groups.push(run);
      run = 0;
    }
    if (sepKinds[i] === 2) extendedUsed.add(cps[i]!);
  }
  if (run > 0) groups.push(run);

  if (extendedUsed.size === 0) return true;
  if (extendedUsed.size !== 1) return false;

  // Every group but the LAST must meet the floor.
  //
  // Requiring it of the last group too was a real leak: card lengths that
  // are not a multiple of four, written in the usual groups of four, end in
  // a short remainder -- a 13-digit Visa as 4307.4185.2963.7, a 14-digit
  // Diners as 3056.3074.1852.90, 17- and 18-digit Maestro likewise. All four
  // were rejected outright and reached storage in cleartext.
  //
  // Exempting only the final group keeps every price list out, because money
  // puts a 2-digit cents group in the MIDDLE of the span as well as at the
  // end: "12.99 4.50 3.25" fails on the interior "99" and "4" long before
  // the last group is considered.
  for (let i = 0; i < groups.length - 1; i++) {
    if (groups[i]! < MIN_PLAUSIBLE_GROUP) return false;
  }
  return true;
}

/**
 * Scans one string for 13-19 digit Luhn-valid spans and redacts each.
 *
 * Works over an array of CODE POINTS with a parallel classification rather
 * than over the raw string, for two reasons. Astral digits (e.g. U+1D7CE)
 * are two UTF-16 units, so index parity with a transliterated copy would
 * break; and everything outside a redacted span must be emitted VERBATIM --
 * transliterating in place would rewrite a Devanagari invoice number that
 * was never a card at all.
 *
 * At each digit position the LONGEST valid window (19 down to 13) wins, so
 * a genuine 16-digit PAN is matched whole rather than accidentally matched
 * short first; a position with no valid window advances by one digit. A
 * window must pass Luhn AND `spanIsPlausible` -- a window that passes Luhn
 * by chance across a price list is rejected and the next length is tried.
 */
function scrubString(value: string): { text: string; redactions: number } {
  const normalized = value.normalize("NFKC");
  const cps = Array.from(normalized);
  const n = cps.length;

  const digitVals: (number | null)[] = new Array(n);
  const sepKinds: SeparatorKind[] = new Array(n);
  let anyDigit = false;
  for (let i = 0; i < n; i++) {
    const ch = cps[i]!;
    const dv = decimalDigitValue(ch);
    digitVals[i] = dv;
    if (dv !== null) {
      anyDigit = true;
      sepKinds[i] = 0;
    } else {
      sepKinds[i] = separatorKind(ch);
    }
  }
  if (!anyDigit) return { text: normalized, redactions: 0 };

  const spans: Array<[number, number]> = [];
  let redactions = 0;

  let i = 0;
  while (i < n) {
    if (digitVals[i] === null) {
      i += 1;
      continue;
    }

    // The maximal digit/separator region starting here, trimmed so it ends
    // on a digit (a trailing "." is punctuation, not part of the number).
    let j = i;
    let lastDigit = i;
    while (j < n && (digitVals[j] !== null || sepKinds[j] !== 0)) {
      if (digitVals[j] !== null) lastDigit = j;
      j += 1;
    }

    const digitIndexes: number[] = [];
    for (let k = i; k <= lastDigit; k++) {
      if (digitVals[k] !== null) digitIndexes.push(k);
    }

    let p = 0;
    while (p < digitIndexes.length) {
      const maxLen = Math.min(MAX_PAN_DIGITS, digitIndexes.length - p);
      let matchedLen = 0;
      for (let len = maxLen; len >= MIN_PAN_DIGITS; len--) {
        const from = digitIndexes[p]!;
        const to = digitIndexes[p + len - 1]!;
        if (!spanIsPlausible(cps, digitVals, sepKinds, from, to)) continue;
        const window: number[] = [];
        for (let q = p; q < p + len; q++) window.push(digitVals[digitIndexes[q]!]!);
        if (passesLuhn(window)) {
          matchedLen = len;
          break;
        }
      }
      if (matchedLen > 0) {
        spans.push([digitIndexes[p]!, digitIndexes[p + matchedLen - 1]! + 1]);
        redactions += 1;
        p += matchedLen;
      } else {
        p += 1;
      }
    }

    i = lastDigit + 1;
  }

  if (spans.length === 0) return { text: normalized, redactions: 0 };

  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += cps.slice(cursor, start).join("") + REDACTION_MARKER;
    cursor = end;
  }
  out += cps.slice(cursor).join("");
  return { text: out, redactions };
}

/** M-1: a JSON *number* (not just a string) whose decimal form is a
 * Luhn-valid 13-19 digit span — e.g. a model emitting `"card_number":
 * 4111111111111111` instead of a string — must not survive into
 * `extraction_raw` either. `4111111111111111 < 2^53`, so no precision is
 * lost converting to a string first. Redacting changes the value's JSON
 * type from number to string; acceptable here since `extraction_raw` is
 * schemaless jsonb and correctness beats type fidelity for this one
 * (intentionally rare) case. */
function scrubNumber(value: number): { scrubbed: number | string; redactions: number } {
  const { text, redactions } = scrubString(String(value));
  return { scrubbed: redactions > 0 ? text : value, redactions };
}

export type ScrubResult<T> = { scrubbed: T; redactions: number };

/**
 * Recursively walks a parsed value (the tool-use `input`, or anything else
 * that might carry model-generated text) and redacts every Luhn-valid
 * 13-19 digit sequence found in any string OR number, at any depth —
 * object keys and values, array elements, nested item descriptions, all of
 * it (M-1: object keys are scrubbed too, not just values).
 */
export function scrubLuhnSequences<T>(value: T): ScrubResult<T> {
  if (typeof value === "string") {
    const { text, redactions } = scrubString(value);
    return { scrubbed: text as T, redactions };
  }

  if (typeof value === "number") {
    const { scrubbed, redactions } = scrubNumber(value);
    return { scrubbed: scrubbed as T, redactions };
  }

  if (Array.isArray(value)) {
    let redactions = 0;
    const scrubbed = value.map((item) => {
      const result = scrubLuhnSequences(item);
      redactions += result.redactions;
      return result.scrubbed;
    });
    return { scrubbed: scrubbed as T, redactions };
  }

  if (value !== null && typeof value === "object") {
    let redactions = 0;
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const keyResult = scrubString(key);
      redactions += keyResult.redactions;
      const entryResult = scrubLuhnSequences(entry);
      redactions += entryResult.redactions;
      scrubbed[keyResult.text] = entryResult.scrubbed;
    }
    return { scrubbed: scrubbed as T, redactions };
  }

  return { scrubbed: value, redactions: 0 };
}

/**
 * `card_last4` gets its own, stricter check regardless of what the scrub
 * above did: exactly 4 digits, or null. Anything else — a longer number
 * that slipped past the model's own instruction, a masked value like
 * "**1234", non-digit characters — becomes null rather than trusted.
 * CLAUDE.md: "card_last4 is exactly four digits or null. Never the full
 * number."
 */
export function normalizeCardLast4(value: unknown): string | null {
  // `unknown`, not `string | null | undefined` (F-24). `RegExp.test`
  // STRINGIFIES its argument, so the old signature was load-bearing and the
  // compiler could not hold it up: `/^\d{4}$/.test(["1234"])` is `true`, and
  // the array was then returned as if it were a string and written to
  // `receipts.card_last4`. A non-string is not a card_last4.
  //
  // `undefined` is handled by the same check: model output can omit a field
  // entirely, and a missing card_last4 is the same fact as an absent one.
  if (typeof value !== "string") return null;
  return /^\d{4}$/.test(value) ? value : null;
}
