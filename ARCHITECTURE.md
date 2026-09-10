# Ledgerly — Architecture

Receipt capture and spend tracking. Self-hosted PWA behind Cloudflare Tunnel +
Cloudflare Access, with Claude-powered receipt extraction.

Modeled on Forkd. Every deviation from Forkd is recorded in `DECISIONS.md` with
a decision ID; this document references those IDs rather than re-arguing them.

Companion documents: `docs/SCHEMA.md` (data model), `docs/PHASES.md` (build
order), `docs/Ledgerly_Project_Plan.md` (original brief).

---

## 1. Stack

| Layer         | Choice                                     | Version        | Source           |
| ------------- | ------------------------------------------ | -------------- | ---------------- |
| Runtime       | Node                                       | 22-alpine      | Forkd            |
| Language      | TypeScript, ESM, ES2022, `strict`          | 5.x            | Forkd            |
| Framework     | Next.js App Router, `output: "standalone"` | 15+            | Forkd            |
| UI            | React + HeroUI + TailwindCSS               | 19 / 2.7 / 4.x | Forkd            |
| Icons         | lucide-react                               | 1.x            | Forkd            |
| API           | **tRPC** + TanStack Query + superjson      | 11 / 5 / 2     | Forkd — see D-01 |
| Database      | **PostgreSQL**                             | **17**-alpine  | Forkd — see D-02 |
| ORM           | Drizzle ORM + drizzle-kit                  | 0.41 / 0.31    | Forkd            |
| Driver        | `pg` (`pg.Pool`)                           | 8.x            | Forkd            |
| Validation    | Zod                                        | 3.x            | Forkd            |
| JWT           | `jose`                                     | 6.x            | Forkd            |
| Jobs          | **BullMQ + Redis**                         | 5.x / 8.x      | Forkd — see D-08 |
| Images        | `sharp` (with libheif), `pdftoppm`         | 0.33           | see D-11         |
| Spreadsheets  | `exceljs`                                  | 4.x            | new              |
| AI            | `@anthropic-ai/sdk`                        | latest         | Forkd            |
| Tests         | Vitest                                     | 3.x            | Forkd            |
| Monorepo      | pnpm workspaces + Turbo                    | 11 / 2.x       | Forkd — see D-07 |
| Lint / format | ESLint 9 flat config, Prettier 3           |                | Forkd            |
| Secrets       | secretlint (pre-commit) + gitleaks (CI)    |                | see D-13         |

**Not adopted from Forkd:** `better-auth` (D-03), `playwright-core`,
`chrome-headless`, `yt-dlp`, `openai`, `qrcode`, `framer-motion`. Ledgerly has
no scraping, no video import, no guest capability URLs, and no transcription.
Dropping Playwright removes the single most painful item in
`docs/reference/FORKD_LESSONS.md` (the standalone file-tracing failure) by
construction.

---

## 2. Module layout

```
apps/
  web/                          Next.js app — the only deployable
    src/
      app/                      App Router
        (app)/                  authenticated shell: dashboard, projects, receipts, settings
        admin/                  instance-owner-only: users, categories, backups, AI usage
        welcome/                first/last name capture (onboarding gate target)
        api/
          trpc/[trpc]/          tRPC HTTP handler
          v1/health/            deep healthcheck — DB + Redis (D-15)
          images/[...key]/      authenticated image serving (never static)
          auth/sign-out/        Route Handler; redirects to CF Access logout (D-04)
      components/               React components
      lib/                      client-safe helpers, tRPC client
      server/                   server-only helpers, shutdown hooks
      middleware.ts             edge perimeter: CF Access JWT verification (D-30)
    public/                     manifest, icons, sw.js, offline.html
    next.config.ts              standalone output, CSP headers, serverExternalPackages
    instrumentation.ts          starts the in-process BullMQ workers

packages/
  api/                          tRPC routers, trpc.ts context/middleware, scopedProjects()
  auth/                         CF Access JWT verify, JIT provisioning, first-owner txn
  config/                       Zod env schema + startup validation  (D-14)
  db/                           Drizzle schema, migrations, client, seed
  queue/                        BullMQ queues, workers, pipeline/
  shared/                       Zod DTOs, category constants, currency, logger
  ui/                           shared presentational components

docker/                         Dockerfile (deps/builder/runner) + entrypoint.sh
.github/workflows/ci.yml        lint, typecheck, test, gitleaks, docker build
docker-compose.yml              webapp, db, redis
```

