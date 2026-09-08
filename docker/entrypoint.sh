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
  exec "$@"
fi
