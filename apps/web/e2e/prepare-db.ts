import { execFileSync } from "node:child_process";
import path from "node:path";

import { Client } from "pg";

/**
 * apps/web/e2e/prepare-db.ts — a dedicated, freshly-created database for the
 * browser suite.
 *
 * Run as its own step BEFORE `playwright test` (see the `e2e` script in
 * package.json), not as Playwright's `globalSetup`: Playwright starts
 * `webServer` first and only then runs globalSetup, so a globalSetup that
 * creates the database races a dev server already trying to connect to it —
 * which fails as a 3D000 "database does not exist" during startup, before any
 * test runs.
 *
 * WHY ITS OWN DATABASE, rather than reusing `ledgerly_test`:
 *
 * `DEV_AUTH_BYPASS` provisions a fixed identity that becomes the FIRST
 * INSTANCE OWNER, and `users_single_owner_key` permits exactly one
 * `role='owner'` row. The unit suite creates owners of its own, so any
 * leftover row makes the dev user's first-owner election fail with a unique
 * violation and every page 500s. A separate database removes the coupling
 * entirely, and means the unit suite and this one can run at the same time.
 *
 * Dropped and recreated each run rather than truncated: the first-owner
 * election is genuinely once-per-instance state, so "clean" has to mean
 * clean, not "clean apart from instance_state".
 */

function e2eDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = "/ledgerly_e2e";
  return url.toString();
}

async function main(): Promise<void> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error(
      "TEST_DATABASE_URL is required for the e2e suite. Run ./scripts/test-db.sh first.",
    );
  }
  // D-18: never the real database. Asserted here as well as in the harness,
  // because this setup DROPS the database it is pointed at.
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === base) {
    throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL (D-18).");
  }

  const target = e2eDatabaseUrl(base);

  // The database name is hardcoded above, so this can only ever drop a
  // database literally called `ledgerly_e2e` — but if DATABASE_URL is itself
  // pointed at one, refuse rather than destroy it. Cheap, and the failure it
  // prevents is unrecoverable.
  if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === "/ledgerly_e2e") {
    throw new Error(
      "DATABASE_URL points at ledgerly_e2e, which this script drops. Point it elsewhere (D-18).",
    );
  }

  process.env.E2E_DATABASE_URL = target;

  const admin = new Client({ connectionString: new URL("/postgres", base).toString() });
  await admin.connect();
  try {
    // Terminate stragglers first: a dev server left running from a previous
    // run holds connections, and DROP DATABASE fails while any exist.
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'ledgerly_e2e'",
    );
    await admin.query("DROP DATABASE IF EXISTS ledgerly_e2e");
    await admin.query("CREATE DATABASE ledgerly_e2e");
  } finally {
    await admin.end();
  }

  const dbPackage = path.join(import.meta.dirname, "..", "..", "..", "packages", "db");
  const env = { ...process.env, DATABASE_URL: target };
  execFileSync("pnpm", ["exec", "tsx", "src/migrate.ts"], {
    cwd: dbPackage,
    env,
    stdio: "inherit",
  });
  execFileSync("pnpm", ["exec", "tsx", "src/seed.cli.ts"], {
    cwd: dbPackage,
    env,
    stdio: "inherit",
  });
}

await main();
console.log("[e2e] ledgerly_e2e ready.");
