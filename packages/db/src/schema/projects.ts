import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { memberPermissionEnum, projectStatusEnum } from "./enums";
import { users } from "./users";

// docs/SCHEMA.md §projects.
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    status: projectStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("projects_name_not_blank", sql`length(btrim(${t.name})) > 0`),
    check(
      "projects_date_order",
      sql`${t.endDate} IS NULL OR ${t.startDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
    // NOTE (D-22): partial + expression index. drizzle-kit 0.31 does not
    // reliably emit the `WHERE deleted_at IS NULL` clause combined with
    // `lower(name)`. Verify the generated SQL in
    // packages/db/migrations/0000_*.sql by hand; if missing, the statement
    // is hand-appended there per docs/SCHEMA.md §Migration strategy.
    uniqueIndex("projects_owner_name_live_key")
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
    // NOTE (D-22): partial (non-expression) index — drizzle-kit is more
    // likely to emit this one correctly, but it is still checked by hand
    // alongside the two above.
    index("projects_status_idx")
      .on(t.status)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

// docs/SCHEMA.md §project_members.
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: memberPermissionEnum("permission").notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user_idx").on(t.userId),
  ],
);
