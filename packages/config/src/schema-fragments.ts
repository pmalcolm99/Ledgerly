import { z } from "zod";

/**
 * Field-level Zod builders shared between `env.ts` (full server schema) and
 * `edge.ts` (the four-key Edge Runtime subset). This module must stay free
 * of `server-only` and Node built-ins — `edge.ts` imports it directly and is
 * bundled for the Edge Runtime.
 */

/** "true" / "false" from the environment, coerced to a real boolean. Any
 * other non-empty string is passed through so Zod reports a clear issue
 * rather than silently defaulting. */
export function zBoolEnv(defaultValue: boolean) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === "") return undefined;
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    },
    z.boolean({ invalid_type_error: 'must be "true" or "false"' }).default(defaultValue),
  );
}

/** Empty string -> undefined, so `KEY=` in a .env file behaves like an unset
 * key rather than a defined-but-blank one. */
export function zOptionalString() {
  return z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
}

/** D-25: an unconfigured `CF_ACCESS_AUD` must fail at startup, never at
 * verification time. Empty is treated as "not configured"; anything else
 * must be exactly 64 lowercase hex characters. */
export const cfAccessAudSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .regex(/^[0-9a-f]{64}$/, "CF_ACCESS_AUD must be 64 lowercase hex characters")
    .optional(),
);
