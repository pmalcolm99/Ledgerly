# Ledgerly — Database Schema

PostgreSQL 17, Drizzle ORM 0.41, drizzle-kit 0.31. See `DECISIONS.md` D-02.

**This document is the Phase 1 gate.** Nothing in Phase 2 is built until the
tables, the money type, and the permission model here are approved.

## Conventions

Inherited from `docs/reference/FORKD_STACK.md` §"Database Conventions":

- `snake_case` in the database, `camelCase` in the Drizzle schema.
- Primary keys are `uuid` with `default gen_random_uuid()`. There are no Better
  Auth tables and therefore no `text` primary keys (D-03).
- Foreign keys always declare `ON DELETE` explicitly. A column referenced by
  `ON DELETE SET NULL` must be nullable, even when the requirement reads "not
  null".
- `created_at` / `updated_at` on mutable tables; `deleted_at` only where soft
  delete is actually wanted.
- **Money is `numeric(12,2)`, never `double precision`** (D-21). Drizzle reads
  `numeric` as a string; the application converts to integer cents for all
  arithmetic via `packages/shared/money.ts` and formats back once, at the
  display or export boundary.
- **Every extracted receipt field is nullable.** Extraction never fails an
  upload (`CLAUDE.md`).
- Timestamps are `timestamptz`. Dates that represent a calendar day with no time
  — `transaction_date`, `start_date`, `end_date` — are `date`.

## Enums

```sql
CREATE TYPE user_role          AS ENUM ('owner', 'user');
CREATE TYPE project_status     AS ENUM ('active', 'archived');
CREATE TYPE member_permission  AS ENUM ('read', 'read_add', 'full');
CREATE TYPE extraction_status  AS ENUM ('pending', 'ok', 'partial', 'failed');
CREATE TYPE backup_kind        AS ENUM ('manual', 'scheduled');
CREATE TYPE backup_status      AS ENUM ('running', 'complete', 'failed');
```

`member_permission` is ordered `read < read_add < full`, and the ordering is
load-bearing: `scopedProjects(user, level)` compares against it directly.
Postgres enums compare by declaration order, so the order above must never
change. New levels are appended, never inserted.

---

## instance_state

A single row. It exists so the first-owner election has something to lock.

```sql
CREATE TABLE instance_state (
  id           boolean     PRIMARY KEY DEFAULT true,
  owner_id     uuid        REFERENCES users(id) ON DELETE RESTRICT,
  schema_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instance_state_singleton CHECK (id)
);
INSERT INTO instance_state (id) VALUES (true);
```

**Why this table exists.** The brief specifies
`SELECT ... WHERE role='owner' FOR UPDATE` for the atomic first-owner election.
That does not work: `FOR UPDATE` locks the rows a query returns, and on an empty
users table it returns none, so two concurrent first requests both see "no owner"
and both insert. A single guaranteed row gives the transaction something real to
lock.

```sql
BEGIN;
  SELECT owner_id FROM instance_state WHERE id = true FOR UPDATE;  -- serialises
  -- insert the user; if owner_id IS NULL, role := 'owner' and set owner_id
COMMIT;
```

Phase 3 task 3.4 tests this with concurrent transactions and asserts exactly one
owner. `owner_id` is `ON DELETE RESTRICT`: the instance owner cannot be deleted
while they hold the role.

---

## users

```sql
CREATE TABLE users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cf_access_sub  text        NOT NULL,
  email          text        NOT NULL,
  first_name     text,
  last_name      text,
  display_name   text,
  role           user_role   NOT NULL DEFAULT 'user',
  theme          text        NOT NULL DEFAULT 'dark',
  onboarded_at   timestamptz,
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_cf_access_sub_key ON users (cf_access_sub);
CREATE UNIQUE INDEX users_email_lower_key   ON users (lower(email));
```

- `cf_access_sub` is the identity (D-06). Unique, not null, never updated except
  by the owner-only re-link action.
- `email` is a mutable attribute refreshed from the JWT on each visit. The unique
  index is on `lower(email)` — `FORKD_AUTH.md` finding #6 notes Forkd lowercases
  in application code only, so an admin import could insert a case variant that
  never matches. Here the database enforces it.
- `first_name` / `last_name` nullable: the onboarding gate is "either is null".
  `onboarded_at` is set when the welcome form is submitted.
- `display_name` holds the JWT `name` claim, kept in sync. `first_name` and
  `last_name` are user-entered and never overwritten from the IdP — Forkd's
  behaviour, and correct.
