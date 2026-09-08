import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { auditLog, projectMembers, projects } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/projects.test.ts — task 4.2, 4.5 acceptance.
 * CRUD correctness, D-22 soft-delete re-creation, 404-not-403 on `get`,
 * the transactional owner-membership invariant, and audit rows for
 * create/archive/unarchive/delete. The full permission-matrix suite lives
 * in `permissions.test.ts`; this file exercises the router mechanics.
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

describe("projects.create", () => {
  it("inserts a project and the owner's project_members row (full), in one transaction", async () => {
    const owner = await mkTestUser(db, "owner1");
    const caller = appRouter.createCaller(ctxFor(owner));

    const project = await caller.projects.create({ name: "Kitchen Remodel" });

    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, owner.id)));
    expect(membership?.permission).toBe("full");
  });

  it("throws CONFLICT on a duplicate live name for the same owner", async () => {
    const owner = await mkTestUser(db, "owner2");
    const caller = appRouter.createCaller(ctxFor(owner));

    await caller.projects.create({ name: "Deck" });
    await expect(caller.projects.create({ name: "Deck" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("succeeds reusing a soft-deleted project's name, same owner (D-22)", async () => {
    const owner = await mkTestUser(db, "owner3");
    const caller = appRouter.createCaller(ctxFor(owner));

    const first = await caller.projects.create({ name: "Fence" });
    await caller.projects.delete({ id: first.id });
    const second = await caller.projects.create({ name: "Fence" });

    expect(second.id).not.toBe(first.id);
  });

  it("rejects a blank name via zod before the DB CHECK ever runs", async () => {
    const owner = await mkTestUser(db, "owner4");
    const caller = appRouter.createCaller(ctxFor(owner));

    await expect(caller.projects.create({ name: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects an endDate before startDate", async () => {
    const owner = await mkTestUser(db, "owner5");
    const caller = appRouter.createCaller(ctxFor(owner));

    await expect(
      caller.projects.create({ name: "Bad Dates", startDate: "2026-06-01", endDate: "2026-01-01" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("projects.get — 404, not 403", () => {
  it("returns NOT_FOUND for a nonexistent id", async () => {
    const owner = await mkTestUser(db, "owner6");
    const caller = appRouter.createCaller(ctxFor(owner));

    await expect(caller.projects.get({ id: randomUUID() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns NOT_FOUND (not FORBIDDEN) for a project the caller cannot see", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner7", members: [] });
    const stranger = await mkTestUser(db, "stranger7");
    const caller = appRouter.createCaller(ctxFor(stranger));

    await expect(caller.projects.get({ id: project.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns the row for a visible project", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner8",
      members: [{ key: "reader8", permission: "read" }],
    });
    const caller = appRouter.createCaller(ctxFor(users.reader8!));

    const row = await caller.projects.get({ id: project.id });
    expect(row.id).toBe(project.id);
  });
});

describe("projects.list", () => {
  it("returns every live project across all owners for the instance owner", async () => {
    const instanceOwner = await mkTestUser(db, "iowner9", "owner");
    const { project: p1 } = await createTestProjectWithMembers(db, {
      ownerKey: "owner9a",
      members: [],
    });
    const { project: p2 } = await createTestProjectWithMembers(db, {
      ownerKey: "owner9b",
      members: [],
    });
    const caller = appRouter.createCaller(ctxFor(instanceOwner));

    const rows = await caller.projects.list();
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([p1.id, p2.id]));
  });

  it("returns only owned + member projects for a normal user", async () => {
    const { project: mine, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner10",
      members: [{ key: "member10", permission: "read" }],
    });
    const { project: other } = await createTestProjectWithMembers(db, {
      ownerKey: "owner10b",
      members: [],
    });
    const caller = appRouter.createCaller(ctxFor(u.member10!));

    const ids = (await caller.projects.list()).map((r) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
  });

  it("filters by status while still respecting scope", async () => {
    const owner = await mkTestUser(db, "owner11");
    const caller = appRouter.createCaller(ctxFor(owner));
    const active = await caller.projects.create({ name: "Active One" });
    const toArchive = await caller.projects.create({ name: "Archive Me" });
    await caller.projects.archive({ id: toArchive.id });

    const archivedIds = (await caller.projects.list({ status: "archived" })).map((r) => r.id);
    expect(archivedIds).toEqual([toArchive.id]);
    expect(archivedIds).not.toContain(active.id);
  });
});

describe("projects.update", () => {
  it("succeeds for a full member; fails NOT_FOUND for read/read_add members", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner12",
      members: [
        { key: "reader12", permission: "read" },
        { key: "adder12", permission: "read_add" },
        { key: "fuller12", permission: "full" },
      ],
    });

    const fullCaller = appRouter.createCaller(ctxFor(u.fuller12!));
    const updated = await fullCaller.projects.update({ id: project.id, name: "Renamed" });
    expect(updated.name).toBe("Renamed");

    const readerCaller = appRouter.createCaller(ctxFor(u.reader12!));
    await expect(
      readerCaller.projects.update({ id: project.id, name: "Nope" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const adderCaller = appRouter.createCaller(ctxFor(u.adder12!));
    await expect(
      adderCaller.projects.update({ id: project.id, name: "Nope" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws CONFLICT when renaming to a live duplicate", async () => {
    const owner = await mkTestUser(db, "owner13");
    const caller = appRouter.createCaller(ctxFor(owner));
    await caller.projects.create({ name: "Alpha" });
    const beta = await caller.projects.create({ name: "Beta" });

    await expect(caller.projects.update({ id: beta.id, name: "Alpha" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects a partial date patch that would violate the row's existing other date (task 4.8 finding M-2)", async () => {
    const owner = await mkTestUser(db, "owner-m2");
    const caller = appRouter.createCaller(ctxFor(owner));
    const project = await caller.projects.create({
      name: "Partial Date Edit",
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    });

    // Moving startDate past the EXISTING endDate, touching only one field —
    // the zod refine can't catch this since endDate isn't in this call.
    await expect(
      caller.projects.update({ id: project.id, startDate: "2026-06-01" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is FORBIDDEN on an archived project — archived is read-only (task 4.8 finding M-4)", async () => {
    const owner = await mkTestUser(db, "owner-m4");
    const caller = appRouter.createCaller(ctxFor(owner));
    const project = await caller.projects.create({ name: "Archived Edit Attempt" });
    await caller.projects.archive({ id: project.id });

    await expect(
      caller.projects.update({ id: project.id, name: "Should Not Land" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("audits owner_override.performed when the instance owner edits a project they don't own (task 4.8 finding M-5)", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner-m5",
      members: [],
    });
    const instanceOwner = await mkTestUser(db, "iowner-m5", "owner");
    const caller = appRouter.createCaller(ctxFor(instanceOwner));

    await caller.projects.update({ id: project.id, name: "Renamed By Owner" });

    const overrideRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, project.id), eq(auditLog.action, "owner_override.performed")),
      );
    expect(overrideRows).toHaveLength(1);
    expect(overrideRows[0]?.metadata).toMatchObject({ underlyingAction: "project.updated" });

    // The underlyingAction label names a row that actually exists in the
    // log, not a phantom action visible only in metadata.
    const updatedRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, project.id), eq(auditLog.action, "project.updated")));
    expect(updatedRows).toHaveLength(1);
  });

  it("writes no audit row at all for an ordinary edit by the project's own owner", async () => {
    const owner = await mkTestUser(db, "owner-m5b");
    const caller = appRouter.createCaller(ctxFor(owner));
    const project = await caller.projects.create({ name: "Ordinary Edit" });

    await caller.projects.update({ id: project.id, name: "Ordinary Edit, Renamed" });

    const updatedRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, project.id), eq(auditLog.action, "project.updated")));
    expect(updatedRows).toHaveLength(0);
  });
});

describe("projects.archive / unarchive", () => {
  it("sets status and archivedAt, and writes a project.archived audit row", async () => {
    const owner = await mkTestUser(db, "owner14");
    const caller = appRouter.createCaller(ctxFor(owner));
    const project = await caller.projects.create({ name: "To Archive" });

    const archived = await caller.projects.archive({ id: project.id });
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "project"),
          eq(auditLog.entityId, project.id),
          eq(auditLog.action, "project.archived"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("also writes owner_override.performed when the instance owner archives a project they don't own", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner15",
      members: [],
    });
    const instanceOwner = await mkTestUser(db, "iowner15", "owner");
    const caller = appRouter.createCaller(ctxFor(instanceOwner));

    await caller.projects.archive({ id: project.id });

    const overrideRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, project.id), eq(auditLog.action, "owner_override.performed")),
      );
    expect(overrideRows).toHaveLength(1);
  });

  it("unarchive reverses archive and writes project.unarchived", async () => {
    const owner = await mkTestUser(db, "owner16");
    const caller = appRouter.createCaller(ctxFor(owner));
    const project = await caller.projects.create({ name: "Round Trip" });
    await caller.projects.archive({ id: project.id });

    const restored = await caller.projects.unarchive({ id: project.id });
    expect(restored.status).toBe("active");
    expect(restored.archivedAt).toBeNull();

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, project.id), eq(auditLog.action, "project.unarchived")));
    expect(rows).toHaveLength(1);
  });

  it("is idempotent — archiving twice does not duplicate the audit row or bump archivedAt (task 4.8 finding L-2)", async () => {
    const owner = await mkTestUser(db, "owner-l2");
    const caller = appRouter.createCaller(ctxFor(owner));
    const project = await caller.projects.create({ name: "Archive Twice" });

    const first = await caller.projects.archive({ id: project.id });
    const second = await caller.projects.archive({ id: project.id });
    expect(second.archivedAt).toEqual(first.archivedAt);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, project.id), eq(auditLog.action, "project.archived")));
    expect(rows).toHaveLength(1);
  });
});

describe("projects.delete", () => {
  it("soft-deletes (sets deletedAt) and writes project.deleted", async () => {
    const owner = await mkTestUser(db, "owner17");
    const caller = appRouter.createCaller(ctxFor(owner));
    const project = await caller.projects.create({ name: "Doomed" });

    await caller.projects.delete({ id: project.id });

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row?.deletedAt).not.toBeNull();

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, project.id), eq(auditLog.action, "project.deleted")));
    expect(auditRows).toHaveLength(1);
  });

  it("fails NOT_FOUND for a full member (not the owner) — full is not enough to delete", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner18",
      members: [{ key: "fuller18", permission: "full" }],
    });
    const caller = appRouter.createCaller(ctxFor(u.fuller18!));

    await expect(caller.projects.delete({ id: project.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("succeeds for the instance owner on a project they don't own, and audits both events", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner19",
      members: [],
    });
    const instanceOwner = await mkTestUser(db, "iowner19", "owner");
    const caller = appRouter.createCaller(ctxFor(instanceOwner));

    await caller.projects.delete({ id: project.id });

    const deletedRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, project.id), eq(auditLog.action, "project.deleted")));
    const overrideRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, project.id), eq(auditLog.action, "owner_override.performed")),
      );
    expect(deletedRows).toHaveLength(1);
    expect(overrideRows).toHaveLength(1);
  });

  it("makes the project invisible to every previously-authorized caller, including the former owner", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner20",
      members: [{ key: "fuller20", permission: "full" }],
    });
    const ownerCaller = appRouter.createCaller(ctxFor(u.owner20!));

    await ownerCaller.projects.delete({ id: project.id });

    await expect(ownerCaller.projects.get({ id: project.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const fullCaller = appRouter.createCaller(ctxFor(u.fuller20!));
    await expect(fullCaller.projects.get({ id: project.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const listIds = (await ownerCaller.projects.list()).map((r) => r.id);
    expect(listIds).not.toContain(project.id);
  });
});

describe("H-1 regression — the lock+scope race, isolated on a write with no secondary check", () => {
  /**
   * Task 4.8 review finding H-1. `archive` (unlike `members.add`) has no
   * secondary statement downstream of `lockScopedProject` that could
   * incidentally catch a stale authorization decision — it locks, checks,
   * and writes. That makes it the cleanest place to prove
   * `lockScopedProject`'s fix in isolation, unclouded by any other guard.
   * See `members.test.ts`'s "H-1 regression" describe block for the
   * equivalent test through `members.add`, and `scope.ts`'s
   * `lockScopedProject` docblock for the full mechanism.
   */
  it("a member being concurrently revoked cannot archive the project in the race window", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "raceOwner2",
      members: [{ key: "raceVictim2", permission: "full" }],
    });

    const clientA = await getCleanPool().connect();
    try {
      await clientA.query("BEGIN");
      await clientA.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [project.id]);
      await clientA.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [
        project.id,
        u.raceVictim2!.id,
      ]);

      const victimCaller = appRouter.createCaller(ctxFor(u.raceVictim2!));
      const racedCall = victimCaller.projects.archive({ id: project.id });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await clientA.query("COMMIT");

      await expect(racedCall).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      clientA.release();
    }

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row?.status).toBe("active");
  });

  /**
   * Task 4.8 follow-up review: the H-1 fix's first draft locked the bare
   * row with no scope predicate at all, so an unauthorized caller queued
   * on whatever transaction was holding the lock before ever being told
   * "no". That's an existence oracle (unauthorized `NOT_FOUND` takes as
   * long as the contending writer's transaction) and a connection-pool
   * amplification vector. `lockScopedProject`'s unlocked pre-check fixes
   * this — an unauthorized caller is rejected before taking any lock.
   */
  it("a stranger with no access is rejected quickly, without queuing on another transaction's lock", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "raceOwner3",
      members: [],
    });
    const stranger = await mkTestUser(db, "raceStranger3");

    const clientA = await getCleanPool().connect();
    try {
      await clientA.query("BEGIN");
      await clientA.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [project.id]);

      const strangerCaller = appRouter.createCaller(ctxFor(stranger));
      const startedAt = Date.now();
      await expect(strangerCaller.projects.archive({ id: project.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const elapsedMs = Date.now() - startedAt;

      // Generous margin: the point isn't a tight latency budget, it's that
      // the call did NOT block for anywhere near the lock hold below.
      expect(elapsedMs).toBeLessThan(500);

      await clientA.query("COMMIT");
    } finally {
      clientA.release();
    }
  });
});
