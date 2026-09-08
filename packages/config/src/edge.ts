import { z } from "zod";

import { cfAccessAudSchema, zBoolEnv, zOptionalString } from "./schema-fragments";

/**
 * packages/config/src/edge.ts — the Edge Runtime subset of env.ts.
 *
 * Next.js inlines `process.env.LITERAL_KEY` into the Edge Runtime bundle at
 * build time via static analysis, but does NOT provide a full `process.env`
 * object there — a Zod parse over the whole environment would silently
 * yield `{}` on the Edge. This file exists to read exactly the four keys the
 * Phase 3 middleware needs, each as its own literal `process.env.X`
 * expression, validated by the same field schemas `env.ts` uses.
 *
 * CF_ACCESS_JWKS_TTL_MS is here too (five keys, not four as the Phase 3
 * design pass first sketched): `packages/auth/src/jwks.ts` needs it, and
 * that module is imported by the Edge middleware as well as the Node
 * layer, so it cannot reach for `env.ts`.
 *
 * Rules that keep this working:
 *   - no `import "server-only"` (this file legitimately runs on the Edge)
 *   - no destructuring of `process.env`
 *   - no dynamic key access (`process.env[someVariable]`)
 *   - no Node built-ins
 */

const edgeSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DEV_AUTH_BYPASS: zBoolEnv(false),
    CF_ACCESS_ENABLED: zBoolEnv(false),
    CF_ACCESS_AUD: cfAccessAudSchema,
    CF_ACCESS_TEAM_DOMAIN: zOptionalString(),
    CF_ACCESS_JWKS_TTL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  })
  // D-05, enforced HERE as well as in env.ts. The Node-side guard runs in
  // instrumentation at boot; this one makes the invariant true inside the
  // Edge runtime independently, so the middleware can never honour a
  // production dev-bypass even if the Node process somehow started.
  .superRefine((edge, ctx) => {
    if (edge.DEV_AUTH_BYPASS && edge.NODE_ENV === "production") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEV_AUTH_BYPASS"],
        message: "DEV_AUTH_BYPASS must not be true when NODE_ENV=production (D-05).",
      });
    }
  });

export type EdgeEnv = z.infer<typeof edgeSchema>;

/** Pure over an injected record, so the D-05 invariant is testable without
 * mutating the environment — same reason `env.ts` exports `parseEnv`. */
export function parseEdgeEnv(raw: Record<string, string | undefined>): EdgeEnv {
  const result = edgeSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`Invalid Edge Runtime environment configuration:\n${issues.join("\n")}`);
  }

  return result.data;
}

function readEdgeEnv(): EdgeEnv {
  return parseEdgeEnv({
    NODE_ENV: process.env.NODE_ENV,
    DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
    CF_ACCESS_ENABLED: process.env.CF_ACCESS_ENABLED,
    CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
    CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_JWKS_TTL_MS: process.env.CF_ACCESS_JWKS_TTL_MS,
  });
}

export const edgeEnv = readEdgeEnv();
