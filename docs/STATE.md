# Ledgerly — Build State

Updated at the end of every phase. Read this first in any new session.

## Current phase

Phase 3 — Auth & identity. **Complete.** Reviewed (task 3.12), findings
triaged and fixed, committed.

## Task 3.12 review — what was found and what was done

The `reviewer` pass found 2 high, 7 medium and 11 low. Fixed before commit:

| #       | Finding                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H-1** | No tRPC `errorFormatter`. Internal messages went to the client verbatim — Postgres constraint names, the `instance_state` seed hint, `pg` connection errors carrying the database host. The contract §8 promised this formatter and it was never written. | `errorFormatter` replaces the message for any non-client-facing code, strips `stack`/`path` (deleted, not undefined — superjson serialises undefined as null _and_ a meta entry), logs the real cause server-side, and pins `isDev: false`. Regression-tested.                           |
| **H-2** | `scopedProjects` — the one authorization helper, which all of Phase 4 composes onto — had **no tests at all**, and neither did the procedure ladder.                                                                                                      | `packages/api/src/scope.test.ts` (8) covers every matrix cell across live/archived/soft-deleted projects for 6 actor types, plus an assertion that the `member_permission` enum still orders `read < read_add < full` **in the database**. `trpc.test.ts` (8) covers the ladder and H-1. |
| **M-1** | `.env.example` shipped `DEV_AUTH_BYPASS=true`, and compose's `env_file` overrides the image's `NODE_ENV=production`. Only a Next.js implementation detail was saving it.                                                                                  | Default is now `false`, with the reasoning in the comment.                                                                                                                                                                                                                               |
| **M-2** | `refreshUser`'s Case A recovery issued a second `UPDATE` after a `23505` on the same connection. Inside an enclosing transaction that fails with `25P02`, turning a never-fail path into a 500.                                                           | The collision-prone `UPDATE` is wrapped in its own transaction, so nesting yields a SAVEPOINT.                                                                                                                                                                                           |
| **M-4** | The `user.sub_relinked` audit row omitted the old `sub`, which the relink overwrites in place — so it existed nowhere afterwards. D-27 requires both.                                                                                                     | `previousSub` carried out on `ProvisionOutcome` and audited.                                                                                                                                                                                                                             |
| **M-6** | Turbo ran `@ledgerly/db`, `@ledgerly/auth` and `@ledgerly/api` tests concurrently against one database; `withCleanDatabase()` TRUNCATEs it. Passed only because the suites were small.                                                                    | Root `test` runs `--concurrency=1`; `fileParallelism: false` within `packages/api`; the clean pool sets `lock_timeout=10s` so a future collision fails loudly instead of hanging.                                                                                                        |
| **M-7** | `admin.relinkAccount` was a read-then-write with no lock or transaction; a race produced an unhandled `23505` (returned verbatim, per H-1) and could leave an audit row claiming a relink that did not happen.                                            | One transaction, `FOR UPDATE` on the target row, `23505` mapped to `CONFLICT`.                                                                                                                                                                                                           |
| **L-1** | `verifyAccessJwt`'s `keySet` default parameter evaluated _before_ the `not_configured` guard, and `getAccessKeySet()` throws without a team domain — so branch 3e threw a 500 instead of returning a clean rejection. Reachable outside production.       | `keySet` resolved after the guard.                                                                                                                                                                                                                                                       |
| **L-5** | The race test's pool used pg's implicit `max: 10` — exactly the number of concurrent transactions, so any change would silently serialise them and every assertion would still pass.                                                                      | `max: 20` set explicitly.                                                                                                                                                                                                                                                                |
| **L-7** | Case A's WARN logged only one of the two conflicting `sub`s, so the operator could not identify the other row.                                                                                                                                            | Logs both identities, still no addresses.                                                                                                                                                                                                                                                |
| **L-9** | The matcher excluded `api/v1/health` as a _prefix_, so a future `/api/v1/health/detail` would inherit the exemption.                                                                                                                                      | `api/v1/health(?![\w-])`.                                                                                                                                                                                                                                                                |
| —       | `CF_ACCESS_JWKS_TTL_MS` accepted `1`, which would refetch Cloudflare's certs on nearly every request.                                                                                                                                                     | Floor of 60s.                                                                                                                                                                                                                                                                            |
| **M-3** | Route Handlers are never covered by a layout, so a future `route.ts` under `app/(app)/` would look gated and not be.                                                                                                                                      | `requireAuthRoute(request)` exported under the contract's promised name, documenting the obligation at the call site.                                                                                                                                                                    |

