#!/usr/bin/env bash
#
# scripts/test-db.sh — start and migrate the local test database (D-18).
#
# Why this exists as a separate container rather than the compose stack:
# docker-compose.yml's `db` deliberately publishes no ports at all
# (ARCHITECTURE.md §8 — nothing but the Cloudflare Tunnel should be able to
# reach this instance), so host-run tests cannot connect to it. Rather than
# weaken that, tests get their own throwaway Postgres on a published
# loopback port — which is also exactly what CI does with its
# `postgres:17` service container, so local and CI runs match.
#
# Idempotent: safe to run repeatedly. Reuses a running container, restarts a
# stopped one, and re-applies migrations (a no-op when already current).
#
# Usage:
#   ./scripts/test-db.sh          start + migrate
#   ./scripts/test-db.sh --reset  destroy and recreate from scratch
#   ./scripts/test-db.sh --stop   remove the container
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=ledgerly-test-db
IMAGE=postgres:17-alpine

cd "$REPO_ROOT"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env first." >&2
  exit 1
fi

# Read only the two keys needed, rather than sourcing .env — which would
# pull every secret in the file into this shell's environment.
read_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

TEST_URL="$(read_env TEST_DATABASE_URL)"
APP_URL="$(read_env DATABASE_URL)"

if [[ -z "$TEST_URL" ]]; then
  echo "error: TEST_DATABASE_URL is not set in .env (see .env.example)." >&2
  exit 1
fi

# D-18: tests must never run against the application database. The harness
# asserts this too (packages/db/src/testHarness.ts); catching it here means
# a mistake fails before anything is created rather than mid-suite.
if [[ -n "$APP_URL" && "$TEST_URL" == "$APP_URL" ]]; then
  echo "error: TEST_DATABASE_URL must not equal DATABASE_URL (D-18)." >&2
  exit 1
fi

# postgres://USER:PASS@HOST:PORT/NAME
parse() { python3 -c "import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(getattr(p,sys.argv[2]) or '')" "$TEST_URL" "$1"; }
DB_USER="$(parse username)"
DB_PASS="$(parse password)"
DB_PORT="$(parse port)"; DB_PORT="${DB_PORT:-5432}"
DB_NAME="$(python3 -c "import sys,urllib.parse as u;print(u.urlparse(sys.argv[1]).path.lstrip('/'))" "$TEST_URL")"

case "${1:-}" in
  --stop)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "removed $CONTAINER"
    exit 0
    ;;
  --reset)
    echo "resetting $CONTAINER ..."
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    ;;
esac

state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
case "$state" in
  running) echo "$CONTAINER already running" ;;
  exited|created) echo "starting existing $CONTAINER ..."; docker start "$CONTAINER" >/dev/null ;;
  *)
    echo "creating $CONTAINER on 127.0.0.1:$DB_PORT ..."
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$DB_PASS" \
      -e POSTGRES_DB="$DB_NAME" \
      -p "127.0.0.1:$DB_PORT:5432" \
      "$IMAGE" >/dev/null
    ;;
esac

printf 'waiting for postgres '
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    echo "ready"
    break
  fi
  printf '.'
  sleep 1
done

if ! docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  echo >&2
  echo "error: $CONTAINER did not become ready in 60s. Check: docker logs $CONTAINER" >&2
  exit 1
fi

echo "applying migrations ..."
( cd packages/db && DATABASE_URL="$TEST_URL" pnpm exec tsx src/migrate.ts )

echo
echo "test database ready. Run the suite with:  pnpm test"
