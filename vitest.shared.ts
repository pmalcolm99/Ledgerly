import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reads one key out of the repo-root `.env`. Deliberately not a general env
 * loader and deliberately not `dotenv`: only TEST_DATABASE_URL is lifted,
 * so nothing else from a developer's `.env` leaks into the test process.
 */
function readFromDotEnv(key: string): string | undefined {
  const file = path.join(repoRoot, ".env");
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === key) return match[2]?.trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? readFromDotEnv("TEST_DATABASE_URL");

/**
 * Config every package's own vitest.config.ts merges in. Vitest resolves
 * config relative to its cwd (the package directory turbo invokes `vitest
 * run` from) rather than walking up to a root config the way tsconfig
 * does, so each package needs its own vitest.config.ts — but they all
 * share this base, which is what keeps the `server-only` fix and the node
 * environment defined in exactly one place.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    passWithNoTests: true,
    env: {
      // TEST_DATABASE_URL (D-18) comes from the real environment first, so
      // CI's throwaway postgres:17 service always wins, and falls back to
      // the repo-root .env for local runs. Without this, `pnpm test` is red
      // from a clean checkout: the db package's rollback harness requires
      // the variable and nothing else loads .env into Vitest. Only this one
      // key is lifted out of the loaded file -- nothing else from .env is
      // pulled into the test environment.
      ...(testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {}),

      // packages/config/src/env.ts does `export const env =
      // parseEnv(process.env)` at module scope (that top-level evaluation
      // *is* the D-05 startup guard — ARCHITECTURE.md §7.1). Any test file
      // that imports anything from env.ts — even to test parseEnv() as a
      // pure function against its own injected records — therefore also
      // triggers that module-scope call against the real process.env. These
      // are non-secret, structurally-valid placeholders that satisfy the
      // schema so that evaluation doesn't throw during test collection;
      // they are never used to open a real connection anywhere in this
      // config.
      NODE_ENV: "test",
      DATABASE_URL: "postgres://ledgerly:ledgerly@localhost:5432/ledgerly_vitest_placeholder",
      MASTER_KEY: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=",
      ANTHROPIC_API_KEY: "vitest-placeholder-key",
    },
  },
  resolve: {
    alias: {
      // See test/stubs/server-only.js for why this alias exists.
      "server-only": path.join(repoRoot, "test/stubs/server-only.js"),
    },
  },
});
