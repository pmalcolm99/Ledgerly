/**
 * packages/shared/src/slug.ts — the one slug derivation.
 *
 * Lifted out of `packages/api/src/routers/categories.ts`, which had it
 * private, once Phase 8 needed a second caller (the export filename). Two
 * copies of a slug rule drift, and this one is load-bearing in two different
 * ways: a category slug is the stable key an export is written against
 * (D-20), and an export filename is interpolated into a `Content-Disposition`
 * header.
 *
 * The output alphabet is `[a-z0-9-]`, capped at 80 characters, with no
 * leading or trailing dash. That makes header injection through a project
 * name UNREPRESENTABLE rather than something a call site has to remember to
 * escape — the same "by construction, not by check" property D-23 gives
 * filesystem paths.
 */

/** The shape every slug this function returns conforms to. Exported so a
 *  test can assert the property rather than restate the pattern. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derives a slug from a display name.
 *
 * Returns `null` when the name contains nothing sluggable (no ASCII letters
 * or digits — "日本語", "!!!", "   "). Callers decide what that means: the
 * category router turns it into a `BAD_REQUEST`, the export filename
 * substitutes a fallback. Returning null rather than throwing keeps this
 * module free of any error type, which is what lets it live in `shared`.
 */
export function slugify(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug === "" ? null : slug;
}

/** `slugify` with a caller-supplied substitute for the unsluggable case. The
 *  fallback is trusted to be a valid slug already — it is always a literal at
 *  the call site, never user input. */
export function slugifyOr(name: string, fallback: string): string {
  return slugify(name) ?? fallback;
}
