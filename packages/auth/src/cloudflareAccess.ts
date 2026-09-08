import { errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { edgeEnv } from "@ledgerly/config/edge";

import { getAccessKeySet } from "./jwks";
import type { AccessIdentity, AuthFailureReason, VerifyResult } from "./types";

/**
 * packages/auth/src/cloudflareAccess.ts — Cloudflare Access JWT
 * verification (tasks 3.2/3.3, contract §2).
 *
 * The only header read is `Cf-Access-Jwt-Assertion`. The convenience
 * authenticated-email header Cloudflare also injects is never read
 * anywhere in this package: it carries no signature and is trivially
 * forgeable if anything ever reaches the app off-tunnel.
 */

/** The Cloudflare Access application this instance accepts tokens for.
 * Injected rather than read inline so tests can exercise the
 * `not_configured` branch without mutating the environment. */
export type AccessConfig = {
  aud: string | undefined;
  teamDomain: string | undefined;
};

export function currentAccessConfig(): AccessConfig {
  return {
    aud: edgeEnv.CF_ACCESS_AUD,
    teamDomain: edgeEnv.CF_ACCESS_TEAM_DOMAIN,
  };
}

/** Cloudflare Access signs with RS256. Pinning forecloses algorithm
 * confusion — `jose` will not honour `alg: none` regardless, but pinning
 * also stops a symmetric algorithm being substituted if the key set ever
 * gained an oct key. Forkd pins nothing. */
const ALLOWED_ALGORITHMS = ["RS256"] as const;

/**
 * `exp` is required so a token without one is a rejection rather than a
 * token that never expires. `nbf` is deliberately absent: `jose` validates
 * it when present, and Cloudflare does not always emit it — requiring it
 * would reject valid tokens.
 */
const REQUIRED_CLAIMS = ["sub", "exp", "iat", "aud", "iss"] as const;

/**
 * Set explicitly rather than inherited. FORKD_AUTH.md §3 asserts `jose`
 * defaults to 60 seconds; that claim is unverified and the default has
 * differed across major versions.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

function fail(reason: AuthFailureReason): VerifyResult {
  return { ok: false, reason };
}

/**
 * Cloudflare emits `aud` as an array. A naive `payload.aud !== expected`
 * rejects every real token; a naive `includes` on a string matches a
 * substring. Narrow on `Array.isArray` and compare with `===`.
 */
function audienceContains(aud: JWTPayload["aud"], expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

/**
 * One catch, one classifier, one log site (task 3.3). The default arm is
 * `bad_signature`, never `ok` — an unrecognised error is a rejection.
 */
function classify(error: unknown): AuthFailureReason {
  if (error instanceof errors.JWTExpired) return "expired";

  if (error instanceof errors.JWTClaimValidationFailed) {
    // A claim that is absent entirely is a different fault from one that is
    // present and wrong, even though both produce the same 403.
    if (error.reason === "missing") return "missing_required_claim";
    switch (error.claim) {
      case "aud":
        return "wrong_audience";
      case "iss":
        return "wrong_issuer";
      case "nbf":
        return "not_yet_valid";
      default:
        return "missing_required_claim";
    }
  }

  if (error instanceof errors.JOSEAlgNotAllowed) return "wrong_algorithm";
  if (error instanceof errors.JWKSNoMatchingKey) return "unknown_kid";
  if (error instanceof errors.JWKSTimeout) return "jwks_unavailable";
  if (error instanceof errors.JWSSignatureVerificationFailed) return "bad_signature";
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) {
    return "malformed_token";
  }
  if (error instanceof errors.JWKSInvalid || error instanceof errors.JWKSMultipleMatchingKeys) {
    return "jwks_unavailable";
  }
  // A network failure reaching the JWKS endpoint arrives as a plain
  // TypeError from fetch rather than a jose error class.
  if (error instanceof TypeError) return "jwks_unavailable";

  return "bad_signature";
}

/**
 * Verifies a Cloudflare Access JWT and extracts the identity.
 *
 * `keySet` and `config` are parameters, not module-level mutable seams, so
 * tests inject a local key set and a chosen audience by argument. There is
 * no test-only export, no global reset, and no environment-mode branch
 * anywhere in this package (task 3.10).
 */
export async function verifyAccessJwt(
  token: string | null | undefined,
  keySet?: JWTVerifyGetKey,
  config: AccessConfig = currentAccessConfig(),
): Promise<VerifyResult> {
  if (!token || token.trim() === "") return fail("missing_token");

  // (a) Configuration precondition. `jose` skips audience validation
  // ENTIRELY when `audience` is undefined, so an unset CF_ACCESS_AUD would
  // silently turn "reject hard on aud mismatch" into "accept any Access
  // token from any application on this team". Refuse to verify instead.
  // This is the check Forkd does not have — D-25.
  if (!config.aud || !config.teamDomain) return fail("not_configured");

  // Resolved HERE, not as a default parameter. Default parameters evaluate
  // on entry, before the guard above — and `getAccessKeySet()` throws when
  // the team domain is unset, so a defaulted `keySet` turned a clean
  // `not_configured` rejection into a thrown 500 in exactly the
  // misconfiguration this branch exists to report. Found in the task 3.12
  // review; branch 3e of the contract table was unreachable in production.
  let keys: JWTVerifyGetKey;
  try {
    keys = keySet ?? getAccessKeySet();
  } catch {
    return fail("not_configured");
  }

  const expectedIssuer = `https://${config.teamDomain}`;

  let payload: JWTPayload;
  let algorithm: string;
  try {
    // (b) jose
    const verified = await jwtVerify(token, keys, {
      algorithms: [...ALLOWED_ALGORITHMS],
      audience: config.aud,
      issuer: expectedIssuer,
      requiredClaims: [...REQUIRED_CLAIMS],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload;
    algorithm = verified.protectedHeader.alg;
  } catch (error) {
    return fail(classify(error));
  }

  // (c) Redundant explicit assertions. `jose` has already checked all
  // three. They are repeated because (a) only protects against an *absent*
  // audience, and no single future refactor of how config is assembled
  // should be able to silently disable the check the entire authentication
  // model rests on. The cost is three comparisons on a path that has just
  // done RSA. D-25.
  if (algorithm !== "RS256") return fail("wrong_algorithm");
  if (!audienceContains(payload.aud, config.aud)) return fail("wrong_audience");
  if (payload.iss !== expectedIssuer) return fail("wrong_issuer");

  // Never defaulted to an empty string — Forkd's shape (FORKD_AUTH.md §3). Under
  // D-06 `sub` carries a unique index, so an empty one would match every
  // subsequent subject-less token and collapse them into a single shared
  // account. This also rejects Cloudflare *service tokens*, whose `sub` is
  // "" and whose identity lives in `common_name`: correct, because Ledgerly
  // has no machine-access surface. See D-26 — not a bug to be "fixed".
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) return fail("empty_subject");

  const rawEmail = typeof payload["email"] === "string" ? (payload["email"] as string).trim() : "";
  if (!rawEmail) return fail("missing_email");

  const rawName = typeof payload["name"] === "string" ? (payload["name"] as string).trim() : "";

  const identity: AccessIdentity = {
    sub,
    // Lowercased at extraction. The database also enforces this with a
    // UNIQUE index on lower(email) — FORKD_AUTH.md finding #6 notes Forkd
    // lowercases in application code only, so an admin import could insert
    // a case variant that never matches.
    email: rawEmail.toLowerCase(),
    name: rawName === "" ? null : rawName,
    issuedAt: payload.iat as number,
    expiresAt: payload.exp as number,
  };

  return { ok: true, identity };
}
