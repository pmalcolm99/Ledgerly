import { Queue, Worker } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";

import { RECEIPT_EMAIL_QUEUE_NAME, assertUsableJobId, autoEmailJobId } from "./queue";
import { getRedisConnection } from "./redis";

/**
 * packages/queue/src/autoEmailJobId.test.ts — the automatic receipt email's job
 * id, against a REAL BullMQ queue.
 *
 * ## Why this file exists
 *
 * `autoEmailJobId` returned `${receiptId}:auto` from the day D-44 was written.
 * BullMQ builds its Redis keys as `bull:<queue>:<jobId>` and refuses a custom
 * id containing `:` — `add()` throws `Custom Id cannot contain :`. So every
 * automatic enqueue threw, `worker.ts` swallowed it (deliberately: a Redis
 * hiccup must not fail an extraction that has already been paid for), and the
 * feature had never once worked in production. Manual sends were unaffected,
 * because they pass no job id at all — which is exactly why it looked like
 * "email works, but not automatically".
 *
 * It shipped because `autoEmailJobId` had NO test of any kind, and because
 * every other test in this package injects a fake queue. A string assertion
 * would not have caught it either: the id is well-formed, it is BullMQ that
 * refuses it. **Only adding a job to a real queue proves this contract**, so
 * that is what this does — the same reasoning `rateLimit.test.ts` gives for
 * testing its Lua script against a real Redis rather than a stand-in.
 */

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error(
      "TEST_REDIS_URL is required to run the job-id tests. Set it in .env " +
        "(scripts/test-redis.sh), or rely on CI's throwaway redis service.",
    );
  }
  return url;
}

const url = testRedisUrl();
const RECEIPT_ID = "11111111-2222-3333-4444-555555555555";
/** Its own queue, so obliterating it cannot disturb the real one. */
const PROBE_QUEUE = `${RECEIPT_EMAIL_QUEUE_NAME}-jobid-probe`;

afterAll(async () => {
  await getRedisConnection(url).quit();
});

describe("autoEmailJobId", () => {
  it("does not contain a colon", () => {
    expect(autoEmailJobId(RECEIPT_ID)).not.toContain(":");
    expect(autoEmailJobId(RECEIPT_ID)).toBe(`${RECEIPT_ID}-auto`);
  });

  it("is still stable per receipt, which is what the once-only marker relies on", () => {
    expect(autoEmailJobId(RECEIPT_ID)).toBe(autoEmailJobId(RECEIPT_ID));
    expect(autoEmailJobId(RECEIPT_ID)).not.toBe(autoEmailJobId("22222222-0000-0000-0000-0000"));
  });

  /** The assertion that would have caught the original bug. */
  it("is accepted by a real BullMQ queue and actually runs", async () => {
    const queue = new Queue(PROBE_QUEUE, {
      connection: getRedisConnection(url),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    });
    await queue.obliterate({ force: true }).catch(() => undefined);

    const processed: string[] = [];
    const worker = new Worker(
      PROBE_QUEUE,
      async (job) => {
        processed.push(String(job.id));
      },
      { connection: getRedisConnection(url), autorun: true },
    );

    try {
      const jobId = autoEmailJobId(RECEIPT_ID);
      // `add` is where the original failed — it threw rather than returning.
      const added = await queue.add("email", { receiptId: RECEIPT_ID, reason: "auto" }, { jobId });
      expect(added.id).toBe(jobId);

      await expect.poll(() => processed, { timeout: 10_000 }).toEqual([jobId]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  }, 30_000);

  /** Pins the BullMQ behaviour this whole file is about, so a future reader
   *  does not have to take the comment on faith — and so an upgrade that
   *  changed it would be visible rather than silent. */
  it("BullMQ really does reject a colon in a custom id", async () => {
    const queue = new Queue(PROBE_QUEUE, { connection: getRedisConnection(url) });
    try {
      await expect(
        queue.add("email", { receiptId: RECEIPT_ID }, { jobId: `${RECEIPT_ID}:auto` }),
      ).rejects.toThrow(/cannot contain/i);
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  }, 30_000);
});

describe("assertUsableJobId", () => {
  it("throws loudly on a colon rather than leaving it for the enqueue to swallow", () => {
    expect(() => assertUsableJobId("abc:auto")).toThrow(/cannot contain/i);
    // The message names the offending id — the original failure was invisible
    // precisely because nothing said which receipt or which id.
    expect(() => assertUsableJobId("abc:auto")).toThrow(/abc:auto/);
  });

  it("passes anything BullMQ accepts through untouched", () => {
    expect(assertUsableJobId(`${RECEIPT_ID}-auto`)).toBe(`${RECEIPT_ID}-auto`);
    expect(assertUsableJobId(RECEIPT_ID)).toBe(RECEIPT_ID);
  });
});
