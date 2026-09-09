import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { aiUsage, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/admin.test.ts — `admin.aiUsage` (task 6.10).
 * Review finding M-6: neither new Phase 6 procedure had an authorization
 * test before this file. `relinkAccount` (the only other `adminRouter`
 * procedure) has no dedicated test file of its own either — its coverage
 * lives in `packages/auth`'s provisioning suite — so this file is scoped
 * to `aiUsage` only.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxFor = (user: AuthUser | null): Context => ({ db, user });

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

describe("admin.aiUsage -- authorization", () => {
  it("the instance owner can read it", async () => {
    const owner = await mkTestUser(db, "au-owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner));

    const result = await caller.admin.aiUsage(undefined);
    expect(result.models).toEqual([]);
    expect(result.escalationRate).toBeNull();
  });

  it("a non-owner project member is FORBIDDEN", async () => {
    const { users } = await createTestProjectWithMembers(db, {
      ownerKey: "au-projowner",
      members: [{ key: "full", permission: "full" }],
    });
    const caller = appRouter.createCaller(ctxFor(users.full!));

    await expect(caller.admin.aiUsage(undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an unauthenticated caller is UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(ctxFor(null));

    await expect(caller.admin.aiUsage(undefined)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("admin.aiUsage -- data shape", () => {
  it("aggregates spend and escalation rate per model", async () => {
    const { mkTestUser } = await import("@ledgerly/db/testHarness");
    const owner = await mkTestUser(db, "au-owner2", "owner");
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "au-p2", members: [] });
    const [receipt] = await db
      .insert(receipts)
      .values({ projectId: project.id, extractionStatus: "ok" })
      .returning({ id: receipts.id });

    await db.insert(aiUsage).values([
      {
        receiptId: receipt!.id,
        model: "claude-haiku-4-5",
        pass: 1,
        inputTokens: 1000,
        outputTokens: 100,
        escalated: false,
        ok: true,
      },
      {
        receiptId: receipt!.id,
        model: "claude-sonnet-5",
        pass: 2,
        inputTokens: 1000,
        outputTokens: 100,
        escalated: true,
        ok: true,
      },
    ]);

    const caller = appRouter.createCaller(ctxFor(owner));
    const result = await caller.admin.aiUsage(undefined);

    expect(result.totalCalls).toBe(2);
    expect(result.escalationRate).toBe(1); // 1 escalated / 1 pass-1 call
    const haiku = result.models.find((m) => m.model === "claude-haiku-4-5");
    expect(haiku?.calls).toBe(1);
    expect(haiku?.costUsd).not.toBeNull();
  });

  it("excludes a manual force-Sonnet call (escalated:false, pass:2) from the escalation rate", async () => {
    const { mkTestUser } = await import("@ledgerly/db/testHarness");
    const owner = await mkTestUser(db, "au-owner3", "owner");
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "au-p3", members: [] });
    const [receipt] = await db
      .insert(receipts)
      .values({ projectId: project.id, extractionStatus: "ok" })
      .returning({ id: receipts.id });

    await db.insert(aiUsage).values([
      {
        receiptId: receipt!.id,
        model: "claude-haiku-4-5",
        pass: 1,
        inputTokens: 1000,
        outputTokens: 100,
        escalated: false,
        ok: true,
      },
      {
        // receipts.reextract's manual force -- pass 2, escalated:false.
        receiptId: receipt!.id,
        model: "claude-sonnet-5",
        pass: 2,
        inputTokens: 1000,
        outputTokens: 100,
        escalated: false,
        ok: true,
      },
    ]);

    const caller = appRouter.createCaller(ctxFor(owner));
    const result = await caller.admin.aiUsage(undefined);

    expect(result.escalationRate).toBe(0); // 0 escalated / 1 pass-1 call
  });
});
