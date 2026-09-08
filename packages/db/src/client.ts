import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema/index";

/**
 * The application's connection pool.
 *
 * **Lazy on purpose.** Constructing the pool at module load makes merely
 * *importing* this module require `DATABASE_URL`, and `next build` collects
 * page data by evaluating every route module — so an eager pool turns a
 * build into something that only works when a database URL happens to be in
 * the environment. Nothing here connects until something actually asks for
 * a query, while the missing-variable error stays loud and immediate at the
 * point of first use.
 *
 * `DATABASE_URL` is read from `process.env` rather than through
 * `@ledgerly/config`, because this module is also imported by
 * `src/migrate.ts` and `src/seed.cli.ts`, which run as standalone scripts
 * (Docker entrypoint, `pnpm db:seed`) under plain Node/tsx rather than the
 * Next.js webpack build. `@ledgerly/config`'s `env.ts` still validates
 * `DATABASE_URL` for the running server process.
 *
 * Deliberately no `import "server-only"` here: that marker package throws
 * unconditionally outside a webpack build with the `react-server` export
 * condition set (i.e. under plain Node, tsx, or Vitest), which would break
 * exactly the CLI scripts and tests that need this module directly. The
 * guard lives one layer up, at `./index.ts` — the `@ledgerly/db` package
 * entrypoint that `apps/web` and `packages/api` actually import.
 */

export type Database = NodePgDatabase<typeof schema>;

let cachedPool: Pool | undefined;
let cachedDb: Database | undefined;

export function getPool(): Pool {
  if (!cachedPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required to create the database pool.");
    }
    cachedPool = new Pool({ connectionString });
  }
  return cachedPool;
}

export function getDb(): Database {
  if (!cachedDb) cachedDb = drizzle(getPool(), { schema });
  return cachedDb;
}