### 2.1 The one rule the monorepo imposes

`packages/shared` is imported by Client Components. Per
`docs/reference/FORKD_LESSONS.md` §"Node.js built-ins bleeding into client
bundle", it must **never** export:

- anything importing a `node:*` built-in,
- anything importing `drizzle-orm/pg`, `pg`, `bullmq`, `ioredis`, `sharp`, or
  `@anthropic-ai/sdk`,
- anything over ~10 KB.

Crypto, DB access, and AI calls live in `packages/api`, `packages/db`, and
`packages/queue`, each with `import "server-only"` at the top of every module.
Dependency direction is one-way:

```
shared -> ui -> web
shared -> db -> api -> web
shared -> db -> queue -> web (instrumentation only)
config -> everything
```

`packages/config` is the only package that may be imported from both sides, and
it exports only the parsed, non-secret subset to the client (see §7.2).

---

## 3. Request flow

### 3.1 Authenticated page load

```
Browser
  -> Cloudflare Edge
  -> Cloudflare Access  (SSO; mints JWT, sets CF_Authorization cookie)
  -> Cloudflare Tunnel
  -> cloudflared (host systemd service)
  -> http://localhost:${APP_PORT}
  -> Next.js edge middleware  apps/web/src/proxy.ts
       1. if DEV_AUTH_BYPASS -> inject fake identity, continue   (dev only, D-05)
       2. read Cf-Access-Jwt-Assertion header; absent -> 403
       3. jose.jwtVerify against cached JWKS
            audience: CF_ACCESS_AUD          <- hard reject on mismatch
            issuer:   https://${CF_ACCESS_TEAM_DOMAIN}
            exp / nbf checked implicitly
       4. extract sub, email, name
       5. continue — attaching nothing to the request       (D-24)
  -> Server Component / Route Handler / tRPC procedure
       resolveIdentity()  — re-reads and re-verifies the JWT from the raw
                            headers; React cache()-wrapped, one DB read
                            per request
       -> JIT provision on first sight of a sub  (§4.2)
       -> onboarding gate: first_name or last_name null -> redirect /welcome
  -> tRPC procedure -> scopedProjects(user) -> Drizzle -> Postgres
```

**The middleware is a perimeter, not a trust boundary.** See D-24. It rejects
unauthenticated requests cheaply at the edge and passes nothing downstream; the
Node layer verifies the JWT again, independently, and that second verification
is the only trust boundary. Identity is never carried between the two in a
request header. A middleware `matcher` gap is therefore a performance
regression, not an auth bypass.

**There is no session cookie and no session table.** See D-03. Forkd layered a
Better Auth session on top of Access and paid for it three times over (redirect
loop, `Set-Cookie` stripped by Cache Rules, sessions signed with `MASTER_KEY`).
Access already authenticates every request; re-verifying its JWT costs one
in-memory JWKS lookup. The user row read is deduplicated per request with
React's `cache()` — Forkd's own fix for the same problem, applied from the start.

### 3.2 Middleware matcher

Public, unmatched by the middleware:

```
/_next/*  favicon.ico  manifest.webmanifest  robots.txt
sw.js  offline.html  icon*.png  apple-icon*.png
/api/v1/health
```

Everything else is gated. Ledgerly has **no** public guest surface — the `/g/`
prefix and its self-contained-HTML requirement from
`docs/reference/FORKD_LESSONS.md` do not apply. That also means the
`/_next/static/*` Access bypass that broke Forkd's guest pages is unnecessary
here: nothing anonymous ever needs an asset.

### 3.3 Sign-out

A GET Route Handler at `/api/auth/sign-out`, never a Server Component — Next.js
15 forbids cookie writes in RSCs (`FORKD_LESSONS.md`). It redirects to
`https://${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout`. With no app session to
clear, that redirect is the entire operation, and it is the only thing that
actually logs the user out.

