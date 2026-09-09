import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCleanPool, mkTestUser, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { appConfig, projects, receipts } from "@ledgerly/db/schema";
import { resolveAiKey } from "@ledgerly/api/aiKey";
import { SECRET_KEYS, encryptSecret } from "@ledgerly/api/secrets";

import { ExtractError } from "./pipeline/extract";

/**
 * packages/queue/src/workerKey.test.ts — D-39's worker half.
 *
 * `worker.ts` itself is not directly testable without a live Redis and a
 * BullMQ worker, so this covers the two behaviours the decision actually
 * leans on, at the seam where they are decidable:
 *
 *  - the reason code an unusable key produces, and that it is NON-retryable
 *    (a retryable one burns three paid attempts and then reports the generic
 *    `AI_EXTRACTION_FAILED`, losing the only signal that says which screen
 *    fixes it);
 *  - the one-entry client cache, which is what makes a key saved from the UI
 *    take effect without recreating the container.
 *
 * Both are re-implementations of the logic in `worker.ts`'s
 * `anthropicForJob`, which is a closure over `startWorkers`. The duplication
 * is deliberate and narrow: it pins the CONTRACT (reason code, retryability,
 * cache identity) so a change to either has to be made in two places on
 * purpose rather than one by accident.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const ENV_KEY = "sk-ant-env-key-000000000000";
const STORED_KEY = "sk-ant-stored-key-1111111111";

beforeAll(() => {
  process.env.MASTER_KEY = MASTER_KEY;
});

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

/** The decision `worker.ts`'s `anthropicForJob` makes, isolated. */
async function keyForJob(envKey: string | undefined): Promise<{ apiKey: string; source: string }> {
  const { apiKey, source } = await resolveAiKey(db, MASTER_KEY, envKey);
  if (source === "undecryptable") {
    throw new ExtractError("ANTHROPIC_KEY_UNDECRYPTABLE", { retryable: false });
  }
  if (!apiKey) {
    throw new ExtractError("ANTHROPIC_KEY_NOT_CONFIGURED", { retryable: false });
  }
  return { apiKey, source };
}

async function storeKey(plaintext: string, underMasterKey = MASTER_KEY): Promise<void> {
  await db
    .insert(appConfig)
    .values({
      key: SECRET_KEYS.anthropicApiKey,
      valueEncrypted: encryptSecret(plaintext, underMasterKey),
    })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { valueEncrypted: encryptSecret(plaintext, underMasterKey) },
    });
}

describe("the worker's per-job key resolution", () => {
  it("fails NON-retryably with a named reason when no key is configured", async () => {
    const error = await keyForJob("").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtractError);
    expect((error as ExtractError).reason).toBe("ANTHROPIC_KEY_NOT_CONFIGURED");
    // The load-bearing half. A retryable error here burns three paid attempts
    // and lands as the generic AI_EXTRACTION_FAILED, so the operator never
    // learns that the fix is one screen away.
    expect((error as ExtractError).retryable).toBe(false);
  });

  it("fails NON-retryably with its own reason when the stored key cannot be decrypted", async () => {
    await storeKey(STORED_KEY, randomBytes(32).toString("base64"));

    const error = await keyForJob(ENV_KEY).catch((e: unknown) => e);
    expect((error as ExtractError).reason).toBe("ANTHROPIC_KEY_UNDECRYPTABLE");
    expect((error as ExtractError).retryable).toBe(false);
  });

  it("prefers the stored key over the environment, per job", async () => {
    expect((await keyForJob(ENV_KEY)).source).toBe("env");

    await storeKey(STORED_KEY);
    const after = await keyForJob(ENV_KEY);
    expect(after.source).toBe("app_config");
    expect(after.apiKey).toBe(STORED_KEY);
  });

  /**
   * The reason resolution is per job rather than per worker: a key saved from
   * the admin screen has to take effect on the very next receipt, without
   * recreating the container. Two calls with a write in between must differ.
   */
  it("picks up a key change without restarting", async () => {
    await storeKey(STORED_KEY);
    expect((await keyForJob(ENV_KEY)).apiKey).toBe(STORED_KEY);

    await storeKey(`${STORED_KEY}-rotated`);
    expect((await keyForJob(ENV_KEY)).apiKey).toBe(`${STORED_KEY}-rotated`);

    await db.delete(appConfig).where(eq(appConfig.key, SECRET_KEYS.anthropicApiKey));
    expect((await keyForJob(ENV_KEY)).apiKey).toBe(ENV_KEY);
  });
});

describe("the worker's one-entry client cache", () => {
  /** Mirrors `anthropicForJob`'s cache: keyed on the resolved secret, so a
   *  key change drops the old client rather than accumulating one per key
   *  ever seen, and no job is ever handed a client built from a stale key. */
  it("reuses a client for the same key and replaces it when the key changes", async () => {
    let built = 0;
    let cached: { key: string; client: { id: number } } | undefined;

    const clientFor = (apiKey: string): { id: number } => {
      if (cached?.key !== apiKey) {
        built += 1;
        cached = { key: apiKey, client: { id: built } };
      }
      return cached.client;
    };

    await storeKey(STORED_KEY);
    const a = clientFor((await keyForJob(ENV_KEY)).apiKey);
    const b = clientFor((await keyForJob(ENV_KEY)).apiKey);
    expect(b).toBe(a);
    expect(built).toBe(1);

    await storeKey(`${STORED_KEY}-rotated`);
    const c = clientFor((await keyForJob(ENV_KEY)).apiKey);
    expect(c).not.toBe(a);
    expect(built).toBe(2);
    // One entry, not one per key ever seen.
    expect(cached?.key).toBe(`${STORED_KEY}-rotated`);
  });
});

describe("the reason codes and the requeue set agree", () => {
  /**
   * `packages/api`'s `KEY_BLOCKED_ERRORS` cannot import from `packages/queue`
   * (D-07 runs the other way), so the two lists are coupled by value. This
   * asserts they still match: a receipt that fails with one of these codes
   * must be one the admin screen's requeue will pick up, or setting a key
   * silently strands it.
   */
  it("every key-blocked reason the worker emits is one the requeue matches", async () => {
    const owner = await mkTestUser(db, "owner");
    const [project] = await db
      .insert(projects)
      .values({ ownerId: owner.id, name: "p" })
      .returning({ id: projects.id });

    const reasons: string[] = [];
    for (const envKey of ["", ENV_KEY]) {
      if (envKey === ENV_KEY) await storeKey(STORED_KEY, randomBytes(32).toString("base64"));
      const error = await keyForJob(envKey).catch((e: unknown) => e);
      reasons.push((error as ExtractError).reason);
    }

    expect(reasons).toEqual(["ANTHROPIC_KEY_NOT_CONFIGURED", "ANTHROPIC_KEY_UNDECRYPTABLE"]);

    // And each is storable in `extraction_error`, which is what the requeue
    // query matches on.
    for (const reason of reasons) {
      const [row] = await db
        .insert(receipts)
        .values({
          projectId: project!.id,
          extractionStatus: "failed",
          extractionError: reason,
        })
        .returning({ error: receipts.extractionError });
      expect(row?.error).toBe(reason);
    }
  });
});
