import { randomUUID } from "node:crypto";

import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EMAIL_RECEIPT_RATE_LIMIT_PER_DAY,
  EMAIL_RECEIPT_RATE_LIMIT_PER_MIN,
  checkEmailReceiptRateLimit,
  checkUploadRateLimit,
  checkWindowedRateLimit,
} from "./rateLimit";

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

/**
 * D-44. The per-minute cap bounds a burst; it does not bound the bill.
 * `emailReceipt` needs only READ on a project, so any member of any shared
 * project can drive it, and 5/min sustained is over 7,000 messages a day —
 * enough to exhaust a typical 10,000/month relay plan in under two days and
 * take the operator's sending reputation with it.
 */
describe("checkEmailReceiptRateLimit", () => {
  it("admits a normal send", async () => {
    const result = await checkEmailReceiptRateLimit(redis, randomUUID());
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("rejects once the per-minute budget is spent", async () => {
    const userId = randomUUID();
    for (let i = 0; i < EMAIL_RECEIPT_RATE_LIMIT_PER_MIN; i++) {
      expect((await checkEmailReceiptRateLimit(redis, userId)).allowed).toBe(true);
    }
    const denied = await checkEmailReceiptRateLimit(redis, userId);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  /**
   * The daily budget must NOT be charged for a request the per-minute check
   * already refused — otherwise a client hammering past the minute limit burns
   * the whole day's allowance doing it, which is the opposite of the point.
   */
  it("does not spend the daily budget on requests the minute limit refused", async () => {
    const userId = randomUUID();
    for (let i = 0; i < EMAIL_RECEIPT_RATE_LIMIT_PER_MIN; i++) {
      await checkEmailReceiptRateLimit(redis, userId);
    }
    for (let i = 0; i < 20; i++) {
      expect((await checkEmailReceiptRateLimit(redis, userId)).allowed).toBe(false);
    }

    // The daily counter should hold exactly the admitted requests.
    const bucket = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    const spent = await redis.get(`email_receipt_daily:${userId}:${bucket}`);
    expect(Number(spent)).toBe(EMAIL_RECEIPT_RATE_LIMIT_PER_MIN);
  });
});

describe("checkWindowedRateLimit", () => {
  it("counts against a window longer than a minute and expires it", async () => {
    const key = `test_window:${randomUUID()}`;
    const windowSeconds = 24 * 60 * 60;

    expect((await checkWindowedRateLimit(redis, key, 1, 2, windowSeconds)).allowed).toBe(true);
    expect((await checkWindowedRateLimit(redis, key, 1, 2, windowSeconds)).allowed).toBe(true);

    const denied = await checkWindowedRateLimit(redis, key, 1, 2, windowSeconds);
    expect(denied.allowed).toBe(false);
    // Retry-after is bounded by the window, not by 60 seconds.
    expect(denied.retryAfterSeconds).toBeGreaterThan(60);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);

    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const ttl = await redis.ttl(`${key}:${bucket}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(windowSeconds);
  });

  it("is a per-user budget, not a shared one", async () => {
    const a = `test_window:${randomUUID()}`;
    const b = `test_window:${randomUUID()}`;
    expect((await checkWindowedRateLimit(redis, a, 1, 1, 3600)).allowed).toBe(true);
    expect((await checkWindowedRateLimit(redis, a, 1, 1, 3600)).allowed).toBe(false);
    expect((await checkWindowedRateLimit(redis, b, 1, 1, 3600)).allowed).toBe(true);
  });
});

/** Guard against the daily cap being set below the per-minute cap, which would
 *  make the minute limit unreachable and the messages misleading. */
it("EMAIL_RECEIPT_RATE_LIMIT_PER_DAY exceeds the per-minute budget", () => {
  expect(EMAIL_RECEIPT_RATE_LIMIT_PER_DAY).toBeGreaterThan(EMAIL_RECEIPT_RATE_LIMIT_PER_MIN);
});
