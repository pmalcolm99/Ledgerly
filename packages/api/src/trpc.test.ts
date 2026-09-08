import { drizzle } from "drizzle-orm/node-postgres";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCleanPool, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { users } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "./root";
import { publicProcedure, router } from "./trpc";
import type { Context } from "./trpc";

/**
 * Contract §12.4 tests 31–33 — the procedure ladder — plus a regression
 * test for the missing `errorFormatter` (H-1 from the task 3.12 review).
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

async function mkUser(key: string, opts: { onboarded: boolean; owner?: boolean }) {
  const [row] = await db
    .insert(users)
    .values({
      cfAccessSub: `sub-${key}`,
      email: `${key}@example.com`,
      role: opts.owner ? "owner" : "user",
      ...(opts.onboarded ? { firstName: "T", lastName: "User", onboardedAt: new Date() } : {}),
    })
    .returning();
  return row as AuthUser;
}

const ctxFor = (user: AuthUser | null): Context => ({ db, user });

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

describe("the procedure ladder (task 3.11, D-28)", () => {
  it("protectedProcedure without an identity throws UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(ctxFor(null));
    await expect(
      caller.admin.relinkAccount({ email: "a@b.com", newCfAccessSub: "x" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("protectedProcedure with an un-onboarded user throws FORBIDDEN / ONBOARDING_REQUIRED", async () => {
    const user = await mkUser("fresh-owner", { onboarded: false, owner: true });
    const caller = appRouter.createCaller(ctxFor(user));
    // Owner role, so the only thing that can stop them is the gate.
    await expect(
      caller.admin.relinkAccount({ email: "a@b.com", newCfAccessSub: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "ONBOARDING_REQUIRED" });
  });

  it("ownerProcedure as a non-owner throws FORBIDDEN, with no onboarding hint", async () => {
    const user = await mkUser("plain", { onboarded: true });
    const caller = appRouter.createCaller(ctxFor(user));
    const error = await caller.admin
      .relinkAccount({ email: "a@b.com", newCfAccessSub: "x" })
      .then(() => null)
      .catch((e: { code: string; message: string }) => e);
    expect(error?.code).toBe("FORBIDDEN");
    expect(error?.message).not.toBe("ONBOARDING_REQUIRED");
  });

  it("onboardingProcedure is reachable by an un-onboarded user (the opt-out)", async () => {
    const user = await mkUser("fresh", { onboarded: false });
    const caller = appRouter.createCaller(ctxFor(user));
    const me = await caller.auth.me();
    expect(me.onboarded).toBe(false);
    expect(me.email).toBe("fresh@example.com");
  });

  it("completeOnboarding satisfies the gate in one statement", async () => {
    const user = await mkUser("newbie", { onboarded: false });
    const caller = appRouter.createCaller(ctxFor(user));
    const result = await caller.auth.completeOnboarding({ firstName: "Ada", lastName: "L" });
    expect(result.onboarded).toBe(true);

    const [row] = await db.select().from(users);
    // Names and onboarded_at are written together, so the two
    // representations of "onboarded" cannot disagree (D-28).
    expect(row?.firstName).toBe("Ada");
    expect(row?.onboardedAt).not.toBeNull();
  });
});

// --- H-1 regression ----------------------------------------------------
describe("errorFormatter (H-1)", () => {
  const leakyRouter = router({
    boom: publicProcedure.query(() => {
      throw new Error('duplicate key value violates unique constraint "users_email_lower_key"');
    }),
  });

  async function callBoom() {
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/boom"),
      router: leakyRouter,
      createContext: () => ctxFor(null),
    });
    // superjson nests the payload under `error.json`; accept either shape
    // so the assertion is about content, not transformer internals.
    const body = (await response.json()) as {
      error?: { message?: string; data?: unknown; json?: { message?: string; data?: unknown } };
    };
    return { body, message: body.error?.json?.message ?? body.error?.message };
  }

  it("replaces an internal error message instead of returning it to the client", async () => {
    const { body, message } = await callBoom();
    expect(message).toBe("Internal server error.");
    // The specific leak the review found: a Postgres constraint name.
    expect(JSON.stringify(body)).not.toMatch(/users_email_lower_key|duplicate key/);
  });

  it("attaches no stack trace", async () => {
    const { body } = await callBoom();
    expect(JSON.stringify(body)).not.toMatch(/\bat \w+.*:\d+:\d+/);
    expect(JSON.stringify(body)).not.toMatch(/"stack"/);
  });

  it("still passes through client-facing codes unchanged", async () => {
    const user = await mkUser("fresh2", { onboarded: false, owner: true });
    const caller = appRouter.createCaller(ctxFor(user));
    await expect(
      caller.admin.relinkAccount({ email: "a@b.com", newCfAccessSub: "x" }),
    ).rejects.toMatchObject({ message: "ONBOARDING_REQUIRED" });
  });
});
