import "server-only";

import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { getDb } from "@ledgerly/db";
import type { Database } from "@ledgerly/db";
import { isOnboarded, resolveIdentityFromHeaders } from "@ledgerly/auth";
import type { AuthUser } from "@ledgerly/auth";

import type { RateLimitRedis } from "./rateLimit";
import type { SmtpConfig } from "./smtp";

/**
 * packages/api/src/trpc.ts — context and the procedure ladder
 * (task 3.11, ARCHITECTURE.md §4.3, contract §8).
 */

/** Enqueues a `receipt-extract` job. Injected rather than imported, because
 * `packages/queue` already depends on `@ledgerly/api` (e.g.
 * `pipeline/render.ts` uses `storage.ts`) — importing `@ledgerly/queue`
 * back from here would be a circular workspace dependency, not just a
 * style violation of ARCHITECTURE.md §2's one-way dependency direction.
 * `apps/web`'s tRPC route handler supplies the real implementation;
 * `undefined` (the default, e.g. in tests and `createCallerFactory`
 * callers that don't pass it) means the one procedure that reads it
 * (`receipts.reextract`) records its audit row but logs a warning instead
 * of enqueuing — never crashes the mutation over a missing capability. */
export type EnqueueReceiptExtract = (params: {
  receiptId: string;
  forcePass2: boolean;
}) => Promise<void>;

/** Enqueues a `receipt-email` job. Injected for the same reason as
 * `enqueueReceiptExtract` above. `receipts.emailReceipt` is the only caller;
 * it never sends, it only asks the queue to. */
export type EnqueueReceiptEmail = (params: {
  receiptId: string;
  toUserId: string;
  requestedBy: string;
}) => Promise<void>;

/** Sends one message NOW, used only by `admin.testSmtp`. Injected because
 * `nodemailer` lives in `packages/queue` (which already depends on this
 * package, so the import would be circular) and because the credential-
 * consuming client must stay unreachable from anything `apps/web` bundles.
 * Every other send in the app goes through the queue. */