- `role` is never downgraded by the auth layer. Promotion and demotion are
  explicit owner actions that write `audit_log`.
- No `deleted_at`. Deleting a user is rare and would orphan receipts; the
  supported path is demotion and removal from project membership.

---

## projects

```sql
CREATE TABLE projects (
  id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name         text           NOT NULL,
  description  text,
  start_date   date,
  end_date     date,
  status       project_status NOT NULL DEFAULT 'active',
  created_at   timestamptz    NOT NULL DEFAULT now(),
  updated_at   timestamptz    NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  deleted_at   timestamptz,
  CONSTRAINT projects_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT projects_date_order     CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE UNIQUE INDEX projects_owner_name_live_key
  ON projects (owner_id, lower(name))
  WHERE deleted_at IS NULL;                                    -- D-22

CREATE INDEX projects_status_idx ON projects (status) WHERE deleted_at IS NULL;
```

- `owner_id` is `ON DELETE RESTRICT`, and is the **delete authority** — only the
  project owner and the instance owner may delete a project (see the matrix
  below). The owner also gets a `project_members` row (below), so
  `scopedProjects` has one code path rather than two.
- The unique index is **partial**. A full-table unique constraint on
  `(owner_id, name)` would make re-creating a deleted project fail
  (`FORKD_LESSONS.md`; D-22). Duplicate-detection queries must also filter
  `deleted_at IS NULL` or they short-circuit on deleted history.
- `status` is `archived` for read-only projects; `deleted_at` is soft delete.
  They are different states and both are needed.

---

## project_members

```sql
CREATE TABLE project_members (
  project_id  uuid              NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid              NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  permission  member_permission NOT NULL,
  granted_by  uuid                       REFERENCES users(id)    ON DELETE SET NULL,
  granted_at  timestamptz       NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX project_members_user_idx ON project_members (user_id);
```

- `granted_by` is nullable because it is `ON DELETE SET NULL` — the convention
  from `FORKD_STACK.md`.
- `project_members_user_idx` is the index `scopedProjects(user)` runs on, and it
  is on the hot path of every project-scoped query.
- **The project owner gets a row here with `permission = 'full'`,** inserted in
  the same transaction as the project. Without it, `scopedProjects` needs a
  separate `OR owner_id = $user` branch that has to be remembered in every
  composition. Project deletion authority still comes from `projects.owner_id`,
  which is why both exist.

### Permission matrix

|                                         | View         | Add receipts | Edit/delete receipts | Manage members | Delete project |
| --------------------------------------- | ------------ | ------------ | -------------------- | -------------- | -------------- |
| `read`                                  | yes          | —            | —                    | —              | —              |
| `read_add`                              | yes          | yes          | own only             | —              | —              |
| `full`                                  | yes          | yes          | yes                  | yes            | —              |
| Project owner (`projects.owner_id`)     | yes          | yes          | yes                  | yes            | yes            |
| Instance owner (`users.role = 'owner'`) | all projects | yes          | yes                  | yes            | yes            |

"own only" means `receipts.uploaded_by = current user`. That is enforced in the
same scoped query, not as a route-level check.

**Enforcement.** `packages/api/src/scope.ts` exports
`scopedProjects(user, level = "read")`, returning a Drizzle subquery of project
ids. The instance owner short-circuits to all non-deleted projects. Every
project-scoped query composes with it. No route handler performs its own check
(`CLAUDE.md` hard rule).

**Escalation guard.** A member with `full` may manage members but must not be
able to grant a permission they do not hold, nor modify the project owner's row,
nor grant themselves `full` if they do not already have it. The member-management
mutation asserts all three; Phase 4's matrix test suite covers each as a case.

---

## categories

```sql
CREATE TABLE categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  slug        text        NOT NULL,
  is_system   boolean     NOT NULL DEFAULT false,
  color       text,
  sort_order  integer     NOT NULL DEFAULT 1000,
  created_by  uuid                 REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT categories_system_undeletable CHECK (NOT (is_system AND deleted_at IS NOT NULL))
);

CREATE UNIQUE INDEX categories_slug_live_key ON categories (slug) WHERE deleted_at IS NULL;  -- D-22
CREATE INDEX categories_sort_idx ON categories (sort_order, name) WHERE deleted_at IS NULL;
```

Instance-wide, not per-project (D-20). Seeded (`is_system = true`, undeletable by
CHECK constraint):

