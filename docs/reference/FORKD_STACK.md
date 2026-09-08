# Forkd Technology Stack

**Executive Summary**

Forkd is a monorepo Next.js application for restaurant bill tracking and management. It uses TypeScript, Node 22, a PostgreSQL 17 database, and a modular package structure with TRPC for API endpoints. The stack emphasizes type safety (Zod for validation, TypeScript strict mode) and progressive enhancement (PWA, guest bill-splits via token URLs, Cloudflare Access integration). Testing via Vitest, build orchestration via Turbo, and BullMQ for async job processing (receipt extraction, backups, imports).

## 1. Languages and Runtime Versions

| Component | Version | Source |
|-----------|---------|--------|
| Node.js | 22-alpine | `docker/Dockerfile` (lines 4, 67) |
| TypeScript | 5.x | `package.json`, `tsconfig.base.json` |
| Compilation target | ES2022 | `tsconfig.base.json` compilerOptions |
| Module system | ESM | `package.json` type: "module" |
| pnpm | 11.0.9 | `package.json` packageManager |

**Notes:**
- No `.nvmrc` file; Node version is inferred from Docker and CI config (`.github/workflows/ci.yml` sets node-version: "22").
- TypeScript in strict mode: `strict: true`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
- All source code is ES modules (import/export syntax).

## 2. Frameworks and Major Libraries

| Layer | Package | Version | Purpose |
|-------|---------|---------|---------|
| **Web Framework** | Next.js | latest (v15+) | Full-stack React framework; standalone output for Docker |
| **UI Framework** | React | 19.x | Component library |
| **UI Components** | HeroUI | 2.7.8 | Pre-built UI component library |
| **Styling** | TailwindCSS | 4.x | Utility-first CSS |
| **Styling (Theme)** | @heroui/theme | 2.4.26 | HeroUI theme configuration |
| **API / RPC** | TRPC | 11.0.0 | Type-safe RPC; includes @trpc/client, @trpc/server, @trpc/react-query |
| **Data Fetching** | @tanstack/react-query | 5.x | Async data fetching and caching (TanStack Query) |
| **State Serialization** | superjson | 2.2.2 | Serializes JS types (Date, Map, Set, BigInt) for TRPC/JSON |
| **Database ORM** | Drizzle ORM | 0.41.0 | SQL-first ORM for PostgreSQL |
| **Database Driver** | pg | 8.14.0 | Node.js PostgreSQL client |
| **Database Migrations** | drizzle-kit | 0.31.0 | Schema-to-SQL migration generator |
| **Validation** | Zod | 3.24.0 | Runtime schema validation |
| **Authentication** | better-auth | 1.2.0 | Authentication and session management (Drizzle adapter) |
| **JWT** | jose | 6.2.3 | JWT signing/verification; used for Cloudflare Access token validation |
| **Async Jobs** | BullMQ | 5.x | Redis-backed job queue (receipt extraction, backups, imports) |
| **Cache/Queue Store** | ioredis | (via BullMQ) | Redis client for BullMQ |
| **Image Processing** | sharp | 0.33.0 | Image resizing/optimization for restaurant photos |
| **Browser Automation** | playwright-core | 1.50.0 | Headless browser for screenshot capture (dynamic import; not bundled) |
| **Motion/Animation** | framer-motion | 12.x | React animation library |
| **Icons** | lucide-react | 1.17.0 | Icon library |
| **QR Codes** | qrcode | 1.5.4 | QR code generation for guest bill-splits |
| **AI Provider SDK** | @anthropic-ai/sdk | 0.54.0 | Claude API client (optional; server-side only) |
| **Alternative AI SDK** | openai | 4.x | OpenAI API client (optional fallback) |

**Database Engine:**
- PostgreSQL 17-alpine (from `docker-compose.yml`)
- Connection pooling via `pg.Pool` (see `packages/db/src/client.ts`)

**Key dependency notes:**
- TRPC integrates with React Query and Next.js via `@trpc/react-query` and middleware in the web app.
- Playwright Core is dynamically imported in `instrumentation.ts` (line 58 of Dockerfile) and excluded from Next.js file tracing; explicitly copied into the runner stage.
- AI provider SDK and OpenAI SDK are server-side only; never exposed to client bundles.

## 3. Directory Layout

