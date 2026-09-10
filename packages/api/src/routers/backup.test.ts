import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getCleanPool, mkTestUser, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { appConfig, auditLog, backups } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";
import { SECRET_KEYS, encryptSecret } from "../secrets";
import { describeBackupSchedule, resolveBackupSchedule, validateCron } from "../backupSchedule";

/**
 * packages/api/src/routers/backup.test.ts — Phase 9's obligations on the API
 * side.
 *
 * The theme is the one the phase is built around: **a backup system that fails
 * silently is worse than none.** So the interesting assertions are not about
 * the happy path but about the states that could quietly mean "no backups are
 * happening" — an undecryptable schedule, a scheduler that is not registered, a
 * queue that is not wired — and about `path` never reaching a client.
 */

const MASTER_KEY = randomBytes(32).toString("base64");

beforeAll(() => {
  process.env.MASTER_KEY = MASTER_KEY;
});

let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxFor = (user: AuthUser | null, extra: Partial<Context> = {}): Context => ({
  db,
  user,
  ...extra,
});

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

async function owner(): Promise<AuthUser> {
  const user = await mkTestUser(db, "backup-owner");
  await db.update(schema.users).set({ role: "owner" }).where(eq(schema.users.id, user.id));
  return { ...user, role: "owner" } as unknown as AuthUser;
}

/** A context with every backup capability wired, plus the spies to assert on. */
function wiredCtx(user: AuthUser) {
  const enqueueBackup = vi.fn(async () => undefined);
  const rescheduleBackup = vi.fn(async () => undefined);
  const readBackupScheduleState = vi.fn(async () => ({
    registered: true,
    pattern: "0 3 * * *",
    nextRunAt: new Date("2026-09-10T03:00:00Z"),
  }));
  return {
    ctx: ctxFor(user, { enqueueBackup, rescheduleBackup, readBackupScheduleState }),
    enqueueBackup,
    rescheduleBackup,
    readBackupScheduleState,
  };
}

describe("validateCron", () => {
  it("accepts 5- and 6-field patterns and reports the next fire time", () => {
    const five = validateCron("0 3 * * *");
    expect(five.ok).toBe(true);
    expect(five.ok && five.next.getTime()).toBeGreaterThan(Date.now());
    expect(validateCron("30 0 4 * * *").ok).toBe(true);
  });

  it("refuses a 4-field pattern rather than scheduling a guess", () => {
    // cron-parser accepts this by padding it, which would silently schedule
    // something other than what was typed.
    const result = validateCron("0 3 * *");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("5 fields");
  });

  it("refuses nonsense", () => {
    expect(validateCron("not a cron").ok).toBe(false);
    expect(validateCron("99 99 99 99 99").ok).toBe(false);
  });
});

describe("resolveBackupSchedule", () => {
  it("reports `none` when nothing is stored", async () => {
    expect(await resolveBackupSchedule(db, MASTER_KEY)).toEqual({ schedule: null, source: "none" });
  });

  it("reports `app_config` and the cron when one is stored", async () => {
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ cron: "15 2 * * *" }), MASTER_KEY),
    });
    const resolved = await resolveBackupSchedule(db, MASTER_KEY);
    expect(resolved.source).toBe("app_config");
    expect(resolved.schedule).toEqual({ cron: "15 2 * * *" });
  });

  /**
   * The state this whole phase is defensive about. A rotated MASTER_KEY makes
   * the row unreadable; reporting that as "no schedule configured" would send
   * the operator hunting for a setting that is right there, and would make the
   * admin screen quietly wrong about whether backups are running.
   */
  it("reports `undecryptable` under a different MASTER_KEY, never `none`", async () => {
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ cron: "0 3 * * *" }), MASTER_KEY),
    });
    const other = randomBytes(32).toString("base64");
    const resolved = await resolveBackupSchedule(db, other);
    expect(resolved.source).toBe("undecryptable");
    expect(resolved.schedule).toBeNull();
  });

  it("reports `undecryptable` for a row that decrypts but no longer parses", async () => {
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ notACron: true }), MASTER_KEY),
    });
    expect((await resolveBackupSchedule(db, MASTER_KEY)).source).toBe("undecryptable");
  });

  it("reports `undecryptable` for a stored pattern that is no longer valid", async () => {
    // A cron that was accepted when written but is not now. Silently becoming
    // "no schedule" would be the same lie by another route.
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ cron: "0 3 * *" }), MASTER_KEY),
    });
    expect((await resolveBackupSchedule(db, MASTER_KEY)).source).toBe("undecryptable");
  });

  it("describes a stored schedule with its next run", async () => {
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ cron: "0 3 * * *" }), MASTER_KEY),
    });
    const described = await describeBackupSchedule(db, MASTER_KEY);
    expect(described.cron).toBe("0 3 * * *");
    expect(described.nextRunAt).toBeInstanceOf(Date);
    expect(described.updatedAt).toBeInstanceOf(Date);
  });
});