export type SendEmail = (params: {
  config: SmtpConfig;
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

/** Enqueues a `backup` job against a `backups` row this package has already
 * inserted (Phase 9). Injected for the same reason as the two above.
 *
 * The row is created first and the enqueue happens after, so a Redis failure
 * leaves a visible `running` row rather than a backup nobody knows was asked
 * for — `backupWorker.ts`'s boot sweep marks it `failed`, which is the honest
 * outcome. `admin.createBackup` is the only caller. */
export type EnqueueBackup = (params: {
  backupId: string;
  kind: "manual" | "scheduled";
}) => Promise<void>;

/** Registers, replaces, or removes the nightly backup's BullMQ job scheduler
 * (task 9.3, whose acceptance criterion is that changing the cron in the UI
 * reschedules without a restart — which is exactly what this capability buys).
 * `null` removes the schedule.
 *
 * `app_config` remains the source of truth; this only reconciles Redis to it,
 * and `backupWorker.ts` does the same reconciliation at boot, so a failure here
 * is recoverable by restarting rather than being silently permanent. */
export type RescheduleBackup = (cron: string | null) => Promise<void>;

/** Reports what the backup scheduler in Redis currently holds, so
 * `admin.backupStatus` can tell "a schedule is configured and registered" from
 * "a schedule is configured and nothing is going to run it" — the second being
 * the silent failure Phase 9 exists to prevent. */
export type ReadBackupScheduleState = () => Promise<{
  registered: boolean;
  pattern: string | null;
  nextRunAt: Date | null;
}>;

export type Context = {
  db: Database;
  user: AuthUser | null;
  enqueueReceiptExtract?: EnqueueReceiptExtract;
  enqueueReceiptEmail?: EnqueueReceiptEmail;
  sendEmail?: SendEmail;
  enqueueBackup?: EnqueueBackup;
  rescheduleBackup?: RescheduleBackup;
  readBackupScheduleState?: ReadBackupScheduleState;
  /** Same injection reasoning as `enqueueReceiptExtract` above (Redis
   * lives behind `@ledgerly/queue`, which cannot be imported back into
   * this package). Used by `receipts.reextract` (review finding M-3) to
   * cap how often a caller can force a paid Sonnet pass. */
  rateLimitRedis?: RateLimitRedis;
};

/**
 * Resolves identity exactly ONCE per request and passes `ctx.user` down.
 * That is task 3.6's guarantee for the API path — the React `cache()`
 * wrapper in apps/web covers the RSC path by a different route to the same
 * end (one database read per request, D-03).
 */
export async function createContext(opts: {
  headers: Headers;
  enqueueReceiptExtract?: EnqueueReceiptExtract;
  enqueueReceiptEmail?: EnqueueReceiptEmail;
  sendEmail?: SendEmail;
  enqueueBackup?: EnqueueBackup;
  rescheduleBackup?: RescheduleBackup;
  readBackupScheduleState?: ReadBackupScheduleState;
  rateLimitRedis?: RateLimitRedis;
}): Promise<Context> {
  return {
    db: getDb(),
    user: await resolveIdentityFromHeaders(opts.headers),
    enqueueReceiptExtract: opts.enqueueReceiptExtract,
    enqueueReceiptEmail: opts.enqueueReceiptEmail,
    sendEmail: opts.sendEmail,
    enqueueBackup: opts.enqueueBackup,
    rescheduleBackup: opts.rescheduleBackup,
    readBackupScheduleState: opts.readBackupScheduleState,
    rateLimitRedis: opts.rateLimitRedis,
  };
}

/**
 * Messages the client is allowed to see. Everything else is replaced.
 *
 * tRPC's default `getErrorShape` puts `error.message` verbatim into the
 * response for EVERY code, including an `INTERNAL_SERVER_ERROR` synthesised
 * from a caught throw. Without this formatter the client receives things
 * like `duplicate key value violates unique constraint
 * "users_cf_access_sub_key"`, the `instance_state singleton row is missing`
 * hint, or a `pg` connection error carrying the database host — the exact
 * failure D-27 calls out as "itself a finding". The Phase 3 contract §8
 * promised this formatter; it was missing until the task 3.12 review.
 */
const CLIENT_SAFE_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "BAD_REQUEST",
  "TOO_MANY_REQUESTS",
  // D-44. A capability that exists and FAILS — the receipt-email enqueue
  // losing Redis — needs to tell the caller that nothing was sent, which the
  // flattened "Internal server error." cannot. Safe to admit as a class
  // because tRPC never SYNTHESISES this code: `getErrorFromUnknown` maps every
  // unrecognised throw to INTERNAL_SERVER_ERROR, so the only way a
  // SERVICE_UNAVAILABLE reaches here is a `new TRPCError` written in this
  // repository, whose message is therefore ours and not a driver's.
  "SERVICE_UNAVAILABLE",
]);

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  // Decided here, once, rather than inherited from `process.env.NODE_ENV`
  // at module-load time: tRPC's default `isDev` would attach stack traces
  // to responses in any environment that is not exactly "production".
  isDev: false,
  errorFormatter({ shape, error }) {
    if (CLIENT_SAFE_CODES.has(error.code)) return shape;

    // Server-side only. This is the one place the real cause is recorded.
    console.error(`[ledgerly] tRPC ${error.code}:`, error.cause ?? error.message);

    // Deleted, not set to `undefined`: superjson serialises undefined as
    // `null` plus a `meta.values` entry, so the keys would survive into the
    // response body announcing what was stripped.
    const data: Record<string, unknown> = { ...shape.data };
    delete data.stack;
    delete data.path;

    return { ...shape, message: "Internal server error.", data } as typeof shape;
  },
});

export const router = t.router;
export const middleware = t.middleware;
/** Server-side invocation of a procedure without an HTTP round trip. Used
 * by the /welcome server action so onboarding goes through the same
 * procedure — and therefore the same authorization — as any other caller. */
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure;

/** Identity present. The building block; not exported, because on its own
 * it does not enforce onboarding — see D-28. */
const requireAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Identity present, onboarding NOT required. The explicit opt-out from the
 * default, and deliberately awkward to reach for: it has exactly two
 * members, `auth.me` and `auth.completeOnboarding`. A third is a review
 * trigger.
 */
export const onboardingProcedure = t.procedure.use(requireAuth);

/**
 * Identity present AND onboarded. THE DEFAULT (D-28).
 *
 * The inverse shaping — an opt-in `requireOnboarded` composed onto the
 * procedures that need it — fails OPEN when omitted, and omission is the
 * failure that actually happens. This fails closed: forgetting to think
 * about onboarding yields a blocked route, noticed immediately, rather than
 * an open one, noticed by nobody.
 */
export const protectedProcedure = onboardingProcedure.use(({ ctx, next }) => {
  if (!isOnboarded(ctx.user)) {
    // The message is the contract with the client, which redirects to
    // /welcome on seeing it. It leaks nothing.
    throw new TRPCError({ code: "FORBIDDEN", message: "ONBOARDING_REQUIRED" });
  }
  return next({ ctx });
});

/**
 * The instance owner. This is the only permission expressed as a
 * procedure: per-project permission is `scopedProjects(user, level)`
 * composed into the query, never a middleware (ARCHITECTURE.md §4.3).
 */
export const ownerProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
