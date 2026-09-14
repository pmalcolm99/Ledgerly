# Ledgerly

Self-hosted receipt capture and spend tracking, with AI extraction.

Photograph a receipt; Claude reads the merchant, date, total, tax and line
items; the result lands in a project you can search, filter and export. It
runs on your own machine, behind a Cloudflare Tunnel and Cloudflare Access,
with no inbound ports and no published IP address.

Built for tracking spend on a project — a renovation, a build, a job — where
the questions are "what have we spent so far", "what did we buy from whom",
and "where is the receipt for that".

---

## Why it exists

Spreadsheets lose receipts. Photo libraries lose them among everything else.
Commercial expense apps want your financial history on their servers and a
subscription for the privilege.

Ledgerly keeps the data on hardware you control. The only third party
involved is Anthropic, which sees a receipt image in order to read it, and
Cloudflare, which authenticates visitors at the edge and forwards the traffic.

---

## What it does

- **Capture** — camera, photo library, or PDF, from a phone or a laptop.
  Multi-file batches. Installs to an iOS home screen as a PWA.
- **Extract** — two-pass Claude extraction with a confidence check. Every
  field is nullable; anything unreadable goes to a review queue rather than
  being guessed. Extraction never fails an upload.
- **Organise** — projects with per-member permissions (`read`, `read_add`,
  `full`), a user-extensible category taxonomy, search, filters and sorting.
- **Report** — spend by category, itemised versus unitemised totals, CSV and
  XLSX export.
- **Email** — a receipt summary on demand, or automatically once a receipt has
  been reviewed.
- **Back up** — scheduled archives with per-table checksums, and a restore
  script that verifies row counts against the manifest rather than just
  claiming success.

---

## How it fits together

```
  phone / laptop
        │  https://receipts.<your-domain>
        ▼
  Cloudflare edge — Access authenticates, Tunnel routes
        │  outbound-only connection
        ▼
  your machine
    ├─ cloudflared
    └─ docker compose
       ├─ webapp    Next.js + BullMQ workers   (127.0.0.1 only)
       ├─ postgres  receipts, projects, audit  (no published port)
       └─ redis     job queues                 (no published port)
                          │
                          └─→ Anthropic API (server-side only)
```

**Stack:** TypeScript throughout. Next.js (App Router) and tRPC; PostgreSQL
with Drizzle; Redis and BullMQ for the ingest, extraction, email and backup
queues; sharp and poppler for image and PDF handling; Docker Compose to run
it.

