# Ledgerly — Build State

Updated at the end of every phase. Read this first in any new session.

## Current phase
Phase 0 — Recon & bootstrap. **Complete.**

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

## Next

Phase 1 — architecture. Write `ARCHITECTURE.md`, `docs/SCHEMA.md`,
`docs/PHASES.md`, and `DECISIONS.md` from the reference docs.

## Resolved questions

- **Postgres vs SQLite** → **PostgreSQL 17.** Forkd runs `postgres:17-alpine`
  with Drizzle ORM 0.41 + drizzle-kit 0.31. Matching it keeps the schema,
  migration tooling, and backup path (`pg_dump --format=custom`) inheritable.
- **Repo public or private** → **public.** Raises the bar on the secret
  rules in CLAUDE.md; every doc gets a scrub pass before commit.

## Blocked / open questions

- **Scope of inheritance from Forkd's receipt pipeline.** Forkd already has
  one (`packages/queue/src/receiptWorker.ts` + `pipeline/`, BullMQ-driven,
  `@anthropic-ai/sdk` 0.54). Ledgerly is specialising an existing pipeline,
  not building one from scratch. Decide in Phase 1 whether to port it or
  rewrite against the nullable-field / `missing_fields[]` contract.
- **AI model default.** Forkd pins `AI_MODEL=claude-opus-4-7`, which is
  stale. Pick Ledgerly's default in Phase 1.
- **Monorepo vs single app.** Forkd is a pnpm/Turbo monorepo with 8
  packages. That structure carries real cost (see the bundling lessons).
  Decide in Phase 1 whether Ledgerly needs it.

## Surprises / notes

- Forkd's `packages/config` is an empty `export {}`; env vars are read via
  bare `process.env` throughout, with no startup validation. Both the stack
  and auth analyses flagged this independently. Ledgerly should validate
  env with a Zod schema at startup.
- Forkd's tests run against the shared dev database — no isolation, no
  rollback. Do not inherit this.
- The healthcheck at `/api/v1/health` returns `{status:"ok"}` without
  touching the database, so a container can report healthy while every
  query fails.
