import { describe, expect, it } from "vitest";

import { ExportQueryError, describeFilters, parseExportQuery } from "./filters";

const q = (search: string): URLSearchParams => new URLSearchParams(search);

describe("parseExportQuery", () => {
  it("defaults to xlsx and no filters", () => {
    expect(parseExportQuery(q(""))).toEqual({ format: "xlsx", filters: {} });
  });

  it("maps the UI's `category` param onto the API's `categoryId`", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseExportQuery(q(`category=${id}`)).filters).toEqual({ categoryId: id });
  });

  it("treats needsReview=1 as true and anything else as absent", () => {
    expect(parseExportQuery(q("needsReview=1")).filters.needsReview).toBe(true);
    expect(parseExportQuery(q("needsReview=0")).filters.needsReview).toBeUndefined();
    expect(parseExportQuery(q("")).filters.needsReview).toBeUndefined();
  });

  it("ignores unknown parameters rather than rejecting the export", () => {
    const parsed = parseExportQuery(q("utm_source=email&sort=merchant&format=csv"));
    expect(parsed).toEqual({ format: "csv", filters: {} });
  });

  it("rejects an unknown format", () => {
    expect(() => parseExportQuery(q("format=pdf"))).toThrow(ExportQueryError);
  });

  it("rejects a malformed date and a non-uuid id", () => {
    expect(() => parseExportQuery(q("from=03/04/2026"))).toThrow(ExportQueryError);
    expect(() => parseExportQuery(q("category=lumber"))).toThrow(ExportQueryError);
    expect(() => parseExportQuery(q("uploadedBy=me"))).toThrow(ExportQueryError);
  });

  it("rejects an inverted date range, matching receipts.list's own refine", () => {
    expect(() => parseExportQuery(q("from=2026-06-01&to=2026-01-01"))).toThrow(ExportQueryError);
    // Equal endpoints are a valid single-day range.
    expect(() => parseExportQuery(q("from=2026-06-01&to=2026-06-01"))).not.toThrow();
  });

  it("never leaks anything but the parameter name in its message", () => {
    try {
      parseExportQuery(q("from=not-a-date"));
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toBe("Invalid export parameter: from.");
    }
  });
});

describe("describeFilters", () => {
  const CATEGORY = "22222222-2222-4222-8222-222222222222";
  const USER = "33333333-3333-4333-8333-333333333333";

  it("says `none` when nothing is filtered", () => {
    expect(describeFilters({})).toBe("none");
  });

  it("describes a full filter set deterministically", () => {
    const text = describeFilters(
      {
        from: "2026-01-01",
        to: "2026-06-30",
        categoryId: CATEGORY,
        uploadedBy: USER,
        needsReview: true,
      },
      { categoryName: "Lumber", uploaderName: "Preston M." },
    );

    expect(text).toBe(
      `dates 2026-01-01 to 2026-06-30; category Lumber [${CATEGORY}]; uploaded by Preston M. [${USER}]; needs review only`,
    );
  });

  it("handles a one-sided date range", () => {
    expect(describeFilters({ from: "2026-01-01" })).toBe("dates from 2026-01-01");
    expect(describeFilters({ to: "2026-06-30" })).toBe("dates through 2026-06-30");
  });

  /**
   * The id is written alongside the name precisely so a renamed or deleted
   * category does not make an old export unreproducible — the name is what a
   * human reads, the id is what actually reruns the query.
   */
  it("still records the id when the name cannot be resolved", () => {
    expect(describeFilters({ categoryId: CATEGORY })).toBe(`category (deleted) [${CATEGORY}]`);
  });
});