| sort | name                   | slug                    |
| ---- | ---------------------- | ----------------------- |
| 10   | Building Supplies      | `building-supplies`     |
| 20   | Tools & Equipment      | `tools-equipment`       |
| 30   | Household              | `household`             |
| 40   | Food & Dining          | `food-dining`           |
| 50   | Transportation & Fuel  | `transportation-fuel`   |
| 60   | Lodging & Travel       | `lodging-travel`        |
| 70   | Professional Services  | `professional-services` |
| 80   | Utilities              | `utilities`             |
| 90   | Office Supplies        | `office-supplies`       |
| 100  | Shipping & Postage     | `shipping-postage`      |
| 110  | Permits & Fees         | `permits-fees`          |
| 120  | Labor & Subcontractors | `labor-subcontractors`  |
| 999  | Uncategorized          | `uncategorized`         |

The seed is idempotent, keyed on `slug`. `uncategorized` is the fallback the
extraction prompt is told to use and must always exist.

Users may add categories; those are `is_system = false` and also instance-wide.
The extraction tool schema's `category` enum is generated **at call time** from
the live rows, which is why it cannot be a compile-time constant (D-20).

---

## receipts

```sql
CREATE TABLE receipts (
  id                    uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid              NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by           uuid                       REFERENCES users(id)    ON DELETE SET NULL,

  merchant_name         text,
  merchant_address      text,
  merchant_phone        text,

  transaction_date      date,
  transaction_time      time,

  subtotal              numeric(12,2),
  sales_tax             numeric(12,2),
  tip                   numeric(12,2),
  total                 numeric(12,2),
  currency              char(3)           NOT NULL DEFAULT 'USD',

  card_last4            char(4),
  payment_method        text,

  image_key             text,
  thumb_key             text,
  original_key          text,

  extraction_status     extraction_status NOT NULL DEFAULT 'pending',
  extraction_model      text,
  extraction_pass       smallint,
  extraction_confidence numeric(4,3),
  extraction_raw        jsonb,
  extraction_error      text,
  missing_fields        text[]            NOT NULL DEFAULT '{}',
  validation_flags      text[]            NOT NULL DEFAULT '{}',

  user_notes            text,
  reviewed_at           timestamptz,

  created_at            timestamptz       NOT NULL DEFAULT now(),
  updated_at            timestamptz       NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  CONSTRAINT receipts_card_last4_digits CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT receipts_confidence_range  CHECK (extraction_confidence IS NULL
                                               OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  CONSTRAINT receipts_date_sane         CHECK (transaction_date IS NULL
                                               OR transaction_date >= DATE '2000-01-01')
);

CREATE INDEX receipts_project_date_idx
  ON receipts (project_id, transaction_date DESC NULLS LAST)
  WHERE deleted_at IS NULL;                                    -- dashboard list

CREATE INDEX receipts_review_idx
  ON receipts (project_id, extraction_status)
  WHERE deleted_at IS NULL AND extraction_status <> 'ok';      -- review queue

CREATE INDEX receipts_pending_idx
  ON receipts (created_at)
  WHERE deleted_at IS NULL AND extraction_status = 'pending';  -- reconciliation sweep, D-08
```

- **Every extracted field is nullable.** `project_id`, `currency`,
  `extraction_status`, `missing_fields`, and `validation_flags` are the only
  non-null columns, and none of them come from the model.
- `card_last4` is `char(4)` with a digits-only CHECK. The database therefore
  cannot store a full card number in this column even if every application guard
  failed — the Luhn scrub (`ARCHITECTURE.md` §6.3) is the first line, this is the
  second. `CLAUDE.md` hard rule.
- `extraction_raw` is the post-scrub model response, stored verbatim for
  debugging bad reads. It is scrubbed **before** it is written, never after.
- `missing_fields` defaults to `'{}'` not null, so consumers never branch on
  null-vs-empty. It names fields the user might want to fill in (came back
  null), never a reason a check failed.
- `validation_flags` (Phase 6) names which sanity check(s) tripped when
  `extraction_status = 'partial'` — `arithmetic_mismatch_total`,
  `arithmetic_mismatch_items`, `date_in_future`, `date_too_old`. Separate
  from `missing_fields` because more than one check can trip on the same
  receipt, and separate from `extraction_error` (a single string, reserved
  for `extraction_status = 'failed'` from either the ingest or the AI
  stage) because a `partial` receipt is not a failure.
