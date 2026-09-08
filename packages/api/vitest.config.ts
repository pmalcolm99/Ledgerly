import { mergeConfig, defineConfig } from "vitest/config";

import shared from "../../vitest.shared";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Both suites in this package call withCleanDatabase(), which
      // TRUNCATEs the shared test database. Running the files in parallel
      // makes them clobber each other's fixtures mid-test.
      fileParallelism: false,
    },
  }),
);
