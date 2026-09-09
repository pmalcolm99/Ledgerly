import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCleanPool, mkTestUser, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { appConfig, auditLog, projects, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";
import { resolveAiKey } from "../aiKey";
import { SECRET_KEYS, decryptSecret, encryptSecret } from "../secrets";

/**
 * packages/api/src/routers/aiKey.test.ts — D-39's three obligations.
 *
 * 1. Only the instance owner can read the status or change the key.
 * 2. The key NEVER comes back over tRPC, in any shape.
 * 3. The stored value overrides the environment, and clearing falls back.
 *
 * `MASTER_KEY` is set here before the first `getEnv()` call in this file's
 * module registry — the same "set process.env once in beforeAll" trick
 * `receipts.test.ts` uses for `UPLOADS_DIR`, forced by `env.ts`'s caching.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const ENV_KEY = "sk-ant-from-environment-0000000000";

beforeAll(() => {
  process.env.MASTER_KEY = MASTER_KEY;
  process.env.ANTHROPIC_API_KEY = ENV_KEY;
});

let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxFor = (user: AuthUser | null): Context => ({ db, user });

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

const GOOD_KEY = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("admin.aiKey — authorization", () => {
  it("an instance owner can read the status", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const result = await appRouter.createCaller(ctxFor(owner as unknown as AuthUser)).admin.aiKey();
    expect(result.source).toBe("env");
  });

  it("a non-owner is refused, on read and on both writes", async () => {
    const member = await mkTestUser(db, "member");
    const caller = appRouter.createCaller(ctxFor(member as unknown as AuthUser));

    await expect(caller.admin.aiKey()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.setAiKey({ apiKey: GOOD_KEY })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.admin.clearAiKey()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an unauthenticated caller is refused", async () => {
    const caller = appRouter.createCaller(ctxFor(null));
    await expect(caller.admin.aiKey()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.admin.setAiKey({ apiKey: GOOD_KEY })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  /**
   * A non-owner's FORBIDDEN must not depend on whether a key is stored, or
   * the error itself becomes a one-bit oracle about instance configuration.
   */
  it("refuses a non-owner identically whether or not a key is stored", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const member = await mkTestUser(db, "member");
    const memberCaller = appRouter.createCaller(ctxFor(member as unknown as AuthUser));

    const before = await memberCaller.admin.aiKey().catch((e: unknown) => e);
    await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setAiKey({ apiKey: GOOD_KEY });
    const after = await memberCaller.admin.aiKey().catch((e: unknown) => e);

    expect((before as { code: string }).code).toBe((after as { code: string }).code);
    expect((before as Error).message).toBe((after as Error).message);
  });
});

describe("admin.aiKey — the key never leaves the server", () => {
  it("returns a hint, never the key, on any procedure", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner as unknown as AuthUser));

    const setResult = await caller.admin.setAiKey({ apiKey: GOOD_KEY });
    const status = await caller.admin.aiKey();

    // Serialised, so a nested field cannot hide the value from a shallow check.
    const everything = JSON.stringify({ setResult, status });
    expect(everything).not.toContain(GOOD_KEY);
    expect(everything).not.toContain("api03");

    expect(status.source).toBe("app_config");
    expect(status.hint).toBe(`…${GOOD_KEY.slice(-4)} (${GOOD_KEY.length} characters)`);
  });

  it("does not leak the environment key either", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const status = await appRouter.createCaller(ctxFor(owner as unknown as AuthUser)).admin.aiKey();

    expect(JSON.stringify(status)).not.toContain(ENV_KEY);
    expect(status.source).toBe("env");
    expect(status.hint).toContain("…0000");
  });

  it("stores the key encrypted, not as plaintext bytes", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setAiKey({ apiKey: GOOD_KEY });

    const [row] = await db
      .select({ value: appConfig.valueEncrypted })
      .from(appConfig)
      .where(eq(appConfig.key, SECRET_KEYS.anthropicApiKey));

    expect(row).toBeDefined();
    expect(row!.value.toString("utf8")).not.toContain(GOOD_KEY);
    expect(row!.value.toString("utf8")).not.toContain("sk-ant");
    // ...and it really is the key, once you hold MASTER_KEY.
    expect(decryptSecret(row!.value, MASTER_KEY)).toBe(GOOD_KEY);
  });
});

