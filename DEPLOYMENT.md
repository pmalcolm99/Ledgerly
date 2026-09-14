# Deploying and operating Ledgerly

This is the operations manual. `SETUP.md` gets a fresh instance running;
this covers everything after that — upgrades, rollback, backup and restore,
where the logs are, and the failures this project actually hit while it was
being built.

The troubleshooting section is deliberately specific. Every entry in it is a
problem that really happened here, with the symptom as it actually presented,
because a generic checklist is no use at 2am and the problems you will hit are
the ones already hit once.

---

## 1. Production deployment

### 1.1 What runs where

One machine runs four processes:

| Process       | What it is                   | Exposure                          |
| ------------- | ---------------------------- | --------------------------------- |
| `cloudflared` | The tunnel. Outbound only.   | Host process or its own container |
| `webapp`      | Next.js + the BullMQ workers | Bound to `127.0.0.1:${APP_PORT}`  |
| `db`          | PostgreSQL 17                | No published ports                |
| `redis`       | Redis 8                      | No published ports                |

`db` and `redis` publish nothing. `webapp` binds to loopback only. The **only**
path in from the internet is the tunnel, and Cloudflare Access sits in front
of it.

### 1.2 Deploying

```bash
git pull
docker compose up -d --build
docker compose logs -f webapp
```

Migrations run automatically at container start, before the server begins
listening. They are forward-only and are never edited after being applied.

### 1.3 Verifying a deploy

```bash
curl -s localhost:3000/api/v1/health
docker compose ps
```

Expect healthy status, and every service `running` with none restarting. Then
check the build actually changed: **Admin → Logs** shows the running build's
version and commit SHA. If it still shows the old SHA, you are running the old
image — see 2.4.

### 1.4 Running as a service

`restart: always` brings the stack back after a reboot, provided the Docker
daemon starts at boot. `cloudflared` needs the same treatment:

```bash
# macOS
brew services start cloudflared

# Linux
sudo cloudflared service install
```

Verify by rebooting and confirming the site answers without you touching
anything. An instance that only works until the next power cut is not
deployed.

### 1.5 Container hardening

The image declares `USER node`, so the container runs unprivileged. Compose
adds `no-new-privileges:true` and `cap_drop: ALL`.

One consequence worth knowing: **named volumes inherit ownership correctly,
bind mounts do not.** Docker seeds a fresh named volume from the image
directory it covers, and the image chowns `/app/uploads` and `/app/backups` to
`node` at build time. If you swap a named volume for a bind mount, chown the
host directory yourself:

```bash
sudo chown -R 1000:1000 /your/host/path
```

Otherwise nothing looks wrong and everything is: the container starts, the
healthcheck passes (it touches neither directory), and then **every upload
fails with EACCES** writing `staging.bin` — and so does **the nightly backup
job**, which is the quieter and more damaging half, because nobody is watching
it. Check `docker compose logs webapp | grep EACCES` if uploads fail on a
fresh bind-mount deployment.

---

## 2. Upgrades and rollback

### 2.1 Before any upgrade

```bash
# Take a backup and confirm it completed.
docker compose exec webapp node -e "process.exit(0)"   # container is alive
# Then: Admin → Backups → Back up now, and wait for status "complete".

# Note the SHA you are on, so you know what to roll back to.
git rev-parse --short HEAD
docker compose images webapp
```

Write the SHA down. This is the only step people skip and the only one they
regret.

### 2.2 Upgrading

```bash
git pull
docker compose up -d --build
docker compose logs -f webapp
```

Watch for the migration lines. If a migration fails the container will not
start serving — which is correct, and is why you took the backup.

### 2.3 Rolling back code

CI publishes two tags for every push to `main`:

- `ghcr.io/<owner>/ledgerly:latest` — moves every build
- `ghcr.io/<owner>/ledgerly:<git-sha>` — immutable

Roll back by pinning the SHA:

```bash
IMAGE_LOCATION=ghcr.io/<owner>/ledgerly:<previous-sha> docker compose up -d
```

Or persist it by setting `IMAGE_LOCATION` in `.env`.

