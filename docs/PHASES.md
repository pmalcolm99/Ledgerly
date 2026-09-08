# Ledgerly — Phases 2 through 10

One phase per Claude Code session. Every phase ends by updating `docs/STATE.md`
and committing. State is handed off through that file, not through a long
context window — this is the single biggest lever on token spend.

**Model column** follows `CLAUDE.md` routing:

| Label      | Means                                                                                |
| ---------- | ------------------------------------------------------------------------------------ |
| **Opus**   | main thread, or the `reviewer` subagent. Architecture, auth design, security review. |
| **Sonnet** | the `implementer` subagent. Feature work against a settled design.                   |
| **Haiku**  | the `doc-writer` subagent. Docs, changelogs, inventory.                              |

Escalate to Opus **after** Sonnet has failed twice, not preemptively.

**Standing rules for every phase.** Never read the Forkd repo — `docs/reference/`
is the standing substitute (`CLAUDE.md`). Dispatch the `reviewer` subagent over
the diff before committing any auth, upload, or AI-integration work. After
pushing, verify the Actions run with `gh run watch`.

**Parallelism.** Phases 5 and 7 touch different directories and may run
concurrently in two terminals once Phase 4 lands. Everything else is sequential.

**Note on `frontend-design`.** The brief's Phase 7 names a `frontend-design`
model that does not exist in `.claude/agents/` — the available agents are
`forkd-analyst`, `implementer`, `reviewer`, and `doc-writer`. Phase 7 uses
`implementer` (Sonnet), optionally preceded by the `design` skill if a canvas
mockup is wanted first.

---

## Phase 2 — Foundation

**Goal.** A repository that builds, lints, types, tests, and comes up green under
`docker compose up`, with nothing in it yet.

| #    | Task                                                                                                                                                                                         | Files                                            | Model    | Acceptance                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| 2.1  | pnpm workspace + Turbo, 7 packages, `tsconfig.base.json` (ES2022, strict, `noUncheckedIndexedAccess`), ESLint 9 flat, Prettier 3                                                             | root configs, `packages/*/package.json`          | Sonnet   | `pnpm install` clean; `pnpm lint` and `pnpm typecheck` pass on an empty tree                                       |
| 2.2  | ESLint `no-restricted-imports` enforcing the D-07 dependency direction: `packages/shared` may not import `node:*`, `pg`, `drizzle-orm/pg`, `bullmq`, `ioredis`, `sharp`, `@anthropic-ai/sdk` | `eslint.config.js`                               | Sonnet   | A test fixture importing `node:crypto` from `shared` fails lint                                                    |
| 2.3  | `packages/config`: Zod env schema, parsed at import, with the D-05 and `MASTER_KEY` cross-field invariants                                                                                   | `packages/config/src/env.ts`                     | **Opus** | Missing var lists every problem and exits non-zero; `DEV_AUTH_BYPASS=true` + `NODE_ENV=production` refuses to boot |
| 2.4  | `.env.example` — every variable from `ARCHITECTURE.md` §7.2, documented, no real values                                                                                                      | `.env.example`                                   | Haiku    | secretlint clean; no hostname, AUD tag, or key present                                                             |
| 2.5  | `packages/db`: `pg.Pool` client, `drizzle.config.ts`, schema files per `docs/SCHEMA.md` §"Schema file layout"                                                                                | `packages/db/src/**`                             | Sonnet   | `pnpm db:generate` emits migration `0000`; the SQL is reviewed by hand before commit                               |
| 2.6  | Migration `0000` applied; partial unique indexes appended by hand where drizzle-kit cannot emit them                                                                                         | `packages/db/migrations/`                        | Sonnet   | Applies from empty; `\d+` shows every index in `docs/SCHEMA.md`                                                    |
| 2.7  | Idempotent seed: `instance_state` row + 13 system categories                                                                                                                                 | `packages/db/src/seed.ts`                        | Sonnet   | Running twice leaves 13 categories, not 26                                                                         |
| 2.8  | Next.js app skeleton, standalone output, `serverExternalPackages` for `sharp`/`bullmq`/`ioredis`, tRPC handler + root router                                                                 | `apps/web/**`, `packages/api/src/{trpc,root}.ts` | Sonnet   | `pnpm build` succeeds; `.next/standalone/node_modules` contains all three                                          |
| 2.9  | Deep healthcheck: `SELECT 1` + Redis ping, 503 on failure, no detail in the body (D-15)                                                                                                      | `apps/web/src/app/api/v1/health/route.ts`        | Sonnet   | Returns 200 healthy; stopping `db` makes it 503 within one interval                                                |
| 2.10 | Dockerfile (deps/builder/runner), `poppler-utils` + `vips` + `libheif` + `postgresql17-client`; entrypoint that checks `id -u` before `su-exec`                                              | `docker/**`                                      | Sonnet   | Image builds; runs both as root and with a `user: "1000:1000"` override without crashing                           |
| 2.11 | `docker-compose.yml`: webapp (`127.0.0.1:${APP_PORT}` only), db (healthcheck), redis; four named volumes                                                                                     | `docker-compose.yml`                             | Sonnet   | `docker compose up` green; `db` and `redis` publish no ports                                                       |
| 2.12 | Test harness: throwaway `postgres:17` in CI, `TEST_DATABASE_URL` locally, per-test transaction rollback (D-18)                                                                               | `vitest.config.ts`, `test/setup.ts`              | Sonnet   | A test that inserts leaves the database unchanged after the run                                                    |
| 2.13 | CI: install, lint, typecheck, test, **gitleaks over full history**, docker build+push to GHCR on `main`                                                                                      | `.github/workflows/ci.yml`                       | Sonnet   | All jobs green; gitleaks scans full history, not just the tip                                                      |
| 2.14 | secretlint in lint-staged pre-commit (D-13)                                                                                                                                                  | `package.json`, lint-staged config               | Sonnet   | A staged file containing a fake key is blocked                                                                     |

