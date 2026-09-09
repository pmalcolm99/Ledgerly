import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { DEFAULT_THEME, resolveTheme, themeBackground } from "@ledgerly/shared/themes";
import type { ThemeId } from "@ledgerly/shared/themes";

import { resolveIdentity } from "../server/identity";
import { SPLASH_LINKS } from "./splashLinks.generated";
import { PortraitLock } from "../components/PortraitLock";
import { Providers } from "./providers";
import "./globals.css";

/**
 * The wordmark face. `next/font/local`, not `next/font/google`: the latter
 * fetches at build time, and a self-hosted app that cannot build without
 * reaching fonts.googleapis.com has acquired a third party it did not want.
 * See ./fonts/README.md for the subset and its licence.
 *
 * `display: "swap"` so the header never blocks paint on a 25KB download, and
 * a matching system fallback so the pre-swap frame is not a blank box.
 */
const brandFont = localFont({
  src: "./fonts/DancingScript-Bold-latin.woff2",
  weight: "700",
  style: "normal",
  display: "swap",
  variable: "--font-brand",
  fallback: ["Snell Roundhand", "Apple Chancery", "Segoe Script", "cursive"],
});

/**
 * apps/web/src/app/layout.tsx — the app shell (task 7.2).
 *
 * The active theme is resolved server-side and applied as a class on <html>,
 * which is what stops the flash of default theme Forkd's own notes warn about
 * (FORKD_UI.md §Design System Inconsistencies, item 5). `resolveIdentity` is
 * React `cache()`d, so the two calls below — one for the viewport meta, one
 * for the class — cost a single database read (D-03).
 */

export const metadata: Metadata = {
  title: "Ledgerly",
  description: "Receipt capture and spend tracking.",
  // Tells iOS to run in standalone mode when launched from the home screen,
  // and to paint the status bar over the header rather than beside it.
  appleWebApp: {
    capable: true,
    title: "Ledgerly",
    // black-translucent lets the page paint behind the status bar, which is
    // what makes the header's safe-area top inset look intentional rather
    // than leaving a coloured strip.
    statusBarStyle: "black-translucent",
    // Generated alongside the images themselves so the media queries and the
    // filenames on disk cannot drift (scripts/generate-icons.ts).
    startupImage: [...SPLASH_LINKS],
  },
  manifest: "/manifest.webmanifest",
};

/**
 * Never let a theme lookup break the page. `resolveIdentity` reaches the
 * database, and the root layout wraps *everything* including error routes —
 * a throw here would turn a recoverable failure into an unstyled 500 with no
 * way back. The theme is cosmetic; the real auth gate is `(app)/layout.tsx`,
 * which still fails loudly.
 */
async function activeTheme(): Promise<ThemeId> {
  try {
    const user = await resolveIdentity();
    return resolveTheme(user?.theme);
  } catch {
    return DEFAULT_THEME;
  }
}

export async function generateViewport(): Promise<Viewport> {
  return {
    width: "device-width",
    initialScale: 1,
    // Extends the page under the notch and home indicator; the safe-area
    // insets in globals.css are what keep content out from under them.
    viewportFit: "cover",
    themeColor: themeBackground(await activeTheme()),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await activeTheme();

  return (
    <html lang="en" className={`${theme} ${brandFont.variable}`} suppressHydrationWarning>
      <body className="bg-background text-foreground">
        <PortraitLock />
        {/* Rendered always, shown only by the landscape-phone media query in
            globals.css — so it needs no JS and cannot flash during hydration. */}
        <div id="portrait-notice" role="status">
          <span className="font-brand text-3xl leading-none">Ledgerly</span>
          <p className="text-sm">Ledgerly is designed for portrait. Rotate your phone upright.</p>
        </div>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
