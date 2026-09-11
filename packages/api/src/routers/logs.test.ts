import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCleanPool, mkTestUser, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { appEvents, auditLog, users } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";
import { getEnv } from "@ledgerly/config/env";

import { recordEvent } from "../events";

/**
 * packages/api/src/routers/logs.test.ts — the Logs tab's query (D-46).
 *
 * The assertions that matter are about the SEAM. `admin.logs` merges two
 * tables with a UNION and keyset-paginates the result, and the failure mode of
 * a merged timeline is not "it returns nothing" — it is that a row is dropped
 * or repeated at a page boundary, which is invisible unless a test walks the
 * pages and compares against the whole set.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

const ctxFor = (user: AuthUser): Context => ({ db, user });

async function owner(): Promise<AuthUser> {
  const user = await mkTestUser(db, "logs-owner");
  await db.update(users).set({ role: "owner" }).where(eq(users.id, user.id));
  return { ...user, role: "owner" } as unknown as AuthUser;
}

/** Interleaves audit and event rows on a single shared clock, so the union has
 *  to actually order across both tables rather than happening to look right
 *  because one table's rows are all newer. */
async function interleaved(actorId: string, count: number): Promise<void> {
  const base = new Date("2026-09-01T00:00:00Z").getTime();
  for (let i = 0; i < count; i += 1) {
    const at = new Date(base + i * 1000);
    if (i % 2 === 0) {
      await db.insert(auditLog).values({
        actorUserId: actorId,
        action: "receipt.updated",
        entityType: "receipt",
        entityId: null,
        metadata: { seq: i },
        createdAt: at,
      });
    } else {
      await db.insert(appEvents).values({
        level: "info",
        category: "email",
        event: "email.sent",
        metadata: { seq: i },
        at,
      });
    }
  }
}

/**
 * The same interleaving, but at SUB-MILLISECOND spacing, written as raw SQL
 * because a JS `Date` cannot express a microsecond and so cannot set one up.
 *
 * This is the spacing `interleaved` above cannot produce and therefore cannot
 * test. It is not a contrived case: `audit_log.created_at` defaults to `now()`,
 * which is the TRANSACTION timestamp, so every audit row written by a single
 * mutation shares a `created_at` down to the microsecond — `members.ts` writes
 * two in one transaction. A cursor that rounds `at` to the millisecond skips
 * every row inside the rounded-away remainder, and skips them permanently,
 * because no later page ever asks for them again.
 */
async function interleavedMicroseconds(actorId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    // 100µs apart: ten rows inside a single millisecond.
    const at = `2026-09-01 00:00:00.${String(i * 100).padStart(6, "0")}+00`;
    if (i % 2 === 0) {
      await db.execute(sql`
        INSERT INTO audit_log (actor_user_id, action, entity_type, metadata, created_at)
        VALUES (${actorId}::uuid, 'receipt.updated', 'receipt', ${JSON.stringify({ seq: i })}::jsonb,
                ${at}::timestamptz)
      `);
    } else {
      await db.execute(sql`
        INSERT INTO app_events (level, category, event, metadata, at)
        VALUES ('info', 'email', 'email.sent', ${JSON.stringify({ seq: i })}::jsonb,
                ${at}::timestamptz)
      `);
    }
  }
}

/** Walks every page and returns the ids in the order they were handed out. */
async function walkPages(
  caller: ReturnType<typeof appRouter.createCaller>,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let page = await caller.admin.logs({ limit });
  seen.push(...page.items.map((i) => i.id));
  let guard = 0;
  while (page.nextCursor && guard < 50) {
    page = await caller.admin.logs({ limit, cursor: page.nextCursor });
    seen.push(...page.items.map((i) => i.id));
    guard += 1;
  }
  return seen;
}