describe("admin.aiKey — precedence and lifecycle", () => {
  it("the stored key overrides the environment, and clearing falls back", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner as unknown as AuthUser));

    expect((await resolveAiKey(db, MASTER_KEY, ENV_KEY)).source).toBe("env");

    await caller.admin.setAiKey({ apiKey: GOOD_KEY });
    const stored = await resolveAiKey(db, MASTER_KEY, ENV_KEY);
    expect(stored.source).toBe("app_config");
    expect(stored.apiKey).toBe(GOOD_KEY);

    await caller.admin.clearAiKey();
    const fellBack = await resolveAiKey(db, MASTER_KEY, ENV_KEY);
    expect(fellBack.source).toBe("env");
    expect(fellBack.apiKey).toBe(ENV_KEY);
  });

  it("reports `none` when neither is set", async () => {
    expect((await resolveAiKey(db, MASTER_KEY, "")).source).toBe("none");
    expect((await resolveAiKey(db, MASTER_KEY, undefined)).apiKey).toBeNull();
  });

  it("replacing a key overwrites rather than accumulating rows", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner as unknown as AuthUser));

    await caller.admin.setAiKey({ apiKey: GOOD_KEY });
    await caller.admin.setAiKey({ apiKey: `${GOOD_KEY}-second` });

    const rows = await db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, SECRET_KEYS.anthropicApiKey));
    expect(rows).toHaveLength(1);
    expect((await resolveAiKey(db, MASTER_KEY, ENV_KEY)).apiKey).toBe(`${GOOD_KEY}-second`);
  });

  it("rejects keys that are obviously mistakes, with a usable message", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner as unknown as AuthUser));

    await expect(caller.admin.setAiKey({ apiKey: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.admin.setAiKey({ apiKey: "sk-ant short" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.admin.setAiKey({ apiKey: "sk-tiny" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("trims surrounding whitespace from a pasted key", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setAiKey({ apiKey: `  ${GOOD_KEY}  ` });

    expect((await resolveAiKey(db, MASTER_KEY, ENV_KEY)).apiKey).toBe(GOOD_KEY);
  });
});

describe("admin.aiKey — recovery when MASTER_KEY no longer matches", () => {
  /**
   * Review finding M-1. Rotate MASTER_KEY, or restore a dump onto an instance
   * with a different one, and the stored row is ciphertext nobody can read.
   * The screen that fixes it must not be the screen that breaks.
   */
  it("reports `undecryptable` instead of throwing, so the admin screen still renders", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner as unknown as AuthUser));
    await caller.admin.setAiKey({ apiKey: GOOD_KEY });

    // Simulate the rotation by overwriting the row with ciphertext from a
    // different key — byte-for-byte what a restore-with-wrong-MASTER_KEY
    // leaves behind.
    const otherKey = randomBytes(32).toString("base64");
    await db
      .update(appConfig)
      .set({ valueEncrypted: encryptSecret(GOOD_KEY, otherKey) })
      .where(eq(appConfig.key, SECRET_KEYS.anthropicApiKey));

    const status = await caller.admin.aiKey();
    expect(status.source).toBe("undecryptable");
    expect(status.hint).toBeNull();
  });

  /** Crucially it must NOT quietly fall back to the environment key, or the
   *  operator never learns their MASTER_KEY is wrong. */
  it("does not silently fall back to the environment key", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setAiKey({ apiKey: GOOD_KEY });

    const otherKey = randomBytes(32).toString("base64");
    await db
      .update(appConfig)
      .set({ valueEncrypted: encryptSecret(GOOD_KEY, otherKey) })
      .where(eq(appConfig.key, SECRET_KEYS.anthropicApiKey));

    const resolved = await resolveAiKey(db, MASTER_KEY, ENV_KEY);
    expect(resolved.source).toBe("undecryptable");
    expect(resolved.apiKey).toBeNull();
  });

  it("clearing works against a row that cannot be decrypted", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner as unknown as AuthUser));
    await caller.admin.setAiKey({ apiKey: GOOD_KEY });

    const otherKey = randomBytes(32).toString("base64");
    await db
      .update(appConfig)
      .set({ valueEncrypted: encryptSecret(GOOD_KEY, otherKey) })
      .where(eq(appConfig.key, SECRET_KEYS.anthropicApiKey));

    const result = await caller.admin.clearAiKey();
    expect(result.cleared).toBe(true);
    expect((await resolveAiKey(db, MASTER_KEY, ENV_KEY)).source).toBe("env");
  });
});

