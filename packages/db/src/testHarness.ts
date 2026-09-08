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

// ---------------------------------------------------------------------------
// Fixture factories (Phase 4) — shared by scope.test.ts-style suites that
// use withCleanDatabase(). Before this, packages/api/src/scope.test.ts and
// trpc.test.ts each carried their own local `mkUser`; Phase 4 adds a third
// and fourth consumer (projects/members/permissions tests), which is the
// point past which that duplication is worth breaking. Kept here rather
// than in packages/api because fixture rows are a database concern, not an
// API-specific one — reusable by any package's tests.
// ---------------------------------------------------------------------------

export type TestUserRow = typeof schema.users.$inferSelect;
export type TestProjectRow = typeof schema.projects.$inferSelect;

/** Creates a `users` row with the same shape `scope.test.ts`'s local
 * `mkUser` factory already used. Returns the full row rather than the
 * narrower `AuthUser` type from `@ledgerly/auth/types` — importing that
 * type here would make `packages/db` depend on `packages/auth`, which
 * itself depends on `packages/db` (ARCHITECTURE.md §2.1's one-way
 * dependency direction). `typeof schema.users.$inferSelect` is the exact
 * same shape `AuthUser` is defined as, so callers can use this
 * interchangeably. */
export async function mkTestUser(
  database: NodePgDatabase<typeof schema>,
  key: string,
  role: "owner" | "user" = "user",
): Promise<TestUserRow> {
  const [row] = await database
    .insert(schema.users)
    .values({
      cfAccessSub: `sub-${key}`,
      email: `${key}@example.com`,
      firstName: "T",
      lastName: "User",
      onboardedAt: new Date(),
      role,
    })
    .returning();
  if (!row) throw new Error(`mkTestUser: failed to create user ${key}`);
  return row;
}

/** Creates a project owned by a fresh `ownerKey` user (with the owner's
 * `project_members` row at `full`, matching what `projects.create`
 * guarantees in production), plus one fresh user per entry in `members`,
 * each added to `project_members` at the given permission. Returns every
 * created user keyed by the `key` passed in, so callers can look up
 * `users.readMember`, `users.fullMember`, etc. */
export async function createTestProjectWithMembers(
  database: NodePgDatabase<typeof schema>,
  opts: {
    ownerKey: string;
    members: Array<{ key: string; permission: "read" | "read_add" | "full" }>;
    name?: string;
    status?: "active" | "archived";
  },
): Promise<{ project: TestProjectRow; users: Record<string, TestUserRow> }> {
  const users: Record<string, TestUserRow> = {};
  const owner = await mkTestUser(database, opts.ownerKey);
  users[opts.ownerKey] = owner;

  const [project] = await database
    .insert(schema.projects)
    .values({
      ownerId: owner.id,
      name: opts.name ?? `project-${opts.ownerKey}-${Math.random().toString(36).slice(2, 8)}`,
      status: opts.status ?? "active",
      archivedAt: opts.status === "archived" ? new Date() : null,
    })
    .returning();
  if (!project) throw new Error("createTestProjectWithMembers: failed to create project");

  await database.insert(schema.projectMembers).values({
    projectId: project.id,
    userId: owner.id,
    permission: "full",
    grantedBy: owner.id,
  });

  for (const member of opts.members) {
    const user = await mkTestUser(database, member.key);
    users[member.key] = user;
    await database.insert(schema.projectMembers).values({
      projectId: project.id,
      userId: user.id,
      permission: member.permission,
      grantedBy: owner.id,
    });
  }

  return { project, users };
}