```
Forkd (monorepo root)
├── apps/
│   └── web/                         # Next.js application
│       ├── src/
│       │   ├── app/                 # Next.js App Router (file-based routing)
│       │   │   ├── admin/           # Admin panel routes
│       │   │   ├── api/             # API route handlers (TRPC, auth, webhooks)
│       │   │   ├── dev/             # Development-only routes (user selector, etc.)
│       │   │   ├── g/               # Guest bill-split share routes (capability URL)
│       │   │   ├── map/             # Map view
│       │   │   ├── restaurants/     # Restaurant CRUD
│       │   │   ├── splits/          # Bill-split management
│       │   │   └── [other routes]   # sign-in, profile, welcome, etc.
│       │   ├── components/          # Reusable React components
│       │   ├── lib/                 # Utilities and helpers
│       │   │   ├── trpc/            # TRPC client setup
│       │   │   └── [helpers]        # fetch, auth, etc.
│       │   └── server/              # Server-only code (shutdown hooks)
│       ├── public/                  # Static assets, manifest, service worker
│       ├── next.config.ts           # Next.js config (standalone output, CSP headers)
│       ├── tsconfig.json            # App-specific TypeScript config
│       ├── package.json
│       └── vitest.config.ts         # Node test environment
│
├── packages/
│   ├── api/                         # TRPC API router definitions
│   │   └── src/
│   │       ├── routers/             # 13 routers (auth, restaurants, reviews, photos, splits, backups, etc.)
│   │       ├── trpc.ts              # TRPC context and middleware setup
│   │       ├── root.ts              # Root router composition
│   │       └── [ai, external, config, crypto]  # Utilities
│   │
│   ├── auth/                        # Better Auth integration
│   │   └── src/
│   │       └── auth.ts              # Better Auth instance (Drizzle adapter, Cloudflare Access middleware)
│   │
│   ├── config/                      # Configuration (minimal; mostly env-based)
│   │   └── src/
│   │       └── index.ts             # Empty export (config loaded via process.env)
│   │
│   ├── db/                          # Drizzle ORM schema and migrations
│   │   ├── src/
│   │   │   ├── schema/              # Schema definition (one file per domain)
│   │   │   │   ├── auth.ts          # Better Auth tables (user, account, session, verification)
│   │   │   │   ├── restaurants.ts   # restaurants, restaurant_status, us_state
│   │   │   │   ├── reviews.ts       # restaurant_reviews
│   │   │   │   ├── photos.ts        # restaurant_photos
│   │   │   │   ├── splits.ts        # Bill splits
│   │   │   │   ├── config.ts        # app_config (encrypted settings)
│   │   │   │   ├── imports.ts       # import_jobs, import_status
│   │   │   │   ├── backups.ts       # backup records
│   │   │   │   ├── relations.ts     # All Drizzle relations (avoids circular deps)
│   │   │   │   └── index.ts         # Re-exports
│   │   │   ├── client.ts            # pg.Pool + drizzle() instance
│   │   │   ├── configRead.ts        # getDecryptedConfigValue()
│   │   │   ├── configWrite.ts       # setEncryptedConfigValue()
│   │   │   ├── crypto.ts            # MASTER_KEY encryption/decryption
│   │   │   ├── seed.ts              # Seed cuisine_types
│   │   │   └── apiUsage.ts          # Track API token usage
│   │   ├── migrations/              # SQL migration files (generated by drizzle-kit)
│   │   ├── drizzle.config.ts        # Drizzle Kit configuration
│   │   └── package.json
│   │
│   ├── queue/                       # BullMQ job processing
│   │   └── src/
│   │       ├── queue.ts             # Queue definitions (import, backup, receipt)
│   │       ├── redis.ts             # Redis connection options (URL parsing)
│   │       ├── worker.ts            # Worker entry point (exports startImportWorker, etc.)
│   │       ├── receiptWorker.ts     # Receipt extraction job handler
│   │       ├── backupWorker.ts      # Database backup/restore handler
│   │       ├── pipeline/            # Receipt extraction pipeline (image → text → structured data)
│   │       └── [*.test.ts]          # Unit tests
│   │
│   ├── shared/                      # Shared utilities (no dependencies on other packages)
│   │   └── src/
│   │       ├── schemas/             # Zod schemas for validation
│   │       ├── logger.ts            # Logging utility
│   │       ├── currencies.ts        # ISO 4217 list
│   │       ├── countries.ts         # Country data
│   │       ├── priceLevel.ts        # Price level enums/helpers
│   │       ├── openingHours.ts      # Restaurant opening hours parsing
│   │       ├── restaurantStatus.ts  # Status enums
│   │       ├── familyAverage.ts     # Average calculation for bill splits
│   │       └── [*.test.ts]          # Unit tests
│   │
│   ├── trpc/                        # TRPC utilities (minimal)
│   │   └── src/
│   │       └── index.ts             # Re-exports for consistent imports
│   │
│   └── ui/                          # Reusable components (minimal)
│       └── src/
│           └── RestaurantMap.tsx    # Map visualization component
│
├── docker/
│   ├── Dockerfile                   # Multi-stage build (deps, builder, runner)
│   └── entrypoint.sh                # Container startup script (migrations, volume perms)
│
├── .github/workflows/
│   └── ci.yml                       # GitHub Actions: lint, typecheck, test, Docker build
│
├── tsconfig.base.json               # Base TypeScript config (strict mode, ES2022)
├── vitest.config.ts                 # Root vitest config (project discovery)
├── turbo.json                        # Turbo task configuration (build, test, lint, etc.)
├── eslint.config.js                 # ESLint config (flat config, TypeScript plugin)
├── .prettierrc.json                 # Prettier formatting rules
├── .env.example                     # Environment variable template (35+ keys)
├── pnpm-workspace.yaml              # pnpm workspace roots
├── docker-compose.yml               # Local dev: postgres:17, redis, chrome-headless, forkd app
└── pnpm-lock.yaml                   # Monorepo dependency lock file

```