---

## 4. Authentication and authorization

### 4.1 Identity

Identity is the JWT `sub` claim, stored as `users.cf_access_sub` (unique, not
null). Email is a mutable attribute, never a join key. See D-06.

`Cf-Access-Authenticated-User-Email` is never read. It is a convenience header,
trivially forgeable if anything ever reaches the app off-tunnel, and carries no
signature.

A token with a missing or empty `sub` is **rejected**, never stored as `""`
(D-26). Under D-06 an empty `sub` would match a unique index and collapse every
subject-less token into one shared account; Cloudflare service tokens have
exactly that shape. `aud`, `iss`, and `alg` are pinned and asserted twice, and
an unconfigured `CF_ACCESS_AUD` refuses to verify rather than silently skipping
the audience check (D-25).

**IdP-change caveat.** If the Cloudflare Access identity provider is changed
(Google to one-time-PIN, say), `sub` changes and the returning user is
provisioned as a new account. Mitigation: an owner-only **"re-link account"**
admin action that reassigns a `cf_access_sub` onto an existing `users` row,
matched by email, writing an `audit_log` entry. Built in Phase 3 (task 3.7).

### 4.2 JIT provisioning and first-owner

On the first request bearing an unseen `sub`, a `users` row is created inside a
single transaction that also decides ownership:

```sql
BEGIN;
  SELECT id FROM users WHERE role = 'owner' FOR UPDATE;
  -- no row -> this user becomes owner
  INSERT INTO users (cf_access_sub, email, role, ...) VALUES (..., $role, ...);
COMMIT;
```

Two simultaneous first requests must not both win. `FOR UPDATE` on an empty
result set does not lock, so the statement is a `SELECT ... FOR UPDATE` against
a dedicated single-row `instance_state` table instead — see `docs/SCHEMA.md`
§instance_state. Race-tested in Phase 3 (task 3.4).

The owner assignment is logged at WARN with the email, so the operator can
verify the right person won.

Because `users_email_lower_key` is unique and identity is `sub`, an IdP change
gives every returning user a new `sub` with an existing email and collides on
insert — locking out the whole instance, owner included. `ACCESS_ALLOW_SUB_RELINK`
(default false) is the audited recovery path; see D-27.

### 4.3 Authorization at the query layer

One helper, in `packages/api/src/scope.ts`:

```ts
scopedProjects(user); // -> a Drizzle subquery of project ids the user may see
scopedProjects(user, "add"); // -> ... may add receipts to
scopedProjects(user, "manage"); // -> ... may manage members of
```

The instance owner short-circuits to "all projects". Everyone else gets the
intersection of `project_members` rows at or above the requested permission
level. Every project-scoped query composes with it; no route handler performs
its own permission check. The permission matrix and its exact semantics live in
`docs/SCHEMA.md` §project_members.

tRPC procedure ladder, mirroring Forkd's: `publicProcedure` ->
`protectedProcedure` (identity present **and** onboarded) -> `ownerProcedure`
(instance owner). `onboardingProcedure` is the explicit opt-out from the
onboarding requirement and holds exactly two members (D-28).
Per-project permission is never expressed as a procedure — it is expressed as a
scope composed into the query, because that is the check that cannot be
forgotten.

### 4.4 Dev bypass

`DEV_AUTH_BYPASS=true` injects a fixed development identity and skips JWT
verification. The Zod env schema in `packages/config` **refuses to boot** if it
is true while `NODE_ENV=production` — a thrown error at startup, not a warning,
and not a request-time check. See D-05. Forkd's equivalent guard was two
independent `!==` comparisons scattered across files; a single startup assertion
is strictly stronger.

---

## 5. Image pipeline

Accepted input: JPEG, PNG, HEIC/HEIF, WebP, TIFF, PDF (first page only, D-10).