> **Rolling back code does not roll back the database.** Migrations are
> forward-only by design. If the newer version added a migration, the older
> code is running against a newer schema — usually fine (added columns are
> ignored), sometimes not. If a migration is involved, restore the backup from
> 2.1 rather than only pinning an older image.

### 2.4 "I deployed but nothing changed"

Almost always a stale image. `docker compose up -d` alone does not rebuild:

```bash
docker compose up -d --build            # rebuild from local source
docker compose pull && docker compose up -d   # or pull the published image
```

Confirm via **Admin → Logs**, which shows the running commit SHA.

### 2.5 Updating the pinned base images

Base images are pinned by digest in `docker/Dockerfile` and
`docker-compose.yml`, so a rebuild is reproducible and an upstream repush
cannot change your image underneath you. Updating them is a deliberate act:

```bash
docker manifest inspect -v node:22-alpine | grep -m1 '"digest"'
```

Take the **`.Descriptor.digest`** — the multi-arch index digest, so it stays
correct on both arm64 and amd64 — update the `FROM` line, and commit it on its
own. Do the same for `postgres:17-alpine` and `redis:8-alpine`.

Pin the app image too if you want a fully reproducible stack; `IMAGE_LOCATION`
accepts a digest as readily as a tag.

---

## 3. Backup and restore operations

### 3.1 What is in an archive

A `.tgz` containing a `pg_dump` of the whole database, a `manifest.json` with
per-member SHA-256 checksums and row counts, and — **only if
`BACKUP_INCLUDE_IMAGES=true`** — a tar of the uploads directory. A `.sha256`
sidecar sits beside the archive for verifying it after it has been copied
somewhere else, which is the operation that actually corrupts backups.

Both the archive and the sidecar are written `0600`.

### 3.2 What is _not_ in an archive

**`MASTER_KEY`.** Deliberately: a backup carrying its own decryption key is not
a safeguard. The `app_config` table restores with its values still encrypted,
so on a machine without the same `MASTER_KEY` the Claude API key and the SMTP
password come back as unreadable ciphertext and must be re-entered by hand.
Everything else restores.

Keep `MASTER_KEY` somewhere independent of both the machine and the backups.

### 3.3 Archives are not encrypted

They are `0600` on disk, but file permissions do not travel with a file. Once
you download an archive through the admin UI or sync it to cloud storage, it is
the entire instance in cleartext — every user, every email address, every
receipt, every `card_last4` — readable by anyone who has it.

If that matters for where you store them, encrypt them yourself on the way out:

```bash
age -r <your-age-recipient> -o backup.tgz.age backup.tgz
# or
gpg --symmetric --cipher-algo AES256 backup.tgz
```

Use a key that is **not** `MASTER_KEY`, for the same reason `MASTER_KEY` is not
in the archive: a backup you cannot decrypt without the key that was lost with
the machine is not a backup.

### 3.4 Taking a backup

Scheduled: **Admin → Backups**, set a cron (`0 3 * * *` for 3am). Stored in the
database, effective without a restart. Nothing is backed up until you set it.

On demand: **Admin → Backups → Back up now.**

Retention is `BACKUP_RETENTION_DAYS` (default 30). The same job that writes a
new archive unlinks expired ones and soft-deletes their rows.

### 3.5 Restoring

```bash
./scripts/restore.sh <archive.tgz> [options]
```

| Option               | What it does                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--database-url URL` | Restore into this database instead of the Compose stack                                                                   |
| `--uploads-dir DIR`  | Replace this directory's contents from the archive                                                                        |
| `--force`            | Proceed although the target database is not empty. **Without this a non-empty target is refused.**                        |
| `--ignore-checksum`  | Proceed although a member failed its SHA-256. For the disaster where a damaged archive is all that exists. Never routine. |
| `--skip-uploads`     | Database only, images untouched                                                                                           |
| `--yes`              | No confirmation prompt                                                                                                    |

**Into the live stack** (the real-disaster case):

```bash
docker compose stop webapp
./scripts/restore.sh /path/to/backup.tgz --force
docker compose start webapp
```

Stop `webapp` first. Restoring underneath a running app gives you a worker
mid-job writing into a database being replaced.

**Into a scratch database** (the rehearsal):

```bash
docker compose exec db psql -U ledgerly -d ledgerly -c 'CREATE DATABASE ledgerly_drill;'
mkdir -p /tmp/ledgerly-drill-uploads
./scripts/restore.sh /path/to/backup.tgz \
  --database-url postgres://ledgerly:<password>@localhost:5432/ledgerly_drill \
  --uploads-dir /tmp/ledgerly-drill-uploads
