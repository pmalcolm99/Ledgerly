import "server-only";

import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import * as schema from "./schema/index";

/**
 * packages/db/src/tables.ts — every table in the schema, by SQL name.
 *
 * Derived from the drizzle schema rather than hand-listed, which matters for
 * the one caller that has it: a backup manifest's per-table row counts
 * (Phase 9). A hand-written list would mean a table added in some later phase
 * silently stops being counted, and the manifest would keep reporting a clean
 * match while quietly ignoring it — the failure mode a manifest exists to
 * catch.
 *
 * Deliberately NOT the same thing as `testHarness.ts`'s
 * `TABLES_IN_FK_SAFE_ORDER`, which is ordered for TRUNCATE and cannot be
 * derived. That list is allowed to be manual because a missing entry there
 * fails a test loudly and immediately.
 */
export function appTableNames(): string[] {
  const names: string[] = [];
  // Widened to `unknown[]` on purpose: the schema barrel's value union includes
  // pgEnums and `relations()` declarations, and narrowing a member of that
  // union to `PgTable` is not something a type predicate can express. `is()`
  // does the real check at runtime either way.
  for (const value of Object.values(schema) as unknown[]) {
    if (is(value, PgTable)) names.push(getTableName(value));
  }
  return [...new Set(names)].sort();
}
