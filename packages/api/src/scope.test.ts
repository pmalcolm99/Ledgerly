import { drizzle } from "drizzle-orm/node-postgres";
import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCleanPool, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { projectMembers, projects, users } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { scopedProjects } from "./scope";
import type { ScopeLevel } from "./scope";

/**
 * The permission matrix in `docs/SCHEMA.md` §project_members, exercised
 * against a real Postgres.
 *
 * This suite exists because the task 3.12 review found `scopedProjects` —
 * the single authorization helper that `CLAUDE.md` makes a hard rule, and
 * that every Phase 4 query will compose onto — with no tests at all.
 *
 * It has to run against a live database rather than a fake: the level
 * comparison is `permission >= $level::member_permission`, which depends on
 * the *declaration order of a Postgres enum*. Nothing in TypeScript can
 * stand in for that, and `docs/SCHEMA.md` marks that ordering as
 * load-bearing and never-to-be-reordered.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const LEVELS: ScopeLevel[] = ["read", "add", "manage", "delete"];

const actors: Record<string, AuthUser> = {};
const projectIds: Record<string, string> = {};

async function mkUser(key: string, role: "owner" | "user"): Promise<AuthUser> {
  const [row] = await db
    .insert(users)
    .values({
      cfAccessSub: `sub-${key}`,
      email: `${key}@example.com`,
      firstName: "T",
      lastName: "User",
      onboardedAt: new Date(),
      role,
    })
    .returning();
  if (!row) throw new Error(`failed to create user ${key}`);
  return row;
}

/** The set of project keys `user` may act on at `level`, composed exactly
 * the way a real query would compose it. */
async function visible(user: AuthUser, level: ScopeLevel): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, scopedProjects(user, level)));
  return rows.map((r) => r.name).sort();
}

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });

  actors.instanceOwner = await mkUser("instance-owner", "owner");
  actors.projectOwner = await mkUser("project-owner", "user");
  actors.readMember = await mkUser("read-member", "user");
  actors.addMember = await mkUser("add-member", "user");
  actors.fullMember = await mkUser("full-member", "user");
  actors.stranger = await mkUser("stranger", "user");

  const owner = actors.projectOwner!;
  for (const [name, extra] of [
    ["live", {}],
    ["archived", { status: "archived" as const, archivedAt: new Date() }],
    ["deleted", { deletedAt: new Date() }],
  ] as const) {
    const [row] = await db
      .insert(projects)
      .values({ ownerId: owner.id, name, ...extra })
      .returning();
    projectIds[name] = row!.id;
  }

  // Memberships on every project, so "excluded" is never an artefact of a
  // missing row. The owner also gets a `full` row, per docs/SCHEMA.md.
  for (const name of ["live", "archived", "deleted"]) {
    for (const [key, permission] of [
      ["projectOwner", "full"],
      ["readMember", "read"],
      ["addMember", "read_add"],
      ["fullMember", "full"],
    ] as const) {
      await db.insert(projectMembers).values({
        projectId: projectIds[name]!,
        userId: actors[key]!.id,
        permission,
      });
    }
  }
});

afterAll(async () => {
  await getCleanPool().end();
});

describe("scopedProjects — soft deletes", () => {
  it("never returns a soft-deleted project, at any level, for anyone", async () => {
    for (const level of LEVELS) {
      for (const [key, user] of Object.entries(actors)) {
        expect(await visible(user, level), `${key} @ ${level}`).not.toContain("deleted");
      }
    }
  });
});

describe("scopedProjects — instance owner short-circuit", () => {
  it("sees every live project at every level, without any membership row", async () => {
    // The instance owner has no project_members rows at all.
    for (const level of LEVELS) {
      const seen = await visible(actors.instanceOwner!, level);
      // `add` excludes archived even for the instance owner: archived means
      // read-only, and that is a property of the project, not the actor.
      const expected = level === "add" ? ["live"] : ["archived", "live"];
      expect(seen, `instance owner @ ${level}`).toEqual(expected);
    }
  });
});

describe("scopedProjects — the permission matrix", () => {
  it("read: every member and the project owner can see live and archived", async () => {
    for (const key of ["projectOwner", "readMember", "addMember", "fullMember"]) {
      expect(await visible(actors[key]!, "read"), key).toEqual(["archived", "live"]);
    }
  });

  it("add: requires read_add, and excludes archived (read-only) projects", async () => {
    expect(await visible(actors.readMember!, "add")).toEqual([]);
    expect(await visible(actors.addMember!, "add")).toEqual(["live"]);
    expect(await visible(actors.fullMember!, "add")).toEqual(["live"]);
    expect(await visible(actors.projectOwner!, "add")).toEqual(["live"]);
  });

  it("manage: requires full; read and read_add cannot manage members", async () => {
    expect(await visible(actors.readMember!, "manage")).toEqual([]);
    expect(await visible(actors.addMember!, "manage")).toEqual([]);
    expect(await visible(actors.fullMember!, "manage")).toEqual(["archived", "live"]);
  });

  it("delete: the project owner only — `full` is not enough", async () => {
    // docs/SCHEMA.md's matrix: delete authority comes from projects.owner_id,
    // and is not grantable through project_members at any level.
    expect(await visible(actors.fullMember!, "delete")).toEqual([]);
    expect(await visible(actors.addMember!, "delete")).toEqual([]);
    expect(await visible(actors.readMember!, "delete")).toEqual([]);
    expect(await visible(actors.projectOwner!, "delete")).toEqual(["archived", "live"]);
  });

  it("a non-member sees nothing at any level", async () => {
    for (const level of LEVELS) {
      expect(await visible(actors.stranger!, level), `stranger @ ${level}`).toEqual([]);
    }
  });
});

describe("scopedProjects — enum ordering is load-bearing", () => {
  it("orders read < read_add < full in the database, not just in TypeScript", async () => {
    const { rows } = await getCleanPool().query<{ ok: boolean }>(
      "select 'read'::member_permission < 'read_add'::member_permission " +
        "and 'read_add'::member_permission < 'full'::member_permission as ok",
    );
    // If this ever fails, someone reordered the enum and every `>=` level
    // comparison in scopedProjects silently means something else.
    expect(rows[0]?.ok).toBe(true);
  });
});