**Gate.** `docker compose up` is green from a clean checkout and the Actions run
passes.

---

## Phase 3 — Auth & identity

The security-critical phase. It opens with an Opus design pass and closes with an
Opus review; the build in between is Sonnet.

| #    | Task                                                                                                                                                                         | Files                                                    | Model                 | Acceptance                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 3.1  | Design pass: write the auth module contract — function signatures, failure modes, what each returns on each failure                                                          | `docs/private/` working notes                            | **Opus**              | Every branch in `ARCHITECTURE.md` §3.1 has a named function and a defined failure result                             |
| 3.2  | `verifyAccessJwt()` — `jose` + `createRemoteJWKSet`, lazy singleton cache; `audience` = `CF_ACCESS_AUD`, `issuer` = `https://${CF_ACCESS_TEAM_DOMAIN}`; `exp`/`nbf` implicit | `packages/auth/src/cloudflareAccess.ts`                  | Sonnet                | Unit tests: valid token passes; **wrong `aud` rejects**; wrong `iss` rejects; expired rejects; unknown `kid` rejects |
| 3.3  | Failure responses leak nothing — one catch, one generic log line, plain-text 403, no stack, no reason                                                                        | `packages/auth/src/cloudflareAccess.ts`                  | Sonnet                | The four rejection cases in 3.2 produce byte-identical responses                                                     |
| 3.4  | Atomic first-owner election against `instance_state` (`docs/SCHEMA.md`)                                                                                                      | `packages/auth/src/provision.ts`                         | **Opus**              | **Concurrency test: N parallel transactions, exactly one owner.** Election logged at WARN with the email             |
| 3.5  | JIT provisioning keyed on `sub`; email and `display_name` refreshed each visit; `first_name`/`last_name` never overwritten from the IdP                                      | `packages/auth/src/provision.ts`                         | Sonnet                | An email change at the IdP updates the row rather than creating a second one                                         |
| 3.6  | `proxy.ts` middleware + matcher from `ARCHITECTURE.md` §3.2; `resolveIdentity()` wrapped in React `cache()`                                                                  | `apps/web/src/proxy.ts`, `packages/auth/src/identity.ts` | Sonnet                | A page reading identity three times issues **one** database query                                                    |
| 3.7  | Owner-only "re-link account" action: reassign a `cf_access_sub` onto an existing user by email, writing `audit_log` (D-06)                                                   | `packages/api/src/routers/admin.ts`                      | Sonnet                | Re-link preserves the user's projects; a non-owner gets FORBIDDEN                                                    |
| 3.8  | Onboarding gate: `first_name` or `last_name` null redirects to `/welcome`, which is itself exempt                                                                            | `apps/web/src/proxy.ts`, `apps/web/src/app/welcome/`     | Sonnet                | A fresh user cannot reach any other route until the form is submitted                                                |
| 3.9  | Sign-out Route Handler redirecting to the Access logout endpoint; nav uses `<a>`, not `<Link>` (D-04)                                                                        | `apps/web/src/app/api/auth/sign-out/route.ts`            | Sonnet                | Close browser, revisit, and be challenged by Access again                                                            |
| 3.10 | Dev bypass wired to the D-05 startup guard; no per-request `NODE_ENV` checks anywhere                                                                                        | `packages/auth/**`, `packages/config/**`                 | Sonnet                | `grep -r 'NODE_ENV' packages/auth` returns nothing                                                                   |
| 3.11 | tRPC procedure ladder: `publicProcedure` -> `protectedProcedure` -> `ownerProcedure`                                                                                         | `packages/api/src/trpc.ts`                               | Sonnet                | `protectedProcedure` without identity throws UNAUTHORIZED; `ownerProcedure` as a non-owner throws FORBIDDEN          |
| 3.12 | Security review of the whole diff                                                                                                                                            | —                                                        | **Opus** (`reviewer`) | No high findings outstanding                                                                                         |

