import { describe, expect, it } from "vitest";

import {
  normalizeConfidence,
  normalizeDate,
  normalizeMoney,
  normalizeQuantity,
  normalizeTime,
} from "./normalize";

describe("normalizeMoney", () => {
  it("passes through a clean decimal string, canonicalized", () => {
    expect(normalizeMoney("12.3")).toBe("12.30");
    expect(normalizeMoney("12")).toBe("12.00");
  });

  /**
   * The Costco credit. This returned null before `canonicalizeMoneySign`
   * existed: the credit disappeared from the receipt entirely, and its
   * absence then made `sum(items)` too high.
   */
  it("reads a credit in every notation a receipt prints", () => {
    expect(normalizeMoney("4.50-")).toBe("-4.50");
    expect(normalizeMoney("(4.50)")).toBe("-4.50");
    expect(normalizeMoney("-4.50")).toBe("-4.50");
    expect(normalizeMoney("$4.50-")).toBe("-4.50");
    expect(normalizeMoney("($1,234.50)")).toBe("-1234.50");
  });

  it("still degrades an ambiguous double sign to null rather than guessing", () => {
    expect(normalizeMoney("(-4.50)")).toBeNull();
  });

  it("strips currency symbols, commas, and whitespace", () => {
    expect(normalizeMoney("$12.34")).toBe("12.34");
    expect(normalizeMoney("1,234.56")).toBe("1234.56");
    expect(normalizeMoney(" 5.00 ")).toBe("5.00");
  });

  it("returns null for null input", () => {
    expect(normalizeMoney(null)).toBeNull();
  });

  it("returns null for unparseable input rather than throwing", () => {
    expect(normalizeMoney("not a number")).toBeNull();
    expect(normalizeMoney("12.34.56")).toBeNull();
  });
});

describe("normalizeQuantity", () => {
  it("accepts up to 3 fractional digits", () => {
    expect(normalizeQuantity("2.5")).toBe("2.5");
    expect(normalizeQuantity("1")).toBe("1");
    expect(normalizeQuantity("0.125")).toBe("0.125");
  });

  it("returns null for null or malformed input", () => {
    expect(normalizeQuantity(null)).toBeNull();
    expect(normalizeQuantity("two")).toBeNull();
  });

  // Review finding H-3: a huge magnitude would overflow numeric(12,3) at
  // insert time rather than degrading to null.
  it("rejects a quantity beyond numeric(12,3)'s range", () => {
    expect(normalizeQuantity("99999999999999")).toBeNull();
    expect(normalizeQuantity("1000000000")).toBeNull(); // just past the bound
    expect(normalizeQuantity("999999999.999")).toBe("999999999.999"); // just inside
  });
});

describe("normalizeConfidence", () => {
  it("passes through a valid 0-1 number unchanged", () => {
    expect(normalizeConfidence(0.85)).toBe(0.85);
    expect(normalizeConfidence(0)).toBe(0);
    expect(normalizeConfidence(1)).toBe(1);
  });

  // Review finding H-3: strict mode's own `type: "number"` constraint
  // *should* guarantee this, but D-12 is Provisional on that -- these are
  // the degrade-to-0 (not clamp-to-bound) cases that keep a garbage value
  // from both violating receipts_confidence_range's CHECK and being
  // silently trusted as "maximally confident."
  it("rejects (to 0, not clamped) a number outside 0-1", () => {
    expect(normalizeConfidence(95)).toBe(0);
    expect(normalizeConfidence(-1)).toBe(0);
    expect(normalizeConfidence(1.5)).toBe(0);
  });

  it("rejects non-numbers and non-finite numbers", () => {
    expect(normalizeConfidence("high")).toBe(0);
    expect(normalizeConfidence(null)).toBe(0);
    expect(normalizeConfidence(undefined)).toBe(0);
    expect(normalizeConfidence(NaN)).toBe(0);
    expect(normalizeConfidence(Infinity)).toBe(0);
  });
});

describe("normalizeDate", () => {
  it("accepts ISO YYYY-MM-DD", () => {
    expect(normalizeDate("2026-01-15")).toBe("2026-01-15");
  });

  it("rejects anything else", () => {
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate("01/15/2026")).toBeNull();
    expect(normalizeDate("not a date")).toBeNull();
  });
});

describe("normalizeTime", () => {
  it("accepts HH:MM and HH:MM:SS", () => {
    expect(normalizeTime("14:30")).toBe("14:30");
    expect(normalizeTime("14:30:00")).toBe("14:30:00");
  });

  it("rejects anything else", () => {
    expect(normalizeTime(null)).toBeNull();
    expect(normalizeTime("2:30pm")).toBeNull();
  });

  /**
   * The regression for the production failure: a model that OMITS a field
   * yields `undefined`, and a `raw === null` guard does not catch it.
   * `normalizeMoney(undefined)` threw
   * `TypeError: Cannot read properties of undefined (reading 'replace')`
   * after a successful, billed API call — surfacing as the generic
   * AI_EXTRACTION_FAILED and burning two more attempts.
   *
   * The schema now requires every field, so this should not arise; these
   * assertions exist because this file's whole job is to not depend on that.
   */
  it("treats undefined exactly like null, never throwing", () => {
    expect(normalizeMoney(undefined)).toBeNull();
    expect(normalizeQuantity(undefined)).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
    expect(normalizeTime(undefined)).toBeNull();
    expect(normalizeConfidence(undefined)).toBe(0);
  });
});