## 4. Build Tooling

### Bundler and Build Chain

- **Monorepo Orchestration:** Turbo 2.x (`turbo.json` at root)
  - Tasks: `build`, `dev`, `lint`, `typecheck`, `test`, `format`
  - Caching enabled for `build`, `lint`, `typecheck`, `test`
  - `dev` task is persistent (no caching); `format` is not cached
  - Turbo passes `GIT_SHA` build arg to Docker build (see `turbo.json` line 7)

- **Next.js Build:** Next.js standalone output (`next.config.ts` line 16: `output: "standalone"`)
  - Bundles entire app into `.next/standalone/` with minimal node_modules
  - webpack config (custom) in `next.config.ts` lines 60–68:
    - Adds `chromium-bidi` and `playwright-core` as externals on server-side builds
  - Transpiles `@forkd/ui` package (line 18)
  - Declares external packages: `sharp`, `playwright-core`, `bullmq`, `ioredis` (not bundled; must exist in runtime)

- **TypeScript:** TypeScript 5.x (defined in root `package.json`)
  - Base config: `tsconfig.base.json` (ES2022 target, strict mode)
  - App-specific: `apps/web/tsconfig.json`, per-package configs
  - No `declaration` output (line 22 of base config)

- **Linting:** ESLint 9.x (flat config)
  - Config file: `eslint.config.js` (root)
  - Plugins: `@eslint/js`, `typescript-eslint`
  - Ignores: node_modules, .next, dist, .turbo, coverage, public
  - Runs via `pnpm run lint` (Turbo task)

- **Formatting:** Prettier 3.x
  - Config: `.prettierrc.json` (minimal; mostly defaults)
  - Runs via `pnpm run format` (not cached in Turbo)
  - Integrated with lint-staged for pre-commit

- **Secret Detection:** secretlint 8.x
  - Rule preset: `@secretlint/secretlint-rule-preset-recommend`
  - Runs in lint-staged on all files with `--maskSecrets` flag
  - Prevents accidental commits of API keys, credentials, etc.

### npm Scripts (Root)

```bash
pnpm run dev              # Turbo dev task (watches all packages)
pnpm run build            # Turbo build (Next.js → .next/standalone, esbuild migrate.cjs)
pnpm run lint             # Turbo lint (ESLint, secretlint via lint-staged)
pnpm run typecheck        # Turbo typecheck (tsc --noEmit)
pnpm run test             # Turbo test (Vitest in all packages)
pnpm run format           # Prettier write (not Turbo-cached)
pnpm run docker:up        # docker compose up --build
pnpm run docker:down      # docker compose down
pnpm run db:generate      # drizzle-kit generate (new migrations from schema)
pnpm run db:migrate       # drizzle-kit migrate (apply pending migrations)
pnpm run db:push          # drizzle-kit push (schema → DB, dev only, no migration history)
pnpm run db:seed          # tsx seed.ts (populate cuisine_types, idempotent)
```

### Build Artifacts