describe("admin.aiKey — the key-blocked backlog", () => {
  async function insertFailedReceipt(reason: string | null): Promise<string> {
    const owner = await mkTestUser(db, `up-${reason ?? "none"}-${Math.random()}`);
    const [project] = await db
      .insert(projects)
      .values({ ownerId: owner.id, name: `p-${Math.random()}` })
      .returning({ id: projects.id });
    const [row] = await db
      .insert(receipts)
      .values({
        projectId: project!.id,
        uploadedBy: owner.id,
        extractionStatus: reason === null ? "ok" : "failed",
        extractionError: reason,
        imageKey: "webp",
      })
      .returning({ id: receipts.id });
    return row!.id;
  }

  /**
   * Review finding M-2, and D-39's own headline scenario: fresh instance, no
   * key, upload receipts, then set the key. Before this, the whole backlog
   * stayed `failed` forever — `reconcilePendingExtractions` only sweeps
   * `pending` — and the user had to find and re-extract each one by hand.
   */
  it("re-enqueues receipts that failed only for want of a key, and nothing else", async () => {
    const blocked = await insertFailedReceipt("ANTHROPIC_KEY_NOT_CONFIGURED");
    const undecryptable = await insertFailedReceipt("ANTHROPIC_KEY_UNDECRYPTABLE");
    const unrelated = await insertFailedReceipt("IMAGE_DECODE_FAILED");
    const fine = await insertFailedReceipt(null);

    const enqueued: string[] = [];
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller({
      db,
      user: owner as unknown as AuthUser,
      enqueueReceiptExtract: async ({ receiptId }) => {
        enqueued.push(receiptId);
      },
    });

    const result = await caller.admin.setAiKey({ apiKey: GOOD_KEY });
    expect(result.requeued).toBe(2);
    expect([...enqueued].sort()).toEqual([blocked, undecryptable].sort());

    const rows = await db
      .select({
        id: receipts.id,
        status: receipts.extractionStatus,
        error: receipts.extractionError,
      })
      .from(receipts);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(blocked)?.status).toBe("pending");
    expect(byId.get(blocked)?.error).toBeNull();
    expect(byId.get(undecryptable)?.status).toBe("pending");
    // Untouched: a decode failure is not a key problem.
    expect(byId.get(unrelated)?.status).toBe("failed");
    expect(byId.get(unrelated)?.error).toBe("IMAGE_DECODE_FAILED");
    expect(byId.get(fine)?.status).toBe("ok");
  });

  /** The queue is an optional capability. A missing one must not fail the key
   *  change — the receipts are left `pending` for the boot sweep. */
  it("still resets the receipts when no queue is wired into the context", async () => {
    const blocked = await insertFailedReceipt("ANTHROPIC_KEY_NOT_CONFIGURED");
    const owner = await mkTestUser(db, "owner", "owner");

    const result = await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setAiKey({ apiKey: GOOD_KEY });

    expect(result.requeued).toBe(1);
    const [row] = await db
      .select({ status: receipts.extractionStatus })
      .from(receipts)
      .where(eq(receipts.id, blocked));
    expect(row?.status).toBe("pending");
  });

  it("reports zero when there is no backlog", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const result = await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setAiKey({ apiKey: GOOD_KEY });
    expect(result.requeued).toBe(0);
  });
});

describe("admin.aiKey — audit", () => {
  it("does not audit a clear that cleared nothing", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const result = await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.clearAiKey();

    expect(result.cleared).toBe(false);
    const rows = await db.select().from(auditLog);
    expect(rows.filter((r) => r.action === "app_config.cleared")).toHaveLength(0);
  });

  it("audits a set and a clear, naming the key but never its value", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    const caller = appRouter.createCaller(ctxFor(owner as unknown as AuthUser));

    await caller.admin.setAiKey({ apiKey: GOOD_KEY });
    await caller.admin.clearAiKey();

    const rows = await db.select().from(auditLog).orderBy(auditLog.createdAt);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("app_config.updated");
    expect(actions).toContain("app_config.cleared");

    for (const row of rows) {
      expect(row.actorUserId).toBe(owner.id);
      const meta = JSON.stringify(row.metadata);
      expect(meta).toContain(SECRET_KEYS.anthropicApiKey);
      // Not even a hint: hints accumulated across many rows are a slow leak.
      expect(meta).not.toContain(GOOD_KEY);
      expect(meta).not.toContain("aaaa");
    }
  });
});