```
POST multipart -> apps/web/src/app/api/... (Route Handler, not tRPC — streams bytes)

  1. size guard        reject > MAX_UPLOAD_BYTES (default 50 MB) BEFORE any decode
  2. sniff             magic bytes; the client Content-Type is never trusted
  3. PDF               pdftoppm -f 1 -l 1 -r 200 -png  ->  raster
  4. probe             sharp.metadata(); reject width*height > 100 MP (bomb defense)
  5. orient + strip    .rotate() applies EXIF orientation, then all EXIF is dropped
                       (GPS coordinates live there; see the security checklist)
  6. renders:
       [A] extraction  longest edge 2200, JPEG q88   -> held in memory, sent to Claude, discarded
       [B] display     longest edge 1600, WebP q72   -> persisted   (target < 300 KB)
       [C] thumb       longest edge  320, WebP q60   -> persisted
       [D] original    untouched bytes               -> persisted only if RETAIN_ORIGINALS=true (D-09)
  7. write             ${UPLOADS_DIR}/<project_id>/<receipt_id>/{display,thumb,original}.<ext>
  8. enqueue           receipt-extract job with the receipt id
```

**Extract before you compress.** The AI pass runs on render (A), which never
touches disk. Compression artifacts destroy small print, and the sales-tax line
is small print.

**Path safety by construction.** Every path segment is a UUID the server
generated. No user-supplied string ever reaches the filesystem, so path
traversal is not a check that can be forgotten — it is unrepresentable.

**Serving.** Images are read and streamed by
`/api/images/[...key]`, which resolves the receipt, composes with
`scopedProjects(user)`, and 404s (not 403 — no existence oracle) on failure.
`UPLOADS_DIR` is never a static route and never inside `public/`.

**Rate limiting.** Per-user upload rate limit enforced in tRPC/Route Handler
middleware backed by Redis, which BullMQ already requires. Default 60
uploads/minute, `UPLOAD_RATE_LIMIT_PER_MIN`.

---

## 6. AI extraction flow

Runs in the BullMQ worker, never in a request. See D-08.

### 6.1 The ladder

| Pass | Model (env)      | Default            | When                                                                                                                 |
| ---- | ---------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1    | `AI_MODEL_PASS1` | `claude-haiku-4-5` | every receipt                                                                                                        |
| 2    | `AI_MODEL_PASS2` | `claude-sonnet-5`  | pass 1 returned null `total`, null `transaction_date`, zero items, or `confidence < AI_ESCALATE_BELOW` (default 0.6) |

Model IDs are exact and carry no date suffix. Both are env-tunable so the ladder
can be re-pointed without a code change. See D-12 for why these two, and for the
corrected pricing.

**The two passes are not the same request.** Haiku 4.5 rejects
`output_config.effort` and uses the older `thinking: {type:"enabled",
budget_tokens:N}` form; Sonnet 5 uses `thinking: {type:"adaptive"}` and supports
`effort`. `packages/queue/src/pipeline/extract.ts` builds the request per model
from a capability table rather than sending one shape to both.

### 6.2 Structured output

A single tool, `record_receipt`, declared with `strict: true`,
`additionalProperties: false`, and an explicit `required` list. Strict mode
guarantees `tool_use.input` validates against the schema exactly, which removes
the parse-and-repair step entirely. The schema is the one sketched in
`docs/Ledgerly_Project_Plan.md` §1.6, with the `category` enum generated at call
time from the live `categories` table so user-added categories are selectable.

Phase 6 must confirm strict mode accepts `"type": ["string","null"]` unions; if
it does not, the fallback is non-strict tool use with Zod validation of the
result, and the decision is recorded as an amendment to D-12.

Tool inputs are always parsed with `JSON.parse`, never string-matched — escaping
differs across models.

### 6.3 Post-processing, in order

1. **Luhn scrub.** Every string field and the raw response are scanned for any
   13–19 digit sequence (ignoring spaces and dashes) that passes a Luhn check.
   Matches are redacted before anything is written. `card_last4` is separately
   asserted to be exactly four digits or null. This runs **before** persistence
   and **before** `extraction_raw` is stored. `CLAUDE.md` hard rule.
2. **Zod parse** into the internal DTO. Every field is nullable.
3. **Sanity checks**, each setting `extraction_status = 'partial'` and appending
   to `missing_fields[]` rather than failing:
   - `|subtotal + sales_tax + tip - total| > 0.02` (`tip` is 0 when not
     printed — a superset of the brief's formula, added because a tipped
     receipt otherwise always trips this check; review finding L-4)
   - `|sum(line_total) - subtotal| > 1.00`
   - `transaction_date` in the future, or before 2000-01-01
