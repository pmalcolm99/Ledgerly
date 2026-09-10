# Ledgerly — Build State

Updated at the end of every phase. Read this first in any new session.

## Current phase

**Phase 9 — Backup and restore. Complete, reviewed, and GATED.** The gate is
"the restore drill succeeds on a scratch database", and it did — the numbers are
below and in `docs/private/PHASE9_RESTORE_DRILL.md` (gitignored).

Phase 8's gate stays half-closed on the Excel half, Phase 7's on the on-device
check, and Phase 6's on the two live-API tasks (6.3, 6.12) that need a real
`ANTHROPIC_API_KEY`; D-12 stays Provisional. All three are unchanged by this
phase and still listed under "Blocked / open questions".

## Phase 9 — Backups (D-45)

Almost all of the scaffolding was already in place: the `backups` table and its
two enums shipped in migration `0000`, `BACKUPS_DIR`/`BACKUP_RETENTION_DAYS`/
`BACKUP_INCLUDE_IMAGES` were in `packages/config` since Phase 2, the
`app_backups` volume and `postgresql17-client`+`tar` were in the compose file
and the image from the start, and `admin.backups` existed as a read-only query
behind a **disabled** "Backups arrive in phase 9" button. **Phase 9 needed no
migration.** It is the job, the schedule, the download, the script and the
drill.

### The three decisions, all put to you first (D-45)

1. **The cron lives only in `app_config`**, not in the environment. The brief
   said "configurable via env"; ARCHITECTURE.md §8.3, docs/SCHEMA.md and task
   9.3's acceptance ("reschedules without a restart") all said `app_config`, and
   the documents won. There is no `BACKUP_SCHEDULE` variable, and `.env.example`
   says so explicitly so its absence reads as a decision rather than an
   oversight.
2. **The job writes the archive; the download is a separate route.** A
   tee-while-writing design was rejected because the manifest checksums the
   dump — the dump has to be finalised before the archive can be described, so
   a streaming version would have to omit the checksums or lie about them.
3. **`scripts/restore.sh` targets both** the compose stack and an arbitrary
   `--database-url`. The drill uses the second form, so **the drill exercises
   the shipped script** rather than a hand-run `pg_restore`.

### The shape, and why

**Failure is loud by construction, because that is the whole point.** A backup
system that fails silently is worse than none: it manufactures confidence. So
every way this can quietly stop working has a visible surface — a reason code on
the row and a `console.error` from the worker's `failed` handler; a boot sweep
that marks any row still `running` after a restart as `INTERRUPTED` (a backup
cannot survive a restart, so such a row is by definition orphaned) and deletes
`.part`/`.staging` debris; an `undecryptable` schedule reported as itself rather
than as "not configured"; and a **"configured but not registered"** callout for
the case where `app_config` holds a cron and Redis holds no scheduler. That last
one is not exotic: **Redis is not in any backup**, so it is the normal state
after a `redis_data` loss.

**`admin.backupStatus` reports the two next-run figures separately** — the one
computed from the stored cron, and the one BullMQ's scheduler actually holds.
They agree in every healthy state; the case where they disagree is the finding.
A `null` scheduler reading ("we could not ask") is deliberately distinct from
`registered: false` ("we asked, and nothing is there"), because the UI must
raise an alarm on the second and not the first.

**The archive is written under `.part` and renamed on success.**
`docker-compose.yml` sets `stop_grace_period: 30s` and a real `pg_dump` with
images can outlive it, so SIGKILL mid-`tar` is reachable, not theoretical. A
truncated file that looks like a backup is worse than no file.

**The database password never enters argv.** `pgEnvAndFlags` passes host, port,
user and database as flags and the password in the child's `PGPASSWORD`, because
argv is world-readable through `/proc/<pid>/cmdline` — a `postgres://user:pass@`
URI there would put the password in front of anything that can run `ps` in the
container.

**Row counts come from ONE query.** Counting table by table would let a
concurrent upload land between two counts and produce a manifest whose numbers
cannot all be true at once — and the manifest's entire job is to be the thing a
restore is checked against. The table list is **derived from the drizzle schema**
(`packages/db/src/tables.ts`) rather than hand-written, so a table added in a
later phase cannot silently stop being counted while the manifest keeps
reporting a clean match.

**The schema version is read from `drizzle.__drizzle_migrations`** — what is
actually applied to the database being dumped, not what the repo happens to
contain. That is what lets `restore.sh` tell an old backup from a new one and
migrate forward instead of failing in a SQL error twenty statements deep.

**Retention unlinks the file before it soft-deletes the row.** A crash between
the two then leaves a row claiming a file that is gone — visible in the admin
view, which already computes `hasArtifact` from `path IS NOT NULL`, and
harmless. The other order leaves a file no row admits to: invisible, never
pruned again, and it fills the disk.

**`backups.path` never reaches a client.** The download route takes a row id,
resolves the path server-side, and asserts the resolved path is inside
`BACKUPS_DIR` after `realpath` — defence in depth against a row edited in the
database or a symlink planted in the volume, not input validation. Owner-only,
and **404 for a non-owner, byte-identical to the 404 for a nonexistent backup**,
so the endpoint cannot be used to count how many backups this instance has.

### The restore drill (task 9.6) — the gate

Seven drills, all against `ledgerly-test-db`, never the application database.
Full detail in `docs/private/PHASE9_RESTORE_DRILL.md`.

**Drill 1 — the gate.** A source database with 3 users, 3 projects (one
archived), 5 membership rows, 24 receipts across every `extraction_status`, 40
line items, 10 `ai_usage` rows, 8 `audit_log` rows, an encrypted `app_config`
row, and a 40-file uploads tree. Backed up by the real pipeline with
`BACKUP_INCLUDE_IMAGES=true`, restored into a scratch database **by the shipped
script**:

```
  ok  ai_usage 10   app_config 1   audit_log 8    backups 2
  ok  categories 15 instance_state 1 project_members 5
  ok  projects 3    receipt_items 40 receipts 24   users 3
  ok  images 40
==> restore verified against the manifest
```

`backups` reads 2, not 1, because the manifest counts rows at dump time and the
backup's own `running` row is in the dump. Correct, and worth stating before
someone reads it as an off-by-one.

Row counts prove nothing about contents, so the drill went further: an
`md5(string_agg(t::text))` over **all ten data tables** matches source-to-restore
on every one; `sum(total)` = **2828.08** and `sum(line_total)` = **1000.00** on
both sides; the status distribution (`pending=4 ok=12 partial=4 failed=4`) is
identical; 13 foreign keys, 32 indexes, 16 enum values and 11 check constraints
survive; the encrypted `app_config` row restores as ciphertext byte for byte;
and `diff -r` over the two uploads trees is clean.

**Drills 2–7, the refusals** — all pass:

| #   | Drill                                | Outcome                                                                                                                                                                        |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2   | Non-empty target, no `--force`       | Refused, and printed what it found (11 tables, 24 receipts, 3 users) before declining                                                                                          |
| 3   | One byte flipped in `db.dump`        | Checksum mismatch, refused **before touching the database** — and refused even with `--force`, since `--force` covers a non-empty target, not a damaged archive                |
| 4   | Backup at migration 5, checkout at 6 | Said so plainly, migrated forward, and `receipt_email_sent_at` arrived                                                                                                         |
| 5   | Backup at migration 7, checkout at 6 | Refused — migrations are forward-only, so there is nothing honest to do                                                                                                        |
| 6   | `--force` / `--ignore-checksum`      | Both do what they say; `--ignore-checksum` warns twice in the loudest wording the script has                                                                                   |
| 7   | Compose mode against the live stack  | Detected the running `db`, read `.env` without sourcing it, found the real database (7 receipts, 2 users) and refused. **Read-only — its write path was deliberately not run** |

The production image was checked directly rather than assumed: `pg_dump
(PostgreSQL) 17.11` on `PATH` inside `ledgerly-webapp-1`, `/app/backups` owned
by and writable by `node`.

**And the drill is now a standing test.** `pipeline/backupRoundTrip.test.ts`
takes a real `pg_dump` and restores it into a freshly created scratch database
**by running `scripts/restore.sh`** — the shipped script, from a directory that
is not the repo root — then asserts the row counts equal the manifest. Two more
cases assert it REFUSES a damaged archive and a manifest shape it does not
understand, which are the outcomes that actually protect anyone. So the gate
does not decay back into a hypothesis after this session. It skips, loudly on stderr, when the client
tools are absent or when `pg_dump` is older than the server (which it refuses
outright). `backupScheduler.test.ts` covers task 9.3's acceptance against a real
Redis: a second `upsertJobScheduler` **replaces** rather than accumulating, so
changing the cron reschedules without a restart.

### Review — what was found and what was done

The `reviewer` pass found **2 high, 9 medium and 8 low**, and separately traced
clean: credential handling through every error, log, audit row and `failedReason`
path (verified empirically, not read — a rejected `pg_dump` carries host, port,
user and database but no password, through the whole `[cause]` chain); the
download route's 404-not-403 uniformity and its `realpath` containment; `path`
and `manifest` never reaching a client; every new procedure being
`ownerProcedure`; the BullMQ jobId/`removeOn*` trap; `undecryptable` handling
and both its recovery paths; and `appTableNames()` returning exactly the real
tables. All 19 findings are fixed.

Two of them are the phase's own thesis turned against it, and both were
demonstrated rather than argued:

| Sev      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **High** | **"Restore verified against the manifest" could be printed having verified nothing.** Both verification loops are `while … done < <(python3 …)` over `files` and `tables`; an empty or renamed list makes the body never run, the counters stay at zero, and the script reports success. Shown end to end with a plausible future `manifestVersion: 2`: zero files checksummed, zero tables counted, target wiped, declared verified.                                                                                                  | Refuse anything that is not `app: "ledgerly"` and `manifestVersion: 1`, refuse an empty `files` or `tables`, and assert afterwards that the number of entries actually checked equals the number listed. A verification step that silently degrades to a no-op is worse than none — it is the one line the operator reads. |
| **High** | **The manifest's row counts described a different instant than the dump.** `pg_dump` takes its own snapshot; `countRows` ran afterwards in a separate transaction. One receipt uploaded during a nightly backup and four tables read high — with the bill arriving weeks later, mid-recovery, when `restore.sh` refuses to call a byte-perfect restore verified, after it has already overwritten the target.                                                                                                                          | One REPEATABLE READ READ ONLY transaction exports a snapshot, `pg_dump` is handed it via `--snapshot`, and the counts run inside that same transaction. Same instant by construction. The image count moved from a directory walk to a `tar -tf` of the finished archive, for the identical reason.                        |
| Med      | **The boot sweep raced the worker that started it.** `autorun: true` meant a job left waiting by a `docker stop` was picked up immediately, so the sweep could delete the staging directory out from under a live `pg_dump` and mark its row `INTERRUPTED` — the sweep's "nothing is running, so anything here is debris" premise was simply false.                                                                                                                                                                                    | `autorun: false`, reconcile, then `worker.run()`. The only worker in the app built that way, and the comment says why.                                                                                                                                                                                                     |
| Med      | **A stalled job wedged manual backups until a restart.** The `failed` handler returns early while attempts remain, on the assumption a retry is coming; BullMQ's stalled path fails a job without that being true, leaving the row `running` forever — CONFLICT on every press, button disabled, no way out short of a restart.                                                                                                                                                                                                        | Only a `running` row younger than `PG_DUMP_TIMEOUT_MS` blocks a new one. A dump cannot outlive its own timeout, so anything older is not running.                                                                                                                                                                          |
| Med      | **Archives could orphan on the volume with nothing able to reclaim them.** `pruneBackups` ran inside the try after the row was already `complete`; a throw there failed the job, BullMQ retried, `ensureBackupRow` repointed the same row at a second archive — and the first was invisible to `pruneBackups` (which walks rows) and to `clearBackupWorkspace` (which only removes `.part`).                                                                                                                                           | Retention is housekeeping and now cannot fail the job: its own try/catch, outside everything.                                                                                                                                                                                                                              |
| Med      | **A stale scheduler rendered as fully healthy.** `getBackupScheduleState` returns the scheduler's own `pattern` and `backupStatus` discarded it. Save the cron, have the reschedule fail on a Redis blip (which reports in success green, deliberately), and Redis keeps the OLD scheduler: `registered: true`, no callout, and a next-run computed from the new cron while backups run at the old time indefinitely.                                                                                                                  | The pattern travels, and the card renders a danger callout when it disagrees with the saved cron. The two next-run figures were collected separately for exactly this and were then never compared.                                                                                                                        |
| Med      | **Nothing on the card noticed that backups had stopped happening.** "Next scheduled run" is always in the future because it is computed from the cron, and "Last backup" is a bare timestamp. A worker not consuming its queue, or a host off at 3am every night, produced a screen where every individual figure looked fine.                                                                                                                                                                                                         | An overdue callout: the cron's own period, doubled plus a day of slack, capped at the retention window. A nightly backup has to be three days late before it fires.                                                                                                                                                        |
| Med      | **`scripts/restore.sh` put the database password in argv** — `psql "$URL"`, `pg_restore --dbname="$URL"` — undoing on the restore side exactly what `pgEnvAndFlags` exists to prevent on the backup side, in the example SETUP.md tells operators to type.                                                                                                                                                                                                                                                                             | Parsed once into `PGPASSWORD` plus `-h/-p/-U/-d`, mirroring `pgEnvAndFlags`, and unset from the shell afterwards.                                                                                                                                                                                                          |
| Med      | **A relative `--uploads-dir` silently targeted the wrong directory.** `cd "$REPO_ROOT"` happens before argument parsing, so SETUP.md's own `./scratch-uploads` form resolved against the repo root — and that path is what `find … -delete` runs on and what the image count is then verified in, so it reported the restore verified having emptied somewhere else.                                                                                                                                                                   | Paths resolve against the invocation directory, captured before the `cd`. The confirmation prompt now names the uploads directory too — it was a recursive delete the operator was never shown.                                                                                                                            |
| Med      | **Compose mode restored under a live webapp**, so `--clean`'s DROPs contended with live connections and the row-count check raced the `audit_log` writes those requests were making.                                                                                                                                                                                                                                                                                                                                                   | `docker compose stop webapp` first, `start` after, and an EXIT trap that brings it back if the restore dies partway. Plus a note about Redis holding pre-restore job state.                                                                                                                                                |
| Med      | **`restore.sh` had no test at all**, contradicting its own header ("the thing that gets tested and the thing an operator reaches for at 2am are the same file") and D-45. The round-trip test reimplemented the restore with a direct `pg_restore` call.                                                                                                                                                                                                                                                                               | The round-trip test now RUNS the script — from a directory that is not the repo root, so the path bug above is covered — and two new cases assert it refuses a damaged archive and a manifest it does not understand.                                                                                                      |
| Low ×8   | Prune could unlink a path outside `BACKUPS_DIR` (the download route guards the read direction; the delete direction did not); a sidecar that would not unlink skipped the soft-delete, so the row could never be pruned; `read_env` under `set -e` made its own `die` unreachable; `--help` printed one line; `createBackup` was a read-then-insert race; one-second archive names could clobber via `fs.rename`; `measureTree` counted symlinks where `restore.sh` counts `-type f`; the compose dump used a predictable `/tmp` path. | All fixed — containment guard, independent sidecar try, `                                                                                                                                                                                                                                                                  |     | true`, a real `--help`range,`pg_advisory_xact_lock` (`FOR UPDATE`locks nothing when nothing is running — the first-owner trap), the row id in the filename, regular files only, and`mktemp` in the container. |

### Verification

**761 unit tests**, up from 670. `pnpm build` still traces
`sharp`/`bullmq`/`ioredis` — and now `cron-parser` — into
`.next/standalone/node_modules`.

`cron-parser` is a new direct dependency of `packages/api`, declared rather than
borrowed from BullMQ's transitive tree, matching the sharp/bullmq/exceljs
precedent. It is used for validation and next-run only; the scheduler itself is
BullMQ's.

**A `.gitignore` rule nearly shipped this feature without its endpoint.** The
`backups/` line — meant for the backup volume at the repo root — is unanchored,
so it matches a directory of that name at any depth, and it silently swallowed
`apps/web/src/app/api/admin/backups/` with the entire download route and its
twelve tests inside. `git status` showed a clean tree; `git status --ignored`
(which `CLAUDE.md` requires before a first-time commit of a new directory, and
which is the only reason this was caught) showed the directory as ignored. The
download button would have shipped calling a 404, and CI would have agreed
everything was fine because the tests were not in the repository either. `data/`,
`uploads/` and `backups/` are now `/data/`, `/uploads/` and `/backups/`, which
is what they always meant.

