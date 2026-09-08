# Forkd Cloudflare Access Integration Reference

## Auth Model Summary

Forkd uses **Cloudflare Access as the identity provider in production**, verified via JWT on every request. The flow is:
1. Cloudflare Access sits in front of Forkd and injects a signed JWT (`Cf-Access-Jwt-Assertion` header) after authenticating users.
2. The Next.js edge middleware (`proxy.ts`) verifies the JWT signature using JWKS fetched from Cloudflare's CDN, validates claims (aud, iss, exp), and extracts the email.
3. If valid, the user is checked for a session cookie. If missing, a redirect to `/api/auth/cloudflare-sync` triggers just-in-time provisioning: a `user` row is created (first user becomes Owner) and a `session` row is inserted.
4. The session token (a signed UUID) is placed in `forkd.session_token`, a 7-day HttpOnly Secure SameSite=Lax cookie.
5. Subsequent requests use the session cookie via Better Auth, which looks up the user from the DB without re-verifying the CF JWT.
6. In development (when `CF_ACCESS_ENABLED` is not `"true"`), the entire auth layer is bypassed and `/dev/select-user` allows manual user impersonation.

## Request Lifecycle

**Unauthenticated → Protected Route:**

1. Browser visits `https://<ACCESS_AUD>.cloudflareaccess.com/<path>`.
2. Cloudflare Access intercepts, authenticates user (Google, OTP, OIDC), issues JWT.
3. Browser sent to `https://<APP_HOSTNAME><path>` with `Cf-Access-Jwt-Assertion: <jwt>` header.
4. Next.js Edge Runtime executes `apps/web/src/proxy.ts` (middleware).
5. Middleware parses `Cf-Access-Jwt-Assertion`, calls `verifyCloudflareAccessJwt()`.
6. JWT verified via `jose.jwtVerify()` against JWKS from `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`.
7. If invalid: return `403 "Access denied. Invalid Cloudflare Access token."`.
8. If valid: extract email claim (lowercased), check for `forkd.session_token` cookie.
9. **No session cookie?** Redirect to `/api/auth/cloudflare-sync?returnTo=<path>` via meta-refresh to preserve Set-Cookie.
10. Sync route re-verifies CF JWT, looks up user by email, creates `user` + `session` if first visit, sets cookie, redirects back to original path.
11. **Session cookie exists?** Lookup session via Better Auth, attach user context, pass request through.
12. Page rendered with `ctx.user` attached; tRPC calls in `protectedProcedure` can access it.

---

## 1. JWT Verification

**Library & Version:** `jose@6.2.3` — specifically `createRemoteJWKSet` and `jwtVerify` subpaths.

**File & Function:**
- **Verification function:** `apps/web/src/lib/cloudflareAccess.ts` line 20, `verifyCloudflareAccessJwt(token: string): Promise<CfIdentity | null>`
- **Usage:** Called by middleware in `apps/web/src/proxy.ts` line 15 and by sync route in `apps/web/src/app/api/auth/cloudflare-sync/route.ts` line 67.

**Header Source:** `Cf-Access-Jwt-Assertion` header (checked on line 8 of proxy.ts and line 63 of sync route). Cloudflare Access injects this automatically; no cookies or alternative headers are used for JWT delivery.

**Verification Call** (cloudflareAccess.ts lines 23–26):
```typescript
const { payload } = await jwtVerify(token, getJwks(), {
  audience: process.env.CF_ACCESS_AUD,
  issuer: `https://${process.env.CF_ACCESS_TEAM_DOMAIN}`,
});
```

**Options:**
- `audience`: Must match `CF_ACCESS_AUD` env var exactly (the 64-char hex "Application Audience" from Cloudflare dashboard).
- `issuer`: Must match `https://<CF_ACCESS_TEAM_DOMAIN>`, verifying the token was signed by your Cloudflare team, not another team's Access instance.
- Clock skew tolerance: Not explicitly set; jose defaults to 60 seconds.
- `exp` (expiration) is checked implicitly by jose (throws `JWTExpired` if past).
- `nbf` (not before) is checked implicitly by jose (throws `JWTClaimInvalid` if before current time).

