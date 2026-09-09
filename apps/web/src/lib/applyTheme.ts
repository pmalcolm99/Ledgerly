"use client";

import { THEMES, type ThemeId } from "@ledgerly/shared/themes";

/**
 * Swaps the theme class on <html> for an instant preview, ahead of the
 * round trip that persists it. Mirrors Forkd's `applyTheme.ts`.
 *
 * Also updates the `theme-color` meta, which is what the iOS status bar and
 * the Android chrome are painted from — without it the browser furniture
 * stays the old theme's colour until a full reload, which is very visible on
 * a phone.
 */
export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  for (const entry of THEMES) root.classList.remove(entry.id);
  root.classList.add(theme);

  const background = THEMES.find((entry) => entry.id === theme)?.background;
  if (!background) return;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", background);
  }
}
