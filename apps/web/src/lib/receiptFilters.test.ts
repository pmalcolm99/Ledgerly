import { describe, expect, it } from "vitest";

import { exportSearch, exportUrl, hasAnyFilter, parseReceiptFilters } from "./receiptFilters";

/**
 * apps/web/src/lib/receiptFilters.test.ts — the URL-to-filter mapping.
 *
 * This module exists because the mapping had a trap in it and three call
 * sites: the URL says `category`, `receipts.list` says `categoryId`. The
 * export forwards the former and the dashboard consumes the latter, so a
 * mistranslation would show one filter on screen and put a different one in
 * the spreadsheet, silently.
 */

describe("parseReceiptFilters", () => {
  it("translates `category` to `categoryId`", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseReceiptFilters(`?category=${id}`).categoryId).toBe(id);
  });

  it("maps every absent or empty filter to undefined, never null or empty string", () => {
    const filters = parseReceiptFilters("?from=&to=&category=&uploadedBy=");
    expect(filters).toEqual({
      from: undefined,
      to: undefined,
      categoryId: undefined,
      uploadedBy: undefined,
      needsReview: undefined,
    });
  });

  it("reads needsReview as strictly `1`", () => {
    expect(parseReceiptFilters("?needsReview=1").needsReview).toBe(true);
    expect(parseReceiptFilters("?needsReview=0").needsReview).toBeUndefined();
    expect(parseReceiptFilters("?needsReview=true").needsReview).toBeUndefined();
  });

  it("accepts a URLSearchParams as well as a raw string", () => {
    const params = new URLSearchParams("from=2026-01-01");
    expect(parseReceiptFilters(params).from).toBe("2026-01-01");
  });
});

describe("hasAnyFilter", () => {
  it("is false only when nothing is set", () => {
    expect(hasAnyFilter(parseReceiptFilters(""))).toBe(false);
    expect(hasAnyFilter(parseReceiptFilters("?needsReview=1"))).toBe(true);
    expect(hasAnyFilter(parseReceiptFilters("?from=2026-01-01"))).toBe(true);
  });
});

describe("exportSearch", () => {
  it("forwards only the five known filters, plus the format", () => {
    const search = exportSearch(
      "?from=2026-01-01&to=2026-06-30&category=abc&uploadedBy=def&needsReview=1&utm_source=email&sort=merchant",
      "xlsx",
    );
    expect(search).toBe(
      "from=2026-01-01&to=2026-06-30&category=abc&uploadedBy=def&needsReview=1&format=xlsx",
    );
  });

  it("is stable in parameter order regardless of the URL's order", () => {
    const a = exportSearch("?needsReview=1&to=2026-06-30&from=2026-01-01", "csv");
    const b = exportSearch("?from=2026-01-01&needsReview=1&to=2026-06-30", "csv");
    expect(a).toBe(b);
  });

  it("omits absent filters entirely rather than sending empty values", () => {
    expect(exportSearch("?from=&category=", "xlsx")).toBe("format=xlsx");
  });
});

describe("exportUrl", () => {
  it("builds the download path for a project", () => {
    expect(exportUrl("p1", "?needsReview=1", "csv")).toBe(
      "/api/projects/p1/export?needsReview=1&format=csv",
    );
  });
});
