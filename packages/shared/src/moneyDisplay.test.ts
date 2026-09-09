import { describe, expect, it } from "vitest";

import { formatCentsDisplay, formatMoneyDisplay } from "./moneyDisplay";
import { formatMoney } from "./money";

describe("formatMoneyDisplay", () => {
  it("formats a numeric string with symbol and separators", () => {
    expect(formatMoneyDisplay("1234.50")).toBe("$1,234.50");
    expect(formatMoneyDisplay("0.05")).toBe("$0.05");
  });

  it("normalizes loose but valid numeric shapes", () => {
    expect(formatMoneyDisplay("5")).toBe("$5.00");
    expect(formatMoneyDisplay("05.5")).toBe("$5.50");
  });

  /**
   * The whole point of routing a string through Intl rather than `cents/100`.
   * At the top of `numeric(12,2)`'s range a float divide is still exact, but
   * the property we want is that no float is involved at all, so the test
   * pins the boundary value's exact rendering.
   */
  it("is exact at the numeric(12,2) maximum", () => {
    expect(formatMoneyDisplay("9999999999.99")).toBe("$9,999,999,999.99");
  });

  /** Values that are famously not representable in binary floating point. */
  it("renders values a float would round", () => {
    expect(formatMoneyDisplay("0.10")).toBe("$0.10");
    expect(formatMoneyDisplay("0.70")).toBe("$0.70");
    expect(formatMoneyDisplay("1234567.89")).toBe("$1,234,567.89");
  });

  it("renders an absent amount as a dash, never as zero", () => {
    expect(formatMoneyDisplay(null)).toBe("—");
    expect(formatMoneyDisplay(undefined)).toBe("—");
    expect(formatMoneyDisplay("")).toBe("—");
    // The distinction the review queue depends on.
    expect(formatMoneyDisplay(null)).not.toBe(formatMoneyDisplay("0.00"));
    expect(formatMoneyDisplay("0.00")).toBe("$0.00");
  });

  it("honours an explicit blank placeholder", () => {
    expect(formatMoneyDisplay(null, { blank: "not read" })).toBe("not read");
  });

  it("honours the currency without a picker existing (D-17)", () => {
    expect(formatMoneyDisplay("10.00", { currency: "EUR" })).toBe("€10.00");
  });

  it("returns a malformed value verbatim rather than laundering it into blank", () => {
    // A bug upstream should stay visible and must not be mistaken for absent.
    expect(formatMoneyDisplay("not-a-number")).toBe("not-a-number");
    expect(formatMoneyDisplay("not-a-number")).not.toBe("—");
  });

  it("does not throw on any input", () => {
    for (const bad of ["", "  ", "1.2.3", "abc", "1e5", "-", "0.001"]) {
      expect(() => formatMoneyDisplay(bad)).not.toThrow();
    }
  });
});

describe("formatCentsDisplay", () => {
  it("round-trips integer cents through the same string path", () => {
    expect(formatCentsDisplay(1)).toBe("$0.01");
    expect(formatCentsDisplay(123450)).toBe("$1,234.50");
    expect(formatCentsDisplay(999_999_999_999)).toBe("$9,999,999,999.99");
  });

  it("agrees with formatMoneyDisplay for every value", () => {
    for (const cents of [0, 1, 10, 99, 100, 12345, 999_999_999_999]) {
      expect(formatCentsDisplay(cents)).toBe(formatMoneyDisplay(formatMoney(cents)));
    }
  });

  it("renders absent cents as a dash", () => {
    expect(formatCentsDisplay(null)).toBe("—");
  });
});
