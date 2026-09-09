/**
 * packages/queue/src/pipeline/scrub.ts — the Luhn scrub (task 6.6,
 * ARCHITECTURE.md §6.3, CLAUDE.md hard rule).
 *
 * "Scan all model output for any 13-19 digit sequence that passes a Luhn
 * check and strip it before anything is persisted." This runs BEFORE the
 * tool-input object is parsed into the internal receipt DTO and BEFORE
 * `extraction_raw` is stored — callers must scrub first, then parse the
 * *returned* (scrubbed) value, never the original. An unredacted PAN must
 * never exist in a variable used for persistence, logging, or field
 * mapping, even transiently.
 */

const REDACTION_MARKER = "[REDACTED-CARD-NUMBER]";
const MIN_PAN_DIGITS = 13;
const MAX_PAN_DIGITS = 19;

/** Standard Luhn checksum over a digit-only string. */
function passesLuhn(digitsOnly: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let digit = Number(digitsOnly[i]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// A maximal run of digits/spaces/dashes -- the candidate REGION to scan.
// Deliberately broad: review finding H-1 was that the previous version
// Luhn-checked this whole run as ONE candidate and skipped it entirely
// once the run's total digit count fell outside 13-19 -- so two numbers
// merely adjacent on the same line (a PAN followed by an expiry date, an
// auth code before the PAN, a PAN split across a line wrap) were never
// checked at all. `scrubString` below instead slides a window *within*
// each run, checking every 19-down-to-13-digit span at every offset.
const DIGIT_RUN_PATTERN = /\d(?:[\d\s-]*\d)?/g;

/**
 * Scans one digit run (digits/spaces/dashes only) for every 13-19-digit
 * Luhn-valid span, redacting each and leaving the rest of the run intact.
 * At each digit position, the LONGEST valid window (19 down to 13) wins,
 * so a genuine 16-digit PAN is matched whole rather than accidentally
 * matched short first; a position with no valid window advances by one
 * digit rather than being swallowed into a false full-run match.
 */
function scrubDigitRun(run: string): { text: string; redactions: number } {
  const digitPositions: number[] = []; // digitPositions[i] = index into `run` of the i-th digit
  const digits: string[] = [];
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    if (ch !== undefined && ch >= "0" && ch <= "9") {
      digitPositions.push(i);
      digits.push(ch);
    }
  }

  let redactions = 0;
  let out = "";
  let cursor = 0; // position in `run` already copied into `out`
  let i = 0;
  while (i < digits.length) {
    const maxLen = Math.min(MAX_PAN_DIGITS, digits.length - i);
    let matchedLen = 0;
    for (let len = maxLen; len >= MIN_PAN_DIGITS; len--) {
      if (passesLuhn(digits.slice(i, i + len).join(""))) {
        matchedLen = len;
        break;
      }
    }
    if (matchedLen > 0) {
      const spanStart = digitPositions[i]!;
      const spanEndExclusive = digitPositions[i + matchedLen - 1]! + 1;
      out += run.slice(cursor, spanStart) + REDACTION_MARKER;
      cursor = spanEndExclusive;
      redactions++;
      i += matchedLen;
    } else {
      i += 1;
    }
  }
  out += run.slice(cursor);
  return { text: out, redactions };
}

/**
 * Scans one string for 13-19 digit Luhn-valid spans (spaces/dashes within
 * a run ignored for the Luhn check itself, per CLAUDE.md) and redacts
 * each. A span that fails Luhn (e.g. an order or tracking number) is left
 * untouched — this is deliberately conservative, not a blanket
 * "redact anything digit-shaped" scrub. `normalize("NFKC")` first so
 * full-width digit forms (e.g. U+FF10-FF19) fold to ASCII before scanning
 * (L-6) — a residual gap remains for non-decomposable numeral systems
 * (Arabic-Indic, etc.), judged low-likelihood output from a model that
 * otherwise transcribes receipts as ASCII digits.
 */
function scrubString(value: string): { text: string; redactions: number } {
  const normalized = value.normalize("NFKC");
  let redactions = 0;
  const text = normalized.replace(DIGIT_RUN_PATTERN, (run) => {
    const result = scrubDigitRun(run);
    redactions += result.redactions;
    return result.text;
  });
  return { text, redactions };
}

/** M-1: a JSON *number* (not just a string) whose decimal form is a
 * Luhn-valid 13-19 digit span — e.g. a model emitting `"card_number":
 * 4111111111111111` instead of a string — must not survive into
 * `extraction_raw` either. `4111111111111111 &lt; 2^53`, so no precision is
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
export function normalizeCardLast4(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}$/.test(value) ? value : null;
}
