#!/usr/bin/env bash
#
# scripts/test-redis.sh — start the local test Redis (Phase 5, mirrors
# scripts/test-db.sh's reasoning exactly).
#
# docker-compose.yml's `redis` deliberately publishes no ports at all
# (ARCHITECTURE.md §8), so host-run tests cannot connect to it. Tests get
# their own throwaway Redis on a published loopback port instead — which is
# also what CI does with its own redis service container, so local and CI
# runs behave the same.
#
# TEST_REDIS_URL and REDIS_URL point at the SAME container on different
# logical Redis databases (path suffix, e.g. /0 vs /1) rather than two
# containers — Redis's numbered-database mechanism is the direct analogue
# of TEST_DATABASE_URL and DATABASE_URL being two databases inside the one
# throwaway Postgres container test-db.sh manages.
#
# Idempotent: safe to run repeatedly. Reuses a running container, restarts a
# stopped one.
#
# Usage:
#   ./scripts/test-redis.sh          start
#   ./scripts/test-redis.sh --reset  destroy and recreate from scratch
#   ./scripts/test-redis.sh --stop   remove the container
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=ledgerly-test-redis
IMAGE=redis:8-alpine

cd "$REPO_ROOT"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Copy .env.example to .env first." >&2
  exit 1
fi

read_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

TEST_URL="$(read_env TEST_REDIS_URL)"
if [[ -z "$TEST_URL" ]]; then
  echo "error: TEST_REDIS_URL is not set in .env (see .env.example)." >&2
  exit 1
fi

REDIS_PORT="$(python3 -c "import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(p.port or 6379)" "$TEST_URL")"

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
    echo "creating $CONTAINER on 127.0.0.1:$REDIS_PORT ..."
    docker run -d --name "$CONTAINER" \
      -p "127.0.0.1:$REDIS_PORT:6379" \
      "$IMAGE" >/dev/null
    ;;
esac

printf 'waiting for redis '
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" redis-cli ping >/dev/null 2>&1; then
    echo "ready"
    break
  fi
  printf '.'
  sleep 1
done

if ! docker exec "$CONTAINER" redis-cli ping >/dev/null 2>&1; then
  echo >&2
  echo "error: $CONTAINER did not become ready in 30s. Check: docker logs $CONTAINER" >&2
  exit 1
fi

echo
echo "test redis ready. Run the suite with:  pnpm test"
