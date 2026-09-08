import { describe, expect, it } from "vitest";

import { addMoney, formatMoney, parseMoney } from "./money";

/**
 * A tiny seeded PRNG (mulberry32) so the property tests below are
 * deterministic — a fixed seed means a failure is reproducible by
 * construction, rather than requiring `Math.random()`'s state to be
 * captured and replayed after the fact (task 4.8 follow-up review finding,
 * L-8: the boundary-case table added alongside this addressed some of the
 * concern, but the random sweep itself was still unseeded).
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("parseMoney", () => {
  it("parses whole dollars", () => {
    expect(parseMoney("20")).toBe(2000);
  });

  it("parses two-decimal amounts", () => {
    expect(parseMoney("19.99")).toBe(1999);
  });

  it("pads a single fractional digit", () => {
    expect(parseMoney("1.5")).toBe(150);
  });

  it("parses negative amounts", () => {
    expect(parseMoney("-4.50")).toBe(-450);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseMoney("  3.00  ")).toBe(300);
  });

  it.each(["abc", "1.999", "1.2.3", "", "-", "1-"])("rejects malformed input %j", (input) => {
    expect(() => parseMoney(input)).toThrow();
  });
});

describe("formatMoney", () => {
  it("formats whole dollars with two decimals", () => {
    expect(formatMoney(2000)).toBe("20.00");
  });

  it("formats cents under a dollar with a leading zero", () => {
    expect(formatMoney(5)).toBe("0.05");
  });

  it("formats negative cents", () => {
    expect(formatMoney(-450)).toBe("-4.50");
  });

  it("rejects non-integer input", () => {
    expect(() => formatMoney(19.99)).toThrow();
  });

  it("rejects an unsafe integer, even though Number.isInteger would accept it (task 4.8 finding L-4)", () => {
    expect(() => formatMoney(2 ** 60)).toThrow();
  });

  it("rejects a value outside numeric(12,2)'s range (task 4.8 finding L-5)", () => {
    expect(() => formatMoney(999_999_999_999 + 1)).toThrow();
    expect(() => formatMoney(-(999_999_999_999 + 1))).toThrow();
  });

  it("accepts numeric(12,2)'s exact boundary", () => {
    expect(formatMoney(999_999_999_999)).toBe("9999999999.99");
    expect(formatMoney(-999_999_999_999)).toBe("-9999999999.99");
  });
});

describe("addMoney", () => {
  it("19.99 + 0.01 === 20.00 exactly", () => {
    expect(addMoney("19.99", "0.01")).toBe("20.00");
  });

  it("does not reproduce the classic 0.1 + 0.2 float error", () => {
    expect(addMoney("0.10", "0.20")).toBe("0.30");
  });

  it("rejects a sum that would exceed numeric(12,2)'s range (task 4.8 finding L-5)", () => {
    expect(() => addMoney("9999999999.99", "9999999999.99")).toThrow();
  });
});

// Boundary cases a random sweep might never happen to hit, table-driven so
// a failure is reproducible on its own (task 4.8 review finding L-8 — the
// property test below is unseeded, so any failure it did find would not
// be).
describe.each([
  { cents: 0, formatted: "0.00" },
  { cents: 1, formatted: "0.01" },
  { cents: 99, formatted: "0.99" },
  { cents: 100, formatted: "1.00" },
  { cents: -1, formatted: "-0.01" },
  { cents: 999_999_999_999, formatted: "9999999999.99" },
  { cents: -999_999_999_999, formatted: "-9999999999.99" },
])("money.ts — boundary case $cents cents", ({ cents, formatted }) => {
  it(`formatMoney(${cents}) === "${formatted}"`, () => {
    expect(formatMoney(cents)).toBe(formatted);
  });

  it(`parseMoney("${formatted}") === ${cents}`, () => {
    expect(parseMoney(formatted)).toBe(cents);
  });
});

describe("money.ts — property: addMoney matches integer-cent ground truth over 10,000 random pairs", () => {
  it("agrees with direct cent addition", () => {
    const random = mulberry32(0xc0ffee);
    for (let i = 0; i < 10_000; i++) {
      const aCents = Math.floor(random() * 10_000_000); // up to $100,000.00
      const bCents = Math.floor(random() * 10_000_000);
      const a = formatMoney(aCents);
      const b = formatMoney(bCents);
      expect(addMoney(a, b)).toBe(formatMoney(aCents + bCents));
    }
  });

  it("round-trips formatMoney(parseMoney(x)) === x across a random range, including negatives", () => {
    const random = mulberry32(0xdeadbeef);
    for (let i = 0; i < 10_000; i++) {
      const cents = Math.floor(random() * 20_000_000) - 10_000_000;
      const formatted = formatMoney(cents);
      expect(parseMoney(formatted)).toBe(cents);
    }
  });
});
