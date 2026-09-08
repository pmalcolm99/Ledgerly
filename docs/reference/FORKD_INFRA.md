# Forkd Infrastructure

## Deployment Topology

Forkd runs four Docker containers orchestrated by `docker-compose.yml` on a single Linux host. The webapp (Next.js + BullMQ worker) listens on `127.0.0.1:${PORT}` and is exposed to the internet via a Cloudflare Tunnel running as a host systemd service. Traffic passes through Cloudflare Access for identity verification before reaching the tunnel. All containers share an internal Docker bridge network; only the webapp publishes a port. Data (database, uploads, backups, cache) is persisted in four named Docker volumes that survive container restarts and image updates.

---

## Docker

**File:** `/docker/Dockerfile`

**Base Image:** `node:22-alpine` (multi-stage)

**Build Stages:**

1. **`deps`** — Installs pnpm 11.0.9 and runs `pnpm install --frozen-lockfile` with workspace manifests copied per line (no glob) to maximize Docker layer caching.
2. **`builder`** — Copies full source tree, builds `@forkd/web` and all dependencies with `pnpm build --filter=@forkd/web`, bundles `scripts/migrate.ts` to `/app/.next/standalone/migrate.cjs` using esbuild, and stages `playwright-core` to `/tmp/playwright-core` (dynamic import not auto-traced by Next.js).
3. **`runner`** — Minimal production image: copies `/app/.next/standalone/*` (Next.js standalone server + node_modules), static assets, migrations folder, and `playwright-core` from builder. Installs `vips`, `libheif`, `ffmpeg`, `python3`, `postgresql17-client` (for `pg_dump`/`pg_restore`), `tar`, and `su-exec` (for permission dropping). Downloads `yt-dlp` binary at version pinned in `ARG YT_DLP_VERSION=2025.01.15`.

**Volume/Permission Setup:**

- Creates `/app/uploads` and `/app/backups` directories with `chown node:node` (UID/GID 1000:1000).
- Copies `docker/entrypoint.sh` with `--chmod=755` to fix volume ownership at startup.
- Container starts as **root** — the entrypoint runs `su-exec node:node` to drop to unprivileged `node` user after `chown`. Do **not** set `user: node` in compose or the chown fails.

**Exposed Port & Environment:**

```dockerfile
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sh", "-c", "node migrate.cjs && node apps/web/server.js"]
```

Runs pending migrations then starts Next.js. If `migrate.cjs` exits non-zero, the container fails immediately (fail-fast).

**Build Argument:**

- `GIT_SHA` — passed by CI as `--build-arg GIT_SHA=${{ github.sha }}`, defaults to `"dev"` for local builds. Embedded as `APP_GIT_SHA` for display in the About page.

---

## Docker Compose

**File:** `docker-compose.yml` (at repo root)

### Services

#### `webapp`

```yaml
services:
  webapp:
    build:
      context: .
      dockerfile: docker/Dockerfile
    image: ${IMAGE_LOCATION:-ghcr.io/pmalcolm99/forkd:latest}
    restart: always
    ports:
      - "127.0.0.1:${PORT:-3000}:${PORT:-3000}"
    env_file:
      - .env
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      CHROME_CDP_ENDPOINT: http://chrome-headless:3000
      UPLOADS_DIR: /app/uploads
      BACKUPS_DIR: /app/backups
      CF_ACCESS_ENABLED: "${CF_ACCESS_ENABLED:-false}"
      PORT: "${PORT:-3000}"
    volumes:
      - app_uploads:/app/uploads
      - app_backups:/app/backups
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
      chrome-headless:
        condition: service_started
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/v1/health')..."]
      interval: 60s
      timeout: 15s
      retries: 3
      start_period: 60s
```

- Binds to **localhost only** — Cloudflare Tunnel reaches it from `http://localhost:${PORT}`.
- `restart: always` required for in-app restart feature (app can call `process.exit(0)` and Docker re-spawns).
- No `user:` override — container starts as root (entrypoint drops to `node` user).
- `depends_on` blocks startup: `db` must be healthy (healthcheck passes), `redis` and `chrome-headless` just need to have started.

#### `db`

```yaml
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- PostgreSQL 17 (Alpine). Healthcheck uses `pg_isready` to gate webapp startup.
- No published port — only reachable on the Docker network via `db:5432`.

#### `redis`

```yaml
  redis:
    image: redis:8.4.0
    restart: unless-stopped
    volumes:
      - redis_data:/data
```

- Redis 8.4.0 (no Alpine specified in the compose, but Redis defaults apply). BullMQ job queue and session storage.
- No published port. No healthcheck (webapp treats it as "started enough").

#### `chrome-headless`

```yaml
  chrome-headless:
    image: zenika/alpine-chrome:latest
    restart: unless-stopped
    command:
      - --remote-debugging-address=0.0.0.0
      - --remote-debugging-port=3000
      - --headless
      - --no-sandbox
      - --disable-gpu
      - --disable-dev-shm-usage
