/**
 * packages/auth/src/response.ts — the single byte-identical failure
 * response (task 3.3, contract §5).
 *
 * Every rejection — all fourteen `AuthFailureReason` values, plus
 * `identity_conflict` — produces exactly this response: same status, same
 * headers, same body, regardless of *why* the request was rejected. The
 * reason is never returned to the client; it is logged once, at the single
 * call site in `resolveIdentityFromHeaders` (identity.ts), never here.
 *
 * `ACCESS_DENIED_RESPONSE` is the data (status/headers/body); a `Response`
 * object's body stream is single-use once read, so a shared instance cannot
 * safely be returned to more than one caller. `buildAccessDeniedResponse()`
 * is the one function — used by the middleware today, and by the tRPC HTTP
 * boundary and any future upload/image Route Handlers — that constructs a
 * fresh `Response` from that constant data every time it is called.
 */

export const ACCESS_DENIED_RESPONSE = {
  status: 403,
  headers: {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    // `cache-control: no-store` is not decoration: FORKD_LESSONS.md records
    // a cached Access redirect bricking an installed PWA. A cached 403 is
    // the same failure with a longer tail.
    vary: "Cf-Access-Jwt-Assertion",
  },
  body: "Access denied.",
} as const;

/** Builds a fresh, byte-identical `Response` every call. Never inspects
 * `reason` — that parameter exists only so call sites can pass it through
 * for symmetry/future logging without the builder itself branching on it. */
export function buildAccessDeniedResponse(_reason?: string): Response {
  return new Response(ACCESS_DENIED_RESPONSE.body, {
    status: ACCESS_DENIED_RESPONSE.status,
    headers: ACCESS_DENIED_RESPONSE.headers,
  });
}
