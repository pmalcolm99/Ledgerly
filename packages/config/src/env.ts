import "server-only";

import { z } from "zod";

import { cfAccessAudSchema, zBoolEnv, zOptionalString } from "./schema-fragments";

/**
 * packages/config/src/env.ts — Zod env schema, parsed once per process.
 *
 * `parseEnv` is a pure function over an injected record. That is what makes
 * the invariants below testable without mutating `process.env` or fighting
 * the module cache (ARCHITECTURE.md §7.1, D-14). `env` at the bottom of this
 * file is the only place `process.env` is actually read.
 *
 * Every variable here is documented in ARCHITECTURE.md §7.2 and mirrored,
 * placeholder-only, in `.env.example`.
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // --- App -------------------------------------------------------------
  APP_PORT: z.coerce.number().int().positive().default(3000),
  APP_HOSTNAME: zOptionalString(),

  // --- Data stores -------------------------------------------------------
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1).default("redis://redis:6379"),

  // --- Secrets / crypto --------------------------------------------------
  MASTER_KEY: z
    .string()
    .min(1, "MASTER_KEY is required")
    .refine(isBase64, { message: "MASTER_KEY must be base64-encoded" })
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "MASTER_KEY must base64-decode to exactly 32 bytes",
    }),

  // --- Filesystem ----------------------------------------------------------
  UPLOADS_DIR: z.string().min(1).default("/app/uploads"),
  BACKUPS_DIR: z.string().min(1).default("/app/backups"),

  // --- Cloudflare Access ---------------------------------------------------
  CF_ACCESS_ENABLED: zBoolEnv(false),
  CF_ACCESS_AUD: cfAccessAudSchema,
  CF_ACCESS_TEAM_DOMAIN: zOptionalString(),
  CF_ACCESS_JWKS_TTL_MS: z.coerce.number().int().min(60_000).default(3_600_000),

  // --- Dev / recovery flags -------------------------------------------------
  DEV_AUTH_BYPASS: zBoolEnv(false),
  ACCESS_ALLOW_SUB_RELINK: zBoolEnv(false),

  // --- AI extraction ---------------------------------------------------------
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  AI_MODEL_PASS1: z.string().min(1).default("claude-haiku-4-5"),
  AI_MODEL_PASS2: z.string().min(1).default("claude-sonnet-5"),
  AI_ESCALATE_BELOW: z.coerce.number().min(0).max(1).default(0.6),
  AI_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // --- Uploads -----------------------------------------------------------
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800),
  RETAIN_ORIGINALS: zBoolEnv(false),
  // Decompression-bomb guard (Phase 5 task 5.2): checked against header-only
  // dimensions (sharp .metadata(), or a PDF's declared page size at the
  // pipeline's fixed rasterization DPI) BEFORE any decode.
  MAX_UPLOAD_MEGAPIXELS: z.coerce.number().int().positive().default(100),
  // Per-user, whole-batch-atomic, Redis-backed (packages/api/src/rateLimit.ts).
  UPLOAD_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  // Concurrency cap for the Phase 5 `receipt-ingest` render-pipeline worker
  // (packages/queue/src/ingestWorker.ts) — a DIFFERENT knob from
  // AI_CONCURRENCY above, which caps Phase 6's `receipt-extract` AI-call
  // worker. Same default by coincidence only; do not merge the two.
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // --- Misc ----------------------------------------------------------------
  DEFAULT_CURRENCY: z.string().length(3).default("USD"),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  BACKUP_INCLUDE_IMAGES: zBoolEnv(false),
});

type RawEnv = z.infer<typeof rawSchema>;

export type Env = RawEnv;

// ---------------------------------------------------------------------------
// cross-field invariants
// ---------------------------------------------------------------------------

function applyInvariants(env: RawEnv, ctx: z.RefinementCtx): void {
  // D-05: the dev bypass must never be reachable in production. This is a
  // startup guard, not a per-request check — see instrumentation.ts.
  if (env.DEV_AUTH_BYPASS && env.NODE_ENV === "production") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DEV_AUTH_BYPASS"],
      message: "DEV_AUTH_BYPASS must not be true when NODE_ENV=production (D-05).",
    });
  }

  // Production requires real Cloudflare Access configuration.
  if (env.NODE_ENV === "production") {
    if (!env.CF_ACCESS_AUD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CF_ACCESS_AUD"],
        message: "CF_ACCESS_AUD is required when NODE_ENV=production.",
      });
    }
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CF_ACCESS_TEAM_DOMAIN"],
        message: "CF_ACCESS_TEAM_DOMAIN is required when NODE_ENV=production.",
      });
    }
  }
}

const envSchema = rawSchema.superRefine(applyInvariants);

// ---------------------------------------------------------------------------
// parseEnv — the pure function every test exercises
// ---------------------------------------------------------------------------

/**
 * Parses and validates an injected record (never `process.env` directly —
 * that indirection is what makes this testable). Throws a single Error
 * listing every problem found, field-level and cross-field alike, so a
 * misconfiguration is diagnosable from one log line instead of a chain of
 * fix-one-rerun-find-the-next cycles.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new Error(
      `Invalid environment configuration (${issues.length} problem${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((issue) => `  - ${issue}`).join("\n"),
    );
  }

  // D-27: an intentionally-enabled recovery flag must be loud, every boot,
  // so it is never left on by accident after an identity-provider migration.
  if (result.data.ACCESS_ALLOW_SUB_RELINK) {
    console.warn(
      "[ledgerly] WARN: ACCESS_ALLOW_SUB_RELINK=true. Email-matched sub re-linking is " +
        "active. This should be enabled only during a deliberate identity-provider " +
        "migration and turned off immediately afterward (D-27).",
    );
  }

  return result.data;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// the process-wide parse
// ---------------------------------------------------------------------------

let cached: Env | undefined;

/**
 * Parses `process.env` once and caches it.
 *
 * **Lazy, and called explicitly at boot rather than run at module load.**
 * An eager module-scope parse makes merely *importing* this module require
 * a fully-configured environment — and `next build` collects page data by
 * evaluating every route module, so any route that transitively imports
 * config would fail the build on a machine that has no production secrets.
 * That is a build that only works by accident of the shell it runs in.
 *
 * The D-05 / D-14 startup guarantee is unchanged, and is not weakened by
 * being lazy: `apps/web/src/instrumentation.ts` CALLS this function during
 * `register()`, before the server listens. A misconfigured process still
 * refuses to boot rather than failing later on some unlucky route. The
 * guard is "invoked once at startup", which it still is — it is just no
 * longer "invoked as a side effect of any import from anywhere".
 */
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

// ---------------------------------------------------------------------------
// client-safe subset — explicit whitelist only
// ---------------------------------------------------------------------------

/**
 * Only these keys are re-exported to the client. `ANTHROPIC_API_KEY`,
 * `MASTER_KEY`, `DATABASE_URL`, `REDIS_URL`, and `CF_ACCESS_AUD` are never
 * among them (ARCHITECTURE.md §7.2, CLAUDE.md).
 */
export function getPublicEnv() {
  const env = getEnv();
  return {
    APP_HOSTNAME: env.APP_HOSTNAME,
    DEFAULT_CURRENCY: env.DEFAULT_CURRENCY,
    NODE_ENV: env.NODE_ENV,
  } as const;
}
