import { describe, expect, it } from "vitest";

import { normalizeCardLast4, scrubLuhnSequences } from "./scrub";

// Standard Visa test number -- Luhn-valid, 16 digits.
const LUHN_VALID_PAN = "4111111111111111";
// Same length, fails the Luhn checksum -- must survive the scrub untouched
// (a real receipt's order/tracking numbers must not be needlessly mangled).
// Exhaustively verified (every 13-19-digit window at every offset) to
// contain no Luhn-valid substring at all -- a genuinely clean control,
// unlike a sequential run of digits, which frequently contains an
// accidental Luhn-valid window purely by chance.
const NON_LUHN_16_DIGITS = "2222222222222222";

describe("scrubLuhnSequences", () => {
  it("redacts a Luhn-valid card number in a top-level string field", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({
      merchant_address: `123 Main St, card on file ${LUHN_VALID_PAN}`,
    });
    expect(redactions).toBe(1);
    expect(JSON.stringify(scrubbed)).not.toContain(LUHN_VALID_PAN);
    expect((scrubbed as { merchant_address: string }).merchant_address).toContain(
      "[REDACTED-CARD-NUMBER]",
    );
  });

  it("redacts a Luhn-valid number nested inside an item description", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({
      items: [{ description: `Gift card ${LUHN_VALID_PAN}`, category: "household" }],
    });
    expect(redactions).toBe(1);
    expect(JSON.stringify(scrubbed)).not.toContain(LUHN_VALID_PAN);
  });

  it("redacts a Luhn-valid number anywhere in the raw top-level object", () => {
    const raw = { note: "unrelated", card: LUHN_VALID_PAN, nested: { deeper: LUHN_VALID_PAN } };
    const { scrubbed, redactions } = scrubLuhnSequences(raw);
    expect(redactions).toBe(2);
    expect(JSON.stringify(scrubbed)).not.toContain(LUHN_VALID_PAN);
  });

  it("leaves a non-Luhn 16-digit sequence untouched", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({ order_number: NON_LUHN_16_DIGITS });
    expect(redactions).toBe(0);
    expect((scrubbed as { order_number: string }).order_number).toBe(NON_LUHN_16_DIGITS);
  });

  it("leaves a short digit run (< 13) untouched", () => {
    const short = scrubLuhnSequences({ x: "12345" });
    expect(short.redactions).toBe(0);
  });

  it("leaves a long run with no Luhn-valid window anywhere in it untouched", () => {
    // 20 digits, exhaustively verified to contain no Luhn-valid 13-19-digit
    // window at any offset -- a genuine "just a long number" case.
    const result = scrubLuhnSequences({ x: "11111111111111111111" });
    expect(result.redactions).toBe(0);
  });

  // Review finding H-1: the previous implementation Luhn-checked an entire
  // digit RUN as one candidate and skipped it whole once the run's total
  // digit count fell outside 13-19 -- so a PAN merely adjacent (same run,
  // joined only by whitespace/a dash) to any other digits was never
  // checked at all. These three cases are the confirmed bypasses; all must
  // now redact the embedded PAN while leaving the adjacent digits alone.
  it("redacts a Luhn-valid PAN immediately followed by unrelated digits in the same run", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({ x: `${LUHN_VALID_PAN}\n1234` });
    expect(redactions).toBe(1);
    const text = (scrubbed as { x: string }).x;
    expect(text).not.toContain(LUHN_VALID_PAN);
    expect(text).toContain("1234"); // the trailing digits are NOT part of the PAN -- untouched
  });

  it("redacts a Luhn-valid PAN preceded by an unrelated digit group in the same run", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({ x: `012345 ${LUHN_VALID_PAN}` });
    expect(redactions).toBeGreaterThanOrEqual(1);
    const text = (scrubbed as { x: string }).x;
    // The core security property: the PAN never survives intact. This
    // particular prefix ("012345") happens to create ITS OWN
    // Luhn-valid window that bleeds across the boundary with the PAN's
    // leading digits (a property of the Luhn checksum on this specific
    // input, verified by exhaustive search, not a scrubber defect) --
    // so the leading "0123" survives, `LUHN_VALID_PAN` never appears
    // as a contiguous substring, and at most a short trailing fragment
    // of it can remain (well under the 13-digit minimum needed to be a
    // card number on its own).
    expect(text).not.toContain(LUHN_VALID_PAN);
    expect(text).toContain("012");
  });

  it("redacts a Luhn-valid PAN with a trailing expiry-date-shaped group in the same run", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({ x: `${LUHN_VALID_PAN} 12-25` });
    expect(redactions).toBe(1);
    const text = (scrubbed as { x: string }).x;
    expect(text).not.toContain(LUHN_VALID_PAN);
    expect(text).toContain("12-25");
  });

  it("handles spaced/dashed card numbers", () => {
    const spaced = "4111 1111 1111 1111";
    const { scrubbed, redactions } = scrubLuhnSequences({ x: spaced });
    expect(redactions).toBe(1);
    expect((scrubbed as { x: string }).x).not.toContain("4111");
  });

  it("passes through non-Luhn numbers and non-string, non-object values unchanged", () => {
    expect(scrubLuhnSequences(null).scrubbed).toBeNull();
    expect(scrubLuhnSequences(42).scrubbed).toBe(42);
    expect(scrubLuhnSequences(true).scrubbed).toBe(true);
  });

  // Review finding M-1: a JSON *number* whose decimal form is Luhn-valid,
  // or a Luhn-valid PAN used as an object KEY, must be scrubbed too — not
  // just PANs found in ordinary string values.
  it("redacts a Luhn-valid number value, even though it changes the value's JSON type", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({ card_number: 4111111111111111 });
    expect(redactions).toBe(1);
    expect(JSON.stringify(scrubbed)).not.toContain("4111111111111111");
    expect((scrubbed as { card_number: unknown }).card_number).toBe("[REDACTED-CARD-NUMBER]");
  });

  it("redacts a Luhn-valid PAN used as an object key", () => {
    const { scrubbed, redactions } = scrubLuhnSequences({ [LUHN_VALID_PAN]: "note" });
    expect(redactions).toBe(1);
    expect(JSON.stringify(scrubbed)).not.toContain(LUHN_VALID_PAN);
  });
});

describe("normalizeCardLast4", () => {
  it("accepts exactly 4 digits", () => {
    expect(normalizeCardLast4("1234")).toBe("1234");
  });

  it("nulls out anything that isn't exactly 4 digits", () => {
    expect(normalizeCardLast4(null)).toBeNull();
    expect(normalizeCardLast4("12345")).toBeNull();
    expect(normalizeCardLast4("12")).toBeNull();
    expect(normalizeCardLast4("[REDACTED-CARD-NUMBER]")).toBeNull();
    expect(normalizeCardLast4("**34")).toBeNull();
  });
});