**Gate.** Tests cover the first-owner race and the `aud` reject. The `reviewer`
subagent has signed off.

---

## Phase 4 — Projects & permissions

| #       | Task                                                                                                                                                                                                                        | Files                                  | Model                 | Acceptance                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| ~~4.1~~ | ~~`scopedProjects(user, level)`~~ **DONE IN PHASE 3** — `packages/api/src/scope.ts` plus `scope.test.ts` covering every matrix cell. Do not rebuild. Outstanding follow-ups on it are listed in `docs/STATE.md` (L-4, L-6). | —                                      | —                     | —                                                                                     |
| 4.2     | Project CRUD; creation inserts the owner's `project_members` row with `full` in the same transaction                                                                                                                        | `packages/api/src/routers/projects.ts` | Sonnet                | A created project always has an owner membership row                                  |
| 4.3     | Member management with the three escalation guards from `docs/SCHEMA.md`                                                                                                                                                    | `packages/api/src/routers/members.ts`  | Sonnet                | Cannot grant above your own level, cannot modify the owner's row, cannot self-promote |
| 4.4     | **Permission matrix test suite** — every cell of the matrix, plus "own only" edit semantics                                                                                                                                 | `packages/api/src/routers/*.test.ts`   | Sonnet                | Every cell has a passing positive and negative case                                   |
| 4.5     | Deleted/archived filtering: every duplicate check and list query filters `deleted_at IS NULL` (D-22)                                                                                                                        | `packages/api/src/routers/projects.ts` | Sonnet                | Re-creating a soft-deleted project by the same name succeeds                          |
| 4.6     | `packages/shared/money.ts` — `numeric` string <-> integer cents, the only place the conversion is written (D-21)                                                                                                            | `packages/shared/src/money.ts`         | Sonnet                | `19.99 + 0.01 === 20.00` exactly; property test over 10k random pairs                 |
| 4.7     | `audit_log` writes on permission grants and deletions                                                                                                                                                                       | `packages/api/src/audit.ts`            | Sonnet                | Each audited action produces exactly one row                                          |
| 4.8     | Authorization review                                                                                                                                                                                                        | —                                      | **Opus** (`reviewer`) | No query reaches a project by raw id without composing `scopedProjects`               |

