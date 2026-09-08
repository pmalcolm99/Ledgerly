import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { auditLog, projects, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import { scopedProjects } from "../scope";
import type { Context } from "../trpc";

/**
 * packages/api/src/routers/permissions.test.ts — task 4.4's dedicated
 * acceptance artifact: the full permission matrix from the phase brief,
 *
 *                  view  add-receipt  edit-receipt  manage-members  delete-project
 *   read            Y         N             N              N               N
 *   read_add        Y         Y          own only          N               N
 *   full            Y         Y             Y              Y               N
 *   project owner   Y         Y             Y              Y               Y
 *   instance owner  Y         Y             Y              Y               Y
 *
 * Receipts don't exist as a feature until Phase 5 — only the `receipts`
 * table schema exists today. The add-receipt/edit-receipt columns are
 * therefore tested directly against `scopedProjects(user, "add")` (the
 * same style `scope.test.ts` uses), not through a receipts router, per the
 * plan's resolved ambiguity. view/manage-members/delete-project go through
 * real `projects`/`members` router calls.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

type Actors = {
  read: AuthUser;
  readAdd: AuthUser;
  full: AuthUser;
  projectOwner: AuthUser;
  instanceOwner: AuthUser;
  stranger: AuthUser;
};

let actors: Actors;
let projectId: string;

const ctxFor = (user: AuthUser | null): Context => ({ db, user });

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });

  const { project, users: u } = await createTestProjectWithMembers(db, {
    ownerKey: "projectOwner",
    members: [
      { key: "readMember", permission: "read" },
      { key: "addMember", permission: "read_add" },
      { key: "fullMember", permission: "full" },
    ],
  });
  projectId = project.id;

  actors = {
    read: u.readMember!,
    readAdd: u.addMember!,
    full: u.fullMember!,
    projectOwner: u.projectOwner!,
    instanceOwner: await mkTestUser(db, "instanceOwner", "owner"),
    stranger: await mkTestUser(db, "stranger"),
  };
});

afterAll(async () => {
  await getCleanPool().end();
});

async function canAddScope(user: AuthUser): Promise<boolean> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), inArray(projects.id, scopedProjects(user, "add"))));
  return rows.length === 1;
}

describe("view", () => {
  it.each([
    ["read", () => actors.read],
    ["read_add", () => actors.readAdd],
    ["full", () => actors.full],
    ["project owner", () => actors.projectOwner],
    ["instance owner", () => actors.instanceOwner],
  ] as const)("%s can view the project", async (_label, getActor) => {
    const caller = appRouter.createCaller(ctxFor(getActor()));
    await expect(caller.projects.get({ id: projectId })).resolves.toMatchObject({ id: projectId });
  });

  it("a non-member (stranger) gets NOT_FOUND, not FORBIDDEN — no existence oracle", async () => {
    const caller = appRouter.createCaller(ctxFor(actors.stranger));
    await expect(caller.projects.get({ id: projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe('add-receipt (scopedProjects(user, "add"))', () => {
  it("read cannot add", async () => {
    expect(await canAddScope(actors.read)).toBe(false);
  });

  it.each([
    ["read_add", () => actors.readAdd],
    ["full", () => actors.full],
    ["project owner", () => actors.projectOwner],
    ["instance owner", () => actors.instanceOwner],
  ] as const)("%s can add", async (_label, getActor) => {
    expect(await canAddScope(getActor())).toBe(true);
  });
});

describe("edit-receipt (own only)", () => {
  it("the uploader sees their own receipt through the add-scope + uploaded_by composition", async () => {
    const [receipt] = await db
      .insert(receipts)
      .values({ projectId, uploadedBy: actors.full.id })
      .returning();

    const ownRows = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          inArray(receipts.projectId, scopedProjects(actors.full, "add")),
          eq(receipts.uploadedBy, actors.full.id),
        ),
      );
    expect(ownRows.map((r) => r.id)).toContain(receipt!.id);
  });

  it("a different member with add-scope does not see someone else's receipt under the own-only composition", async () => {
    const [receipt] = await db
      .insert(receipts)
      .values({ projectId, uploadedBy: actors.full.id })
      .returning();

    const otherRows = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          inArray(receipts.projectId, scopedProjects(actors.readAdd, "add")),
          eq(receipts.uploadedBy, actors.readAdd.id),
        ),
      );
    expect(otherRows.map((r) => r.id)).not.toContain(receipt!.id);
  });

  it("a read-only member has no add-scope at all, so the composition returns nothing regardless of uploader", async () => {
    const rows = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          inArray(receipts.projectId, scopedProjects(actors.read, "add")),
          eq(receipts.uploadedBy, actors.read.id),
        ),
      );
    expect(rows).toHaveLength(0);
  });
});

describe("manage-members", () => {
  it.each([
    ["full", () => actors.full],
    ["project owner", () => actors.projectOwner],
    ["instance owner", () => actors.instanceOwner],
  ] as const)("%s can add a member", async (_label, getActor) => {
    const target = await mkTestUser(db, `target-${_label.replace(/\s/g, "")}`);
    const caller = appRouter.createCaller(ctxFor(getActor()));
    await expect(
      caller.members.add({ projectId, userId: target.id, permission: "read" }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["read", () => actors.read],
    ["read_add", () => actors.readAdd],
  ] as const)("%s cannot manage members (NOT_FOUND)", async (_label, getActor) => {
    const target = await mkTestUser(db, `target-neg-${_label}`);
    const caller = appRouter.createCaller(ctxFor(getActor()));
    await expect(
      caller.members.add({ projectId, userId: target.id, permission: "read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("delete-project", () => {
  it.each([
    ["project owner", () => actors.projectOwner],
    ["instance owner", () => actors.instanceOwner],
  ] as const)("%s can delete the project", async (_label, getActor) => {
    const caller = appRouter.createCaller(ctxFor(getActor()));
    await expect(caller.projects.delete({ id: projectId })).resolves.toMatchObject({
      id: projectId,
    });
  });

  it.each([
    ["read", () => actors.read],
    ["read_add", () => actors.readAdd],
    ["full", () => actors.full],
  ] as const)("%s cannot delete the project (NOT_FOUND)", async (_label, getActor) => {
    const caller = appRouter.createCaller(ctxFor(getActor()));
    await expect(caller.projects.delete({ id: projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("cross-cutting", () => {
  it("the instance owner can act on every column of a project they do not own", async () => {
    const caller = appRouter.createCaller(ctxFor(actors.instanceOwner));

    await expect(caller.projects.get({ id: projectId })).resolves.toMatchObject({ id: projectId });
    expect(await canAddScope(actors.instanceOwner)).toBe(true);
    const target = await mkTestUser(db, "cross-cutting-target");
    await expect(
      caller.members.add({ projectId, userId: target.id, permission: "read" }),
    ).resolves.toBeDefined();
    await expect(caller.projects.delete({ id: projectId })).resolves.toMatchObject({
      id: projectId,
    });
  });

  it("a user cannot escalate their own permission (members.updatePermission self-target)", async () => {
    const caller = appRouter.createCaller(ctxFor(actors.full));
    await expect(
      caller.members.updatePermission({ projectId, userId: actors.full.id, permission: "full" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the project owner's row can never be removed, even by the instance owner", async () => {
    const caller = appRouter.createCaller(ctxFor(actors.instanceOwner));
    await expect(
      caller.members.remove({ projectId, userId: actors.projectOwner.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("removing a member immediately revokes their view access", async () => {
    const ownerCaller = appRouter.createCaller(ctxFor(actors.projectOwner));
    const removedCaller = appRouter.createCaller(ctxFor(actors.full));

    await expect(removedCaller.projects.get({ id: projectId })).resolves.toMatchObject({
      id: projectId,
    });
    await ownerCaller.members.remove({ projectId, userId: actors.full.id });
    await expect(removedCaller.projects.get({ id: projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("owner_override.performed carries the right underlyingAction for archive, delete, grant, and remove", async () => {
    const caller = appRouter.createCaller(ctxFor(actors.instanceOwner));

    await caller.projects.archive({ id: projectId });
    const target = await mkTestUser(db, "override-target");
    await caller.members.add({ projectId, userId: target.id, permission: "read" });
    await caller.members.remove({ projectId, userId: target.id });
    await caller.projects.delete({ id: projectId });

    const overrides = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, projectId), eq(auditLog.action, "owner_override.performed")),
      );

    const underlyingActions = overrides.map(
      (row) => (row.metadata as { underlyingAction?: string }).underlyingAction,
    );
    expect(underlyingActions).toEqual(
      expect.arrayContaining([
        "project.archived",
        "member.permission_granted",
        "member.removed",
        "project.deleted",
      ]),
    );
  });
});
