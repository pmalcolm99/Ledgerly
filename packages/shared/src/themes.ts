/**
 * packages/shared/src/themes.ts — the theme table (Phase 7 task 7.1).
 *
 * Client-safe by construction: no imports at all, so it may be read from a
 * Client Component, a Server Component, and the root layout alike
 * (ARCHITECTURE.md §2.1 — `packages/shared` is imported by Client Components
 * and must never reach for a node built-in or a server-only library).
 *
 * Mirrors Forkd's `packages/shared/src/themes.ts` (`docs/reference/FORKD_UI.md`
 * §Colors), including the id/label/background/isDark shape. The three
 * non-default themes are ported verbatim; `dark` and `light` carry Ledgerly's
 * own accent instead of Forkd's green — see `apps/web/hero.ts` for the ramps
 * and DECISIONS.md D-31 for why.
 *
 * `background` is duplicated here rather than derived from the HeroUI plugin
 * config because it is needed in two places the plugin cannot reach: the
 * `themeColor` viewport meta (which sets the iOS/Android browser chrome) and
 * the PWA manifest. Both run before any CSS is parsed.
 */

export const THEMES = [
  { id: "dark", label: "Ledgerly Dark", background: "#0a0a0a", isDark: true },
  { id: "midnight", label: "Midnight", background: "#0b1020", isDark: true },
  { id: "amber", label: "Amber", background: "#161310", isDark: true },
  { id: "plum", label: "Plum", background: "#140d18", isDark: true },
  { id: "light", label: "Ledgerly Light", background: "#ffffff", isDark: false },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "dark";

const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

/**
 * `users.theme` is a plain `text` column with no CHECK constraint
 * (docs/SCHEMA.md §users), so a value that is not a live theme id can be in
 * the database — a theme removed in a later release leaves rows behind
 * pointing at it. Every read goes through here so that case degrades to the
 * default instead of emitting `class="undefined"` on `<html>`.
 */
export function isThemeId(value: string | null | undefined): value is ThemeId {
  return typeof value === "string" && THEME_IDS.includes(value);
}

export function resolveTheme(value: string | null | undefined): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME;
}

export function themeBackground(value: string | null | undefined): string {
  const id = resolveTheme(value);
  return THEMES.find((t) => t.id === id)?.background ?? "#0a0a0a";
}