**Gate.** The permission matrix test suite is green.

---

## Phase 5 — Ingest pipeline

Parallel-safe with Phase 7.

| #    | Task                                                                                                           | Files                                           | Model                 | Acceptance                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| 5.1  | Upload Route Handler: **size guard before any decode**, magic-byte sniff (client `Content-Type` never trusted) | `apps/web/src/app/api/receipts/upload/route.ts` | Sonnet                | A 60 MB file is rejected without being decoded; a `.jpg` that is actually a script is rejected |
| 5.2  | Pixel guard: reject > 100 MP after `sharp.metadata()`, before full decode                                      | same                                            | Sonnet                | A decompression-bomb PNG is rejected without exhausting memory                                 |
| 5.3  | PDF rasterisation, first page only (D-10)                                                                      | `packages/queue/src/pipeline/render.ts`         | Sonnet                | A 3-page PDF yields one image, from page 1                                                     |
| 5.4  | HEIC via `sharp` + libheif (D-11)                                                                              | same                                            | Sonnet                | **A real HEIC from the phone round-trips**                                                     |
| 5.5  | EXIF: orientation applied via `.rotate()`, then **all EXIF stripped**                                          | same                                            | Sonnet                | `exiftool` on a stored render shows no GPS and no camera tags                                  |
| 5.6  | Three renders — A (2200 JPEG q88, in-memory only), B (1600 WebP q72), C (320 WebP q60)                         | same                                            | Sonnet                | Render B averages under 300 KB across 10 real receipts; A never touches disk                   |
| 5.7  | UUID-derived storage paths under `UPLOADS_DIR` (D-23)                                                          | `packages/api/src/storage.ts`                   | Sonnet                | No user-supplied string appears in any path; `../` in a filename is unrepresentable            |
| 5.8  | Authenticated image serving; **404 not 403** on permission failure                                             | `apps/web/src/app/api/images/[...key]/route.ts` | Sonnet                | Another user's receipt id returns 404, identical to a nonexistent id                           |
| 5.9  | Per-user upload rate limit in Redis, `UPLOAD_RATE_LIMIT_PER_MIN`                                               | `packages/api/src/rateLimit.ts`                 | Sonnet                | The 61st upload in a minute is rejected with 429                                               |
| 5.10 | Enqueue `receipt-extract` on successful write                                                                  | same                                            | Sonnet                | Upload returns before extraction starts; receipt is `pending`                                  |
| 5.11 | Upload + authorization review                                                                                  | —                                               | **Opus** (`reviewer`) | No high findings                                                                               |

**Gate.** A real HEIC photographed on your phone round-trips end to end.

---

## Phase 6 — AI extraction