**Deliberately not fixed — carried into Phase 4:**

- **L-4** — nothing constrains `users.role='owner'` to one row, and both
  `scopedProjects`' short-circuit and `ownerProcedure` trust it alone. Wants
  a forward-only migration adding `CREATE UNIQUE INDEX ... WHERE role='owner'`.
  Migration work belongs with Phase 4's schema changes, not bolted on here.
- **M-5** — with `ACCESS_ALLOW_SUB_RELINK` on, a `sub` presenting the
  instance owner's email takes over the owner row. D-27 accepts the model;
  the residual blast radius wants a guard refusing to relink onto
  `role='owner'`, plus a note in `SETUP.md` (Phase 10 task 10.3).
- **L-2** — each rejected identity-conflict request writes an `audit_log`
  row, and the page path redirects into a re-auth loop, so one affected user
  can fill the table at request rate. Wants dedup or a cooldown.
- **L-3** — the null-user page path 307s to sign-out rather than returning
  the §5 byte-identical 403. Probably better UX, but it is contract drift
  and should either be recorded in `DECISIONS.md` or changed.
- **L-6** — `scopedProjects` returns a bare `SQL`, so misuse type-checks
  (it fails at runtime in Postgres, so it is not a silent bypass). Worth a
  narrower return type before a dozen Phase 4 call sites exist.
- **L-10** — contract test 30 (three identity reads, one query) is still
  unwritten, so D-03's economics are unverified.
- **L-11** — the `raced` early return skips the §4.4 refresh, leaving
  `lastSeenAt` one request stale on that path. Cosmetic.
- **L-8** — the elected owner's email is logged at WARN. Per contract §4.3
  and intentional; noted because it is PII in `docker logs`.
- The contract's §6 signature block is stale: `resolveIdentity` lives in
  `apps/web/src/server/identity.ts`, not `packages/auth`, to keep the auth
  package framework-agnostic. The relocation is right; the document is not.

## Completed

**Phase 0 (2026-09-07)**

- Forkd analysed by five scoped `forkd-analyst` subagents. Reference docs
  written to `docs/reference/`: `FORKD_STACK.md`, `FORKD_AUTH.md`,
  `FORKD_INFRA.md`, `FORKD_UI.md`, `FORKD_LESSONS.md` (~2300 lines).
  These are the standing substitute for reading the Forkd repo. Later
  phases read these, never Forkd itself.
- Scrub pass over all five docs: no hostnames, AUD tags, tunnel IDs, keys,
  or local paths. One real hostname was caught and replaced with
  `<APP_HOSTNAME>`.
- Git initialised (`main`), identity set repo-local only, `.gitignore`
  verified against 18 sensitive path probes before the first commit.
- Repo published as a public GitHub repo.

**Phase 1 (2026-09-07)**

- `docs/Ledgerly_Project_Plan.md` — the project brief, committed as the
  standing reference. `DECISIONS.md` is authoritative where they disagree.
- `ARCHITECTURE.md` — stack, module layout, request flow, image pipeline,
  AI extraction flow, configuration, deployment topology, PWA.
- `DECISIONS.md` — 23 decisions (D-01 … D-23), each with context, rationale,
  and consequences. All five of the brief's open decisions resolved, plus the
  three questions Phase 0 left open.
- `docs/SCHEMA.md` — 11 tables, 6 enums, full DDL with constraints and
  indexes, permission matrix, migration strategy. **This is the Phase 1 gate.**
- `docs/PHASES.md` — phases 2–10 as 100 numbered tasks, each with files,
  acceptance criterion, and model assignment.

**Phase 2 (2026-09-08)**