- `receipts_date_sane` enforces the brief's "before 2000" check at the database
  level. The future-date and arithmetic checks are _not_ constraints — they set
  `extraction_status = 'partial'` and append to `validation_flags`, because the
  receipt must still be saved (`ARCHITECTURE.md` §6.3).
- `transaction_time` is `time` without zone: it is what the receipt printed, not
  an instant.
- `extraction_pass` records 1 or 2, feeding the escalation-rate metric (D-12).
- No unique constraints, so D-22 has nothing to bite here — but any future
  duplicate detection (same merchant, date, and total) must filter
  `deleted_at IS NULL`.

**Currency note (D-17).** Project totals sum `total` without regard to
`currency`, which is correct while every row shares one. If a second currency
ever appears, the dashboard aggregation must be revisited before its numbers
mean anything.

---

## receipt_items

```sql
CREATE TABLE receipt_items (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id          uuid          NOT NULL REFERENCES receipts(id)   ON DELETE CASCADE,
  category_id         uuid                   REFERENCES categories(id) ON DELETE RESTRICT,
  line_no             integer       NOT NULL,
  description         text          NOT NULL,
  sku                 text,
  quantity            numeric(12,3),
  unit_price          numeric(12,2),
  line_total          numeric(12,2),
  ai_assigned_category boolean      NOT NULL DEFAULT false,
  confidence          numeric(4,3),
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT receipt_items_line_no_positive CHECK (line_no > 0),
  CONSTRAINT receipt_items_confidence_range CHECK (confidence IS NULL
                                                   OR (confidence >= 0 AND confidence <= 1))
);

CREATE UNIQUE INDEX receipt_items_line_key ON receipt_items (receipt_id, line_no);
CREATE INDEX receipt_items_receipt_idx  ON receipt_items (receipt_id);
CREATE INDEX receipt_items_category_idx ON receipt_items (category_id);   -- filtering + export
```

- `description` is the one not-null field, matching the tool schema's `required`
  list — an item the model cannot describe is not an item.
- `quantity` is `numeric(12,3)` because receipts sell things by weight.
- `category_id` is nullable and `ON DELETE RESTRICT`: deleting a user category
  requires reassigning its items first, enforced by the database rather than by
  application convention (D-20). Nullable so a receipt can be saved before
  categorisation.
- `ai_assigned_category` distinguishes a model guess from a user's choice, so the
  UI can show which are worth reviewing and a bulk re-categorise can skip the
  ones a human already set.
- `receipt_items` has **no** `deleted_at`. Items are owned entirely by their
  receipt and cascade with it; soft-deleting them independently would put the
  line-item sum out of step with the receipt subtotal.

---

## ai_usage

```sql
CREATE TABLE ai_usage (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id     uuid                 REFERENCES receipts(id) ON DELETE SET NULL,
  model          text        NOT NULL,
  pass           smallint    NOT NULL,
  input_tokens   integer     NOT NULL,
  output_tokens  integer     NOT NULL,
  latency_ms     integer,
  escalated      boolean     NOT NULL DEFAULT false,
  ok             boolean     NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_usage_created_idx ON ai_usage (created_at DESC);
CREATE INDEX ai_usage_model_idx   ON ai_usage (model, created_at DESC);
```

Feeds the admin spend view and the pass-1 -> pass-2 escalation rate that D-12's
~45% threshold is measured against. `receipt_id` is `ON DELETE SET NULL` so cost
history survives receipt deletion. It stores **no prompt or response content** —
`extraction_raw` on the receipt is the only place model output is retained.

---

## audit_log

```sql
CREATE TABLE audit_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid                 REFERENCES users(id) ON DELETE SET NULL,
  action         text        NOT NULL,
  entity_type    text        NOT NULL,
  entity_id      uuid,
  metadata       jsonb       NOT NULL DEFAULT '{}',
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx  ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_actor_idx   ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
```

Append-only; nothing updates or deletes a row. The security checklist requires
entries for **permission grants, deletions, and exports**; also logged: first-
owner election, role changes, the account re-link action (D-06), and category
deletion.

`action` and `entity_type` are `text` rather than enums so a new audited action
never needs a migration — the cost of a typo is a mislabelled log line, not a
failed write. `metadata` never contains receipt images, model output, or secrets.

---

## backups