One thing worth recording about the restore script: **it is deliberately not
copied into the runner image**, contrary to the first draft of the plan. Its
compose mode drives `docker compose` from outside the container and it needs
`python3`, which ARCHITECTURE.md §8.1 explicitly drops from that image. An
operator reaches it from a checkout — which is how they got `docker-compose.yml`
in the first place.

## Email Receipts (D-44)

Commit 3 of the post-Phase-8 batch, and the only genuinely new feature in it:
an SMTP relay configured by the instance owner, a per-project setting that
emails the project owner once per scanned receipt, and an on-demand send for
any single receipt.

### The shape, and why

**SMTP settings are one encrypted `app_config` blob**, reusing D-39's
`secrets.ts` machinery. `packages/api/src/smtp.ts` mirrors `aiKey.ts`,
including `undecryptable` as a real state and a description type with **no
field capable of holding the password** — which is the mechanism, not the
discipline. No environment fallback: the Claude key needs one because a fresh
instance must extract before anyone visits the admin screen, and email has no
equivalent bootstrap problem.

**Sending is a third queue, `receipt-email`,** not a step inside extraction.
This is the decision that matters most. An inline send would put a mail relay
in the retry path of a job that spends money — a relay hiccup would burn two
more paid Anthropic calls and then write `extraction_status='failed'` on a
receipt whose extraction succeeded. The enqueue happens after
`processReceiptExtraction` returns, outside its persistence transaction, and is
wrapped so that even a Redis failure cannot fail the extraction job.

**`receipts.receipt_email_sent_at` is load-bearing.** `receipts.reextract` sets
`forcePass2` and re-enters persistence, so without a durable marker every
manual re-extract would send again. Written after the send, not before, so a
failure retries rather than being suppressed by a marker for mail that never
went.

**The recipient is a user id, never an address.** `receipts.emailReceipt` takes
`toUserId`, checked against membership in the procedure and again in the
worker. Mailing a receipt to an arbitrary address is not a validation failure —
it is an operation the API cannot express. Read access is enough to send:
forwarding to a fellow member discloses nothing either could not already open.

**`nodemailer` is in `packages/queue` only.** `pipeline/email.ts` takes the
transport as a structurally-typed dependency and never names the library. The
one synchronous send is `admin.testSmtp`, and even that reaches the library
through an injected context capability supplied by `apps/web`'s route handler.

### Fixed while in the file

The **Test button on the Claude API key card did not exist**. Commit 1 added
`admin.testAiKey`, wired `onTest`/`testing` through `KeyForm`'s props — and
never rendered the button. The procedure, its rate limit and its six tests were
all real; the control was not. Now rendered, and it tests the STORED key rather
than the draft, so it stays available while the input is empty, which is its
normal state.

### Verification

