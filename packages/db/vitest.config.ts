import { mergeConfig, defineConfig } from "vitest/config";

import shared from "../../vitest.shared";

// DB-touching tests get the default per-test transaction-rollback wrapper
// (task 2.12, D-18) via this setupFile. Tests that need the
// withCleanDatabase() escape hatch instead import it directly — see
// packages/db/src/testHarness.ts.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      setupFiles: ["../../test/setup.ts"],
      // These tests hit a real Postgres connection per test (open +
      // rollback); running them one at a time keeps the isolation model
      // simple to reason about, and the suite is small enough that it
      // doesn't cost meaningful wall-clock time.
      fileParallelism: false,
    },
  }),
);
