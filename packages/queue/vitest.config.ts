import { mergeConfig, defineConfig } from "vitest/config";

import shared from "../../vitest.shared";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Mirrors packages/api/vitest.config.ts: withCleanDatabase() TRUNCATEs
      // the shared test database, so files that use it must not run
      // concurrently with each other.
      fileParallelism: false,
    },
  }),
);