describe("admin backup procedures — authorization", () => {
  it("a non-owner is refused on every backup procedure", async () => {
    const member = await mkTestUser(db, "member");
    const caller = appRouter.createCaller(ctxFor(member as unknown as AuthUser));

    await expect(caller.admin.backups()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.backupStatus()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.createBackup()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.setBackupSchedule({ cron: "0 3 * * *" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.admin.clearBackupSchedule()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an anonymous caller is refused", async () => {
    const caller = appRouter.createCaller(ctxFor(null));
    await expect(caller.admin.createBackup()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a non-owner's refusal happens before any row is written", async () => {
    const member = await mkTestUser(db, "member2");
    const caller = appRouter.createCaller(ctxFor(member as unknown as AuthUser));
    await expect(caller.admin.createBackup()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(backups)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe("admin.createBackup", () => {
  it("inserts a running row, audits it, and enqueues against that row", async () => {
    const user = await owner();
    const { ctx, enqueueBackup } = wiredCtx(user);
    const result = await appRouter.createCaller(ctx).admin.createBackup();

    expect(result.ok).toBe(true);
    const [row] = await db.select().from(backups).where(eq(backups.id, result.backupId));
    expect(row!.status).toBe("running");
    expect(row!.kind).toBe("manual");
    expect(row!.path).toBeNull();

    // The enqueue names the row that already exists, so a job can never point
    // at nothing.
    expect(enqueueBackup).toHaveBeenCalledWith({ backupId: result.backupId, kind: "manual" });

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "backup.requested"), eq(auditLog.entityType, "backup")));
    expect(audit!.entityId).toBe(result.backupId);
    expect(audit!.metadata).toMatchObject({ via: "admin.createBackup" });
  });

  it("refuses while one is already running", async () => {
    const user = await owner();
    const { ctx, enqueueBackup } = wiredCtx(user);
    await db.insert(backups).values({ kind: "scheduled", status: "running" });

    await expect(appRouter.createCaller(ctx).admin.createBackup()).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(enqueueBackup).not.toHaveBeenCalled();
    // No second row: the refusal happens before the insert, so a rejected
    // click leaves no trace to clean up.
    expect(await db.select().from(backups)).toHaveLength(1);
  });

  /**
   * M-2: BullMQ can fail a stalled job without the retry the failed handler
   * assumes is coming, leaving the row `running` forever. Without an age bound,
   * one stalled job disables the button until the next restart — a backup
   * system that has quietly stopped accepting backups.
   */
  it("is not blocked by a running row older than a dump could possibly take", async () => {
    const user = await owner();
    const { ctx } = wiredCtx(user);
    await db.insert(backups).values({
      kind: "scheduled",
      status: "running",
      // Older than PG_DUMP_TIMEOUT_MS (2h), so it cannot still be running.
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    await expect(appRouter.createCaller(ctx).admin.createBackup()).resolves.toMatchObject({
      ok: true,
    });
  });

  it("is still blocked by a running row that could plausibly be in flight", async () => {
    const user = await owner();
    const { ctx } = wiredCtx(user);
    await db.insert(backups).values({
      kind: "scheduled",
      status: "running",
      startedAt: new Date(Date.now() - 60 * 1000),
    });
    await expect(appRouter.createCaller(ctx).admin.createBackup()).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("ignores a soft-deleted running row when deciding whether one is in flight", async () => {
    const user = await owner();
    const { ctx } = wiredCtx(user);
    await db
      .insert(backups)
      .values({ kind: "scheduled", status: "running", deletedAt: new Date() });
    await expect(appRouter.createCaller(ctx).admin.createBackup()).resolves.toMatchObject({
      ok: true,
    });
  });

  /**
   * The row is written first and the enqueue happens after, so a Redis failure
   * leaves a visible `running` row rather than nothing — `backupWorker`'s boot
   * sweep marks it `failed`, which is the honest outcome. What must NOT happen
   * is the caller being told it worked.
   */
  it("reports SERVICE_UNAVAILABLE when the enqueue fails, leaving the row visible", async () => {
    const user = await owner();
    const enqueueBackup = vi.fn(async () => {
      throw new Error("redis is down");
    });
    const caller = appRouter.createCaller(ctxFor(user, { enqueueBackup }));

    await expect(caller.admin.createBackup()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    const rows = await db.select().from(backups);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");
  });

  it("reports SERVICE_UNAVAILABLE when no queue is wired at all", async () => {
    const user = await owner();
    await expect(appRouter.createCaller(ctxFor(user)).admin.createBackup()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});

describe("admin.backups / admin.backupStatus — what reaches the client", () => {
  /**
   * `path` is a host filesystem path, and `manifest` is jsonb that carries the
   * same kind of detail. Neither has any business in a browser: the download
   * route takes a row id and resolves the path server-side. Asserted over the
   * serialised payload rather than by eyeballing the select, so a field added
   * later cannot slip through.
   */
  it("never returns `path` or `manifest`, in either shape", async () => {
    const user = await owner();
    await db.insert(backups).values({
      kind: "manual",
      status: "complete",
      path: "/app/backups/ledgerly-backup-20260909T000000Z.tgz",
      sizeBytes: 4096,
      manifest: { tables: { users: 1 }, secretish: "/app/backups" },
      finishedAt: new Date(),
    });
    const caller = appRouter.createCaller(wiredCtx(user).ctx);

    const list = JSON.stringify(await caller.admin.backups());
    expect(list).not.toContain("/app/backups");
    expect(list).not.toContain("secretish");
    expect(list).toContain("hasArtifact");

    const status = JSON.stringify(await caller.admin.backupStatus());
    expect(status).not.toContain("/app/backups");
    expect(status).not.toContain("secretish");
  });

  it("hasArtifact is false once retention has unlinked the file", async () => {
    const user = await owner();
    await db.insert(backups).values({ kind: "manual", status: "complete", path: null });
    const [row] = await appRouter.createCaller(wiredCtx(user).ctx).admin.backups();
    expect(row!.hasArtifact).toBe(false);
  });

  it("excludes soft-deleted rows", async () => {
    const user = await owner();
    await db
      .insert(backups)
      .values({ kind: "scheduled", status: "complete", deletedAt: new Date() });
    expect(await appRouter.createCaller(wiredCtx(user).ctx).admin.backups()).toHaveLength(0);
  });

  it("reports the last backup, the schedule, and the scheduler state together", async () => {
    const user = await owner();
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ cron: "0 3 * * *" }), MASTER_KEY),
    });
    await db.insert(backups).values({
      kind: "scheduled",
      status: "failed",
      error: "PG_DUMP_FAILED",
      startedAt: new Date("2026-09-08T03:00:00Z"),
    });

    const status = await appRouter.createCaller(wiredCtx(user).ctx).admin.backupStatus();
    expect(status.last?.status).toBe("failed");
    // The reason travels with it — a failed backup that does not say why is
    // barely better than one that failed silently.
    expect(status.last?.error).toBe("PG_DUMP_FAILED");
    expect(status.schedule.source).toBe("app_config");
    expect(status.schedule.cron).toBe("0 3 * * *");
    expect(status.scheduler).toEqual({
      registered: true,
      pattern: "0 3 * * *",
      nextRunAt: new Date("2026-09-10T03:00:00Z"),
    });
  });

  /**
   * M-4: registered is not the same as registered WITH THE SAVED CRON.
   *
   * `setBackupSchedule` commits to `app_config` before it touches Redis, so a
   * failed reschedule leaves the old scheduler in place. Every other indicator
   * reads healthy — `registered: true`, a next-run computed from the new cron —
   * while backups go on running at the old time indefinitely. The card can only
   * catch that if the pattern travels with the rest.
   */
  it("carries the scheduler's own pattern, so a stale one is detectable", async () => {
    const user = await owner();
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ cron: "30 4 * * *" }), MASTER_KEY),
    });
    // Redis still holds the previous cron.
    const readBackupScheduleState = vi.fn(async () => ({
      registered: true,
      pattern: "0 3 * * *",
      nextRunAt: new Date("2026-09-10T03:00:00Z"),
    }));
    const status = await appRouter
      .createCaller(ctxFor(user, { readBackupScheduleState }))
      .admin.backupStatus();

    expect(status.schedule.cron).toBe("30 4 * * *");
    expect(status.scheduler?.pattern).toBe("0 3 * * *");
    // The disagreement is representable, which is the whole point.
    expect(status.scheduler?.pattern).not.toBe(status.schedule.cron);
  });

  /**
   * "We could not ask Redis" must not be reported as "nothing is registered" —
   * the UI raises an alarm on the second and must not on the first.
   */
  it("reports scheduler as null when the capability is absent, not as unregistered", async () => {
    const user = await owner();
    const status = await appRouter.createCaller(ctxFor(user)).admin.backupStatus();
    expect(status.scheduler).toBeNull();
  });

  it("reports scheduler as null when reading it throws", async () => {
    const user = await owner();
    const readBackupScheduleState = vi.fn(async () => {
      throw new Error("redis is down");
    });
    const status = await appRouter
      .createCaller(ctxFor(user, { readBackupScheduleState }))
      .admin.backupStatus();
    expect(status.scheduler).toBeNull();
  });
});

describe("admin.setBackupSchedule / clearBackupSchedule", () => {
  it("stores the cron, audits it, and reschedules", async () => {
    const user = await owner();
    const { ctx, rescheduleBackup } = wiredCtx(user);
    const result = await appRouter.createCaller(ctx).admin.setBackupSchedule({ cron: "0 3 * * *" });

    expect(result.ok).toBe(true);
    expect(result.nextRunAt).toBeInstanceOf(Date);
    expect(rescheduleBackup).toHaveBeenCalledWith("0 3 * * *");
    expect((await resolveBackupSchedule(db, MASTER_KEY)).schedule).toEqual({ cron: "0 3 * * *" });

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "app_config.updated"));
    expect(audit!.metadata).toMatchObject({
      key: SECRET_KEYS.backupSchedule,
      via: "admin.setBackupSchedule",
      cron: "0 3 * * *",
    });
    // app_config rows are keyed by text and `audit_log.entity_id` is uuid.
    expect(audit!.entityId).toBeNull();
  });

  /**
   * Validation happens BEFORE the write. A pattern BullMQ would reject must
   * never be persisted as the configured schedule while nothing exists to run
   * it — a stored intention with no effect that looks correct on the screen
   * that set it.
   */
  it("rejects an invalid cron without writing anything", async () => {
    const user = await owner();
    const { ctx, rescheduleBackup } = wiredCtx(user);
    await expect(
      appRouter.createCaller(ctx).admin.setBackupSchedule({ cron: "0 3 * *" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(rescheduleBackup).not.toHaveBeenCalled();
    expect(await db.select().from(appConfig)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  /**
   * The write has already committed by the time the reschedule runs, so a
   * failure there is reported as "saved, not yet live" rather than thrown.
   * Throwing would tell the operator the whole operation failed when the
   * durable half succeeded, and invite a retry of something that does not need
   * retrying.
   */
  it("reports a reschedule failure without losing the saved schedule", async () => {
    const user = await owner();
    const rescheduleBackup = vi.fn(async () => {
      throw new Error("redis is down");
    });
    const result = await appRouter
      .createCaller(ctxFor(user, { rescheduleBackup }))
      .admin.setBackupSchedule({ cron: "0 3 * * *" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("Restart");
    expect((await resolveBackupSchedule(db, MASTER_KEY)).schedule).toEqual({ cron: "0 3 * * *" });
  });

  it("clears the schedule, audits it, and removes the scheduler", async () => {
    const user = await owner();
    const { ctx, rescheduleBackup } = wiredCtx(user);
    await appRouter.createCaller(ctx).admin.setBackupSchedule({ cron: "0 3 * * *" });
    rescheduleBackup.mockClear();

    const result = await appRouter.createCaller(ctx).admin.clearBackupSchedule();
    expect(result.cleared).toBe(true);
    expect(rescheduleBackup).toHaveBeenCalledWith(null);
    expect((await resolveBackupSchedule(db, MASTER_KEY)).source).toBe("none");
    const cleared = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "app_config.cleared"));
    expect(cleared).toHaveLength(1);
  });

  it("does not audit a clear that cleared nothing", async () => {
    const user = await owner();
    const result = await appRouter.createCaller(wiredCtx(user).ctx).admin.clearBackupSchedule();
    expect(result.cleared).toBe(false);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "app_config.cleared")),
    ).toHaveLength(0);
  });

  /**
   * The recovery path. `clearBackupSchedule` never reads the stored row, so it
   * works on ciphertext nobody can decrypt — and saving over an unreadable row
   * must succeed too, or the admin screen becomes a dead end after a
   * MASTER_KEY rotation.
   */
  it("can replace or clear a schedule that cannot be decrypted", async () => {
    const user = await owner();
    const other = randomBytes(32).toString("base64");
    await db.insert(appConfig).values({
      key: SECRET_KEYS.backupSchedule,
      valueEncrypted: encryptSecret(JSON.stringify({ cron: "0 3 * * *" }), other),
    });
    expect((await resolveBackupSchedule(db, MASTER_KEY)).source).toBe("undecryptable");

    const { ctx } = wiredCtx(user);
    await appRouter.createCaller(ctx).admin.setBackupSchedule({ cron: "30 4 * * *" });
    expect((await resolveBackupSchedule(db, MASTER_KEY)).schedule).toEqual({ cron: "30 4 * * *" });

    expect((await appRouter.createCaller(ctx).admin.clearBackupSchedule()).cleared).toBe(true);
  });
});
