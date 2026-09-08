# Ledgerly — Project Plan

**Receipt capture and spend tracking, modeled on Forkd.**

Self-hosted PWA behind Cloudflare Tunnel + Cloudflare Access. Users create
projects, photograph receipts, and Claude extracts the structured data.
Everything exports to Excel/CSV for tax and reporting.

> **Status of this document.** This is the original brief as written, preserved
> as the standing reference for later phases. Phase 1 amended it in several
> places — the API layer, the Postgres version, the AI model IDs and pricing,
> and the session model. Where this document and `DECISIONS.md` disagree,
> **`DECISIONS.md` is authoritative.** Each amendment is recorded there with a
> decision ID and rationale.

---

## 0. Ground rules

**The Forkd repo is the spec.** It lives at `/Users/pmalcolm/Documents/Forkd`.
Before anything is designed, Claude Code reads it and produces reference
documents. Where this plan and Forkd disagree on stack, structure, or
convention, **Forkd wins** unless there's a documented reason recorded in
`DECISIONS.md`.

**Nothing sensitive reaches GitHub.** AARs, working notes, threat models, real
hostnames, tunnel IDs, API keys, and screenshots containing real receipts stay
in `docs/private/`, which is gitignored from commit #1 (before there is
anything to leak).

**One phase per Claude Code session.** State is handed off through
`docs/STATE.md`, not through a long context window. This is the single biggest
lever on token spend.

---

## 1. Architecture

### 1.1 Stack

Adopt Forkd's stack. The reconnaissance phase confirms it. As a placeholder for
planning, assume:

| Layer | Assumption (confirm against Forkd) |
|---|---|
| Runtime | Node 22 LTS |
| API | Express or Fastify |
| DB | PostgreSQL 16 (SQLite acceptable if Forkd uses it) |
| Migrations | Whatever Forkd uses — do not introduce a second tool |
| Frontend | Forkd's framework, PWA-first |
| Images | `sharp` + `heic-convert` |
| Container | Docker Compose, single `docker compose up` |
| Ingress | `cloudflared` tunnel, Cloudflare Access in front |

### 1.2 Request path

```
Browser -> Cloudflare Edge -> Access (SSO, issues JWT)
        -> Tunnel -> cloudflared -> app container -> Postgres
                                                  -> ./data/receipts (volume)
                                                  -> Claude API (egress only)
```

The app container is **never** published to a host port in production. All
ingress is via the tunnel. Local dev may bind a port for convenience,
controlled by `APP_PORT` in `.env`.

### 1.3 Data model

```
users
  id, cf_access_sub (unique), email, first_name, last_name,
  role ('owner'|'user'), onboarded_at, created_at, last_seen_at

projects
  id, owner_id -> users, name, description,
  start_date, end_date, status ('active'|'archived'),
  created_at, archived_at

project_members
  project_id, user_id, permission ('read'|'read_add'|'full'),
  granted_by, granted_at
  PRIMARY KEY (project_id, user_id)

receipts
  id, project_id, uploaded_by,
  merchant_name, merchant_address, merchant_phone,
  transaction_date, transaction_time,
  subtotal, sales_tax, tip, total, currency,
  card_last4, payment_method,
  image_key, thumb_key, original_key (nullable),
  extraction_status ('pending'|'ok'|'partial'|'failed'),
  extraction_model, extraction_confidence, extraction_raw jsonb,
  missing_fields text[], user_notes,
  created_at, updated_at, deleted_at

receipt_items
  id, receipt_id, line_no, description, quantity,
  unit_price, line_total, category_id, sku,
  ai_assigned_category boolean, confidence

categories
  id, name, slug, is_system, color, sort_order
  (system defaults seeded; instance-wide, not per-project)

audit_log
  id, actor_user_id, action, entity_type, entity_id,
  metadata jsonb, ip, created_at

backups
  id, kind ('manual'|'scheduled'), path, size_bytes,
  db_included, images_included, status, created_at
```

**Seed categories:** Building Supplies, Tools & Equipment, Household, Food &
Dining, Transportation & Fuel, Lodging & Travel, Professional Services,
Utilities, Office Supplies, Shipping & Postage, Permits & Fees, Labor &
Subcontractors, Uncategorized.

**Every extracted field is nullable.** Extraction never fails the upload.
Fields that could not be read land in `missing_fields[]` and surface as a
review badge on the receipt.

