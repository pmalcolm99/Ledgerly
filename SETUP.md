# Setting up Ledgerly

This guide takes you from nothing to a working, private, internet-reachable
Ledgerly instance. It assumes you are comfortable in a terminal and with
editing a config file, but it assumes **no prior experience** with Cloudflare
Tunnel, Cloudflare Access, or the Anthropic API. Those three are explained
where they first matter.

Every step is numbered, and every step is followed by a **✅ You should see**
line. If you do not see it, stop there — each step depends on the one before,
and a problem is much cheaper to find at the step that caused it than three
steps later. `DEPLOYMENT.md` has a troubleshooting section for the failures
that are known to bite.

Budget about an hour for a first run, most of it waiting for Docker.

> **A note on the screenshots you won't find here.** Cloudflare reorganises the
> Zero Trust dashboard regularly — sections get renamed, moved between menus,
> and occasionally split in two. Anthropic's console changes less often but
> does change. So this guide tells you **what you are looking for** and what it
> is called, not only where it sat when this was written. If a menu path below
> does not match what you see, search the dashboard for the feature name; the
> concepts and the values you need have been stable even while the navigation
> has not.

---

## What you are building

```
        your phone / laptop
                │
                │  https://receipts.<your-domain>
                ▼
    ┌───────────────────────────┐
    │  Cloudflare edge          │
    │  ├─ Access: who are you?  │  ← identity check happens HERE
    │  └─ Tunnel: route it      │
    └───────────┬───────────────┘
                │  outbound-only connection
                ▼
    ┌───────────────────────────┐
    │  your machine             │
    │  ├─ cloudflared           │
    │  └─ docker compose        │
    │     ├─ webapp :3000       │  ← binds to 127.0.0.1 only
    │     ├─ postgres           │
    │     └─ redis              │
    └───────────────────────────┘
```

Two things are worth understanding before you start, because they are what
make this design safe:

- **Nothing inbound is ever opened.** `cloudflared` dials _out_ to Cloudflare
  and holds the connection open. There is no port forwarding, no firewall
  hole, and your home IP address is never published.
- **Cloudflare Access authenticates people before traffic reaches you.** By
  the time a request arrives at your machine it already carries a signed JWT
  naming who sent it. Ledgerly verifies that signature itself rather than
  trusting the header — but the first line of defence is at the edge.

---

## 1. Prerequisites

### 1.1 Install Docker

Install Docker Desktop (macOS/Windows) or Docker Engine with the Compose
plugin (Linux). Then:

```bash
docker --version
docker compose version
```

✅ **You should see** two version lines, for example `Docker version 27.x` and
`Docker Compose version v2.x`. If `docker compose` reports "is not a docker
command", you have the old standalone `docker-compose` binary; install the
Compose plugin, because this project's commands assume the modern form.

### 1.2 Have a domain on Cloudflare

You need a domain whose **nameservers point at Cloudflare**. Buying a domain
elsewhere and merely pointing a record at Cloudflare is not enough — Cloudflare
has to be running DNS for the zone, because the tunnel creates DNS records for
you.

If you do not have one yet: add the domain at <https://dash.cloudflare.com>,
choose the free plan, and follow its instructions to change the nameservers at
your registrar. Propagation usually takes minutes but can take hours.

✅ **You should see** your domain listed in the Cloudflare dashboard with
status **Active**. "Pending nameserver update" means it is not ready and the
tunnel steps will fail.

A free Cloudflare plan is sufficient for everything in this guide, including
Access.

### 1.3 Have a GitHub account

Only needed to clone the repository. If the repository is private, set up
either an SSH key or a personal access token first.

✅ **You should see** `ssh -T git@github.com` reply with
`Hi <username>! You've successfully authenticated`, or be able to log in at
github.com if you plan to clone over HTTPS.

### 1.4 Decide your hostname

Pick the hostname Ledgerly will live at — something like
`receipts.<your-domain>`. Write it down; you will type it three times, and
they must match exactly.

Throughout this guide, replace:

| Placeholder        | With                                    |
| ------------------ | --------------------------------------- |
| `<your-domain>`    | your actual domain, e.g. `example.com`  |
| `<your-team-name>` | your Cloudflare Zero Trust team name    |
| `<your-email>`     | the email address you will sign in with |

---

## 2. Clone the repository

### 2.1 Clone it

