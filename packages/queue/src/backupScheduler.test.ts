import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  BACKUP_SCHEDULER_ID,
  getBackupQueue,
  getBackupScheduleState,
  removeBackupSchedule,
  upsertBackupSchedule,
} from "./queue";
import { getRedisConnection } from "./redis";

/**
 * packages/queue/src/backupScheduler.test.ts — task 9.3's acceptance criterion,
 * against a real Redis.
 *
 * "Changing the cron in the UI reschedules without a restart" reduces to one
 * property: `upsertJobScheduler` against a single fixed id REPLACES the
 * schedule rather than accumulating a scheduler per cron string ever
 * configured. A fake would prove nothing about that — it is BullMQ's own
 * behaviour under test — so this uses `TEST_REDIS_URL`, the same reasoning
 * `packages/api/src/rateLimit.test.ts` gives for the rate limiter's Lua script.
 */

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) {
    throw new Error(
      "TEST_REDIS_URL is required to run the backup scheduler tests. Set it in " +
        ".env (scripts/test-redis.sh), or rely on CI's throwaway redis service.",
    );
  }
  return url;
}

const url = testRedisUrl();

beforeEach(async () => {
  await removeBackupSchedule(url);
});

afterAll(async () => {
  await removeBackupSchedule(url);
  await getBackupQueue(url).close();
  await getRedisConnection(url).quit();
});

describe("the nightly backup scheduler", () => {
  it("reports nothing registered when no schedule is set", async () => {
    // Not merely `nextRunAt: null` — `registered: false` is what the admin card
    // renders as an error when a cron IS configured, so the two must be
    // distinguishable.
    expect(await getBackupScheduleState(url)).toEqual({
      registered: false,
      pattern: null,
      nextRunAt: null,
    });
  });

  it("registers a cron and reports when it will next fire", async () => {
    await upsertBackupSchedule(url, "0 3 * * *");
    const state = await getBackupScheduleState(url);
    expect(state.registered).toBe(true);
    expect(state.pattern).toBe("0 3 * * *");
    expect(state.nextRunAt).toBeInstanceOf(Date);
    expect(state.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  /** Task 9.3's acceptance, and the reason `BACKUP_SCHEDULER_ID` is a single
   *  fixed constant: a second upsert must replace the first, not add to it. */
  it("replaces the schedule on a second upsert rather than accumulating one", async () => {
    await upsertBackupSchedule(url, "0 3 * * *");
    await upsertBackupSchedule(url, "30 4 * * *");

    const state = await getBackupScheduleState(url);
    expect(state.pattern).toBe("30 4 * * *");

    const schedulers = await getBackupQueue(url).getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.key).toBe(BACKUP_SCHEDULER_ID);
  });

  it("removes the schedule, and removing twice is not an error", async () => {
    await upsertBackupSchedule(url, "0 3 * * *");
    await removeBackupSchedule(url);
    expect(await getBackupScheduleState(url)).toMatchObject({ registered: false });
    // The boot sweep calls this unconditionally when no cron is configured, so
    // a second removal has to be a no-op rather than a throw.
    await expect(removeBackupSchedule(url)).resolves.not.toThrow();
  });
});