```

- Zenika Alpine Chrome for social media scraping via Puppeteer. CDP on port 3000.
- `--no-sandbox` required for some VPS (e.g., KVM, bare-metal); OpenVZ-based hosts may fail.
- No volumes, no published port, no healthcheck.

### Volumes

```yaml
volumes:
  app_uploads:
  app_backups:
  db_data:
  redis_data:
```

All named volumes, no host bind-mounts specified. Location managed by Docker (typically `/var/lib/docker/volumes/`).

- **`app_uploads`** — Restaurant photos uploaded via UI. Must be backed up.
- **`app_backups`** — Full backup `.tar.gz` archives. Must be backed up (or synced offsite).
- **`db_data`** — PostgreSQL data directory. Critical; must be backed up.
- **`redis_data`** — Redis dump. Ephemeral; job queue state is volatile; no backup needed.

---

## Port and Hostname Configuration

**From `.env`:**

```env
PORT=3000
HOST=0.0.0.0
AUTH_URL=https://forkd.yourdomain.com
```

**Tracing through to compose/app:**

1. `.env` sets `PORT=3000`.
2. `docker-compose.yml` reads `${PORT:-3000}` for both the container's internal `ENV PORT` and the host binding (`127.0.0.1:${PORT}:${PORT}`).
3. Dockerfile sets `ENV HOSTNAME="0.0.0.0"` (fixed in image, not configurable via `.env`).
4. Next.js server binds to `0.0.0.0:${PORT}` inside the container.
5. Cloudflare Tunnel (host systemd service) is configured to reach `http://localhost:${PORT}`.

**Hardcoding check:** No hardcoded ports in the Dockerfile or compose. If you change `PORT` in `.env`, you must also update the tunnel's ingress service URL in `/etc/cloudflared/config.yml` on the host.

---

## Cloudflared

**Deployment:** Runs as a **host systemd service**, not a Docker container.

**Installation:** Via `cloudflared` apt package (Debian/Ubuntu) or Homebrew (macOS) — see deployment guide.

**Configuration File:** `/etc/cloudflared/config.yml` (or `~/.cloudflared/config.yml` for user-level)

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflare/tunnels/<TUNNEL_ID>.json

ingress:
  - hostname: <APP_HOSTNAME>
    service: http://localhost:3000
  - service: http_status:404
```

Replace `<TUNNEL_ID>` with the UUID output from `cloudflared tunnel create forkd`, and `<APP_HOSTNAME>` with the public domain (e.g., `forkd.yourdomain.com`). The `.json` credentials file is generated during `cloudflared tunnel login`.

**Service Management:**

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
```

Runs as root, auto-starts on reboot. Logs to journalctl: `journalctl -u cloudflared -f`.

**DNS & Routing:**

- `cloudflared tunnel route dns <tunnel-name> <hostname>` creates a CNAME record pointing to `<TUNNEL_ID>.cfargotunnel.com` in Cloudflare DNS.
- The tunnel itself is created in Cloudflare Zero Trust via `cloudflared tunnel create`.

**Credential Storage:**

- Tunnel credentials live in `~/.cloudflared/<TUNNEL_ID>.json` (or `/root/.cloudflare/tunnels/` if installed as root service).
- Never commit this file or the tunnel ID to version control.

---

## Healthcheck

**Endpoint:** `GET /api/v1/health` (path: `/apps/web/src/app/api/v1/health/route.ts`)

```typescript
export function GET(): Response {
  return Response.json({ status: "ok" });
}
```

**What it checks:** Response status only. Does **not** verify database connectivity or cache availability. A simple "is the Next.js server running?" ping.

**Docker Healthcheck Config:**

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 60s
  timeout: 15s
  retries: 3
  start_period: 60s
```

- Runs every 60 seconds. If 3 consecutive checks fail (over 180 seconds after start), the container is marked unhealthy.
- `start_period: 60s` allows the app 60 seconds to boot before the first healthcheck is enforced (migrations may take time).

**Operational Note:** Healthcheck is shallow; it doesn't validate DB or cache. A healthy container might still fail a request if the database is down. The `db` service has its own `pg_isready` healthcheck, which `webapp` depends on.

---

## GitHub Actions

**Workflow File:** `.github/workflows/ci.yml`

### Job: `ci`

Runs on every push and PR:

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "pnpm"
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm run test
```

- Node 22 (fixed version, no matrix).
- Lints, typechecks, and runs tests. Fails the PR if any step fails.

### Job: `docker`

Runs only on commits to `main` after `ci` passes:

```yaml
docker:
  runs-on: ubuntu-latest
  needs: ci
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  permissions:
    contents: read
    packages: write
  steps:
    - uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
    - uses: docker/build-push-action@v6
      with:
        context: .
        file: docker/Dockerfile
        push: true
        tags: ghcr.io/${{ github.repository_owner }}/forkd:latest
        build-args: |
          GIT_SHA=${{ github.sha }}
        cache-from: type=gha
        cache-to: type=gha,mode=max
```

