import { describe, expect, it } from "vitest";

import { runSanityChecks } from "./validate";
import type { ValidationInput } from "./validate";

function baseInput(overrides: Partial<ValidationInput> = {}): ValidationInput {
  return {
    subtotal: "10.00",
    salesTax: "1.00",
    tip: null,
    total: "11.00",
    transactionDate: "2026-01-15",
    items: [{ lineTotal: "10.00" }],
    ...overrides,
  };
}

describe("runSanityChecks", () => {
  it("trips nothing on a clean receipt", () => {
    const result = runSanityChecks(baseInput());
    expect(result).toEqual({ status: "ok", validationFlags: [] });
  });

  it("trips arithmetic_mismatch_total when subtotal + tax != total by more than 2 cents", () => {
    const result = runSanityChecks(baseInput({ total: "20.00" }));
    expect(result.status).toBe("partial");
    expect(result.validationFlags).toContain("arithmetic_mismatch_total");
  });

  it("does not trip arithmetic_mismatch_total within the 2-cent tolerance", () => {
    const result = runSanityChecks(baseInput({ total: "11.02" }));
    expect(result.validationFlags).not.toContain("arithmetic_mismatch_total");
  });

  it("skips the total check when any of subtotal/salesTax/total is null", () => {
    const result = runSanityChecks(baseInput({ salesTax: null }));
    expect(result.validationFlags).not.toContain("arithmetic_mismatch_total");
  });

  // Review finding L-4: a tipped receipt (total = subtotal + tax + tip)
  // must not be flagged as a false-positive arithmetic mismatch.
  it("includes tip in the total check when present", () => {
    const clean = runSanityChecks(baseInput({ tip: "2.00", total: "13.00" }));
    expect(clean.validationFlags).not.toContain("arithmetic_mismatch_total");

    const mismatched = runSanityChecks(baseInput({ tip: "2.00", total: "20.00" }));
    expect(mismatched.validationFlags).toContain("arithmetic_mismatch_total");
  });

  it("treats a null tip as zero, not as skipping the check", () => {
    const result = runSanityChecks(baseInput({ tip: null, total: "11.00" }));
    expect(result.validationFlags).not.toContain("arithmetic_mismatch_total");
  });

  it("trips arithmetic_mismatch_items when line totals don't sum to subtotal by more than $1", () => {
    const result = runSanityChecks(
      baseInput({ items: [{ lineTotal: "5.00" }, { lineTotal: "2.00" }] }),
    );
    expect(result.status).toBe("partial");
    expect(result.validationFlags).toContain("arithmetic_mismatch_items");
  });

  it("does not trip arithmetic_mismatch_items within the $1 tolerance", () => {
    const result = runSanityChecks(baseInput({ items: [{ lineTotal: "9.50" }] }));
    expect(result.validationFlags).not.toContain("arithmetic_mismatch_items");
  });

  it("skips the items check when there are no line totals at all", () => {
    const result = runSanityChecks(baseInput({ items: [{ lineTotal: null }] }));
    expect(result.validationFlags).not.toContain("arithmetic_mismatch_items");
  });

  it("trips date_in_future for a date after today", () => {
    const result = runSanityChecks(baseInput({ transactionDate: "2099-01-01" }));
    expect(result.status).toBe("partial");
    expect(result.validationFlags).toContain("date_in_future");
  });

  it("trips date_too_old for a date before 2000-01-01", () => {
    const result = runSanityChecks(baseInput({ transactionDate: "1999-12-31" }));
    expect(result.status).toBe("partial");
    expect(result.validationFlags).toContain("date_too_old");
  });

  it("skips the date check when transactionDate is null", () => {
    const result = runSanityChecks(baseInput({ transactionDate: null }));
    expect(result.validationFlags).not.toContain("date_in_future");
    expect(result.validationFlags).not.toContain("date_too_old");
  });

  it("trips more than one flag simultaneously", () => {
    const result = runSanityChecks(baseInput({ total: "999.00", transactionDate: "1990-01-01" }));
    expect(result.status).toBe("partial");
    expect(result.validationFlags).toContain("arithmetic_mismatch_total");
    expect(result.validationFlags).toContain("date_too_old");
    expect(result.validationFlags).toHaveLength(2);
  });
});
