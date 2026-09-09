import { describe, expect, it } from "vitest";

import { SLUG_PATTERN, slugify, slugifyOr } from "./slug";

describe("slugify", () => {
  it("lowercases and joins words with single dashes", () => {
    expect(slugify("Building Supplies")).toBe("building-supplies");
    expect(slugify("Tools & Equipment")).toBe("tools-equipment");
    expect(slugify("Kitchen  Remodel -- 2026")).toBe("kitchen-remodel-2026");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  ...Lumber!  ")).toBe("lumber");
  });

  it("caps at 80 characters without leaving a trailing dash", () => {
    // 'a' * 79 + ' ' + 'b' -> the 80-char slice lands exactly on the dash.
    const slug = slugify(`${"a".repeat(79)} b`);
    expect(slug).toBe("a".repeat(79));
    expect(slug?.endsWith("-")).toBe(false);
  });

  it("returns null when there is nothing sluggable", () => {
    expect(slugify("")).toBeNull();
    expect(slugify("   ")).toBeNull();
    expect(slugify("!!!")).toBeNull();
    expect(slugify("日本語")).toBeNull();
  });

  /**
   * The header-injection property. A project name reaches
   * `Content-Disposition: attachment; filename="<slug>_<date>.xlsx"`, so a
   * name carrying a quote, a newline, or a semicolon must not be able to
   * break out of the quoted string.
   */
  it("never emits a character that could escape a quoted header value", () => {
    const hostile = [
      'Report" ; filename="owned.exe',
      ["Line", "X-Injected: yes"].join(String.fromCharCode(13, 10)),
      "../../etc/passwd",
      "Quarter 1 — 100% \\ done",
    ];
    for (const name of hostile) {
      const slug = slugifyOr(name, "project");
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.length).toBeLessThanOrEqual(80);
    }
  });

  it("slugifyOr substitutes only when slugify yields nothing", () => {
    expect(slugifyOr("Kitchen Remodel", "project")).toBe("kitchen-remodel");
    expect(slugifyOr("!!!", "project")).toBe("project");
  });
});
