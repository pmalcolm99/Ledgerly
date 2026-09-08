# Forkd: Lessons Learned

This document captures the actual problems that emerged during Forkd development, how they were fixed, and the rules Ledgerly must follow to avoid repeating them. Evidence is from git history, After Action Reports, and source comments.

## Cloudflare Access and Authentication

### Invisible asset failures in guest-facing URLs

**What went wrong:** Guest bill-split links (`/g/[token]`) are publicly accessible, unguarded by Cloudflare Access. When deployed, they rendered as blank white pages in Safari on iOS, but worked fine elsewhere. The root cause was not the browser.

**Why it was hard to diagnose:** The setup guide said to bypass only `/g/*` and `/api/v1/guest/*` in Access. This looked complete. In reality, a Next.js page under `/g/` pulls ~20 JavaScript chunks and a stylesheet from `/_next/static/` — and those stayed behind the Access gate. A guest device with no `CF_Authorization` cookie received the page HTML and got 302 redirects to the Access login for every asset, leaving an unstyled empty shell. The operator, who had already signed in, saw a perfectly normal page in their browser. The failure was invisible to whoever configured it.

**Evidence:** Commit `2ed2425` (fix: serve guest bill pages as self-contained HTML); commit `95da917` (docs: guest links also need /_next/static/* bypassed in Cloudflare Access).

**The fix:** Instead of widening the Access bypass to expose `/_next/static/*` to the internet (which is safe but lazy), Forkd rewrote the guest page as a Route Handler returning one complete HTML document with CSS inlined and no JavaScript. The entire public surface is now a single `/g/` prefix with no asset dependencies.

**Actionable rule for Ledgerly:** If you have public guest-facing URLs (Forkd's `/g/` paths), serve them as **self-contained HTML** with inline CSS and zero JavaScript dependencies. Do not rely on a subset of `/_next/static/*` being accessible. If that's too restrictive, bypass the entire `/_next/static/` prefix in Cloudflare Access—it's compiled build output with no user data. Page HTML and RSC payloads stay gated.

### Session provisioning redirect loops

**What went wrong:** After enabling Cloudflare Access, unauthenticated users hit an infinite redirect loop: `Access → /api/auth/cloudflare-sync → Access → ...`.

**Why it was subtle:** The sync route verifies the Cloudflare Access JWT and provisions a Better Auth session cookie. But once the user reaches that route, the cookie is not yet set. The `proxy.ts` middleware checks for the cookie and redirects back to the sync route if absent—creating a loop.

**Evidence:** Commit `8555405` (Phase 5: Cloudflare Access auth); docs/cloudflare-access-setup.md Step 1 pre-flight checklist and redirect-loop diagnosis.

**The fix:** The sync route is exempted from the cookie check (line 22–24 in `/apps/web/src/proxy.ts`): a explicit path check bypasses the session verification. Once the route sets the cookie and redirects to the original destination, subsequent requests pass the cookie guard.

**Actionable rule for Ledgerly:** When implementing Cloudflare Access with a session sync flow: exempt the sync route itself from session checks. Comment this clearly—it's a security-critical exception. Test the full redirect flow end-to-end before enabling Access on a live instance.

### Cache Rules stripping Set-Cookie headers

**What went wrong:** Cloudflare Cache Rules can strip `Set-Cookie` headers from cached responses, preventing session cookies from reaching the browser.

**Why it was easy to miss:** The `/api/auth/cloudflare-sync` route does return `Cache-Control: no-store`, but a misconfigured "Cache Everything" rule would override it.

**Evidence:** docs/cloudflare-access-setup.md "Cloudflare dashboard checks" (§2, Cache Rules).

**The fix:** The route uses a 200 response with `<meta http-equiv="refresh">` instead of a 302 redirect, because Cloudflare strips `Set-Cookie` from 3xx responses even when no Cache Rule applies. Belt-and-suspenders: if Cache Rules exist, add an exception to bypass cache for `<APP_HOSTNAME>/api/auth/*`.

**Actionable rule for Ledgerly:** Any route that sets session cookies must:
1. Return `Cache-Control: no-store`
2. Use a 200 response with `<meta http-equiv="refresh">`, not a 302, as a defense against Cloudflare's default caching behavior on 3xx
3. Document that Cloudflare Cache Rules can break session provisioning
4. Test behind Cloudflare with a real device that has never authenticated before

---

## Database, Migrations, and Data Integrity

### Soft-deleted rows violated by full-table unique constraints

**What went wrong:** A unique constraint on `restaurants.google_place_id` caused a crash when re-importing a TikTok whose place_id belonged to a previously soft-deleted restaurant.

**Why:** Forkd uses soft deletes (`deleted_at` timestamp). When a restaurant is deleted, its `google_place_id` row stays in the table. A re-import tries to insert the same `google_place_id`, hitting the unique constraint.

**Evidence:** Commit `a9dd50c` (fix: partial unique index on google_place_id + filter deleted rows).

**The fix:** A two-part migration:
1. Dropped the full-table `UNIQUE` constraint and replaced it with a partial `UNIQUE INDEX WHERE deleted_at IS NULL`. Now only live rows are unique; soft-deleted history is ignored.
2. The duplicate-detection SELECT also filters `deleted_at IS NULL`, so it never short-circuits on deleted records.

```sql
CREATE UNIQUE INDEX idx_restaurants_google_place_id_not_deleted
  ON restaurants(google_place_id)
  WHERE deleted_at IS NULL;
```

**Actionable rule for Ledgerly:** If you use soft deletes:
- Never use a full-table unique constraint on a field that is not deleted. Use a partial unique index with `WHERE deleted_at IS NULL`.
- In any query checking for duplicates or uniqueness, filter `deleted_at IS NULL` to avoid matching deleted history.
- Test re-import scenarios for soft-deleted records before shipping.

---

## Docker, Deployment, and Runtime

### Entrypoint crashes when user override is already non-root

**What went wrong:** The Docker entrypoint uses `su-exec` to drop from root to the `node` user. But when `docker-compose.yml` contains a `user: "1000:1000"` override, the entrypoint is already running as non-root. Calling `setgroups()` as a non-root user fails, and the container crashes with a 502.

**Why it's easy to miss:** Production works fine (root entrypoint, su-exec succeeds). A local `docker-compose.yml` with a user override fails silently on startup, only discovered when the container is pushed and runs without that override.

**Evidence:** Commit `89a9e1e` (fix: entrypoint must not su-exec when already non-root (prod 502)).

**The fix:** Check if the entrypoint is already running as root. Only do `chown` + `su-exec` when actually `root`. Otherwise, exec the app directly.

```bash
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app
  exec su-exec node node /app/index.js
else
  exec node /app/index.js
fi
```

**Actionable rule for Ledgerly:** If the entrypoint needs to drop privileges, check the current UID first. Support both `user:` overrides in `docker-compose.yml` and running as root (for image builds). Test locally with and without `user:` override.

### Standalone output misses dynamically imported modules

**What went wrong:** The Next.js standalone output omits modules that are only reachable via dynamic imports. When `instrumentation.ts` dynamically imported `@forkd/queue/worker`, the file tracer never encountered `playwright-core`, so it was absent from `standalone/node_modules` at runtime, causing `Cannot find module 'playwright-core'`.

**Why:** Next.js file tracing is static. It walks the import graph from entry points. Dynamic `await import(...)` is not traced.

**Evidence:** Commit `f8b4d4b` (perf: lean service worker + per-request session dedupe) and Phase 10 AAR (§"Docker runtime: Cannot find module 'playwright-core'").

**The fix:** In the Dockerfile builder stage, use `find` to locate the module in the pnpm store and copy it explicitly to the runner stage before the Next.js standalone output is used.

```dockerfile
# Builder stage
RUN find /pnpm-dir -name "playwright-core" -type d -exec cp -rL {} /tmp/playwright-core \;

# Runner stage
COPY --from=builder /tmp/playwright-core /app/node_modules/playwright-core
```

**Actionable rule for Ledgerly:** For any dynamically imported module that is not tree-shakeable:
1. Add it to `next.config.ts` in `serverExternalPackages`
2. Explicitly copy it in the Dockerfile runner stage if file tracing misses it
3. Test the production Docker image by running it locally and checking that the module is present
4. Document which modules are dynamically imported and why (e.g., `@forkd/queue/worker` to prevent webpack from statically tracing playwright-core)

---

## Async, Stale Closures, and Race Conditions

### Stale-closure URL wipe from debounced search

**What went wrong:** A search input debounce effect captured `updateFilter` at mount time with empty `searchParams`. When the home-state effect fired 300ms later and set `?state=CO`, the debounced `updateFilter` function ran with stale `searchParams`, rebuilt the URL from the empty initial params, and wiped the state filter.

**Why it's easy to miss:** The bug is timing-dependent. If you navigate fast, the state filter survives. If you pause for 300ms on the home screen, it disappears.

**Evidence:** Commit `e0a2964` (fix: use window.location.search in updateFilter to prevent stale-closure URL wipe).

**The fix:** Always read the current URL from `window.location.search` instead of relying on a captured `searchParams` variable. `window.location.search` is always live, updated synchronously by `history.replaceState`.

```typescript
// ❌ Wrong — stale closure
const [searchParams] = useSearchParams();
const updateFilter = () => {
  const newParams = new URLSearchParams(searchParams); // captured at mount, stale
  // ...
};

// ✅ Right — always live
const updateFilter = () => {
  const newParams = new URLSearchParams(new URL(window.location.search, 'http://localhost').search);
  // ...
};
```

**Actionable rule for Ledgerly:** In React effects that debounce user input and update the URL, always read the current URL from `window.location.search` or `useSearchParams()` inside the handler, not outside it. Never trust a closure over `searchParams`.

### Session resolution called multiple times per request

**What went wrong:** The root layout called `serverTrpc().me()` to fetch the current user. Multiple page components also called it (e.g., `generateViewport`), causing 2–3 DB joins per hard load—unnecessary and slow.

**Why:** Each route handler was independent; there was no request-level deduplication.

**Evidence:** Commit `f8b4d4b` (perf: lean service worker + per-request session dedupe).

**The fix:** Wrapped `resolveSessionFromCookie` in React's `cache()` helper, which deduplicates at the request level. The first call to `resolveSessionFromCookie` runs; subsequent calls in the same request return the cached result without hitting the DB.

```typescript
export const resolveSessionFromCookie = cache(async (cookieValue: string) => {
  return db.query.session.findFirst({
    where: eq(session.token, cookieValue),
  });
});
```

**Actionable rule for Ledgerly:** Wrap server-side functions that read authentication state in `cache()` so they execute at most once per request. This applies to any DB query that must run in multiple places during a single render (session, user profile, permissions checks).

---

## Service Workers and Caching

### Over-caching dynamic assets doubles tunnel requests

**What went wrong:** The service worker cached every `.webp` file (all restaurant photos) with `stale-while-revalidate`. This meant every request to a cached photo triggered two network calls: one to the cache (immediate) and one in the background to check for updates. Over a Cloudflare Tunnel with latency, this doubled requests for photo-heavy pages.

**Why it's subtle:** The cache hit returns instantly, so the user sees no delay. But the background re-fetch still burns quota and tunnel bandwidth.

**Evidence:** Commit `f8b4d4b` (perf: lean service worker + per-request session dedupe).

**The fix:** Rewrote the service worker (v2) with a narrower cache strategy:
- **Cache-first, no revalidation** for immutable assets (`/_next/static/` content-hashed URLs + the precached shell)
- **Network-first** for navigations (using navigation preload so the SW doesn't block)
- **Never cached** for tRPC, RSC payloads, and photo bytes

```javascript
// Only content-hashed build assets and the shell are cacheable.
function isCacheableAsset(url) {
  return url.pathname.startsWith("/_next/static/") || PRECACHE.includes(url.pathname);
}

// Everything else (photos, tRPC, RSC) is always network, never cached.
```

**Actionable rule for Ledgerly:** Service workers must distinguish between:
1. **Immutable assets** (content-hashed files from the build): cache-first, no revalidation
2. **Dynamic data** (user photos, API responses, RSC payloads): network-first or network-only, never cached
3. **Navigations**: network-first with navigation preload fallback

Never use `stale-while-revalidate` on user-generated or time-sensitive content. Cache busting happens via `PRECACHE` version bumps in the `activate` event, which deletes all old cache names.

---

## Frontend, PWA, and Browser APIs

### HTML form nesting violations silently adopted by browsers

**What went wrong:** The guest bill-split page had a form nested inside another form. HTML forbids this. Browsers silently drop the inner `<form>` tag and adopt its button into the outer form. The "I've paid" button posted to the wrong endpoint.

**Why it wasn't caught:** Unit tests only string-matched the markup. The tests passed even though the form structure was broken.

**Evidence:** Commit `2ed2425` (fix: serve guest bill pages as self-contained HTML). Included in the commit: "The strict guest CSP was set in the route handler, where Next's next.config.ts headers silently replaced it. Moved to next.config.ts, where it actually applies."

**The fix:** Removed the nested form entirely by rewriting the guest page as a single self-contained HTML document. Added Playwright WebKit tests that actually render the page and verify form structure, not just string matching.

**Actionable rule for Ledgerly:** Never nest `<form>` elements. If a form needs multiple submit buttons posting to different endpoints, use multiple routes (FormAction) or add a hidden field to distinguish them. Unit tests that only string-match HTML will miss this. Always render the page in a real browser (Playwright with WebKit) to catch silent browser corrections.

### CSS isolation for overlapping components (z-index escaping)

**What went wrong:** On mobile (390 px viewport), a Leaflet map rendered over a photo lightbox. The lightbox was supposed to be the modal dialog, but the map's z-indexes (up to 1000) painted through the modal.

**Why:** Leaflet creates panes with z-indexes up to 700 and controls reaching 1000. The HeroUI Modal's default z-index (z-50 = 50 in Tailwind) was below that. Without CSS isolation, Leaflet's z-indexes escaped to the page-level stacking context.

**Evidence:** Commit `4c26af1` (post-Phase 9 polish) and Phase 10 AAR (§"Bug 1 (CRITICAL) — Leaflet map renders over photo lightbox").

**The fix:** Added `isolation: isolate` Tailwind class to the container wrapping the map component. This creates a new CSS stacking context, trapping all Leaflet z-indexes inside the map so they can't escape to the page level. As belt-and-suspenders, also set `z-[9999]` on the Modal.

```tsx
<div className="isolate">
  <Map />
</div>

<Modal classNames={{ wrapper: "z-[9999]" }} />
```

**Actionable rule for Ledgerly:** When using third-party libraries (Leaflet, video players, etc.) that set high z-indexes:
1. Wrap the library component in `isolation: isolate` to trap z-indexes
2. Don't rely on z-index escalation to fix overlap—it's fragile
3. Test on mobile viewports (390 px) with overlays

### iOS viewport and dynamic toolbar issues

**What went wrong:** On iOS Safari, the app's viewport changes when the dynamic toolbar collapses. Using `100vh` height causes the map to extend below the viewport and overlap the bottom bar. The custom address inputs used `max-h-screen`, which was already wrong.

**Evidence:** Phase 9 AAR (§"General polish") and various commits with iOS fixes.

**The fix:** Use `100dvh` (dynamic viewport height) instead of `100vh`. Use `calc(100dvh - 240px)` to account for toolbars. On the map, raise the bottom clearance and use `viewport-fit=cover` with `top:0` pinning for headers.

```css
.map { height: calc(100dvh - 240px); }
.sticky-header { position: sticky; top: 0; }
```

**Actionable rule for Ledgerly:** On iOS:
- Use `100dvh` instead of `100vh` for full-height elements (adapts to collapsing toolbar)
- Use `viewport-fit=cover` in the viewport meta tag to support notch/Dynamic Island
- Explicitly set `top: 0` for sticky headers so they don't disappear under the notch
- Test on an actual iPhone, not just the DevTools emulator

---

## API Integration and External Services

### Chrome DevTools Protocol Host header mismatch

**What went wrong:** When Forkd's scraper connects to a `chrome-headless` container via Playwright, it needs to fetch Chrome's `/json/version` endpoint to get the WebSocket URL. Chrome's DevTools HTTP endpoint rejects non-localhost Host headers as a DNS-rebinding protection. The scraper's `fetch()` call set `Host: chrome-headless` (the container hostname), which Chrome rejected with 500.

**Why:** Both `fetch` and `undici` derive the Host header from the URL and do not allow overriding it.

**Evidence:** Commit `19753d1` (fix: resolve Chrome CDP connection — HTTP Host header + env var rename).

**The fix:** Use `node:http` (not fetch) to make the request, which allows setting an arbitrary Host header. Then parse both the CDP endpoint and the returned WebSocket URL as `URL` objects and transplant the hostname and port, so the final WS target reflects the container network.

```typescript
// ✅ node:http allows Host override
const request = http.get(new URL(cdpEndpoint), {
  hostname: 'chrome-headless',
  port: 3000,
  path: '/json/version',
  headers: { 'Host': 'localhost' },
});

// Parse and transplant hostname/port
const wsUrl = new URL(response.webSocketDebuggerUrl);
wsUrl.hostname = new URL(cdpEndpoint).hostname;
wsUrl.port = new URL(cdpEndpoint).port;
```

**Actionable rule for Ledgerly:** If you need to connect to Chrome DevTools:
1. Use `node:http` (not fetch) to bypass Host header restrictions
2. Fetch `/json/version` with `Host: localhost` to bypass DNS-rebinding checks
3. Parse the returned WebSocket URL and transplant hostname/port from your CDP endpoint
4. Add a startup self-check that logs the Chrome version on success or warns on failure
5. Never pass raw WS URLs to Playwright—always fetch the current path from `/json/version`

### Audio codec compatibility with Whisper

**What went wrong:** The audio extractor output `.opus` files. Openai's Whisper API rejected them with `400: The audio file could not be decoded or its format is not supported`.

**Why:** Whisper's accepted format list is `['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']`. The `.opus` extension and codec are absent from this list.

**Evidence:** Commit `2fc49bd` (fix: output audio as m4a/aac instead of opus for Whisper compatibility).

**The fix:** Switched to AAC codec with `.m4a` container. AAC is ffmpeg's native built-in encoder (no external library), so it's always available on Alpine Linux. `m4a` is in Whisper's accepted list.

```bash
ffmpeg -i input.webm -c:a aac -b:a 64k output.m4a
```

**Actionable rule for Ledgerly:** When outputting audio for external APIs:
1. Check the API's accepted format list first (not the codec's popularity)
2. Prefer codecs and containers that are ffmpeg built-ins on Alpine Linux (aac, mp3, wav)
3. Test the audio format against the real API before shipping
4. Surface the full error body from the API (not just "400") for future debugging

---

## Webpack, Next.js, and Bundling

### Node.js built-ins bleeding into client bundle

**What went wrong:** `packages/shared/src/crypto.ts` used `node:crypto`. When a Client Component imported from `@forkd/shared`, webpack attempted to bundle `node:crypto` into the browser bundle. The Docker build failed: `Module not found: Can't resolve 'crypto'`.

**Why:** `packages/shared` is imported by Client Components. Webpack resolves all imports from shared packages, including ones that use Node.js built-ins.

**Evidence:** Commit `931e6e7` (fix: move crypto module to packages/api to prevent node:crypto in client bundle); Phase 6 AAR (§"1. node:crypto in client bundle").

**The fix:** Moved `crypto.ts` from `packages/shared` to `packages/api` (server-only). Left thin re-exports in the original location for existing consumers, but new code imports from `packages/api`.

**Actionable rule for Ledgerly:** `packages/shared` (or any package imported by Client Components) must never export:
- Code using `node:*` built-ins
- Any Node.js-only library (e.g., `node-postgres`, `drizzle-orm/pg`)
- Anything larger than 10 KB (it bloats the client bundle)

Use `import "server-only"` at the top of server-only files. Structure packages: shared → ui, shared → api, api → workers.

### Playwright-core not included in Next.js standalone output

**What went wrong:** `@forkd/queue/worker` is only imported dynamically in `instrumentation.ts`. The Next.js file tracer doesn't follow dynamic imports, so `playwright-core` (which is only reachable through the worker) is missing from the standalone output. The app crashes at runtime: `Cannot find module 'playwright-core'`.

**Why:** Next.js file tracing is static and doesn't follow `await import(...)`.

**Evidence:** Phase 10 AAR (§"Docker runtime: Cannot find module 'playwright-core'").

**The fix (three parts):**
1. Mark the queue index to export only `importQueue`, not `startImportWorker` (prevents webpack from statically tracing playwright-core through the API router)
2. Create a subpath export `"./worker": "./src/worker.ts"` in `packages/queue/package.json`
3. Use the dynamic subpath import: `await import("@forkd/queue/worker")` (webpack doesn't trace subpath imports)
4. In the Dockerfile, explicitly copy `playwright-core` from the builder to the runner stage
5. Add webpack externals in `next.config.ts` for `chromium-bidi` and `playwright-core` (belt-and-suspenders)

```typescript
// instrumentation.ts
const { startImportWorker } = await import("@forkd/queue/worker");

// next.config.ts
webpack: (config, { isServer }) => {
  if (isServer) {
    const existing = Array.isArray(config.externals) ? config.externals : [];
    config.externals = [...existing, /^chromium-bidi/, /^playwright-core/];
  }
  return config;
};
```

**Actionable rule for Ledgerly:** If you have a large library (playwright, puppeteer, etc.) that is only used in a background worker:
1. Split the export: main export for the queue client, subpath export for the worker code
2. Use dynamic subpath imports: `await import("@package/worker")`
3. Add webpack externals in `next.config.ts`
4. List the module in `serverExternalPackages`
5. Explicitly copy it in the Dockerfile runner stage
6. Verify it exists: `ls -la .next/standalone/node_modules/playwright-core`

### CSS imports in components must be imported at file top

**What went wrong:** Importing Leaflet's CSS inside the `RestaurantMap` component (`import "leaflet/dist/leaflet.css"` at the function body) didn't survive the Next.js production webpack build. The CSS was not injected into the page.

**Why:** CSS imports at component load time are not handled correctly by webpack in Next.js production builds. The CSS injection happens at module initialization, which may be too late for dynamic components.

**Evidence:** Phase 9 AAR (§"RestaurantMap component", bullet 2).

**The fix:** Import the CSS at the top of the file, before any code, so it's part of the module's static imports.

```typescript
// ✅ Top of file
import "leaflet/dist/leaflet.css";

export function RestaurantMap() {
  // ...
}
```

**Actionable rule for Ledgerly:** CSS imports must be at the top of the file, not inside functions or useEffect. This applies especially to third-party libraries (Leaflet, react-big-calendar, etc.). Test the production build with `next build && node .next/standalone/server.js` to verify CSS injection.

---

## Testing and CI

### Vitest mock hoisting breaks subprocess tests

**What went wrong:** Tests for subprocess modules (ffmpeg, yt-dlp) used `vi.mock("node:child_process", factory)` inside `it()` blocks. Vitest hoists all `vi.mock` calls to file scope, so when two tests defined different mocks, the second factory definition overwrote the first. The first test received the wrong mock.

**Why:** Vitest's hoisting is a compile-time transformation. Code like `vi.mock(...)` inside a test block is hoisted to the top of the file and merged with all other mock definitions. Only the last factory wins.

**Evidence:** Phase 10 AAR (§"Vitest `vi.mock` hoisting breaks subprocess tests").

**The fix:** Removed subprocess mocking tests entirely. Replaced them with pure function tests of the Zod schema validation (11 tests, zero I/O). Subprocess integration is tested in docker-compose with real binaries.

**Actionable rule for Ledgerly:** Don't use `vi.mock` inside test blocks. Mocks must be defined at file scope (before any `describe` or `it`). For multi-scenario subprocess tests, either:
1. Use separate test files (one mock per file)
2. Test only the pure functions (schema validation, parsing)
3. Use real binaries in integration tests with docker-compose

### Invalid test fixtures cause silent failures

**What went wrong:** A synthetic MP3 audio fixture generated from raw MPEG1 Layer3 frame bytes (constructed in Python without a proper encoder) was used to test Whisper. Whisper returned `400: invalid file format`. The root cause was invisible: the bytes were not a valid MP3 container.

**Why:** Raw audio frame bytes are not an audio file. An audio file requires headers, metadata, and a well-defined container format.

**Evidence:** Phase 6 AAR (§"3. Whisper test returning 400") and commit `d6f4a8f` (fix: replace invalid MP3 fixture with valid WAV for Whisper test).

**The fix:** Replaced the MP3 with a proper WAV file (0.5 s, 16 kHz, mono, 16-bit PCM) generated using Python's `wave` standard library. WAV format has a simple, well-specified header.

```python
import wave, struct, io
b = open('silence.wav', 'wb')
w = wave.open(b, 'wb')
w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(struct.pack('<8000h', *([0]*8000)))
w.close()
```

**Actionable rule for Ledgerly:** Audio, image, and binary fixtures must be:
1. Generated with a real encoder or standard library (wave, PIL, etc.)
2. Verified with the final consumer (OpenAI Whisper, Google Cloud, etc.) before commit
3. Tested in CI against real API credentials
4. Never constructed from raw bytes—use a proper file format

---

## Authorization and Session Management

### Next.js 15 forbids cookie writes in RSC pages

**What went wrong:** The sign-out page (`/sign-out/page.tsx`) called `cookies().delete()` inside a Server Component. Next.js 15 forbids cookie modification in RSCs—only Route Handlers and Server Actions can write cookies. The deletion never happened, leaving the user with a stale session cookie.

**Why:** The error occurs before the page renders, but it's not caught until the page is visited. The user sees a redirect, assumes sign-out worked, then discovers the cookie is still there on the next visit.

**Evidence:** Commit `7c2f033` (fix: convert sign-out to Route Handler to allow cookie deletion); Phase 6 AAR (§"2. Sign-out page crashing").

**The fix:** Moved sign-out logic to `/api/auth/sign-out` (a GET Route Handler, which has full cookie write access). The sign-out page now just redirects there. The nav link uses `<a>` instead of `<Link>` so the browser makes a real GET request (not a client-side navigation).

```typescript
// ✅ Route Handler
export async function GET(req: NextRequest) {
  cookies().delete("forkd.session_token");
  // ...
  return NextResponse.redirect(logoutUrl);
}

// ✅ Sign-out page
export default function SignOut() {
  return <a href="/api/auth/sign-out">Sign out...</a>;
}
```

**Actionable rule for Ledgerly:** Any operation that modifies cookies—sign-out, session refresh, login—must be in a Route Handler or Server Action. Never call `cookies()` inside a page component. Test sign-out by checking that the session cookie is actually cleared in DevTools after clicking the button.

### Cloudflare Access logout endpoint must be reached

**What went wrong:** After sign-out, users appeared to log back in automatically when they revisited the app. The Cloudflare JWT (`CF_Authorization` cookie) was still valid, so Cloudflare re-issued it on the next request, and the app re-provisioned a session.

**Why:** Sign-out only deleted the app's session cookie. It didn't tell Cloudflare Access to revoke the user's JWT.

**Evidence:** docs/cloudflare-access-setup.md (§"Sign-out behavior").

**The fix:** After clearing the app session, redirect to `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/logout`, which revokes the Cloudflare JWT. Only then is the user truly logged out.

```typescript
const cfTeamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
const logoutUrl = `https://${cfTeamDomain}/cdn-cgi/access/logout`;
return NextResponse.redirect(logoutUrl);
```

**Actionable rule for Ledgerly:** If you use Cloudflare Access:
1. Sign-out must hit the Cloudflare logout endpoint: `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`
2. Do this AFTER clearing your own session cookie
3. Test sign-out by closing the browser, revisiting, and verifying you're challenged by Cloudflare again (not silently re-authenticated)

---

## Top 10 Things Ledgerly Must Not Repeat

Ranked by cost (development time + production incidents + data loss risk):

1. **Over-caching user data in service workers.** Cache only immutable build assets (`/_next/static/`). Never cache photos, API responses, or RSC payloads. Service worker bugs are invisible until production and require version bumps to clear stale caches across all users.

2. **Nested `<form>` elements that browsers silently corrupt.** Browsers drop nested forms without error. Unit tests won't catch this. Use Playwright WebKit to render the page and verify form structure.

3. **Session cookies blocked by Cloudflare cache rules.** Cache rules can strip `Set-Cookie` headers, breaking the entire auth flow. Test session provisioning behind Cloudflare with a device that has never authenticated. Use 200 + `<meta http-equiv="refresh">` for auth redirects.

4. **Soft-deleted rows violating unique constraints.** Always use partial unique indexes with `WHERE deleted_at IS NULL`. Filter `deleted_at IS NULL` in duplicate-detection queries.

5. **Node.js built-ins bleeding into client bundle.** Never export node:* modules from `packages/shared` or any package imported by Client Components. Use `import "server-only"` at the top of server-only files.

6. **Dynamically imported modules missing from standalone output.** Use subpath exports, dynamic imports, webpack externals, and explicit Dockerfile COPY to ensure large libraries (playwright, puppeteer) are available at runtime.

7. **Stale closures wiping URL state in debounced functions.** Always read `window.location.search` inside the debounced handler, not from a closure. Use `cache()` to deduplicate DB queries per request.

8. **Cloudflare Access asset bypasses that expose stale cookies.** Guest-facing URLs must be self-contained HTML with inline CSS and no JavaScript. Never rely on `/_next/static/*` bypass to work transparently.

9. **Chrome DevTools connection failures from Host header mismatches.** Use `node:http` (not fetch) with `Host: localhost` to fetch `/json/version`. Parse and transplant hostname/port into the WebSocket URL.

10. **Entrypoint crashes from `su-exec` on already-non-root containers.** Check `id -u` before calling `su-exec`. Support both root and non-root execution paths.

---

## Cross-Cutting Patterns

### Test against real external services, not mocks

Forkd discovered bugs only after deploying to production with real Chrome, real Whisper, real Cloudflare. Mock tests passed. Always test the real integration before shipping:
- Chrome DevTools: verify connection in docker-compose with real chrome-headless
- Whisper: call the real API with the real file format, not a mock
- Cloudflare Access: test with a real device, real IdP, and no pre-existing cookies

### Device and browser testing is non-negotiable

Three bugs appeared only on iOS (form nesting, z-index escaping, viewport height). The DevTools emulator and React testing won't catch these. Test on:
- iPhone (Safari)
- Android (Chrome)
- Desktop (Chrome, Firefox)
- Private browsing mode (for Cloudflare tests)

### Automate deployment order

Forkd's Cloudflare Access setup requires matching `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` values to the application created in the Cloudflare Zero Trust dashboard. A typo breaks the entire app. Document this and automate it if possible.

### Prefer self-contained, single-file outputs for public URLs

The guest bill-split page works perfectly as a single HTML file with inline CSS. No JS dependencies, no asset complexity, no cache issues. For public or semi-public URLs, this is the gold standard.
