import { defineConfig } from "vitest/config";

// Convenience aggregator for running the whole suite from the repo root
// (`pnpm exec vitest run` at root). CI and `turbo run test` instead invoke
// each package's own "test" script, which uses that package's own
// vitest.config.ts (see vitest.shared.ts for what they all share) —
// Vitest resolves config relative to its cwd, not by walking up to this
// file, so this aggregator and the per-package configs are independent.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
