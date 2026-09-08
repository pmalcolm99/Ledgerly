import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs as a standalone CLI, outside the app process, so it does
// not go through @ledgerly/config's Zod validation — it only needs
// DATABASE_URL. Load the repo-root .env explicitly so `pnpm db:generate`
// works the same from any package directory.
loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required (set it in .env) to run drizzle-kit.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: connectionString,
  },
  verbose: true,
  strict: true,
});
