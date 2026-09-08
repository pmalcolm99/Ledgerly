import { getDb, getPool } from "./client";
import { seed } from "./seed";

/**
 * The CLI entrypoint for `pnpm db:seed` and the Docker entrypoint's
 * `node seed.cjs` (ARCHITECTURE.md §8.1). Deliberately a separate file from
 * `seed.ts`: this file is only ever meant to be *run*, never imported, so it
 * carries no "am I the main module" self-check. That check used to live in
 * `seed.ts` guarded by `process.argv[1] === fileURLToPath(import.meta.url)`
 * — which works under tsx/plain Node, but esbuild bundling `seed.ts` to
 * CommonJS for the Docker image (task 2.10) makes `import.meta.url`
 * `undefined`, so the guard always failed and `main()` never ran the
 * seed at container startup. Splitting the CLI entrypoint out removes the
 * need for that check entirely, and keeps `seed.ts`'s own `seed()`
 * export — which `packages/db/src/testHarness.ts`'s `withCleanDatabase()`
 * also imports — free of any script-only side effect.
 */
async function main(): Promise<void> {
  console.log("[seed] seeding instance_state + system categories ...");
  await seed(getDb());
  console.log("[seed] done.");
  await getPool().end();
}

main().catch((error: unknown) => {
  console.error("[seed] failed:", error);
  process.exit(1);
});