| #    | Task                                                                                                                                                       | Files                                     | Model                 | Acceptance                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 6.1  | BullMQ scaffolding ported from Forkd's shapes: `queue.ts`, `redis.ts`, `worker.ts`, graceful shutdown (D-19)                                               | `packages/queue/src/`                     | Sonnet                | Workers start via `instrumentation.ts` and shut down cleanly on SIGTERM                                          |
| 6.2  | `record_receipt` tool: `strict: true`, `additionalProperties: false`, explicit `required`; `category` enum built at call time from the live table          | `packages/queue/src/pipeline/schema.ts`   | Sonnet                | A category added through the UI appears in the next call's enum                                                  |
| 6.3  | **Confirm strict mode accepts `["string","null"]` unions.** If rejected, fall back to non-strict tool use + Zod, and append the outcome to D-12            | same                                      | **Opus**              | Either strict works, or the fallback is implemented and `DECISIONS.md` D-12 is amended                           |
| 6.4  | Per-model request construction from a capability table — Haiku 4.5 takes `budget_tokens` and rejects `effort`; Sonnet 5 takes `adaptive` + `effort` (D-12) | `packages/queue/src/pipeline/extract.ts`  | Sonnet                | Both models return successfully; neither request is sent in the other's shape                                    |
| 6.5  | Escalation ladder: pass 2 on null `total`, null `transaction_date`, zero items, or `confidence < AI_ESCALATE_BELOW`                                        | same                                      | Sonnet                | A deliberately blurred receipt escalates; a clean one does not                                                   |
| 6.6  | **Luhn scrub before persistence**, over every string field _and_ the raw response; `card_last4` asserted 4 digits or null                                  | `packages/queue/src/pipeline/scrub.ts`    | **Opus**              | A synthetic receipt containing a Luhn-valid 16-digit number stores no trace of it, including in `extraction_raw` |
| 6.7  | Sanity checks setting `partial` + `missing_fields[]`, never failing the receipt                                                                            | `packages/queue/src/pipeline/validate.ts` | Sonnet                | Each of the three checks trips independently; the receipt is still saved                                         |
| 6.8  | Reconciliation sweep at worker startup: re-enqueue `pending` receipts with no live job (D-08)                                                              | `packages/queue/src/worker.ts`            | Sonnet                | Kill mid-job, restart, and the receipt completes                                                                 |
| 6.9  | Concurrency 3, backoff on 429/529, 3 attempts, then `failed` with images intact                                                                            | `packages/queue/src/queue.ts`             | Sonnet                | A 40-image import issues at most 3 concurrent calls                                                              |
| 6.10 | `ai_usage` rows on every call; admin view showing spend and escalation rate                                                                                | `packages/api/src/routers/admin.ts`       | Sonnet                | Escalation rate is visible and matches the run                                                                   |
| 6.11 | API key hygiene: read only in `packages/queue`, never logged, never in an error surfaced to the UI                                                         | —                                         | Sonnet                | `grep -r ANTHROPIC_API_KEY apps/web/src` returns nothing; a provider error reaches the UI as status + job id     |
| 6.12 | **Extract 10 real receipts; log per-field accuracy**                                                                                                       | `docs/private/`                           | Sonnet                | Accuracy recorded; a pass-1 model change is justified by the numbers or not made                                 |
| 6.13 | AI-integration review                                                                                                                                      | —                                         | **Opus** (`reviewer`) | No high findings                                                                                                 |

**Gate.** 10 real receipts extracted, accuracy logged, Luhn scrub proven.

---

## Phase 7 — UI & PWA

Parallel-safe with Phase 5.

