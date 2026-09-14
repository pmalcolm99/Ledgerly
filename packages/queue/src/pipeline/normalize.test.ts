import { describe, expect, it } from "vitest";

import {
  normalizeConfidence,
  normalizeDate,
  normalizeMoney,
  normalizeQuantity,
  normalizeTime,
} from "./normalize";
import { itemsReconcile } from "@ledgerly/shared/receiptValidation";

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

/**
 * Phase 10a finding F-24. The declared parameter type was
 * `string | null | undefined`, which the compiler honoured and the model
 * did not: these are fed from parsed JSON, so a number, an object or an
 * array reaches them at runtime. `normalizeMoney(12.34)` used to throw
 * `raw.replace is not a function` AFTER a billed API call, failing the
 * receipt with no extracted data at all.
 *
 * Every case below throws on the pre-fix implementation.
 */
describe("non-string model output (F-24)", () => {
  const NON_STRINGS: ReadonlyArray<[string, unknown]> = [
    ["a JSON number", 12.34],
    ["an integer", 1234],
    ["zero", 0],
    ["a boolean", true],
    ["an object", { amount: "12.34" }],
    ["an array", ["12.34"]],
    ["NaN", Number.NaN],
  ];

  it.each(NON_STRINGS)("normalizeMoney returns null for %s", (_label, value) => {
    expect(() => normalizeMoney(value)).not.toThrow();
    expect(normalizeMoney(value)).toBeNull();
  });

  it.each(NON_STRINGS)("normalizeQuantity returns null for %s", (_label, value) => {
    expect(() => normalizeQuantity(value)).not.toThrow();
    expect(normalizeQuantity(value)).toBeNull();
  });

  it.each(NON_STRINGS)("normalizeDate returns null for %s", (_label, value) => {
    expect(() => normalizeDate(value)).not.toThrow();
    expect(normalizeDate(value)).toBeNull();
  });

  it.each(NON_STRINGS)("normalizeTime returns null for %s", (_label, value) => {
    expect(() => normalizeTime(value)).not.toThrow();
    expect(normalizeTime(value)).toBeNull();
  });

  it("still parses a legitimate string after the widening", () => {
    expect(normalizeMoney("12.3")).toBe("12.30");
    expect(normalizeDate("2026-09-13")).toBe("2026-09-13");
  });
});

/**
 * F-24, second pass. The first fix widened the normalizers but missed
 * `pricedItems`, which fed `item.line_total ?? null` straight into
 * `itemsReconcile` -> `parseMoney` -> `numeric.trim()`. A numeric
 * `line_total` is the likeliest non-string the model emits, and the throw
 * landed OUTSIDE `retryIfItemsDoNotReconcile`'s try block, in a function
 * documented as never throwing.
 */
describe("itemsReconcile with non-string model money (F-24)", () => {
  it("does not throw when subtotal is a JSON number", () => {
    expect(() =>
      itemsReconcile({ subtotal: normalizeMoney(12.34), items: [{ lineTotal: "12.34" }] }),
    ).not.toThrow();
  });

  it("does not throw when a line total is a JSON number", () => {
    expect(() =>
      itemsReconcile({
        subtotal: normalizeMoney("12.34"),
        items: [{ lineTotal: normalizeMoney(4.5) }],
      }),
    ).not.toThrow();
  });

  it("still reconciles correctly for well-formed strings", () => {
    const result = itemsReconcile({
      subtotal: normalizeMoney("10.00"),
      items: [{ lineTotal: normalizeMoney("4.00") }, { lineTotal: normalizeMoney("6.00") }],
    });
    expect(result?.reconciles).toBe(true);
  });
});