```bash
git clone git@github.com:<your-github-username>/ledgerly.git
cd ledgerly
```

✅ **You should see** the repository contents — `docker-compose.yml`,
`ARCHITECTURE.md`, `packages/`, `apps/`.

### 2.2 Confirm you are on `main`

```bash
git status
```

✅ **You should see** `On branch main` and `nothing to commit, working tree
clean`.

### 2.3 Do not install Node dependencies

You do not need Node, pnpm, or `pnpm install` to _run_ Ledgerly. Everything is
built inside the container. They are only needed if you intend to develop.

---

## 3. Create the Cloudflare Tunnel

A **tunnel** is a persistent outbound connection from your machine to
Cloudflare's edge. You create it once; it gets a permanent ID and a credentials
file that proves your machine is allowed to serve that tunnel.

### 3.1 Install `cloudflared`

```bash
# macOS
brew install cloudflared

# Debian/Ubuntu — see Cloudflare's downloads page for the current .deb
# and for other platforms; the package name and URL change over time.

cloudflared --version
```

✅ **You should see** a version string, e.g. `cloudflared version 2024.x.x`.

### 3.2 Authenticate `cloudflared` with your Cloudflare account

```bash
cloudflared tunnel login
```

A browser window opens. Choose the domain you set up in step 1.2.

✅ **You should see** the browser say the certificate was downloaded, and the
terminal print a path ending in `cert.pem` (normally
`~/.cloudflared/cert.pem`). That certificate is what authorises you to create
tunnels for this zone.

### 3.3 Create the tunnel

```bash
cloudflared tunnel create ledgerly
```

✅ **You should see** `Created tunnel ledgerly with id <a long UUID>` and a
line naming a credentials JSON file, normally
`~/.cloudflared/<tunnel-id>.json`.

> 🔒 That JSON file is a **secret**. Anyone holding it can serve traffic for
> your hostname. It lives in `~/.cloudflared/`, outside the repository, and
> `.gitignore` already excludes `.cloudflared/` and `tunnel-*.json` so it
> cannot be committed by accident. Never paste its contents anywhere.

### 3.4 Route your hostname to the tunnel

```bash
cloudflared tunnel route dns ledgerly receipts.<your-domain>
```

✅ **You should see** confirmation that a CNAME record was added for
`receipts.<your-domain>`. In the Cloudflare dashboard, under **DNS → Records**,
you should now find a proxied (orange cloud) CNAME pointing at
`<tunnel-id>.cfargotunnel.com`.

### 3.5 Write the `cloudflared` config

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: receipts.<your-domain>
    service: http://localhost:3000
  - service: http_status:404
```

If you changed `APP_PORT` from 3000, this port must match it. The final
catch-all `service:` entry is required — `cloudflared` refuses to start
without one.

✅ **You should see** `cloudflared tunnel ingress validate` print
`Validating rules against the ingress rules` followed by **OK**.

### 3.6 Do not start the tunnel yet

There is nothing listening on port 3000 until step 8. Leave it for now; you
will start it in step 8.4.

---

## 4. Create the Access application and its policy

**Cloudflare Access** is the identity layer. Without it, anyone who guessed
your hostname would reach Ledgerly directly. With it, Cloudflare demands a
login first and only then forwards the request — carrying a signed token that
says who the visitor is.

Access lives in the **Zero Trust** dashboard, which is a separate area from the
main Cloudflare dashboard: <https://one.dash.cloudflare.com>.

> This is the part of the guide most likely to have drifted. Cloudflare has
> moved Access applications between menus more than once, and has renamed
> "Zero Trust" itself in the past. You are looking for the section that lets
> you **protect a self-hosted application behind a login policy** — historically
> **Access → Applications**, more recently sometimes nested under a
> "Networks" or "Secure" grouping. If the menu names below do not match,
> search the Zero Trust dashboard for **Applications**.

### 4.1 Choose your team name

The first time you open Zero Trust it asks you to pick a **team name**. This
becomes `<your-team-name>.cloudflareaccess.com` and it is permanent and
awkward to change, so choose something you will not mind typing.

✅ **You should see** the Zero Trust overview page, and your team domain shown
somewhere in **Settings** as `<your-team-name>.cloudflareaccess.com`.

### 4.2 Add a login method

Under **Settings → Authentication** (sometimes **Authentication** at the top
level), add at least one identity provider.

The simplest is **One-time PIN**, which needs no configuration: Cloudflare
emails a code to the address the visitor types. Google, GitHub and others are
also fine, and are nicer day to day.

✅ **You should see** your chosen method listed under login methods. If you
picked One-time PIN there is nothing to configure — it is available by
default on most accounts.

### 4.3 Create a self-hosted application

**Access → Applications → Add an application → Self-hosted.**

Fill in:

| Field            | Value                                           |
| ---------------- | ----------------------------------------------- |
| Application name | `Ledgerly`                                      |
| Session duration | `1 month` is reasonable for a personal instance |
| Subdomain        | `receipts`                                      |
| Domain           | `<your-domain>`                                 |

Leave the path empty so the whole host is protected.

✅ **You should see** the application's public hostname shown as
`receipts.<your-domain>` before you continue to the policy step.

### 4.4 Add an allow policy

Still in the application setup, add a policy:

| Field       | Value                |
| ----------- | -------------------- |
| Policy name | `Allow me`           |
| Action      | **Allow**            |
| Rule type   | Include → **Emails** |
| Value       | `<your-email>`       |

You can add more email addresses now or later — each one becomes a Ledgerly
user the first time they sign in.

> Prefer **Emails** over **Everyone**. An `Everyone` policy with a login method
> attached means _anyone on the internet with any email address_ can
> authenticate and reach your receipts.

✅ **You should see** the policy listed with action **Allow** and your email in
its include rule. Save the application.

### 4.5 Confirm the application is live

Visit `https://receipts.<your-domain>` in a private browser window.

