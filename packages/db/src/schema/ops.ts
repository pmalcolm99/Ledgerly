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

import { backupKindEnum, backupStatusEnum } from "./enums";
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
    index("audit_log_created_idx").on(t.createdAt.desc()),
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
