import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Runs pending migrations then exits. This is what the Docker entrypoint
 * runs before starting the server (ARCHITECTURE.md §8.1): a non-zero exit
 * fails the container before it ever serves a request — fail fast, per
 * `docs/reference/FORKD_INFRA.md`.
 *
 * The migrations folder is resolved from `MIGRATIONS_DIR` rather than from
 * `import.meta.url`, because this file is esbuild-bundled to a CommonJS
 * `migrate.cjs` for the container image (ARCHITECTURE.md §8.1), where
 * `import.meta.url`-relative paths would depend on bundler output layout.
 * The Dockerfile sets `MIGRATIONS_DIR=/app/migrations` explicitly; locally,
 * it falls back to `./migrations` relative to this package's directory
 * (`pnpm db:migrate` runs with cwd = packages/db).
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  console.log(`[migrate] applying pending migrations from ${migrationsFolder} ...`);
  await migrate(db, { migrationsFolder });
  console.log("[migrate] done.");

  await pool.end();
}

main().catch((error: unknown) => {
  console.error("[migrate] failed:", error);
  process.exit(1);
});
