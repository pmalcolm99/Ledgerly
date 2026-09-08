# Ledgerly

Receipt capture and spend tracking. Self-hosted PWA behind Cloudflare Tunnel
+ Cloudflare Access, with Claude-powered receipt extraction.

Architecturally modeled on Forkd (`/Users/pmalcolm/Documents/Forkd`).

## Read first

- `docs/STATE.md` — where the build currently stands. Always read this.
- `docs/reference/` — Forkd analysis. Read these, not the Forkd repo itself.
- `ARCHITECTURE.md`, `docs/SCHEMA.md`, `docs/PHASES.md` — the design.

## Hard rules

**Never commit secrets.** `.env`, tunnel credentials, API keys, real
hostnames, AUD tags. Check `git status --ignored` before any first-time
commit of a new directory.

**Never commit `docs/private/`.** AARs, retros, working notes, and threat
models live there and stay local. If asked to write a retro or AAR, it goes
in `docs/private/`.

**Never read the Forkd repo in the main thread.** Dispatch a `forkd-analyst`
subagent. Reading it directly destroys the context budget.

**Never store full card numbers.** Only `card_last4`. Scrub any Luhn-valid
13-19 digit sequence from AI output before it reaches the database.

**Authorization at the query layer.** Every project query composes with the
`scopedProjects(user)` helper. Do not scatter permission checks through
route handlers.

**The Anthropic API key is server-side only.** Never in a client bundle,
never in logs, never in an error message.

## Conventions

- Follow Forkd's stack, structure, and naming. Deviations are recorded in
  `DECISIONS.md` with a reason.
- Every extracted receipt field is nullable. Extraction never fails an
  upload; unreadable fields go to `missing_fields[]` for user review.
- Port and hostname come from `.env` (`APP_PORT`, `APP_HOSTNAME`). Never
  hardcode them.
- Migrations are forward-only and never edited after being applied.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.

## Workflow

- One phase per session. Update `docs/STATE.md` before committing.
- After pushing, verify the GitHub Actions run passes (`gh run watch`).
- Dispatch the `reviewer` subagent over the diff before committing any
  auth, upload, or AI-integration work.
- Ask rather than assume on anything ambiguous. A wrong assumption in the
  schema or auth layer is expensive to unwind.

## Model routing

- Reading, grepping, inventory → `forkd-analyst` / `doc-writer` (Haiku)
- Implementation → Sonnet
- Architecture, auth design, security review → Opus
- Escalate to Opus after Sonnet has failed twice, not preemptively.