✅ **You should see** a Cloudflare Access login page asking for your email.
A `502` or `1033` error _after_ the login page is expected and correct at this
stage — Access is working, and there is simply nothing behind the tunnel yet.

If you see your registrar's parking page or a DNS error instead, the tunnel
route from step 3.4 did not take effect.

---

## 5. Find the AUD tag and the team domain

These two values are the ones people most often get wrong, so they get their
own section. Ledgerly refuses to start if either is malformed, which is
deliberate — a bad value here should fail at boot, not silently let everyone
in.

### 5.1 What they are

| Value           | What it is                                                                                                                                                                                         | Shape                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **AUD tag**     | The _Application Audience_ tag. A unique id for **one Access application**. Ledgerly checks that every token it receives was issued for _this_ application and not some other app in your account. | Exactly **64 lowercase hex characters** |
| **Team domain** | Your Zero Trust team's hostname. Ledgerly fetches Cloudflare's public signing keys from it to verify token signatures.                                                                             | `<your-team-name>.cloudflareaccess.com` |

### 5.2 Find the AUD tag

It belongs to the **application**, not to your account, and it is not on the
main Cloudflare dashboard at all.

1. Zero Trust dashboard → **Access → Applications**
2. Click the **Ledgerly** application
3. Open its **Overview** tab (on some versions it is the first thing shown when
   you click **Edit**)
4. Find the field labelled **Application Audience (AUD) Tag** and copy it

✅ **You should see** a 64-character string of lowercase letters `a`–`f` and
digits. Check the length:

```bash
echo -n '<paste-it-here>' | wc -c
```

✅ **You should see** exactly `64`. If you get 32, or a value containing `-`,
you have copied something else — most likely the application _UUID_, which
looks similar and is not what Ledgerly wants.

> **The single most common mistake.** Each Access application has its own AUD
> tag. If you later delete and recreate the application — which is easy to do
> while experimenting — **the AUD tag changes** and Ledgerly will reject every
> token until you update `.env` and restart. If sign-in breaks right after you
> touched the Access config, check this first.

### 5.3 Find the team domain

Zero Trust dashboard → **Settings → Custom Pages**, or **Settings → General**,
depending on version. It is displayed as your **team domain**.

✅ **You should see** `<your-team-name>.cloudflareaccess.com`.

Then confirm it actually serves keys:

```bash
curl -s https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs | head -c 200
```

✅ **You should see** JSON beginning `{"keys":[{` . That is the JWKS endpoint
Ledgerly reads. If you get a 404 or an HTML error page, the team name is wrong.

> Enter the team domain **without** `https://` and **without** a trailing
> slash. Ledgerly builds the certs URL itself.

---

## 6. Get an Anthropic API key and set a spend limit