- pnpm workspace, 7 packages (`api`, `auth`, `config`, `db`, `queue`,
  `shared`, `ui`) + `apps/web`, Turbo, `tsconfig.base.json` (ES2022, strict,
  `noUncheckedIndexedAccess`), ESLint 9 flat config, Prettier 3.
- `packages/shared`'s D-07 import boundary (`node:*`, `pg`,
  `drizzle-orm/pg*`, `bullmq`, `ioredis`, `sharp`, `@anthropic-ai/sdk`
  forbidden) enforced by `no-restricted-imports`, proven by an in-memory
  ESLint-API fixture test rather than a permanently-failing tracked file.
- `packages/config`: Zod env schema (`env.ts`) parsed once at import, with
  the D-05/D-14/D-25/D-27 cross-field invariants, plus `edge.ts` — the
  four-key Edge Runtime subset read as literal `process.env.X` expressions
  (Next inlines these at build time; a full-object parse silently yields
  `{}` there). 14 tests, all against `parseEnv` as a pure function.
- `.env.example`: every variable from `ARCHITECTURE.md` §7.2, placeholders
  only, secretlint-clean (verified against the whole tracked tree, not just
  this file).
- `packages/db`: full schema per `docs/SCHEMA.md` (11 tables, 6 enums),
  `pg.Pool` client, `drizzle.config.ts`, idempotent seed
  (`instance_state` + 13 system categories). Migration `0000` generated,
  hand-reviewed, and applied against a real `postgres:17` — drizzle-kit
  0.31 emitted every partial/expression unique index correctly on the
  first pass (`users_email_lower_key`, `projects_owner_name_live_key`,
  `categories_slug_live_key`), so no hand-appended SQL was needed this
  time; still worth re-checking by hand on every future `db:generate`.
- `apps/web`: Next.js 15 App Router skeleton, `output: "standalone"`,
  `serverExternalPackages: ["sharp","bullmq","ioredis"]`, tRPC handler
  mounted on an empty root router (`packages/api/src/{trpc,root}.ts` —
  bare context only, no auth middleware, per CLAUDE.md), deep healthcheck
  (`SELECT 1` + Redis ping, 503 on failure, D-15).
  `src/instrumentation.ts` imports `@ledgerly/config/env` unconditionally
  under a `NEXT_RUNTIME === "nodejs"` guard (Edge Runtime can't load it —
  see the file's own comment for why the guard is a platform necessity,
  not a loophole).
- `docker/Dockerfile` (deps/builder/runner) + `entrypoint.sh` (checks
  `id -u` before `su-exec` — both the root path and a `user: "1000:1000"`
  override tested directly against the built image).
  `docker-compose.yml`: webapp on `127.0.0.1:${APP_PORT}` only, db/redis
  publish no ports, four named volumes. Full `docker compose up` verified
  green: migrate → seed → serve, health 200, 503 within one interval when
  `db` is stopped, 200 again on recovery, seed idempotent across two full
  boot cycles (13 categories, not 26).
- Test harness (`test/setup.ts`, `packages/db/src/testHarness.ts`):
  default per-test transaction rollback, plus `withCleanDatabase()` as the
  documented escape hatch for Phase 3's first-owner race test (genuinely
  separate connections, which the rollback wrapper forecloses).
  `TEST_DATABASE_URL` only, never `DATABASE_URL` (D-18).
- `.github/workflows/ci.yml`: install → lint → typecheck → test (throwaway
  `postgres:17` service) → build, gitleaks over full history as a
  separate job, docker build+push to GHCR on `main`.
- secretlint wired into `lint-staged` via husky `pre-commit`; verified end
  to end — a staged file with a fake GitHub token is blocked and reverted.
- **Left undone / flagged for the next session:** gitleaks could not be
  run locally in this environment (the `zricethezav/gitleaks` container
  hung indefinitely at `docker create`, unrelated to the Dockerfile/compose
  work — those built and ran successfully earlier in the same session).
  It runs for real in the CI job above; Phase 10 task 10.6 is the standing
  full-history sweep regardless. Next.js's standalone `server.js` forces
  `NODE_ENV=production` internally regardless of what's injected at the
  container level, which means `DEV_AUTH_BYPASS` only ever works through
  `pnpm dev`, never through the Docker image — worth a line in `SETUP.md`
  (Phase 10) so this isn't rediscovered the hard way.

