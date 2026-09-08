import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `bytea`. Drizzle's pg-core has no built-in column type for it —
 * see the survey in `pnpm db:generate`'s review notes — so this defines the
 * minimal custom type: raw bytes in, raw bytes out, no driver-side mapping.
 * Used only by `app_config.value_encrypted` (docs/SCHEMA.md §app_config).
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