```sql
CREATE TABLE backups (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            backup_kind   NOT NULL,
  status          backup_status NOT NULL DEFAULT 'running',
  path            text,
  size_bytes      bigint,
  db_included     boolean       NOT NULL DEFAULT true,
  images_included boolean       NOT NULL DEFAULT false,
  manifest        jsonb,
  error           text,
  started_at      timestamptz   NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  deleted_at      timestamptz
);

CREATE INDEX backups_started_idx ON backups (started_at DESC) WHERE deleted_at IS NULL;
```

`manifest` mirrors the `manifest.json` inside the archive: schema version,
per-table row counts, image count, SHA-256 checksums. Retention prunes by
`started_at` past `BACKUP_RETENTION_DAYS`, soft-deleting the row and unlinking
the file — Forkd's pattern (`docs/reference/FORKD_INFRA.md`).

---

## app_config

```sql
CREATE TABLE app_config (
  key             text        PRIMARY KEY,
  value_encrypted bytea       NOT NULL,
  updated_by      uuid                 REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

Encrypted key-value store for runtime settings, following Forkd's
`getDecryptedConfigValue()` / `setEncryptedConfigValue()` pattern with
`MASTER_KEY` (32 bytes, base64, validated at startup by D-14). Keys in v1:
`backup.schedule_cron`, `backup.include_images`, `ai.escalate_below`.

**`MASTER_KEY` is irreplaceable.** A backup archive contains the encrypted values
and nothing that can decrypt them. `SETUP.md` says so in bold, and the key is
backed up out-of-band. Under D-03 its blast radius is limited to this table — it
no longer signs session tokens, so a leak does not forge identities.

---

## Entity relationships

```
instance_state --owner_id--> users

users ----owner_id-------> projects ---+
      ----uploaded_by-----> receipts   |
      ----(project_members)------------+

projects --1:N--> project_members --N:1-- users
projects --1:N--> receipts --1:N--> receipt_items --N:1--> categories

receipts --1:N--> ai_usage
users    --1:N--> audit_log
```

Drizzle `relations()` all live in `packages/db/src/schema/relations.ts`, not
beside their tables — Forkd's convention, and it is what avoids circular imports
between schema files.

### Schema file layout

```
packages/db/src/schema/
  enums.ts       all CREATE TYPE enums
  instance.ts    instance_state, app_config
  users.ts       users
  projects.ts    projects, project_members
  categories.ts  categories
  receipts.ts    receipts, receipt_items
  ops.ts         audit_log, backups, ai_usage
  relations.ts   every relations() declaration
  index.ts       re-exports
```

---

## Migration strategy

Forward-only. **A migration is never edited after it has been applied**
(`CLAUDE.md`).

```
pnpm db:generate   # drizzle-kit generate — diff schema against migration history
                   # review the emitted SQL by hand, then commit it
pnpm db:migrate    # drizzle-kit migrate — apply pending migrations
pnpm db:seed       # idempotent; seeds instance_state + the 13 system categories
```

- Migrations live in `packages/db/migrations/`, named by drizzle-kit
  (`0000_<adjective>_<noun>.sql`), with `meta/_journal.json` as drizzle's
  bookkeeping.
- **The generated SQL is reviewed before commit, every time.** drizzle-kit emits
  destructive statements for column renames and type changes; it cannot tell a
  rename from a drop-and-add. This is the step that prevents a silent data loss.
- **`db:push` is never used against anything but a scratch database.** It applies
  schema without recording history, which desynchronises the migration journal
  from reality. It is not in the deploy path and not in CI.
- Migrations run in the container entrypoint before the server starts, via the
  esbuild-bundled `migrate.cjs`. A non-zero exit fails the container — fail-fast,
  Forkd's pattern (`docs/reference/FORKD_INFRA.md`).
- Partial unique indexes (D-22) are not expressible in Drizzle's schema DSL in
  all cases. Where drizzle-kit cannot emit one, the index is added by a
  hand-written statement appended to the generated migration file, and the schema
  file carries a comment pointing at it so the two never drift.
- A migration that requires a data backfill is split: one migration adds the
  nullable column, a second backfills, a third adds the constraint. Never one
  migration that adds a `NOT NULL` column to a populated table.

### Testing (D-18)

CI runs a throwaway `postgres:17` service; locally, `TEST_DATABASE_URL` points at
a separate `ledgerly_test` database. Every migration is applied from empty in CI
on each run, so a migration that only works against the developer's existing
database fails before merge. Each database-touching test runs inside a
transaction rolled back in teardown. Tests never run against `DATABASE_URL` —
Forkd does this and `docs/STATE.md` records it as a defect not to inherit.
