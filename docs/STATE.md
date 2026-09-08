# Ledgerly — Build State

Updated at the end of every phase. Read this first in any new session.

## Current phase
Phase 1 — Architecture & decisions. **Complete.**

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

## Next

Phase 2 — Foundation. 14 tasks in `docs/PHASES.md`. Gate: `docker compose up`
green from a clean checkout and the Actions run passes.

Read before starting: `CLAUDE.md`, this file, `docs/PHASES.md` §Phase 2,
`ARCHITECTURE.md` §2 and §7, `docs/SCHEMA.md`.

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
