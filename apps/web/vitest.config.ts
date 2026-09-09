import { configDefaults, mergeConfig, defineConfig } from "vitest/config";

import shared from "../../vitest.shared";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Mirrors packages/api/vitest.config.ts: withCleanDatabase() TRUNCATEs
      // the shared test database, so files that use it must not run
      // concurrently with each other.
      fileParallelism: false,
      // Playwright owns `e2e/`. Without this, Vitest collects those specs,
      // fails on `@playwright/test`'s fixtures, and turns the whole
      // `pnpm test` run red for a suite it was never going to run.
      exclude: [...configDefaults.exclude, "e2e/**"],
    },
  }),
);
