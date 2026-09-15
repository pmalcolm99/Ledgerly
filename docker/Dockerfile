# syntax=docker/dockerfile:1
# Multi-stage build: deps -> builder -> runner (ARCHITECTURE.md §8.1).
#
# Base images are pinned BY DIGEST, not by tag (Phase 10a, F-32). `node:22-
# alpine` is a moving target: it is repointed on every upstream patch, so
# two builds of the same commit could produce different images and there was
# no way to state which bytes were running. The tag is kept alongside the
# digest purely as a human-readable label -- the digest is what Docker
# resolves.
#
# To update, use buildx and take the INDEX digest:
#
#   docker buildx imagetools inspect node:22-alpine \
#     --format '{{json .Manifest.Digest}}'
#
# Verify it is an index before pinning it -- `.Manifest.MediaType` must be
# `application/vnd.oci.image.index.v1+json`, NOT `...image.manifest.v1+json`.
#
# NOT `docker manifest inspect -v`. That returns an ARRAY of per-platform
# manifests, and taking `[0].Descriptor.digest` from it yields the FIRST
# PLATFORM's manifest (amd64), not the index. Pinning that forces amd64 on
# every host: BuildKit reports `InvalidBaseImagePlatform`, an arm64 machine
# silently builds and runs the whole stack under emulation, and the apk
# output gives it away by fetching `x86_64/APKINDEX.tar.gz`. That is exactly
# what the first version of this pin did.
#
# Do the update deliberately, as its own commit.

# =============================================================================
# deps — install once, cached by lockfile + workspace manifests
# =============================================================================
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
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
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

COPY --from=deps /app ./
COPY . .

# Declared in BOTH stages because ARG does not cross them. Here it is
# promoted to ENV so `next.config.ts` can read it during `next build` and
# inline it as APP_GIT_SHA — without this line the ARG was declared and never
# used, which is why nothing in the app could say which build it was running.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time-only placeholders so packages/config/src/env.ts's startup parse
# (D-14) can succeed while Next.js collects page data — see task 2.8's build
# notes. These are never the values the running container uses; real values
# come from docker-compose's env_file / environment at runtime.
ENV NODE_ENV=production

# Passed INLINE on the build command rather than declared as ENV.
#
# BuildKit's linter flags `ENV MASTER_KEY=...` and `ENV ANTHROPIC_API_KEY=...`
# as SecretsUsedInArgOrEnv, and it is right to: an ENV persists in that
# stage's image metadata, so anyone with the image can read it back. Nothing
# was ever actually leaked here -- these are throwaway placeholders, the
# builder stage is discarded and never pushed, and the real values come from
# docker-compose's env_file at runtime -- but there is no reason for them to
# sit in metadata at all when the command that needs them can carry them for
# exactly as long as it runs.
#
# They exist because `packages/config/src/env.ts` parses and validates the
# environment at startup (D-14), and `next build` triggers that parse while
# collecting page data. The values are structurally valid and deliberately
# useless.
RUN DATABASE_URL="postgres://build:build@localhost:5432/build_placeholder" \
    MASTER_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
    ANTHROPIC_API_KEY="build-placeholder" \
    CF_ACCESS_AUD="0000000000000000000000000000000000000000000000000000000000000000" \
    CF_ACCESS_TEAM_DOMAIN="build-placeholder.cloudflareaccess.com" \
    pnpm exec turbo run build --filter=@ledgerly/web

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
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
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

# F-31: declare the runtime user in the IMAGE, not only in the entrypoint.
#
# The privilege drop was correct for the CMD path -- entrypoint.sh execs
# `su-exec node:node` -- but the image's declared user was still root, so
# anything that did NOT traverse the entrypoint ran as uid 0: `docker
# compose exec`, the compose healthcheck, `docker run --entrypoint ...`.
# Only /app/uploads and /app/backups are chowned, so the rest of /app was
# root-writable, including server.js and the migrator.
#
# entrypoint.sh still works unchanged: its `id -u` check now takes the
# already-unprivileged branch and execs straight through (that branch exists
# because Forkd took a production 502 calling su-exec unconditionally --
# task 2.10 tests both paths).
#
# The runtime chown that branch skips is not needed for the named volumes in
# docker-compose.yml: Docker seeds a fresh named volume with the ownership
# of the image directory it is mounted over, and the chown above sets that
# to node:node at build time. An operator using a BIND mount instead must
# chown the host directory to uid/gid 1000 themselves -- DEPLOYMENT.md says
# so.
USER node

ENTRYPOINT ["/entrypoint.sh"]
CMD ["sh", "-c", "node migrate.cjs && node seed.cjs && node apps/web/server.js"]