4. **Persist** receipt + items in one transaction. `extraction_raw` is stored
   verbatim (post-scrub) for debugging bad reads.

**Extraction never fails an upload.** An API error, a timeout, or an
unparseable response sets `extraction_status = 'failed'` and leaves the receipt
in the review queue with its images intact. `CLAUDE.md` convention.

### 6.4 Concurrency and cost

Worker concurrency 3 (`AI_CONCURRENCY`), exponential backoff on 429 and 529, a
per-job attempt cap of 3. A 40-photo camera-roll import therefore issues at most
3 concurrent calls.

Every call records tokens in and out, model, pass number, and latency to an
`ai_usage` table. The admin view surfaces spend and the pass-1 -> pass-2
escalation rate; if that rate exceeds ~45%, the ladder is costing more than
going Sonnet-first (D-12).

The API key is read from the environment inside `packages/queue` only. It is
never imported into `apps/web` client code, never logged, and never included in
an error response — errors surfaced to the UI carry a status and a job id, not a
provider message.

---

## 7. Configuration

### 7.1 Startup validation

`packages/config/src/env.ts` exports a Zod schema covering every variable, parsed
once at module load. Failure throws with the full list of problems and the
process exits non-zero. Forkd's `packages/config` is an empty `export {}` with
env read via bare `process.env` throughout, which both the stack and auth
analyses flagged independently; Ledgerly does not inherit that. See D-14.

The schema is also where cross-field invariants live:

- `DEV_AUTH_BYPASS === true && NODE_ENV === "production"` -> refuse to boot
- `NODE_ENV === "production"` -> `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` required
- `MASTER_KEY` must base64-decode to exactly 32 bytes

### 7.2 Key variables

| Variable                    | Default              | Notes                                                        |
| --------------------------- | -------------------- | ------------------------------------------------------------ |
| `APP_PORT`                  | 3000                 | host bind and container port (D-16)                          |
| `APP_HOSTNAME`              | —                    | public hostname; used for absolute URLs (D-16)               |
| `DATABASE_URL`              | —                    | composed in compose from `POSTGRES_*`                        |
| `REDIS_URL`                 | `redis://redis:6379` |                                                              |
| `MASTER_KEY`                | —                    | 32 bytes base64; encrypts `app_config`. Back up out-of-band  |
| `UPLOADS_DIR`               | `/app/uploads`       | named volume                                                 |
| `BACKUPS_DIR`               | `/app/backups`       | named volume                                                 |
| `CF_ACCESS_ENABLED`         | `false`              |                                                              |
| `CF_ACCESS_AUD`             | —                    | never committed                                              |
| `CF_ACCESS_TEAM_DOMAIN`     | —                    | never committed                                              |
| `CF_ACCESS_JWKS_TTL_MS`     | `3600000`            | JWKS `cacheMaxAge`; explicit, not inherited (D-29)           |
| `ACCESS_ALLOW_SUB_RELINK`   | `false`              | IdP-migration recovery only; WARNs at boot while true (D-27) |
| `DEV_AUTH_BYPASS`           | `false`              | hard-fails under production                                  |
| `ANTHROPIC_API_KEY`         | —                    | server-side only                                             |
| `AI_MODEL_PASS1`            | `claude-haiku-4-5`   |                                                              |
| `AI_MODEL_PASS2`            | `claude-sonnet-5`    |                                                              |
| `AI_ESCALATE_BELOW`         | `0.6`                |                                                              |
| `AI_CONCURRENCY`            | `3`                  |                                                              |
| `MAX_UPLOAD_BYTES`          | `52428800`           | 50 MB                                                        |
| `RETAIN_ORIGINALS`          | `false`              | ~10x storage if true (D-09)                                  |
| `MAX_UPLOAD_MEGAPIXELS`     | `100`                | decompression-bomb cap, checked header-only before decode    |
| `UPLOAD_RATE_LIMIT_PER_MIN` | `60`                 | per-user, whole-batch atomic (Phase 5)                       |
| `INGEST_CONCURRENCY`        | `3`                  | render-worker concurrency; distinct from `AI_CONCURRENCY`    |
| `DEFAULT_CURRENCY`          | `USD`                | no UI in v1 (D-17)                                           |
| `BACKUP_RETENTION_DAYS`     | `30`                 |                                                              |
| `BACKUP_INCLUDE_IMAGES`     | `false`              |                                                              |