### 1.4 Auth and authorization

Cloudflare Access sends `Cf-Access-Jwt-Assertion` on every request.

1. Verify the JWT signature against
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cache the JWKS
   with a TTL.
2. Validate `aud` equals the Access application AUD tag from `.env`. **A missing
   or wrong `aud` is a hard reject** — this is what stops a JWT minted for a
   different Access app in the same account from working here.
3. Validate `iss`, `exp`, `nbf`.
4. Never trust `Cf-Access-Authenticated-User-Email` on its own. It is a
   convenience header, not an authentication.
5. Identity comes from the JWT `sub` claim, not the email. Emails change; `sub`
   does not.

**First-user-becomes-owner** must be atomic. Inside a single transaction:
`SELECT ... WHERE role='owner' FOR UPDATE`, and if none exists, insert this user
as owner. Two simultaneous first requests must not both win. Cover this with a
test.

**Onboarding:** if `first_name` or `last_name` is null, every non-onboarding
route returns a 428-style redirect to the name capture screen.

**Permission matrix:**

| | View project | Add receipts | Edit/delete receipts | Manage members | Delete project |
|---|---|---|---|---|---|
| `read` | yes | no | no | no | no |
| `read_add` | yes | yes | own only | no | no |
| `full` | yes | yes | yes | yes | no |
| Project owner | yes | yes | yes | yes | yes |
| Instance owner | yes, all projects | yes | yes | yes | yes |

Enforce at the **query layer**, not in route handlers. A single
`scopedProjects(user)` helper that every query composes with. Route-level checks
get forgotten; query-level checks cannot be.

**Dev bypass:** `DEV_AUTH_BYPASS=true` injects a fake identity for local work.
The app must refuse to boot if this is set while `NODE_ENV=production`. Fail
loud, at startup, not at request time.

### 1.5 Image pipeline

Accept anything the camera or file picker produces: JPEG, PNG, HEIC/HEIF, WebP,
TIFF, PDF (first page).

```
upload -> size guard (reject > 50 MB pre-decode)
       -> pixel guard (reject > 100 MP, decompression bomb defense)
       -> HEIC/PDF -> raster
       -> EXIF orientation applied, EXIF then stripped (GPS is in there)
       -> [A] extraction render: longest edge 2200px, JPEG q88  <- sent to Claude, then discarded
       -> [B] stored display:   longest edge 1600px, WebP q72
       -> [C] stored thumb:     longest edge 320px,  WebP q60
```

**Extract before you compress.** Run the AI pass on the high-quality render (A),
not the archival copy (B). Compression artifacts eat small print, and small
print is where the tax line lives. (A) is temporary and never written to
permanent storage.

Target for (B): under 300 KB, which is roughly 3,500 receipts per GB.

`RETAIN_ORIGINALS` env flag, default `false`. When true, the untouched upload is
kept alongside. Document the storage cost in `SETUP.md` so the choice is
informed.

**Storage layout:** `data/receipts/<project_id>/<receipt_id>/{display,thumb,original}.<ext>`.
Filenames are UUID-derived, never user-supplied — that closes path traversal by
construction. Images are served through an authenticated app route that checks
project access, never as static files.

### 1.6 Claude extraction

Model routing, cheapest-first:

| Pass | Model | When |
|---|---|---|
| 1 | `claude-haiku-4-5-20251001` | Every receipt |
| 2 | `claude-sonnet-5` | Escalate if pass 1 returns null `total`, null `transaction_date`, zero line items, or self-reported low confidence |

Haiku is $1/$5 per MTok against Sonnet 5 at $2/$10, and a typical receipt image
runs roughly 1–2k input tokens. Most receipts are legible and never escalate.
Track escalation rate in the admin view; if it exceeds ~30%, go Sonnet-first and
skip the double spend.

**Use tool-use with an input schema, not "please return JSON."** A forced schema
is dramatically more reliable than prompt-and-parse, and it eliminates the
markdown-fence stripping that plagues JSON-mode prompting.

Sketch:

