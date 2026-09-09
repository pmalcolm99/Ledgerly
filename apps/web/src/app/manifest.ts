import type { MetadataRoute } from "next";
import { DEFAULT_THEME, THEMES } from "@ledgerly/shared/themes";

/**
 * apps/web/src/app/manifest.ts — served by Next at /manifest.webmanifest
 * (task 7.9).
 *
 * The manifest is fetched by the browser BEFORE any session exists (and is
 * excluded from the Access matcher for exactly that reason), so it must not
 * depend on the signed-in user. `theme_color` and `background_color` therefore
 * use the default theme rather than the viewer's — the per-user colour is
 * applied by the viewport meta in layout.tsx, which does run per request.
 *
 * No `share_target`: Forkd has one for importing links, but Ledgerly's input
 * is a photograph taken in the app, and a share target that accepted images
 * would need an authenticated POST handler outside the Access-gated paths.
 */
export default function manifest(): MetadataRoute.Manifest {
  const theme = THEMES.find((entry) => entry.id === DEFAULT_THEME)!;

  return {
    name: "Ledgerly",
    short_name: "Ledgerly",
    description: "Receipt capture and spend tracking.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: theme.background,
    theme_color: theme.background,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Separate entry, not `purpose: "any maskable"`: a single icon declared
      // as both is letterboxed on Android, because the launcher applies the
      // maskable safe-area crop to artwork that was not drawn for it.
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
