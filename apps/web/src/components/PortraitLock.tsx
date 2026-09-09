"use client";

import { useEffect } from "react";

/**
 * apps/web/src/components/PortraitLock.tsx — best-effort portrait orientation.
 *
 * There is no single mechanism that keeps a web app portrait on both
 * platforms, so this is three of them, each covering what the others cannot:
 *
 * 1. **`orientation: "portrait"` in the manifest** (`app/manifest.ts`, already
 *    set). Android honours it for an INSTALLED PWA. Chrome in a normal tab
 *    ignores it, and so does every iOS surface.
 *
 * 2. **`screen.orientation.lock("portrait")`, here.** Android Chrome honours
 *    it in standalone/fullscreen. **iOS Safari does not implement
 *    `ScreenOrientation.lock` at all** — the property is undefined — so this
 *    is a no-op there and must not be written as though it will work. It
 *    rejects rather than throwing synchronously in some browsers and throws in
 *    others, hence both guards below.
 *
 * 3. **A CSS overlay for landscape phones** (`globals.css`). The only thing
 *    that has any effect on iOS. It does not prevent rotation — nothing can
 *    from a web page — it makes the rotated state a deliberate, readable
 *    screen instead of a broken-looking one.
 *
 * The honest summary, which belongs in the code rather than only in a commit
 * message: on Android, installed, this is a real lock. On iOS it is a polite
 * request the OS ignores, plus a message. A native wrapper is the only way to
 * actually lock orientation on iOS.
 */
export function PortraitLock() {
  useEffect(() => {
    const orientation = window.screen?.orientation as
      (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
    if (typeof orientation?.lock !== "function") return;

    try {
      // Rejects with NotSupportedError on desktop and on any browser not in
      // a fullscreen/standalone context. Entirely expected — swallowed rather
      // than logged, because it would fire on every desktop page load.
      void orientation.lock("portrait").catch(() => {});
    } catch {
      // Older implementations throw synchronously instead of rejecting.
    }
  }, []);

  return null;
}