```json
{
  "name": "record_receipt",
  "description": "Record the structured contents of a receipt image.",
  "input_schema": {
    "type": "object",
    "properties": {
      "merchant_name":     { "type": ["string","null"] },
      "merchant_address":  { "type": ["string","null"] },
      "transaction_date":  { "type": ["string","null"], "description": "ISO 8601 date" },
      "subtotal":          { "type": ["number","null"] },
      "sales_tax":         { "type": ["number","null"] },
      "total":             { "type": ["number","null"] },
      "card_last4":        { "type": ["string","null"], "description": "Last 4 digits only. Never the full number." },
      "payment_method":    { "type": ["string","null"] },
      "confidence":        { "type": "number", "description": "0.0-1.0, your confidence in this extraction" },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "description": { "type": "string" },
            "quantity":    { "type": ["number","null"] },
            "unit_price":  { "type": ["number","null"] },
            "line_total":  { "type": ["number","null"] },
            "category":    { "type": "string", "enum": ["<seeded categories>"] }
          },
          "required": ["description"]
        }
      }
    },
    "required": ["confidence", "items"]
  }
}
```

Prompt instructions that matter: return `null` rather than guessing; do not
invent line items that are not printed; `card_last4` is exactly four digits or
null; assign every item a category from the enum, using `Uncategorized` when
genuinely unclear.

**Post-processing, non-negotiable:** scrub the model output for any 13–19 digit
sequence that passes a Luhn check and drop it before it touches the database.
Full card numbers are printed on some receipts. The app must never be the thing
that stores one.

**Sanity checks** that set `extraction_status='partial'` rather than silently
accepting: `subtotal + sales_tax` more than 2 cents from `total`; sum of
`line_total` more than a dollar from `subtotal`; `transaction_date` in the
future or before 2000.

Store `extraction_raw` verbatim. When a user reports a bad read, you need the
original response to debug it.

Queue uploads. Batch camera-roll imports must not fire 40 concurrent API calls —
a small worker with a concurrency cap of 2–3 and exponential backoff on
429/529.

### 1.7 Export

Two sheets in the XLSX; CSV emits the line-item sheet only.

**Sheet 1 — Line Items** (one row per item):
`project_name, receipt_id, transaction_date, merchant, category,
item_description, quantity, unit_price, line_total, card_last4, uploaded_by,
receipt_notes, image_filename`

**Sheet 2 — Receipts** (one row per receipt):
`receipt_id, transaction_date, merchant, subtotal, sales_tax, total,
card_last4, item_count, payment_method, uploaded_by, needs_review`

Receipt-level totals live **only** on sheet 2. Repeating `total` on every line
item row is how spreadsheet exports quietly triple people's deductions when
someone drags a SUM down the column. Keep the grains separate.

Respect active filters (date range, category) and note the applied filter in a
header row so an export can be reproduced later.

### 1.8 Backups

**Manual:** admin button -> `pg_dump` + optional image tarball -> streamed
download, logged to `backups` table.

**Scheduled:** nightly cron in-container, writes to the `./backups` volume,
retention `BACKUP_RETENTION_DAYS` (default 30), prunes oldest.

Every backup writes a `manifest.json` with schema version, row counts, image
count, and a checksum. `BACKUP_INCLUDE_IMAGES` toggles image inclusion — DB-only
backups are small enough to run nightly forever, images are not.

**Ship a restore script and test it.** A backup that has never been restored is
a hypothesis. `SETUP.md` includes a restore drill.

### 1.9 PWA

Manifest, icons, offline app shell, `display: standalone`, iOS splash screens.

Camera capture:
`<input type="file" accept="image/*" capture="environment" multiple>`.

**Service worker gotchas** (verify how Forkd handled these — this is exactly the
kind of hard-won detail the reference doc should capture):

- Never cache authenticated API responses.
- Cloudflare Access returns a **302 to the login page** when a session expires.
  If the SW caches that redirect as if it were your app shell, the PWA bricks
  until the user clears site data. Bypass the SW for anything that returns a
  redirect or a non-200, and never cache opaque responses.
- Navigation preload plus a network-first shell strategy avoids most of this.

---

## 2. Phases

Each phase is one Claude Code session. Each ends by updating `docs/STATE.md` and
committing.