Only variables explicitly whitelisted as public are re-exported to the client.
`ANTHROPIC_API_KEY`, `MASTER_KEY`, `DATABASE_URL`, and `CF_ACCESS_AUD` are never
among them.

---

## 8. Deployment topology

Three containers, down from Forkd's four — no `chrome-headless`.

```
                          Internet
                             |
                    Cloudflare Edge + Access
                             |
                     Cloudflare Tunnel
                             |
              cloudflared (host systemd service)
                             |
                 http://localhost:${APP_PORT}
                             |
  +--------------------------+--------------------------+
  |               docker bridge network                  |
  |                                                      |
  |  webapp  (Next.js standalone + in-process workers)   |
  |    127.0.0.1:${APP_PORT} published — localhost only  |
  |    volumes: app_uploads -> /app/uploads              |
  |             app_backups -> /app/backups              |
  |         |                        |                   |
  |      db:5432                 redis:6379              |
  |   postgres:17-alpine          redis:8.x              |
  |   volume: db_data             volume: redis_data     |
  +------------------------------------------------------+
```

- The webapp binds **localhost only**. Nothing but the tunnel can reach it.
- `db` and `redis` publish no ports.
- `depends_on`: `db` must be `service_healthy` (`pg_isready`); `redis`
  `service_started`.
- `restart: always` on webapp.
- **No `user:` override in compose.** The container starts as root, the
  entrypoint `chown`s the volumes and drops to `node` via `su-exec` — but only
  after checking `id -u`, per `FORKD_LESSONS.md` (Forkd took a production 502
  on exactly this). Both paths are supported and both are tested.

### 8.1 Container

Multi-stage `node:22-alpine`: `deps` (pnpm, frozen lockfile) -> `builder`
(Next.js standalone + esbuild-bundled `migrate.cjs`) -> `runner`.

Runner packages: `vips`, `libheif` (sharp/HEIC), **`poppler-utils`** (PDF
rasterisation — new, D-11), `postgresql17-client` (`pg_dump`/`pg_restore`),
`tar`, `su-exec`. No Chromium, no ffmpeg, no python3, no yt-dlp.

```
CMD ["sh", "-c", "node migrate.cjs && node apps/web/server.js"]
```

Migrations run before the server starts and fail the container on non-zero.

`serverExternalPackages`: `sharp`, `bullmq`, `ioredis`. The workers start via
`instrumentation.ts`; because they are imported through a package subpath, the
same file-tracing caveat that bit Forkd applies, and Phase 2 verifies the
modules are present in `.next/standalone/node_modules` as an explicit acceptance
criterion.

### 8.2 Healthcheck

`GET /api/v1/health` executes `SELECT 1` against the pool and pings Redis,
returning 503 if either fails. Forkd's returns `{status:"ok"}` without touching
the database, so a container can report healthy while every query fails
(`docs/STATE.md`). Ledgerly does not inherit that. See D-15.

### 8.3 Backups

The `backup` queue — the third D-08 reserved, and the only one still owed after
D-37 left `export` unbuilt. One processor for both kinds: manual (the admin
button, against a `backups` row the API has already inserted) and scheduled (a
BullMQ job scheduler, cron from `app_config`). A scheduled backup that behaved
differently from the one you tested by hand would not be a backup you had
tested.

- `pg_dump --format=custom --no-owner --no-privileges` -> `db.dump`. The
  connection goes in as discrete flags with the password in `PGPASSWORD`, never
  as a URI in argv — argv is world-readable through `/proc`.
- `${UPLOADS_DIR}` tree as `uploads.tar`, only if `BACKUP_INCLUDE_IMAGES=true`.
  Not gzipped: every file under it is an already-compressed WebP.
