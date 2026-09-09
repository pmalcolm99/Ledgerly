"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, and nothing else.
 *
 * Mounted inside `(app)`, so it only ever runs for an authenticated,
 * onboarded session. That matters: registering from an unauthenticated page
 * would install the worker in a context where the very next navigation is an
 * Access redirect, which is the situation the worker's caching rules exist to
 * survive.
 *
 * Failure is deliberately silent. A missing service worker costs the offline
 * shell, not the app — an error banner here would be noise the user cannot
 * act on.
 *
 * NOT REGISTERED IN DEVELOPMENT. The worker caches `/_next/static/*`
 * cache-first with no revalidation, which is exactly right for production —
 * those URLs are content-hashed, so the bytes behind one never change — and
 * exactly wrong in dev, where Next serves chunks whose contents change under
 * a stable URL. A cached dev chunk gets served after a rebuild and hydration
 * fails in ways that look like application bugs. The worker itself is
 * exercised by apps/web/src/sw.test.ts and by the Playwright PWA specs, which
 * fetch /sw.js directly rather than relying on it being registered.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* offline shell unavailable; the app itself is unaffected */
      });
    };
    // After load, so registration never competes with the first paint on a
    // phone over a tunnel.
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
    return undefined;
  }, []);

  return null;
}
