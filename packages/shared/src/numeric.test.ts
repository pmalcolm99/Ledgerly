import { describe, expect, it } from "vitest";

import { formatConfidencePercent, formatQuantityDisplay, parseQuantityInput } from "./numeric";
import { parseMoney } from "./money";

describe("parseQuantityInput", () => {
  it("normalizes to numeric(12,3)'s scale", () => {
    expect(parseQuantityInput("2")).toBe("2.000");
    expect(parseQuantityInput("1.5")).toBe("1.500");
    expect(parseQuantityInput("0.125")).toBe("0.125");
  });

  /**
   * The reason this module exists: `money.ts` is scale-2 by construction and
   * throws on a third fractional digit, but `receipt_items.quantity` is
   * numeric(12,3) and "0.125" is ordinary data (an eighth of a pound).
   */
  it("accepts three decimals, which parseMoney rejects", () => {
    expect(() => parseMoney("0.125")).toThrow();
    expect(parseQuantityInput("0.125")).toBe("0.125");
  });

  it("rejects a fourth decimal and non-numeric input", () => {
    expect(() => parseQuantityInput("0.1255")).toThrow();
    expect(() => parseQuantityInput("abc")).toThrow();
    expect(() => parseQuantityInput("")).toThrow();
  });

  it("rejects values beyond numeric(12,3)'s range", () => {
    expect(() => parseQuantityInput("1234567890")).toThrow();
    expect(parseQuantityInput("999999999")).toBe("999999999.000");
  });
});

describe("formatQuantityDisplay", () => {
  it("strips the padding Postgres adds", () => {
    expect(formatQuantityDisplay("2.000")).toBe("2");
    expect(formatQuantityDisplay("1.500")).toBe("1.5");
    expect(formatQuantityDisplay("0.125")).toBe("0.125");
  });

  it("renders absent as empty", () => {
    expect(formatQuantityDisplay(null)).toBe("");
    expect(formatQuantityDisplay(undefined)).toBe("");
  });

  it("does not mangle a whole number with no decimal point", () => {
    expect(formatQuantityDisplay("12")).toBe("12");
    expect(formatQuantityDisplay("0.000")).toBe("0");
  });
});

describe("formatConfidencePercent", () => {
  it("converts numeric(4,3) to a whole percentage", () => {
    expect(formatConfidencePercent("0.875")).toBe(88);
    expect(formatConfidencePercent("1.000")).toBe(100);
    expect(formatConfidencePercent("0.000")).toBe(0);
  });

  it("returns null for absent or unparseable confidence", () => {
    expect(formatConfidencePercent(null)).toBeNull();
    expect(formatConfidencePercent("")).toBeNull();
    expect(formatConfidencePercent("abc")).toBeNull();
  });
});