Ledgerly sends each receipt image to Claude to extract the merchant, date,
total and line items. That is a paid API, billed per request, separate from any
Claude.ai subscription you may already have.

### 6.1 Create an account

Go to <https://console.anthropic.com> and sign up or sign in.

✅ **You should see** the Anthropic Console dashboard.

### 6.2 Add credit

Find **Billing** (usually under **Settings**) and add a payment method, then
buy a small amount of credit — $5 is plenty to start.

✅ **You should see** a positive credit balance. A brand-new account with no
credit will return HTTP 400 errors on every extraction, which surfaces in
Ledgerly as receipts stuck in the review queue with an error.

### 6.3 Set a spend limit — do this _before_ creating the key

Still under **Billing**, find **Limits** (sometimes **Usage limits** or
**Spend limits**). Set a **monthly spend limit** you are comfortable with. $10
is generous for personal use: extraction costs roughly a cent or two per
receipt at current Sonnet pricing.

Set an email notification threshold below the hard limit if the option is
offered.

✅ **You should see** the limit shown on the billing page.

> Ledgerly has per-minute rate limits, but **it has no spend ceiling of its
> own** — a runaway loop or an enthusiastic bulk import is bounded by
> Anthropic's limit and nothing else. This is the only backstop, which is why
> it comes before the key.

### 6.4 Create the API key

**Settings → API keys → Create key**. Name it `ledgerly`.

✅ **You should see** the key exactly once, beginning `sk-ant-`. Copy it now —
the console will not show it again.

> 🔒 This key is a **secret** and a **billable credential**. It is server-side
> only: it never reaches the browser, and it is never written to a log. Do not
> paste it into a chat, an issue, or a commit.

### 6.5 Decide where to put it

You have two options, and you do not have to choose now:

- **Leave it out of `.env` entirely** and paste it into the admin UI after
  first sign-in (step 9.4). It is then stored encrypted in the database.
- **Put it in `.env`** to seed the instance without visiting the admin screen.

The admin-UI value wins if both are set. If neither is set the app still
starts, warns at boot, and leaves uploaded receipts in the review queue
un-extracted — nothing is lost, and you can add the key later.

---

## 7. Fill in `.env`, variable by variable

### 7.1 Copy the example

```bash
cp .env.example .env
```

✅ **You should see** a new `.env`. It is already in `.gitignore` and has been
since the first commit — it cannot be committed by accident.

### 7.2 Generate `MASTER_KEY`

```bash
openssl rand -base64 32
```

✅ **You should see** a 44-character string ending in `=`. Put it in `.env` as
`MASTER_KEY=`.

> 🔒 **Back this up somewhere outside this machine, now.** `MASTER_KEY`
> encrypts the Claude API key and the SMTP password in the database. It is
> deliberately **not** included in backup archives — a backup that carried its
> own decryption key would not be much of a safeguard. Lose the machine and
> this key, and a restored backup comes back with those two credentials
> unreadable. Everything else restores fine, and you can re-enter them.

### 7.3 Set a database password

```bash
openssl rand -base64 24
```

Put it in **both** places it appears — `POSTGRES_PASSWORD` and the password
inside `DATABASE_URL`. They must match.

✅ **You should see** no remaining occurrence of `change-me-before-first-run`:

```bash
grep -n 'change-me-before-first-run' .env || echo "none left — good"
```

### 7.4 Fill in the rest

Work down the file. Here is what each variable does:

**Runtime**

| Variable   | What it does                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV` | `development` while you work through steps 7–8; **`production`** from step 8.5 onward. In production the app requires the Cloudflare Access settings to be present and refuses to boot without them. |

**App**

| Variable       | What it does                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `APP_PORT`     | Container port. Leave at `3000` unless something else has it. If you change it, change `~/.cloudflared/config.yml` to match. |
| `APP_HOSTNAME` | `receipts.<your-domain>`. Used to build absolute URLs, e.g. in receipt emails.                                               |

**Postgres**

| Variable                        | What it does                                                          |
| ------------------------------- | --------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_DB` | Leave as `ledgerly` unless you have a reason.                         |
| `POSTGRES_PASSWORD`             | From 7.3.                                                             |
| `DATABASE_URL`                  | Composed for you by Compose; the password must match 7.3.             |
| `TEST_DATABASE_URL`             | Only used when running the test suite. Ignore for a plain deployment. |

**Redis** — `REDIS_URL` stays `redis://redis:6379`. That is the service name
inside the Compose network, not your machine.

