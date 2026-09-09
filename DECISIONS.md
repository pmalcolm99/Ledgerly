# Ledgerly — Decisions

Every significant choice, with the reason. `CLAUDE.md` requires that any
deviation from Forkd's stack, structure, or naming be recorded here.

Format: **decision**, **context**, **why**, **consequence**. Decisions are
append-only. If one is reversed, the entry stays and gains a `Superseded by`
line, because the reasoning that led to a reversal is worth as much as the
reversal.

Status legend: **Settled** — decided in Phase 1. **Provisional** — decided, but
a named Phase must confirm it against reality before it hardens.

---

## D-01 — tRPC, not Express or Fastify. **Settled.**

**Context.** `docs/Ledgerly_Project_Plan.md` §1.1 lists "Express or Fastify" as
the API layer, flagged as an assumption to confirm against Forkd. Forkd uses
tRPC 11 + TanStack Query + superjson running inside Next.js
(`docs/reference/FORKD_STACK.md` §2). There is no separate API server.

**Why tRPC.** The plan's own ground rule is that Forkd wins on stack. Beyond
that: adding Express would mean a second process to supervise, a second place to
integrate Cloudflare Access verification, a second CORS surface, and
hand-maintained request/response types where tRPC infers them. Forkd's
`protectedProcedure` / `ownerProcedure` middleware ladder is the exact shape
Ledgerly's permission model needs, and it transfers with no translation.

**Consequence.** All mutations and queries are tRPC procedures in
`packages/api/src/routers/`. The two exceptions are byte-streaming endpoints
that do not fit RPC — upload (`multipart`) and image serving — which are Next.js
Route Handlers, and which perform the same `scopedProjects` composition.

---

## D-02 — PostgreSQL 17. **Settled.**

**Context.** Open decision #1 in the brief: Postgres or SQLite. The brief notes
SQLite is defensible for a personal app. `docs/STATE.md` had already resolved
this in Phase 0.

**Why Postgres 17.** Forkd runs `postgres:17-alpine`; matching it makes the
Drizzle schema, the drizzle-kit migration tooling, and the
`pg_dump --format=custom` backup path inheritable rather than reinvented. The
brief also specifies SQLite at version 16 in one place and Postgres in another —
17 resolves both. SQLite would have made backups simpler but would have cost the
entire backup/restore design in `docs/reference/FORKD_INFRA.md`, plus
`SELECT ... FOR UPDATE`, which the atomic first-owner transaction depends on.

**Consequence.** `postgres:17-alpine`, Drizzle ORM 0.41, drizzle-kit 0.31, `pg`
8.x with `pg.Pool`. `postgresql17-client` in the runner image for
`pg_dump`/`pg_restore`.

---

## D-03 — No session layer. Verify the Access JWT on every request. **Settled.**

**Context.** Forkd verifies the Access JWT in edge middleware, then provisions a
Better Auth session row and a `forkd.session_token` cookie signed with
`MASTER_KEY`; every subsequent request trusts the cookie and does not re-verify
the JWT (`docs/reference/FORKD_AUTH.md` §4). The brief §1.4 describes per-request
JWT verification and never mentions a session.

**Why no session.** Three of the most expensive incidents in
`docs/reference/FORKD_LESSONS.md` trace directly to that cookie:

1. An infinite redirect loop between Access and the sync route, fixed only by
   exempting the sync route from its own cookie check — a security-critical
   exception that has to be remembered forever.
2. Cloudflare Cache Rules stripping `Set-Cookie`, forcing the sync route to
   return a 200 with `<meta http-equiv="refresh">` instead of a 302.
3. Session tokens signed with `MASTER_KEY` (`FORKD_AUTH.md` finding #4,
   "CRITICAL"): a key leak forges a session for any user.

