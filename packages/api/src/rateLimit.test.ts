import { randomUUID } from "node:crypto";

import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkUploadRateLimit } from "./rateLimit";

/**
 * Real local Redis (scripts/test-redis.sh / TEST_REDIS_URL — mirrors D-18's
 * TEST_DATABASE_URL reasoning). The Lua script's atomicity is exactly what
 * these tests are checking, so a fake/in-memory stand-in would prove
 * nothing.
 */
function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error(
      "TEST_REDIS_URL is required to run rate-limit tests. Set it in .env " +
        "(scripts/test-redis.sh), or rely on CI's throwaway redis service.",
    );
  }
  return url;
}

let redis: IORedis;

beforeAll(() => {
  redis = new IORedis(testRedisUrl());
});

afterAll(async () => {
  await redis.quit();
});

describe("checkUploadRateLimit", () => {
  it("admits requests within the limit", async () => {
    const userId = randomUUID();
    const result = await checkUploadRateLimit(redis, userId, 5, 10);
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("rejects a request that would exceed the limit", async () => {
    const userId = randomUUID();
    const first = await checkUploadRateLimit(redis, userId, 8, 10);
    expect(first.allowed).toBe(true);

    const second = await checkUploadRateLimit(redis, userId, 5, 10);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("rejects the whole batch atomically -- no partial admission", async () => {
    const userId = randomUUID();
    // Exactly at the limit already.
    await checkUploadRateLimit(redis, userId, 10, 10);

    const rejected = await checkUploadRateLimit(redis, userId, 1, 10);
    expect(rejected.allowed).toBe(false);

    // The rejected attempt must not have incremented the counter -- a
    // request for exactly the remaining budget (0) should still be
    // rejected (cost must be > 0 to mean anything), and a subsequent
    // legitimate check for a DIFFERENT user is unaffected.
    const otherUser = await checkUploadRateLimit(redis, randomUUID(), 10, 10);
    expect(otherUser.allowed).toBe(true);
  });

  it("does not let concurrent requests from the same user both pass a shared boundary", async () => {
    const userId = randomUUID();
    const limit = 10;
    // 20 concurrent requests of cost 1 against a limit of 10 -- exactly 10
    // must be admitted if the script is truly atomic. A GET-then-INCRBY
    // race (two round trips instead of one Lua script) would let more than
    // 10 through.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkUploadRateLimit(redis, userId, 1, limit)),
    );
    const admitted = results.filter((r) => r.allowed).length;
    expect(admitted).toBe(limit);
  });

  it("isolates users from each other", async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    await checkUploadRateLimit(redis, userA, 10, 10);

    const aRejected = await checkUploadRateLimit(redis, userA, 1, 10);
    const bAllowed = await checkUploadRateLimit(redis, userB, 1, 10);

    expect(aRejected.allowed).toBe(false);
    expect(bAllowed.allowed).toBe(true);
  });
});
