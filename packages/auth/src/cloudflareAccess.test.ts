import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyAccessJwt } from "./cloudflareAccess";
import type { AccessConfig } from "./cloudflareAccess";
import { buildAccessDeniedResponse } from "./response";

/**
 * Contract §12.1. No database and no network: fixtures are generated
 * keypairs and the key set is injected as an argument, which is exactly
 * why `verifyAccessJwt` takes `keySet` as a parameter rather than reaching
 * for a module-level seam.
 */

const AUD = "a".repeat(64);
const TEAM_DOMAIN = "testteam.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const CONFIG: AccessConfig = { aud: AUD, teamDomain: TEAM_DOMAIN };

const KID = "test-key-1";
const OTHER_KID = "rotated-key-2";

/** Inferred from jose rather than annotated `CryptoKey`: that global is
 * not in this package's ES2022 lib, and widening the lib for a test file
 * would be the wrong trade. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let signingKey: PrivateKey;
let otherSigningKey: PrivateKey;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  signingKey = primary.privateKey;
  otherSigningKey = other.privateKey;

  const jwk = await exportJWK(primary.publicKey);
  // The JWKS deliberately contains ONLY the primary key, so a token signed
  // with `otherSigningKey` exercises the unknown-kid path.
  keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
});

type Claims = Record<string, unknown>;

async function sign(
  claims: Claims = {},
  opts: { kid?: string; key?: PrivateKey; expiresIn?: number | null; notBefore?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({
    email: "Alice@Example.COM",
    name: "Alice Example",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setAudience(AUD);

  if (claims["sub"] === undefined) jwt = jwt.setSubject("cf-sub-alice");
  if (opts.expiresIn !== null) jwt = jwt.setExpirationTime(now + (opts.expiresIn ?? 600));
  if (opts.notBefore !== undefined) jwt = jwt.setNotBefore(now + opts.notBefore);

  return jwt.sign(opts.key ?? signingKey);
}

describe("verifyAccessJwt", () => {
  // --- 1 -------------------------------------------------------------
  it("accepts a valid token and extracts the identity", async () => {
    const result = await verifyAccessJwt(await sign(), keySet, CONFIG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.sub).toBe("cf-sub-alice");
    // Lowercased at extraction.
    expect(result.identity.email).toBe("alice@example.com");
    expect(result.identity.name).toBe("Alice Example");
    expect(result.identity.expiresAt).toBeGreaterThan(result.identity.issuedAt);
  });

  // --- 2 -------------------------------------------------------------
  it("rejects an expired token", async () => {
    const result = await verifyAccessJwt(await sign({}, { expiresIn: -120 }), keySet, CONFIG);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  // --- 3 -------------------------------------------------------------
  it("rejects a token minted for a different application audience", async () => {
    const result = await verifyAccessJwt(await sign(), keySet, {
      ...CONFIG,
      aud: "b".repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_audience" });
  });

  // --- 3b ------------------------------------------------------------
  it("accepts an aud array that contains the configured audience", async () => {
    // Cloudflare emits `aud` as an array; a naive !== would reject every
    // real token and a naive substring includes would over-match.
    const token = await sign({ aud: [AUD, "c".repeat(64)] });
    const result = await verifyAccessJwt(token, keySet, CONFIG);
    expect(result.ok).toBe(true);
  });

  // --- 3c ------------------------------------------------------------
  it("refuses to verify when CF_ACCESS_AUD is unconfigured, rather than skipping the check", async () => {
    // The regression test for FORKD_AUTH.md's silent failure: jose skips
    // audience validation ENTIRELY when `audience` is undefined (D-25).
    for (const aud of [undefined, ""]) {
      const result = await verifyAccessJwt(await sign(), keySet, { ...CONFIG, aud });
      expect(result).toEqual({ ok: false, reason: "not_configured" });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses to verify when CF_ACCESS_TEAM_DOMAIN is unconfigured", async () => {
    const result = await verifyAccessJwt(await sign(), keySet, {
      ...CONFIG,
      teamDomain: undefined,
    });
    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });

  // --- 4 -------------------------------------------------------------
  it("rejects a missing token", async () => {
    for (const token of [null, undefined, "", "   "]) {
      const result = await verifyAccessJwt(token, keySet, CONFIG);
      expect(result).toEqual({ ok: false, reason: "missing_token" });
    }
  });

  // --- 5 -------------------------------------------------------------
  it("rejects a tampered signature", async () => {
    const token = await sign();
    const [header, payload, signature] = token.split(".");
    const flipped = (signature ?? "").startsWith("A")
      ? `B${(signature ?? "").slice(1)}`
      : `A${(signature ?? "").slice(1)}`;
    const result = await verifyAccessJwt(`${header}.${payload}.${flipped}`, keySet, CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects a payload tampered after signing", async () => {
    const token = await sign();
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "attacker", email: "attacker@example.com" }),
    ).toString("base64url");
    const result = await verifyAccessJwt(`${header}.${forged}.${signature}`, keySet, CONFIG);
    expect(result.ok).toBe(false);
  });

  // --- 6 -------------------------------------------------------------
  it("rejects a token from another Cloudflare team", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email: "alice@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setSubject("cf-sub-alice")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .setIssuer("https://attacker.cloudflareaccess.com")
      .setAudience(AUD)
      .sign(signingKey);

    const result = await verifyAccessJwt(token, keySet, CONFIG);
    expect(result).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  // --- 7 -------------------------------------------------------------
  it("rejects a token signed with a key absent from the JWKS", async () => {
    const token = await sign({}, { kid: OTHER_KID, key: otherSigningKey });
    const result = await verifyAccessJwt(token, keySet, CONFIG);
    expect(result).toEqual({ ok: false, reason: "unknown_kid" });
  });

  // --- 8 -------------------------------------------------------------
  it("rejects a token that is not yet valid", async () => {
    const result = await verifyAccessJwt(await sign({}, { notBefore: 120 }), keySet, CONFIG);
    expect(result).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  // --- 9 -------------------------------------------------------------
  it("rejects a token with no exp claim rather than treating it as eternal", async () => {
    const result = await verifyAccessJwt(await sign({}, { expiresIn: null }), keySet, CONFIG);
    expect(result).toEqual({ ok: false, reason: "missing_required_claim" });
  });

  // --- 10 ------------------------------------------------------------
  it("rejects an empty sub instead of storing it as an empty string", async () => {
    // Regression test against Forkd defaulting an absent sub to "". Under D-06
    // `cf_access_sub` is unique, so an empty sub would collapse every
    // subject-less token — including Cloudflare service tokens — into one
    // shared account. D-26.
    for (const sub of ["", "   "]) {
      const result = await verifyAccessJwt(await sign({ sub }), keySet, CONFIG);
      expect(result).toEqual({ ok: false, reason: "empty_subject" });
    }
  });

  it("rejects a service-token-shaped JWT (empty sub, common_name present)", async () => {
    const token = await sign({ sub: "", common_name: "ci-service-token" });
    const result = await verifyAccessJwt(token, keySet, CONFIG);
    expect(result).toEqual({ ok: false, reason: "empty_subject" });
  });

  // --- 11 ------------------------------------------------------------
  it("rejects a token with no email claim", async () => {
    for (const email of [undefined, "", "  "]) {
      const result = await verifyAccessJwt(await sign({ email }), keySet, CONFIG);
      expect(result).toEqual({ ok: false, reason: "missing_email" });
    }
  });

  // --- 12 ------------------------------------------------------------
  it("rejects an unsigned alg:none token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${enc({ alg: "none" })}.${enc({
      sub: "attacker",
      email: "attacker@example.com",
      iss: ISSUER,
      aud: AUD,
      iat: now,
      exp: now + 600,
    })}.`;

    const result = await verifyAccessJwt(token, keySet, CONFIG);
    expect(result.ok).toBe(false);
  });

  it("rejects a structurally malformed token", async () => {
    for (const token of ["not-a-jwt", "a.b", "a.b.c.d"]) {
      const result = await verifyAccessJwt(token, keySet, CONFIG);
      expect(result.ok).toBe(false);
    }
  });

  // --- 13 ------------------------------------------------------------
  it("accepts a token 30s past exp, within the 60s clock tolerance", async () => {
    const result = await verifyAccessJwt(await sign({}, { expiresIn: -30 }), keySet, CONFIG);
    expect(result.ok).toBe(true);
  });

  it("omits an absent name claim rather than inventing one", async () => {
    const result = await verifyAccessJwt(await sign({ name: undefined }), keySet, CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBeNull();
  });
});

// --- 14 ----------------------------------------------------------------
describe("failure responses (task 3.3)", () => {
  it("are byte-identical across every rejection reason", async () => {
    const [header, payload, signature] = (await sign()).split(".");
    const tampered = `${header}.${payload}.A${(signature ?? "").slice(1)}`;

    const rejections = await Promise.all([
      verifyAccessJwt(await sign({}, { expiresIn: -120 }), keySet, CONFIG), // expired
      verifyAccessJwt(await sign(), keySet, { ...CONFIG, aud: "b".repeat(64) }), // wrong_audience
      verifyAccessJwt(null, keySet, CONFIG), // missing_token
      verifyAccessJwt(tampered, keySet, CONFIG), // bad_signature
      verifyAccessJwt(await sign({}, { kid: OTHER_KID, key: otherSigningKey }), keySet, CONFIG),
      verifyAccessJwt(await sign(), keySet, { ...CONFIG, aud: undefined }), // not_configured
    ]);

    // Sanity: these really are six distinct internal reasons.
    const reasons = rejections.map((r) => (r.ok ? "OK" : r.reason));
    expect(new Set(reasons).size).toBe(6);
    expect(reasons).not.toContain("OK");

    const rendered = await Promise.all(
      rejections.map(async (result) => {
        const response = buildAccessDeniedResponse(result.ok ? undefined : result.reason);
        return {
          status: response.status,
          headers: [...response.headers.entries()].sort(),
          body: await response.text(),
        };
      }),
    );

    const [first] = rendered;
    expect(first).toBeDefined();
    for (const rendition of rendered) {
      expect(rendition).toEqual(first);
    }
    // And it leaks nothing about why.
    expect(first?.status).toBe(403);
    expect(first?.body).toBe("Access denied.");
    expect(JSON.stringify(first)).not.toMatch(/expired|audience|signature|kid|configured/i);
  });
});
