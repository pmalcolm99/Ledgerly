import "server-only";

import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { getDb } from "@ledgerly/db";
import type { Database } from "@ledgerly/db";
import { isOnboarded, resolveIdentityFromHeaders } from "@ledgerly/auth";
import type { AuthUser } from "@ledgerly/auth";

/**
 * packages/api/src/trpc.ts — context and the procedure ladder
 * (task 3.11, ARCHITECTURE.md §4.3, contract §8).
 */

export type Context = {
  db: Database;
  user: AuthUser | null;
};

/**
 * Resolves identity exactly ONCE per request and passes `ctx.user` down.
 * That is task 3.6's guarantee for the API path — the React `cache()`
 * wrapper in apps/web covers the RSC path by a different route to the same
 * end (one database read per request, D-03).
 */
export async function createContext(opts: { headers: Headers }): Promise<Context> {
  return { db: getDb(), user: await resolveIdentityFromHeaders(opts.headers) };
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
