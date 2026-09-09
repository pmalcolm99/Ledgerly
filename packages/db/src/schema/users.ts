import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { userRoleEnum } from "./enums";

// docs/SCHEMA.md §users.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cfAccessSub: text("cf_access_sub").notNull(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    displayName: text("display_name"),
    role: userRoleEnum("role").notNull().default("user"),
    // D-41: the beige light theme is the default. Only affects NEW rows —
    // an account already holding an explicit theme keeps it, which is why
    // migration 0004 changes the column default and deliberately does not
    // rewrite existing values.
    theme: text("theme").notNull().default("light"),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_cf_access_sub_key").on(t.cfAccessSub),
    // NOTE (D-22): drizzle-kit 0.31 does not reliably emit this expression
    // index (`lower(email)`) from the schema DSL. Verify the generated SQL
    // in packages/db/migrations/0000_*.sql by hand; if it is missing, the
    // statement is hand-appended there per docs/SCHEMA.md §Migration
    // strategy, and this comment is the pointer back to it.
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    // Phase 4 task 4.8 review finding M-7 (docs/STATE.md's carried-forward
    // L-4): nothing previously constrained `role='owner'` to a single row,
    // yet both `scopedProjects`'s instance-owner short-circuit and every
    // `ownerProcedure`/`isInstanceOwner` check trust `role='owner'` alone
    // to mean "unbounded authority over every project." A partial unique
    // index on `role` filtered to the owner value permits any number of
    // `role='user'` rows (unconstrained) but at most one `role='owner'`
    // row — enforced by the database, not by an insert-time check that
    // could be bypassed by any future write path.
    uniqueIndex("users_single_owner_key")
      .on(t.role)
      .where(sql`${t.role} = 'owner'`),
  ],
);
