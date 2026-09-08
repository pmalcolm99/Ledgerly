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
import { auditLog, projectMembers } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/members.test.ts — task 4.3 acceptance:
 * add/updatePermission/remove correctness, the escalation guards
 * (self-target, owner-row protection), and audit rows. The full
 * permission-matrix suite lives in `permissions.test.ts`.
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

async function membershipOf(projectId: string, userId: string) {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return row;
}

describe("members.add", () => {
  it("grants a new read member and writes member.permission_granted", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner1",
      members: [],
    });
    const target = await mkTestUser(db, "target1");
    const caller = appRouter.createCaller(ctxFor(u.owner1!));

    await caller.members.add({ projectId: project.id, userId: target.id, permission: "read" });

    expect((await membershipOf(project.id, target.id))?.permission).toBe("read");
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, project.id), eq(auditLog.action, "member.permission_granted")),
      );
    expect(rows).toHaveLength(1);
  });

  it("lets a full member grant within/at their own level", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner2",
      members: [{ key: "fuller2", permission: "full" }],
    });
    const target = await mkTestUser(db, "target2");
    const caller = appRouter.createCaller(ctxFor(u.fuller2!));

    await caller.members.add({ projectId: project.id, userId: target.id, permission: "full" });

    expect((await membershipOf(project.id, target.id))?.permission).toBe("full");
  });

  it("fails NOT_FOUND when a read or read_add member attempts to manage members", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner3",
      members: [
        { key: "reader3", permission: "read" },
        { key: "adder3", permission: "read_add" },
      ],
    });
    const target = await mkTestUser(db, "target3");

    const readerCaller = appRouter.createCaller(ctxFor(u.reader3!));
    await expect(
      readerCaller.members.add({ projectId: project.id, userId: target.id, permission: "read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const adderCaller = appRouter.createCaller(ctxFor(u.adder3!));
    await expect(
      adderCaller.members.add({ projectId: project.id, userId: target.id, permission: "read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails FORBIDDEN when targeting the project owner", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner4",
      members: [],
    });
    const caller = appRouter.createCaller(ctxFor(u.owner4!));

    await expect(
      caller.members.add({ projectId: project.id, userId: u.owner4!.id, permission: "read" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails CONFLICT when the target is already a member", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner5",
      members: [{ key: "existing5", permission: "read" }],
    });
    const caller = appRouter.createCaller(ctxFor(u.owner5!));

    await expect(
      caller.members.add({ projectId: project.id, userId: u.existing5!.id, permission: "full" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("fails NOT_FOUND (not a raw 500) when the target userId does not exist (task 4.8 finding M-3)", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner-m3",
      members: [],
    });
    const caller = appRouter.createCaller(ctxFor(u["owner-m3"]!));

    await expect(
      caller.members.add({ projectId: project.id, userId: randomUUID(), permission: "read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("members.list", () => {
  it("lists every member for a project the caller can view (task 4.8 finding M-6)", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner-m6",
      members: [
        { key: "reader-m6", permission: "read" },
        { key: "fuller-m6", permission: "full" },
      ],
    });
    const caller = appRouter.createCaller(ctxFor(u["reader-m6"]!));

    const rows = await caller.members.list({ projectId: project.id });
    const userIds = rows.map((r) => r.userId);
    expect(userIds).toEqual(
      expect.arrayContaining([u["owner-m6"]!.id, u["reader-m6"]!.id, u["fuller-m6"]!.id]),
    );
  });

  it("fails NOT_FOUND for a non-member — member visibility is not an existence oracle", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner-m6b",
      members: [],
    });
    const stranger = await mkTestUser(db, "stranger-m6");
    const caller = appRouter.createCaller(ctxFor(stranger));

    await expect(caller.members.list({ projectId: project.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("members.updatePermission", () => {
  it("raises a read member to full and writes member.permission_changed with from/to", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner6",
      members: [{ key: "reader6", permission: "read" }],
    });
    const caller = appRouter.createCaller(ctxFor(u.owner6!));

    await caller.members.updatePermission({
      projectId: project.id,
      userId: u.reader6!.id,
      permission: "full",
    });

    expect((await membershipOf(project.id, u.reader6!.id))?.permission).toBe("full");
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, project.id), eq(auditLog.action, "member.permission_changed")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ from: "read", to: "full" });
  });

  it("fails FORBIDDEN on self-targeting, whether caller is a full member or the project owner", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner7",
      members: [{ key: "fuller7", permission: "full" }],
    });

    const fullCaller = appRouter.createCaller(ctxFor(u.fuller7!));
    await expect(
      fullCaller.members.updatePermission({
        projectId: project.id,
        userId: u.fuller7!.id,
        permission: "read",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ownerCaller = appRouter.createCaller(ctxFor(u.owner7!));
    await expect(
      ownerCaller.members.updatePermission({
        projectId: project.id,
        userId: u.owner7!.id,
        permission: "read",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails FORBIDDEN targeting the project owner's row, even for the instance owner", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner8",
      members: [],
    });
    const instanceOwner = await mkTestUser(db, "iowner8", "owner");

    const ownerCaller = appRouter.createCaller(ctxFor(instanceOwner));
    await expect(
      ownerCaller.members.updatePermission({
        projectId: project.id,
        userId: u.owner8!.id,
        permission: "read",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("members.remove", () => {
  it("removes a full member and writes member.removed", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner9",
      members: [{ key: "fuller9", permission: "full" }],
    });
    const caller = appRouter.createCaller(ctxFor(u.owner9!));

    await caller.members.remove({ projectId: project.id, userId: u.fuller9!.id });

    expect(await membershipOf(project.id, u.fuller9!.id)).toBeUndefined();
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, project.id), eq(auditLog.action, "member.removed")));
    expect(rows).toHaveLength(1);
  });

  it("fails FORBIDDEN targeting the project owner's row, even for the instance owner", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner10",
      members: [],
    });
    const instanceOwner = await mkTestUser(db, "iowner10", "owner");
    const caller = appRouter.createCaller(ctxFor(instanceOwner));

    await expect(
      caller.members.remove({ projectId: project.id, userId: u.owner10!.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("succeeds for the instance owner on a project they don't own, and audits the override", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner11",
      members: [{ key: "fuller11", permission: "full" }],
    });
    const instanceOwner = await mkTestUser(db, "iowner11", "owner");
    const caller = appRouter.createCaller(ctxFor(instanceOwner));

    await caller.members.remove({ projectId: project.id, userId: u.fuller11!.id });

    const overrideRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, project.id), eq(auditLog.action, "owner_override.performed")),
      );
    expect(overrideRows).toHaveLength(1);
  });

  it("immediately revokes access — the removed user gets NOT_FOUND from get and is absent from list", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "owner12",
      members: [{ key: "fuller12", permission: "full" }],
    });
    const ownerCaller = appRouter.createCaller(ctxFor(u.owner12!));
    const removedCaller = appRouter.createCaller(ctxFor(u.fuller12!));

    // Confirm access before removal.
    await expect(removedCaller.projects.get({ id: project.id })).resolves.toMatchObject({
      id: project.id,
    });

    await ownerCaller.members.remove({ projectId: project.id, userId: u.fuller12!.id });

    await expect(removedCaller.projects.get({ id: project.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const listIds = (await removedCaller.projects.list()).map((r) => r.id);
    expect(listIds).not.toContain(project.id);
  });
});

describe("H-1 regression — the lock+scope race", () => {
  /**
   * Task 4.8 review finding H-1: composing `scopedProjects` into the SAME
   * statement as a `FOR UPDATE` lock is unsafe under Postgres's
   * EvalPlanQual, because the membership subquery is commonly planned as
   * an InitPlan — evaluated once, before the lock wait, never re-run when
   * a blocked lock wakes up. A member whose access is revoked by the
   * transaction they were blocked on could still land a write judged
   * against their pre-revocation membership.
   *
   * This test holds a revoking transaction open on a SEPARATE real
   * connection (checked out directly from the pool, not through a
   * `ctx.db.transaction()` — that would release its connection back to
   * the pool before we want it to), races a real `members.add` call
   * against it, and only then lets the revocation commit. `scope.ts`'s
   * `lockScopedProject` fix (lock the bare row, then re-check
   * `scopedProjects` as a second, independent statement) is what makes the
   * raced call see the revocation instead of stale data.
   */
  it("a member being concurrently revoked cannot land a privileged write in the race window", async () => {
    const { project, users: u } = await createTestProjectWithMembers(db, {
      ownerKey: "raceOwner",
      members: [{ key: "raceVictim", permission: "full" }],
    });
    const accomplice = await mkTestUser(db, "raceAccomplice");

    // Connection A: the owner's revocation, held open mid-transaction so
    // the test controls exactly when it commits relative to B below.
    const clientA = await getCleanPool().connect();
    try {
      await clientA.query("BEGIN");
      await clientA.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [project.id]);
      await clientA.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [
        project.id,
        u.raceVictim!.id,
      ]);

      // Connection B: the about-to-be-revoked member's own request,
      // racing in through the real router. It blocks on A's row lock.
      const victimCaller = appRouter.createCaller(ctxFor(u.raceVictim!));
      const racedCall = victimCaller.members.add({
        projectId: project.id,
        userId: accomplice.id,
        permission: "read",
      });

      // Give B's query time to actually reach Postgres and start waiting
      // on A's lock before A wins the race by committing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await clientA.query("COMMIT");

      await expect(racedCall).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      clientA.release();
    }

    const accompliceRows = await db
      .select()
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, accomplice.id)),
      );
    expect(accompliceRows).toHaveLength(0);
  });
});
