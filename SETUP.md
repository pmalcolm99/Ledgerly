# Setting up Ledgerly

This guide takes a machine with nothing on it to a working Ledgerly instance
reachable from your phone. It assumes no prior familiarity with the codebase.

Each step says what you should see when it worked. If you see something else,
check [Troubleshooting](#troubleshooting) at the bottom — it covers the three
failures this deployment actually hit.

Rough timings: 20 minutes for steps 1–4 (a working app on `localhost`), another
20 for steps 5–7 (reachable from the internet, behind authentication).

---

## What you are building

Ledgerly runs as four containers on one machine:

| Container     | What it is                                                       |
| ------------- | ---------------------------------------------------------------- |
| `webapp`      | The Next.js app and the background workers, in one image         |
| `db`          | PostgreSQL 17 — receipts, projects, users                        |
| `redis`       | The job queue that renders images and calls the extraction model |
| `cloudflared` | The tunnel (installed separately, in step 5)                     |

Only `webapp` listens on a port, and only on `127.0.0.1`. Nothing is exposed to
your LAN or to the internet directly. Every request from the outside arrives
through the Cloudflare Tunnel, and Cloudflare Access authenticates it before it
reaches the tunnel. **There is no login page in this app** — Cloudflare is the
login, and the app trusts the signed token it forwards.

That is why steps 5 and 6 are not optional extras. Until Access is in front of
it, anything that can reach the tunnel hostname can read every receipt.

---

## 1. Prerequisites

- A machine that stays on: a NAS, a home server, a small VPS. Linux or macOS.
- **Docker** with the Compose plugin. `docker compose version` should print
  `v2.x` or later. (`docker-compose` with a hyphen is the old one; if that is
  what you have, install the plugin.)
- **A Cloudflare account** and **a domain on it**. Free tier is fine for both.
  The domain has to have its nameservers pointed at Cloudflare — the tunnel
  cannot create a hostname on a domain Cloudflare does not control.
- **An Anthropic API key**, from <https://console.anthropic.com>. Optional at
  this stage; the app boots without one and you can add it from the admin
  screen later.

You do **not** need Node, pnpm, or Postgres installed. They are all inside the
image.

Clone the repository, then stay in that directory for everything below:

```bash
git clone https://github.com/pmalcolm99/ledgerly.git
cd ledgerly
```

---

## 2. Write the `.env` file

```bash
cp .env.example .env
```

`.env.example` documents every variable. Most have working defaults. These are
the ones you must decide:

### Required, always

| Variable            | What to put                                          |
| ------------------- | ---------------------------------------------------- |
| `POSTGRES_PASSWORD` | Any long random string. It never leaves the machine. |
| `DATABASE_URL`      | Must contain the same password. See the note below.  |
| `MASTER_KEY`        | Generate it — see below.                             |

`DATABASE_URL` appears in `.env` for the benefit of running the app _outside_
Docker. Under `docker compose` the value is composed for you from the
`POSTGRES_*` variables, so the one in `.env` is ignored — but keep them
consistent anyway, so the file does not lie to the next person who reads it.

Generate `MASTER_KEY`:

```bash
openssl rand -base64 32
```

> **Back `MASTER_KEY` up somewhere outside this machine, now.**
>
> It encrypts the `app_config` table — the Claude API key and, from Phase 9, the
> SMTP password. It is deliberately never written into a backup archive, so a
> backup **cannot be decrypted without it**. Losing it does not lose your
> receipts, but it does lose every stored secret, permanently, with no recovery
> path. A password manager entry is enough.

### Required once you go to production

Leave these blank for now; step 6 fills them in.

| Variable                | What to put                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `CF_ACCESS_ENABLED`     | `true` once Access is actually in front of the app           |
| `CF_ACCESS_AUD`         | The Application Audience tag — **exactly 64 hex characters** |
| `CF_ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com`                              |

`packages/config` refuses to boot with `NODE_ENV=production` unless all three
are set and well-formed. That is deliberate: a misconfigured Access check that
fails _open_ is indistinguishable from no authentication at all, so it fails at
startup instead, loudly, before serving a single request.

### Worth setting

| Variable            | Note                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| `APP_HOSTNAME`      | The public hostname you will create in step 5, e.g. `receipts.example.com`.            |
| `APP_PORT`          | Change it only if 3000 is taken. See the D-16 warning in Troubleshooting.              |
| `ANTHROPIC_API_KEY` | Optional. You can set the key from the admin UI instead, where it is stored encrypted. |
| `NODE_ENV`          | `development` while you work through steps 3–4; `production` from step 6 on.           |

`DEV_AUTH_BYPASS` deserves its own line. It injects a fixed development
identity and skips JWT verification entirely, so anyone who reaches the app is
signed in as the owner. It defaults to `false` and the app **refuses to boot**
if it is `true` while `NODE_ENV=production`. Leave it alone.

---

## 3. First boot

```bash
docker compose up -d --build
```

The first build takes several minutes. When it finishes:

```bash
docker compose ps
```

**You should see** the three services — `webapp`, `db`, `redis` — with `webapp`
eventually reaching `healthy`. It takes up to a minute; the health check has a
60-second grace period while migrations run.

```bash
curl -s http://localhost:3000/api/v1/health
```

**You should see** a JSON body reporting `ok`, with the database and Redis
both up. If `webapp` is restarting in a loop instead, go to Troubleshooting —
that is almost always a `.env` validation failure, and the reason is in
`docker compose logs webapp`.

Migrations run automatically on every start, before the server accepts
connections. You never run them by hand.

---

## 4. Look at it locally

Open <http://localhost:3000>.

With `NODE_ENV=development` and `CF_ACCESS_ENABLED=false`, the app has no way to
identify you, so it will not let you in — which is correct, and is the point. To
see the UI before Cloudflare is set up, set `DEV_AUTH_BYPASS=true` in `.env`,
run `docker compose up -d`, and you are signed in as a fixed development
identity.

**Set it back to `false` before step 6.** The app will refuse to boot in
production with it on, so you cannot ship it by accident, but you can waste
twenty minutes wondering why.

---

## 5. The Cloudflare Tunnel

The tunnel makes an _outbound_ connection from your machine to Cloudflare, and
Cloudflare routes your hostname down it. Nothing inbound; no port forwarding;
no firewall rules.

1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a
   tunnel**. Pick **Cloudflared**, name it (`ledgerly` is fine), and save.
2. Cloudflare shows you an install command containing a long token. Run it on
   the machine — it installs `cloudflared` and registers it as a service.
3. Back in the dashboard, on the tunnel's **Public Hostname** tab, add a
   hostname:
   - **Subdomain**: `receipts` (or whatever you set in `APP_HOSTNAME`)
   - **Domain**: your domain
   - **Service type**: `HTTP`
   - **URL**: `localhost:3000` — this must match `APP_PORT`

**You should see** the tunnel listed as **HEALTHY** within a few seconds, and
`https://receipts.example.com` should now load the app.

At this moment your receipts are on the public internet with no authentication.
Do step 6 now, not later.

---

## 6. Cloudflare Access

Access sits in front of the hostname and authenticates every request before it
reaches the tunnel.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. **Application name**: Ledgerly. **Session duration**: whatever you like — a
   month is reasonable for a personal instance.
3. **Application domain**: the same hostname from step 5.
4. Add a **policy**:
   - **Name**: Owner
   - **Action**: Allow
   - **Include** → **Emails** → your email address.

   Use `Emails`, not `Everyone`, and not `Emails ending in` unless you really
   do mean everyone at that domain.

5. Pick a login method. One-time PIN by email works with no further setup.
6. Save, then open the application's **Overview** tab and copy the
   **Application Audience (AUD) Tag**.

Now finish `.env`:

```dotenv
NODE_ENV=production
CF_ACCESS_ENABLED=true
CF_ACCESS_AUD=<the 64-character tag you just copied>
CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
DEV_AUTH_BYPASS=false
```

`CF_ACCESS_TEAM_DOMAIN` is the hostname only — no `https://`, no trailing
slash. You will find it under **Zero Trust → Settings → Custom Pages**, or in
the URL of the login page Access shows you.

```bash
docker compose up -d
```

**You should see** Cloudflare's login page when you open the hostname in a
private window, and the app only after you authenticate.

---

## 7. First sign-in, and the API key

Open the hostname and sign in through Access.

**The first account to sign in becomes the instance owner.** There is no
separate bootstrap step and no default password to change. Every later sign-in
creates an ordinary user account.

You will be asked for your name and offered a theme; that screen is shown once.

Then, as owner:

1. **Admin → Claude API key.** Paste your Anthropic key and save. It is
   encrypted with `MASTER_KEY` before it is stored, and it takes precedence
   over the `ANTHROPIC_API_KEY` environment variable.
2. Press **Test**. **You should see** a success message. That button makes one
   real, minimal call to the Anthropic API, which is the only thing that
   distinguishes a valid key from a well-formed invalid one.
3. Create a project, upload a receipt, and watch the fields fill in on their
   own within a few seconds.

You are done.

---

## 8. Optional: receipt emails

Ledgerly can email you each receipt once it has been scanned, with the image
attached. It is off by default and needs two things switched on.

### The relay

**Admin → Email (SMTP).** Any relay works — smtp2go, Postmark, SES. You need:

| Field               | Note                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host / Port         | `587` with implicit TLS **off** is the common case. Turn implicit TLS on only for port `465`.                                                      |
| Username / Password | Stored encrypted with `MASTER_KEY`, like the Claude key. The password is write-only: once saved you see its last four characters and nothing else. |
| From address        | Must be an address the relay is willing to send as. This is the field that most often causes a rejection.                                          |

Press **Send test email**. It sends a real message to your own address using
the **saved** settings — so save your changes first. **You should see** a
success line, and the message in your inbox within a minute.

Editing settings later: leave the password box blank to keep the stored one.
Only fill it in when you actually want to change it.

### Per project

On a project's page, **Receipt emails → Email me each receipt**. Each new
receipt then emails the project owner once, after extraction finishes — so the
email contains the extracted fields rather than an empty shell. A re-extract
does not send a second copy.

Regardless of that setting, any receipt can be emailed on demand from its own
page, to any member of that project. There is no free-text address field: to
send a receipt to someone, add them to the project first.

---

## Troubleshooting

### `webapp` restarts in a loop

Almost always a `.env` validation failure. The reason is printed:

```bash
docker compose logs webapp | tail -30
```

The message names the variable. Config validation runs before anything else
starts, on purpose — a bad value fails at boot rather than halfway through
someone's upload.

### "CF_ACCESS_AUD must be 64 hex characters"

The AUD tag is exactly 64 lowercase hex characters. A copy that picked up a
stray character — a trailing space, a newline, a smart quote from a notes app —
is 65, and is rejected at startup.

Count it:

```bash
grep '^CF_ACCESS_AUD=' .env | cut -d= -f2 | tr -d '\n' | wc -c
```

**You should see** `64`. Anything else, re-copy the tag straight from the
Cloudflare dashboard into the file.

This is checked at boot rather than at verification time deliberately: a
truncated AUD would otherwise fail every request with an opaque 403, which
looks like a Cloudflare problem rather than a typo in your `.env`.

### Changing `APP_PORT` breaks the tunnel

`APP_PORT` lives in **two** places and they must agree:

1. `APP_PORT` in `.env`
2. The **URL** field on the tunnel's Public Hostname (`localhost:<port>`)

Changing one and not the other gives you a healthy container, a healthy tunnel,
and a 502 — because `cloudflared` is connecting to a port nothing is listening
on. The app never hardcodes the port; if it does not match, this is why.

### A receipt uploads but no fields appear

Extraction is asynchronous and never fails an upload — an image that cannot be
read still saves, with the unreadable fields left for you to fill in. Open the
receipt: it carries a status and a reason code.

- `ANTHROPIC_KEY_NOT_CONFIGURED` — no key. Admin → Claude API key.
- An authentication or permission reason — the key is wrong, revoked, or has no
  credit. Press **Test** on the admin card; it reports the provider's own
  message rather than a generic failure.
- Anything else — `docker compose logs webapp` has the provider's response.

The image is never lost. Fix the cause and press **Re-extract** on the receipt.

### Rotating an identity provider locked everyone out

If you change how Access authenticates you, Cloudflare issues a new subject id
and the app sees a brand-new person — including for the owner account.

`ACCESS_ALLOW_SUB_RELINK=true` is the recovery path: a new subject whose email
matches exactly one existing user is reassigned onto that user's row instead of
creating a duplicate. Every reassignment is audited, and the app warns at every
boot while it is on, specifically so it does not get left on.

Turn it on, sign in once as each affected user, turn it off, restart.

---

## Routine operations

```bash
# Update to the latest code
git pull && docker compose up -d --build

# Logs
docker compose logs -f webapp

# A psql shell
docker compose exec db psql -U ledgerly -d ledgerly

# Stop everything (data survives — it is in named volumes)
docker compose down
```

`docker compose down -v` deletes the volumes, and with them every receipt and
image. There is no undo.