```

The script verifies the archive checksum, verifies each member against the
manifest, restores, and then compares row counts per table against the
manifest. That comparison is the point — a restore that "succeeded" while
silently dropping a table is the failure worth catching.

### 3.6 Rehearse it

Run 3.5's scratch restore on a schedule you will actually keep — quarterly is
plenty. Record the date, the archive, the row counts and the elapsed time.
`docs/private/` is gitignored and is the right place for that note.

CI runs the same round trip on every push (`backupRoundTrip.test.ts`) and
**fails the build if the drill did not run**, so a silently-skipped drill can
no longer pass for a passing one. That covers the code; it does not cover your
actual archives on your actual disk. Do both.

---

## 4. Logs

### 4.1 Container logs

```bash
docker compose logs -f webapp          # app + workers
docker compose logs -f db
docker compose logs -f redis
docker compose logs --since 1h webapp
docker compose logs webapp | grep '\[ledgerly\]'
```

Everything the app writes is prefixed `[ledgerly]`. These logs go to Docker's
json-file driver — i.e. the host disk — and **rotate only if you configure
rotation**. On a long-lived instance, set `logging.options.max-size` in
`docker-compose.yml` or configure the daemon.

### 4.2 In-app logs

**Admin → Logs** shows two things the container logs do not:

- the **event log** — uploads, extractions, exports, backups, failures
- the **audit log** — permission grants, deletions, exports

Both are retained for `LOG_RETENTION_DAYS` (default 90) and then hard-deleted
by the nightly job and by the worker at boot. After that window, "who deleted
that receipt" is no longer answerable — raise it if that matters more than
table size.

The same screen shows the running build's version and commit SHA. Check it
first whenever a deploy seems not to have taken.

### 4.3 Tunnel logs

```bash
# foreground
cloudflared tunnel run ledgerly

