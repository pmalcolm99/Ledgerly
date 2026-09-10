#!/usr/bin/env bash
#
# scripts/restore.sh — restore a Ledgerly backup archive (Phase 9, task 9.5).
#
# The reason this is a script in the repository and not a paragraph in
# DEPLOYMENT.md: a restore procedure that only exists as prose is a procedure
# nobody has ever run. This one is what the Phase 9 restore drill exercises, so
# the thing that gets tested and the thing an operator reaches for at 2am are
# the same file.
#
# It validates the archive against its own manifest.json BEFORE touching a
# database, refuses a non-empty target unless told otherwise, and handles the
# case where the backup predates the current schema by migrating forward rather
# than failing somewhere deep in a SQL error.
#
# Two targets, auto-detected:
#
#   ./scripts/restore.sh backup.tgz
#       The running compose stack. Restores into the `db` service and replaces
#       the webapp's /app/uploads. This is the deployment case.
#
#   ./scripts/restore.sh backup.tgz --database-url postgres://…/scratch \
#                                   --uploads-dir ./tmp/uploads
#       Anywhere. This is the drill case, and the reason the drill can exercise
#       this script rather than a hand-run pg_restore.
#
# Usage:
#   ./scripts/restore.sh <archive.tgz> [options]
#
#   --database-url URL   Restore into this database instead of the compose stack
#   --uploads-dir DIR    Replace this directory's contents from the archive
#                        (default: the compose stack's app_uploads volume)
#   --force              Proceed even though the target database is not empty.
#                        WITHOUT this, a non-empty target is refused.
#   --ignore-checksum    Proceed even though a member file's SHA-256 does not
#                        match the manifest. For the disaster where a damaged
#                        archive is all that exists — never routine.
#   --skip-uploads       Restore the database only, leaving images untouched.
#   --yes                Do not prompt for confirmation.
#
# MASTER_KEY IS NOT IN THE ARCHIVE and cannot be recovered from it. The
# app_config table restores with its values still encrypted; without the same
# MASTER_KEY the Claude API key and SMTP password must be entered again by
# hand. See SETUP.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Captured BEFORE the cd below, and every path argument is resolved against it.
# Without this, `--uploads-dir ./scratch-uploads` would resolve against the repo
# root instead of the operator's shell — and line ~330 runs `find … -delete` on
# whatever that turns out to be, then verifies the image count in the same wrong
# place and reports the restore verified.
INVOCATION_CWD="$PWD"
cd "$REPO_ROOT"

# Resolves a path argument against the operator's original directory. Does not
# require the path to exist (--uploads-dir may be created).
abspath() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *)  printf '%s/%s\n' "${INVOCATION_CWD%/}" "$1" ;;
  esac
}

ARCHIVE=""
DATABASE_URL_ARG=""
UPLOADS_DIR_ARG=""
FORCE=0
IGNORE_CHECKSUM=0
SKIP_UPLOADS=0
ASSUME_YES=0

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url) DATABASE_URL_ARG="${2:-}"; shift 2 ;;
    --uploads-dir)  UPLOADS_DIR_ARG="${2:-}"; shift 2 ;;
    --force)           FORCE=1; shift ;;
    --ignore-checksum) IGNORE_CHECKSUM=1; shift ;;
    --skip-uploads)    SKIP_UPLOADS=1; shift ;;
    --yes|-y)          ASSUME_YES=1; shift ;;
    -h|--help)      sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)             die "unknown option: $1" ;;
    *)
      [[ -z "$ARCHIVE" ]] || die "more than one archive given"
      ARCHIVE="$1"; shift ;;
  esac
done

[[ -n "$ARCHIVE" ]] || die "no archive given. Usage: ./scripts/restore.sh <archive.tgz> [options]"
ARCHIVE="$(abspath "$ARCHIVE")"
[[ -f "$ARCHIVE" ]] || die "no such file: $ARCHIVE"
[[ -z "$UPLOADS_DIR_ARG" ]] || UPLOADS_DIR_ARG="$(abspath "$UPLOADS_DIR_ARG")"

for tool in tar python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not on PATH"
done