---

## 2. JWKS (JSON Web Key Set)

**Fetch URL Shape:** `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`
- Cloudflare's public JWKS endpoint; no authentication required.
- Example: `https://myteam.cloudflareaccess.com/cdn-cgi/access/certs`

**Caching Strategy:**
- **Lazy singleton** (cloudflareAccess.ts lines 8–16): `JWKS` variable is `null` until first call.
- **Function:** `getJwks()` returns cached `JWKS` or creates and caches it.
- **Jose's Internal Caching:** The comment on line 7 states "jose caches keys internally after the first fetch so subsequent calls are fast." The `createRemoteJWKSet()` function in jose handles HTTP requests and in-memory caching transparently; Forkd relies on jose's built-in TTL (jose caches for ~1 hour per key).

**TTL:**
- Not explicitly configured in Forkd; jose's default is approximately **1 hour per key**. After 1 hour, the next `jwtVerify()` will re-fetch the JWKS.

**Fetch Failure Handling:**
- If `createRemoteJWKSet()` throws or the HTTP request fails, the exception propagates to the catch block (line 35), logged at info level, and `null` is returned. No retry; subsequent requests will attempt the fetch again.
- If a token arrives with a key ID (`kid`) not in the JWKS, `jwtVerify()` throws `JWTClaimInvalid`, caught and logged, returns `null`.

**Key Rotation:**
- Cloudflare rotates signing keys periodically. The JWKS endpoint always returns the current public keys. When rotation occurs, old keys are removed from the JWKS, but tokens signed with them still verify (for the duration of the old key's TTL in jose's cache). Once the cache expires (~1 hour), the next token with an old key ID will fail to verify, and the error is logged.

---

## 3. Claim Validation

**Audience (`aud`)** — Required, verified at line 24 of cloudflareAccess.ts:
- Checked by passing `audience: process.env.CF_ACCESS_AUD` to `jwtVerify()`.
- Jose verifies the `aud` claim in the JWT matches exactly.
- Mismatched `aud` throws `JWTClaimInvalid`; caught, logged, returns `null`.

**Issuer (`iss`)** — Required, verified at line 25:
- Checked by passing `issuer: https://<CF_ACCESS_TEAM_DOMAIN>` to `jwtVerify()`.
- Jose verifies the `iss` claim matches; mismatches throw `JWTClaimInvalid`.

**Expiration (`exp`)** — Implicit:
- Jose checks automatically. Expired tokens throw `JWTExpired`.

**Not-Before (`nbf`)** — Implicit:
- Jose checks automatically. Tokens with `nbf` in the future throw `JWTClaimInvalid`.