# as a service
brew services info cloudflared          # macOS
journalctl -u cloudflared -f            # Linux
```

### 4.4 What is never logged

The Anthropic API key, `MASTER_KEY`, the SMTP password, and full card numbers.
Card numbers are stripped before anything is persisted or logged. Provider
errors are logged as status/type/message only, never the whole error object —
an SDK error can carry request headers, and that is how an API key ends up in
a log file.

---

## 5. Troubleshooting

Every entry here is a failure that actually occurred during this build.

### 5.1 `webapp` restarts in a loop

Read the logs before anything else:

```bash
docker compose logs --tail 50 webapp
```

Configuration is validated at boot and a bad value **refuses to start** rather
than failing later mid-request. With `restart: always`, "refuses to start"
looks like a crash loop. The message names the variable.

The most common cause is **`DEV_AUTH_BYPASS=true` in `.env`**. The production
container is built with `NODE_ENV=production` baked into the server bundle, so
the bypass is rejected at startup no matter what `.env` says about `NODE_ENV`.
That is the guard working. Set it to `false`.

`DEV_AUTH_BYPASS` only ever works under `pnpm dev` on a development machine.
It is not a way to look at the production container. And never point a dev
server with the bypass on at a database that will become production: the bypass
identity is a fixed `sub`, so it will win the first-owner election permanently
and a unique constraint then blocks promoting the real person without a manual
database change.

### 5.2 "CF_ACCESS_AUD must be 64 hex characters"

You have copied the wrong value. The **AUD tag** belongs to the Access
_application_ (Zero Trust → Access → Applications → your app → Overview), is
exactly 64 lowercase hex characters, and is not the application UUID — which
looks similar, is 36 characters, and contains hyphens.

```bash
echo -n "$CF_ACCESS_AUD" | wc -c     # must be 64
```

### 5.3 Sign-in broke and nothing changed in the app

Something changed in Cloudflare. In order of likelihood:

1. **The Access application was deleted and recreated.** The AUD tag changes.
   Update `.env` and restart.
2. **The team domain is wrong.** Check the JWKS endpoint answers:
   ```bash
   curl -s https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs | head -c 100
   ```
   Expect JSON starting `{"keys":[{`. A 404 or an HTML error page means the
   team name is wrong. Enter it with no scheme and no trailing slash.
3. **The email was removed from the Access policy.** Cloudflare will not even
   show the login.

All auth failures return an identical 403 by design — the response never tells
a caller _why_ — so the server log is where the reason lives.

### 5.4 A receipt uploads but no fields appear

The upload and the extraction are separate on purpose: the image is stored
before Claude is called, so extraction can never lose an upload.

Check **Admin → Logs** for the failure reason.

- `ANTHROPIC_KEY_NOT_CONFIGURED` — no key. Admin → Claude API key.
- `AI_REQUEST_REJECTED` — the API refused the request. Usually an invalid
  model id (the admin Extraction settings accept free text and do not check it
  against the catalogue) or an exhausted credit balance.
- Nothing at all in the logs — check the worker is alive:
  `docker compose logs webapp | grep -i worker`.

The receipt and its image are safe throughout. Fix the cause and use
**Re-extract**.

### 5.5 Changing `APP_PORT` breaks the tunnel

`~/.cloudflared/config.yml` names the port explicitly. Change both, or neither.
The symptom is a 502 through the hostname while `localhost:<new-port>` works
fine.

### 5.6 Restoring an identity-provider migration

If you change identity providers, every user gets a new Access `sub` and
Ledgerly provisions new accounts — including a new, non-owner account for you.
Everyone is locked out of their own data, including the owner.

The recovery path is `ACCESS_ALLOW_SUB_RELINK=true`. While it is on, a new
`sub` whose email matches exactly one existing user is reassigned onto that
user's row instead of creating a new account. Every reassignment is audited,
and the app warns at every boot while it is on.

Turn it off the moment the migration is done. It is off by default, and it
makes email a join key while it is on.

### 5.7 CI: "Cache export is not supported for the docker driver"

The `docker` job sets `cache-to: type=gha`, which needs buildx.
`docker/setup-buildx-action` must run before `build-push-action`.

Worth knowing for the general lesson: that job is gated on
`github.ref == 'refs/heads/main' && github.event_name == 'push'`, so **no pull
request or branch run could ever have exercised it**. It failed the first time
it ran, on main, having passed everything else. A job that only runs on main
gets its first real test on main.

### 5.8 CI: the restore drill skipped and the build still went green

This one bit three times, in three different ways, and is the reason the drill
is now enforced rather than merely warned about.

1. **The version guard never fired.** `serverMajor()` ran `SHOW
server_version` and read `.v` off the row — but `SHOW` names its column
   after the setting, so the read was always `undefined`, the guard always saw
   `null`, and CI ran the drill into the exact mismatch the guard existed to
   skip. Use `SELECT current_setting('server_version') AS v`.
2. **Installing the client was not enough.** `/usr/bin/pg_dump` is Debian's
   `pg_wrapper`, which dispatches to the **default cluster's** version, not the
   newest installed. The logs showed `pg_dump (PostgreSQL) 16.15` on the line
   immediately after 17.11 finished unpacking. Put
   `/usr/lib/postgresql/17/bin` on `GITHUB_PATH` so the versioned binary wins.
3. **`continue-on-error` hid the consequences.** That flag is right — a PGDG
   outage should cost one run's drill, not the whole pipeline — but it meant an
   apt failure silently disabled the one check proving a backup is restorable.
   The drill now writes a marker when it genuinely runs and a CI step fails the
   job if the marker is missing.

`pg_dump` refuses a server newer than itself outright, so client and server
versions must match or the client must be newer.

### 5.9 CI: an unrelated apt repository breaks the e2e job

`playwright install --with-deps` shells out to `apt-get update`, which fails the
**entire** install if any configured repository is unhealthy — including ones
this project has no use for. The GitHub runner image ships Google's Chrome
repo preconfigured; it once served a `Packages.gz` whose hash did not match its
own `Release` file, and took e2e down on main twice before a single test ran.
This suite is WebKit-only and has never used Chrome.

The fix removes the irrelevant repos first. Match them **by content, not by
filename** — the first attempt deleted `google-chrome.list` and the repo was
still fetched, because the runner image names it differently and may use either
the one-line `.list` format or deb822 `.sources`. Grep the apt config for the
host instead.

### 5.10 A route exists in the code but 404s in the container

Check `.gitignore` before debugging the route. An **unanchored** directory
pattern matches at any depth: a bare `backups/` silently swallowed
`apps/web/src/app/api/admin/backups/` — the entire backup download route and
its tests — so the feature was committed without the endpoint its button
called, and nothing failed until someone pressed it.

The data-volume patterns are anchored (`/data/`, `/backups/`, `/uploads/`) for
exactly this reason. Before the first commit of any new directory:

```bash
git status --ignored
```

### 5.11 `Cannot find module 'sharp'` (or `bullmq`, or `exceljs`) in the container

A pnpm-workspace quirk in Next.js standalone builds. Packages listed in
`serverExternalPackages` are not bundled, so they must be resolvable at
runtime — but Next's file tracer resolves relative to each entrypoint's own
`node_modules` chain. A package that reaches `apps/web` only _transitively_
(sharp and bullmq via `@ledgerly/queue`; exceljs via `@ledgerly/api`) gets
copied to `.next/standalone/packages/queue/node_modules/`, which is **not** on
the path Node walks from the bundled code that calls `require("sharp")`.

The fix is to list them as **direct** dependencies of `apps/web` as well —
purely so pnpm creates the symlinks where the trace and the runtime `require()`
can find them.

`nodemailer` is deliberately not in `serverExternalPackages`: it has no
`__dirname`, no `createRequire` and no dynamic requires, so webpack inlines it
cleanly and there is no runtime `require()` left to resolve.

### 5.12 A feature "works" manually but never automatically

Two instances of this, worth reading together because the shape recurs.

**The automatic receipt email had never worked once.** Manual sends arrived;
automatic ones never did. The automatic path passed a BullMQ job id of
`${receiptId}:auto`, and BullMQ builds its keys as `bull:<queue>:<jobId>` and
rejects a custom id containing `:` — `add()` throws `Custom Id cannot contain
:`. Every automatic enqueue threw. The enqueue is wrapped in a `catch` on
purpose (a Redis hiccup must not fail an extraction already paid for), so it
was swallowed, leaving one `console.error` per receipt as the only trace. The
manual path passes no job id, which is exactly why it was fine — and why the
symptom read as "email works, but not automatically".

The lesson that generalises: every other test in that package injected a fake
queue. A well-formed string passes a string assertion; it was BullMQ that
refused it. The test now adds the real id to a **real** queue.

**And in the same area:** D-44's own verification note recorded the symptom —
"the automatic-send marker correctly left null" — and read it as success.

### 5.13 iOS: the export downloads nothing, or hijacks the whole screen

Three bugs in one place. Useful because the first two fixes were both
confident and both wrong.

1. **`location.assign`** downloaded the file correctly but handed the whole
   screen to the share sheet with no way back — a standalone PWA has one
   document and no browser chrome.
2. **A `target="_blank"` anchor** restored the way back and broke the
   download: an installed iOS app opens such a link in an in-app browser view
   that cannot save a `Content-Disposition` attachment at all. It renders blank
   and discards the body.

   Both fixes argued about _which window_ should receive the file. Neither
   asked whether any window could. In a standalone PWA there is nowhere to
   navigate to, so the page that already exists must fetch the file itself and
   hand it to the OS via the Web Share API.

3. **And then the fetch never left the device.** The real error was
   `TypeError: Can only call Window.fetch on instances of Window` — a bare
   `fetch` reference passed through a deps object and invoked as
   `deps.fetchImpl(...)`, making the deps object the receiver. WebKit enforces
   the receiver on `Window.fetch`; Chrome, Firefox and Node are all lenient, so
   it failed on exactly one platform and nowhere the test suite was looking. A
   `catch` that assumed a network failure relabelled it "Could not reach the
   server", which is how a one-line binding bug got explained twice as WebKit
   download behaviour.

If you touch the export or download path, **test on a real iPhone with the app
installed to the home screen.** Safari-in-a-tab behaves differently from a
standalone PWA, and the CI WebKit suite is not the same thing either.

### 5.14 Uploads return 503 `rate_limit_unavailable`

Redis is unreachable. The rate-limit check is bounded and fails **closed**: an
upload that cannot be proven within the limit is refused rather than admitted
unmetered.

```bash
docker compose ps redis
docker compose logs --tail 30 redis
docker compose restart redis
```

### 5.15 Uploads return 413

Either the body exceeded `MAX_UPLOAD_BYTES × 60` plus framing overhead, or the
batch had more than 60 files, or a single file exceeded `MAX_UPLOAD_BYTES`. The
per-file case comes back as a per-file result so the rest of a batch still
uploads; the whole-body case is a plain 413.

The usual cause on a phone is a **video** selected from the camera roll.

### 5.16 Recovering the owner account

The instance owner is whoever signed in first, enforced by a unique constraint.
If the wrong person claimed it there is no in-app path to move it:

```bash
docker compose exec db psql -U ledgerly -d ledgerly
```

```sql
SELECT id, email, role FROM users ORDER BY created_at;
BEGIN;
UPDATE users SET role = 'member' WHERE role = 'owner';
UPDATE users SET role = 'owner'  WHERE email = '<your-email>';
COMMIT;
```

Back up first. The constraint permits only one owner, so demote before you
promote.

---

## 6. Routine operations

```bash
# Status
docker compose ps
curl -s localhost:3000/api/v1/health

# Follow the app
docker compose logs -f webapp

# psql shell
docker compose exec db psql -U ledgerly -d ledgerly

# Restart just the app (keeps the databases up)
docker compose restart webapp

# Stop everything. Data survives — it is in named volumes.
docker compose down

# Disk usage
docker system df -v | grep ledgerly
```

### 6.1 Rotating the Claude API key

Create the new key in the Anthropic console, paste it into **Admin → Claude
API key**, test it, then revoke the old one. No restart needed; the stored key
overrides `ANTHROPIC_API_KEY`.

### 6.2 Rotating `MASTER_KEY`

There is no automated rotation. `MASTER_KEY` encrypts `app_config`, so
changing it strands the Claude API key and the SMTP password. To rotate:
note both credentials, change the key, restart, then re-enter both through
the admin UI.

### 6.3 Adding a user

Add their email to the Cloudflare Access policy. They sign in, complete the
welcome form, and become an ordinary user. Add them to a project from its
member list at `read`, `read_add` or `full`.

Note what `full` carries: rename and re-date the project, archive it,
add/remove/re-permission any member including granting `full`, and edit or
delete **any** receipt in the project. Only deleting the project itself is
reserved to its owner.

### 6.4 Removing a user

Remove them from the Access policy — that cuts off access immediately, at the
edge. Remove them from projects in-app.

Do **not** delete the user row to revoke access. `audit_log.actor_user_id` is
`ON DELETE SET NULL`, so deleting the row anonymises every audit entry they
ever generated — including permission grants and exports.

---

## 7. Monitoring

There is no built-in alerting. At minimum, check periodically that:

- `docker compose ps` shows everything running
- **Admin → Backups** shows a recent successful archive
- **Admin → Logs** shows no repeating extraction failures
- your Anthropic spend is within expectations

`GET /api/v1/health` is exempt from the auth middleware so the container
healthcheck can reach it on loopback. It is still behind Cloudflare Access
from the outside. If you ever add an Access bypass rule for external uptime
monitoring, add a rate limit at the same time — it touches Postgres and Redis
on every call.