- `manifest.json`: schema version (read from `drizzle.__drizzle_migrations`, so
  it is what is actually applied), per-table row counts in ONE query so they
  share a snapshot, image count, and a SHA-256 of every member file.
- tar + gzip into `${BACKUPS_DIR}`, written under a `.part` name and renamed
  only on success, so a SIGKILL cannot leave a truncated file that looks like a
  backup. A sidecar `.sha256` carries the archive's own checksum, which cannot
  be inside the file it describes.

`app_config` is **not** written out separately — the dump already contains it,
with its values still encrypted (D-45).

Retention `BACKUP_RETENTION_DAYS` (default 30): unlink first, then soft-delete
the row, so a crash between the two leaves a visible inconsistency rather than
an invisible one.

Failures are loud by construction, because a backup system that fails silently
is worse than none: a reason code on the row, a `console.error` from the
worker's `failed` handler, a `failed` status in the admin view, and a boot sweep
that marks any row still `running` after a restart as `INTERRUPTED`. That sweep
also reconciles the cron from `app_config` into Redis — Redis is not in any
backup, so an unregistered scheduler is the normal state after a `redis_data`
loss, and the admin card renders "configured but not registered" as an error.

`scripts/restore.sh` ships in the repo (host-side; it drives `docker compose`,
and the runner image has no python3). It validates every member against the
manifest before touching a database, refuses a non-empty target without
`--force`, and migrates forward when the archive predates the checkout. Phase 9
does not pass until a restore drill succeeds against a scratch database. A
backup that has never been restored is a hypothesis.

`MASTER_KEY` is not in the archive and cannot be recovered from it. `SETUP.md`
says so in bold, and so does the admin screen.

### 8.4 CI

`.github/workflows/ci.yml`: install -> lint -> typecheck -> test (against a
throwaway `postgres:17` service, not a shared dev database — `docs/STATE.md`) ->
**gitleaks over full history** -> docker build and push to GHCR on `main`.

---

## 9. Frontend and PWA

HeroUI v2 + Tailwind 4, following `docs/reference/FORKD_UI.md`: system font
stack, `font-size: max(16px, 1em)` on inputs to stop iOS zoom, safe-area insets
applied globally on `body` with the top inset handled by the header,
`100dvh` never `100vh`, `viewport-fit=cover`.

Capture is `<input type="file" accept="image/*" capture="environment" multiple>`.

**Service worker** — hand-rolled, cache name `ledgerly-shell-v1`:

- immutable `/_next/static/*` and the precached shell: cache-first, no revalidation
- navigations: network-first with navigation preload, `offline.html` fallback
- **everything else — tRPC, images, RSC payloads: network-only, never cached**

`stale-while-revalidate` is used nowhere. Forkd's service worker cached every
photo that way and doubled tunnel requests on photo-heavy pages
(`FORKD_LESSONS.md`).

The Access-expiry hazard from the brief §1.9 is handled explicitly: the fetch
handler bypasses the cache for any response that is a redirect, non-200, or
`type: "opaque"`. A cached Access login redirect would brick the installed PWA
until the user cleared site data.

---

## 10. Deviations from Forkd — index

| ID   | Deviation                                                               |
| ---- | ----------------------------------------------------------------------- |
| D-01 | tRPC retained over the brief's Express/Fastify                          |
| D-02 | PostgreSQL 17, not 16                                                   |
| D-03 | No Better Auth, no session table, no session cookie                     |
| D-04 | Sign-out is only the Access logout redirect                             |
| D-05 | `DEV_AUTH_BYPASS` fails at startup, not per-request                     |
| D-06 | Identity keyed on `sub`, not email                                      |
| D-07 | Monorepo retained                                                       |
| D-08 | BullMQ + Redis retained                                                 |
| D-11 | `sharp`+libheif over `heic-convert`; `poppler-utils` added              |
| D-13 | gitleaks in CI alongside secretlint                                     |
| D-14 | Zod env validation at startup                                           |
| D-15 | Deep healthcheck                                                        |
| D-16 | `APP_PORT` / `APP_HOSTNAME` naming                                      |
| D-18 | Isolated test database                                                  |
| D-19 | Receipt pipeline rewritten, scaffolding ported                          |
| D-24 | Edge middleware is a perimeter; the Node layer re-verifies              |
| D-25 | `aud`/`iss`/`alg` pinned and asserted twice; unconfigured `aud` refuses |
| D-26 | Missing or empty `sub` rejects the token                                |
| D-27 | Best-effort email refresh; `ACCESS_ALLOW_SUB_RELINK` for IdP migration  |
| D-28 | `protectedProcedure` implies onboarded                                  |
| D-29 | Explicit JWKS TTL, cooldown, and fetch timeout                          |
| D-30 | Middleware file is `middleware.ts`; `proxy.ts` is inert on Next 15      |
| D-37 | Export streams from a Route Handler; the `export` queue stays unbuilt   |
| D-38 | `card_last4` is written as `="0042"` in CSV so Excel keeps the zero     |

