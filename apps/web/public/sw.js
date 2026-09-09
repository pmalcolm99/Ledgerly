/*
 * apps/web/public/sw.js — Ledgerly's service worker (task 7.10).
 *
 * THE HAZARD THIS FILE IS BUILT AROUND
 *
 * Ledgerly sits behind Cloudflare Access. When an Access session expires,
 * Access answers a navigation with a 302 to its own login page. A service
 * worker that caches that response as the app shell BRICKS the installed PWA:
 * every subsequent launch serves the cached redirect from disk, the user
 * never reaches the app, and the only fix is manually clearing site data on a
 * phone. That is unrecoverable for a normal person.
 *
 * The defence here is structural, not conditional. **No code path in this file
 * ever writes a navigation response into the cache.** There is no `cache.put`
 * reachable from the navigation handler at all, so a cached Access redirect is
 * not "guarded against" — it is unrepresentable. "Network-first" for
 * navigations means: go to the network; if the NETWORK ITSELF fails, fall back
 * to the precached offline page. A 302 is a perfectly successful network
 * response, so it is passed straight through to the browser, which follows it
 * to the login page exactly as it would with no service worker installed.
 *
 * Everything that IS cached passes one predicate (`isCacheable`), which
 * rejects redirects, every non-200, and both `opaque` and `opaqueredirect`
 * responses.
 *
 * `stale-while-revalidate` appears nowhere, deliberately: Forkd's worker
 * cached every photo that way and doubled tunnel requests on photo-heavy
 * pages (docs/reference/FORKD_LESSONS.md).
 *
 * ESLint does not lint this file (`**\/public\/**` is ignored) and it is not
 * bundled, so it is plain ES2020 with no imports. Its behaviour is covered by
 * apps/web/src/sw.test.ts, which evaluates THIS file in a synthetic worker
 * scope rather than a copy of its logic.
 */

const CACHE = "ledgerly-shell-v1";

/* Only assets that are safe to serve to any authenticated user and carry no
 * per-user data. Never an API response, never a receipt image. */
const PRECACHE = [
  "/offline.html",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable.png",
  "/manifest.webmanifest",
];

/* The offline page is the only asset whose absence would break the fallback,
 * so it is the only one whose precache failure aborts the install. */
const REQUIRED = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Fetched and gated through isCacheable rather than `cache.add`.
      //
      // `cache.add` does its own fetch and stores anything the Cache API
      // considers acceptable — which rejects opaque and non-ok responses but
      // does NOT check `redirected`. A same-origin 200 arrived at through a
      // redirect chain (an Access login page, say) would therefore be storable
      // as /offline.html, and the file's stated invariant — that everything
      // cached passes isCacheable — would not actually be true. Small blast
      // radius, since only the offline page and icons go through here and
      // never the shell, but the invariant should hold as written.
      //
      // allSettled, not all: one optional icon failing must not abort the
      // whole install and leave the app with no offline shell at all.
      const results = await Promise.allSettled(
        PRECACHE.map(async (url) => {
          const response = await fetch(url, { credentials: "same-origin" });
          if (!isCacheable(response)) throw new Error("sw: refusing to precache " + url);
          await cache.put(url, response);
        }),
      );
      const requiredIndex = PRECACHE.indexOf(REQUIRED);
      if (results[requiredIndex] && results[requiredIndex].status === "rejected") {
        throw new Error("sw: could not precache the offline page");
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/**
 * The single cacheability predicate.
 *
 *   status === 200      rejects 3xx (an Access login redirect that was
 *                       followed), 401/403 (an expired session answered
 *                       directly), and every error.
 *   type === "basic"    rejects "opaque" (a no-cors cross-origin response,
 *                       whose status is always 0 and whose body we cannot
 *                       inspect) and "opaqueredirect" (a redirect on a
 *                       manual-redirect request, also status 0).
 *   !redirected         rejects a 200 that was ARRIVED AT through a redirect
 *                       chain — the body is the login page even though the
 *                       final status is 200, which is the subtlest form of
 *                       this bug and the one a status check alone misses.
 */
function isCacheable(response) {
  return !!response && response.status === 200 && response.type === "basic" && !response.redirected;
}

function isPrecachedShellPath(pathname) {
  return PRECACHE.indexOf(pathname) !== -1;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Never touch a mutation. An upload must not be replayed or intercepted.
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Cross-origin is none of this worker's business. Leaving it unhandled is
  // also what keeps opaque responses out of the cache by construction.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }

  // Content-hashed build output: cache-first, no revalidation, because the
  // URL changes whenever the bytes do.
  if (url.pathname.indexOf("/_next/static/") === 0) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isPrecachedShellPath(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // EVERYTHING ELSE IS NETWORK-ONLY, and network-only here means "do not call
  // respondWith at all" rather than "fetch and return". Staying out of the way
  // entirely lets the browser handle credentials, redirects and streaming
  // natively, and guarantees this worker cannot cache:
  //   /api/trpc/*      authenticated data
  //   /api/images/*    receipt images, scoped per user
  //   /api/*           everything else, including sign-out
  //   ?_rsc= payloads  React Server Component responses, per-user
  return;
});

/**
 * Network-first, with the offline page as a fallback for NETWORK FAILURE
 * ONLY — never for an unexpected status.
 *
 * Nothing here caches. That is the whole design: a 302 to the Access login
 * page, a 403, or a 500 is returned to the browser untouched, so the user
 * lands on the real login page and can sign back in. Substituting the offline
 * page for a 403 would be actively worse — it would tell someone whose
 * session merely expired that they have no connection.
 */
async function handleNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    const cached = await caches.match(REQUIRED);
    if (cached) return cached;
    return new Response("You are offline.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  let response;
  try {
    response = await fetch(request);
  } catch {
    // A missing static asset offline is not fatal; let the browser show its
    // own failure rather than inventing one.
    return Response.error();
  }

  if (isCacheable(response)) {
    const cache = await caches.open(CACHE);
    // clone() before returning: a Response body can only be read once.
    cache.put(request, response.clone());
  }
  return response;
}