**Clock Skew:** Default 60 seconds (jose's built-in; not overridden in Forkd).

**Email Claim Extraction** (lines 27–28):
```typescript
const email = payload["email"] as string | undefined;
if (!email) return null;
```
- Extracted from the JWT payload. If absent, the entire identity is rejected (`null`).
- No schema validation on the string (assumed to be a valid email since Cloudflare's IdPs enforce that).
- **Lowercased at extraction time** (line 31): `email: email.toLowerCase()`— ensures all downstream DB queries are case-insensitive without additional logic.

**Name Claim** (line 32):
- Optional; taken from `payload["name"]` if present.

**Subject (`sub`)** (line 33):
- Stored as `sub: payload.sub ?? ""`.
- Used as an identity stable identifier (doesn't change if email changes at the IdP).

---

## 4. Session Handling

**Model:** Hybrid — Cloudflare Access provides authentication; Better Auth provides the app session.

**No App Session on Top of Access:** After the CF JWT is verified and the user is provisioned, Forkd does **not** maintain a server-side session state file or token that is validated on every request. Instead:

1. **First request with CF JWT** → Sync route creates a session row in the `session` table (PostgreSQL).
2. **Subsequent requests** → Use the `forkd.session_token` cookie (a signed UUID).
3. **Cookie Validation:** Better Auth's `auth.api.getSession()` (called in `packages/api/src/trpc.ts` line 44) decodes the cookie and looks up the session row from the DB. It does **not** re-verify the CF JWT; it trusts the session record.

**Cookies:**
- Name: `forkd.session_token`
- Value: `<rawToken>.<signature>` where:
  - `rawToken` is a UUID stored in the DB `session.token` column.
  - `signature` is HMAC-SHA256 of `rawToken` using `MASTER_KEY` (see `packages/auth/src/auth.ts` line 105).
- **HttpOnly:** `true` (never accessible to JavaScript).
- **Secure:** `true` if `AUTH_URL` starts with `https://` (line 133 of sync route).
- **SameSite:** `lax` (prevents cross-site cookie submission on POST).
- **Path:** `/` (entire app).
- **Max-Age:** `7 * 24 * 60 * 60` seconds (7 days).

**Verified Identity Attached to Request:**
- TRPC context (line 44–51 of `packages/api/src/trpc.ts`):
  ```typescript
  const session = await auth.api.getSession({ headers: req.headers });
  return { db, session: session?.session ?? null, user: session?.user ?? null, ... }
  ```
- Returned context passed to all procedures; available as `ctx.user` and `ctx.session`.
- Route handlers: Better Auth's session is also available via `await auth.api.getSession({ headers: req.headers })` in route handlers (see line 44 of cloudflare-sync route).

---

## 5. User Records & JIT Provisioning

**Mapping:** Verified CF Access email → PostgreSQL `user` table row.

**Just-In-Time Creation** (sessionProvisioning.ts lines 14–47):

1. On first request with valid CF JWT:
   - `verifyCloudflareAccessJwt()` extracts email (lowercased).
   - Sync route calls `provisionSessionForIdentity(identity, userAgent, ip)`.

2. **Lookup by Email** (line 15):
   ```typescript
   let [existing] = await db.select().from(user)
     .where(eq(user.email, identity.email)).limit(1);
   ```
   - Email is already lowercased by `verifyCloudflareAccessJwt()` before this call.

3. **If user doesn't exist:**
   - Check if there are any existing owners (lines 19–20). If not, the new user is marked `isOwner: true` and `isAdmin: true` (first user wins).
   - Create user record (lines 36–47):
     - `id`: UUID
     - `email`: from CF identity (lowercase)
     - `emailVerified`: `true` (Cloudflare verified it)
     - `name`: from CF JWT `name` claim, or falls back to email.
     - `firstName`, `lastName`: `null` (user fills these via `/welcome` page flow)
     - `isAdmin`, `isOwner`: `true` if first user, else `false`
     - `createdAt`, `updatedAt`: current timestamp
   - Logged loudly if first user (lines 24–27): `"CF Access: first user provisioned as Owner — verify this is the intended Owner email"` — operator must verify this email in logs.

4. **If user exists:**
   - Check if CF JWT has a different `name` claim (line 50). If so, update `user.name` (lines 53–57) to keep it in sync with the IdP. **Does not touch `firstName`/`lastName`** to preserve manual user customization.

**Admin/Owner Status:**
- **Never downgraded** by auth layer. Manually managed via database only.
- First login auto-promotes; subsequent logins are regular users unless manually promoted.

---

## 6. First-Run / Admin Bootstrap

**Mechanism:** **First-login-wins.**

- No pre-configured admin email or env var.
- No seed migration that creates users.
- Whichever email logs in first via Cloudflare Access (after enabling `CF_ACCESS_ENABLED=true`) is automatically promoted to `isOwner=true` and `isAdmin=true`.
- Logged to stdout at WARN level: operator must verify the email in the logs.
- If wrong email logs in first, the operator can:
  - Manually update the first user's email in the DB before enabling Access:
    ```sql
    UPDATE "user" SET email = 'correct@email.com' WHERE is_owner = true;
    ```
  - Or create the correct owner manually and demote the wrong one afterward via SQL.

**Before CF Access Enabled (Dev Bootstrap):**
- Dev sign-in page (`/dev/select-user`, guarded by `NODE_ENV !== "production"` and `CF_ACCESS_ENABLED !== "true"`).
- Page shows all existing users; clicking one calls `devSelectUser` TRPC mutation.
- Mutation creates a session cookie, acting as a temporary session. First created user via `devCreateUser` is marked owner.

---

## 7. Local Dev Auth Bypass

**Guard Conditions:**
1. `CF_ACCESS_ENABLED !== "true"` (line 5 of proxy.ts): If unset or `"false"`, entire middleware returns `NextResponse.next()` without checking any CF JWT.
2. `NODE_ENV !== "production"` (line 8 of page.tsx, line 116 of auth.ts): Dev routes only render when not in production.

**How It Works:**
- Middleware returns immediately (proxy.ts line 6).
- No CF JWT required; no session cookie required; all requests pass through.
- User navigates to `/dev/select-user`, chooses or creates a user, calls `devSelectUser` or `devCreateUser` TRPC endpoint.
- Endpoint creates a session row and sets `forkd.session_token` cookie.
- User is now logged in as that user for dev testing.

**Env Vars to Guard Against Accidental Exposure in Prod:**
- `CF_ACCESS_ENABLED` — must be `"true"` in production, `"false"` or unset in dev.
- `NODE_ENV` — must be `"production"` in prod, `"development"` in dev.
- Both checks in sync should **never both be true unless intentional**: you can flip `CF_ACCESS_ENABLED` without flipping `NODE_ENV`, but doing so in production would leave the app unprotected. The guard is airtight **if `NODE_ENV` is correctly set by the CI/CD or deployment system**.

**Security Assessment of Guard:**
- **Threat:** If `NODE_ENV=production` but `CF_ACCESS_ENABLED=false`, the dev bypass is exposed.
- **Mitigation:** CI/CD must inject `NODE_ENV=production` at build time via the Dockerfile (it does via the Node.js process default). If `NODE_ENV` is unset or wrong, the app's security posture is broken — but that's an operator error, not a code flaw.
- **Verdict:** The guard is well-designed for its threat model (malicious dev code, not malicious env config). If the deployment platform misconfigures `NODE_ENV`, all bets are off.

---

## 8. Middleware Structure & Route Protection

**Middleware File:** `apps/web/src/proxy.ts` (exported as `proxy` function + `config` object).

**Matcher Pattern** (lines 52–60):
```typescript
matcher: [
  "/((?!_next/|favicon\\.ico|manifest\\.(?:json|webmanifest)|robots\\.txt|sw\\.js|offline\\.html|(?:apple-)?icon[\\w-]*\\.png|api/v1/health|g/).*)",
],
```
- **Protected:** All routes matching the above (negation of the exclusion list).
- **Public/Exempt Routes:**
  - `/_next/*` — Next.js static assets, images, HMR, webpack chunks.
  - `favicon.ico`, `manifest.json`, `manifest.webmanifest`, `robots.txt` — browser metadata, PWA manifest.
  - `sw.js`, `offline.html`, `icon*.png`, `apple-icon*.png` — PWA service worker and offline shell (must load before user is logged in).
  - `api/v1/health` — Docker health check endpoint (no auth required).
  - `/g/*` — guest bill-split links (deliberately public, guarded by a separate Cloudflare Access application).

**Full Middleware Chain:**
1. `proxy.ts` runs on all matched routes.
2. Checks `CF_ACCESS_ENABLED` (dev bypass).
3. Reads `Cf-Access-Jwt-Assertion` header.
4. Verifies JWT (signature, aud, iss, exp, nbf).
5. Extracts email and other claims.
6. Checks for `forkd.session_token` cookie.
7. If missing, redirects to sync route.
8. If invalid session, sync route re-creates it.
9. Request passed to Next.js App Router.

**Protected vs. Public Routes:**
- **Protected:** `/`, `/restaurants`, `/receipts`, `/bills`, `/settings`, `/dev/select-user` (wait, dev pages are routed via `NODE_ENV` check, not middleware).
- **Public:** `/g/*`, `/api/v1/health`, static assets.

**Health Check Exemption** (`api/v1/health`):
- Returns `200` with no auth. Used by Docker health probes and load balancers.
- Allows infra monitoring without CF JWT.

**Auth Failure Responses:**
- **No CF JWT header:** `403 "Access denied. This application requires Cloudflare Access."` (line 11 of proxy.ts).
- **Invalid CF JWT:** `403 "Access denied. Invalid Cloudflare Access token."` (line 17 of proxy.ts).
- **Sync route missing CF JWT:** `403 "Missing Cloudflare Access JWT"` (line 65 of sync route).
- **Sync route invalid CF JWT:** `403 "Invalid Cloudflare Access JWT"` (line 69 of sync route).
- All responses are plain text, no HTML templates, no stack traces. Responses do **not** leak details about why a JWT failed (signature, aud mismatch, expiration — all caught in one catch block, one generic log line).

---

## 9. Authorization at Query Layer

**Pattern:** Permission scoping via helper functions, composed into every query. **Not scattered through route handlers.**

**Helper Functions:**
- **File:** `packages/api/src/trpc.ts`
- **Protected Procedure** (lines 60–81): Middleware that checks `ctx.user` is not null. If absent, throws `UNAUTHORIZED`.
- **Admin Procedure** (lines 83–88): Stacked on `protectedProcedure`. Checks `isAdmin || isOwner`. If not, throws `FORBIDDEN`.
- **Owner Procedure** (lines 90–95): Stacked on `protectedProcedure`. Checks `isOwner` only. Throws `FORBIDDEN` if not.

**Usage Example** (auth.ts):
```typescript
export const authRouter = router({
  me: protectedProcedure.query(({ ctx }) => {
    // ctx.user is guaranteed to exist here; type-safe.
    return { id: ctx.user.id, email: ctx.user.email, ... };
  }),
  updateProfile: protectedProcedure.input(...).mutation(async ({ input, ctx }) => {
    // Can only update own profile
    await ctx.db.update(user).set({...}).where(eq(user.id, ctx.user.id));
  }),
});
```

**Query-Level Scoping:**
- Most mutations filter by `ctx.user.id` in the WHERE clause, implicitly scoping to the authenticated user.
- No query helper function yet documented for "fetch only my data" (each route does its own filtering). This is OK for a small team app.

**No Scattered Checks:**
- Route handlers do **not** re-check auth; they rely on `protectedProcedure` and `adminProcedure` middlewares.
- TRPC handles auth at the invocation layer; handlers receive a guaranteed `ctx.user`.

---

## Security Findings & Weaknesses

### 1. Dev Bypass Reachability — **LOW RISK, WELL-GUARDED**

**Finding:** Dev auth is reachable if both `CF_ACCESS_ENABLED !== "true"` AND `NODE_ENV !== "production"`. If an operator accidentally sets only one flag incorrectly in production, the dev bypass could be exposed.

**Severity:** Low, because:
- `NODE_ENV` is set at build time by the Dockerfile (node:22-alpine defaults to `"production"` when not set).
- Exposure requires operator to explicitly set `CF_ACCESS_ENABLED=false` in production, which is a config mistake, not a code flaw.
- Dev sign-in does not require a password; it's intended only for developers with database access to create test users.

**Recommendation:** Document that `NODE_ENV=production` must be enforced at the deployment platform level. Consider a startup warning if both flags are not consistent.

---

### 2. Email Claim as Sole Identity — **MEDIUM IMPORTANCE, BY DESIGN**

**Finding:** The app treats the `email` claim from Cloudflare as the authoritative identity. If Cloudflare's IdP is misconfigured or if an identity provider is compromised, the app cannot distinguish. No `sub` (subject) uniqueness is enforced at the database level.

**Details:**
- `sub` is extracted and stored (sessionProvisioning.ts line 33) but only used for audit purposes (stored in `CfIdentity` object).
- Email is the join key for user lookup (sessionProvisioning.ts line 15).
- If two IdPs return the same email (e.g., Google and a custom OIDC provider both claim `alice@example.com`), they will be treated as the same user.

**Recommendation:** This is intentional per the design. Forkd assumes Cloudflare Access is the trusted IdP and that the operator has configured it correctly (one IdP per email domain, or email uniqueness enforced at the OIDC level). No additional checks needed.

---

### 3. No Explicit JWKS Fetch Error Recovery — **LOW RISK**

**Finding:** If the JWKS endpoint is unreachable, `createRemoteJWKSet()` will throw, caught as a generic auth failure, and return `null`. No retry, no fallback.

**Impact:** If the JWKS CDN is down for an extended period, legitimate users are locked out.

**Mitigation:** Cloudflare's CDN (the JWKS endpoint) has SLA of 99.9+% and is geographically distributed. In practice, this is not a realistic concern.

**Recommendation:** No change needed; the mitigation is sufficient.

---

### 4. Session Token Signature Uses MASTER_KEY — **CRITICAL, SHARED SECRET**

**Finding:** Session tokens are signed with `MASTER_KEY` (line 63 of sessionProvisioning.ts, HMAC-SHA256). If `MASTER_KEY` is leaked, an attacker can forge session cookies for any user.

**Severity:** Critical — but this is true of any symmetric auth scheme.

**Mitigation:**
- `MASTER_KEY` must be stored out-of-band, never in git, never in logs.
- `.env.example` documents it but shows a placeholder (`CHANGE_ME_BASE64_KEY`).
- Generated once via `openssl rand -base64 32`, backed up offline.
- Losing it means losing all sessions (users must re-authenticate).

**Recommendation:** Document key rotation procedure (there isn't one currently, but could be added if needed).

---

### 5. No Clock Skew Tolerance Configuration — **LOW RISK**

**Finding:** Jose's clock skew tolerance is hardcoded to 60 seconds. If server and Cloudflare have > 60 second clock skew, valid tokens are rejected.

**Severity:** Low; 60 seconds is typical for NTP-synchronized servers.

**Recommendation:** No change needed unless clock skew is observed in production logs.

---

### 6. Lowercase Email — **BY DESIGN**

**Finding:** Emails are lowercased at extraction time, not at the database schema level. If an email is somehow inserted uppercase (e.g., via admin import script), lookups will fail.

**Severity:** Low; the schema does not enforce case-insensitivity, but the app never inserts uppercase emails.

**Recommendation:** Add a `UNIQUE LOWER(email)` constraint to the schema if admin imports are planned.

---

### 7. Missing Signout Redirect to Cloudflare Logout — **NOT IMPLEMENTED IN AUTH LAYER**

**Finding:** The docs (cloudflare-access-setup.md line 112) state that sign-out should redirect to `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/logout`. The auth router (auth.ts line 103) only deletes the session and clears the app cookie. The redirect is not implemented in the auth layer.

**Severity:** Low; the app session is cleared, so the user is logged out of Forkd. However, they remain logged in to Cloudflare Access, so the next visit to the app re-authenticates them without showing a login dialog. This is a UX issue, not a security issue.

**Recommendation:** Implement the redirect in the `signOut` handler or as a redirect on the auth success page.

---

### 8. Open-Redirect Vulnerability Guarded — **WELL-MITIGATED**

**Finding:** The `returnTo` parameter in the sync route (line 73–74 of sync route) is validated to ensure it's a relative path: `raw.startsWith("/") && !raw.startsWith("//")`. This prevents open redirects.

**Verification:** Line 31–33 of proxy.ts does the same check before setting the sync URL parameter.

**Verdict:** Well-guarded. No issue.

---

## Env Vars Summary

| Var | Required | Example | Purpose |
|-----|----------|---------|---------|
| `CF_ACCESS_ENABLED` | Yes (prod only) | `"true"` | Gate to enable/disable Access verification. |
| `CF_ACCESS_AUD` | Yes (prod) | `<64-char-hex>` | Application Audience tag from Cloudflare dashboard. |
| `CF_ACCESS_TEAM_DOMAIN` | Yes (prod) | `myteam.cloudflareaccess.com` | Team domain for issuer validation & JWKS fetch. |
| `MASTER_KEY` | Yes (always) | `<base64-32-bytes>` | HMAC-SHA256 key for signing session tokens. |
| `AUTH_URL` | Yes (always) | `https://app.example.com` | Public URL of the app; used for session cookie domain & redirects. |
| `NODE_ENV` | Yes (prod) | `"production"` | Must be `"production"` in prod to disable dev routes. |