| #    | Task                                                                                                                                                                                                     | Files                                                  | Model    | Acceptance                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| 7.1  | HeroUI + Tailwind 4 setup per `docs/reference/FORKD_UI.md`; theme mechanism, system font stack, `font-size: max(16px, 1em)` on inputs                                                                    | `apps/web/tailwind.config.js`, `globals.css`           | Sonnet   | No iOS zoom on input focus                                                                                       |
| 7.2  | App shell: header with safe-area top inset, body with left/right/bottom insets, `100dvh` never `100vh`                                                                                                   | `apps/web/src/app/layout.tsx`, `components/Header.tsx` | Sonnet   | No content under the notch; header stays put as the iOS toolbar collapses                                        |
| 7.3  | Project dashboard: start/end date, total spend, receipts by transaction date descending                                                                                                                  | `apps/web/src/app/(app)/projects/[id]/`                | Sonnet   | Totals reconcile against the database; the list uses `receipts_project_date_idx`                                 |
| 7.4  | Receipt detail and edit — every field editable, `missing_fields` shown as a review badge                                                                                                                 | `apps/web/src/app/(app)/receipts/[id]/`                | Sonnet   | Editing clears the field from `missing_fields`                                                                   |
| 7.5  | Review queue: receipts where `extraction_status <> 'ok'`                                                                                                                                                 | `apps/web/src/app/(app)/review/`                       | Sonnet   | Uses `receipts_review_idx`; empty state is not an error state                                                    |
| 7.6  | Category management and per-item assignment; `ai_assigned_category` visually distinct                                                                                                                    | `apps/web/src/app/(app)/settings/categories/`          | Sonnet   | Deleting a category in use is blocked with a message naming the count                                            |
| 7.7  | Filters — date range and category — with URL state read from `window.location.search` **inside** the handler, never a closure                                                                            | `apps/web/src/components/Filters.tsx`                  | Sonnet   | Pausing 300ms on a filtered view does not wipe the other filter (`FORKD_LESSONS.md`)                             |
| 7.8  | Capture: `<input type="file" accept="image/*" capture="environment" multiple>`, batch upload with progress                                                                                               | `apps/web/src/components/Capture.tsx`                  | Sonnet   | 10 photos from the camera roll upload in one action                                                              |
| 7.9  | Manifest, icons, `offline.html`, install prompt (Android `beforeinstallprompt` + iOS instructions)                                                                                                       | `apps/web/src/app/manifest.ts`, `public/`              | Sonnet   | Installs to the home screen on both platforms                                                                    |
| 7.10 | Service worker `ledgerly-shell-v1`: cache-first for `/_next/static/` and the shell, network-first navigations with preload, **network-only for everything else**; bypass on redirect, non-200, or opaque | `apps/web/public/sw.js`                                | **Opus** | An expired Access session does **not** cache a login redirect as the shell; no `stale-while-revalidate` anywhere |
| 7.11 | No nested `<form>` anywhere; verified by rendering, not string-matching                                                                                                                                  | —                                                      | Sonnet   | Playwright WebKit renders each form page and asserts structure (`FORKD_LESSONS.md`)                              |
| 7.12 | Third-party components wrapped in `isolation: isolate` if any set high z-indexes                                                                                                                         | —                                                      | Sonnet   | Modals render above everything at a 390px viewport                                                               |

**Gate.** Usable on your phone through the tunnel.

---

## Phase 8 — Export

| #   | Task                                                                                        | Files                                   | Model  | Acceptance                                                                                  |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| 8.1 | XLSX via `exceljs`, two sheets, generated as a `export` queue job for large projects        | `packages/queue/src/pipeline/export.ts` | Sonnet | A 2,000-item project exports without blocking a request                                     |
| 8.2 | Sheet 1 "Line Items", one row per item, the exact column list in the brief §1.7             | same                                    | Sonnet | Column headers match the brief exactly                                                      |
| 8.3 | Sheet 2 "Receipts", one row per receipt. **Receipt totals appear only here**                | same                                    | Sonnet | `total` appears on no line-item row — dragging a SUM down sheet 1 cannot triple a deduction |
| 8.4 | CSV emits sheet 1 only                                                                      | same                                    | Sonnet | CSV opens in Excel with no mangled dates or lost leading zeros on `card_last4`              |
| 8.5 | Filter-aware; the applied filter is written into a header row so the export is reproducible | same                                    | Sonnet | Two exports of the same filter are byte-identical apart from the timestamp                  |
| 8.6 | Money formatted from `numeric` strings via `money.ts`, never a float (D-21)                 | same                                    | Sonnet | Sheet 2 totals equal the database sums to the cent                                          |
| 8.7 | `audit_log` entry on every export                                                           | `packages/api/src/routers/export.ts`    | Sonnet | One row per export, with the filter in `metadata`                                           |

**Gate.** Opens clean in Excel and the totals reconcile.

---

## Phase 9 — Backups