- **Next.js:**
  - Output: `.next/standalone/` (app server, API routes, TRPC)
  - Static: `.next/static/` (JS chunks, CSS)
  - Standalone includes all dependencies except `sharp`, `playwright-core`, `bullmq`, `ioredis`

- **Migrations:**
  - Migration script bundled to `migrate.cjs` via esbuild (Dockerfile line 51–56)
  - Self-contained; drizzle-orm and pg inlined

## 5. Test Setup

### Test Runner

- **Framework:** Vitest 3.x
- **Config:** `vitest.config.ts` (root) discovers projects in `packages/*/vitest.config.ts` and `apps/*/vitest.config.ts`
- **Environment:** Node (no jsdom)
- **Coverage:** `@vitest/coverage-v8` (available but no default coverage run; see `turbo.json` line 21: coverage outputs)

### Test Files

- **Location:** Tests colocated with source code
- **Naming:** `*.test.ts` (e.g., `packages/shared/src/index.test.ts`, `packages/api/src/routers/restaurants.test.ts`)
- **Count:** ~15 test files across `shared`, `api`, `queue` packages

### Database in Tests

- **No isolated test database:** Tests run against process.env.DATABASE_URL (shared with dev)
- **Recommendation for Ledgerly:** Set up a separate test database or use transactions that roll back per test

### Running Tests

```bash
pnpm run test             # All packages (via Turbo)
pnpm test -w              # Watch mode (via Vitest if run directly)
```

### CI Integration

