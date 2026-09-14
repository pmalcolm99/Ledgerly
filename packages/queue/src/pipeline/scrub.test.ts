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

/**
 * Phase 10a finding F-23. The candidate-region pattern was `[\d\s-]` --
 * digits, whitespace and ASCII hyphen only -- so a PAN written with any
 * other separator split into four four-digit runs, every one of them below
 * the 13-digit floor, and the sliding Luhn window never looked at it. Each
 * case below was confirmed to LEAK on the previous implementation.
 *
 * These are regression tests in the strict sense: they fail on the code as
 * it shipped through Phase 9.
 */
describe("scrubLuhnSequences: separator and numeral coverage (F-23)", () => {
  const SEPARATED: ReadonlyArray<[string, string]> = [
    ["full stop", "4111.1111.1111.1111"],
    ["solidus", "4111/1111/1111/1111"],
    ["reverse solidus", "4111\\1111\\1111\\1111"],
    ["asterisk", "4111*1111*1111*1111"],
    ["underscore", "4111_1111_1111_1111"],
    ["vertical bar", "4111|1111|1111|1111"],
    ["hyphen U+2010", "4111\u20101111\u20101111\u20101111"],
    ["non-breaking hyphen U+2011", "4111\u20111111\u20111111\u20111111"],
    ["figure dash U+2012", "4111\u20121111\u20121111\u20121111"],
    ["en dash U+2013", "4111\u20131111\u20131111\u20131111"],
    ["em dash U+2014", "4111\u20141111\u20141111\u20141111"],
    ["horizontal bar U+2015", "4111\u20151111\u20151111\u20151111"],
    ["minus sign U+2212", "4111\u22121111\u22121111\u22121111"],
    ["middle dot U+00B7", "4111\u00b71111\u00b71111\u00b71111"],
    ["bullet U+2022", "4111\u20221111\u20221111\u20221111"],
    ["hyphenation point U+2027", "4111\u20271111\u20271111\u20271111"],
    ["no-break space U+00A0", "4111\u00a01111\u00a01111\u00a01111"],
    ["narrow no-break space U+202F", "4111\u202f1111\u202f1111\u202f1111"],
    ["thin space U+2009", "4111\u20091111\u20091111\u20091111"],
    ["newline (a line wrap)", "4111\n1111\n1111\n1111"],
    ["mixed separators", "4111-1111.1111 1111"],
  ];

  it.each(SEPARATED)("redacts a PAN separated by %s", (_label, written) => {
    const { scrubbed, redactions } = scrubLuhnSequences({ user_notes: written });
    expect(redactions).toBe(1);
    expect((scrubbed as { user_notes: string }).user_notes).toBe("[REDACTED-CARD-NUMBER]");
  });

  // NFKC folds fullwidth digits to ASCII but does nothing for these, so the
  // old implementation never saw them as digits at all.
  const NUMERALS: ReadonlyArray<[string, string]> = [
    [
      "Arabic-Indic",
      "\u0664\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661",
    ],
    [
      "Extended Arabic-Indic",
      "\u06f4\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1\u06f1",
    ],
    [
      "Devanagari",
      "\u096a\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967\u0967",
    ],
    [
      "Bengali",
      "\u09ea\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7\u09e7",
    ],
    [
      "Thai",
      "\u0e54\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51\u0e51",
    ],
    [
      "fullwidth",
      "\uff14\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11",
    ],
  ];

  it.each(NUMERALS)("redacts a PAN written in %s numerals", (_label, written) => {
    const { redactions } = scrubLuhnSequences({ merchant_address: written });
    expect(redactions).toBe(1);
  });

  it("redacts a 15-digit Amex in its conventional 4-6-5 grouping", () => {
    const { scrubbed, redactions } = scrubLuhnSequences("3782 822463 10005");
    expect(redactions).toBe(1);
    expect(scrubbed).toBe("[REDACTED-CARD-NUMBER]");
  });

  // The other half of the trade. Widening the separator class lets the
  // window join up more digits, so the characters that most often group
  // NON-card numbers are deliberately excluded -- see the note beside the
  // separator tiers. Without that exclusion a comma list or a timestamp
  // becomes a redaction.
  // The regression the FIRST attempt at F-23 introduced, which matters more
  // than the leak it closed. Admitting "." as a separator unconditionally
  // made a whitespace-separated price list ONE contiguous digit region, and
  // a sliding Luhn window over ~18 digits finds a "valid" span with
  // probability near 1. A user typing prices into a receipt note watched
  // them become [REDACTED-CARD-NUMBER] -- silently, and with no undo.
  //
  // Every case here was measured MANGLED by that attempt.
  const PRICE_LISTS: ReadonlyArray<[string, string]> = [
    ["space-separated prices", "Items: 12.99 4.50 3.25 8.75 1.99 6.20"],
    ["round amounts", "prices 10.00 20.00 30.00 40.00 5.99"],
    ["one per line", "split across lines:\n12.50\n33.10\n44.20\n9.99\n1.25"],
    ["a running tally", "8.99 + 12.00 + 3.50 + 44.25 + 1.75 + 6.00"],
    ["quantities and prices", "2 x 3.99  1 x 12.50  4 x 0.99  3 x 22.10"],
  ];

  it.each(PRICE_LISTS)("leaves %s alone", (_label, written) => {
    const { scrubbed, redactions } = scrubLuhnSequences({ user_notes: written });
    expect(redactions).toBe(0);
    expect((scrubbed as { user_notes: string }).user_notes).toBe(written);
  });

  // Judging plausibility per REGION rather than per candidate span would
  // miss this: the region carries a 2-digit group that has nothing to do
  // with the card.
  it("still finds a separated PAN that follows an unrelated short number", () => {
    const { scrubbed, redactions } = scrubLuhnSequences("order 12 card 4111.1111.1111.1111");
    expect(redactions).toBe(1);
    expect(scrubbed).toBe("order 12 card [REDACTED-CARD-NUMBER]");
  });

  // Card lengths that are not a multiple of four end in a short remainder
  // when written in the usual groups of four. Requiring EVERY group to meet
  // the floor rejected all of these outright, so a Luhn-valid PAN reached
  // extraction_raw, user_notes, the export and the backup archive in
  // cleartext. Only the final group is exempt -- a price list puts its
  // 2-digit cents group in the middle of the span too, so it still fails.
  const SHORT_FINAL_GROUP: ReadonlyArray<[string, string]> = [
    ["13-digit, full stops", "4307.4185.2963.7"],
    ["14-digit Diners shape, full stops", "3056.3074.1852.90"],
    ["17-digit, solidus", "4307/4185/2963/0741/6"],
    ["18-digit Maestro shape, asterisk", "4307*4185*2963*0741*89"],
  ];

  it.each(SHORT_FINAL_GROUP)("redacts a %s PAN", (_label, written) => {
    const { redactions } = scrubLuhnSequences({ user_notes: written });
    expect(redactions).toBe(1);
  });

  const MUST_SURVIVE: ReadonlyArray<[string, string]> = [
    ["a money amount", "Total 1,234.56 plus tax 98.76"],
    ["a timestamp", "12:34:56 on 2026-09-13"],
    ["a comma-separated reference list", "refs 1234, 5678, 9012, 3456"],
    ["a phone number", "+1 555 010 4477"],
    ["a short order number", "order 12345"],
    ["a non-Luhn 16-digit run", NON_LUHN_16_DIGITS],
  ];

  it.each(MUST_SURVIVE)("leaves %s untouched", (_label, written) => {
    const { scrubbed, redactions } = scrubLuhnSequences(written);
    expect(redactions).toBe(0);
    expect(scrubbed).toBe(written);
  });

  it("emits non-redacted text verbatim, including non-ASCII digits", () => {
    // Scanning transliterates, but output must not: a Devanagari invoice
    // number that is not a card has to come back exactly as it went in.
    const written = "invoice \u0967\u0968\u0969 for \u20b91,200";
    const { scrubbed, redactions } = scrubLuhnSequences(written);
    expect(redactions).toBe(0);
    expect(scrubbed).toBe(written);
  });

  it("redacts each of two PANs in one string independently", () => {
    const { scrubbed, redactions } = scrubLuhnSequences(
      "old 4111.1111.1111.1111 new 5555-5555-5555-4444",
    );
    expect(redactions).toBe(2);
    expect(scrubbed).toBe("old [REDACTED-CARD-NUMBER] new [REDACTED-CARD-NUMBER]");
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