| #   | Task                                                                                       | Files                                   | Model  | Acceptance                                                                 |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------- | ------ | -------------------------------------------------------------------------- |
| 9.1 | Manual backup job: `pg_dump --format=custom`, optional images, `app_config` left encrypted | `packages/queue/src/pipeline/backup.ts` | Sonnet | Archive contains `db.dump`, `manifest.json`, and images only when enabled  |
| 9.2 | `manifest.json`: schema version, per-table row counts, image count, SHA-256 checksums      | same                                    | Sonnet | Checksums verify against the archive contents                              |
| 9.3 | Scheduled backup as a BullMQ repeatable job, cron from `app_config`, reconciled on boot    | same                                    | Sonnet | Changing the cron in the UI reschedules without a restart                  |
| 9.4 | Retention: prune past `BACKUP_RETENTION_DAYS`, soft-delete the row, unlink the file        | same                                    | Sonnet | An 31-day-old backup is pruned; the row remains with `deleted_at` set      |
| 9.5 | `scripts/restore.sh` — extract, `pg_restore --clean --if-exists`, replace uploads          | `scripts/restore.sh`                    | Sonnet | Documented, executable, and idempotent                                     |
| 9.6 | **Restore drill against a scratch database**                                               | `docs/private/`                         | Sonnet | Row counts match the manifest; the app boots against the restored database |
| 9.7 | `MASTER_KEY` warning surfaced in the admin UI and in `SETUP.md`                            | —                                       | Haiku  | The archive alone cannot decrypt `app_config`, and the UI says so          |

**Gate.** The restore drill succeeds on a scratch database. A backup that has
never been restored is a hypothesis.

---

## Phase 10 — Hardening & docs

Opens with an Opus review; Sonnet fixes what it finds.

| #     | Task                                                                                                                                                | Files           | Model                 | Acceptance                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------- | ------------------------------------------------------------------- |
| 10.1  | Full security review against the brief §4 checklist, every line                                                                                     | —               | **Opus** (`reviewer`) | Every item verified in code, not assumed                            |
| 10.2  | Fix everything the review raised                                                                                                                    | —               | Sonnet                | Re-review is clean                                                  |
| 10.3  | `SETUP.md` — Cloudflare Tunnel, Access application and policy, Anthropic key, first-owner verification. Written for someone who has done none of it | `SETUP.md`      | Haiku                 | Numbered steps, each stating what you should see; placeholders only |
| 10.4  | `DEPLOYMENT.md` — deploy, upgrade, rollback, restore drill, the `APP_PORT` / tunnel-ingress coupling (D-16)                                         | `DEPLOYMENT.md` | Haiku                 | A port change is documented as a two-place edit                     |
| 10.5  | `README.md` — what it is, quickstart                                                                                                                | `README.md`     | Haiku                 | Accurate against the shipped app, not the plan                      |
| 10.6  | Secret sweep: gitleaks over full history, plus a manual grep for hostnames, AUD tags, tunnel IDs                                                    | —               | Sonnet                | Both clean; the repo is public, so this is a release blocker        |
| 10.7  | Verify `docs/private/` never entered history                                                                                                        | —               | Sonnet                | `git log --all --diff-filter=A -- 'docs/private/*'` is empty        |
| 10.8  | Container runs as non-root after entrypoint; both `user:` override paths tested                                                                     | —               | Sonnet                | `docker exec whoami` returns `node`                                 |
| 10.9  | Device testing — iPhone Safari, Android Chrome, desktop, and a private window with no prior Access cookie                                           | —               | Sonnet                | The three iOS-only failure classes in `FORKD_LESSONS.md` are absent |
| 10.10 | **Clean-machine setup from `SETUP.md`**                                                                                                             | —               | you                   | A working instance without consulting anything else                 |
| 10.11 | Tag `v1.0.0`                                                                                                                                        | —               | Sonnet                | Actions green on the tag                                            |

**Gate.** You complete a clean-machine setup. Any unchecked item on the brief's
security checklist blocks the tag.

---

## Phase 1 acceptance criteria carried forward

Two items are deliberately deferred out of Phase 1 and must not be lost:

- **D-12 is Provisional.** Phase 6 task 6.3 confirms strict-mode union types and
  task 6.12 measures extraction accuracy. Both amend `DECISIONS.md` D-12 in
  place rather than opening a new decision.
- **The brief's escalation threshold** of ~30% was computed against expired
  pricing; ~45% is the corrected figure (D-12). Phase 6 task 6.10 makes the real
  rate visible so the threshold is a measurement, not a guess.