The structure follows [Forkd](https://github.com/pmalcolm99), an earlier
project on the same stack; deliberate deviations are recorded in
`DECISIONS.md` with a reason.

---

## Quickstart

You need Docker, a domain whose DNS is on Cloudflare, and about an hour.

```bash
git clone git@github.com:<your-github-username>/ledgerly.git
cd ledgerly
cp .env.example .env
```

Then, in order:

1. **Generate `MASTER_KEY`** — `openssl rand -base64 32` — and back it up
   somewhere off this machine. It encrypts stored credentials and is
   deliberately not included in backups.
2. **Set a database password**, in both `POSTGRES_PASSWORD` and
   `DATABASE_URL`.
3. **Create a Cloudflare Tunnel** and route `receipts.<your-domain>` to
   `localhost:3000`.
4. **Create a Cloudflare Access application** with an allow policy for your
   email, and copy its **AUD tag** (64 hex characters) and your **team
   domain** into `.env`.
5. **Get an Anthropic API key** from
   [console.anthropic.com](https://console.anthropic.com) — and set a spend
   limit before you create it.
6. **Start it:**
   ```bash
   docker compose up -d --build
   cloudflared tunnel run ledgerly
   ```
7. **Sign in first.** The first person to sign in becomes the instance owner.
   There is no default password and no other bootstrap.

**`SETUP.md` is the real guide** — every step numbered, and every step
followed by what you should see so you can tell whether it worked. The list
above is an outline of it, not a substitute: steps 3 to 5 have specifics that
are easy to get wrong, particularly the AUD tag.

---

## Documentation

| Document                               | What is in it                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **[SETUP.md](SETUP.md)**               | Nothing to working instance. Assumes no prior Cloudflare Tunnel, Access or Anthropic API experience. Start here.                |
| **[DEPLOYMENT.md](DEPLOYMENT.md)**     | Upgrades, rollback, backup and restore operations, log locations, and troubleshooting for the failures this build actually hit. |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How the system is put together and why.                                                                                         |
| **[docs/SCHEMA.md](docs/SCHEMA.md)**   | Data model and the permission matrix.                                                                                           |
| **[DECISIONS.md](DECISIONS.md)**       | Every non-obvious decision, with its reasoning — including the ones later amended, and why.                                     |
| **[docs/STATE.md](docs/STATE.md)**     | Where the build stands, phase by phase.                                                                                         |
| **[docs/PHASES.md](docs/PHASES.md)**   | The build plan and its gates.                                                                                                   |

---

## Security

The design assumptions, and what actually enforces them:

- **Cloudflare Access authenticates every request** before it reaches the
  machine. Ledgerly independently verifies the Access JWT's signature against
  Cloudflare's JWKS, checks the `aud` claim against the configured tag, and
  pins RS256. The `Cf-Access-Authenticated-User-Email` header is never used as
  an identity source; identity is keyed on the token's `sub`.
- **Authorization is composed at the query layer.** Every project-scoped query
  composes a `scopedProjects(user)` helper rather than scattering permission
  checks through route handlers. Non-members get a 404, not a 403, so the
  existence of a record is not disclosed.
- **Full card numbers are never stored.** Any Luhn-valid 13–19 digit sequence
  is stripped from AI output and from user-typed text before it is persisted,
  including from the raw extraction blob. Only `card_last4` is kept.
- **EXIF, including GPS, is stripped from stored images.** Receipt photos
  carry the location they were taken. Retained originals keep their pixels
  bit-identically and lose their metadata.
- **The Anthropic API key is server-side only** — never in a client bundle,
  never in a log, never in an error message, and not readable back through the
  admin API once stored.
- **The container runs as a non-root user**, with no added capabilities and
  `no-new-privileges`. Base images are pinned by digest.
- **Secrets never reach the repository.** `gitleaks` runs in CI over the full
  history and gates the image publish; `secretlint` runs as a pre-commit hook.

A full security review — 24 checks across authentication, authorization,
upload handling, AI integration, and the export and backup paths, plus a
history-wide secret scan — was carried out in Phase 10 and its findings fixed
or recorded. See `DECISIONS.md` for the entries it amended.

**Reporting something:** this is a personal project with no bug bounty. If you
find a vulnerability, open a private issue or contact the maintainer directly
rather than filing a public report.

---

## Development

```bash
pnpm install
./scripts/test-db.sh          # throwaway postgres for tests
./scripts/test-redis.sh       # throwaway redis for tests
pnpm dev
```

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @ledgerly/web e2e    # Playwright, WebKit only
```

Tests never touch `DATABASE_URL` or `REDIS_URL` — they use
`TEST_DATABASE_URL` and `TEST_REDIS_URL` against throwaway services.

Two things worth knowing before you run the suite:

- **The backup restore drill needs `libpq` on `PATH`**, and `pg_dump` must be
  at least as new as the server. Without it the drill skips, and `pnpm test`
  reads green while the one check proving a backup is restorable never ran.
  CI enforces this and fails the build if the drill did not execute.
- **`DEV_AUTH_BYPASS=true` only works under `pnpm dev`.** The production
  container refuses to boot with it on. Never point a dev server with the
  bypass on at a database that will become production — the bypass identity
  would win the first-owner election permanently.

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
Migrations are forward-only and are never edited after being applied.

---

## Status

Phase 10 complete. In daily use on a single instance.

Known limitations, all deliberate and recorded in `DECISIONS.md`:

- PDF receipts extract **page one only**.
- Backups do **not** include receipt images unless
  `BACKUP_INCLUDE_IMAGES=true`.
- Backup archives are **not encrypted** at rest — `0600` on disk, and nothing
  once copied elsewhere.
- There is **no spend ceiling** on the Anthropic API beyond per-minute rate
  limits. Set a limit in the Anthropic console.
- Every signed-in user can see the **member directory** — names and email
  addresses of everyone on the instance (D-33).

---

## Licence

No licence is granted. This is a personal project published for reference.