- Uses `GITHUB_TOKEN` (automatic, no secret config needed) to push to GitHub Container Registry.
- Builds with `GIT_SHA=${{ github.sha }}` and caches layers via GitHub Actions cache backend.
- Published to `ghcr.io/pmalcolm99/forkd:latest` (public image).

**Secrets Referenced (NAMES ONLY):**
- `GITHUB_TOKEN` (provided by GitHub, no config needed)

---

## Backup

**Implementation:** BullMQ job queue (in Redis), triggered manually via UI or on a cron schedule.

**How It Works:**

1. **Creation** (`packages/queue/src/pipeline/backup.ts`):
   - Runs `pg_dump --format=custom` (compressed, restorable with `pg_restore`) to `/app/backups/forkd-backup-<ISO>.tar.gz`.
   - Copies `/app/uploads/` tree into the archive.
   - Exports `app_config` table (encrypted values left encrypted) as `app_config.json`.
   - Includes `manifest.json` (app name, version, timestamp, contents list).
   - Tars and gzips everything into a single `.tar.gz` file.

2. **Storage:** `/app/backups` (named volume `app_backups`). Must be backed up or synced offsite.

3. **Retention:**
   - Default: keep last 30 backups.
   - Hard cap: 10 GB total size.
   - Old backups are soft-deleted from the `backups` table and unlinked from disk.

4. **Scheduling:** Via cron expression (e.g., `0 3 * * *` for daily at 3 AM) stored in `app_config` table. Reconciled by the API router (`reconcileScheduledBackup()`), using BullMQ repeatable jobs.

5. **Restore** (`packages/queue/src/pipeline/restore.ts`):
   - Extracts the archive to a temporary directory.
   - Puts the app in maintenance mode (non-owner requests blocked).
   - Runs `pg_restore --clean --if-exists` (drops and recreates objects, tolerating benign "does not exist" warnings).
   - Replaces `/app/uploads` tree with the archived version.
   - Re-applies `app_config` rows (upsert, preserving secrets).
   - Exits maintenance mode.

**Manual Restore (CLI):**

```bash
mkdir restore && tar -xzf forkd-backup-*.tar.gz -C restore
docker compose cp restore/db.dump db:/tmp/db.dump
docker compose exec db pg_restore --clean --if-exists --no-owner -U forkd -d forkd /tmp/db.dump
docker compose cp restore/uploads/. webapp:/app/uploads/
docker compose restart webapp
```

**Critical Note:**

- **`MASTER_KEY` is irreplaceable.** All secrets (API keys) are encrypted in the database with this key. A backup archive contains the encrypted values (useless without the key). If `MASTER_KEY` is lost and you restore an old backup, the encrypted keys become unreadable — you must re-enter them via the admin UI.
- Back up `MASTER_KEY` out-of-band (password manager, encrypted note). A database backup alone is not sufficient.

**Operational Weaknesses:**

- **Backup storage is local only.** Backups live in the `app_backups` Docker volume, which is typically on the host's filesystem. No built-in S3, Azure, or offsite replication. If the host disk fails, backups are lost.
- **No restore testing.** Restore is tested manually; no automated restore test in CI.
- **Backup size uncapped until 10 GB.** Unbounded growth until the hard cap is hit; no warning before the cap.

---

## Operational Concerns & Flags

1. **Shallow healthcheck:** `/api/v1/health` does not verify database connectivity. The container can be marked healthy while DB queries fail. Mitigation: rely on `depends_on: db condition: service_healthy` to gate startup.

2. **No offsite backup:** All backups stored locally in `app_backups` volume. Recommend setting up a cron job on the host to periodically `tar` the entire `/var/lib/docker/volumes/forkd_app_backups/_data/` to external storage (S3, rsync, etc.).

3. **Cloudflared runs outside Docker:** Tunnel configuration and systemd service on the host introduce operational complexity. If the tunnel is misconfigured or crashes, Forkd is unreachable from the internet. No orchestration restart policy for the tunnel service.

4. **MASTER_KEY loss is catastrophic:** Encrypted API keys in the database become unreadable if the key is lost. No key rotation mechanism. Loss of the key requires re-entry of all API keys via the admin UI.

5. **Chrome sandbox bypass (`--no-sandbox`):** Required for social media scraping. On OpenVZ-based VPS, this fails and scraping silently falls back. No explicit error message for users; they see "scraping failed" without understanding why.

6. **Root user in entrypoint:** Container starts as root to `chown` volumes, then drops to `node`. Standard Docker security practice, but the root phase is brief and scoped.

7. **No restore test in CI:** Backup creation is user-triggered; restore is only manually tested. No automated test to verify a backup can be restored successfully.