None of that buys anything Ledgerly needs. Access already authenticates every
single request — the JWT is present on all of them. Re-verifying it costs one
in-memory JWKS lookup (jose caches keys for roughly an hour). The only real cost
of dropping the cookie is a `users` row read per request, and Forkd already
found the fix for that: wrap the resolution in React's `cache()` so it runs at
most once per request (`FORKD_LESSONS.md` §"Session resolution called multiple
times per request").

**Consequence.** No `session` table, no `account` table, no `verification`
table, no `better-auth` dependency, no cookie signing, no sync route. Three bug
classes and one critical secret dependency are removed by construction.
`MASTER_KEY` is still required, but only for `app_config` encryption, which
shrinks its blast radius from "forge any identity" to "read stored settings".

**Consequence, accepted.** If Cloudflare's JWKS endpoint is unreachable for
longer than jose's cache TTL, every user is locked out rather than only new
sessions. `FORKD_AUTH.md` finding #3 assesses this as low risk given the
endpoint is Cloudflare's own CDN; Ledgerly accepts the same assessment, and it
was already true for new logins under Forkd's design.

---

## D-04 — Sign-out is a Route Handler that redirects to Access logout. **Settled.**

**Context.** Two Forkd lessons converge: Next.js 15 forbids cookie writes in
Server Components (Forkd's sign-out page silently failed to delete the cookie),
and clearing only the app session leaves `CF_Authorization` valid so the user is
silently re-authenticated on the next visit.

**Why.** Under D-03 there is no app session to clear, so sign-out is _only_ the
redirect to `https://<team>/cdn-cgi/access/logout`. That is also the only thing
that ever actually logged a Forkd user out.

**Consequence.** `apps/web/src/app/api/auth/sign-out/route.ts`, a GET Route
Handler. The nav uses a plain `<a href>`, not `<Link>`, so the browser issues a
real navigation. Phase 3 acceptance: close the browser, revisit, and be
challenged by Access again.

---

## D-05 — `DEV_AUTH_BYPASS` fails at startup, not per-request. **Settled.**

**Context.** Forkd's dev bypass is guarded by two independent runtime
comparisons in different files: `CF_ACCESS_ENABLED !== "true"` in `proxy.ts` and
`NODE_ENV !== "production"` in the dev pages. `FORKD_AUTH.md` finding #1 rates it
low risk but notes that a single wrong env var in production exposes it.

**Why change it.** A guard that is checked per-request in two places can be
bypassed by any code path that forgets one of them. A guard that is checked once
at startup cannot: the process does not exist in the unsafe state. The brief also
demands exactly this — "fail loud, at startup, not at request time."

**Consequence.** The invariant lives in the Zod env schema in
`packages/config`: `DEV_AUTH_BYPASS === true && NODE_ENV === "production"`
throws and the process exits non-zero. Phase 3 tests the refusal.

**Amendment (Phase 3, 2026-09-08) — "throws" is not the same as "exits".**
The first container-level test of this guard found it firing correctly and
then _not stopping the process_. Next.js caught the throw from the
instrumentation hook, logged it as an `unhandledRejection`, and kept
running: the container stayed `running` with exit code 0, bound its port,
and served 500s indefinitely. `restart: always` does not help, because
nothing ever exits. A misconfigured deploy would sit permanently broken
rather than crash-looping visibly. No authentication bypass occurred — Next
refuses to serve any route once the hook fails — but D-05's actual promise
is that _the process does not exist in the unsafe state_, and it did.

Two changes make that literally true:

1. `apps/web/src/instrumentation.ts` wraps the config load in a `try/catch`
   that logs `FATAL` and calls `process.exit(1)`. Verified: the container
   now exits with code 1 in about two seconds.
2. The same invariant is enforced independently in
   `packages/config/src/edge.ts`, which adds `NODE_ENV` to its literal
   reads. The Node-side guard runs at boot in the Node runtime; the Edge
   runtime parses its own environment separately, so without this the
   middleware could in principle honour a production dev-bypass through
   `edgeEnv.DEV_AUTH_BYPASS` on a process that had somehow started. Both
   runtimes now refuse.

The general lesson, worth carrying into later phases: a startup guard that
throws has only done half its job. What matters is the exit code.

---

## D-06 — Identity is the `sub` claim, not email. **Settled.**

**Context.** Forkd looks users up by the lowercased `email` claim and stores
`sub` only for audit (`FORKD_AUTH.md` §5). Its own finding #2 flags this: two
IdPs returning the same email collapse into one user, and no `sub` uniqueness is
enforced. The brief §1.4 requires `sub`.

**Why.** Emails change; `sub` does not. Keying on email means an IdP-side email
change silently creates a second account and orphans the first user's projects.

**Consequence.** `users.cf_access_sub` is unique and not null. `email` is stored,
kept in sync from the JWT on each visit, and used only for display and for the
admin re-link action — never as a join key.

**Consequence, accepted and mitigated.** Changing the Access identity provider
changes `sub`, so returning users would be provisioned as new accounts. An
owner-only **re-link account** admin action reassigns a `cf_access_sub` onto an
existing `users` row matched by email, writing an `audit_log` entry. Built in
Phase 3, task 3.7.

---

## D-07 — Keep Forkd's pnpm + Turbo monorepo. **Settled** (user decision).

**Context.** Forkd is a pnpm workspace with 8 packages orchestrated by Turbo.
`docs/STATE.md` carried this as an open question because
`docs/reference/FORKD_LESSONS.md` traces several expensive bugs to the structure:
`node:crypto` bleeding into the client bundle, `playwright-core` missing from the
Next.js standalone output, and the subpath-export gymnastics needed to work
around static file tracing. A single Next.js app was the alternative.

**Why monorepo.** Chosen by the user in Phase 1. It makes every pattern in
`docs/reference/` map one-to-one onto Ledgerly's tree, which is worth real time
across nine remaining phases, and it gives package-level boundaries that make the
client/server split explicit rather than conventional.

**Consequence, and the cost being accepted.** The client-bundle bleed is the
failure mode that comes with the structure. `ARCHITECTURE.md` §2.1 states the
rule up front: `packages/shared` is imported by Client Components and must never
export `node:*` built-ins, server-only libraries, or anything over ~10 KB.
`import "server-only"` goes at the top of every server-only module. Phase 2 adds
an ESLint `no-restricted-imports` rule enforcing the dependency direction, so
this is a build failure rather than a code review responsibility.

Two of the three bugs cited do not apply at all: Ledgerly has no Playwright, no
Chromium, and no yt-dlp, so the standalone-tracing problem has no large
dynamically-imported library to bite. Phase 2 still verifies `sharp`, `bullmq`,
and `ioredis` are present in `.next/standalone/node_modules` as an explicit
acceptance criterion.

---

## D-08 — BullMQ + Redis for background jobs. **Settled** (user decision).

**Context.** Receipt extraction takes 5–30s and cannot run inside the upload
request. Forkd uses BullMQ on Redis, a fourth container. The alternative
considered was a Postgres `jobs` table polled with
`SELECT ... FOR UPDATE SKIP LOCKED`, which would have dropped Redis entirely and
put job state inside `pg_dump` backups.

**Why BullMQ.** Chosen by the user. Retries, exponential backoff, concurrency
caps, and repeatable jobs for the nightly backup all come for free and are
already proven in Forkd; `docs/reference/FORKD_INFRA.md` documents the working
configuration. The Postgres option would have meant writing and testing that
machinery from scratch in a pipeline where a lost job is a lost financial record.

**Consequence.** A `redis` service and a `redis_data` volume. Three queues:
`receipt-extract`, `backup`, `export`. Redis also backs the per-user upload rate
limiter, which it now makes free.

**Consequence, accepted.** Queue state lives outside the database backup. A
restore therefore recovers all receipts but not in-flight extraction jobs. The
mitigation is that `receipts.extraction_status` is the source of truth, not the
queue: a `pending` receipt with no live job is re-enqueued by a reconciliation
sweep at worker startup. Phase 6, task 6.8.

---

## D-09 — `RETAIN_ORIGINALS` defaults to false. **Settled.**

**Context.** Open decision #2 in the brief.

**Why.** The display render targets under 300 KB, roughly 3,500 receipts per GB.
Retaining originals grows storage roughly tenfold, and a modern phone HEIC is
3–6 MB. For the tax and reporting purpose the app exists to serve, the 1600px
WebP is legible and sufficient; the original adds nothing a reader needs.

**Consequence.** `RETAIN_ORIGINALS=false` in `.env.example`. `SETUP.md`
documents the storage cost of `true` so the choice is informed rather than
default-accepted. The `receipts.original_key` column exists either way, so
enabling it later requires no migration — only new uploads gain originals.

---

## D-10 — PDF receipts: first page only in v1. **Settled.**

**Context.** Open decision #5 in the brief.

**Why.** A receipt that spans pages is rare; a PDF whose second page is a terms-
and-conditions boilerplate is common. Rasterising page 1 covers nearly every real
case at a fraction of the complexity, and multi-page would multiply the AI cost
per receipt by the page count with almost no extraction gain.

**Consequence.** `pdftoppm -f 1 -l 1 -r 200 -png`. The schema needs no change for
multi-page later, because a multi-page PDF is still one receipt — only the image
pipeline and the render columns would change. Recorded as a v1.1 candidate.

---

## D-11 — `sharp` + libheif for HEIC; `poppler-utils` for PDF. **Settled.**

**Context.** The brief §1.1 lists `sharp` + `heic-convert`.

**Why.** Forkd's runner image already installs `vips` and `libheif`
(`docs/reference/FORKD_INFRA.md`), so `sharp` decodes HEIC with no additional
dependency and no second decode path to maintain. `heic-convert` would be a
redundant pure-JS decoder alongside a native one that already works.

`sharp` genuinely cannot rasterise PDF, so `poppler-utils` is a real addition to
the runner image — the only package Ledgerly adds that Forkd does not have.

**Consequence.** Runner installs `vips`, `libheif`, `poppler-utils`,
`postgresql17-client`, `tar`, `su-exec`. It drops Forkd's `ffmpeg`, `python3`,
and `yt-dlp`, and the `chrome-headless` service entirely.

---

## D-12 — Two-pass Haiku 4.5 -> Sonnet 5 extraction ladder. **Provisional — Phase 6 confirms.**

> **Amendment (first run against a real API key).** Pass 1 failed on every
> upload with `AI_REQUEST_REJECTED`. The cause is a REQUEST-SHAPE
> incompatibility, not a key or a model id:
>
> ```
> 400 invalid_request_error
> "Thinking may not be enabled when tool_choice forces tool use."
> ```
>
> Haiku 4.5 takes the older `thinking: {type:"enabled", budget_tokens:N}` form,
> and that form cannot be combined with `tool_choice: {type:"tool"}`. Sonnet
> 5's `{type:"adaptive"}` can — which is exactly why pass 2 succeeded in
> production while pass 1 never did, and why the symptom looked like a
> credentials problem. `capabilityForModel` now sends **no `thinking` field**
> for Haiku; forced tool use is the property worth keeping, since this
> pipeline needs a `record_receipt` call rather than prose, and reading a
> receipt is perception rather than reasoning. Verified against the live API:
> Haiku with no `thinking` and a forced tool choice returns a correct
> extraction. `anthropicRequest.test.ts` asserts the absence of the field.
>
> **A wrong turn worth recording, because the reasoning was seductive.** The
> first diagnosis was that `claude-haiku-4-5` is not a real model id, on the
> evidence that `GET /v1/models` lists only `claude-haiku-4-5-20251001`. That
> is a real observation and a false conclusion: `/v1/models` enumerates
> concrete snapshots, not aliases, and the bare alias resolves perfectly well
> — confirmed by calling it directly. This decision's "model IDs are exact and
> carry no date suffix" stands. The default was briefly changed and has been
> changed back. The lesson is narrow and repeatable: absence from a listing
> endpoint is not evidence of invalidity, and the probe that would have
> settled it in one call was available the whole time.
>
> **Task 6.3 is answered: strict mode DOES accept `["string","null"]`
> unions.** Confirmed against the live API on both `claude-haiku-4-5` and
> `claude-sonnet-5`. The condition is that `required` must list **every**
> property — strict mode's contract is `additionalProperties: false` plus a
> complete `required`, with optionality expressed by the union, never by
> omission from `required`.
>
> Ledgerly had it the other way round: `required: ["confidence", "items"]`,
> with every other field optional, while `RecordReceiptInput` typed them all
> as `string | null`. The type was a lie at runtime. A model that omitted a
> field produced `undefined`, `normalizeMoney`'s `raw === null` guard did not
> catch it, and `.replace` threw — **after a successful, billed API call**,
> surfacing as the generic `AI_EXTRACTION_FAILED` and burning two more
> attempts. With the complete list, both models now return every key, with
> genuinely-absent values as explicit `null`.
>
> Two fixes, deliberately both: the schema (the cause) and the normalizers,
> which now treat `undefined` exactly like `null` (the safety net). That file
> exists to not trust the model's output shape, so it must hold regardless of
> what the schema says. `schema.test.ts` asserts the completeness as an
> INVARIANT — every declared property is required — rather than by re-listing
> names, so adding a field and forgetting `required` fails in CI.
>
> **The observability gap this exposed.** ARCHITECTURE.md §6.4 says errors
> surfaced to the UI carry "a status and a job id, not a provider message".
> Only half of that was implemented: the provider message was discarded rather
> than logged. The 400 above existed nowhere an operator could reach it — not
> in the logs, not in `ai_usage` (no row is written for a call that never
> returned), not in `extraction_error`. `pipeline/extract.ts` now logs the
> provider's status, error type and message server-side on every failed call,
> and `worker.ts` logs the underlying error whenever the reason falls back to
> the generic `AI_EXTRACTION_FAILED`.

**Context.** The brief §1.6 specifies the ladder. `docs/STATE.md` carried "AI
model default" as open, because Forkd pins `AI_MODEL=claude-opus-4-7`, which is
stale.

**Why the ladder.** Most receipts are legible and extract correctly on the cheap
model; escalating only the ones that fail concrete criteria avoids paying the
expensive model's rate on the majority. The escalation triggers are objective
(null `total`, null `transaction_date`, zero items, self-reported confidence
below threshold), not vibes.

**Corrections to the brief's numbers.**

- The model ID is `claude-haiku-4-5`, not `claude-haiku-4-5-20251001`. Current
  model IDs carry no date suffix.
- **Sonnet 5 is $3.00 / $15.00 per MTok, not $2.00 / $10.00.** The lower figures
  were an introductory rate that expired 2026-08-31, a week before this decision
  was written. Haiku 4.5 is unchanged at $1.00 / $5.00.
- Revised cost: roughly **$0.006 per receipt** on pass 1 alone, roughly **$0.024**
  when it escalates.
- The brief's "if escalation exceeds ~30%, go Sonnet-first" threshold was
  computed against the expired pricing. At the corrected 3x spread the crossover
  is nearer **45%**. The admin view tracks the rate; the threshold is a prompt to
  reconsider, not an automatic switch.

**Why not Opus 5 by default.** Receipt extraction is a bounded, well-specified
vision-extraction task with a strict output schema — the tier where the cheaper
models are reliable. Both passes are env-tunable (`AI_MODEL_PASS1`,
`AI_MODEL_PASS2`), so re-pointing either at `claude-opus-5` is a config change,
not a code change, if Phase 6's accuracy measurement justifies it.

**Request shape differs by model, and this is not optional.** Haiku 4.5 rejects
`output_config.effort` and uses the older `thinking: {type:"enabled",
budget_tokens:N}` form. Sonnet 5 uses `thinking: {type:"adaptive"}` and supports
`effort`. The pipeline builds each request from a per-model capability table
rather than sending one shape to both.

**Structured output.** One tool, `record_receipt`, with `strict: true`,
`additionalProperties: false`, and an explicit `required` list — stronger than
the brief's plain tool-use, because strict mode guarantees the input validates
against the schema and removes the parse-and-repair step. The `category` enum is
generated at call time from the live `categories` table so user-added categories
are selectable (see D-20).

**What makes this Provisional.** Phase 6 must confirm strict mode accepts the
brief's `"type": ["string","null"]` union types. If it does not, the fallback is
non-strict tool use with Zod validation of the tool input, and that outcome is
appended here rather than filed as a new decision. Phase 6 also measures
extraction accuracy over 10 real receipts, which is what settles whether the
pass-1 model is the right one.

**Amendment (Phase 6 implementation session, 2026-09-08): still Provisional
— the confirmation call was never made.** The full pipeline was built —
`packages/queue/src/pipeline/schema.ts`'s `record_receipt` tool with
`strict: true` and `["string","null"]` money/date/time fields exactly as
sketched above, `pipeline/anthropicRequest.ts`'s per-model request-shape
table, the two-pass ladder, the Luhn scrub, sanity checks — and is
unit-tested end to end against a fake Anthropic client. But this session's
`.env` held only a placeholder `ANTHROPIC_API_KEY` (`dev-placehol...`), so
the one live call task 6.3 requires was never actually made. Nothing here
depends on the outcome being one way or the other: `pipeline/extract.ts`
treats the tool-input shape check as a structural gate only (object +
`items` array), not a hard reject-the-whole-response validator, and every
individual field goes through a total, never-throw normalizer in
`normalize.ts` regardless of whether strict mode's own guarantees hold —
so the pipeline degrades gracefully either way, it just isn't yet _known_
which way. Whoever next has a real key: one call with this exact schema
settles it, and task 6.12's 10-receipt accuracy run (also blocked on a
real key, and on the user's own receipt photos) is what settles the
pass-1 model question. See `docs/STATE.md`'s "Blocked / open questions."

---

## D-13 — gitleaks in CI alongside secretlint in pre-commit. **Settled.**

**Context.** Forkd uses secretlint 8 in lint-staged. The brief asks for gitleaks
in CI and as a pre-commit hook. Open decision #3 (public or private repo) was
resolved to **public** in Phase 0, and the repo is already published.

**Why both.** They cover different moments. secretlint in lint-staged blocks a
secret before it becomes a commit — the cheapest possible interception. gitleaks
in CI scans **full history**, which catches anything that got in before the hook
existed or via a path that bypassed it (`git commit --no-verify`, a merge, a
rebase).

**Consequence.** The brief's checklist item "full git history scanned for secrets
before the repo goes public" is past tense — the repo is public already. It
converts to a standing full-history gitleaks job on every CI run, which is
strictly stronger than a one-time gate. Phase 2 wires it; Phase 10 verifies it is
green as a v1.0.0 blocker.

---

## D-14 — Zod env validation at startup. **Settled.**

**Context.** Forkd's `packages/config/src/index.ts` is `export {}`; env vars are
read via bare `process.env` throughout with no startup validation. Both the stack
and the auth analyses flagged this independently (`docs/STATE.md`).

**Why.** Misconfiguration currently surfaces as an unrelated runtime error at
whatever moment the variable is first touched — potentially days later, in
production, as a 500 on one route. A startup schema turns that into a refusal to
boot with a complete list of what is wrong.

**Consequence.** `packages/config/src/env.ts` is a real module: a Zod schema
covering every variable, parsed once at import, throwing with the full error list
on failure. It is also where cross-field invariants live (D-05, the `MASTER_KEY`
length check, the production requirement for `CF_ACCESS_AUD` and
`CF_ACCESS_TEAM_DOMAIN`). Only an explicitly whitelisted public subset is
re-exported to the client.

---

## D-15 — Deep healthcheck. **Settled.**

**Context.** Forkd's `/api/v1/health` returns `{status:"ok"}` without touching
the database, so a container reports healthy while every query fails
(`docs/STATE.md`).

**Why.** A healthcheck that cannot fail is not a healthcheck. Its entire purpose
is to let Docker restart a container that is up but not working.

**Consequence.** The endpoint runs `SELECT 1` against the pool and pings Redis,
returning 503 if either fails. It stays exempt from the auth middleware. The
route returns no version, no hostname, and no error detail — a 503 with a
generic body, because it is the one endpoint reachable without authentication.

---

## D-16 — `APP_PORT` and `APP_HOSTNAME`. **Settled.**

**Context.** Forkd uses `PORT` and `AUTH_URL`. `CLAUDE.md` states as a hard
convention that port and hostname come from `APP_PORT` and `APP_HOSTNAME` and
are never hardcoded.

**Why.** `CLAUDE.md` is the governing document for this repo and states it as a
rule, not a preference. `APP_PORT` is also less likely to collide with a
platform-injected `PORT`, and `APP_HOSTNAME` names the thing it holds, where
`AUTH_URL` is a leftover from Better Auth — which Ledgerly does not use (D-03).

**Consequence.** `.env`, `docker-compose.yml`, and the Dockerfile all use
`APP_PORT`. Changing it still requires updating the tunnel's ingress `service:`
URL in `/etc/cloudflared/config.yml`, which `DEPLOYMENT.md` calls out — that
coupling is a property of the tunnel, not of the naming.

---

## D-17 — Multi-currency: column present, UI deferred. **Settled.**

**Context.** Open decision #4 in the brief.

**Why.** `receipts.currency` costs nothing to carry and everything to add later
once rows exist without it. A picker, per-currency formatting, and mixed-currency
project totals are real work with no current use.

**Consequence.** `receipts.currency` is `char(3)` not null, defaulting from
`DEFAULT_CURRENCY` (USD). No UI in v1. Project totals sum without regard to
currency, which is correct while every row shares one. If a second currency ever
appears, the dashboard must be revisited before the totals mean anything — noted
in `docs/SCHEMA.md`.

---

## D-18 — Isolated test database. **Settled.**

**Context.** Forkd's tests run against `DATABASE_URL`, shared with dev, with no
isolation and no rollback (`docs/reference/FORKD_STACK.md` §5,
`docs/STATE.md`).

**Why.** Tests that mutate the dev database are tests people stop running. Worse,
they pass or fail depending on data left by the last run.

**Consequence.** CI runs a throwaway `postgres:17` service container. Locally,
`TEST_DATABASE_URL` points at a separate `ledgerly_test` database. Each test that
touches the database runs inside a transaction that is rolled back in teardown.
Phase 2 establishes the harness before there is anything to test, so no test is
ever written against the other pattern.

---

## D-19 — Rewrite the receipt pipeline; port only its scaffolding. **Settled.**

**Context.** `docs/STATE.md` carried this as open. Forkd already has a receipt
pipeline: `packages/queue/src/receiptWorker.ts` plus `pipeline/`, BullMQ-driven,
using `@anthropic-ai/sdk`. Ledgerly is specialising an existing pipeline rather
than starting from nothing.

**Why split it.** The scaffolding and the pipeline have different amounts in
common with Forkd. The scaffolding — `queue.ts`, `redis.ts` (URL parsing),
`worker.ts`, the BullMQ connection options, backoff configuration, graceful
shutdown — is generic and battle-tested, so it ports essentially verbatim.

The pipeline body has almost nothing in common. Forkd extracts a restaurant bill
to split among people. Ledgerly extracts a receipt for tax reporting: every field
nullable, unreadable fields collected into `missing_fields[]`, line items with
per-item categories drawn from a live enum, a Luhn scrub before persistence, four
arithmetic sanity checks, and a two-model escalation ladder. Adapting Forkd's
body to that contract means replacing all of it while carrying its assumptions
forward, which is more work than writing it against the contract directly and
carries the risk of inheriting a behaviour nobody chose.

**Consequence.** `packages/queue/src/{queue,redis,worker}.ts` follow Forkd's
shapes closely. `packages/queue/src/pipeline/extract.ts` is new. Phase 6 does not
read the Forkd repo to do this — `docs/reference/` is the standing substitute
(`CLAUDE.md`).

---

## D-20 — Categories: seeded global list, user-extensible, instance-wide. **Settled** (user decision).

**Context.** The brief requires per-item categories usable for filtering and
export, and specifies the taxonomy is instance-wide, not per-project, with 13
seeded values. The alternatives were a fixed list with no additions, or
per-project taxonomies.

**Why.** A fixed list is wrong the first time a project does not fit it.
Per-project taxonomies break exactly the thing categories exist for: filtering
and cross-project reporting cannot aggregate when "Lumber" in one project is
unrelated to "Lumber" in another.

**Consequence.** The 13 seeded categories are `is_system = true` and cannot be
deleted or renamed, so an export's meaning is stable over time. Users may add
categories, which are also instance-wide. The extraction tool schema's `category`
enum is generated at call time from the live table, so a category added today is
selectable by the model tomorrow — this is why the enum cannot be a compile-time
constant. Deleting a user category requires reassigning its items first; the
schema uses `ON DELETE RESTRICT` to make that a database guarantee rather than an
application convention.

---

## D-21 — Money is `numeric(12,2)`, never a float. **Settled.**

**Context.** The brief's schema sketch does not name types for `subtotal`,
`sales_tax`, `tip`, `total`, `unit_price`, or `line_total`. The `reviewer` agent
checks explicitly for float rounding in money handling.

**Why.** IEEE-754 cannot represent 0.10 exactly. A `double precision` column
turns the brief's own sanity check — `|subtotal + sales_tax - total| > 0.02` —
into a test that fails on correct data. This is a tax record; the arithmetic has
to be exact.

**Consequence.** All money columns are `numeric(12,2)`. Drizzle reads `numeric`
as a **string**, which is the desired behaviour: the application layer converts
to integer cents for all arithmetic and formats back exactly once, at the display
or export boundary. `docs/SCHEMA.md` states this, and a `packages/shared/money.ts`
helper is the only place the conversion is written. Phase 4 adds a unit test that
`19.99 + 0.01` reconciles.

---

## D-22 — Soft deletes use partial unique indexes. **Settled.**

**Context.** `docs/reference/FORKD_LESSONS.md` documents a production crash:
a full-table `UNIQUE` constraint plus a `deleted_at` soft-delete column means a
re-insert collides with a row the user believes is gone.

**Why.** The constraint should express "unique among live rows", which is what a
partial index says and what a full-table constraint does not.

**Consequence.** Every uniqueness rule on a soft-deleted table is written
`CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL`, and every duplicate-detection
query filters `deleted_at IS NULL` so it never short-circuits on deleted history.
`docs/SCHEMA.md` marks each one.

---

## D-23 — Storage paths are UUID-derived; images are never static. **Settled.**

**Context.** The brief §1.5 requires UUID-derived filenames and authenticated
image serving. The `reviewer` agent checks both.

**Why.** Path traversal is not a validation problem if no user-supplied string
ever reaches the filesystem — it becomes unrepresentable rather than guarded.
Serving images as static files would make every receipt photo readable by anyone
who learns a URL, defeating the entire permission model.

**Consequence.** `${UPLOADS_DIR}/<project_id>/<receipt_id>/{display,thumb,original}.<ext>`,
every segment a server-generated UUID. `UPLOADS_DIR` is a named volume outside
`public/`. `/api/images/[...key]` resolves the receipt, composes with
`scopedProjects(user)`, and returns **404** rather than 403 on a permission
failure, so the endpoint is not an existence oracle for other users' receipts.

---

## D-24 — The edge middleware is a perimeter, not a trust boundary. **Settled.**

**Context.** `ARCHITECTURE.md` §3.1 step 5 reads "attach identity to the
request; continue". The obvious implementation is an `x-ledgerly-sub` header
set by `proxy.ts` via `NextResponse.next({ request: { headers } })` and trusted
by the Node layer. Phase 3's design pass rejected it.

**Why.** That implementation makes the middleware `matcher` a security
control. Any path the matcher fails to cover — a new route group, a Next.js
upgrade that changes matcher semantics, an `/api/` prefix somebody adds — is a
path where an attacker who can reach the origin sets `x-ledgerly-sub` and is
authenticated as anyone. Matcher gaps are the most common Next.js
authentication defect, and D-03 was taken specifically to stop relying on
"remembered exceptions" of this kind.

The second verification costs one in-memory JWKS lookup and one RSA signature
check. D-03 already priced and accepted exactly that cost for exactly this
reason.

**Consequence.** Nothing is attached to the request. `proxy.ts` verifies the
JWT and either rejects or calls `next()`. `resolveIdentity()` in the Node layer
reads `Cf-Access-Jwt-Assertion` from the raw headers and verifies it again,
independently. That is the only trust boundary in the application.

A matcher gap becomes a performance regression rather than an auth bypass.
`verifyAccessJwt` becomes a pure function over `(token, keySet)`, unit-testable
in plain Node with no Edge Runtime shim and no HTTP mocking. Verified by
`grep -rn 'x-ledgerly-sub\|x-user-id' apps/web/src` returning nothing.

---

## D-25 — `aud`, `iss`, and `alg` are pinned, and asserted twice. **Settled.**

**Context.** Forkd calls `jwtVerify(token, jwks, { audience: process.env.CF_ACCESS_AUD, issuer: ... })`
(`docs/reference/FORKD_AUTH.md` §1). `jose` **skips audience validation
entirely when `audience` is `undefined`.**

**Why.** An unset or empty `CF_ACCESS_AUD` therefore converts "reject hard on
`aud` mismatch" into "accept any valid Cloudflare Access token from any
application on the team" — with no error, no log line, and a green test suite.
It is the highest-consequence failure available in this phase and it is silent,
which is the combination that makes it worth redundant checking. `CLAUDE.md`'s
requirement is a hard reject; a check that can be disabled by a missing
variable does not implement it.

**Consequence.** Three layers, in `packages/auth/src/cloudflareAccess.ts`:

1. **Precondition.** An absent `CF_ACCESS_AUD` or `CF_ACCESS_TEAM_DOMAIN`
   returns `not_configured` and refuses to verify. It never falls through to
   `jwtVerify`.
2. **`jose`.** `algorithms: ['RS256']`, `audience`, `issuer`,
   `requiredClaims: ['sub','exp','iat','aud','iss']`, and an explicit
   `clockTolerance: 60`. `requiredClaims` makes a token with no `exp` a
   rejection rather than a token that never expires. `nbf` is deliberately not
   required — `jose` validates it when present, and Cloudflare does not always
   emit it. `clockTolerance` is set rather than inherited because
   `FORKD_AUTH.md` §3's claim of a 60-second `jose` default is unverified and
   has differed across major versions.
3. **Redundant assertion.** After `jwtVerify` returns, `alg`, `aud`, and `iss`
   are compared again against the configured values. `aud` is handled as
   `string | string[]` — Cloudflare emits an array, so a naive `!==` rejects
   every real token and a naive `includes` on a string matches a substring.

`packages/config` additionally constrains `CF_ACCESS_AUD` to
`/^[0-9a-f]{64}$/`, so a placeholder or empty value fails at startup rather
than at verification time.

The cost is a handful of comparisons on a path that already does RSA. The
benefit is that no single future refactor of how config is assembled can
silently disable the check the entire authentication model rests on.

---

## D-26 — A missing or empty `sub` rejects the token. **Settled.**

**Context.** Forkd stores `sub: payload.sub ?? ""` (`FORKD_AUTH.md` §3). Under
Forkd this is harmless: `sub` is decorative and email is the join key.

**Why.** Under D-06 `sub` **is** the identity and carries
`users_cf_access_sub_key`, a unique index. An empty-string `sub` would insert
one user row and then match every subsequent subject-less token, collapsing all
of them into a single shared account. Cloudflare **service tokens** have
exactly this shape: `sub` is `""` and the identity is carried in
`common_name`.

**Consequence.** `verifyAccessJwt` returns `empty_subject` when `sub` is
absent, non-string, or empty after trimming. `?? ''` appears nowhere in
`packages/auth`. This also rejects service tokens, which is correct — Ledgerly
has no machine-access surface — and is documented so it is not later "fixed"
as a bug.

The same rule applies to `email`: absent or empty returns `missing_email`,
because `users.email` is `NOT NULL`.

---

## D-27 — Email refresh is best-effort; `ACCESS_ALLOW_SUB_RELINK` recovers an IdP migration. **Settled** (user decision).

**Context.** `users_email_lower_key` is `UNIQUE (lower(email))` and D-06 keys
identity on `sub`. That pairing creates a failure Forkd cannot reach, because
Forkd keys on email and so cannot hold two rows in conflict.

**Case A — refresh collision.** An existing user's IdP email changes to one
another row already holds; the per-visit refresh `UPDATE` raises `23505`.

**Case B — the instance-wide lockout.** The operator changes the Cloudflare
Access identity provider. Every returning user presents a **new `sub` with
their existing email**, so every provisioning `INSERT` collides. Everyone is
locked out, _including the instance owner_ — which means task 3.7's owner-only
re-link action, recorded in D-06 as the mitigation for precisely this scenario,
cannot be reached to perform it. D-06's mitigation does not survive its own
motivating case.

**Why this resolution.** Case A must never fail a request: `sub` is unchanged,
the user is authenticated, and the collision concerns a display attribute.
Locking someone out over their display email is a worse outcome than a stale
one.

Case B needs a recovery path that does not require the app to be reachable by
someone who is locked out of it. Auto-relinking on email match unconditionally
would defeat D-06 outright — it restores email as a join key, so any IdP that
lets a user assert an unverified address could take over an account. Documented
recovery SQL avoids new code but means hand-editing the identity table under
outage pressure, applying the same email-matching trust by hand and untested.

Gating the behaviour on an explicit, default-off, deliberately-temporary flag
keeps D-06's guarantee intact in the steady state and makes the dangerous path
a supported, audited, tested operation rather than an improvisation.

**Consequence.**

- **Case A:** catch `23505`, keep the stale email, set `emailRefreshSkipped`,
  log once at WARN with both `sub` values and neither address, and continue.
- **Case B, flag off (the default):** the collision is caught and classified
  `identity_conflict` — a clean `ACCESS_DENIED_RESPONSE` plus an `audit_log`
  row. Never an unhandled `23505` returning a 500 with a Postgres constraint
  name in the body.
- **Case B, `ACCESS_ALLOW_SUB_RELINK=true`:** a new `sub` whose email matches
  exactly one existing row is reassigned onto that row. Every reassignment
  writes `audit_log` with both the old and the new `sub`. A match against more
  than one row is impossible under the unique index; a match against zero rows
  provisions normally.
- `packages/config` logs at WARN on every boot while the flag is true, so it is
  not left on by accident after a migration.
- `.env.example` documents it as "off except during a deliberate identity-
  provider migration", and `SETUP.md` carries the procedure.

**Consequence, accepted.** While the flag is on, email is temporarily a join
key and D-06's guarantee is suspended. That is the point of it being a flag,
default false, WARN-logged at startup, and audited per write.

---

## D-28 — `protectedProcedure` implies onboarded. **Settled.**

**Context.** The onboarding gate must block every route until `first_name` and
`last_name` are set. The natural shape is a `requireOnboarded` middleware
composed onto the procedures that need it.

**Why the inverse.** An opt-in check fails **open** when omitted, and omission
is the failure that actually occurs — a new router is added, the extra
middleware is not. A default-deny ladder fails closed: forgetting to think
about onboarding yields a blocked route, which is noticed immediately in
development, rather than an open one, which is noticed by nobody.

**Consequence.** The ladder is `publicProcedure` -> `protectedProcedure`
(identity **and** onboarded) -> `ownerProcedure`, with `onboardingProcedure`
as the explicit, deliberately-awkward opt-out holding exactly two members:
`auth.me` and `auth.completeOnboarding`. Adding a third is a review trigger.

For pages, the gate is `apps/web/src/app/(app)/layout.tsx`, and `/welcome`
lives **outside** the `(app)` route group rather than being exempted from
within it. There is no exemption list to maintain — the structural placement is
the exemption. This is deliberately unlike Forkd's sync route, which had to be
exempted from its own cookie check, a security-critical exception that then had
to be remembered forever (D-03).

`PHASES.md` task 3.8 lists `apps/web/src/proxy.ts` as a file for this task.
It cannot be: the gate reads `users.onboarded_at`, middleware runs on the Edge
Runtime, and `pg` does not. `ARCHITECTURE.md` §3.1 already places the gate in
the Node layer after `resolveIdentity()`; that is the correct reading.

`onboarded_at` is written in the same statement as `first_name` and
`last_name`, so the two representations of "onboarded" cannot disagree.

---

## D-29 — JWKS cache TTL, cooldown, and fetch timeout are explicit. **Settled.**

**Context.** Forkd passes no options to `createRemoteJWKSet` and relies on
`jose`'s internal caching; `FORKD_AUTH.md` §2 records the TTL as "not
explicitly configured... approximately 1 hour", inferred rather than set.

**Why.** Under D-03 the JWKS lookup is on the path of **every request**, not
only new logins, so its failure modes matter more here than they did in Forkd.
`timeoutDuration` is the one that bites: without it, a JWKS endpoint that
accepts a connection and then stalls holds every request open until something
else times out. An inferred default is also not a default that a `jose` minor
release is obliged to keep.

**Consequence.** `cacheMaxAge` from `CF_ACCESS_JWKS_TTL_MS` (default
3_600_000), `cooldownDuration: 30_000`, `timeoutDuration: 5_000`. The key set
is a lazy singleton so module import does not depend on env being parsed, and
it is passed to `verifyAccessJwt` as a parameter rather than reached through a
module-level mutable seam — which is what makes the verifier unit-testable
without network access or a test-only export.

**Explicitly not added:** a last-known-good fallback layer. D-03 assessed and
accepted JWKS unavailability as a lockout risk; caching stale keys past their
TTL would quietly weaken revocation to buy back availability that decision said
it did not need.

---

## D-30 — The Access middleware file is `middleware.ts`, not `proxy.ts`. **Settled.**

**Context.** `ARCHITECTURE.md` §2, `docs/PHASES.md` task 3.6, and
`docs/reference/FORKD_AUTH.md` all name this file `apps/web/src/proxy.ts` —
Forkd's name for it, carried across during Phase 1.

**Why it had to change.** Ledgerly is on Next.js 15.5.25, where the only
recognised filename is `middleware`. There is no `PROXY_FILENAME` constant
in that release; `proxy.ts` is the Next 16 rename. A file named `proxy.ts`
is not an error and not a warning — it is simply never registered.

That failure mode is the reason this gets its own decision rather than a
silent rename. With `proxy.ts`, `pnpm build` succeeded, typecheck passed,
lint passed, every unit test passed, and
`.next/server/middleware-manifest.json` was empty: **the Cloudflare Access
perimeter did not exist and nothing said so.** A middleware that is not
wired up fails open and is indistinguishable from one that is, unless you
go looking at the manifest.

**Consequence.** The file is `apps/web/src/middleware.ts` with a default
export. Registration is verified by asserting
`.next/server/middleware-manifest.json` contains the matcher, and by the
live probe that an unauthenticated request to a gated route returns 403 —
not by the build succeeding, which proves nothing here.

`ARCHITECTURE.md` §2's module layout still reads `proxy.ts` and should be
corrected when that document is next revised. The framework decides this
one, so the code is right and the document is stale.

**Consequence, deferred.** When Ledgerly moves to Next 16, `middleware.ts`
is deprecated in favour of `proxy.ts` and this decision reverses. The
manifest assertion is what will catch it either way.

---

## D-31 — Ledgerly's accent is teal; the other three themes are Forkd's. **Settled** (user decision).

**Context.** Phase 7 had to decide how literally to copy Forkd's palette. The
brief asked for "a sibling app, not a cousin".

**Why.** Copying the whole design system — spacing, type scale, component
vocabulary, the five-theme mechanism, the content1–4 ramps — is what makes the
two apps feel related. Copying the _brand colour_ as well would make them
indistinguishable in an app switcher, which is a real cost on a phone where
both are installed.

**Consequence.** `dark` and `light` carry a muted teal (`#2f7d80`) at the same
lightness progression as Forkd's `#3d7a52` green. `midnight`, `amber` and
`plum` are ported verbatim — they are _named_ for their accents, so changing
those would be pointless. Theme labels become "Ledgerly Dark" / "Ledgerly
Light"; the other three keep their names. `apps/web/hero.ts` holds the ramps.

---

## D-32 — The HeroUI theme lives in `hero.ts`, not `tailwind.config.js`. **Settled.**

**Context.** `docs/PHASES.md` task 7.1 names `apps/web/tailwind.config.js`.

**Why.** Tailwind 4 has no JavaScript config file. A theme plugin is loaded
from CSS with `@plugin`, and the plugin is an ordinary module.

**Consequence.** `apps/web/hero.ts` default-exports `heroui({...})` and
`apps/web/src/app/globals.css` loads it with `@plugin "../../hero.ts"`.
`@heroui/theme` is an explicit devDependency of `apps/web` — it is otherwise
nested under `@heroui/react` and unreachable, so both the import and the
`@source` glob would fail to resolve under pnpm. PHASES.md's file name is
stale; the framework decides this one.

---

## D-33 — Category permissions, and `users.list` enumerates the instance. **Settled** (user decision).

**Context.** `docs/SCHEMA.md`'s permission matrix has no column for
categories, and nothing in the API could turn a person into the `userId` that
`members.add` requires — so member management was unreachable from a UI.

**Why (categories).** D-20 makes the taxonomy instance-wide and
user-extensible, so _creating_ one must be open to any onboarded user; a bad
category is cosmetic and soft-delete-recoverable. _Renaming or deleting_ one
changes every historical report and every past export for everyone, which is
not something one user should be able to do to another's data.

**Why (`users.list`).** A member picker needs a directory. The alternative —
typing an exact email — is worse to use and no more private in practice among
people who already share projects.

**Consequence.** categories: `list`/`create` for any onboarded user;
`update`/`delete` for the row's `created_by` or the instance owner; `is_system`
rows for nobody, ever. `users.list` returns every onboarded user's id, name and
email to any caller holding `manage` on at least one project — **an accepted
disclosure, recorded here rather than left implicit.** It returns no `role`,
`cf_access_sub`, `theme` or `last_seen_at`. Its gate reads the caller's role
live from the database and also admits the instance owner outright, because
`scopedProjects` is empty on an instance with no projects yet — a pure
"do you manage anything" gate would hand the owner an empty picker at exactly
the moment they are setting the instance up.

---

## D-34 — Playwright returns, as a devDependency only. **Settled** (user decision).

**Context.** `ARCHITECTURE.md` §1 lists `playwright-core` as "not adopted from
Forkd", and D-07's consequence notes "Ledgerly has no Playwright". But
`docs/PHASES.md` tasks 7.11 and 7.12 both name Playwright WebKit as their
acceptance mechanism.

**Why the old rule does not apply.** What Forkd's Playwright actually broke was
Next's standalone **file tracing** — a large dynamically-imported library
missing from the production bundle. That is a runtime-image concern. A
devDependency used by CI is never traced into the container and cannot
reproduce it.

**Why it is worth having.** `FORKD_LESSONS.md` records three bugs that appeared
only on iOS and were missed by unit tests and by Chrome's device emulator.
Phase 7's suite found four more in its first run: HeroUI's `text-small` beating
the `max(16px, 1em)` iOS-zoom rule (every input zoomed on focus), project cards
rendered as `div role="button"` rather than anchors, the review queue rendering
no heading while loading or erroring, and a modal left invisible at
`opacity: 0`. None were visible to a unit test.

**Consequence.** `@playwright/test` is a devDependency of `apps/web`; **WebKit
only**, installed in its own CI job. It runs against `next dev`, because
`DEV_AUTH_BYPASS` is refused under `NODE_ENV=production` (D-05) and that
refusal is exactly the guarantee that makes the bypass safe. Dev-mode
compilation is slow, so the suite warms every route in setup and runs with
generous timeouts. The runtime image still has no browser, and
`docker/Dockerfile` is unchanged.

---

## D-35 — HeroUI's overlay animations are disabled. **Settled.**

**Context.** With HeroUI 2.8 and React 19, an opened `Modal` never played its
enter transition. framer-motion left the wrapper holding the **exit** variant
as an inline style — `opacity: 0` plus a translate — so the dialog was mounted,
focus-trapping the page, hit-testable, and completely invisible. The
create-project dialog could not be seen at all.

**Why not just upgrade or downgrade.** Reproduced on framer-motion 11.18 and
12.43, in Chrome and in WebKit, with React Strict Mode both on and off. It is
not a dev-only artifact and `disableAnimation` alone did not clear it.

**Consequence.** `HeroUIProvider` sets `disableAnimation`, each `Modal` sets it
too, and `globals.css` carries the rule that actually fixes it:

```css
[data-slot="wrapper"]:has(> [role="dialog"]) {
  opacity: 1 !important;
  transform: none !important;
}
```

`!important` is doing real work — it is overriding an inline style set by
JavaScript, which nothing else outranks. `:has()` scopes it to wrappers that
actually contain a dialog, because `data-slot="wrapper"` is a generic HeroUI
hook. Losing the fade is the intended trade: this app runs on a phone over a
tunnel. Revisit if a later HeroUI release fixes the animation.

---

## D-36 — `receipts.dismissed_fields`. **Settled.**

**Context.** The brief's receipt detail screen asks that a missing field can be
"filled in or dismissed", where dismissing "marks the field intentionally blank
so the badge clears".

**Why a column.** Every extraction run recomputes `missing_fields` from
scratch. Without a record of what the user deliberately blanked, the next
automatic retry resurrects a badge they already dealt with — and "re-extract"
is a button on the same screen as "dismiss". The user clears it, and it comes
back.

**Consequence.** `receipts.dismissed_fields text[] NOT NULL DEFAULT '{}'`
(migration 0003, a metadata-only `ADD COLUMN`).
`pipeline/extract.ts` subtracts it when writing `missing_fields`. A **manual**
re-extract clears it, because explicitly asking the model to read the receipt
again is a request for a fresh opinion rather than a re-application of stale
assertions. Filling a dismissed field also clears its dismissal. The review
predicate stays `missing_fields <> '{}' OR extraction_status <> 'ok'`, with no
set-difference in it, so `receipts_needs_review_idx` remains a plain partial
index the planner can match.

---

## D-37 — Export streams from a Route Handler; the `export` queue stays unbuilt. **Settled** (user decision).

**Context.** `docs/PHASES.md` task 8.1 specifies XLSX "generated as an `export`
queue job for large projects", and D-08 reserves `export` as one of three
BullMQ queues. Phase 8's own brief, however, asks for the response to be
streamed and for the workbook never to be built in memory. Those pull in
opposite directions: a queue job writes a file and hands back an id, which is
the opposite of streaming a response.

**Why the route.** The queue design needs machinery Phase 8 has no other use
for — an `exports` table to authorize a download against, an artifact
directory, a retention sweep to stop it filling the disk, a reconciliation
sweep at worker startup, and a polling UI. That is a phase's worth of surface
to solve a problem this instance does not have: a 2,000-item project streams
in a couple of seconds, and the work is I/O-bound, so it never blocks the event
loop in any meaningful sense. `packages/api/src/export/` streams with bounded
memory instead (see the one-pass note below), which satisfies task 8.1's actual
concern — not building the workbook in memory — without any of it.

**Consequence.** `GET /api/projects/[id]/export?format=xlsx|csv`, a Route
Handler for the same reason upload and image serving are: tRPC speaks JSON over
superjson and cannot stream a binary body. The code lives in
`packages/api/src/export/`, **not** `packages/queue/src/pipeline/export.ts` as
`docs/PHASES.md` names it — with no job, `apps/web` cannot reach
`@ledgerly/queue`, and `queue` already depends on `api`, so `api` is the only
package it can live in.

**Consequence.** The `export` queue named in D-08 remains reserved and
unbuilt. Two queues exist, not three. If a project ever grows large enough that
a synchronous export is genuinely painful, the job version is still the right
answer and this decision is the place to revisit.

**Consequence, accepted.** The export holds no long-lived transaction, so it
reads the receipt table across several keyset pages rather than from one
snapshot. Keyset pagination cannot duplicate or skip a row under concurrent
inserts or deletes; the only way to move a row out from under the loop is to
edit a not-yet-read receipt's `transaction_date` mid-export. Pinning a pool
connection open for the whole duration of a client's download — which is what a
REPEATABLE READ transaction would mean — is the worse trade on a single-user
instance.

**Consequence.** The export relies on **write-time** Luhn scrubbing rather than
scrubbing on the way out. Every path that writes free text scrubs it —
`receipts.update`, `receiptItems.create`/`update`, and the extraction pipeline
before persistence — and `card_last4` is `char(4)` with a digits-only CHECK, so
the database is the boundary. Worth knowing because it means a future write path
that skips the scrub is not just a storage bug, it is an export leak.

**Consequence.** The download is a `GET`, so a third-party page can trigger one
cross-site with the Access cookie attached. Nothing reaches the attacker (no
CORS headers, and the response is an attachment), but an `export.generated`
audit row should be read as "an export was requested by this identity", not as
proof the user intended one. A per-user rate limit
(`EXPORT_RATE_LIMIT_PER_MIN`) bounds the cost, and `request.signal` stops the
paging loop when the client goes away.

**Consequence.** Both sheets and the summary are produced in ONE pass over the
data. Line items stream and are committed row by row; the eleven receipt-grain
scalars per receipt are buffered, capped by `MAX_EXPORT_RECEIPTS` (50,000, over
which the request is a 413). That is what makes the two sheets reconcile by
construction rather than by luck — a two-pass implementation reads two
different snapshots and can disagree, and "the totals reconcile" is Phase 8's
entire gate.

---

## D-38 — `card_last4` is written as `="0042"` in CSV. **Settled.**

**Context.** `receipts.card_last4` is `char(4)` with a digits-only CHECK, so
`"0042"` is a value the database holds and an export must preserve. Task 8.4's
acceptance criterion is "CSV opens in Excel with no mangled dates or lost
leading zeros on `card_last4`". Excel strips the leading zero from a bare
`0042` on a double-click open, and — the part that is easy to get wrong —
**also** from a quoted `"0042"`.

**Why.** `="0042"` is the only form that survives that path with the zero
intact. Since the acceptance criterion names Excel, and opening the file in
Excel is what a user of this app will actually do, Excel wins.

**Consequence, accepted.** A non-Excel reader — pandas, `csv.reader`, a
database import — sees the literal text `="0042"` rather than `0042`, and has
to strip it. This is recorded rather than left as a surprise. The XLSX path has
no such problem — the cell is a real string with `numFmt: "@"` and needs no
trick.

**Amendment (Phase 8 security review, H-1).** The observation this decision
rests on — that Excel re-parses the contents of a quoted CSV field — has a
second consequence that the first draft of this entry got wrong. It originally
claimed the escape was "confined to `card_last4` … so nothing else in the file
carries it". That was true and was the bug: **every other free-text column was
being written unescaped**, so a value beginning `=`, `+`, `-` or `@` was
evaluated as a formula on open. `merchant` is the sharp case, because a merchant
line is read off a photograph by the model and stored unconstrained — a receipt
printed with `=cmd|'/c calc'!A0` on it reached the spreadsheet verbatim. Quoting
was not a mitigation, for exactly the reason this decision exists.

Free-text cells whose first character is `=`, `+`, `-`, `@`, tab or CR are now
prefixed with a single apostrophe (the OWASP mitigation), which every
spreadsheet reads as "the rest of this cell is text". The `="…"` form is
deliberately **not** reused for them: an Excel string literal caps at 255
characters and `item_description`/`receipt_notes` are `text` columns that
routinely exceed it. The cost is a possibly-visible apostrophe on the handful
of cells that need one. The XLSX path was verified unaffected — ExcelJS types a
JS string as `Cell.Types.String` unconditionally, and a formula requires an
explicit `{formula: …}`.

---

## D-39 — The Anthropic API key is settable from the admin screen, and `ANTHROPIC_API_KEY` becomes optional. **Settled** (user decision).

**Context.** The key was environment-only: `packages/config` required it, and
`packages/queue/src/worker.ts` built one `Anthropic` client from it at worker
startup. Changing it meant editing `.env` and recreating the container. The
user asked for it to be settable from the admin page.

**Why `app_config`.** The table already existed for exactly this — encrypted
key-value settings keyed with `MASTER_KEY` (`docs/SCHEMA.md` §app_config) —
and had never been written to. `packages/api/src/secrets.ts` is the first
writer: AES-256-GCM, `version || iv || tag || ciphertext`, a fresh random IV
per write. GCM rather than CBC because it is authenticated: a tampered row
fails to decrypt rather than yielding attacker-influenced plaintext that is
then used as an API key. The property `docs/SCHEMA.md` promises — a stolen
`pg_dump` yields ciphertext and nothing else, because `MASTER_KEY` is backed
up out-of-band — is asserted directly in `secrets.test.ts`.

**Resolution order: `app_config` -> env -> nothing.** The stored value wins.
An operator who types a key into the screen and watches the environment
silently override it has no way to diagnose that; the reverse — environment as
a bootstrap default the UI can supersede — is explainable, and it is what makes
the screen useful on an instance that already has an env key.

**Consequence, and the part that is a real narrowing of an earlier decision.**
`ANTHROPIC_API_KEY` is no longer required, because a fresh instance has to be
able to boot with no key at all or the screen that sets one is unreachable.
That weakens D-14's "refuse to boot on a missing required variable" for this
one variable. Accepted deliberately, and compensated with three visible
signals in place of one fatal one: a WARN at every boot when the environment
variable is empty, a "Not configured" banner on the admin screen, and a
non-retryable job failure with the reason code `ANTHROPIC_KEY_NOT_CONFIGURED`
that leaves the receipt in the review queue with its images intact. Every other
required variable keeps the old behaviour — this is a carve-out, not a change
of policy.

**Consequence.** The worker resolves the key **per job** rather than once at
startup, caching the `Anthropic` client keyed on the resolved secret so a key
change drops the old client instead of accumulating one. Without this, a key
saved from the UI would not take effect until the container was recreated, and
the symptom would be "I saved the key and extraction still fails" with a
restart as the undocumented fix. The cost is one indexed row read plus a
decrypt per receipt.

**Consequence.** The key is write-only over the API. `admin.aiKey` returns a
type with no field capable of holding a secret (`AiKeyDescription`), so no
future edit can leak one through it by accident; the only representation a
user ever sees is the last four characters and a length. The audit rows
(`app_config.updated`, `app_config.cleared`) name the config key and never its
value — not even the hint, since hints accumulated across many rows are a slow
leak.

**Consequence, accepted.** `packages/queue` now imports `@ledgerly/api/aiKey`.
That direction is already the established one (`queue` depends on `api`,
ARCHITECTURE.md §2.1) and introduces no cycle.

**Consequence — `undecryptable` is a fourth state, not an error.** Rotate
`MASTER_KEY`, or restore a `pg_dump` onto an instance holding a different one,
and the stored row is ciphertext nobody can read. Three rules follow, all found
by the review of this change:

- It does **not** fall back to the environment key. Quietly extracting with a
  different key would bury the fact that `MASTER_KEY` is wrong for this
  database, and the next thing the operator would notice is an empty
  `app_config` after some later restore.
- The admin screen must still render its Save and Clear controls when the
  status read fails, because it is the only screen that can fix the row.
  Neither mutation reads the row, so both work on ciphertext.
- It gets its own reason code, `ANTHROPIC_KEY_UNDECRYPTABLE`, distinct from
  `ANTHROPIC_KEY_NOT_CONFIGURED` — "restore the right MASTER_KEY or clear the
  row" is nothing like "go and set a key".

**Consequence — setting a key re-extracts the backlog.** D-39's own headline
scenario is: boot a fresh instance, upload receipts, then set the key. Those
receipts are `failed`, and the worker's startup reconciliation sweep only
looks at `pending`, so without this they would stay failed forever and have to
be re-extracted by hand. `admin.setAiKey` (and a `clearAiKey` that falls back
to a working env key) resets every live receipt whose `extraction_error` is one
of the two key-blocked codes to `pending` and re-enqueues it. Best-effort: the
queue is an optional context capability, and a Redis failure must not fail the
key change, so the receipts are left `pending` for the boot sweep either way.

---

## D-40 — The app icon is a committed source image, not drawn in code. **Settled** (user decision).

**Context.** Task 7.9's icons were generated from an inline SVG in
`scripts/generate-icons.ts`, so the mark existed only as code. The user
supplied a rendered PNG.

**Why a source file.** `apps/web/assets/icon-source.png` is now the single
source of truth and every raster output is derived from it, so replacing the
brand mark is a one-file swap plus `pnpm --filter @ledgerly/web icons` — no
code edit. The generator keeps producing every output, so the filenames and
the iOS splash `<link>` media queries still cannot drift from each other.

**Consequence — three corrections the generator applies, none of them
cosmetic.** The supplied art is a rounded tile on a transparent field, and
each platform mishandles that differently:

1. **iOS paints black behind transparency.** `apple-icon.png` is flattened
   onto the tile colour and fills its whole square; iOS applies its own corner
   mask. A transparent-cornered apple-touch-icon installs with black corners.
2. **Android crops maskable icons to a circle** inscribed in the middle 80%.
   `icon-maskable.png` is flattened and inset 10%, or the launcher clips the
   design's scan-bracket corners off.
3. **The tile was neither square nor centred** in the source canvas
   (1134x1116 at an asymmetric offset within 1254x1254). The generator measures
   the alpha bounding box and re-centres on a square, rather than hardcoding a
   crop, so a future replacement with different padding still lands centred.
   `sharp`'s `.trim()` is not used: it trims to the bounding box, which
   preserves the off-centre framing that is visible at favicon sizes.

**Consequence, accepted.** The artwork is detailed — a receipt with printed
rules, a cart glyph and a dollar sign — and at a 16px browser-tab favicon it
reads as a shape rather than a picture. That is a property of the mark, not of
the pipeline, and is left as-is rather than silently substituting a simplified
glyph that would then disagree with the home-screen icon.

---

## D-41 — The default theme is a beige light theme drawn from the app icon. **Settled** (user decision).

**Context.** D-31 set Ledgerly's accent to teal and made `dark` the default,
before there was an icon. D-40 then brought in an icon that is cream and dark
green, so the installed app's home-screen tile and its first screen shared no
colour at all.

**Why.** User decision: a light, beige scheme "similar to the logo", with dark
kept but no longer default. Both colours are sampled from the icon rather than
invented — `#faf4eb` is the tile, `#324136` is the mark — so the two cannot
drift.

**Consequence.** The `light` theme id is REUSED rather than a new `beige` id
added. Ids are what `users.theme` stores, and a new id would strand every row
holding `light` on a theme that no longer exists. The label changes to
"Ledgerly Beige"; anyone who had explicitly chosen the old white light theme
gets the beige one, which on a self-hosted instance is the intent.

**Consequence.** `DEFAULT_THEME` moves to `light`, and migration `0004` moves
`users.theme`'s column default with it. The migration deliberately does **not**
rewrite existing rows: an account holding an explicit `dark` chose it, and a
theme change is not something a deployment should make on a user's behalf.
The practical effect is that an existing account — including the instance
owner's — stays dark until it picks the new theme from the switcher once.

**Consequence.** The four dark themes keep their accents, so D-31's teal
survives in `dark`. Only the light theme is restyled.

**Consequence.** `THEMES` entries gain an `accent`. The switcher's swatch
showed `background` alone, and four of the five themes are near-black, so the
swatch conveyed nothing about what you were selecting; it now shows page
colour and accent split down the middle.

---

## D-42 — The wordmark is set in a vendored script face. **Settled** (user decision).

**Context.** User request: the app title should be cursive.

**Why vendored, not `next/font/google`.** `next/font/google` self-hosts the
file but fetches it at BUILD time. Ledgerly builds in CI and inside a Docker
image, and a self-hosted app that cannot build without reaching
`fonts.googleapis.com` has acquired exactly the kind of third-party dependency
the rest of the design avoids. `apps/web/src/app/fonts/` holds a 25 KB latin
subset of Dancing Script (SIL OFL 1.1), loaded with `next/font/local`. Builds
are offline and byte-identical.

**Consequence.** The CSS generic `cursive` keyword was rejected as the primary:
it resolves to Snell Roundhand on Apple, Segoe Script on Windows and anything
at all on Linux, so the wordmark would differ per device. Those faces remain
the FALLBACK stack, for the pre-swap frame and for the case where the woff2
fails to load.

---

## D-43 — Portrait orientation is enforced as far as each platform allows, and no further. **Settled.**

**Context.** User request: keep the app in portrait on iOS and Android.

**What actually works.** Three mechanisms, because no single one covers both
platforms:

1. `orientation: "portrait"` in the web manifest — honoured by an **installed**
   PWA on Android. Already present since task 7.9.
2. `screen.orientation.lock("portrait")` — honoured by Android Chrome in
   standalone/fullscreen. **iOS Safari does not implement
   `ScreenOrientation.lock` at all.**
3. A CSS overlay shown only on a landscape phone (`orientation: landscape`
   AND `max-height: 520px` AND `pointer: coarse`, so a landscape iPad or a
   laptop is untouched). The only one of the three with any effect on iOS.

**Consequence, stated plainly because it would otherwise be discovered the
hard way.** On Android, installed, this is a real lock. **On iOS it is not a
lock and cannot be made one from a web page** — it is a request the OS ignores
plus a message asking the user to rotate back. A native wrapper is the only
way to genuinely lock orientation on iOS.

## D-44 — Receipt emails go through their own queue, and the recipient is a user id. **Settled** (user request).

**Context.** User request: an admin-configured SMTP relay; a per-project
setting that emails the project owner once per scanned receipt, after the AI
scan; and the ability to email any single receipt on demand regardless of that
setting.

**The SMTP config is one encrypted `app_config` blob**, `SECRET_KEYS.smtp`,
reusing D-39's `secrets.ts` machinery (AES-256-GCM, version byte as AAD).
Host, port, TLS mode, username, password and From identity are stored as a
single JSON value rather than a password column beside plaintext fields: one
read, one decrypt, one atomic write, and no field of it can be left in the
clear by someone adding a column later, because there are no columns.

Unlike the Claude key there is **no environment fallback**. That key needs one
because a fresh instance must be able to extract before anyone visits the admin
screen. Email has no bootstrap problem — an instance with no SMTP config simply
does not send — so a second source would be a second place to look and nothing
gained. `undecryptable` remains a distinct state, for D-39's reason: reporting
a `MASTER_KEY` mismatch as "not configured" sends an operator hunting for a
setting that is already there.

**Sending is a third BullMQ queue, `receipt-email`, not a step inside
extraction.** This is the decision that matters most.

An inline send would put a mail relay in the retry path of a job that spends
money. A relay hiccup would burn two more **paid Anthropic calls** on retry and
then write `extraction_status='failed'` on a receipt whose extraction actually
succeeded — inverting the rule `pipeline/extract.ts` is built around. The
enqueue therefore happens after `processReceiptExtraction` **returns**, outside
its persistence transaction (an email that succeeds against a transaction that
then rolls back is an email nobody can recall), and the enqueue itself is
wrapped so that even a Redis failure cannot fail the extraction job.

Job ids are not the bare `receiptId` the other two queues use. Those dedup
because a second render or a second extraction is waste; a second _email_ is a
feature — the on-demand send exists to send one again. The automatic send gets
`<receiptId>:auto`; an on-demand send gets no job id at all.

**`receipts.receipt_email_sent_at` is load-bearing, not bookkeeping.**
`receipts.reextract` sets `forcePass2` and re-enters the persistence path, so
without a durable marker every manual re-extract would send the email again. It
records the **automatic** send only — an on-demand send is a deliberate act and
says nothing about whether the automatic one has happened. It is written after
the send, not before, so a failure retries rather than being suppressed by a
marker for a message that never went; the cost is a possible duplicate if the
process dies between the two, which is a far better failure than a silent one.

**The recipient is a user id, never an address.** `receipts.emailReceipt` takes
`toUserId`, validated against project membership in the procedure and **again**
in the worker. Mailing a receipt to an arbitrary address is therefore not a
validation failure — it is an operation the API has no way to express. That is
a deliberate cost in convenience: "email this to my accountant" requires adding
the accountant to the project, which is the same disclosure decision, made once
and visibly, in the members list.

The procedure requires **read**, not edit: a read-only member forwarding a
receipt to a fellow member discloses nothing either of them could not already
open.

**`nodemailer` lives in `packages/queue` only**, the same containment
`@anthropic-ai/sdk` gets and for the same reason. `pipeline/email.ts` takes the
transport as a structurally-typed dependency and never names the library. The
one synchronous send in the app is `admin.testSmtp`, whose whole value is that
it fails immediately and says why — and even that is an injected context
capability supplied by `apps/web`'s tRPC route handler, never an import from
`packages/api` (which `packages/queue` already depends on, so the reverse
import would be circular).

**The attachment is always a JPEG** derived from the display render, longest
edge 1200, q75. `RETAIN_ORIGINALS=false` on this instance, so a PDF invoice's
source file is already discarded and page 1's render is all that exists — there
is no higher-quality source to prefer. JPEG rather than WebP because Outlook
still will not preview a WebP attachment, and an attachment nobody can see is
worse than one that is slightly softer.

**Turning the project setting on or off is audited unconditionally**, unlike
every other field on `projects.update`, which audits nothing for an ordinary
edit. It decides where financial data goes, and "who turned this on" is a
question someone will eventually need answered.