Full rationale for each in `DECISIONS.md`.

---

## 11. Export

Sits logically after §6 and is numbered last only so the existing section
numbers — referenced from code comments as `§7.2`, `§8.1`, `§8.3` — keep
meaning what they meant.

```
GET /api/projects/<id>/export?format=xlsx|csv&from=&to=&category=&uploadedBy=&needsReview=1

  1. identity      requireAuthRoute() — the Node-layer re-verification (D-24)
  2. authorize     scopedProjects(user, "read") composed into the project lookup
                   404, never 403 — no existence oracle (as §5's image serving)
  3. preflight     receipt count + distinct currencies; > 50,000 receipts -> 413
  4. audit         one export.generated row, BEFORE any byte leaves
  5. stream        exceljs WorkbookWriter -> PassThrough -> Response body
```

A Route Handler, not a tRPC procedure: tRPC speaks JSON over superjson and
cannot stream a binary body — the same reason upload and image serving are
Route Handlers. There is **no queue job**; see D-37 for why, and for what the
reserved `export` queue would have cost.

### 11.1 Two grains, one pass

The XLSX has three sheets. The first two are two different **grains**, and
keeping them apart is the point:

| Sheet         | Grain             | Carries                                        |
| ------------- | ----------------- | ---------------------------------------------- |
| 1. Line Items | one row an item   | no receipt-level total, ever                   |
| 2. Receipts   | one row a receipt | `subtotal`, `sales_tax`, `total`, `item_count` |
| 3. Summary    | aggregates        | by category, by month, and the reconciliation  |

Repeating a receipt `total` on each of its item rows is how a spreadsheet
export triples someone's deduction when they drag a SUM down the column.
`LINE_ITEM_COLUMNS` therefore contains no `subtotal`/`sales_tax`/`tip`/`total`,
and the test asserts their absence **by header name** — a future "convenient"
total column on sheet 1 would reintroduce the bug and would read as an
improvement in review.

Both sheets and the summary come from ONE pass over the data. Line items — the
unbounded dimension — stream and are freed row by row; the receipt-grain
scalars are buffered, bounded by `MAX_EXPORT_RECEIPTS`. Two passes would read
two snapshots of a live table and could disagree, and "the totals reconcile" is
the phase gate.

### 11.2 What makes it usable in Excel

Money is a real number (`parseMoney` -> cents -> `/100` only at the cell, per
D-21) with a currency `numFmt`; a date is a real date built with `Date.UTC`
(a locally-parsed `"2026-03-04"` lands a day early west of Greenwich);
`card_last4` is text so `"0042"` survives; the header row is frozen and columns
are sized. Sheet 1 opens with a metadata block naming the applied filter and
the export timestamp, so an export is reproducible later — the CSV carries the
same block, because it is the same sheet.

Tax and tip are **not** apportioned pro-rata across categories on the summary.
An unallocated remainder is a fact; a per-category share of it would be an
invention, and this is a tax record.

### 11.3 Filter parity

The export composes the same filter block as `receipts.list`, including the
correlated `EXISTS` for `categoryId`, and forwards the dashboard's own query
string. A category filter therefore selects **receipts** and then writes every
item of each — which is both what was on screen and what keeps the two sheets
reconciling. Parity is asserted against `receipts.list` itself in the test
suite, not against a re-derived expectation.
