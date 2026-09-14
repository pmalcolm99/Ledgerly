#!/bin/sh
# docker/entrypoint.sh — drops privileges after fixing volume ownership,
# but only when actually starting as root.
#
# Forkd took a production 502 from calling su-exec unconditionally: when the
# container is started with a `user:` override (already non-root), su-exec
# itself requires root to change user and fails outright. Checking `id -u`
# first is what makes both paths work — the default root start (chown, then
# drop to node) and a `user: "1000:1000"` compose override (already
# unprivileged, so skip straight to exec) — docker-compose.yml deliberately
# sets neither, but task 2.10 tests both.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p "${UPLOADS_DIR:-/app/uploads}" "${BACKUPS_DIR:-/app/backups}"
  chown -R node:node "${UPLOADS_DIR:-/app/uploads}" "${BACKUPS_DIR:-/app/backups}"
  exec su-exec node:node "$@"
else
  # Already unprivileged -- which is now the DEFAULT, because the image
  # declares `USER node` (Phase 10a, F-31). We cannot chown from here, but we
  # can still create the directories if their parent is writable, which is
  # what a fresh bind mount needs. `|| true` because failing to create them
  # is not necessarily fatal: a named volume already has them, correctly
  # owned, seeded from the image.
  #
  # A bind mount whose host directory is owned by someone else cannot be
  # fixed from inside the container at all. DEPLOYMENT.md §1.5 says to chown
  # it to 1000:1000 on the host; without that the first upload fails EACCES
  # while the container still looks healthy.
  mkdir -p "${UPLOADS_DIR:-/app/uploads}" "${BACKUPS_DIR:-/app/backups}" 2>/dev/null || true
  exec "$@"
fi
