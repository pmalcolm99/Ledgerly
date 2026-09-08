import { sql } from "drizzle-orm";

import type { Database } from "./client";
import { categories, instanceState } from "./schema/index";

/**
 * docs/SCHEMA.md §categories — the 13 seeded system categories. `is_system`
 * rows cannot be deleted or renamed (enforced by
 * `categories_system_undeletable`), so an export's meaning is stable over
 * time.
 */
export const SYSTEM_CATEGORIES = [
  { sortOrder: 10, name: "Building Supplies", slug: "building-supplies" },
  { sortOrder: 20, name: "Tools & Equipment", slug: "tools-equipment" },
  { sortOrder: 30, name: "Household", slug: "household" },
  { sortOrder: 40, name: "Food & Dining", slug: "food-dining" },
  { sortOrder: 50, name: "Transportation & Fuel", slug: "transportation-fuel" },
  { sortOrder: 60, name: "Lodging & Travel", slug: "lodging-travel" },
  { sortOrder: 70, name: "Professional Services", slug: "professional-services" },
  { sortOrder: 80, name: "Utilities", slug: "utilities" },
  { sortOrder: 90, name: "Office Supplies", slug: "office-supplies" },
  { sortOrder: 100, name: "Shipping & Postage", slug: "shipping-postage" },
  { sortOrder: 110, name: "Permits & Fees", slug: "permits-fees" },
  { sortOrder: 120, name: "Labor & Subcontractors", slug: "labor-subcontractors" },
  { sortOrder: 999, name: "Uncategorized", slug: "uncategorized" },
] as const;

/**
 * Idempotent: running this twice leaves exactly one `instance_state` row and
 * 13 system categories, never more. Both writes rely on `ON CONFLICT ...
 * DO NOTHING` rather than a read-then-write check, so the seed is safe to
 * call concurrently with itself.
 *
 * The `instance_state` singleton is inserted first — Phase 3's first-owner
 * election (docs/SCHEMA.md §instance_state) locks that row, and a missing
 * row means there is nothing to lock.
 */
export async function seed(database: Database): Promise<void> {
  await database.insert(instanceState).values({ id: true }).onConflictDoNothing({
    target: instanceState.id,
  });

  for (const category of SYSTEM_CATEGORIES) {
    await database
      .insert(categories)
      .values({
        name: category.name,
        slug: category.slug,
        isSystem: true,
        sortOrder: category.sortOrder,
      })
      .onConflictDoNothing({
        // categories_slug_live_key is a partial unique index
        // (WHERE deleted_at IS NULL) — the conflict target must match it
        // exactly, or Postgres cannot infer which index to check against.
        target: categories.slug,
        where: sql`${categories.deletedAt} IS NULL`,
      });
  }
}
