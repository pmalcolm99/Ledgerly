import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach } from "vitest";

import { seed } from "./seed";
import * as schema from "./schema/index";

/**
 * The test database harness (task 2.12, D-18). Two modes:
 *
 *   - `registerRollbackHooks()` — the default. Every test gets its own
 *     transaction, opened in `beforeEach` and always rolled back in
 *     `afterEach`, so a test that inserts leaves the database unchanged
 *     after the run.
 *   - `withCleanDatabase()` — the escape hatch. Phase 3's first-owner race
 *     test needs genuinely concurrent transactions on *separate* pool
 *     connections, which a single enclosing transaction forecloses (and
 *     would make that test pass for the wrong reason — one transaction
 *     cannot race with itself). Call this from `beforeEach` instead of
 *     using `registerRollbackHooks()`; it truncates every table and
 *     re-seeds `instance_state` + the system categories.
 *
 * Tests must never touch `DATABASE_URL` — only `TEST_DATABASE_URL`. Both
 * modes refuse to run if that variable is unset, or is equal to
 * `DATABASE_URL`.
 */

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is required to run database tests (D-18). Set it in " +
        ".env locally, or rely on CI's throwaway postgres:17 service. Tests " +
        "must never run against DATABASE_URL.",
    );
  }
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL must not equal DATABASE_URL (D-18) — tests must " +
        "never run against the application database.",
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// Default mode: per-test transaction, rolled back in afterEach
// ---------------------------------------------------------------------------

let txClient: Client | undefined;
let txDb: NodePgDatabase<typeof schema> | undefined;

/** Only valid to call from inside a test — `beforeEach` (registered by
 * `registerRollbackHooks`) has already opened the transaction by then. */
export function db(): NodePgDatabase<typeof schema> {
  if (!txDb) {
    throw new Error(
      "testHarness.db() called outside a test, or registerRollbackHooks() " +
        "was never wired up as this package's vitest setupFile.",
    );
  }
  return txDb;
}

/** Call once from a package's setupFile (see packages/db/vitest.config.ts
 * for the reference wiring). */
export function registerRollbackHooks(): void {
  beforeEach(async () => {
    txClient = new Client({ connectionString: testDatabaseUrl() });
    await txClient.connect();
    await txClient.query("BEGIN");
    txDb = drizzle(txClient, { schema });
  });

  afterEach(async () => {
    try {
      await txClient?.query("ROLLBACK");
    } finally {
      await txClient?.end();
      txClient = undefined;
      txDb = undefined;
    }
  });
}

// ---------------------------------------------------------------------------
// Escape hatch: genuinely separate connections (Phase 3 task 3.4)
// ---------------------------------------------------------------------------

let sharedCleanPool: Pool | undefined;

/** Lazily constructed so packages that never call `withCleanDatabase()`
 * never pay the cost of connecting, and never fail import merely because
 * TEST_DATABASE_URL happens to be unset in their run. */
export function getCleanPool(): Pool {
  if (!sharedCleanPool) {
    sharedCleanPool = new Pool({
      connectionString: testDatabaseUrl(),
      // Explicit, not the library default. The first-owner race test opens
      // ten concurrent transactions; at pg's default max of 10 there is
      // zero headroom, and any future change would silently serialise them
      // — every assertion would still pass while testing nothing.
      max: 20,
      // `withCleanDatabase()` needs ACCESS EXCLUSIVE to TRUNCATE. If
      // another suite is mid-transaction against the same database, that
      // wait is unbounded by default and `pnpm test` hangs rather than
      // fails. Ten seconds turns it into a legible error.
      options: "-c lock_timeout=10000",
    });
  }
  return sharedCleanPool;
}

const TABLES_IN_FK_SAFE_ORDER = [
  "audit_log",
  "ai_usage",
  "backups",
  "receipt_items",
  "receipts",
  "project_members",
  "projects",
  "categories",
  "app_config",
  "users",
  "instance_state",
];

/** Truncates every table and re-seeds `instance_state` + the system
 * categories. Call from `beforeEach` in tests that need real concurrent,
 * separately-connected transactions instead of the rollback wrapper. */
export async function withCleanDatabase(): Promise<void> {
  const pool = getCleanPool();
  await pool.query(`TRUNCATE TABLE ${TABLES_IN_FK_SAFE_ORDER.join(", ")} RESTART IDENTITY CASCADE`);
  await seed(drizzle(pool, { schema }));
}