**Phase 3 (2026-09-08)**

- Design pass (task 3.1) in `docs/private/PHASE3_AUTH_CONTRACT.md` — function
  signatures, failure modes, the branch table for every branch in
  `ARCHITECTURE.md` §3.1, and a numbered test plan. Six new decisions:
  **D-24 … D-29** in `DECISIONS.md`.
- `packages/auth`: `cloudflareAccess.ts` (`verifyAccessJwt`), `jwks.ts`,
  `provision.ts` (JIT + atomic first-owner election), `identity.ts`,
  `response.ts`, `types.ts`.
- `packages/api`: procedure ladder (`publicProcedure` -> `onboardingProcedure`
  -> `protectedProcedure` -> `ownerProcedure`), `scope.ts`
  (`scopedProjects`), `routers/auth.ts`, `routers/admin.ts`.
- `apps/web`: `proxy.ts` (edge perimeter), `server/identity.ts` (React
  `cache()`), `(app)/layout.tsx` (onboarding gate), `welcome/`,
  `api/auth/sign-out/`.
- **`scopedProjects` landed early** — it is Phase 4 task 4.1 in
  `docs/PHASES.md`, pulled into Phase 3 because the procedure ladder is
  incomplete without the thing it deliberately does not do. **Phase 4 must
  not rebuild it.** Its archived-projects semantics (`add` excludes
  archived; `read`/`manage`/`delete` include it) are a judgment call not
  covered by `docs/SCHEMA.md` — recorded in the contract §9.1.
- **`proxy.ts` does not work on Next.js 15.5 and has been renamed to
  `apps/web/src/middleware.ts`.** `ARCHITECTURE.md` §2, `PHASES.md` task
  3.6 and `FORKD_AUTH.md` all name the file `proxy.ts`; Next 15.5.25 has no
  `PROXY_FILENAME` constant and only recognises `middleware` (`proxy.ts` is
  the Next 16 rename). A `proxy.ts` is silently never registered — the
  build stays green and **the Access perimeter is simply inert**. Caught by
  inspecting `.next/server/middleware-manifest.json`, which was empty; it
  now registers the matcher and the build reports `ƒ Middleware 54.6 kB`.
  Worth remembering as the general lesson: a middleware that is not wired
  up fails open and looks identical to one that is.
