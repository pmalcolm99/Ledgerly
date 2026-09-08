import "server-only";

import { getDb } from "@ledgerly/db";
import { getEnv } from "@ledgerly/config";

import { verifyAccessJwt } from "./cloudflareAccess";
import { IdentityConflictError, resolveUserForIdentity } from "./provision";
import type { AccessIdentity, AuthUser } from "./types";

/**
 * packages/auth/src/identity.ts — the pipeline that turns a request into an
 * application user (task 3.6, contract §6).
 *
 * This is the ONLY trust boundary in the application (D-24). The edge
 * middleware verifies too, but it attaches nothing and is not trusted: this
 * function re-reads `Cf-Access-Jwt-Assertion` from the raw headers and
 * verifies it again, from scratch. A middleware matcher gap is therefore a
 * performance regression, not an auth bypass.
 */

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * The fixed local-development identity used when `DEV_AUTH_BYPASS` is set.
 * Fixed, not random, so repeated local runs resolve to one stable user who
 * becomes the local instance owner.
 *
 * There is no environment-mode check here, and none anywhere in this
 * package (task 3.10 asserts that with a grep). The guard is a startup
 * assertion in `packages/config` (D-05): a process with the dev bypass
 * enabled in a production environment does not boot, so it cannot exist in
 * the unsafe state at request time.
 */
export const DEV_IDENTITY: AccessIdentity = {
  sub: "dev-auth-bypass",
  email: "dev@localhost",
  name: "Dev User",
  issuedAt: 0,
  expiresAt: 0,
};

/** Thrown by `requireIdentity()`. Carries no detail: the HTTP boundary maps
 * it to the one byte-identical 403 (contract §5). */
export class AuthError extends Error {
  constructor() {
    super("Access denied.");
    this.name = "AuthError";
  }
}

/**
 * The whole pipeline, and the single site at which a rejection reason is
 * logged. The reason never reaches a client.
 */
export async function resolveIdentityFromHeaders(headers: Headers): Promise<AuthUser | null> {
  let identity: AccessIdentity;

  if (getEnv().DEV_AUTH_BYPASS) {
    identity = DEV_IDENTITY;
  } else {
    const result = await verifyAccessJwt(headers.get(ACCESS_JWT_HEADER));
    if (!result.ok) {
      // One log line. No token, no token segment, no aud, no email.
      console.warn(`[ledgerly] WARN: access denied (reason=${result.reason})`);
      return null;
    }
    identity = result.identity;
  }

  try {
    const outcome = await resolveUserForIdentity(getDb(), identity);
    return outcome.user;
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      console.warn("[ledgerly] WARN: access denied (reason=identity_conflict)");
      return null;
    }
    throw error;
  }
}

/** Throws `AuthError` rather than returning null, for call sites that
 * cannot proceed without a user. */
export async function requireIdentityFromHeaders(headers: Headers): Promise<AuthUser> {
  const user = await resolveIdentityFromHeaders(headers);
  if (!user) throw new AuthError();
  return user;
}

/**
 * The Route Handler entry point — the contract's promised `requireAuthRoute`.
 *
 * **Route Handlers are never covered by a layout.** A `route.ts` placed
 * under `app/(app)/` sits visually inside the onboarding gate and is not
 * gated by it at all: Next.js runs layouts for pages, not for route
 * handlers. Phase 5's upload and image-serving endpoints must call this
 * themselves, and then still compose `scopedProjects` into their queries.
 * Named export rather than a comment because the obligation has to be
 * discoverable at the call site. Raised as M-3 in the task 3.12 review.
 */
export async function requireAuthRoute(request: Request): Promise<AuthUser> {
  return requireIdentityFromHeaders(request.headers);
}