| # | Phase | Primary model | Deliverables | Gate |
|---|---|---|---|---|
| 0 | Recon & bootstrap | Opus (plan) + Haiku (explore) | `docs/reference/FORKD_*.md`, git repo local+remote, CLAUDE.md, .gitignore | You review the reference docs |
| 1 | Architecture & decisions | Opus | `ARCHITECTURE.md`, `DECISIONS.md`, schema, `docs/PHASES.md` | You approve the schema |
| 2 | Foundation | Sonnet | Compose, `.env.example`, migrations, health check, CI skeleton, gitleaks | `docker compose up` is green, Actions pass |
| 3 | Auth & identity | Opus (design) -> Sonnet (build) | JWT verify, atomic first-owner, onboarding, RBAC helper, dev bypass guard | Tests cover the race and the `aud` reject |
| 4 | Projects & permissions | Sonnet | Project CRUD, membership, permission matrix enforced at query layer | Permission matrix test suite green |
| 5 | Ingest pipeline | Sonnet | Upload, HEIC/PDF, EXIF strip, 3-render pipeline, authed image serving | Real HEIC from your phone round-trips |
| 6 | AI extraction | Sonnet | Tool-use schema, Haiku->Sonnet escalation, PAN scrub, sanity checks, queue | 10 real receipts extracted, accuracy logged |
| 7 | UI & PWA | Sonnet + `frontend-design` | Dashboard, receipt list/detail/edit, review queue, categories, filters, PWA shell | Usable on your phone through the tunnel |
| 8 | Export | Sonnet | CSV + XLSX, two-sheet structure, filter-aware | Opens clean in Excel, totals reconcile |
| 9 | Backups | Sonnet | Manual, scheduled, manifest, restore script | Restore drill succeeds on a scratch DB |
| 10 | Hardening & docs | Opus (review) -> Sonnet (fix) | Security review, `SETUP.md`, `DEPLOYMENT.md`, secret scan, v1.0.0 tag | You complete a clean-machine setup |

Phases 5 and 7 can run in parallel in two terminals once phase 4 lands, since
they touch different directories. Everything else is sequential.

---

## 3. Deliverables

**In the repo:**

- Working app, `docker compose up` from a clean checkout
- `README.md` — what it is, quickstart
- `SETUP.md` — step-by-step, including Cloudflare Tunnel, Cloudflare Access
  policy, and Anthropic API key provisioning, written for someone who has done
  none of it before
- `DEPLOYMENT.md` — production deploy, upgrades, rollback, restore drill
- `ARCHITECTURE.md`, `DECISIONS.md`
- `.env.example` with every variable documented and no real values
- GitHub Actions: lint, test, docker build, gitleaks

**Not in the repo** (`docs/private/`, gitignored):

- AARs and retrospectives
- Real tunnel IDs, hostnames, team domain, AUD tags
- Threat model notes
- Screenshots containing real receipt data

---

## 4. Security checklist

Phase 10 verifies every line. Any unchecked item blocks the v1.0.0 tag.

- [ ] Access JWT signature verified against JWKS, with cache TTL
- [ ] `aud` validated against configured AUD tag
- [ ] `Cf-Access-Authenticated-User-Email` never used as the sole identity source
- [ ] Identity keyed on `sub`, not email
- [ ] First-owner assignment atomic, race-tested
- [ ] `DEV_AUTH_BYPASS` refuses to boot under `NODE_ENV=production`
- [ ] Authorization enforced at the query layer via a single scoping helper
- [ ] Full card numbers scrubbed from AI output before persistence (Luhn check)
- [ ] EXIF stripped from all stored images (GPS)
- [ ] Images served only through authenticated routes
- [ ] Upload size and pixel-count guards before decode
- [ ] Filenames UUID-derived, never user-supplied
- [ ] Upload rate limiting per user
- [ ] Anthropic API key server-side only, never logged, never in a client bundle
- [ ] `.env`, `data/`, `backups/`, `docs/private/` gitignored from commit #1
- [ ] gitleaks passing in CI and as a pre-commit hook
- [ ] Full git history scanned for secrets before the repo goes public (if it ever does)
- [ ] Service worker never caches authenticated responses or Access redirects
- [ ] Audit log records permission grants, deletions, and exports
- [ ] Container runs as non-root
- [ ] Restore drill completed and documented

---

## 5. Open decisions

Record answers in `DECISIONS.md` as they're made:

1. **Postgres or SQLite?** Follow Forkd. SQLite makes backups trivially simple;
   Postgres scales past one writer. For a personal receipt app, SQLite is
   defensible.
2. **Retain originals?** Default no. Storage grows roughly 10x if yes.
3. **Public repo or private?** If ever public, the full history needs a secret
   scan first, not just the tip.
4. **Multi-currency?** Schema has the column. Defer the UI unless you need it.
5. **PDF receipts?** First page only in v1, or full multi-page. First page is
   simpler and covers most cases.