**Secrets**

| Variable     | What it does                                           |
| ------------ | ------------------------------------------------------ |
| `MASTER_KEY` | From 7.2. Encrypts credentials stored in the database. |

**Filesystem** — `UPLOADS_DIR` and `BACKUPS_DIR` are paths _inside_ the
container, backed by named Docker volumes. Leave them alone.

**Cloudflare Access**

| Variable                | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `CF_ACCESS_ENABLED`     | `false` for now; **`true`** from step 8.5.                                      |
| `CF_ACCESS_AUD`         | The 64-hex AUD tag from 5.2.                                                    |
| `CF_ACCESS_TEAM_DOMAIN` | `<your-team-name>.cloudflareaccess.com` from 5.3, no scheme, no trailing slash. |
| `CF_ACCESS_JWKS_TTL_MS` | How long Cloudflare's signing keys are cached. The 1-hour default is fine.      |

**Dev / recovery flags**

| Variable                  | What it does                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DEV_AUTH_BYPASS`         | Skips JWT verification and injects a fixed development identity. **Leave it `false`.** See the warning in 8.3. |
| `ACCESS_ALLOW_SUB_RELINK` | Off except during a deliberate identity-provider migration. See `DEPLOYMENT.md`.                               |

**AI extraction**

| Variable                            | What it does                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                 | From 6.4, or leave blank and use the admin UI (6.5).                                               |
| `AI_MODEL_PASS1` / `AI_MODEL_PASS2` | Bootstrap defaults; the admin screen overrides them. Leave as shipped.                             |
| `AI_ESCALATE_BELOW`                 | Confidence below which a second opinion is requested.                                              |
| `AI_CONCURRENCY`                    | Parallel extractions. `3` is fine. The only one of these four that needs a restart to take effect. |

**Uploads**

| Variable                    | What it does                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MAX_UPLOAD_BYTES`          | Per-file cap, default 50 MB.                                                                                             |
| `RETAIN_ORIGINALS`          | Keep the uploaded file as well as the renders. ~10× storage. EXIF including GPS is stripped either way. Default `false`. |
| `MAX_UPLOAD_MEGAPIXELS`     | Decompression-bomb guard, checked before any decode.                                                                     |
| `UPLOAD_RATE_LIMIT_PER_MIN` | Per user, whole-batch atomic.                                                                                            |
| `INGEST_CONCURRENCY`        | Image-processing workers. Distinct from `AI_CONCURRENCY`.                                                                |

**Misc** — `DEFAULT_CURRENCY`, `BACKUP_RETENTION_DAYS`,
`BACKUP_INCLUDE_IMAGES`, `LOG_RETENTION_DAYS` are documented inline in the
file. See step 11 before changing the backup ones.

### 7.5 Check it over

```bash
grep -c '=' .env
grep -E '^(MASTER_KEY|CF_ACCESS_AUD|CF_ACCESS_TEAM_DOMAIN|APP_HOSTNAME)=' .env
```

✅ **You should see** `MASTER_KEY`, `APP_HOSTNAME` and
`CF_ACCESS_TEAM_DOMAIN` with values, and `CF_ACCESS_AUD` with its 64-hex
value.

---

## 8. First run

### 8.1 Build and start

```bash
docker compose up --build
```

The first build takes several minutes. Leave it in the foreground so you can
read the logs.

✅ **You should see**, in order: images building; `db` reporting
`database system is ready to accept connections`; the webapp applying
migrations; and finally a line showing Next.js ready on port 3000. No
container should be restarting.

### 8.2 Check health

In a second terminal:

```bash
curl -s localhost:3000/api/v1/health
```

✅ **You should see** a JSON response reporting healthy status. If it hangs or
refuses the connection, go back to the logs in 8.1.

### 8.3 Look at it locally (optional)

Open <http://localhost:3000>.

✅ **You should see** the app refuse to identify you. That is correct: with
`CF_ACCESS_ENABLED=false` and no Access token, there is no identity to
establish, and the app fails closed rather than open.

> **Do not try to use `DEV_AUTH_BYPASS` to look around here.** It only works
> under `pnpm dev` on a development machine. The production container is built
> with `NODE_ENV=production` baked into the server bundle, and the app
> **refuses to boot** when the bypass is on in production. Setting it `true` in
> `.env` and running `docker compose up` gets you a container that exits
> immediately and — because `restart: always` is set — crash-loops. That is
> the guard working as designed, not a bug. The way to see the UI is to finish
> steps 8.4–8.6, which takes about five minutes.