- **`packages/config`'s `env` and `packages/db`'s pool are now lazy.** Both
  were evaluated at module load, and `next build` collects page data by
  evaluating every route module — so as soon as a route transitively
  imported either (which Phase 3's tRPC context does), the build failed on
  any machine without production secrets. `getEnv()` / `getDb()` /
  `getPool()` replace the eager consts. **The D-05/D-14 startup guarantee
  is unchanged:** `instrumentation.ts` now _calls_ `getEnv()` during
  `register()`, so a misconfigured process still refuses to boot before the
  server listens — the guard is still "invoked once at startup", it is just
  no longer "invoked as a side effect of any import from anywhere".
- Three deviations from `docs/PHASES.md`, each with a reason:
  - The onboarding gate is **not** in `proxy.ts` (task 3.8's file list). It
    needs `users.onboarded_at`; middleware runs on the Edge Runtime and `pg`
    does not. `ARCHITECTURE.md` §3.1 already placed it in the Node layer.
  - `packages/config/src/edge.ts` carries **five** keys, not four —
    `CF_ACCESS_JWKS_TTL_MS` is needed by `jwks.ts`, which the Edge
    middleware imports.
  - `last_seen_at` is coarsened to 15-minute granularity, so D-03's "one
    user row read per request" does not become one row _write_ per request.
- **Test state: 80 passing, 0 unrun.** (Docker was repaired on 2026-09-08;
  everything previously blocked has now been run.)
  - Passing: `packages/auth` 21 (the whole JWT verification matrix,
    including the two named regression tests — an unconfigured
    `CF_ACCESS_AUD` must return `not_configured` and never `ok`, and an
    empty `sub` must be rejected rather than stored as `""`), plus the
    byte-identical-403 assertion across six distinct rejection reasons;
    `packages/config` 14; `packages/shared` 9.
  - `packages/auth` 52 (21 verification + 31 provisioning),
    `packages/config` 17, `packages/shared` 9, `packages/db` 2.
  - **The first-owner race test passes all 20 repeats.** 10 concurrent
    provisions on separate pool connections, exactly one owner every time,
    `instance_state.owner_id` always matching. The winner varies run to run
    (`user0`, `user3`, `user6`, `user8` …), which is the evidence that the
    transactions genuinely race rather than resolving in a fixed order — a
    race test whose winner never changes has not proven anything.
  - Both D-27 branches covered: flag off rejects cleanly with an audit row
    and no orphan user; flag on reassigns the `sub` onto the existing row
    and preserves the user's onboarding.

**Phase 2 + 3 verification, 2026-09-08 (Docker repaired)**

- `docker compose up` green from a clean build: migrate -> seed -> serve,
  `db` healthy and publishing no ports, `redis` publishing no ports,
  webapp bound to `127.0.0.1:3000` only. Seed idempotent across a restart
  (13 categories, 1 `instance_state` row).
- Privilege drop confirmed: PID 1 `next-server` runs as `node` (UID 1000).
  **Note for Phase 10 task 10.8: its acceptance criterion is wrong.**
  `docker exec whoami` returns `root` no matter what, because `docker exec`
  starts a new process as the image's default user rather than inheriting
  PID 1's. Check the process table or `docker top` instead.
- **Live perimeter probe** against the running container: `/api/v1/health`
  200 (matcher-exempt); `/`, `/welcome`, `/api/trpc/*` all 403
  `Access denied.` with identical `cache-control: no-store` headers. A
  garbage JWT, an `alg:none` forged JWT, a spoofed `x-ledgerly-sub`, and a
  spoofed `Cf-Access-Authenticated-User-Email` all return the same 403 —
  D-24 and D-06 hold against a live request, not just in unit tests.
- **CI docker job fixed.** The first-ever push to `main` exposed a Phase 2
  defect in `.github/workflows/ci.yml`: the job sets `cache-to: type=gha`
  but never ran `docker/setup-buildx-action`, so `build-push-action` used
  the default `docker` driver and failed with "Cache export is not
  supported for the docker driver". The job is gated on
  `github.ref == 'refs/heads/main' && github.event_name == 'push'`, so no
  pull-request or branch run could ever have caught it — worth remembering
  when adding any other `main`-only job.
- **gitleaks finally run** (it was blocked in Phase 2 by the same Docker
  fault): full history clean, `no leaks found`. A working-tree scan reports
  one hit, `.env:16`, which is a gitignored file that is supposed to hold
  secrets; the other 15 are inside `node_modules`. Nothing tracked leaks.
- **Found and fixed a real D-05 defect** — see the amendment on D-05. The
  guard fired but did not stop the process: the container stayed `running`
  with exit code 0 and served 500s forever. Now exits 1 in ~2s, and the
  invariant is additionally enforced in the Edge runtime via `edge.ts`.
- Fixed a Phase 2 defect found on review: `TEST_DATABASE_URL` was set in CI
  but present in neither `.env.example` nor `.env`, and nothing loaded
  `.env` into Vitest, so `pnpm test` was red from a clean checkout.
  `vitest.shared.ts` now lifts that one key from the repo-root `.env` (real
  environment first, so CI still wins).

## Next

1. **Task 3.12** — `reviewer` subagent over the whole Phase 2 + Phase 3
   diff. `CLAUDE.md` requires this before any auth work is committed.
2. Commit, push, and verify the Actions run (`gh run watch`).

Then Phase 4 — Projects & permissions, minus task 4.1 (already done).

### Running the database tests locally

```
./scripts/test-db.sh          # start + migrate (idempotent)
./scripts/test-db.sh --reset  # destroy and recreate from scratch
./scripts/test-db.sh --stop   # remove the container
pnpm test
```

The test database is a **separate throwaway container**, not the compose
stack's `db`. That is deliberate: compose's `db` publishes no ports at all
(ARCHITECTURE.md §8 — nothing but the Cloudflare Tunnel should reach this
instance), so host-run tests cannot connect to it, and publishing a port
just for tests would trade away a real security property. A dedicated
container on loopback also matches what CI does with its `postgres:17`
service, so local and CI runs behave the same.

The script reads only `TEST_DATABASE_URL` and `DATABASE_URL` from `.env`
rather than sourcing it, and refuses to run if the two are equal (D-18);
`packages/db/src/testHarness.ts` asserts the same thing again at test time.
`vitest.shared.ts` lifts `TEST_DATABASE_URL` out of `.env` for the run.

## Resolved questions

Phase 0 resolutions:

- **Postgres vs SQLite** → **PostgreSQL 17** (D-02).
- **Repo public or private** → **public** (D-13). The "scan history before going
  public" checklist item is now a standing full-history gitleaks CI job.

Phase 0's three open questions, all closed in Phase 1:

- **Scope of inheritance from Forkd's receipt pipeline** → **port the
  scaffolding, rewrite the pipeline** (D-19). `queue.ts` / `redis.ts` /
  `worker.ts` follow Forkd's shapes; `pipeline/extract.ts` is new, because
  Forkd extracts restaurant bills for splitting and the data contract differs
  too much to adapt.
- **AI model default** → **two-pass ladder**, `claude-haiku-4-5` then
  `claude-sonnet-5`, both env-tunable (D-12). Forkd's `claude-opus-4-7` pin is
  dropped.
- **Monorepo vs single app** → **monorepo retained** (D-07, user decision). The
  client-bundle bleed that comes with it is mitigated by an ESLint
  `no-restricted-imports` rule in Phase 2 task 2.2, not by vigilance.

Decisions taken by the user this session:

- Repo layout → mirror Forkd's pnpm + Turbo monorepo (D-07)
- Background jobs → BullMQ + Redis (D-08)
- Category taxonomy → seeded global list, user-extensible (D-20)

## Blocked / open questions

- **D-12 is Provisional.** Phase 6 task 6.3 must confirm strict-mode tool use
  accepts `["string","null"]` union types; if not, the fallback is non-strict
  tool use with Zod validation, appended to D-12 rather than filed anew. Phase 6
  task 6.12 measures extraction accuracy over 10 real receipts, which is what
  settles whether `claude-haiku-4-5` is the right pass-1 model.

## Surprises / notes

- **The brief's atomic first-owner query does not work as written.**
  `SELECT ... WHERE role='owner' FOR UPDATE` locks the rows it returns, and on an
  empty users table that is none — so two concurrent first requests both see "no
  owner" and both insert. `docs/SCHEMA.md` adds a single-row `instance_state`
  table to give the transaction something real to lock. Phase 3 task 3.4
  race-tests it.
- **Sonnet 5's introductory pricing expired 2026-08-31**, a week before Phase 1.
  The brief's $2/$10 per MTok is now $3/$15. Haiku 4.5 is unchanged at $1/$5.
  The brief's "go Sonnet-first above ~30% escalation" threshold was computed
  against the expired rate; the corrected crossover is nearer 45% (D-12).
- **Haiku 4.5 and Sonnet 5 need different request shapes.** Haiku rejects
  `output_config.effort` and uses `thinking: {type:"enabled", budget_tokens:N}`;
  Sonnet 5 uses `thinking: {type:"adaptive"}` and supports `effort`. One shape
  sent to both will 400.
- Dropping Better Auth (D-03) removes three of Forkd's most expensive bug
  classes at once and shrinks `MASTER_KEY`'s blast radius from "forge any
  session" to "read stored settings".
- Ledgerly has **no public guest surface**, so the `/g/` self-contained-HTML
  rule and the `/_next/static/*` Access bypass from `FORKD_LESSONS.md` do not
  apply. Nothing anonymous ever needs an asset.
- `poppler-utils` is the only package Ledgerly adds to the runner image that
  Forkd does not have. It drops Chromium, ffmpeg, python3, and yt-dlp, and the
  entire `chrome-headless` service.