**670 unit tests**, up from 638 — 16 for the message rendering (null merchant,
no line items, an uncategorised item, a credit rendered negative, HTML escaping
of every interpolated field), 10 DB-backed for the send (once-only marker,
setting read at send time, soft-deleted receipt, non-member recipient, the
attachment's JPEG magic bytes and size ceiling), and 12 for the API surface
(owner-only, password never in the response, blank-password-means-unchanged,
the audit row carrying the host and neither credential).

`nodemailer` is webpack-bundled rather than external, so the pnpm standalone
tracing trap that forced `sharp`/`bullmq`/`exceljs` to be direct dependencies
of `apps/web` does not apply. Verified three ways against a real standalone
build rather than argued: the SMTP transport is present inside the emitted
chunk, the containerised `receipt-email` worker starts and registers its queue
in Redis, and **a receipt email was delivered end to end through smtp2go from
that container** — settings saved from the admin screen, sent on demand from a
receipt, audited, with the automatic-send marker correctly left null.

### Review — what was found and what was done

The `reviewer` pass found 1 high, 3 medium and 5 low, and separately traced
clean: secret disclosure across every path (return types, the error formatter,
zod issue payloads, superjson, the relay's own error text, worker logs, audit
metadata, the client bundle), authorization on `emailReceipt`, HTML escaping and
header injection, attachment EXIF/metadata hygiene, card-number scrubbing on
every field the email renders, failure containment around the extraction job,
the migration's lock behaviour, and money/null handling. All nine findings
fixed before commit.

| Sev      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **High** | **A terminally-failed auto email blocked that receipt from ever auto-emailing again.** `removeOnFail: {count: 50}` retained the job hash, and BullMQ's `addStandardJob` returns early — reporting SUCCESS — when a hash with the same id exists. So the stable `<receiptId>:auto` job id stayed parked and every later enqueue was a silent no-op that threw nothing to catch. Turn the project toggle on before configuring SMTP, and every receipt uploaded in that window could never auto-email afterwards — including via re-extract, the obvious remedy and the entire reason the marker exists. | `removeOnFail: {count: 0}`, matching the other two queues, which use it for exactly this reason. The durable record of a failure is the `failed` handler's log line, not the Redis-resident job.                                                                                                       |
| Med      | **A failed marker write turned one send into up to five.** The write is after the send so a crash costs one duplicate — accepted. But letting it THROW made the job retryable after a successful send, and the retry re-read a marker still null. Pool saturation while several extractions land at once — exactly when these fire — would deliver five copies.                                                                                                                                                                                                                                        | The marker write is wrapped and logged, never rethrown. Caps the damage at one possible duplicate on a later re-extract, which the design already accepts.                                                                                                                                             |
| Med      | **Any project reader could burn the operator's relay quota.** `emailReceipt` needs only `read`, and 5/min sustained is >7,000 messages a day — enough to exhaust a 10,000/month plan in under two days and take the sending reputation with it.                                                                                                                                                                                                                                                                                                                                                        | A second budget, 60/day, via a new `checkWindowedRateLimit`. Charged only after the per-minute check admits, so hammering the minute limit cannot burn the day's allowance. The project flag deliberately still does NOT gate on-demand sends — that was an explicit requirement.                      |
| Low      | **The audit row committed before the enqueue**, so a Redis failure left the log asserting an email that was never queued, and the caller saw the flattened "Internal server error."                                                                                                                                                                                                                                                                                                                                                                                                                    | Renamed to `receipt.email_requested` (the honest claim, and `reextract`'s own convention), the enqueue failure is caught and logged, and it now returns `SERVICE_UNAVAILABLE` — added to `CLIENT_SAFE_CODES`, which is safe as a class because tRPC never synthesises that code from an unknown throw. |
| Low      | **`secretHint` disclosed too much of an SMTP password.** Its last-four rule is argued for a 100-plus character API key; relay passwords are routinely 12–20, where four characters is a third of the secret.                                                                                                                                                                                                                                                                                                                                                                                           | The SMTP hint is a length only.                                                                                                                                                                                                                                                                        |
| Low      | **`nodemailer` was the one deviation** from the documented `serverExternalPackages` tracing pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Verified rather than assumed (above), and the reasoning is now recorded in `next.config.ts` so it does not read as an oversight.                                                                                                                                                                       |
| Low      | **On-demand sends reported "Queued" even with no SMTP configured**, and non-owners cannot read `admin.smtp` to find out why nothing arrived.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `emailReceipt` checks the config before it audits or enqueues, and returns a plain "Email is not set up on this instance."                                                                                                                                                                             |
| Low      | A comment claimed the project owner has no `project_members` row. `projects.create` does insert one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Comment corrected; the code was already right, since the owner branch is tested first and deliberately does not depend on that row.                                                                                                                                                                    |

One process note: `prettier --write` across the repo also reformatted nine files
untouched by this work (the `docs/reference/` Forkd analyses and three agent
definitions). Reverted — a formatting sweep is not part of this change.

## Post-Phase-8 batch 3 — UI, live updating, credits, setup guide

Thirteen reported items, delivered as three commits so the visible fixes reach
the phone before the heavier work lands. Commits 1 and 2 are described here;
commit 3 (Email Receipts, D-44) is still to come.

### Commit 1 (`38adc42`) — header, filters, admin overflow, key test

- **The receipt icon is gone from the header**, left of the wordmark. Removed
  from the render with a one-line comment naming the restore; nothing deleted.
- **A refresh button** sits left of the user-name dropdown, driven by
  TanStack's `useIsFetching()` rather than local state, so the spin reflects
  work actually in flight. It exists because an installed iOS PWA has no URL
  bar, no reload button and no pull-to-refresh: there was otherwise no way to
  force a refetch short of killing the app.
- **The six filter controls collapsed behind one Filters button** with an
  active-filter count. They occupied ~300px above the receipt list on a phone,
  always. Not a HeroUI `<Badge>` for the count — that component wraps its
  target and requires children.
- **Two genuine flexbox bugs on the admin screen**, not cosmetics: the users
  row's email had `truncate` but no `min-w-0`, so a flex item's default
  `min-width: auto` refused to shrink and `truncate` did nothing; the projects
  row's five unguarded trailing spans wrapped to a second line instead of
  truncating.
- **The Claude key card shows the stored hint as its placeholder** (it was
  write-only and started empty, which read as "not configured") and gained a
  **Test** button — a rate-limited `ownerProcedure` making one minimal live
  call. Only a live call distinguishes a bad key from a bad model id from a
  bad request shape, which is exactly the gap the previous session spent hours
  in.

### Commit 2 — the reported bug, and a second one next to it

**Nothing live-updated because nothing ever asked again.** `ReceiptDetail`
called `receipts.get` with no options at all; with `staleTime: 30_000` and
`refetchOnWindowFocus: false`, the page fetched once and never learned
extraction had finished. Re-extract _appeared_ to fix it, but only because its
`onSuccess` invalidate refetched whatever the PREVIOUS background job had
already written — the re-extract it had just queued was still running. That is
why it "worked" and why the fields were always one job behind.

`lib/extractionPolling.ts` is now the single rule: poll only while a row is
genuinely unfinished, stop the moment it is not. A permanent interval on a
dashboard reached over a Cloudflare Tunnel is a real battery cost on the phone
this app is used from.

The poll also **moved out of `Capture` and into `ProjectDashboard`**, which
fixed two things at once. `Capture` polled `{projectId, limit: 50}` while the
dashboard rendered `{projectId, ...filters, limit: 50}` — with any filter
active those are different cache entries, so the poll was refreshing something
the user was not looking at. And `Capture`'s `pending` list was only emptied by
the _error_ branch's Dismiss button, so after a successful upload its 2.5s poll
ran forever.

Polling then made a latent bug load-bearing: `EditableField` re-synced its
draft from the server during render, so a refetch landing mid-sentence would
replace what the user was typing — at the exact moment they were correcting a
field the model got wrong. `lib/useEditableDraft.ts` holds that contract now,
guarded by `!isFocused`, adopting the value it is sending on blur so the
re-sync cannot clobber the draft before the save returns. Also fixed while in
the file: `isSaving` was passed to all twelve fields, so editing one disabled
every other until the round trip returned.

**Line items are a CSS grid, not a `<Table>`.** The table carried a hard
`min-w-[38rem]` floor inside an `overflow-x-auto`, so every phone scrolled
sideways by construction — a table cannot reflow. The grid is a stacked card
per item below `sm` and aligned columns above it, one DOM node either way. All
four value cells are now inline-editable on the same commit-on-blur contract;
`receiptItems.update` already accepted every one of them, so this was purely a
missing UI.

**Credits parse.** A Costco credit prints as `12.34-`, accounting software
uses `(12.34)`, and only the leading-minus form was accepted — the other two
silently became null. That does not just lose the line: its absence inflates
`sum(items)` and raises a FALSE `arithmetic_mismatch_items` on a receipt that
balanced perfectly. `canonicalizeMoneySign` in `packages/shared/src/money.ts`
is the one place that translation is written, routed through both
`normalizeMoney` (model output) and `moneyString` (hand edits), so a credit
means the same thing whichever way it arrived. `parseMoney` itself stays
strict — it is D-21's boundary and the column's last defence. The helper is
deliberately narrow: `(-12.34)` and `12.34--` are returned untouched to be
rejected, because inventing a sign for a money value is worse than refusing to
read it. The system prompt and the tool schema now say so too. No migration —
there was never a CHECK on any money column.

Accepting `12.34-` also solves a phone problem: `inputMode="decimal"` surfaces
no minus key on the iOS keypad, so trailing-minus is the form that is actually
typeable.

**Export no longer traps you on iOS.** `window.location.assign` navigates the
only document a standalone PWA has, so the "Open in 'Excel'" sheet arrived with
no chrome and no history to go back to; the only way out was to kill the app.
Now a synthetic `target="_blank"` anchor click. Not `window.open` — passing
`noopener` in the features string makes it return null BY SPEC, so any "did it
work?" fallback fires every time and opens the file twice.

**New users pick a theme** on the welcome page — radio inputs inside the
existing form, previewing live via `applyTheme`. Carried as an optional `theme`
on `completeOnboarding` rather than by promoting `setTheme` to
`onboardingProcedure`, which would have added a third member to a two-member
exemption list `routers/auth.ts` argues explicitly for keeping at two.

**`SETUP.md` exists.** `.env.example` had pointed at it since Phase 1. Bare
machine to working instance: prerequisites, every variable that needs a
decision, first boot, the tunnel, the Access application and policy, first
sign-in becoming owner, the API key. Each step says what you should see.
Troubleshooting covers the three failures this deployment actually hit — the
65-character AUD, the `APP_PORT`/tunnel-ingress two-place edit, and an
extraction failing with a visible reason code.

Also corrected: `docs/SCHEMA.md` still documented `users.theme` defaulting to
`'dark'`; D-41 moved it to `'light'` and the migration went with it.

**Known test gap:** the plan called for an `EditableField` test proving a
focused input survives a background refetch. `apps/web` has no DOM test
environment (no jsdom, no testing-library), and adding one for a single
assertion was out of scope for this batch. The pure half — when to poll — is
covered by `extractionPolling.test.ts`; the focus guard is currently only
covered by use.

## Post-Phase-8 fixes — the first real extraction run, capture, theme, orientation

Five reported issues. The first two were real bugs with the same root cause
class: something was broken and the system could not tell you what.

### The API key was fine, and so was the model id — the REQUEST SHAPE was wrong (D-12 amended)

Every upload failed with `AI_REQUEST_REJECTED`, whose label blamed the API key.
The actual error, once it was possible to see it:

```
400 invalid_request_error
"Thinking may not be enabled when tool_choice forces tool use."
```

Haiku 4.5 takes the older `thinking: {type:"enabled", budget_tokens:N}` form,
which cannot be combined with a forced `tool_choice`. Sonnet 5's
`{type:"adaptive"}` can — so pass 2 worked in production while pass 1 never
did, which is precisely why the symptom read as a credentials problem. Haiku
now sends no `thinking` field; forced tool use is the property worth keeping.
`anthropicRequest.test.ts` asserts the absence of the field.

**A wrong turn, recorded because the reasoning was seductive.** The first
diagnosis was that `claude-haiku-4-5` is not a real model id — `GET /v1/models`
returns only `claude-haiku-4-5-20251001`. True observation, false conclusion:
that endpoint lists concrete snapshots, not aliases, and calling the bare alias
directly works fine. D-12's "no date suffix" rule stands; the default was
briefly changed and changed back. **Absence from a listing endpoint is not
evidence of invalidity**, and one direct call would have settled it — the same
call that eventually did.

**The second bug, and the one that was actually stopping extraction.** With
the request shape fixed, every receipt still failed — now with a visible cause,
because the logging above was in place:

```
TypeError: Cannot read properties of undefined (reading 'replace')
```

The tool schema's `required` list was `["confidence", "items"]`, so every other
field was optional and the model simply omitted the ones it could not read.
`RecordReceiptInput` typed them all as `string | null`, which was a lie at
runtime, and `normalizeMoney`'s `raw === null` guard does not catch `undefined`.
It threw **after a successful, billed API call**, which is why three Sonnet
calls could succeed and the receipt still end up `failed`.

This also finally answers **task 6.3 / D-12's Provisional question**: strict
mode DOES accept `["string","null"]` unions, on both Haiku 4.5 and Sonnet 5 —
provided `required` lists every property. Optionality goes in the union, never
in an omission from `required`. Confirmed live; both models now return every
key with absent values as explicit `null`.

Fixed in both places on purpose: the schema (the cause) and the normalizers,
which now treat `undefined` exactly like `null` (the safety net — that file's
entire job is to not trust the model's output shape). `schema.test.ts` asserts
completeness as an invariant rather than by re-listing names.

**The gap that made all of this expensive.** ARCHITECTURE.md §6.4 promises the
UI gets "a status and a job id, not a provider message". Only half was built:
the provider's message was _discarded_ rather than logged server-side. That
400 existed nowhere — not in the logs, not in `ai_usage` (no row is written for
a call that never returned), not in `extraction_error`. Diagnosing it required
a live API probe. Now:

- `pipeline/extract.ts` logs the provider's status, error type and message on
  every failed call;
- `worker.ts` logs the underlying error whenever the reason falls back to the
  generic `AI_EXTRACTION_FAILED` — the codes that say nothing are exactly the
  ones whose cause was being thrown away.

A second receipt failed generically after three _successful_ Sonnet calls. That
one is still unexplained — the failure is after the API call, in mapping or
persistence — and it is now self-diagnosing on the next occurrence rather than
needing another archaeology session.

### Capture: `capture="environment"` is not a preference, it is an exclusion

On iOS, `capture` does not mean "prefer the camera" — it removes Photo Library
and Files from the sheet entirely. A single input carrying it can never reach
an existing photo or a PDF. Split into two: **Take photo** (with `capture`) and
**Choose files** (without, accepting `image/*,application/pdf`). The PDF path
needed no backend work at all — the ingest pipeline has rasterised PDFs since
Phase 5 (D-10), and the upload route sniffs magic bytes rather than trusting
`Content-Type`; only the `accept` attribute was keeping them out of the picker.

### Theme (D-41, D-42)

Beige light theme sampled from the icon (`#faf4eb` page, `#324136` accent),
now the default; `light`'s id is reused so no `users.theme` row is stranded,
and migration `0004` moves the column default. Existing rows are deliberately
not rewritten, so an account already holding `dark` stays dark until it picks
the new theme once.

Both switcher bugs were real:

- **The checkmark never moved** because `theme` is a _server prop_.
  `chooseTheme` swapped the class on `<html>` and wrote to the database, but
  the prop cannot change until the next server render — the page looked right
  and the menu lied about it. Now tracked locally and adjusted during render
  when the prop changes (React's documented pattern; an effect here is a
  cascading render, which `react-hooks/set-state-in-effect` correctly flags).
- **The swatches conveyed nothing** because they showed `background` only, and
  four of the five themes are near-black. `THEMES` entries gained an `accent`
  and the swatch is now split page-colour/accent.

The wordmark is set in a vendored 25 KB latin subset of Dancing Script via
`next/font/local` — not `next/font/google`, which would make every CI and
Docker build depend on reaching fonts.googleapis.com (D-42).

### Orientation (D-43)

Three mechanisms, because no single one covers both platforms: the manifest's
`orientation` (installed Android), `screen.orientation.lock` (Android Chrome
standalone), and a CSS overlay for landscape phones. **On iOS none of the
first two do anything** — `ScreenOrientation.lock` is not implemented — so
what iOS gets is a message asking the user to rotate back. Stated plainly in
D-43 because the alternative is discovering it on a device.

## Post-Phase-8 work — admin-settable API key, and a new app icon

Two unrelated requests, done together and reviewed together.

### D-39 — the Claude API key is settable from the admin screen

`app_config` finally has its first writer. `packages/api/src/secrets.ts` is
AES-256-GCM over `MASTER_KEY`, blob layout `version || iv || tag ||
ciphertext`, fresh IV per write, with the version byte as AAD so it cannot be
downgraded once a version 2 exists. Resolution is `app_config` -> env ->
nothing, **stored wins**, and the worker resolves per job (caching the
`Anthropic` client on the resolved secret) so a saved key takes effect on the
next receipt rather than the next container recreate.

The key is write-only over the API: `admin.aiKey` returns `AiKeyDescription`,
a type with **no field capable of holding a secret**, so a later edit cannot
leak one by accident. The only representation a user sees is the last four
characters.

`ANTHROPIC_API_KEY` is now optional in `packages/config` — a fresh instance
has to boot with no key or the screen that sets one is unreachable. That is a
deliberate narrowing of D-14 for one variable, compensated with three visible
signals. See D-39.

### D-40 — the app icon is a committed source image

`apps/web/assets/icon-source.png` is the source of truth; every raster is
derived from it by `scripts/generate-icons.ts`. Three corrections the supplied
art needed, all in the generator rather than hand-edited into the PNG: iOS
paints black behind transparency (so `apple-icon` is flattened and fills its
square), Android crops maskable icons to a circle (so that one is flattened
and inset 10%), and the tile was neither square nor centred in its canvas
(measured from the alpha channel and re-centred, rather than `sharp`'s
`.trim()`, which preserves the off-centre framing). 256-colour quantisation
took the icon set from 580KB to 263KB and the splash set from 2.53MB to
1.12MB, verified visually identical (mean per-channel error ~5/255) — the
service worker precaches all three icons, so this is not cosmetic.

### Review — what was found and what was done

No high findings. The key-leak axis was traced clean: tRPC return types, the
`errorFormatter`, superjson, zod issue payloads, the transport (mutations
cannot go over GET, so no access-log exposure), the client bundle, PWA
storage, and the worker's new log line. Two mediums, both recovery rather than
disclosure, and six lows. All fixed.

| Sev | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Med | **An undecryptable stored key locked the owner out of the only screen that could fix it.** Rotate `MASTER_KEY` or restore a dump under a different one, and `admin.aiKey` threw; `AiKeyCard` rendered its error branch, where Save and Clear did not exist. The only way back was `psql`. The worker made it worse: a non-`ExtractError` was treated as retryable, so every receipt burned three attempts and reported the generic `AI_EXTRACTION_FAILED`. | `undecryptable` is now a fourth `AiKeySource` rather than an exception; the card renders the same Save/Clear form on the error path (neither mutation reads the row, so both work on ciphertext); the worker gets a distinct non-retryable `ANTHROPIC_KEY_UNDECRYPTABLE`. Deliberately does NOT fall back to the env key.                                           |
| Med | **Receipts that failed for want of a key were stranded permanently** — exactly D-39's headline scenario. `reconcilePendingExtractions` sweeps only `pending`; these are `failed`. The UI said "new uploads use it immediately", quietly excluding the entire backlog.                                                                                                                                                                                      | `setAiKey`/`clearAiKey` reset every live receipt whose `extraction_error` is a key-blocked code back to `pending` and re-enqueue via `ctx.enqueueReceiptExtract`. Best-effort — the capability is optional and a Redis failure must not fail the key change, so the rows are left `pending` for the boot sweep regardless. The success message now names the count. |
| Low | `ANTHROPIC_KEY_NOT_CONFIGURED` had **no user-facing label**, so the third of D-39's "three visible signals" did not actually exist — it fell through to the generic "Extraction failed."                                                                                                                                                                                                                                                                   | Both key-blocked codes added to `receiptLabels.ts`, each naming the fix rather than the symptom.                                                                                                                                                                                                                                                                    |
| Low | The **format version byte was read before authentication and covered by nothing**. Not exploitable at version 1; a free downgrade the moment a version 2 exists.                                                                                                                                                                                                                                                                                           | `setAAD` on both sides, plus a test. Done now because it cannot be retrofitted once rows exist in the wild.                                                                                                                                                                                                                                                         |
| Low | `secretsMatch` was **dead code** whose comment promised constant time while branching on length.                                                                                                                                                                                                                                                                                                                                                           | Deleted.                                                                                                                                                                                                                                                                                                                                                            |
| Low | `readSecretMetadata`'s comment claimed the UI path never holds the plaintext; `describeAiKey` decrypts to compute four characters.                                                                                                                                                                                                                                                                                                                         | Comment corrected to say what is actually true, and why it is still safe.                                                                                                                                                                                                                                                                                           |
| Low | `clearAiKey` **audited a clear that may not have happened** — an append-only log asserting an effect that did not occur.                                                                                                                                                                                                                                                                                                                                   | `deleteSecret` returns whether a row existed; the audit row and the requeue are conditional on it.                                                                                                                                                                                                                                                                  |
| Low | The worker's new key path had **no test**, and the reason code crosses three hops (`ExtractError` -> `UnrecoverableError.message` -> the `failed` handler).                                                                                                                                                                                                                                                                                                | `packages/queue/src/workerKey.test.ts` pins the reason codes, their non-retryability, the per-job pickup, and the one-entry cache.                                                                                                                                                                                                                                  |

One repo-hygiene note from the review acted on: the 1.3MB `ledgerly icon.png`
at the repo root was untracked and un-ignored, byte-identical to the committed
`apps/web/assets/icon-source.png`, and would have been swept in by `git add
-A`. Removed.

**607 unit tests**, up from 594.

## Phase 8 review — what was found and what was done

The `reviewer` pass found 1 high, 3 medium and 4 low. All eight fixed before
commit; the reviewer separately verified eight areas clean (authorization
composition, 404-not-403, header injection, audit metadata, client-facing error
messages, the Luhn boundary, keyset pagination, and column grain).

| Sev      | Finding                                                                                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **High** | **CSV formula injection.** Seven text columns were written unescaped, so a cell beginning `=`/`+`/`-`/`@` was evaluated on open. `merchant` is the sharp one and it is not an insider threat: the merchant line is **read off a photograph by the model**, typed as an unconstrained string, and the Luhn scrub only touches digits — a receipt printed with `=cmd                           | '/c calc'!A0` reached the spreadsheet verbatim. D-38's own research (Excel re-parses quoted fields) is exactly why quoting was not a mitigation.                                                                                                              | Apostrophe-prefix (OWASP) on any free-text cell with a formula lead, plus the header block. `="…"` deliberately not reused — an Excel string literal caps at 255 chars and `item_description`/`receipt_notes` exceed it. Test verified to fail without the fix. XLSX confirmed unaffected (ExcelJS types a string as `String` unconditionally). D-38 amended, including the sentence it had wrong. |
| Med      | The detached writer's `PassThrough` had **no `error` listener**, so `destroy(error)` outside the read window is an unhandled `'error'` — a process kill. Reachable: `writeWorkbook` runs synchronously to its first `await` (writer construction, header block, first commits), so a throw there fires the catch _before_ `startProjectExport` returns, when no consumer exists.             | `stream.on("error", () => {})` at construction. The real failure is already reported by `console.error` and the truncated transfer.                                                                                                                           |
| Med      | **A stalled reader parks the writer indefinitely.** `stream.destroyed` catches a _cancelled_ read, but a client that opens the connection and stops reading without disconnecting produces no `drain`, no `close`, no `error` — the page of rows and the whole ExcelJS workbook stay resident. No rate limit either, unlike upload and `reextract`.                                          | `request.signal` threaded into the paging loop, plus `EXPORT_RATE_LIMIT_PER_MIN` (6/min/user) reusing `rateLimit.ts`. Checked before the project lookup so a limited caller learns nothing about existence — asserted.                                        |
| Med      | **`uploaded_by` emitted a raw email**, contradicting the policy stated 40 lines away in `resolveFilterLabels` ("this string is written into a file that gets emailed to an accountant"). `displayNameOf` falls back to the address and `display_name` is nullable for everyone, so one export could carry a colleague's address in thousands of cells while the header line refused it once. | `email: null` at all call sites, and `users.email` dropped from the export's select entirely so the fallback is unrepresentable. Writing the test found a **third** instance the review missed — `exportedBy`, the exporter's own address in the header line. |
| Low      | `addCents`'s safe-integer guard protected a bound ~90x higher than the one that binds: every total renders through `formatMoney`, which throws above `NUMERIC_12_2_MAX_CENTS`. The guard meant to make the failure loud could never fire first.                                                                                                                                              | Guards the real ceiling with an accurate message; `NUMERIC_12_2_MAX_CENTS` exported from `money.ts`.                                                                                                                                                          |
| Low      | **A truncated CSV is a syntactically valid CSV.** The "a truncated transfer is the correct outcome" reasoning holds for XLSX (a cut zip will not open) but not for CSV, where every complete line before the cut is still a well-formed record and the only signal is whatever the browser says.                                                                                             | A terminal `# end of export: N line items` row, asserted against the actual row count. If it is absent, the file is short.                                                                                                                                    |
| Low      | The `stream.destroyed` early returns skip `workbook.commit()`, abandoning the writer mid-zip. Not a leak in this configuration (in-memory, collectable) but would orphan a temp file per cancelled download in ExcelJS's file-backed mode.                                                                                                                                                   | Comment at the return, naming the condition under which it would become one.                                                                                                                                                                                  |
| Low      | The download is a `GET`, so a third-party page can trigger one cross-site with the Access cookie and cause an audit row plus a full project read. No data reaches the attacker.                                                                                                                                                                                                              | Documented at the handler and in D-37: an `export.generated` row means "requested by this identity", not "intended by this user". The rate limit above bounds the cost.                                                                                       |

Two things worth recording about the review itself. It ran against a tree that
changed underneath it — `fetchItemsForReceipts` gained a scoped `innerJoin` and
`stream.end()` gained a `destroyed` guard mid-review — and it re-read those
files at the end rather than reporting stale findings. And it verified its
claims by running the code (the CSV escape functions, and four `PassThrough`
destroy/cancel scenarios) rather than reasoning about it, which is what turned
the `error`-listener finding from a theory into a reachable process kill.

## Phase 7 review — what was found and what was done

The `reviewer` pass found 1 high, 5 medium and 4 low. Ten fixed, one
disputed with evidence, one already done.

| Sev  | Finding                                                                                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High | `receiptItems.create/update` stored a **full, Luhn-valid card number** via `description`/`sku`. `receipts.update` scrubs its whole patch; the line-item router, added the same phase, scrubbed nothing — and a line item is exactly where someone retypes what a receipt prints. Confirmed live by the reviewer. | `scrubLuhnSequences` over the supplied patch in both, `redactions` in the audit row, two regression tests.                                                                                                                                                              |
| Med  | `members.list`'s rewritten row query did not compose `scopedProjects` — enforcement sat in the preceding probe statement. Not exploitable (the probe throws first) but exactly the shape `receipts.get` and `projects.stats` refuse.                                                                             | Scope composed into the row query too.                                                                                                                                                                                                                                  |
| Med  | `canEditSql` used `"manage"`, which **includes** archived projects, while enforcement gates at `"add"`, which excludes them. The UI offered a full editing surface on an archived project and every save returned `NOT_FOUND` — reading as "this receipt is gone".                                               | Rewritten as `"add"` AND (`"manage"` OR own), mirroring `loadEditableReceipt` exactly. Regression test.                                                                                                                                                                 |
| Med  | `update`/`dismissMissingField`/`undismissMissingField` returned the whole row including `extraction_raw`, which `receipts.get` deliberately strips — shipping the full model payload on every committed field edit.                                                                                              | Explicit projection shared by all three, so a column added later is not silently included. Regression test.                                                                                                                                                             |
| Med  | `categories.delete`'s usage count excluded soft-deleted receipts. `ON DELETE RESTRICT` never fires on a soft delete, so that count is the _only_ guard — a category referenced solely by items on soft-deleted receipts could be deleted, leaving live FKs to a deleted row.                                     | Count includes them. Regression test.                                                                                                                                                                                                                                   |
| Med  | `ReviewQueue` hardcoded `canEdit`, so a read-only member got editable inputs and every save failed. The queue is gated at `"read"` on purpose and the API already returned a correct per-row `canEdit`.                                                                                                          | Threaded through, plus a "view only" marker.                                                                                                                                                                                                                            |
| Low  | `extract.ts`'s `dismissed_fields` read was unlocked; a dismissal committing mid-extraction was silently overwritten.                                                                                                                                                                                             | `.for("update")`.                                                                                                                                                                                                                                                       |
| Low  | `users.list` re-read the caller's role live but then passed `ctx.user` (JWT role) to `scopedProjects`, which short-circuits on `role === "owner"` — a demoted owner kept the directory.                                                                                                                          | Scope composed against a user object carrying the live role.                                                                                                                                                                                                            |
| Low  | `sw.js` claimed everything cached passes `isCacheable`, but `cache.add` does its own fetch and does not check `redirected`.                                                                                                                                                                                      | Precache fetches and gates each entry itself. Two new tests, including a redirected 200 being refused.                                                                                                                                                                  |
| Low  | `docs/STATE.md` not updated.                                                                                                                                                                                                                                                                                     | It was — the review ran against a tree from before that edit.                                                                                                                                                                                                           |
| Low  | The comment explaining why correlated subqueries write out qualified column names was said to be factually wrong: drizzle's source suggests columns always render qualified.                                                                                                                                     | **Disputed, with evidence.** Re-verified on drizzle-orm 0.41.0 by printing `.toSQL()`: a column interpolated into a `sql` template in a select list renders BARE. The transcript is now in the comment so the next reader can re-run it rather than trust either claim. |

## Task 6.13 review — what was found and what was done

The `reviewer` pass found 3 high, 6 medium, and 8 low. All 17 fixed before
commit.

| #       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H-1** | The Luhn scrub Luhn-checked an entire digit RUN (a maximal span of digits/spaces/dashes) as one candidate and skipped it whole once the combined digit count fell outside 13-19 — so a real PAN merely adjacent to any other digits (an expiry date, an auth code, a line wrap) was never checked at all. `scrub.test.ts` had encoded the bypass as intended behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `scrubDigitRun` now slides a window (19 down to 13 digits) across every position within a run, redacting each Luhn-valid span found and leaving the rest of the run intact, rather than testing the whole run as one candidate.                                                                                                                                                  |
| **H-2** | `date_too_old` guaranteed the persist transaction would abort: the value still got written to `transaction_date`, which `receipts_date_sane`'s CHECK rejects — burning up to 3 retries (6 paid API calls) before permanently failing the receipt with zero extracted data, against ARCHITECTURE.md §6.3's "sanity checks never fail the receipt."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `transactionDate` is nulled (and added to `missing_fields`) before the write whenever `date_too_old` trips. `date_in_future` has no such constraint, so that value is kept.                                                                                                                                                                                                      |
| **H-3** | Model output reached the DB unvalidated beyond a bare structural check — an out-of-range `confidence` (`receipts_confidence_range`), a calendar-invalid date/time, an over-magnitude `quantity`, or a malformed item array element could each abort the transaction or throw a raw `TypeError` mid-map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `normalize.ts`'s date/time functions now round-trip through `Date.UTC` (rejecting Feb 30, hour 99, etc.); new `normalizeConfidence` rejects-to-0 (not clamps) anything outside 0-1; `normalizeQuantity` gained a `numeric(12,3)` magnitude bound; a new `mapItems` filters non-object/malformed array elements before mapping. Every one degrades to null/dropped, never throws. |
| **M-1** | The scrub skipped JSON _numbers_ (only strings) and object _keys_ — a model emitting a PAN as a number, or as a key, survived into `extraction_raw` unredacted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `scrubLuhnSequences` now scrubs numbers (converting to a redacted string when a match is found) and object keys, not just string values.                                                                                                                                                                                                                                         |
| **M-2** | `receipt-extract` jobs dedup on `jobId: receiptId`; while a job for a receipt is still waiting/active/delayed, `receipts.reextract`'s re-add silently no-ops, dropping `forcePass2` with no error — and the reconciliation sweep only picks up `pending` receipts, so an already-`ok` receipt was unreachable by it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `reextract` now sets `extraction_status='pending'` inside its transaction before enqueuing — makes the collision harmless to observe and makes the startup sweep a genuine backstop.                                                                                                                                                                                             |
| **M-3** | `receipts.reextract` forces a paid Sonnet 5 pass with no rate limit — unlike uploads, unmetered and directly user-triggerable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | New `checkReextractRateLimit` (10/min/user), reusing `rateLimit.ts`'s Lua script under a generalized `checkRateLimit`. Injected via `Context.rateLimitRedis`, same pattern as `enqueueReceiptExtract`.                                                                                                                                                                           |
| **M-4** | `classifyAnthropicError`'s retryable/non-retryable distinction was computed but never used — a 400 (a rejected strict-mode schema, exactly D-12's open question) or a bad API key was retried 3x with backoff before failing, same as a genuinely transient 429/529.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `ExtractError` gained `retryable`; `worker.ts` throws BullMQ's `UnrecoverableError` for non-retryable reasons, and the `"failed"` handler's finality check now also recognizes `UnrecoverableError` (which can fire on attempt 1 of 3, not just the last).                                                                                                                       |
| **M-5** | A billable call that returned no usable tool call (`AI_NO_TOOL_USE`/`AI_INVALID_RESPONSE`) was billed but never recorded in `ai_usage` — invisible to `admin.aiUsage`'s spend/escalation-rate accounting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `runPass` now records `ai_usage` (with `ok:false`) on both failure branches before throwing, not only on success.                                                                                                                                                                                                                                                                |
| **M-6** | Neither `receipts.reextract` nor `admin.aiUsage` had an authorization test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `receipts.test.ts` gained the full own-only matrix (mirroring `delete`'s 8-case set) plus BAD_REQUEST/audit/status coverage; new `admin.test.ts` covers owner/non-owner/unauthenticated plus the spend-aggregation and escalation-rate-excludes-manual-force shape.                                                                                                              |
| **L**   | Eight more: object-key/number scrub coverage extended to full-width digits via NFKC normalize (L-6); `arithmetic_mismatch_total` didn't account for `tip`, false-flagging every tipped receipt (L-4, ARCHITECTURE.md §6.3 updated); `admin.aiUsage`'s `sinceDays` had no upper bound (L-5); the escalation guard in `reextract` ran after, not before, the imageKey check, a narrow existence oracle (L-1); the `"failed"` handler's DB write had no `deletedAt` predicate, unlike `extract.ts`'s own persistence (L-2); a soft-delete race between the `receipts` update and the `receiptItems` write in the same transaction (L-3); `shutdown.ts` `process.exit()`'d without closing the pg pool/Redis connection, and `docker-compose.yml` had no `stop_grace_period` for an in-flight Sonnet call (L-7); this section itself, and D-12's amendment (L-8, see `DECISIONS.md`). | All fixed.                                                                                                                                                                                                                                                                                                                                                                       |

## Task 5.11 review — what was found and what was done

The `reviewer` pass found 3 high, 8 medium, and 10 low. All three high and
all eight medium findings fixed before commit; 8 of 10 low findings fixed,
2 deliberately deferred (noted at the end).

| #       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H-1** | The size guard ran only after `request.formData()` had already buffered the whole multipart body and every file's bytes — no cap on total request size or file count, so an oversized body or a huge file count spent unbounded memory/CPU before any guard fired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A `Content-Length` ceiling (`MAX_UPLOAD_BYTES * MAX_FILES_PER_BATCH`) rejects before `formData()` ever runs; a hard `MAX_FILES_PER_BATCH` (60) caps file count once parsed; per-file `File.size` is checked before the `arrayBuffer()` copy. Files are now processed sequentially, not via unbounded `Promise.all`.                     |
| **H-2** | `processOneFile` had no error handling around the DB insert, staged write, or enqueue. A thrown error rejected the whole `Promise.all`, losing every other file's results; an enqueue failure after a successful insert left a `pending` row with no job and no record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Every persistence step is wrapped; a failure after the row exists marks it `extraction_status='failed'`, `extraction_error='UPLOAD_PERSISTENCE_FAILED'` rather than leaving it silently `pending` forever. `processOneFile` never throws past its own guard stage.                                                                      |
| **H-3** | `pipeline/ingest.ts` consumed (renamed/deleted) `staging.bin` **before** the final `receipts` DB write. A failure between those two steps left a retry with no staged bytes, throwing `STAGING_FILE_MISSING` on an ingest that partially succeeded — the module's own "retry-safe" doc comment was untrue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Reordered: the DB write (`imageKey`/`thumbKey`/`originalKey`) happens first; `staging.bin` is touched only after that write commits. Added an "already ingested" early-return (checks `receipt.imageKey`) so a retry that reaches the function again after a genuinely successful prior run is a safe no-op.                            |
| **M-1** | `MAX_UPLOAD_MEGAPIXELS` was enforced only by the upload route's header probe. Every actual `sharp` decode used sharp's own ~268MP default regardless of the operator-configured (possibly much lower) cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `maxMegapixels` threaded through `renderDisplayAndThumb`/`renderExtraction`/`regenerateExtractionRender`, passed as `limitInputPixels` on every real decode.                                                                                                                                                                            |
| **M-2** | The image-serving route had no `nosniff`, no `Content-Disposition`, no CSP — attacker-controlled bytes served from the app's own origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Added `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, and `content-disposition` (`inline` for display/thumb, `attachment` for original).                                                                                                                                                     |
| **M-3** | A retained `original.<ext>` keeps GPS EXIF (D-09's "untouched bytes") and was served to every project member with plain `read` access — uploading a receipt to a shared project disclosed the uploader's location to everyone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `kind=original` now additionally requires the caller be the uploader or hold `manage`-level access (full/project owner/instance owner); `display`/`thumb` (EXIF-stripped) stay at the general `read` floor.                                                                                                                             |
| **M-4** | `receipts.delete` locked the `receipts` row `FOR UPDATE` **before** any authorization check — the exact timing-oracle/connection-pinning problem `scope.ts`'s own doc comment describes at length as the reason for check-lock-recheck.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Reordered to an unlocked precheck (learn `projectId` only) → `lockScopedProject` (authorization + project lock) → a fresh, still-unlocked receipt re-read. No lock is ever taken on a row before the caller is proven authorized; the project lock still serializes concurrent `receipts.delete`/`members.*` calls on the same project. |
| **M-5** | The `isInstanceOwner` check read `ctx.user.role`, resolved from the JWT at request entry and unprotected by any lock — a user demoted from instance owner mid-request would still pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Re-reads `users.role` for the caller's own id inside the transaction.                                                                                                                                                                                                                                                                   |
| **M-6** | `worker.on("failed", ...)`'s `attemptsMade < attempts` gate is not a reliable signal for every way a job can end up permanently stuck (e.g. a stalled worker), leaving a receipt `pending` forever with no operator-visible failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Added `reconcilePendingReceipts`, run once at `ingestWorker` startup: any `pending` receipt with no render and no activity in 15 minutes gets a fresh `receipt-ingest` job (`jobId: receiptId`, so a still-genuinely-active job is untouched). Same D-08 principle Phase 6 documents for its own queue, applied here.                   |
| **M-7** | `redisConnectionOptions` silently dropped the logical Redis database number from the URL (`redis://host:port/N`), so `TEST_REDIS_URL`'s db-index isolation from `REDIS_URL` — the whole point of this session's own `scripts/test-redis.sh` — did nothing; a test run could land on a developer's real dev Redis. The connection singleton also ignored the URL on every call after the first.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `redisConnectionOptions` now parses `url.pathname` into ioredis's `db` option. `getRedisConnection` is keyed on the URL it was first created with and throws on a mismatched second call instead of silently reusing the wrong connection.                                                                                              |
| **M-8** | The image route read the whole file into a `Buffer` then copied it again into a `Uint8Array` — ~2x the file size in memory per in-flight request, no `Range` support.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Streams via `Readable.toWeb(receiptFileReadStream(...))` with an explicit `content-length` from `fs.stat`. Verified live: byte-identical to the file on disk, correct `content-length`.                                                                                                                                                 |
| **L**   | Nine more: batch-exceeds-limit now 413 not 429; PDF probe/rasterize temp files written `mode: 0o600`; an AVIF file whose major brand is the generic `mif1` it shares with real HEIC (compatible-brand-only `avif` tag) is now rejected, not misidentified; `IngestError` messages no longer embed filesystem paths (BullMQ persists `Error.message` as `failedReason` in Redis); a `receipts.delete` landing mid-ingest no longer leaves orphaned renders with no DB row (the final ingest write is a conditional `UPDATE ... WHERE deleted_at IS NULL`, cleaning up on a zero-row result); `display`/`thumb` now cache `private, max-age=86400, must-revalidate` (immutable once written) while `original` stays `no-store`; `instrumentation.ts` calls `getEnv()` once, not twice; fixed-window burst behavior documented in `rateLimit.ts`'s own comment. | All fixed.                                                                                                                                                                                                                                                                                                                              |

**Deliberately not fixed — carried forward:**

- **LOW** — `routers/receipts.ts` calls `getEnv().UPLOADS_DIR` directly
  rather than through an injected dependency, unlike every other file this
  phase added. Flagged by the reviewer as inconsistent with this phase's
  own DI pattern. Not changed: `Context`'s shape (`{db, user}`) is shared
  by every existing router and test in the app, and widening it to carry
  `env`/`uploadsDir` has a blast radius disproportionate to a style nit —
  `receipts.test.ts`'s "deletes the image directory only after the DB
  transaction commits" test already demonstrates this file IS testable
  against a temp dir today (via the same "set `process.env.UPLOADS_DIR`
  once before the first `getEnv()` call" trick `env.ts`'s own caching
  requires elsewhere in this codebase).
- **LOW** — Ingest failures reuse `extraction_status='failed'` /
  `extraction_error`, the same columns Phase 6's AI extraction will use for
  its own failures. Once Phase 6 exists, an operator won't be able to tell
  "the render pipeline failed" from "Claude failed" by status alone —
  `extraction_error`'s reason codes ARE already ingest-stage-specific
  (`PDFTOPPM_UNAVAILABLE`, `IMAGE_DECODE_FAILED`, etc.), so the information
  exists, just not as a first-class column. Adding one needs a schema
  migration and touches Phase 6's own status-model design, which doesn't
  exist yet — left for Phase 6 to resolve deliberately rather than
  guessed at here.

## Task 4.8 review — what was found and what was done

The initial `reviewer` pass found 1 high, 7 medium, and 4 low. A follow-up
review of the fixes themselves found one more medium (in the H-1 fix's own
first draft) and confirmed everything else held. All fixed before commit
except the three explicitly deferred items noted at the end.

| #       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H-1** | Composing `scopedProjects(user, level)` into the SAME statement as a `SELECT ... FOR UPDATE` lock is unsafe: Postgres's EvalPlanQual only re-evaluates quals against the _locked relation's_ substituted tuple on wake-up, but the membership subquery is commonly planned as an InitPlan — evaluated once, before the lock wait, never re-run. A member revoked by the very transaction being waited on could still land a write. Proven empirically: reverting the fix let a revoked `full` member's concurrent `projects.archive` call succeed. | `packages/api/src/scope.ts` gained `lockScopedProject(tx, projectId, user, level)`: lock the bare row, then re-check `scopedProjects` as a separate, freshly-planned statement. `projects.ts`'s `update`/`archive`/`unarchive`/`delete` and `members.ts`'s `loadManageContext` now go through it instead of composing scope into their own locking `SELECT`. Two regression tests hold a revoking transaction open on a raw connection and race a real router call against it — one via `members.add`, one via `projects.archive` (chosen because it has no secondary check that could incidentally mask the bug). |
| **M-1** | (Consequence of H-1.) Writes reaching `projects` by raw id (`WHERE eq(projects.id, row.id)`) with no scope of their own.                                                                                                                                                                                                                                                                                                                                                                                                                           | Resolved by the H-1 fix: these writes now happen only after `lockScopedProject`'s fresh check, while still holding the lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **M-2** | `projects.update` with a patch touching only one of `startDate`/`endDate` could violate `projects_date_order` against the row's _existing_ other date, surfacing as a raw 500 — the zod refine only fires when both dates are supplied together.                                                                                                                                                                                                                                                                                                   | `update` now validates the merged (patch ?? existing) date pair before writing, throwing `BAD_REQUEST`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M-3** | `members.add` with a nonexistent `userId` hit a raw FK violation (23503), surfacing as a 500.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | New `isForeignKeyViolation` in `packages/api/src/errors.ts`, caught to throw `NOT_FOUND` — same 404-not-403 reasoning as everywhere else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **M-4** | `docs/SCHEMA.md` says archived projects are read-only; `projects.update` could still edit one.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `update` throws `FORBIDDEN` when `row.status === "archived"`. `members.*` deliberately stay reachable on archived projects — `scope.ts`'s own rationale is that an archived project must remain manageable.                                                                                                                                                                                                                                                                                                                                                                                                        |
| **M-5** | An instance owner renaming a project they don't own produced zero audit rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `update` now writes a `project.updated` row plus `owner_override.performed` when the override applies (and still nothing for an ordinary edit by the project's own owner) — a follow-up review caught that the first version referenced `underlyingAction: "project.updated"` without ever writing that row.                                                                                                                                                                                                                                                                                                       |
| **M-6** | No way to read a project's membership through the API at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | New `members.list`, gated at `scopedProjects(user, "read")` — visibility isn't the privileged action management is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **M-7** | Nothing constrained `users.role='owner'` to one row (carried forward from Phase 3 as L-4), and it is now load-bearing: every `isInstanceOwner` check in `members.ts`/`scope.ts` trusts it unconditionally, unbounded, across every project.                                                                                                                                                                                                                                                                                                        | `packages/db/src/schema/users.ts` gained `users_single_owner_key`, a partial unique index on `role` filtered to `role = 'owner'`. Migration `0001_happy_titanium_man.sql`, applied to the test database. Required fixing one Phase 3 test (`provision.test.ts`'s "never downgrades a role") whose fixture manually created two simultaneous owners — a state the system was never designed to support.                                                                                                                                                                                                             |
| **L-1** | `loadManageContext`'s `callerLevel` silently defaulted to `"read"` on a missing membership row — exactly the shape H-1's race could produce, masked rather than surfaced.                                                                                                                                                                                                                                                                                                                                                                          | Throws `INTERNAL_SERVER_ERROR` instead; `lockScopedProject`'s fresh check makes this branch a true "should never happen."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **L-2** | Re-archiving/re-deleting a project was not idempotent: duplicate audit rows, overwritten timestamps.                                                                                                                                                                                                                                                                                                                                                                                                                                               | `archive`/`unarchive` now return the current row unchanged if already in the target state. `delete`'s idempotency falls out of `lockScopedProject` for free — `scopedProjects`'s liveness predicate always requires `deletedAt IS NULL`.                                                                                                                                                                                                                                                                                                                                                                           |
| **L-4** | `formatMoney` used `Number.isInteger`, which passes for values like `2**60` where the cents math is no longer provably exact.                                                                                                                                                                                                                                                                                                                                                                                                                      | `Number.isSafeInteger`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **L-5** | `addMoney`/`formatMoney` had no `numeric(12,2)` range guard; an overflowing sum only failed at DB-insert time.                                                                                                                                                                                                                                                                                                                                                                                                                                     | New `assertWithinNumeric12_2` helper in `money.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **L-8** | The money property test was unseeded `Math.random()` — a failure it found would be unreproducible.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Table-driven boundary cases added, and the two random sweeps now run against a seeded `mulberry32` PRNG.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| —       | Follow-up review, found in the H-1 fix's own first draft: `lockScopedProject` locked the bare row with NO scope predicate at all before checking authorization, so an unauthorized caller queued on whatever transaction held the lock before being told "no" — a timing oracle (measured: 12ms unauthenticated-against-nonexistent-id vs. 724ms unauthenticated-against-contended-id) and a connection-pool amplification vector.                                                                                                                 | Restructured to check → lock → re-check: an unlocked `scopedProjects` pre-check rejects unauthorized callers before any lock is taken; the post-lock re-check remains the sole source of truth. Regression test asserts an unauthorized call against a contended row returns in well under the lock hold time.                                                                                                                                                                                                                                                                                                     |
| —       | Constraint-agnostic violation classifiers (`isUniqueViolation`/`isForeignKeyViolation`) mapped _every_ violation of a SQLSTATE to the same client error, correct only while each call site has exactly one plausible constraint.                                                                                                                                                                                                                                                                                                                   | Both now take the expected constraint name, matching `packages/auth/src/provision.ts`'s existing convention. Each call site names its constraint (`projects_owner_name_live_key`, `project_members_project_id_user_id_pk`, `project_members_user_id_users_id_fk`, `users_cf_access_sub_key`).                                                                                                                                                                                                                                                                                                                      |

**Deliberately not fixed — carried forward:**

- **L-3** — `trpc.ts`'s `errorFormatter` shapes only the HTTP adapter path; a
  future server action invoking a procedure via `createCallerFactory` (as
  `/welcome` already does) and rendering a caught error's `.message`
  directly would bypass it. Not exercised by anything Phase 4 ships; a
  Phase 7 concern once server actions call `projects`/`members`.
- **L-6** — `money.ts` has no quantity × unit_price primitive.
  `receipt_items.quantity` is `numeric(12,3)`, one more fractional digit
  than `parseMoney`'s regex accepts, and nothing in Phase 4 needs it yet.
  Phase 5's concern when `receipt_items` ships.
- **L-7** — member audit rows use `entityType: "project_member"` with
  `entityId` set to the _project's_ id (not a member-row id, since
  `project_members` has a composite PK). Judged an intentional, defensible
  convention on review, not a bug — noted so a future reader doesn't assume
  `entityId` names a `project_members` row elsewhere in the log.
- Informational: `instance_state.owner_id` and `users.role='owner'` are two
  sources of truth for instance ownership. M-7's index constrains only the
  latter, which is correct — `instance_state.owner_id` is read solely as
  the first-owner election latch (`provision.ts`), never for authorization.
  The `provision.test.ts` fixture fix for M-7 deliberately creates drift
  between the two mid-test; worth knowing so nobody assumes they're meant
  to track.

## Task 3.12 review — what was found and what was done

The `reviewer` pass found 2 high, 7 medium and 11 low. Fixed before commit:

| #       | Finding                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H-1** | No tRPC `errorFormatter`. Internal messages went to the client verbatim — Postgres constraint names, the `instance_state` seed hint, `pg` connection errors carrying the database host. The contract §8 promised this formatter and it was never written. | `errorFormatter` replaces the message for any non-client-facing code, strips `stack`/`path` (deleted, not undefined — superjson serialises undefined as null _and_ a meta entry), logs the real cause server-side, and pins `isDev: false`. Regression-tested.                           |
| **H-2** | `scopedProjects` — the one authorization helper, which all of Phase 4 composes onto — had **no tests at all**, and neither did the procedure ladder.                                                                                                      | `packages/api/src/scope.test.ts` (8) covers every matrix cell across live/archived/soft-deleted projects for 6 actor types, plus an assertion that the `member_permission` enum still orders `read < read_add < full` **in the database**. `trpc.test.ts` (8) covers the ladder and H-1. |
| **M-1** | `.env.example` shipped `DEV_AUTH_BYPASS=true`, and compose's `env_file` overrides the image's `NODE_ENV=production`. Only a Next.js implementation detail was saving it.                                                                                  | Default is now `false`, with the reasoning in the comment.                                                                                                                                                                                                                               |
| **M-2** | `refreshUser`'s Case A recovery issued a second `UPDATE` after a `23505` on the same connection. Inside an enclosing transaction that fails with `25P02`, turning a never-fail path into a 500.                                                           | The collision-prone `UPDATE` is wrapped in its own transaction, so nesting yields a SAVEPOINT.                                                                                                                                                                                           |
| **M-4** | The `user.sub_relinked` audit row omitted the old `sub`, which the relink overwrites in place — so it existed nowhere afterwards. D-27 requires both.                                                                                                     | `previousSub` carried out on `ProvisionOutcome` and audited.                                                                                                                                                                                                                             |
| **M-6** | Turbo ran `@ledgerly/db`, `@ledgerly/auth` and `@ledgerly/api` tests concurrently against one database; `withCleanDatabase()` TRUNCATEs it. Passed only because the suites were small.                                                                    | Root `test` runs `--concurrency=1`; `fileParallelism: false` within `packages/api`; the clean pool sets `lock_timeout=10s` so a future collision fails loudly instead of hanging.                                                                                                        |
| **M-7** | `admin.relinkAccount` was a read-then-write with no lock or transaction; a race produced an unhandled `23505` (returned verbatim, per H-1) and could leave an audit row claiming a relink that did not happen.                                            | One transaction, `FOR UPDATE` on the target row, `23505` mapped to `CONFLICT`.                                                                                                                                                                                                           |
| **L-1** | `verifyAccessJwt`'s `keySet` default parameter evaluated _before_ the `not_configured` guard, and `getAccessKeySet()` throws without a team domain — so branch 3e threw a 500 instead of returning a clean rejection. Reachable outside production.       | `keySet` resolved after the guard.                                                                                                                                                                                                                                                       |
| **L-5** | The race test's pool used pg's implicit `max: 10` — exactly the number of concurrent transactions, so any change would silently serialise them and every assertion would still pass.                                                                      | `max: 20` set explicitly.                                                                                                                                                                                                                                                                |
| **L-7** | Case A's WARN logged only one of the two conflicting `sub`s, so the operator could not identify the other row.                                                                                                                                            | Logs both identities, still no addresses.                                                                                                                                                                                                                                                |
| **L-9** | The matcher excluded `api/v1/health` as a _prefix_, so a future `/api/v1/health/detail` would inherit the exemption.                                                                                                                                      | `api/v1/health(?![\w-])`.                                                                                                                                                                                                                                                                |
| —       | `CF_ACCESS_JWKS_TTL_MS` accepted `1`, which would refetch Cloudflare's certs on nearly every request.                                                                                                                                                     | Floor of 60s.                                                                                                                                                                                                                                                                            |
| **M-3** | Route Handlers are never covered by a layout, so a future `route.ts` under `app/(app)/` would look gated and not be.                                                                                                                                      | `requireAuthRoute(request)` exported under the contract's promised name, documenting the obligation at the call site.                                                                                                                                                                    |

**Deliberately not fixed — carried into Phase 4:**

- **L-4** — nothing constrains `users.role='owner'` to one row, and both
  `scopedProjects`' short-circuit and `ownerProcedure` trust it alone. Wants
  a forward-only migration adding `CREATE UNIQUE INDEX ... WHERE role='owner'`.
  Migration work belongs with Phase 4's schema changes, not bolted on here.
- **M-5** — with `ACCESS_ALLOW_SUB_RELINK` on, a `sub` presenting the
  instance owner's email takes over the owner row. D-27 accepts the model;
  the residual blast radius wants a guard refusing to relink onto
  `role='owner'`, plus a note in `SETUP.md` (Phase 10 task 10.3).
- **L-2** — each rejected identity-conflict request writes an `audit_log`
  row, and the page path redirects into a re-auth loop, so one affected user
  can fill the table at request rate. Wants dedup or a cooldown.
- **L-3** — the null-user page path 307s to sign-out rather than returning
  the §5 byte-identical 403. Probably better UX, but it is contract drift
  and should either be recorded in `DECISIONS.md` or changed.
- **L-6** — `scopedProjects` returns a bare `SQL`, so misuse type-checks
  (it fails at runtime in Postgres, so it is not a silent bypass). Worth a
  narrower return type before a dozen Phase 4 call sites exist.
- **L-10** — contract test 30 (three identity reads, one query) is still
  unwritten, so D-03's economics are unverified.
- **L-11** — the `raced` early return skips the §4.4 refresh, leaving
  `lastSeenAt` one request stale on that path. Cosmetic.
- **L-8** — the elected owner's email is logged at WARN. Per contract §4.3
  and intentional; noted because it is PII in `docker logs`.
- The contract's §6 signature block is stale: `resolveIdentity` lives in
  `apps/web/src/server/identity.ts`, not `packages/auth`, to keep the auth
  package framework-agnostic. The relocation is right; the document is not.

## Completed

**Phase 8 (2026-09-09)**

- **The whole phase is shaped around one failure mode.** The brief §1.7,
  `docs/PHASES.md` 8.3 and the session prompt all name it independently:
  repeating a receipt total on each of that receipt's line-item rows, so
  someone drags a SUM down the column and triples their deduction. So the two
  grains are structurally separate — `LINE_ITEM_COLUMNS` contains no
  `subtotal`/`sales_tax`/`tip`/`total`, and the test asserts their absence **by
  header name**, not by checking that no value looks like a total. A future
  "convenient" total column on sheet 1 would reintroduce the bug and would read
  as an improvement in a diff; that assertion is what stops it.
- **D-37: a streaming Route Handler, not a BullMQ `export` job.** Task 8.1 and
  D-08 specify a queue job; the session prompt specifies a streamed response.
  Resolved with you in favour of the route. The job version needs an `exports`
  table, an artifact directory, retention, a startup reconciliation sweep and a
  polling UI — a phase's worth of surface for a problem this instance does not
  have. The `export` queue stays reserved and unbuilt; two queues exist, not
  three. The code lives in `packages/api/src/export/`, **not**
  `packages/queue/src/pipeline/export.ts` as `PHASES.md` names it: with no job,
  `apps/web` cannot reach `@ledgerly/queue`, and `queue` already depends on
  `api`.
- **One pass over the data, two grains out.** The obvious implementation reads
  the receipts twice — once per sheet — and is wrong: two reads of a live table
  are two snapshots that can disagree, and "the totals reconcile" is the gate.
  Instead each keyset page writes its line items (committed row by row, then
  freed), buffers eleven receipt-grain scalars, and feeds the summary
  accumulator. The unbounded dimension streams; the bounded one is capped by
  `MAX_EXPORT_RECEIPTS` (50,000 → 413). Both sheets and the summary therefore
  derive from ONE read of each row and cannot disagree.
- **Excel-usable by construction, not by cleanup.** Money is a real number
  (`parseMoney` → integer cents → `/100` only at the cell, D-21) with a
  currency `numFmt`; dates are real dates built with `Date.UTC`; `quantity`
  goes through `numeric.ts`, never `money.ts` (whose pattern rejects a third
  decimal); `card_last4` is a text cell so `"0042"` survives; header rows are
  frozen and columns sized.
- **A third sheet, Summary**: spend by category, spend by month, and a
  reconciliation block printing Σ`line_total`, Σ`sales_tax`, Σ`tip`, Σ`total`
  and the difference. Tax and tip are deliberately not apportioned across
  categories — `projects.ts` already argued that for the dashboard and it holds
  harder for a tax record. The block also counts receipts with no line items
  and receipts with no total, so the gap between the two grains is explained on
  the sheet rather than discovered by someone summing a column.
- **Filter parity is asserted against `receipts.list` itself**, not against a
  re-derived expectation, so a change to one that is not made to the other
  fails in CI rather than in an accountant's inbox. A category filter selects
  RECEIPTS (the same correlated `EXISTS`) and then writes every item of each —
  which is both what was on screen and what keeps the sheets reconciling.
- **Audited before a byte leaves.** One `export.generated` row per export with
  the filter set in `metadata` (ids and dates only — no email, no display
  name), plus `owner_override.performed` when the instance owner exports a
  project they do not own. In its own transaction, because the export writes
  nothing and `recordAudit`'s contract is to share the transaction of the write
  it documents. Deliberately not conditional on the stream completing: a stream
  that fails halfway has still disclosed what it already sent.
- **Tests: 567 unit across the workspace, up from 485.** `packages/api` went
  190 → 233, plus 21 new in `apps/web` (the route handler and the shared filter
  parser). The centrepiece
  reads the WRITTEN FILE back through ExcelJS and sums both sheets
  independently in integer cents — deliberately not a test of the accumulator,
  which could be perfect while the writer put the numbers in the wrong cells.
  The authorization matrix mirrors `phase7Permissions.test.ts`, filter parity
  is asserted against `receipts.list` itself, and the cancel-mid-download path
  has its own test because it was a real leak (below).

**Notes worth carrying forward**

- **`exceljs` had to become a direct dependency of `apps/web` too**, not just
  of `packages/api`. This is the identical trap `next.config.ts` documents at
  length for `sharp`/`bullmq`: a package reachable only transitively is traced
  into `.next/standalone/packages/*/node_modules/`, which is not on the
  resolution path the bundled code walks. Verified the same way task 2.8 did —
  `require.resolve("exceljs", { paths: [".next/standalone/apps/web"] })`
  against a real build, not assumed.
- **`exceljs/index.d.ts` line 1 declares a GLOBAL `interface Buffer extends
ArrayBuffer {}`.** It merges with `@types/node`'s `Buffer<ArrayBuffer>` into a
  type nothing can satisfy — not `Buffer.concat`'s result, not
  `Buffer.alloc`'s, not a real `ArrayBuffer` — while `xlsx.load` accepts all
  three at runtime. The one cast this phase adds is confined to a single test
  helper (`fixture.test-helper.ts`'s `loadWorkbook`) with that explanation
  attached, rather than scattered as unexplained `as` across four suites.
- **A streaming worksheet's `views` is getter-only.** Freeze panes can only be
  set through `addWorksheet(name, { views })`, and `worksheet.columns` must
  carry `width` WITHOUT `header` — a `header` makes ExcelJS emit its own header
  row above everything, which would push sheet 1's metadata block below the
  headers it introduces. `row.commit()` on every row is what actually frees it;
  a row added and never committed stays in memory and the streaming property
  becomes a comment.
- **`needsReview=0` must not be a 400.** The client reads this parameter as
  `value === "1"`, so that URL means "off" on the dashboard. The first version
  of the export's zod schema used `z.literal("1")` and rejected it — the two
  halves of one feature disagreeing about what a filter means. Caught by the
  filters test, not by review.
- **An abandoned export used to leak.** `startProjectExport` returns while a
  detached writer keeps paging the database; if the client disconnects, an
  `awaitDrain` waiting on a `drain` that can never arrive never settles, and
  the writer, its queries and its pool connection leak for the life of the
  process. Both writers now resolve on `close`/`error` as well as `drain` and
  bail on `stream.destroyed` between pages. Surfaced as a TRUNCATE deadlock in
  the test suite, which is the same bug wearing a different hat — every suite
  that starts an export now drains it.
- **`image_filename` is derived, not stored.** The schema has `image_key`,
  which holds only the render's extension; every display render is literally
  named `display.webp`, so a bare basename would be the same string on every
  row. The column carries the path relative to `UPLOADS_DIR`
  (`<project>/<receipt>/display.webp`), which is what locates the image inside
  a backup archive.

**Phase 7 (2026-09-08)**

- **Design system.** `@heroui/react` 2.8 + Tailwind 4 — verified compatible
  (`@heroui/theme` 2.4.26's peer is `tailwindcss >=4.0.0`), which keeps
  Forkd's v2 component API while satisfying ARCHITECTURE.md §9. Five themes
  in `apps/web/hero.ts`; Ledgerly's own teal accent on Dark/Light, Forkd's
  Midnight/Amber/Plum ported verbatim (D-31). Confirmed in the built CSS by
  reading the emitted `--heroui-primary` hue per theme, not by eye.
  `tailwind.config.js` does not exist under Tailwind 4 (D-32).
- **Backend.** Phase 7 turned out to be about two-thirds backend: `receipts`
  had only `delete`/`reextract`, and the UI needed list/get/update, line-item
  CRUD, categories, a user directory, project rollups and an admin overview.
  All of it composes `scopedProjects`; `packages/api/src/receiptAccess.ts`
  extracts the receipt gate the two existing mutations each carried inline,
  and both were refactored onto it with the existing suites as the net.
- **Migration 0003** — `receipts.dismissed_fields` (D-36) and
  `receipts_needs_review_idx`. drizzle-kit emitted the partial index's WHERE
  clause correctly this time (D-22 hand-check done). Index use was verified
  with `EXPLAIN` against 20,200 rows, not just asserted: the planner picks an
  ordered `Index Scan using receipts_needs_review_idx` that the LIMIT stops
  early.
- **`packages/shared` grew three modules and gained two by move.**
  `moneyDisplay.ts`, `numeric.ts`, `personName.ts` are new;
  `receiptValidation.ts` and `scrub.ts` moved out of `packages/queue`
  (re-export shims left behind, all 95 queue tests unchanged and green) so
  `packages/api` can reach them — it cannot import `@ledgerly/queue`, which
  already depends on it.
- **Tests: 485 unit (up from 461) + 15 Playwright/WebKit.** Highlights:
  `apps/web/src/sw.test.ts` evaluates the SHIPPED `public/sw.js` in a
  synthetic worker scope and drives it with real Request/Response objects —
  a 302, an opaqueredirect, an opaque response and a 500 are none of them
  cached, `/api/*` is never intercepted, and a navigation is never cached at
  all. `packages/api/src/routers/phase7Permissions.test.ts` is the matrix for
  every new procedure, including the "own only" cell that
  `permissions.test.ts` previously had to test against `scopedProjects`
  directly because receipts did not exist yet.

**Four real bugs the WebKit suite caught, none of them visible to a unit test**

1. **Every input was 14px and iOS zoomed on focus.** The
   `font-size: max(16px, 1em)` rule was inside `@layer base`; HeroUI sizes
   inputs with a `text-small` utility, and Tailwind's `utilities` layer
   outranks `base`. The rule is now unlayered, which beats every cascade
   layer. This is task 7.1's acceptance criterion, and it was silently failing.
2. **The create-project modal was invisible.** framer-motion left HeroUI's
   modal wrapper holding its _exit_ variant as an inline style
   (`opacity: 0` + a translate) and never played the enter transition, so the
   dialog was mounted, focus-trapping the page, and unseeable. Reproduced in
   Chrome and WebKit, on framer-motion 11 and 12, with Strict Mode on and off
   (D-35).
3. **Project cards were not links.** `<Card isPressable as={NextLink}>`
   renders a `div role="button"` and drops the anchor — no open-in-new-tab,
   no middle-click, no link semantics for a screen reader.
4. **The review queue had no heading while loading or on error** — the page
   had no identity at exactly the moments it was slowest.

**Notes worth carrying forward**

- **Drizzle renders `${table.column}` UNQUALIFIED inside a `sql` template.**
  Every project rollup silently returned 0 because
  `where ${receipts.projectId} = ${projects.id}` became
  `where "project_id" = "id"`, binding both sides to the inner table. It fails
  as a plausible number, not as an error — the dashboard read "0 receipts,
  $0.00" for every project. Correlated subqueries now write their column
  references out, qualified. A nested `SQL` object (e.g. `NEEDS_REVIEW_SQL`)
  _is_ rendered qualified, so embedding one is safe.
- **`count(*)` is bigint and the pg driver returns it as a STRING.** Every
  count is cast `::int` in SQL; `sum(numeric)` stays a string all the way to
  the display formatter (D-21).
- **The service worker is not registered in development.** It caches
  `/_next/static/*` cache-first with no revalidation, which is right for
  content-hashed production URLs and wrong for dev chunks whose contents
  change under a stable URL.
- **`apps/web/scripts/generate-icons.ts`** generates every icon and the iOS
  splash set from an inline SVG, plus the `<link>` media queries, so filenames
  and device geometries cannot drift. Run `pnpm --filter @ledgerly/web icons`.
  It lives under `apps/web` rather than the repo-root `scripts/` because Node
  resolves a dependency from the importing file's location and `sharp` is a
  dependency of `apps/web`.
- **Icons use Next's `apple-icon.png` file convention deliberately.** The
  Access matcher already excluded `(?:apple-)?icon[\w-]*\.png`, which matches
  `apple-icon.png` but NOT `apple-touch-icon.png` (it requires "icon"
  immediately after "apple-"). Only `splash/` needed adding.
- **`/welcome` was the heaviest route in the app** at 462 kB first-load,
  because a Server Component importing HeroUI pulls the client runtime into
  its own route bundle. Moving the form into a Client Component and passing
  the Server Action as a prop took it to 184 kB — on the first screen a new
  user ever sees.

**Phase 0 (2026-09-07)**

- Forkd analysed by five scoped `forkd-analyst` subagents. Reference docs
  written to `docs/reference/`: `FORKD_STACK.md`, `FORKD_AUTH.md`,
  `FORKD_INFRA.md`, `FORKD_UI.md`, `FORKD_LESSONS.md` (~2300 lines).
  These are the standing substitute for reading the Forkd repo. Later
  phases read these, never Forkd itself.
- Scrub pass over all five docs: no hostnames, AUD tags, tunnel IDs, keys,
  or local paths. One real hostname was caught and replaced with
  `<APP_HOSTNAME>`.
- Git initialised (`main`), identity set repo-local only, `.gitignore`
  verified against 18 sensitive path probes before the first commit.
- Repo published as a public GitHub repo.

**Phase 1 (2026-09-07)**

- `docs/Ledgerly_Project_Plan.md` — the project brief, committed as the
  standing reference. `DECISIONS.md` is authoritative where they disagree.
- `ARCHITECTURE.md` — stack, module layout, request flow, image pipeline,
  AI extraction flow, configuration, deployment topology, PWA.
- `DECISIONS.md` — 23 decisions (D-01 … D-23), each with context, rationale,
  and consequences. All five of the brief's open decisions resolved, plus the
  three questions Phase 0 left open.
- `docs/SCHEMA.md` — 11 tables, 6 enums, full DDL with constraints and
  indexes, permission matrix, migration strategy. **This is the Phase 1 gate.**
- `docs/PHASES.md` — phases 2–10 as 100 numbered tasks, each with files,
  acceptance criterion, and model assignment.

**Phase 2 (2026-09-08)**

- pnpm workspace, 7 packages (`api`, `auth`, `config`, `db`, `queue`,
  `shared`, `ui`) + `apps/web`, Turbo, `tsconfig.base.json` (ES2022, strict,
  `noUncheckedIndexedAccess`), ESLint 9 flat config, Prettier 3.
- `packages/shared`'s D-07 import boundary (`node:*`, `pg`,
  `drizzle-orm/pg*`, `bullmq`, `ioredis`, `sharp`, `@anthropic-ai/sdk`
  forbidden) enforced by `no-restricted-imports`, proven by an in-memory
  ESLint-API fixture test rather than a permanently-failing tracked file.
- `packages/config`: Zod env schema (`env.ts`) parsed once at import, with
  the D-05/D-14/D-25/D-27 cross-field invariants, plus `edge.ts` — the
  four-key Edge Runtime subset read as literal `process.env.X` expressions
  (Next inlines these at build time; a full-object parse silently yields
  `{}` there). 14 tests, all against `parseEnv` as a pure function.
- `.env.example`: every variable from `ARCHITECTURE.md` §7.2, placeholders
  only, secretlint-clean (verified against the whole tracked tree, not just
  this file).
- `packages/db`: full schema per `docs/SCHEMA.md` (11 tables, 6 enums),
  `pg.Pool` client, `drizzle.config.ts`, idempotent seed
  (`instance_state` + 13 system categories). Migration `0000` generated,
  hand-reviewed, and applied against a real `postgres:17` — drizzle-kit
  0.31 emitted every partial/expression unique index correctly on the
  first pass (`users_email_lower_key`, `projects_owner_name_live_key`,
  `categories_slug_live_key`), so no hand-appended SQL was needed this
  time; still worth re-checking by hand on every future `db:generate`.
- `apps/web`: Next.js 15 App Router skeleton, `output: "standalone"`,
  `serverExternalPackages: ["sharp","bullmq","ioredis"]`, tRPC handler
  mounted on an empty root router (`packages/api/src/{trpc,root}.ts` —
  bare context only, no auth middleware, per CLAUDE.md), deep healthcheck
  (`SELECT 1` + Redis ping, 503 on failure, D-15).
  `src/instrumentation.ts` imports `@ledgerly/config/env` unconditionally
  under a `NEXT_RUNTIME === "nodejs"` guard (Edge Runtime can't load it —
  see the file's own comment for why the guard is a platform necessity,
  not a loophole).
- `docker/Dockerfile` (deps/builder/runner) + `entrypoint.sh` (checks
  `id -u` before `su-exec` — both the root path and a `user: "1000:1000"`
  override tested directly against the built image).
  `docker-compose.yml`: webapp on `127.0.0.1:${APP_PORT}` only, db/redis
  publish no ports, four named volumes. Full `docker compose up` verified
  green: migrate → seed → serve, health 200, 503 within one interval when
  `db` is stopped, 200 again on recovery, seed idempotent across two full
  boot cycles (13 categories, not 26).
- Test harness (`test/setup.ts`, `packages/db/src/testHarness.ts`):
  default per-test transaction rollback, plus `withCleanDatabase()` as the
  documented escape hatch for Phase 3's first-owner race test (genuinely
  separate connections, which the rollback wrapper forecloses).
  `TEST_DATABASE_URL` only, never `DATABASE_URL` (D-18).
- `.github/workflows/ci.yml`: install → lint → typecheck → test (throwaway
  `postgres:17` service) → build, gitleaks over full history as a
  separate job, docker build+push to GHCR on `main`.
- secretlint wired into `lint-staged` via husky `pre-commit`; verified end
  to end — a staged file with a fake GitHub token is blocked and reverted.
- **Left undone / flagged for the next session:** gitleaks could not be
  run locally in this environment (the `zricethezav/gitleaks` container
  hung indefinitely at `docker create`, unrelated to the Dockerfile/compose
  work — those built and ran successfully earlier in the same session).
  It runs for real in the CI job above; Phase 10 task 10.6 is the standing
  full-history sweep regardless. Next.js's standalone `server.js` forces
  `NODE_ENV=production` internally regardless of what's injected at the
  container level, which means `DEV_AUTH_BYPASS` only ever works through
  `pnpm dev`, never through the Docker image — worth a line in `SETUP.md`
  (Phase 10) so this isn't rediscovered the hard way.

**Phase 3 (2026-09-08)**

- Design pass (task 3.1) in `docs/private/PHASE3_AUTH_CONTRACT.md` — function
  signatures, failure modes, the branch table for every branch in
  `ARCHITECTURE.md` §3.1, and a numbered test plan. Six new decisions:
  **D-24 … D-29** in `DECISIONS.md`.
- `packages/auth`: `cloudflareAccess.ts` (`verifyAccessJwt`), `jwks.ts`,
  `provision.ts` (JIT + atomic first-owner election), `identity.ts`,
  `response.ts`, `types.ts`.
- `packages/api`: procedure ladder (`publicProcedure` -> `onboardingProcedure`
  -> `protectedProcedure` -> `ownerProcedure`), `scope.ts`
  (`scopedProjects`), `routers/auth.ts`, `routers/admin.ts`.
- `apps/web`: `proxy.ts` (edge perimeter), `server/identity.ts` (React
  `cache()`), `(app)/layout.tsx` (onboarding gate), `welcome/`,
  `api/auth/sign-out/`.
- **`scopedProjects` landed early** — it is Phase 4 task 4.1 in
  `docs/PHASES.md`, pulled into Phase 3 because the procedure ladder is
  incomplete without the thing it deliberately does not do. **Phase 4 must
  not rebuild it.** Its archived-projects semantics (`add` excludes
  archived; `read`/`manage`/`delete` include it) are a judgment call not
  covered by `docs/SCHEMA.md` — recorded in the contract §9.1.
- **`proxy.ts` does not work on Next.js 15.5 and has been renamed to
  `apps/web/src/middleware.ts`.** `ARCHITECTURE.md` §2, `PHASES.md` task
  3.6 and `FORKD_AUTH.md` all name the file `proxy.ts`; Next 15.5.25 has no
  `PROXY_FILENAME` constant and only recognises `middleware` (`proxy.ts` is
  the Next 16 rename). A `proxy.ts` is silently never registered — the
  build stays green and **the Access perimeter is simply inert**. Caught by
  inspecting `.next/server/middleware-manifest.json`, which was empty; it
  now registers the matcher and the build reports `ƒ Middleware 54.6 kB`.
  Worth remembering as the general lesson: a middleware that is not wired
  up fails open and looks identical to one that is.
- **`packages/config`'s `env` and `packages/db`'s pool are now lazy.** Both
  were evaluated at module load, and `next build` collects page data by
  evaluating every route module — so as soon as a route transitively
  imported either (which Phase 3's tRPC context does), the build failed on
  any machine without production secrets. `getEnv()` / `getDb()` /
  `getPool()` replace the eager consts. **The D-05/D-14 startup guarantee
  is unchanged:** `instrumentation.ts` now _calls_ `getEnv()` during
  `register()`, so a misconfigured process still refuses to boot before the
  server listens — the guard is still "invoked once at startup", it is just
  no longer "invoked as a side effect of any import from anywhere".
- Three deviations from `docs/PHASES.md`, each with a reason:
  - The onboarding gate is **not** in `proxy.ts` (task 3.8's file list). It
    needs `users.onboarded_at`; middleware runs on the Edge Runtime and `pg`
    does not. `ARCHITECTURE.md` §3.1 already placed it in the Node layer.
  - `packages/config/src/edge.ts` carries **five** keys, not four —
    `CF_ACCESS_JWKS_TTL_MS` is needed by `jwks.ts`, which the Edge
    middleware imports.
  - `last_seen_at` is coarsened to 15-minute granularity, so D-03's "one
    user row read per request" does not become one row _write_ per request.
- **Test state: 80 passing, 0 unrun.** (Docker was repaired on 2026-09-08;
  everything previously blocked has now been run.)
  - Passing: `packages/auth` 21 (the whole JWT verification matrix,
    including the two named regression tests — an unconfigured
    `CF_ACCESS_AUD` must return `not_configured` and never `ok`, and an
    empty `sub` must be rejected rather than stored as `""`), plus the
    byte-identical-403 assertion across six distinct rejection reasons;
    `packages/config` 14; `packages/shared` 9.
  - `packages/auth` 52 (21 verification + 31 provisioning),
    `packages/config` 17, `packages/shared` 9, `packages/db` 2.
  - **The first-owner race test passes all 20 repeats.** 10 concurrent
    provisions on separate pool connections, exactly one owner every time,
    `instance_state.owner_id` always matching. The winner varies run to run
    (`user0`, `user3`, `user6`, `user8` …), which is the evidence that the
    transactions genuinely race rather than resolving in a fixed order — a
    race test whose winner never changes has not proven anything.
  - Both D-27 branches covered: flag off rejects cleanly with an audit row
    and no orphan user; flag on reassigns the `sub` onto the existing row
    and preserves the user's onboarding.

**Phase 2 + 3 verification, 2026-09-08 (Docker repaired)**

- `docker compose up` green from a clean build: migrate -> seed -> serve,
  `db` healthy and publishing no ports, `redis` publishing no ports,
  webapp bound to `127.0.0.1:3000` only. Seed idempotent across a restart
  (13 categories, 1 `instance_state` row).
- Privilege drop confirmed: PID 1 `next-server` runs as `node` (UID 1000).
  **Note for Phase 10 task 10.8: its acceptance criterion is wrong.**
  `docker exec whoami` returns `root` no matter what, because `docker exec`
  starts a new process as the image's default user rather than inheriting
  PID 1's. Check the process table or `docker top` instead.
- **Live perimeter probe** against the running container: `/api/v1/health`
  200 (matcher-exempt); `/`, `/welcome`, `/api/trpc/*` all 403
  `Access denied.` with identical `cache-control: no-store` headers. A
  garbage JWT, an `alg:none` forged JWT, a spoofed `x-ledgerly-sub`, and a
  spoofed `Cf-Access-Authenticated-User-Email` all return the same 403 —
  D-24 and D-06 hold against a live request, not just in unit tests.
- **CI docker job fixed.** The first-ever push to `main` exposed a Phase 2
  defect in `.github/workflows/ci.yml`: the job sets `cache-to: type=gha`
  but never ran `docker/setup-buildx-action`, so `build-push-action` used
  the default `docker` driver and failed with "Cache export is not
  supported for the docker driver". The job is gated on
  `github.ref == 'refs/heads/main' && github.event_name == 'push'`, so no
  pull-request or branch run could ever have caught it — worth remembering
  when adding any other `main`-only job.
- **gitleaks finally run** (it was blocked in Phase 2 by the same Docker
  fault): full history clean, `no leaks found`. A working-tree scan reports
  one hit, `.env:16`, which is a gitignored file that is supposed to hold
  secrets; the other 15 are inside `node_modules`. Nothing tracked leaks.
- **Found and fixed a real D-05 defect** — see the amendment on D-05. The
  guard fired but did not stop the process: the container stayed `running`
  with exit code 0 and served 500s forever. Now exits 1 in ~2s, and the
  invariant is additionally enforced in the Edge runtime via `edge.ts`.
- Fixed a Phase 2 defect found on review: `TEST_DATABASE_URL` was set in CI
  but present in neither `.env.example` nor `.env`, and nothing loaded
  `.env` into Vitest, so `pnpm test` was red from a clean checkout.
  `vitest.shared.ts` now lifts that one key from the repo-root `.env` (real
  environment first, so CI still wins).

**Phase 4 (2026-09-08)**

- Two ambiguities in the phase brief resolved before writing code (see
  `docs/private/` if a fuller writeup exists, otherwise this is the record):
  the prose said "only the project owner or instance owner can manage
  members," but the matrix table gives `full` members `Y` on manage-members,
  matching the already-built, already-tested
  `scopedProjects(user, "manage")` floor of `full` — the matrix and existing
  code govern, `scope.ts` is untouched. And the add-receipt/edit-receipt
  matrix columns are tested directly against `scopedProjects(user, "add")`
  (`permissions.test.ts`), not through a receipts router — receipts don't
  ship until Phase 5.
- `packages/shared/src/money.ts` — `parseMoney`/`formatMoney`/`addMoney`,
  the sole `numeric(12,2)` <-> integer-cents boundary (D-21). Pure,
  isomorphic, zero new dependencies. Property-tested against a seeded PRNG
  plus a table-driven boundary-case suite (0, 1 cent, the `numeric(12,2)`
  limits, negatives).
- `packages/api/src/audit.ts` — `recordAudit(tx, entry)`, generalizing the
  inline pattern `admin.ts`'s `relinkAccount` used before this file existed.
  Always takes the caller's transaction; never opens its own.
- `packages/api/src/errors.ts` — `isUniqueViolation`/`isForeignKeyViolation`,
  both requiring the expected constraint name (matching
  `packages/auth/src/provision.ts`'s existing convention), so a future,
  unrelated violation on the same SQLSTATE surfaces honestly instead of
  silently becoming the wrong client error.
- `packages/api/src/routers/projects.ts` — create/get/list/update/archive/
  unarchive/delete. `create` inserts the project and the owner's `full`
  `project_members` row in one transaction. `get`/`update` compose
  `scopedProjects` (or `lockScopedProject`, for writes) directly into their
  own query so a nonexistent id and an unauthorized id are indistinguishable
  (404, never 403). `delete` is gated at `"delete"`, not `"manage"` — a
  `full` member can archive but not delete, per `scope.ts`'s existing,
  untouched semantics. `unarchive` and archived-projects-are-read-only (on
  `update`) were added beyond the phase brief's literal text; both flagged
  as judgment calls, not silent scope creep.
- `packages/api/src/routers/members.ts` — `list`/`add`/`updatePermission`/
  `remove`. Every mutation's entry gate is `scopedProjects(user, "manage")`;
  the escalation guards (self-target, owner-row protection, above-own-level)
  are checks _beyond_ that gate, since `scopedProjects` deliberately doesn't
  reach into which row within an authorized project gets touched. The
  above-own-level guard is currently unreachable through the public API
  (the `manage` gate already requires `full`, which has no ceiling) — kept
  as insurance per `docs/SCHEMA.md`'s escalation-guard paragraph, with a
  comment at the guard site rather than a test pretending to exercise it.
- `packages/db/src/testHarness.ts` gained `mkTestUser` and
  `createTestProjectWithMembers` — shared fixture factories, replacing what
  would have been a third and fourth copy of `scope.test.ts`/`trpc.test.ts`'s
  local `mkUser`. First expansion of this file's role beyond harness
  plumbing.
- Test suite: `projects.test.ts` (26), `members.test.ts` (16),
  `permissions.test.ts` (29, the task 4.4 matrix acceptance artifact —
  every cell of the phase brief's matrix, positive and negative, plus the
  non-member 404-not-403 case, self-escalation, owner-row protection,
  immediate revocation on removal, and `owner_override.performed` audited
  distinctly), `money.test.ts` (46 including `packages/shared`'s existing
  suite). `scope.test.ts`/`trpc.test.ts` untouched and still passing —
  `scope.ts`'s authorization logic was never modified, only extended.
- `scope.ts` gained a branded `ProjectIdScope` return type (L-6, picked up
  as the last step once every Phase 4 call site existed) and
  `lockScopedProject` — see the task 4.8 review section above for why the
  latter exists and what it fixes.
- `packages/db/src/schema/users.ts` / migration `0001_happy_titanium_man.sql`
  — `users_single_owner_key` (M-7, this phase's pickup of Phase 3's
  carried-forward L-4). Applied to the test database, and confirmed live
  on the dev `ledgerly` database too after a full `docker compose build` +
  `up` — the rebuilt image's entrypoint ran `migrate.cjs` cleanly
  (`[migrate] done.`), reseeded idempotently, and `\d users` on the running
  `db` container shows `users_single_owner_key UNIQUE, btree (role) WHERE
role = 'owner'`.
- **Full-stack Docker verification** (not just the throwaway test DB):
  `docker compose build webapp` from current source, then `docker compose
up -d`. All three containers healthy; `webapp`'s `next-server` runs as
  UID 1000 (`node`), not root; `db`/`redis` publish no ports; `webapp`
  bound to `127.0.0.1:3000` only; `/api/v1/health` returns 200.
- **205 tests passing** across all 8 packages (`api` 88, `auth` 52,
  `shared` 46, `config` 17, `db` 2). `pnpm lint` and `pnpm typecheck` clean
  repo-wide.
- Reviewed twice — see "Task 4.8 review" above. The second (follow-up) pass
  independently re-ran the full suite rather than trusting the first pass's
  fix claims, and found one more real bug in the H-1 fix's own first draft.

**Phase 5 (2026-09-08)**

- Design pass resolved two ambiguities before writing code: the storage
  path (the brief sketched `data/receipts/<project_id>/...`; followed the
  already-settled ARCHITECTURE.md §5/D-23 path instead —
  `${UPLOADS_DIR}/<project_id>/<receipt_id>/...`, no `receipts/` segment)
  and the queue architecture (a new `receipt-ingest` queue/worker for the
  render pipeline, sequential to and separate from Phase 6's
  `receipt-extract`, which stays `autorun:false` until Phase 6). Two
  questions put to the user directly: the image route's failure shape for
  "no identity at all" (settled on 403, matching the app-wide D-24
  convention, vs. 404 for every other failure) and real-device test files
  (settled on synthetic-only — D-13, the repo is public, so no real phone
  photo, even gitignored, should ever risk being committed).
- `packages/shared/src/fileSniff.ts` — magic-byte sniffing
  (JPEG/PNG/WebP/TIFF/HEIC-HEIF/PDF), authoritative over client
  `Content-Type`/filename, which are read nowhere in the guard chain.
- `packages/api/src/storage.ts` — UUID-derived storage paths, closing path
  traversal by construction (D-23); every function testable against a
  plain temp dir with no environment coupling.
- `packages/api/src/rateLimit.ts` — Redis Lua atomic fixed-window limiter,
  whole-batch cost, DI'd Redis client (keeps `packages/api` free of a new
  `ioredis` dependency).
- `packages/queue/src/pipeline/render.ts` — header-only probes
  (`probeImageDimensions`, `probePdfPageDimensionsAtDpi` — the latter
  matters for PDF: a crafted `/MediaBox` can declare an arbitrarily large
  page independent of content, so a fixed rasterization DPI does not make
  the guard moot) and the actual pipeline (PDF rasterize via `pdftoppm`,
  EXIF orient-then-strip via sharp's default `.rotate()` with no
  `.withMetadata()`, renders B/C, plus `renderExtraction`/
  `regenerateExtractionRender` ready for Phase 6, unused this phase).
- `packages/queue/src/pipeline/ingest.ts` + `ingestWorker.ts` — the
  `receipt-ingest` worker (`INGEST_CONCURRENCY`, `autorun:true`, distinct
  from Phase 6's `AI_CONCURRENCY`). Retry-safe: the DB write happens
  before the staged upload is consumed, and an already-ingested receipt is
  a fast no-op.
- `apps/web/src/app/api/receipts/upload/` — the upload Route Handler.
  Guards run in order (size → magic-byte sniff → megapixel/PDF-page-size),
  all before any decode, all before any receipt row exists. One bad file
  in a batch is rejected individually; the rest still upload.
- `apps/web/src/app/api/images/[...key]/` — authenticated image serving.
  403 for no identity; 404 for every other failure (nonexistent receipt,
  wrong project, no membership, unprocessed render) — never an existence
  oracle. `original` (the untouched upload, D-09) is additionally
  restricted to the uploader or a `manage`-level member, since it can
  carry GPS EXIF that `display`/`thumb` strip.
- `packages/api/src/routers/receipts.ts` — `receipts.delete` (soft
  delete + physical directory removal, only after the DB transaction
  commits), a small necessary addition beyond the phase brief's literal 5
  numbered items, same judgment-call convention Phase 4 used for
  `unarchive`.
- `scripts/test-redis.sh` + `TEST_REDIS_URL` — new test infrastructure,
  mirroring `scripts/test-db.sh`/`TEST_DATABASE_URL` exactly: a dedicated
  throwaway Redis (compose's `redis` publishes no ports, same reasoning as
  `db`), `TEST_REDIS_URL` and `REDIS_URL` as two logical Redis databases
  on the one container rather than two containers.
- **300 tests passing** across all 8 packages (`api` 115, `auth` 52,
  `shared` 61, `config` 17, `db` 2, `queue` 25, `web` 28). `pnpm lint` and
  `pnpm typecheck` clean repo-wide.
- **Full manual verification against a real running `pnpm dev` server**
  (not just unit tests): a real synthesized JPEG with GPS EXIF and
  orientation 6, uploaded through the real HTTP route, ingested by the
  real worker — `exiftool` on the resulting `display.webp` shows zero EXIF
  fields (GPS included). A real hand-built PDF rasterized end-to-end into
  a real `display.webp`/`thumb.webp`. A mislabeled file (HTML bytes,
  claimed `image/jpeg`, `.jpg` extension) rejected as
  `UNRECOGNIZED_OR_MISLABELED_TYPE`. `/api/images/...` returned
  byte-identical content with the exact `content-length`/`nosniff`/
  `content-disposition` headers the streaming (M-8) and header-hardening
  (M-2) fixes were meant to produce. `receipts.delete` removed the image
  directory and the image route 404'd immediately after.
- Reviewed once — see "Task 5.11 review" above.
- **Not verified this session, deliberately**: a real HEIC photographed on
  a phone (PHASES.md's own gate line for this phase). Per the answered
  question above, real-device files were kept out of this public repo
  entirely rather than used transiently; nothing in the pipeline is
  HEIC-specific enough to be a real risk (sharp+libheif handles it exactly
  like every other format `render.ts` decodes), but the literal gate
  criterion is unconfirmed and belongs in "Blocked / open questions"
  below so it isn't lost.

**Phase 6 (2026-09-08)**

- Migration `0002` — `receipts.validation_flags text[] not null default
'{}'`, additive-only, plain `ADD COLUMN`. Records which sanity check(s)
  tripped `extraction_status='partial'`, independent of `missing_fields`
  (null fields) and `extraction_error` (a single reason string, reserved
  for `'failed'` from either ingest or AI). Two confirmed-with-the-user
  design decisions going in: this new column, and extracting
  `merchant_phone`/`transaction_time`/`tip` in addition to the task
  brief's original field list (all three already existed as nullable
  `receipts` columns).
- `packages/queue/src/pipeline/schema.ts` — the `record_receipt` tool,
  `strict: true`, `additionalProperties: false`, `category` enum built at
  call time from the live `categories` table (D-20), always including
  `uncategorized`. Money fields are `["string","null"]` decimal strings
  (D-21's convention), not numbers.
- `packages/queue/src/pipeline/anthropicRequest.ts` — the per-model
  capability table D-12 calls for: Haiku 4.5 gets
  `thinking:{type:"enabled",budget_tokens}`, no `effort`; Sonnet 5 gets
  `thinking:{type:"adaptive"}` + `effort:"high"`. Forces the tool via
  `tool_choice`.
- `packages/queue/src/pipeline/scrub.ts` — the Luhn scrub (CLAUDE.md hard
  rule). Slides a 19-to-13-digit window across every digit run (not just
  Luhn-checking a whole run as one candidate — see H-1 below), scrubs
  string values, JSON numbers, and object keys, NFKC-normalizes first.
  `card_last4` separately asserted to be exactly 4 digits or null.
- `packages/queue/src/pipeline/normalize.ts` — total, never-throw
  normalizers for every extracted field, each defending the DB column it
  feeds (calendar-valid dates/times via `Date.UTC` round-trip, a
  `numeric(12,3)` magnitude bound on quantity, `normalizeConfidence`
  rejecting-to-0 anything outside 0-1).
- `packages/queue/src/pipeline/validate.ts` — the three sanity checks
  (arithmetic vs. total including tip, arithmetic vs. items, date
  future/too-old), never failing the receipt, money compared in integer
  cents via `packages/shared/money.ts` (D-21).
- `packages/queue/src/pipeline/extract.ts` — `processReceiptExtraction`,
  mirroring `pipeline/ingest.ts`'s Worker-agnostic shape: idempotency
  guard, `regenerateExtractionRender` as the sole source of render-A bytes
  at extraction time (render A is never persisted or queued —
  ARCHITECTURE.md §5), the two-pass escalation ladder
  (null total/date/zero items/low confidence), `ExtractError` with a
  `retryable` flag, one transaction per persist (replace-not-append
  `receipt_items`, idempotent under retry and manual re-extract).
- `packages/queue/src/worker.ts` — replaces the Phase 5 stub with the real
  `receipt-extract` `Worker` (`autorun: true`, concurrency from
  `AI_CONCURRENCY`), a `"failed"` handler recognizing both
  attempts-exhausted and `UnrecoverableError` finality, and a startup
  reconciliation sweep (D-08) filtering `receipts_pending_idx` the
  opposite direction from `ingestWorker.ts`'s own sweep (render exists,
  extraction doesn't).
- `packages/queue/src/shutdown.ts` — new. `SIGTERM`/`SIGINT` handling
  (D-19) did not exist anywhere in the repo before this phase: closes both
  workers, then the shared pg pool and Redis connection, before exiting.
  `docker-compose.yml`'s `webapp` service gained `stop_grace_period: 30s`
  so an in-flight Sonnet call has room to finish.
- `packages/api/src/routers/receipts.ts` — `reextract`: forces the Sonnet
  path directly (skips the ladder), same own-only escalation-guard shape
  as `delete`, rate-limited (`checkReextractRateLimit`, 10/min/user),
  injects the queue enqueue via a new optional `Context.enqueueReceiptExtract`
  capability (packages/api cannot import `@ledgerly/queue` — that package
  already depends on `@ledgerly/api`, so the reverse import would be
  circular; `apps/web`'s tRPC route handler wires the real implementation).
- `packages/api/src/routers/admin.ts` — `aiUsage`: spend (token-derived,
  a hardcoded $/MTok table) and the pass-1→pass-2 escalation rate per
  D-12, `ownerProcedure`-gated. No UI page consumes it yet —
  `apps/web/src/app/admin/` doesn't exist until Phase 7 (task 7.1 is
  HeroUI/Tailwind setup) — this procedure is task 6.10's "admin view"
  itself, matching the phase brief's own file list for that task.
- `apps/web/src/instrumentation.ts` — actually calls `startWorkers` now
  (previously import-only, for the build's file tracer); registers
  graceful shutdown for both workers.
- **384 tests passing** across all 8 packages (`api` 129, `auth` 52,
  `shared` 61, `config` 17, `db` 2, `queue` 95, `web` 28), up from Phase
  5's 300. `pnpm lint` and `pnpm typecheck` clean repo-wide.
- **Full Docker verification**: `docker compose build && up` from current
  source — migration `0002` applies cleanly, health check 200, no
  worker/Anthropic-client startup errors (verified even with a placeholder
  `ANTHROPIC_API_KEY`, since client construction doesn't validate the key
  format — only an actual call would fail).
- Reviewed once — see "Task 6.13 review" above. All 17 findings (3 High, 6
  Medium, 8 Low) fixed before commit.
- **Not verified this session, deliberately blocked**: task 6.3's live
  strict-mode confirmation and task 6.12's 10-receipt accuracy run. Both
  need a real `ANTHROPIC_API_KEY`; this session's `.env` holds only a
  placeholder (`dev-placehol...`). See "Blocked / open questions" below —
  same "named gap, not a silent one" convention Phase 5 used for its own
  real-HEIC gap.

## Next

Phase 10 — Hardening and docs. Opens with a full security review against the
brief §4 checklist, then `SETUP.md`/`DEPLOYMENT.md`/`README.md`, a secret sweep
over full history, device testing, and the `v1.0.0` tag. Phase 9's restore
procedure is written up under SETUP.md's "Backups" section already; 10.4 folds
it into `DEPLOYMENT.md` alongside deploy/upgrade/rollback.

Two things Phase 9 leaves for Phase 10 to pick up, both recorded honestly rather
than quietly:

- **`scripts/restore.sh`'s compose-mode write path has never been executed.**
  Its refusal path has, against the live stack, and its direct-mode equivalent
  is exercised by the drill and by CI — the two differ only in which shell the
  commands run in. Closing it means restoring onto a throwaway stack.
- **The "Back up now" button has not been pressed on a deployed image.** The
  pipeline, worker, queue, API and download route are covered by tests and by
  the drill; the button itself reaches production with the next deploy.

Still outstanding from earlier phases: Phase 6's two live-API tasks (6.3,
6.12), which need a real `ANTHROPIC_API_KEY`; Phase 7's on-device check; and
Phase 8's Excel check below.

### Phase 8's manual gate

Two sample workbooks are in `docs/private/` (gitignored), generated from the
real exporter:

- `kitchen-remodel_2026-09-09.xlsx` — 24 clean receipts. Summary's
  **Difference** row reads **$0.00**: 11,492.79 line totals + 1,005.63 tax =
  12,498.42 receipt totals. This is the gate.
- `kitchen-remodel-messy_2026-09-09.xlsx` — the same exporter over
  deliberately imperfect data: one receipt whose total never extracted, one
  with no line items, one `card_last4` of `"0042"`, one with no date.
  Difference is $854.23 and the Summary says why. The gap is surfaced, not
  hidden — that is the intended behaviour, not a defect.

What to confirm by hand: both open without a repair prompt; dates are dates
and money is money (not text); the header row stays put when you scroll; the
`0042` card keeps its leading zero in BOTH the .xlsx and the .csv; and a pivot
over the Line Items sheet works without any cleanup first.

### Running the browser suite locally

```
./scripts/test-db.sh && ./scripts/test-redis.sh
pnpm --filter @ledgerly/web exec playwright install webkit   # once
pnpm --filter @ledgerly/web e2e
```

It creates and migrates its own `ledgerly_e2e` database (never the unit
suite's — `DEV_AUTH_BYPASS` provisions an instance owner, and
`users_single_owner_key` permits exactly one, so a leftover owner from the
unit run makes every page 500). It runs against `next dev`, because
`DEV_AUTH_BYPASS` is refused under `NODE_ENV=production` (D-05) — so it warms
every route first and uses generous timeouts; dev-mode compilation plus
hydrating ~5,400 modules in WebKit genuinely takes tens of seconds on a cold
route.

### Running the database tests locally

```
./scripts/test-db.sh          # start + migrate (idempotent)
./scripts/test-db.sh --reset  # destroy and recreate from scratch
./scripts/test-db.sh --stop   # remove the container
pnpm test
```

The test database is a **separate throwaway container**, not the compose
stack's `db`. That is deliberate: compose's `db` publishes no ports at all
(ARCHITECTURE.md §8 — nothing but the Cloudflare Tunnel should reach this
instance), so host-run tests cannot connect to it, and publishing a port
just for tests would trade away a real security property. A dedicated
container on loopback also matches what CI does with its `postgres:17`
service, so local and CI runs behave the same.

The script reads only `TEST_DATABASE_URL` and `DATABASE_URL` from `.env`
rather than sourcing it, and refuses to run if the two are equal (D-18);
`packages/db/src/testHarness.ts` asserts the same thing again at test time.
`vitest.shared.ts` lifts `TEST_DATABASE_URL` out of `.env` for the run.

### Running the test Redis locally

```
./scripts/test-redis.sh          # start (idempotent)
./scripts/test-redis.sh --reset  # destroy and recreate from scratch
./scripts/test-redis.sh --stop   # remove the container
```

Same reasoning as the test database, one container instead of two: compose's
`redis` publishes no ports, so `TEST_REDIS_URL` and `REDIS_URL` point at the
same throwaway container on different logical Redis database numbers
(`/0` vs `/1`) rather than two separate containers/ports.

## Resolved questions

Phase 0 resolutions:

- **Postgres vs SQLite** → **PostgreSQL 17** (D-02).
- **Repo public or private** → **public** (D-13). The "scan history before going
  public" checklist item is now a standing full-history gitleaks CI job.

Phase 0's three open questions, all closed in Phase 1:

- **Scope of inheritance from Forkd's receipt pipeline** → **port the
  scaffolding, rewrite the pipeline** (D-19). `queue.ts` / `redis.ts` /
  `worker.ts` follow Forkd's shapes; `pipeline/extract.ts` is new, because
  Forkd extracts restaurant bills for splitting and the data contract differs
  too much to adapt.
- **AI model default** → **two-pass ladder**, `claude-haiku-4-5` then
  `claude-sonnet-5`, both env-tunable (D-12). Forkd's `claude-opus-4-7` pin is
  dropped.
- **Monorepo vs single app** → **monorepo retained** (D-07, user decision). The
  client-bundle bleed that comes with it is mitigated by an ESLint
  `no-restricted-imports` rule in Phase 2 task 2.2, not by vigilance.

Decisions taken by the user this session:

- Repo layout → mirror Forkd's pnpm + Turbo monorepo (D-07)
- Background jobs → BullMQ + Redis (D-08)
- Category taxonomy → seeded global list, user-extensible (D-20)

## Blocked / open questions

- **Phase 8's gate is half-closed.** "The totals reconcile" is verified
  programmatically and in CI — the suite reads the written workbook back
  through ExcelJS and sums both sheets in integer cents, asserting exact
  equality. "Opens clean in Excel" is not, because there is no Excel in this
  environment and LibreOffice is not Excel for the two things that actually go
  wrong (a `.csv` double-click open eating a leading zero, and a date cell
  landing a day early). Two sample workbooks are in `docs/private/` and the
  checklist is under "Next → Phase 8's manual gate".

- **Phase 7's gate is unverified, and only you can close it.** The gate is
  "usable on your phone through the tunnel". There is no iOS device in this
  environment, and Playwright's WebKit is **not** Mobile Safari — it does not
  implement `apple-touch-startup-image`, standalone display mode, the
  add-to-home-screen flow, or iOS's input-zoom behaviour. What _was_ verified
  here: the manifest, `/sw.js` and every icon and splash image are served and
  are outside the Access gate; the service worker's caching rules, driven
  against the real file; no nested forms, no horizontal scroll, modal
  stacking and a >=16px input font at a 390px WebKit viewport.

  **The iOS checklist, in the order worth doing it:**

  1. Open the tunnel hostname in Safari. Share → **Add to Home Screen**. The
     icon should be the teal receipt mark, the name "Ledgerly".
  2. Launch from the home screen. You should get the dark splash screen with
     the mark centred, then the app with **no Safari chrome** — no URL bar, no
     toolbar.
  3. On a notched device: nothing under the notch, and the header's background
     fills behind the status bar rather than leaving a strip.
  4. Tap into any text field. **The viewport must not zoom.** This is the one
     that was silently broken until the WebKit suite caught it, so it is worth
     checking on the real thing.
  5. From the installed app, tap "Add receipts" → the camera should open
     directly (`capture="environment"`). Take a photo of a real receipt.
     Confirm the per-file progress bar, then the "Reading the receipt…" state,
     then the thumbnail appearing.
  6. Multi-select several photos from the camera roll in one action.
  7. Rotate to landscape and back on the dashboard and the receipt detail.
  8. **Let the Access session expire** (or sign out at
     `<team>.cloudflareaccess.com`), then launch from the home screen. You
     should reach the real Access login page and, after signing in, the app.
     If you ever get a _cached_ login page you cannot get past, that is the
     bug the service worker is built to prevent and it should be reported
     loudly — but it should not be reachable: no code path in `sw.js` writes a
     navigation response to the cache.
  9. Turn on airplane mode and launch. You should get the offline card, not a
     browser error page.

- **A real HEIC still has not round-tripped end to end** — Phase 5's own gap,
  unchanged. Step 5 above is the natural moment to close it: photograph a
  receipt on the phone and confirm `display.webp`/`thumb.webp` land and
  `exiftool` shows no EXIF.

- **Phase 5's gate line — "a real HEIC photographed on your phone
  round-trips end to end" — is unverified.** Deliberately: the repo is
  public (D-13), so no real phone photo (which may carry real GPS EXIF)
  should be committed or transiently handled in a way that risks it, even
  gitignored. Automated coverage is synthetic-only (EXIF orientation via
  sharp, a header-only oversized PNG, a hand-built PDF). Nothing in the
  pipeline is HEIC-specific enough to expect a real HEIC to behave
  differently — sharp+libheif decodes it exactly like every other format —
  but this is a real, named gap, not a silent one. Whoever next has a real
  iPhone photo handy: run it through `/api/receipts/upload` once (locally,
  never committed) and confirm `display.webp`/`thumb.webp` land correctly
  and `exiftool` shows no EXIF; then this line can be struck.
- **D-12 is still Provisional — task 6.3 was never run.** The whole Phase 6
  pipeline (`schema.ts`'s `strict: true` tool, the Haiku/Sonnet request
  shapes) is built and unit-tested against a fake Anthropic client, but the
  actual live confirmation that strict mode accepts `["string","null"]`
  union types requires a real `ANTHROPIC_API_KEY` — this session's `.env`
  holds only a placeholder (`dev-placehol...`), so the call was never made.
  `pipeline/extract.ts`'s `isRecordReceiptInputShape` is a light structural
  guard (object + `items` array), not the full Zod parse
  `ARCHITECTURE.md` §6.2 originally sketched — deliberately: rejecting an
  entire otherwise-good extraction over one out-of-schema field would
  contradict CLAUDE.md's "a null field is fine" philosophy, so
  `normalize.ts`'s per-field functions carry the real defense instead (see
  the task 6.13 review's H-3 entry). If a real key confirms strict mode
  holds, this note can be struck and D-12 marked Confirmed; if it doesn't,
  the fallback is non-strict tool use with a proper Zod parse of the whole
  response, appended to D-12 rather than filed anew.
- **Task 6.12 (10-receipt accuracy) never ran, for the same reason** —
  needs both a real `ANTHROPIC_API_KEY` and the user's own real receipt
  photos (per Phase 5's D-13 precedent, synthetic-only in this public
  repo — real receipts stay local, never committed, written to
  `docs/private/PHASE6_ACCURACY.md`). This is also where the escalation
  rate gets its first real reading against D-12's ~45% threshold.
  Whoever next has both: set a real key in `.env`, then run the extraction
  pipeline against 10 real photos and record correct/null/**wrong** per
  field (wrong called out by name — it's worse than null).

## Surprises / notes

- **An unanchored `.gitignore` directory rule matches at every depth.**
  `backups/` was written for the volume at the repo root and quietly excluded
  `apps/web/src/app/api/admin/backups/` in Phase 9 — a whole route plus its
  tests, with a clean `git status` the entire time. Anchor directory rules that
  mean "the one at the root" with a leading slash, and take `CLAUDE.md`'s
  `git status --ignored` rule seriously: it is what caught this.
- **The brief's atomic first-owner query does not work as written.**
  `SELECT ... WHERE role='owner' FOR UPDATE` locks the rows it returns, and on an
  empty users table that is none — so two concurrent first requests both see "no
  owner" and both insert. `docs/SCHEMA.md` adds a single-row `instance_state`
  table to give the transaction something real to lock. Phase 3 task 3.4
  race-tests it.
- **Sonnet 5's introductory pricing expired 2026-08-31**, a week before Phase 1.
  The brief's $2/$10 per MTok is now $3/$15. Haiku 4.5 is unchanged at $1/$5.
  The brief's "go Sonnet-first above ~30% escalation" threshold was computed
  against the expired rate; the corrected crossover is nearer 45% (D-12).
- **Haiku 4.5 and Sonnet 5 need different request shapes.** Haiku rejects
  `output_config.effort` and uses `thinking: {type:"enabled", budget_tokens:N}`;
  Sonnet 5 uses `thinking: {type:"adaptive"}` and supports `effort`. One shape
  sent to both will 400.
- Dropping Better Auth (D-03) removes three of Forkd's most expensive bug
  classes at once and shrinks `MASTER_KEY`'s blast radius from "forge any
  session" to "read stored settings".
- Ledgerly has **no public guest surface**, so the `/g/` self-contained-HTML
  rule and the `/_next/static/*` Access bypass from `FORKD_LESSONS.md` do not
  apply. Nothing anonymous ever needs an asset.
- `poppler-utils` is the only package Ledgerly adds to the runner image that
  Forkd does not have. It drops Chromium, ffmpeg, python3, and yt-dlp, and the
  entire `chrome-headless` service.
