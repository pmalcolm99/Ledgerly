# syntax=docker/dockerfile:1
# Multi-stage build: deps -> builder -> runner (ARCHITECTURE.md §8.1).

# =============================================================================
# deps — install once, cached by lockfile + workspace manifests
# =============================================================================
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

# Copied per line, no glob, to maximize Docker layer caching (mirrors
# Forkd's pattern — docs/reference/FORKD_STACK.md §3): a change to any one
# package's source never invalidates this layer, only a change to a
# manifest does.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

# =============================================================================
# builder — full source, Next.js standalone output + bundled migrate/seed
# =============================================================================
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

COPY --from=deps /app ./
COPY . .

ARG GIT_SHA=dev
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time-only placeholders so packages/config/src/env.ts's startup parse
# (D-14) can succeed while Next.js collects page data — see task 2.8's build
# notes. These are never the values the running container uses; real values
# come from docker-compose's env_file / environment at runtime.
ENV NODE_ENV=production
ENV DATABASE_URL="postgres://build:build@localhost:5432/build_placeholder"
ENV MASTER_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
ENV ANTHROPIC_API_KEY="build-placeholder"
ENV CF_ACCESS_AUD="0000000000000000000000000000000000000000000000000000000000000000"
ENV CF_ACCESS_TEAM_DOMAIN="build-placeholder.cloudflareaccess.com"

RUN pnpm exec turbo run build --filter=@ledgerly/web

# Bundle the migration and seed scripts to self-contained CommonJS —
# drizzle-orm and pg inlined, so the runner stage needs no dev dependencies
# to run them (ARCHITECTURE.md §8.1). `pg-native` is an optional dependency
# `pg` only requires inside a try/catch when actually present; it is not
# installed here, so it must be marked external rather than bundled, or
# esbuild fails trying to resolve it.
RUN pnpm exec esbuild packages/db/src/migrate.ts \
      --bundle --platform=node --format=cjs --external:pg-native \
      --outfile=/app/apps/web/.next/standalone/migrate.cjs
RUN pnpm exec esbuild packages/db/src/seed.cli.ts \
      --bundle --platform=node --format=cjs --external:pg-native \
      --outfile=/app/apps/web/.next/standalone/seed.cjs

# =============================================================================
# runner — minimal production image
# =============================================================================
FROM node:22-alpine AS runner
WORKDIR /app

ARG GIT_SHA=dev

# vips + libheif: sharp/HEIC (D-11). poppler-utils: PDF rasterisation (D-11,
# new vs. Forkd). postgresql17-client: pg_dump/pg_restore (Phase 9). tar:
# backup archives. su-exec: privilege drop in entrypoint.sh. No Chromium, no
# ffmpeg, no python3, no yt-dlp — Ledgerly drops all four of Forkd's
# scraping/transcription dependencies (ARCHITECTURE.md §1, §8.1).
RUN apk add --no-cache vips libheif poppler-utils postgresql17-client tar su-exec

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV MIGRATIONS_DIR=/app/migrations
ENV APP_GIT_SHA=${GIT_SHA}

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/packages/db/migrations ./migrations

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh \
    && mkdir -p /app/uploads /app/backups \
    && chown -R node:node /app/uploads /app/backups

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["sh", "-c", "node migrate.cjs && node seed.cjs && node apps/web/server.js"]
