import "server-only";

/**
 * @ledgerly/auth — Cloudflare Access verification, JIT provisioning, and
 * identity resolution (Phase 3).
 *
 * The design pass this implements is docs/private/PHASE3_AUTH_CONTRACT.md.
 * Governing decisions: D-03, D-05, D-06, D-24 … D-29.
 *
 * This barrel carries `server-only`. The Edge middleware imports
 * `@ledgerly/auth/cloudflareAccess` and `@ledgerly/auth/response` by their
 * subpaths instead — neither touches the database, `server-only`, or a Node
 * built-in, which is what lets the same verifier run on both sides of D-24.
 */

export { verifyAccessJwt, currentAccessConfig } from "./cloudflareAccess";
export type { AccessConfig } from "./cloudflareAccess";
export { getAccessKeySet } from "./jwks";
export {
  resolveUserForIdentity,
  currentProvisionOptions,
  IdentityConflictError,
} from "./provision";
export type { AuthDatabase, ProvisionOptions, ProvisionOutcome } from "./provision";
export {
  resolveIdentityFromHeaders,
  requireIdentityFromHeaders,
  requireAuthRoute,
  AuthError,
  ACCESS_JWT_HEADER,
  DEV_IDENTITY,
} from "./identity";
export { ACCESS_DENIED_RESPONSE, buildAccessDeniedResponse } from "./response";
export { isOnboarded } from "./types";
export type { AccessIdentity, AuthFailureReason, AuthUser, VerifyResult } from "./types";