# --------------------------------------------------------------------------
# Mode. Direct when --database-url is given, compose otherwise.
# --------------------------------------------------------------------------
if [[ -n "$DATABASE_URL_ARG" ]]; then
  MODE=direct
  for tool in pg_restore psql; do
    command -v "$tool" >/dev/null 2>&1 ||
      die "$tool is required for --database-url (install postgresql-client)"
  done

  # Split the URI once, here, and pass discrete flags from now on with the
  # password only ever in PGPASSWORD.
  #
  # `psql "postgres://user:pass@host/db"` puts the password in argv, where any
  # user on the box can read it out of /proc for the lifetime of the process.
  # `pipeline/backup.ts`'s pgEnvAndFlags exists to avoid exactly that on the
  # backup side; the restore side must not undo it, least of all in the example
  # SETUP.md tells operators to type.
  eval "$(python3 -c "
import shlex, sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
if not p.hostname or not p.path.lstrip('/'):
    sys.exit('bad --database-url')
def emit(name, value):
    print(f'{name}={shlex.quote(value)}')
emit('PG_HOST', p.hostname)
emit('PG_PORT', str(p.port or 5432))
emit('PG_DB', u.unquote(p.path.lstrip('/')))
emit('PG_USER', u.unquote(p.username) if p.username else '')
emit('PG_PASSWORD', u.unquote(p.password) if p.password else '')
" "$DATABASE_URL_ARG")" || die "could not parse --database-url"
  [[ -n "${PG_HOST:-}" ]] || die "could not parse --database-url"
  PG_FLAGS=(-h "$PG_HOST" -p "$PG_PORT" -d "$PG_DB")
  [[ -z "$PG_USER" ]] || PG_FLAGS+=(-U "$PG_USER")
  [[ -z "$PG_PASSWORD" ]] || export PGPASSWORD="$PG_PASSWORD"
  # Dropped from the shell now that it lives in PGPASSWORD, so nothing later can
  # interpolate it back into a command line by accident.
  unset PG_PASSWORD
  DATABASE_URL_ARG_PRESENT=1
else
  MODE=compose
  command -v docker >/dev/null 2>&1 || die "docker is required for the compose-stack mode"
  docker compose ps --status running --services 2>/dev/null | grep -qx db ||
    die "the compose stack's 'db' service is not running. Start it, or pass --database-url."
  [[ -f .env ]] || die ".env not found — needed for POSTGRES_USER/POSTGRES_DB."
  # Read only the keys needed, rather than sourcing .env, which would pull
  # every secret in the file into this shell (scripts/test-db.sh does the same).
  # `|| true` is load-bearing: under `set -e` a `grep` that matches nothing
  # exits 1 and takes the whole script with it, so the explicit `die` below
  # would never be reached and the operator would get a bare exit instead of a
  # message. Strips both quote styles.
  read_env() {
    grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//" || true
  }
  PG_USER="$(read_env POSTGRES_USER)"
  PG_DB="$(read_env POSTGRES_DB)"
  [[ -n "$PG_USER" && -n "$PG_DB" ]] || die "POSTGRES_USER and POSTGRES_DB must be set in .env"
fi

# Runs psql against whichever target is in play and prints the single value the
# query selects. One definition so every check below cannot drift between modes.
psql_value() {
  local query="$1"
  if [[ "$MODE" == direct ]]; then
    psql "${PG_FLAGS[@]}" -Atqc "$query"
  else
    docker compose exec -T db psql -U "$PG_USER" -d "$PG_DB" -Atqc "$query"
  fi
}