describe("admin.logs — authorization", () => {
  it("a non-owner is refused", async () => {
    const member = await mkTestUser(db, "member");
    await expect(
      appRouter.createCaller(ctxFor(member as unknown as AuthUser)).admin.logs({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("admin.logs — the merged timeline", () => {
  it("returns both sources newest-first on one clock", async () => {
    const user = await owner();
    await interleaved(user.id, 6);

    const page = await appRouter.createCaller(ctxFor(user)).admin.logs({});
    expect(page.items).toHaveLength(6);
    // Strictly descending, across both tables.
    const times = page.items.map((i) => i.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // And both sources really are present — an ordering test over one source
    // would pass while the union was silently broken.
    expect(new Set(page.items.map((i) => i.source))).toEqual(new Set(["activity", "system"]));
  });

  /** THE ASSERTION THIS FILE EXISTS FOR. */
  it("pages without dropping or repeating a row at the seam", async () => {
    const user = await owner();
    await interleaved(user.id, 25);

    const seen = await walkPages(appRouter.createCaller(ctxFor(user)), 4);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25); // no repeats
  });

  /**
   * The same walk at microsecond spacing. This is the version that matters:
   * the one-second spacing above passes even when the cursor is truncated to
   * the millisecond, because a whole second survives the rounding. Ten rows
   * inside one millisecond do not — the boundary row's timestamp rounds down
   * onto its own neighbours and takes them off the end of the list.
   */
  it("pages without dropping a row when rows share a millisecond", async () => {
    const user = await owner();
    await interleavedMicroseconds(user.id, 10);

    const seen = await walkPages(appRouter.createCaller(ctxFor(user)), 3);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  /**
   * And the degenerate case the default `now()` actually produces: rows with
   * an IDENTICAL timestamp, where `id` is the only thing separating them.
   */
  it("pages through rows that share a timestamp exactly", async () => {
    const user = await owner();
    for (let i = 0; i < 6; i += 1) {
      await db.execute(sql`
        INSERT INTO audit_log (actor_user_id, action, entity_type, metadata, created_at)
        VALUES (${user.id}::uuid, 'receipt.updated', 'receipt', ${JSON.stringify({ seq: i })}::jsonb,
                '2026-09-01 00:00:00.123456+00'::timestamptz)
      `);
    }

    const seen = await walkPages(appRouter.createCaller(ctxFor(user)), 2);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  /**
   * The cursor is a string, so zod is the only thing standing between an
   * owner-supplied value and a `::timestamptz` cast. A cast error would be a
   * 500 — and since D-46, a 500 writes a `system.internal_error` row, so a
   * malformed cursor would litter the very table it was reading.
   */
  it("rejects a malformed cursor rather than letting the cast fail", async () => {
    const user = await owner();
    const caller = appRouter.createCaller(ctxFor(user));
    const id = "00000000-0000-4000-8000-000000000000";

    for (const at of ["not a date", "2026-09-01", "2026-09-01 00:00:00+00", ""]) {
      await expect(caller.admin.logs({ cursor: { at, id } })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
  });

  /** The cursor's format is this query's contract, not the server's
   *  `DateStyle`: microseconds, `T`, and a literal `Z`. */
  it("emits a cursor in a pinned ISO form with microseconds intact", async () => {
    const user = await owner();
    await interleavedMicroseconds(user.id, 4);

    const page = await appRouter.createCaller(ctxFor(user)).admin.logs({ limit: 2 });
    expect(page.nextCursor?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // Row index 2 of 4 (newest-first: seq 3, 2, |1, 0) — 200µs, not 0µs.
    expect(page.nextCursor?.at).toBe("2026-09-01T00:00:00.000200Z");
  });

  it("stops offering a cursor on the last page", async () => {
    const user = await owner();
    await interleaved(user.id, 3);
    const page = await appRouter.createCaller(ctxFor(user)).admin.logs({ limit: 50 });
    expect(page.nextCursor).toBeNull();
  });

  it("resolves the actor's name without exposing their address", async () => {
    const user = await owner();
    await interleaved(user.id, 2);
    const page = await appRouter.createCaller(ctxFor(user)).admin.logs({});
    const activity = page.items.find((i) => i.source === "activity");
    expect(activity?.actorName).toBeTruthy();
    expect(JSON.stringify(page.items)).not.toContain("@");
  });
});

describe("admin.logs — filters", () => {
  it("source=system returns only events, source=activity only audit rows", async () => {
    const user = await owner();
    await interleaved(user.id, 6);
    const caller = appRouter.createCaller(ctxFor(user));

    const system = await caller.admin.logs({ source: "system" });
    expect(system.items.every((i) => i.source === "system")).toBe(true);
    const activity = await caller.admin.logs({ source: "activity" });
    expect(activity.items.every((i) => i.source === "activity")).toBe(true);
    expect(system.items.length + activity.items.length).toBe(6);
  });

  it("filters by level and category", async () => {
    const user = await owner();
    await recordEvent(db, { level: "error", category: "backup", event: "backup.failed" });
    await recordEvent(db, { level: "info", category: "email", event: "email.sent" });

    const caller = appRouter.createCaller(ctxFor(user));
    const errors = await caller.admin.logs({ level: "error" });
    expect(errors.items.map((i) => i.event)).toEqual(["backup.failed"]);
    const emails = await caller.admin.logs({ category: "email" });
    expect(emails.items.map((i) => i.event)).toEqual(["email.sent"]);
  });

  /**
   * An audit row has neither a level nor a category, so it cannot satisfy
   * either filter. Including it anyway would mean asking for "errors" and
   * getting a list containing somebody renaming a project.
   */
  it("excludes audit rows when a level or category filter is set", async () => {
    const user = await owner();
    await interleaved(user.id, 6);
    const page = await appRouter.createCaller(ctxFor(user)).admin.logs({ level: "info" });
    expect(page.items.every((i) => i.source === "system")).toBe(true);
  });
});

describe("recordEvent", () => {
  /** The property the whole design rests on: a job that has already spent
   *  money must never be failed by a logging insert. */
  it("never throws, even when the insert fails", async () => {
    const exploding = {
      insert: () => ({
        values: () => Promise.reject(new Error("database is on fire")),
      }),
    } as unknown as Parameters<typeof recordEvent>[0];

    await expect(
      recordEvent(exploding, {
        level: "error",
        category: "system",
        event: "system.internal_error",
      }),
    ).resolves.toBeUndefined();
  });

  it("stamps the build sha onto every row", async () => {
    process.env.APP_GIT_SHA = "abcdef1234567890";
    try {
      await recordEvent(db, { level: "info", category: "system", event: "system.test" });
      const [row] = await db.select().from(appEvents);
      // Short sha: the full 40 characters is noise in a metadata blob nobody
      // greps by hand.
      expect(row!.metadata).toMatchObject({ appGitSha: "abcdef1" });
    } finally {
      delete process.env.APP_GIT_SHA;
    }
  });

  /**
   * The metadata in a log row is read in a browser, and several callers store a
   * raw `error.message` because for an unclassified failure that text IS the
   * diagnosis. That text is not ours — a pg error quotes the offending row.
   */
  it("scrubs a card number out of stored metadata", async () => {
    await recordEvent(db, {
      level: "error",
      category: "extraction",
      event: "extraction.failed",
      // A Luhn-valid 16-digit number, as a constraint violation might quote.
      metadata: { error: 'duplicate key value violates unique constraint: "4111111111111111"' },
    });
    const [row] = await db.select().from(appEvents);
    expect(JSON.stringify(row!.metadata)).not.toContain("4111111111111111");
  });

  /** `admin.backups` deliberately withholds `backups.path`; it would be odd to
   *  withhold it there and then leak it through an ENOENT message here. */
  it("redacts the uploads and backups directories out of an error message", async () => {
    const env = getEnv();
    await recordEvent(db, {
      level: "error",
      category: "backup",
      event: "backup.failed",
      metadata: { error: `ENOENT: no such file, open '${env.BACKUPS_DIR}/ledgerly-x.tgz'` },
    });
    const [row] = await db.select().from(appEvents);
    const stored = JSON.stringify(row!.metadata);
    expect(stored).not.toContain(env.BACKUPS_DIR);
    expect(stored).toContain("<backups>");
    // The useful part of the message survives — redaction, not deletion.
    expect(stored).toContain("ledgerly-x.tgz");
  });

  it("lets the caller's metadata win over the stamp", async () => {
    await recordEvent(db, {
      level: "info",
      category: "email",
      event: "email.sent",
      metadata: { toUserId: "u1", messageId: "m1" },
    });
    const [row] = await db.select().from(appEvents);
    expect(row!.metadata).toMatchObject({ toUserId: "u1", messageId: "m1" });
  });
});