### 8.4 Start the tunnel

```bash
cloudflared tunnel run ledgerly
```

✅ **You should see** `Registered tunnel connection` four times (Cloudflare
opens several for redundancy). Leave it running.

### 8.5 Turn on Access enforcement

Stop the stack (`Ctrl-C`), then edit `.env`:

```
NODE_ENV=production
CF_ACCESS_ENABLED=true
```

and start it again:

```bash
docker compose up -d --build
docker compose logs -f webapp
```

✅ **You should see** the app start cleanly with no configuration errors. If it
exits complaining about `CF_ACCESS_AUD` or `CF_ACCESS_TEAM_DOMAIN`, revisit
section 5 — the validation runs at boot precisely so this fails here rather
than at someone's first sign-in.

### 8.6 Visit the real hostname

Open `https://receipts.<your-domain>`.

✅ **You should see** the Cloudflare Access login page, then — after you
authenticate with the email from 4.4 — Ledgerly's own welcome screen. That
round trip proves the whole chain: DNS → Access → tunnel → container → JWT
verification.

---

## 9. Claim the owner account

Ledgerly has exactly one **instance owner**, and it is claimed by whoever
signs in **first**. There is no separate admin bootstrap, no default password,
and no way to be handed ownership later without a manual database change.

### 9.1 Be first

If you have added other people to the Access policy already, sign in before
they do.

### 9.2 Complete the welcome form

Enter your name when prompted.

✅ **You should see** the main Ledgerly screen, with an empty project list.

### 9.3 Confirm you are the owner

✅ **You should see** an **Admin** entry in the navigation. Only the instance
owner sees it. If it is absent, someone else signed in first — see
`DEPLOYMENT.md`, "Recovering the owner account".

### 9.4 Add the Claude API key (if you did not put it in `.env`)

**Admin → Claude API key**, paste the key from 6.4, save. Use the **Test key**
button.

✅ **You should see** the test report success, and the key thereafter displayed
only as a hint like `…abcd (108 characters)`. It is stored encrypted under
`MASTER_KEY` and is never shown in full again — not even to you.

---

## 10. Create a project and upload a test receipt

### 10.1 Create a project

From the main screen, create a project — `Test` will do, or a real one like
`Kitchen remodel`.

✅ **You should see** the project open with no receipts.

### 10.2 Upload a receipt

Use the capture button. On a phone this offers the camera or the photo
library; on a laptop it is a file picker. Any real receipt photo works; a
clear, flat, well-lit one works best.

✅ **You should see** the receipt appear immediately with a "processing"
indicator. The upload and the extraction are deliberately separate: the image
is safely stored before Claude is ever called.

### 10.3 Wait for extraction

Ten to thirty seconds, depending on the model and the image.

✅ **You should see** the merchant, date and total populate on their own. Any
field Claude could not read is listed for your review rather than guessed —
extraction never fails an upload.

### 10.4 Check the fields

Open the receipt.

✅ **You should see** the extracted fields, editable, with line items if the
receipt had them. If a card number appeared on the receipt, you should see at
most the **last four digits** — full card numbers are stripped before anything
is written to the database.

### 10.5 Install it on your phone (optional)

Open `https://receipts.<your-domain>` in Safari on iOS, then **Share → Add to
Home Screen**.

✅ **You should see** a Ledgerly icon on your home screen that opens
full-screen with no browser chrome.

---

## 11. Configure backups

Nothing is backed up until you say so. The admin screen says as much, rather
than implying a safety net that does not exist.

### 11.1 Open the backups screen

**Admin → Backups.**

✅ **You should see** an empty backup list and a note that no schedule is set.

### 11.2 Take one by hand first

Press **Back up now**.

✅ **You should see** a new archive appear with status **complete**, a size, and
a timestamp. A few hundred KB is normal for a near-empty instance.

### 11.3 Set a schedule

Set a nightly cron — `0 3 * * *` runs at 3am. It is stored in the database and
takes effect without a restart.

✅ **You should see** the schedule displayed, with the next run time.

### 11.4 Decide about images

`BACKUP_INCLUDE_IMAGES` defaults to `false`, so **archives contain the
database but not the receipt photographs**. Your figures restore; your images
do not.