# --------------------------------------------------------------------------
# Extract. A temp directory, removed on any exit.
# --------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ledgerly-restore-XXXXXX")"
WEBAPP_STOPPED=0
cleanup() {
  rm -rf "$WORK"
  # If we stopped the app and then died, bring it back. Leaving an operator with
  # a half-restored database AND a stopped app is strictly worse than either.
  if [[ "$WEBAPP_STOPPED" == 1 ]]; then
    echo "==> restarting the webapp after an aborted restore" >&2
    docker compose start webapp >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

say "extracting $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$WORK"

MANIFEST="$WORK/manifest.json"
[[ -f "$MANIFEST" ]] ||
  die "no manifest.json in the archive. This is not a Ledgerly backup, or it is truncated."
DUMP="$WORK/db.dump"
[[ -f "$DUMP" ]] || die "no db.dump in the archive."

# One python invocation per field, reading the manifest rather than grepping it
# — a JSON parser will not be fooled by a value that happens to look like a key.
mf() { python3 -c "
import json,sys
with open(sys.argv[1]) as f: m = json.load(f)
cur = m
for key in sys.argv[2].split('.'):
    cur = (cur or {}).get(key) if isinstance(cur, dict) else None
# json.dumps for a bool so it prints 'true', not Python's 'True' — the shell
# comparisons below read like the manifest they came from.
print('' if cur is None else json.dumps(cur) if isinstance(cur, bool) else cur)
" "$MANIFEST" "$1"; }

MF_VERSION="$(mf manifestVersion)"
MF_APP="$(mf app)"
MF_CREATED="$(mf createdAt)"
MF_KIND="$(mf kind)"
MF_MIGRATIONS="$(mf schema.appliedMigrations)"
MF_IMAGES_INCLUDED="$(mf images.included)"
MF_IMAGE_COUNT="$(mf images.count)"

# --------------------------------------------------------------------------
# The manifest has to be one this script UNDERSTANDS, and it has to have
# something in it.
#
# `pipeline/backup.ts` writes `manifestVersion` and `app` precisely so a reader
# can refuse a shape it does not know, and both verification loops below are
# `while … done < <(python3 …)` over `files` and `tables` — which, given an
# empty or renamed list, simply never execute their bodies. The counters stay
# at zero, and the script prints "restore verified against the manifest" having
# verified exactly nothing, after overwriting the target. Demonstrated during
# the Phase 9 review with a manifest whose keys had been renamed.
#
# A verification step that silently degrades to a no-op is worse than no
# verification step, because it is the one line the operator reads.
# --------------------------------------------------------------------------
[[ "$MF_APP" == "ledgerly" ]] ||
  die "manifest.json is not a Ledgerly manifest (app=\"${MF_APP:-missing}\")."
[[ "$MF_VERSION" == "1" ]] ||
  die "manifest.json is version \"${MF_VERSION:-missing}\"; this script understands version 1.
       Use the version of Ledgerly that wrote this archive."

MF_FILE_COUNT="$(python3 -c "
import json,sys
with open(sys.argv[1]) as f: m = json.load(f)
print(len(m.get('files') or []))
" "$MANIFEST")"
MF_TABLE_COUNT="$(python3 -c "
import json,sys
with open(sys.argv[1]) as f: m = json.load(f)
print(len(m.get('tables') or {}))
" "$MANIFEST")"
[[ "$MF_FILE_COUNT" -gt 0 ]] ||
  die "manifest.json lists no files to verify. Refusing — there would be nothing to check."
[[ "$MF_TABLE_COUNT" -gt 0 ]] ||
  die "manifest.json lists no table row counts. Refusing — the restore could not be verified."

say "archive: created $MF_CREATED ($MF_KIND kind)"
say "archive: schema at ${MF_MIGRATIONS:-unknown} applied migration(s)"
if [[ "$MF_IMAGES_INCLUDED" == "true" ]]; then
  say "archive: $MF_IMAGE_COUNT image file(s) included"
else
  # Said out loud rather than left to be noticed later. A restore that silently
  # produces every receipt with no image is the kind of success that gets
  # discovered months afterwards.
  say "archive: NO images (this backup was taken with BACKUP_INCLUDE_IMAGES=false)"
fi

# --------------------------------------------------------------------------
# Validate every member against the manifest's checksums, BEFORE any write.
# --------------------------------------------------------------------------
say "verifying checksums ($MF_FILE_COUNT file(s) listed)"
CHECKSUM_FAILED=0
CHECKED_FILES=0
while IFS='|' read -r name expected; do
  [[ -n "$name" ]] || continue
  CHECKED_FILES=$((CHECKED_FILES + 1))
  target="$WORK/$name"
  if [[ ! -f "$target" ]]; then
    echo "  MISSING  $name (the manifest lists it and the archive does not contain it)" >&2
    CHECKSUM_FAILED=1
    continue
  fi
  actual="$(python3 -c "
import hashlib,sys
h = hashlib.sha256()
with open(sys.argv[1], 'rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
print(h.hexdigest())
" "$target")"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ok       $name"
  else
    echo "  MISMATCH $name" >&2
    echo "           manifest: $expected" >&2
    echo "           actual:   $actual" >&2
    CHECKSUM_FAILED=1
  fi
done < <(python3 -c "
import json,sys
with open(sys.argv[1]) as f: m = json.load(f)
for entry in m.get('files', []): print(f\"{entry['name']}|{entry['sha256']}\")
" "$MANIFEST")

# The loop above runs in a subshell-free `while` over a process substitution, so
# a zero-iteration run is silent. Count what was actually checked and compare.
[[ "$CHECKED_FILES" == "$MF_FILE_COUNT" ]] ||
  die "verified $CHECKED_FILES of $MF_FILE_COUNT manifest entries. Refusing."

if [[ "$CHECKSUM_FAILED" == 1 ]]; then
  if [[ "$IGNORE_CHECKSUM" == 1 ]]; then
    echo "warning: checksum verification FAILED and --ignore-checksum was given." >&2
    echo "warning: this archive is damaged. Restoring it anyway; expect data loss." >&2
  else
    die "checksum verification failed — refusing to restore a damaged archive.
       If this archive is all you have, re-run with --ignore-checksum."
  fi
fi

# --------------------------------------------------------------------------
# Refuse a non-empty target without --force.
# --------------------------------------------------------------------------
EXISTING_TABLES="$(psql_value "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
EXISTING_TABLES="${EXISTING_TABLES//[[:space:]]/}"
if [[ "${EXISTING_TABLES:-0}" -gt 0 ]]; then
  if [[ "$FORCE" != 1 ]]; then
    # Print what was found rather than only declining. An operator who is about
    # to overwrite a database deserves to see what is in it first.
    echo "The target database is NOT empty: $EXISTING_TABLES table(s) in schema public." >&2
    RECEIPTS="$(psql_value "SELECT count(*) FROM receipts" 2>/dev/null || echo "?")"
    USERS="$(psql_value "SELECT count(*) FROM users" 2>/dev/null || echo "?")"
    echo "  receipts: ${RECEIPTS//[[:space:]]/}   users: ${USERS//[[:space:]]/}" >&2
    die "refusing to overwrite it. Re-run with --force if that is what you want."
  fi
  say "target has $EXISTING_TABLES table(s); --force given, they will be replaced"
fi

if [[ "$ASSUME_YES" != 1 ]]; then
  if [[ "$MODE" == direct ]]; then
    target_label="$PG_HOST:$PG_PORT/$PG_DB"
  else
    target_label="compose stack db/$PG_DB"
  fi
  echo "About to restore $(basename "$ARCHIVE"):"
  echo "  database: $target_label   (will be DROPPED and recreated)"
  # Named explicitly, because this is a recursive delete and an earlier version
  # of this script confirmed only the database — so the one argument that
  # silently erases a directory was the one the operator never saw.
  if [[ "$SKIP_UPLOADS" == 1 ]]; then
    echo "  images:   left untouched (--skip-uploads)"
  elif [[ -n "$UPLOADS_DIR_ARG" ]]; then
    echo "  images:   $UPLOADS_DIR_ARG   (CONTENTS WILL BE DELETED and replaced)"
  else
    echo "  images:   the webapp container's /app/uploads   (CONTENTS WILL BE DELETED and replaced)"
  fi
  printf 'Proceed? [y/N] '
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "aborted."
fi

# --------------------------------------------------------------------------
# M-8: stop the app before rewriting the database underneath it.
#
# `pg_restore --clean` drops and recreates every object while the webapp is
# serving requests, its workers are processing jobs, and every request is
# writing audit_log rows into the database being replaced. The DROPs contend
# with those connections, and the row-count verification at the end races the
# same writes — so a perfectly good restore can report a mismatch on audit_log
# and refuse to call itself verified.
# --------------------------------------------------------------------------
if [[ "$MODE" == compose ]]; then
  say "stopping the webapp for the duration of the restore"
  docker compose stop webapp
  WEBAPP_STOPPED=1
fi

# --------------------------------------------------------------------------
# Restore the database.
# --------------------------------------------------------------------------
say "restoring the database"
# --clean --if-exists drops and recreates every object, tolerating the benign
# "does not exist" notices on a fresh target. --no-owner/--no-privileges so the
# archive restores under whatever role is connecting, which is what lets the
# same file go into a scratch database owned by someone else.
#
# pg_restore exits non-zero on warnings it considers errors even when the
# restore succeeded (a DROP of something absent, most commonly), so its status
# is captured and reported rather than allowed to kill the script under `set
# -e`. The real verification is the row counts at the end.
set +e
if [[ "$MODE" == direct ]]; then
  pg_restore --clean --if-exists --no-owner --no-privileges "${PG_FLAGS[@]}" "$DUMP"
  RESTORE_STATUS=$?
else
  # mktemp rather than a fixed name: this file is the whole database in the
  # clear, sitting in a world-readable /tmp inside the container until the rm
  # below. A predictable path is a predictable window.
  REMOTE_DUMP="$(docker compose exec -T db mktemp /tmp/ledgerly-restore-XXXXXX.dump | tr -d '\r\n')"
  docker compose cp "$DUMP" "db:$REMOTE_DUMP"
  docker compose exec -T db pg_restore --clean --if-exists --no-owner --no-privileges \
    -U "$PG_USER" -d "$PG_DB" "$REMOTE_DUMP"
  RESTORE_STATUS=$?
  docker compose exec -T db rm -f "$REMOTE_DUMP" || true
fi
set -e
if [[ "$RESTORE_STATUS" != 0 ]]; then
  echo "note: pg_restore exited $RESTORE_STATUS. That is common and usually benign —" >&2
  echo "      --clean reports a warning for every object it could not drop because" >&2
  echo "      it did not exist yet. The row counts below are what decide it." >&2
fi

# --------------------------------------------------------------------------
# Schema version. The case the brief asks to be handled in words rather than a
# cryptic SQL error.
# --------------------------------------------------------------------------
CODE_MIGRATIONS="$(ls -1 packages/db/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
RESTORED_MIGRATIONS="$(psql_value "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo "")"
RESTORED_MIGRATIONS="${RESTORED_MIGRATIONS//[[:space:]]/}"

if [[ -z "$RESTORED_MIGRATIONS" ]]; then
  echo "warning: the restored database has no drizzle.__drizzle_migrations table, so its" >&2
  echo "         schema version is unknown. Run migrations by hand before starting the app." >&2
elif [[ "$RESTORED_MIGRATIONS" -lt "$CODE_MIGRATIONS" ]]; then
  say "this backup predates the current schema: $RESTORED_MIGRATIONS applied, $CODE_MIGRATIONS in this checkout"
  say "migrating forward ($((CODE_MIGRATIONS - RESTORED_MIGRATIONS)) migration(s) to apply)"
  if [[ "$MODE" == direct ]]; then
    # The one place the full URI is unavoidable — the migrator takes
    # DATABASE_URL. Passed through the ENVIRONMENT, not on the command line, so
    # it does not land in argv the way `DATABASE_URL=… cmd` in a `ps` listing
    # would suggest it might.
    ( cd packages/db && DATABASE_URL="$DATABASE_URL_ARG" exec pnpm exec tsx src/migrate.ts )
  else
    # The image ships the same migrator the container runs at boot.
    docker compose exec -T webapp node migrate.cjs
  fi
  say "migrated"
elif [[ "$RESTORED_MIGRATIONS" -gt "$CODE_MIGRATIONS" ]]; then
  # Refused rather than attempted. Migrations are forward-only (CLAUDE.md), so
  # there is nothing honest to do here: the archive was written by a newer
  # version of the app than this checkout, and the app would fail against a
  # schema it does not understand in ways this script cannot predict.
  echo "error: this backup is NEWER than the code in this checkout." >&2
  echo "       archive: $RESTORED_MIGRATIONS applied migrations; checkout: $CODE_MIGRATIONS." >&2
  echo "       Migrations are forward-only. Check out the matching version of Ledgerly" >&2
  echo "       (or newer) and run this again. The database has been restored but the app" >&2
  echo "       must not be started against it from here." >&2
  exit 1
else
  say "schema version matches this checkout ($CODE_MIGRATIONS migrations)"
fi

# --------------------------------------------------------------------------
# Uploads.
# --------------------------------------------------------------------------
UPLOADS_TAR="$WORK/uploads.tar"
if [[ "$SKIP_UPLOADS" == 1 ]]; then
  say "skipping images (--skip-uploads)"
elif [[ ! -f "$UPLOADS_TAR" ]]; then
  echo "note: no uploads.tar in this archive, so images were NOT restored." >&2
  echo "      Receipt rows will reference renders that do not exist on disk." >&2
elif [[ -n "$UPLOADS_DIR_ARG" ]]; then
  say "replacing images in $UPLOADS_DIR_ARG"
  mkdir -p "$UPLOADS_DIR_ARG"
  # Emptied first: a merge would leave images from the old instance behind,
  # which is not a restore of the archive, it is a union with whatever was
  # there. `find -delete` rather than `rm -rf "$dir"` so a bind-mounted
  # directory keeps its inode and its permissions.
  find "$UPLOADS_DIR_ARG" -mindepth 1 -delete
  tar -xf "$UPLOADS_TAR" -C "$UPLOADS_DIR_ARG"
else
  say "replacing images in the webapp container's /app/uploads"
  docker compose exec -T webapp sh -c 'find /app/uploads -mindepth 1 -delete'
  docker compose cp "$UPLOADS_TAR" webapp:/tmp/ledgerly-uploads.tar
  # chown after extracting, and it is not optional. `docker compose exec`
  # bypasses the entrypoint, so this shell is ROOT — the entrypoint's su-exec
  # drop only applies to the CMD. Without the chown, every restored image is
  # root-owned and the app, which runs as node, cannot write a new render
  # beside them. The failure would show up as the next upload silently failing.
  docker compose exec -T webapp sh -c 'tar -xf /tmp/ledgerly-uploads.tar -C /app/uploads && rm -f /tmp/ledgerly-uploads.tar && chown -R node:node /app/uploads'
fi

# --------------------------------------------------------------------------
# Verify against the manifest. This is the part that makes a restore a fact
# rather than a hope.
# --------------------------------------------------------------------------
say "verifying row counts against the manifest ($MF_TABLE_COUNT table(s) listed)"
MISMATCHES=0
CHECKED_TABLES=0
while IFS='|' read -r table expected; do
  [[ -n "$table" ]] || continue
  CHECKED_TABLES=$((CHECKED_TABLES + 1))
  actual="$(psql_value "SELECT count(*) FROM \"$table\"" 2>/dev/null || echo "ERR")"
  actual="${actual//[[:space:]]/}"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok       %-16s %s\n' "$table" "$actual"
  else
    printf '  MISMATCH %-16s manifest %s, restored %s\n' "$table" "$expected" "$actual" >&2
    MISMATCHES=$((MISMATCHES + 1))
  fi
done < <(python3 -c "
import json,sys
with open(sys.argv[1]) as f: m = json.load(f)
for table, count in sorted(m.get('tables', {}).items()): print(f'{table}|{count}')
" "$MANIFEST")

if [[ "$MF_IMAGES_INCLUDED" == "true" && "$SKIP_UPLOADS" != 1 ]]; then
  if [[ -n "$UPLOADS_DIR_ARG" ]]; then
    restored_images="$(find "$UPLOADS_DIR_ARG" -type f | wc -l | tr -d ' ')"
  else
    restored_images="$(docker compose exec -T webapp sh -c 'find /app/uploads -type f | wc -l' | tr -d ' \r')"
  fi
  if [[ "$restored_images" == "$MF_IMAGE_COUNT" ]]; then
    printf '  ok       %-16s %s\n' "images" "$restored_images"
  else
    printf '  MISMATCH %-16s manifest %s, restored %s\n' \
      "images" "$MF_IMAGE_COUNT" "$restored_images" >&2
    MISMATCHES=$((MISMATCHES + 1))
  fi
fi

[[ "$CHECKED_TABLES" == "$MF_TABLE_COUNT" ]] ||
  die "checked $CHECKED_TABLES of $MF_TABLE_COUNT tables. The restore is NOT verified."

if [[ "$MISMATCHES" -gt 0 ]]; then
  die "$MISMATCHES mismatch(es) against the manifest. The restore is NOT verified."
fi

say "restore verified against the manifest"
if [[ "$MODE" == compose ]]; then
  say "starting the webapp again"
  docker compose start webapp
  WEBAPP_STOPPED=0
  echo
  echo "note: Redis still holds whatever job state predates this restore, and Redis is"
  echo "      not part of any backup (D-08). A job referring to a receipt id that no"
  echo "      longer exists simply fails and is logged; the worker's startup sweep"
  echo "      re-enqueues anything genuinely pending. If that noise is unwelcome,"
  echo "      \`docker compose exec redis redis-cli FLUSHALL\` before starting the app."
fi
echo
echo "Done. Remember: MASTER_KEY is not in the archive. If this instance does not"
echo "have the same MASTER_KEY the backup was taken under, the Claude API key and"
echo "SMTP settings must be entered again from the admin screen."
