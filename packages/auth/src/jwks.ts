import { createRemoteJWKSet } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { edgeEnv } from "@ledgerly/config/edge";

/**
 * packages/auth/src/jwks.ts — the Cloudflare Access key set (D-29,
 * contract §3).
 *
 * Every option is set explicitly rather than inherited from a `jose`
 * default. Under D-03 this lookup is on the path of *every* request, not
 * only new logins, so its failure modes matter more here than they did in
 * Forkd — which passes no options at all and infers a ~1 hour TTL
 * (FORKD_AUTH.md §2).
 *
 * `timeoutDuration` is the one that bites: without it, a JWKS endpoint that
 * accepts a connection and then stalls holds a request open indefinitely.
 *
 * Deliberately NOT added: a last-known-good fallback layer. D-03 assessed
 * and accepted JWKS unavailability as a lockout risk; caching stale keys
 * past their TTL would quietly weaken revocation to buy back availability
 * that decision said it did not need.
 */

/** Minimum gap between refetches when a token arrives with an unknown
 * `kid` — the floor that stops an attacker forcing unbounded JWKS fetches
 * by replaying garbage key ids. */
const JWKS_COOLDOWN_MS = 30_000;

/** A stalled CDN must not hold a request open. */
const JWKS_TIMEOUT_MS = 5_000;

let cached: JWTVerifyGetKey | null = null;

/**
 * Lazy singleton: constructing this at module load would make importing
 * the module depend on the environment already being parsed. It is passed
 * to `verifyAccessJwt` as an argument rather than reached for through a
 * module-level mutable seam, which is what makes the verifier unit-testable
 * with no network access and no test-only export.
 */
export function getAccessKeySet(): JWTVerifyGetKey {
  if (!cached) {
    if (!edgeEnv.CF_ACCESS_TEAM_DOMAIN) {
      throw new Error("CF_ACCESS_TEAM_DOMAIN is required to build the Cloudflare Access key set.");
    }
    cached = createRemoteJWKSet(
      new URL(`https://${edgeEnv.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
      {
        cacheMaxAge: edgeEnv.CF_ACCESS_JWKS_TTL_MS,
        cooldownDuration: JWKS_COOLDOWN_MS,
        timeoutDuration: JWKS_TIMEOUT_MS,
      },
    );
  }
  return cached;
}
