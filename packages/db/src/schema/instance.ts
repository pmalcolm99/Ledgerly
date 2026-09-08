import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { bytea } from "./customTypes";
import { users } from "./users";

// docs/SCHEMA.md §instance_state.
//
// A single row. It exists so the first-owner election (Phase 3 task 3.4)
// has something real to lock: `SELECT ... FOR UPDATE` against an empty
// `users` table locks nothing, so two concurrent first requests would both
// see "no owner" and both insert without this table.
export const instanceState = pgTable(
  "instance_state",
  {
    id: boolean("id").primaryKey().default(true),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
    schemaNote: text("schema_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_state_singleton", sql`${t.id} = true`)],
);

// docs/SCHEMA.md §app_config.
//
// Encrypted key-value store for runtime settings, keyed with MASTER_KEY
// (packages/config validates it is 32 bytes at startup — D-14). Never
// decryptable from a backup archive alone; MASTER_KEY is backed up
// out-of-band.
export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  valueEncrypted: bytea("value_encrypted").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