For a receipt-capture app that is a significant choice. If you have the disk
space, set `BACKUP_INCLUDE_IMAGES=true` in `.env` and restart. If you leave it
off, make sure you know what your recovery actually gets you.

✅ **You should see**, after a subsequent backup, the archive size jump
substantially if you enabled images.

### 11.5 Copy an archive off this machine

A backup on the same disk as the database is not a backup. Archives live in
the `app_backups` Docker volume and can be downloaded from the admin screen.
Copy them somewhere else — another disk, another machine, cloud storage.

> 🔒 Archives are **not encrypted**. They are `chmod 0600` on disk, but once
> you copy one elsewhere that protection does not travel with it. An archive
> is the whole instance in cleartext: every user, every email address, every
> receipt. Treat it accordingly, and see `DEPLOYMENT.md` for the detail.

✅ **You should see** the downloaded `.tgz` on your local machine.

---

## 12. Run a restore drill

A backup you have never restored is a hypothesis. Do this once, now, while
nothing is at stake — not in six months when something is.

### 12.1 Confirm the tooling

```bash
docker compose exec webapp pg_restore --version
```

✅ **You should see** a version line. It is in the image already.

### 12.2 Read the script's help

```bash
./scripts/restore.sh --help
```

✅ **You should see** usage text explaining the target options.

### 12.3 Restore into a scratch database

**Restore to a scratch database, not over your live one.** The script takes
the archive as a positional argument and restores into the running Compose
stack by default — which is the real-disaster case, not the rehearsal. For a
drill, point it somewhere else with `--database-url` and `--uploads-dir`:

```bash
# Create a scratch database next to the real one.
docker compose exec db psql -U ledgerly -d ledgerly \
  -c 'CREATE DATABASE ledgerly_drill;'

mkdir -p /tmp/ledgerly-drill-uploads

./scripts/restore.sh /path/to/your-backup.tgz \
  --database-url postgres://ledgerly:<your-password>@localhost:5432/ledgerly_drill \
  --uploads-dir /tmp/ledgerly-drill-uploads
```

The other options are worth knowing before you need them:

| Option              | What it does                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--force`           | Proceed even though the target database is not empty. Without it, a non-empty target is **refused** — which is what stops a rehearsal becoming an accident. |
| `--skip-uploads`    | Database only, leaving images untouched.                                                                                                                    |
| `--ignore-checksum` | Proceed despite a member failing its SHA-256. For the disaster where a damaged archive is all you have. Never routine.                                      |
| `--yes`             | Skip the confirmation prompt.                                                                                                                               |

✅ **You should see** the script verify the archive checksum, verify each
member against the manifest, restore, and then print a **row-count comparison**
per table — manifest versus restored — ending in success.

### 12.4 Understand what did _not_ come back

✅ **You should see** the closing note that `MASTER_KEY` is not in the archive.
This is the drill's real lesson: on a machine without the same `MASTER_KEY`,
the Claude API key and SMTP password restore as undecryptable ciphertext and
must be re-entered. Everything else comes back.

### 12.5 Write down what you learned

Record the date, the archive, the row counts and how long it took. When you
need this for real you will be stressed and it will be 2am.

✅ **You should see** your own note somewhere you will find it again. Keep it
out of the repository — `docs/private/` is gitignored for exactly this.

---

## You are done

You now have:

- a private instance reachable only through Cloudflare Access
- no inbound ports and no published home IP
- AI extraction with a spend limit above it
- scheduled backups, and a restore you have actually performed

From here:

- **`DEPLOYMENT.md`** — upgrades, rollback, log locations, backup and restore
  operations, and a troubleshooting section covering the failures this project
  actually hit.
- **`README.md`** — what Ledgerly is and how the pieces fit.
- **`ARCHITECTURE.md`**, **`docs/SCHEMA.md`**, **`DECISIONS.md`** — the design
  and the reasoning behind it.

### Add other people

Add their email to the Access policy from 4.4. They sign in, complete the
welcome form, and become ordinary users — not owners. Add them to a project
from the project's member list, at `read`, `read_add` or `full`.

> Note that **every signed-in user can see the member directory** — the names
> and email addresses of everyone on the instance. This is deliberate and
> documented (D-33): a member picker needs a directory, and everyone here is
> someone you deliberately admitted through Access.