- **GitHub Actions (`.github/workflows/ci.yml`):**
  - Node 22 setup, pnpm cache
  - Lint → Typecheck → Test (all via Turbo)
  - Docker build (only on main branch, after CI passes)
  - No separate DB migration in CI (tests don't run migrations)

## 6. Configuration and Environment Variables

### Environment Variables (from `.env.example`)

**Required Core:**
- `DATABASE_URL` — PostgreSQL connection string (format: `postgres://user:pass@host:port/dbname`)
- `MASTER_KEY` — Base64-encoded 32-byte key for encrypting secrets in `app_config` table
- `AUTH_URL` — Public URL of the app (used for auth callback URLs and session cookie domain)
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` — Docker Compose initialization

**Service URLs (defaults shown are for Docker Compose):**
- `REDIS_URL` — Redis connection (default: `redis://redis:6379`)
- `CHROME_CDP_ENDPOINT` — Headless Chrome for Playwright (default: `http://chrome-headless:3000`)
- `UPLOADS_DIR` — Path for restaurant photos (default: `/app/uploads`)
- `BACKUPS_DIR` — Path for database backups (default: `/app/backups`)

**Optional Runtime:**
- `NODE_ENV` — `production` or `development`
- `HOST` — Bind address (default: `0.0.0.0`)
- `PORT` — Listen port (default: `3000`)
- `IMAGE_LOCATION` — Docker image override (dev only)
- `TRUSTED_ORIGINS` — Comma-separated extra CORS origins
- `SCHEDULER_CLEANUP_MONTHS` — Soft-delete retention period
- `MAX_IMAGE_FILE_SIZE` — Max bytes per photo (default: `10485760`)
- `LOG_LEVEL` — `info`, `debug`, etc.

**Authentication (Bootstrap):**
- `PASSWORD_AUTH_ENABLED` — `auto` (enable until first user), `true`, or `false`
- `ENABLE_REGISTRATION` — Allow self-signup (default: `false`)

**Cloudflare Access (Prod):**
- `CF_ACCESS_AUD` — Application Audience tag from Cloudflare dashboard
- `CF_ACCESS_TEAM_DOMAIN` — Team domain (e.g., `myteam.cloudflareaccess.com`)
- `CF_ACCESS_ENABLED` — Set to `true` when Access is fronting the app

**AI Provider (Server-Side Only):**
- `AI_ENABLED` — Enable/disable AI features (default: `false`)
- `AI_PROVIDER` — `anthropic` or `openai` (default: `anthropic`)
- `AI_MODEL` — Model ID (default: `claude-opus-4-7`)
- `AI_TEMPERATURE` — Sampling temperature (default: `1.0`)
- `AI_MAX_TOKENS` — Max completion tokens (default: `4000`)
- `AI_TIMEOUT_MS` — Timeout for AI calls (default: `300000`)
- `AI_API_KEY` — **Not in `.env.example`; set via admin UI in production** (stored encrypted in `app_config` table)

**Transcription (Optional):**
- `TRANSCRIPTION_PROVIDER` — `disabled` or `openai`
- `TRANSCRIPTION_MODEL` — Model ID (default: `whisper-1`)

**Video Parsing:**
- `VIDEO_PARSING_ENABLED` — Enable yt-dlp import (default: `true`)
- `VIDEO_MAX_LENGTH_SECONDS` — Max video duration (default: `120`)
- `YT_DLP_VERSION` — yt-dlp release version (default: `latest`)
- `YT_DLP_BIN_DIR` — Path to yt-dlp binary (default: `/usr/local/bin`)

**PWA/App:**
- `APP_NAME` — Display name (default: `Forkd`)
- `APP_THEME_COLOR` — CSS color for manifest and theme (default: `#0f172a`)

### Config Loading and Validation

**Approach:** Direct `process.env` access (no centralized validation schema)

- **Database client** (`packages/db/src/client.ts`): Reads `DATABASE_URL` directly into `pg.Pool`
- **Better Auth** (`packages/auth/src/auth.ts`): Uses Drizzle adapter
- **Queue/Redis** (`packages/queue/src/redis.ts`): Parses `REDIS_URL` into host, port, password, db
- **API routers** (`packages/api/src/routers/*`): Read env vars as needed (e.g., `process.env.NODE_ENV`, `process.env.BACKUPS_DIR`)
- **Crypto** (`packages/api/src/crypto.ts`, `packages/db/src/crypto.ts`): Validate `MASTER_KEY` is exactly 32 bytes (base64-decoded)

**No Zod schema or runtime validation at startup.** Config is validated incrementally as modules load. This is a design gap: a single startup schema (Zod + `z.object()` for all required env vars) would catch misconfiguration immediately.

### Config Module Structure

- `packages/config/src/index.ts` is nearly empty; just `export {}`
- Configuration is distributed across packages (db/client.ts, queue/redis.ts, auth/auth.ts, etc.)
- **Recommendation for Ledgerly:** Create a centralized `config.ts` that validates all env vars with Zod at startup, similar to Forkd's pattern in the API layer (see `packages/api/src/routers/auth.ts` for example Zod schemas).

## 7. Database

### Engine

- **PostgreSQL 17-alpine** (Docker image: `postgres:17-alpine`)
- **Driver:** `pg` 8.14.0 (Node.js native)
- **Connection:** `pg.Pool` with `process.env.DATABASE_URL` (see `packages/db/src/client.ts`)

### ORM and Schema

- **Drizzle ORM 0.41.0** — SQL-first ORM
- **Drizzle Kit 0.31.0** — Schema-to-migration compiler

### Schema Layout (`packages/db/src/schema/`)

| File | Tables / Enums |
|------|---|
| `auth.ts` | `user`, `account`, `session`, `verification` (Better Auth) |
| `restaurants.ts` | `restaurants`, `restaurant_status` enum, `us_state` enum |
| `reviews.ts` | `restaurant_reviews` |
| `photos.ts` | `restaurant_photos` |
| `splits.ts` | Split ledger and participant tables |
| `imports.ts` | `import_jobs`, `import_status` enum |
| `config.ts` | `app_config` (encrypted key-value store for settings) |
| `backups.ts` | `backups` (backup metadata and restore state) |
| `relations.ts` | All `relations()` declarations (avoids circular dependencies) |
| `index.ts` | Re-exports all tables and enums |

### Migrations

- **Location:** `packages/db/migrations/`
- **Format:** SQL files
- **Naming:** Auto-generated by Drizzle Kit: `0000_loud_lester.sql`, `0001_medical_black_tom.sql`, etc.
  - Pattern: `<zero-padded-number>_<random-adjective>_<random-noun>.sql`
- **Count:** 13 migrations as of August 2025
- **Schema metadata:** `migrations/meta/_journal.json` (Drizzle internal)

### Migration and Seeding Scripts (via drizzle-kit)

```bash
pnpm db:generate     # drizzle-kit generate (compare schema.ts to DB, output new .sql file)
pnpm db:migrate      # drizzle-kit migrate (apply pending migrations)
pnpm db:push         # drizzle-kit push (dev-only; schema → DB without migration history)
pnpm db:seed         # tsx packages/db/src/seed.ts (populate cuisine_types)
```

**Config:** `packages/db/drizzle.config.ts`
- Dialect: `postgresql`
- Schema file: `packages/db/src/schema/index.ts`
- Migrations output dir: `packages/db/migrations/`
- Credentials: `process.env.DATABASE_URL`

### Database Conventions (from `packages/db/README.md`)

- **Column naming:** `snake_case` in DB; `camelCase` in Drizzle schema
- **Primary keys:** `text` for Better Auth tables (Better Auth manages IDs); `uuid` with `defaultRandom()` for others
- **Foreign keys:** Explicit `onDelete` behavior (cascade, set null, restrict)
- **Timestamps:** `createdAt`, `updatedAt` on mutable tables; `deletedAt` on soft-delete tables
- **Nullable FKs:** When FK is `ON DELETE SET NULL`, column must be nullable in schema (even if requirements say "not null")

### Specialized Tables

- **`app_config`** (`packages/db/src/schema/config.ts`): Encrypted key-value store
  - Keys like `"backup.schedule_cron"`, `"ai.model_override"`
  - Values stored encrypted with `MASTER_KEY` (32-byte base64 key from env)
  - Read via `getDecryptedConfigValue()`, write via `setEncryptedConfigValue()` (see `packages/db/src/configRead.ts`, `configWrite.ts`)
  - Never store full card numbers, auth tokens, or secrets in plaintext

- **Soft deletes:** Tables with `deletedAt` column can be soft-deleted (not physically removed)
  - Cleanup scheduled periodically (configurable via `SCHEDULER_CLEANUP_MONTHS` env var)

---

## Notable Security and Design Patterns

### Strengths

1. **Type safety:** Zod validation on routers, TypeScript strict mode, TRPC type-safe RPC.
2. **Encryption at rest:** `app_config` table encrypted with `MASTER_KEY`.
3. **Database-backed auth:** Better Auth with Drizzle adapter (no session secrets in cookies).
4. **Capability URLs:** Guest bill-splits use cryptographic tokens in URLs (no persistent auth required).
5. **CSP headers:** Strict Content-Security-Policy defined in `next.config.ts`; guest pages use `default-src 'none'`.
6. **AI API key isolation:** Anthropic SDK never in client bundles; key stored encrypted in DB.

### Gaps or Regrets (Inferred)

1. **No centralized config validation:** Environment variables validated incrementally (design gap for Ledgerly to avoid).
   - Recommendation: Create `packages/config/src/validateEnv.ts` with Zod at startup.

2. **Test database isolation:** Tests run against shared dev DB (no rollback or sandboxing).
   - Recommendation for Ledgerly: Use Docker Compose with a test DB or implement transaction-based rollback.

3. **Playwright dynamically imported:** Bundler can't trace it; must be manually staged in Dockerfile.
   - Code: `const { startImportWorker } = await import("@forkd/queue/worker")` (instrumentation.ts)
   - Workaround: Mark as webpack external + explicit COPY in Dockerfile (line 86).

4. **MASTER_KEY loss = data loss:** The encrypted `app_config` table cannot be recovered if `MASTER_KEY` is lost.
   - Comment in `.env.example` warns to "BACK THIS UP OUT-OF-BAND."
   - Recommendation: Document backup and rotation strategy in ops runbook.

5. **No secret rotation:** API keys (AI, etc.) stored encrypted but no rotation mechanism visible.

---

## Quick Reference

| Item | Where | Example |
|------|-------|---------|
| Root package.json | `Forkd:/package.json` | turbo, pnpm 11.0.9 |
| TypeScript config | `tsconfig.base.json` | ES2022, strict, ESM |
| TRPC routers | `packages/api/src/routers/` | 13 routers (auth, restaurants, photos, etc.) |
| Database schema | `packages/db/src/schema/` | One file per domain (restaurants.ts, reviews.ts, etc.) |
| Migrations | `packages/db/migrations/` | SQL files generated by drizzle-kit |
| Queue jobs | `packages/queue/src/queue.ts` | BullMQ: import, backup, receipt extraction |
| Environment setup | `.env.example` | 35+ keys for DB, Redis, AI, Cloudflare Access |
| CI/CD | `.github/workflows/ci.yml` | Node 22, pnpm, ESLint, Vitest, Docker build |
| Local dev | `docker-compose.yml` | PostgreSQL 17, Redis, chrome-headless service |
| Container build | `docker/Dockerfile` | 3-stage: deps, builder (Next.js), runner (alpine) |
| Linting config | `eslint.config.js` | Flat config, TypeScript plugin, secretlint in pre-commit |

---

**End of Document**
