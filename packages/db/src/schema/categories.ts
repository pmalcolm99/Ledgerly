import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users";

// docs/SCHEMA.md §categories. Instance-wide, not per-project (D-20).
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(1000),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("categories_system_undeletable", sql`NOT (${t.isSystem} AND ${t.deletedAt} IS NOT NULL)`),
    // NOTE (D-22): partial index, no expression. Verify the generated SQL
    // in packages/db/migrations/0000_*.sql by hand; hand-append here per
    // docs/SCHEMA.md §Migration strategy if drizzle-kit drops the WHERE.
    uniqueIndex("categories_slug_live_key")
      .on(t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    index("categories_sort_idx")
      .on(t.sortOrder, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);
