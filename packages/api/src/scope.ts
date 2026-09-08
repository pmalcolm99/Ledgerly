import "server-only";

import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { projectMembers, projects } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

/**
 * packages/api/src/scope.ts — THE authorization helper (contract §9.1,
 * ARCHITECTURE.md §4.3, docs/SCHEMA.md §project_members).
 *
 * Pulled forward from Phase 4 task 4.1 because the procedure ladder is
 * incomplete without the thing it deliberately does not do.
 *
 * Every project-scoped query composes with this. No route handler performs
 * its own permission check — `CLAUDE.md` makes that a hard rule, because a
 * check in a handler is a check that can be forgotten, whereas a scope
 * composed into the query is one that cannot.
 *
 * There is deliberately no `requirePermission('full', projectId)`
 * middleware. A route-level project permission check would be a second
 * source of truth, and drift between two authorization mechanisms is worse
 * than either alone.
 */

/**
 * `read`   — see the project.
 * `add`    — add receipts to it.
 * `manage` — manage its members.
 * `delete` — delete it. Not grantable via `project_members`; the project
 *            owner and the instance owner hold it, and nobody else.
 */
export type ScopeLevel = "read" | "add" | "manage" | "delete";

/**
 * The `member_permission` floor each level requires. Postgres enums compare
 * by declaration order, and `docs/SCHEMA.md` marks that order (read <
 * read_add < full) as load-bearing and never-reordered — this comparison is
 * what depends on it.
 */
const PERMISSION_FLOOR = {
  read: "read",
  add: "read_add",
  manage: "full",
} as const;

/**
 * Archived projects are read-only (`docs/SCHEMA.md` §projects), so `add` is
 * excluded. `manage` and `delete` still include them: an archived project
 * must remain un-archivable and deletable, and routing that through a
 * separate bypass would be exactly the scattered check CLAUDE.md forbids.
 */
function excludesArchived(level: ScopeLevel): boolean {
  return level === "add";
}

/**
 * Returns a composable subquery of project ids the user may act on at
 * `level`. Always a subquery landing in a WHERE clause — never a list of
 * ids fetched and then filtered in JS, which would defeat the point.
 */
export function scopedProjects(user: AuthUser, level: ScopeLevel = "read"): SQL {
  const liveness: SQL[] = [isNull(projects.deletedAt)];
  if (excludesArchived(level)) liveness.push(eq(projects.status, "active"));

  // The instance owner short-circuits to every live project, at every level.
  if (user.role === "owner") {
    return sql`(select ${projects.id} from ${projects} where ${and(...liveness)})`;
  }

  // The project owner always qualifies, at every level including `delete`.
  const ownerBranch = eq(projects.ownerId, user.id);

  if (level === "delete") {
    return sql`(select ${projects.id} from ${projects} where ${and(ownerBranch, ...liveness)})`;
  }

  const floor = PERMISSION_FLOOR[level];
  const membershipBranch = inArray(
    projects.id,
    sql`(select ${projectMembers.projectId} from ${projectMembers}
         where ${and(
           eq(projectMembers.userId, user.id),
           gte(projectMembers.permission, sql`${floor}::member_permission`),
         )})`,
  );

  return sql`(select ${projects.id} from ${projects}
              where ${and(or(ownerBranch, membershipBranch), ...liveness)})`;
}
