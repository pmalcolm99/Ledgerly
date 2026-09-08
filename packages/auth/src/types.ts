import type { users } from "@ledgerly/db/schema";

/**
 * packages/auth/src/types.ts — the auth module's vocabulary
 * (docs/private/PHASE3_AUTH_CONTRACT.md §2.2).
 */

/** A verified Cloudflare Access identity. Every field here has been
 * checked; nothing on it is optional-but-maybe-empty. */
export type AccessIdentity = {
  /** The JWT `sub` claim. Non-empty — see D-26. This is the identity
   * (D-06); it maps to `users.cf_access_sub`. */
  sub: string;
  /** Lowercased, non-empty. An attribute, never a join key (D-06). */
  email: string;
  /** The `name` claim -> `users.display_name`. */
  name: string | null;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Why a token was rejected. Structured for logging and for tests — it is
 * never returned to a client. Every value maps to the same byte-identical
 * 403 (task 3.3, contract §5).
 */
export type AuthFailureReason =
  /** CF_ACCESS_AUD / CF_ACCESS_TEAM_DOMAIN absent. Refuse to verify rather
   * than verify without an audience — see D-25. */
  | "not_configured"
  | "missing_token"
  | "malformed_token"
  | "bad_signature"
  | "unknown_kid"
  | "expired"
  | "not_yet_valid"
  | "wrong_audience"
  | "wrong_issuer"
  | "wrong_algorithm"
  | "missing_required_claim"
  /** `sub` present but empty. Cloudflare service tokens look like this;
   * under D-06 accepting one would collapse every such token into a single
   * shared account. See D-26. */
  | "empty_subject"
  | "missing_email"
  | "jwks_unavailable";

export type VerifyResult =
  { ok: true; identity: AccessIdentity } | { ok: false; reason: AuthFailureReason };

/** A provisioned application user. */
export type AuthUser = typeof users.$inferSelect;

/** Onboarding is complete only when both names are present. `onboarded_at`
 * is written in the same statement (D-28), so the two cannot disagree —
 * this helper is the single place that decides. */
export function isOnboarded(user: AuthUser): boolean {
  return user.onboardedAt !== null && user.firstName !== null && user.lastName !== null;
}
