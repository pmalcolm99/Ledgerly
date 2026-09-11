import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { backupKindEnum, backupStatusEnum, eventCategoryEnum, eventLevelEnum } from "./enums";
import { receipts } from "./receipts";
import { users } from "./users";

// docs/SCHEMA.md §audit_log. Append-only; nothing updates or deletes a row.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId, t.createdAt.desc()),
    index("audit_log_actor_idx").on(t.actorUserId, t.createdAt.desc()),
    // `(created_at DESC, id DESC)`, not `created_at` alone. The Logs tab's
    // keyset cursor is the pair — `created_at` is not unique, because it
    // defaults to `now()`, the TRANSACTION timestamp, so one mutation writing
    // two audit rows gives them the same value to the microsecond. A
    // single-column index cannot satisfy that ORDER BY, so the planner sorts
    // the whole table on every page.
    index("audit_log_created_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * docs/SCHEMA.md §app_events. What the SYSTEM did, as distinct from
 * `audit_log`'s what a PERSON did (D-46).
 *
 * The two are separate tables because they are different kinds of write, not
 * because of taste. `recordAudit` must run inside the transaction of the write
 * it documents; an event must NOT — an "extraction failed" row written inside
 * the transaction that then rolls back vanishes along with the failure it
 * exists to record. The volumes differ by orders of magnitude besides.
 *
 * `event` is a stable code (`email.skipped`), never a prose sentence. The
 * sentence is rendered in the UI from the code plus `metadata`, the same way
 * `receiptLabels.ts` already renders extraction errors — prose in a column
 * cannot be filtered, drifts from the metadata beside it, and cannot be
 * reworded without a migration.
 */
export const appEvents = pgTable(
  "app_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    level: eventLevelEnum("level").notNull(),
    category: eventCategoryEnum("category").notNull(),
    event: text("event").notNull(),
    // Free text rather than a FK: an event may name a row that has since been
    // deleted, and losing the event with the row would defeat the point.
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    // The Logs tab's default ordering, and what its keyset pagination seeks on.
    // Both carry `id` as the trailing key, for the reason given on
    // `audit_log_created_idx` above: the Logs tab orders and seeks by the
    // `(at, id)` pair, and an index that stops at `at` leaves the planner
    // sorting the table to break the ties.
    index("app_events_at_idx").on(t.at.desc(), t.id.desc()),
    index("app_events_category_idx").on(t.category, t.at.desc(), t.id.desc()),
  ],
);

// docs/SCHEMA.md §backups.
export const backups = pgTable(
  "backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: backupKindEnum("kind").notNull(),
    status: backupStatusEnum("status").notNull().default("running"),
    path: text("path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    dbIncluded: boolean("db_included").notNull().default(true),
    imagesIncluded: boolean("images_included").notNull().default(false),
    manifest: jsonb("manifest"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("backups_started_idx")
      .on(t.startedAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

// docs/SCHEMA.md §ai_usage. No prompt or response content is stored here —
// `extraction_raw` on the receipt is the only place model output is
// retained, and only after the Luhn scrub (ARCHITECTURE.md §6.3).
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id").references(() => receipts.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    pass: smallint("pass").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    latencyMs: integer("latency_ms"),
    escalated: boolean("escalated").notNull().default(false),
    ok: boolean("ok").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_created_idx").on(t.createdAt.desc()),
    index("ai_usage_model_idx").on(t.model, t.createdAt.desc()),
  ],
);
