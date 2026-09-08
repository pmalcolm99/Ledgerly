import "server-only";

import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { projectMembers, projects } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import type { Tx } from "./audit";

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
 * The subquery `scopedProjects` returns, branded so a future call site
 * cannot pass it somewhere that isn't `inArray(projects.id, ...)` and have
 * that type-check — it would previously fail only at runtime, via a
 * Postgres error, once Phase 4 gave this a dozen call sites (docs/STATE.md
 * L-6). Purely a type-level narrowing: the value at runtime is the exact
 * same `SQL` the function always returned.
 */
export type ProjectIdScope = SQL & { readonly __brand: "ProjectIdScope" };

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
export function scopedProjects(user: AuthUser, level: ScopeLevel = "read"): ProjectIdScope {
  const liveness: SQL[] = [isNull(projects.deletedAt)];
  if (excludesArchived(level)) liveness.push(eq(projects.status, "active"));

  // The instance owner short-circuits to every live project, at every level.
  if (user.role === "owner") {
    return sql`(select ${projects.id} from ${projects} where ${and(...liveness)})` as ProjectIdScope;
  }

  // The project owner always qualifies, at every level including `delete`.
  const ownerBranch = eq(projects.ownerId, user.id);

  if (level === "delete") {
    return sql`(select ${projects.id} from ${projects} where ${and(ownerBranch, ...liveness)})` as ProjectIdScope;
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
              where ${and(or(ownerBranch, membershipBranch), ...liveness)})` as ProjectIdScope;
}

/**
 * Locks a project row by id, re-validating `scopedProjects(user, level)` as
 * a SEPARATE, freshly-planned statement both before AND after the lock, and
 * only then returns the row for the caller to act on. Every mutation that
 * locks a project row and composes `scopedProjects` into that SAME locking
 * statement must go through this instead — task 4.8 review finding H-1.
 *
 * Why the two statements can't be one: Postgres's EvalPlanQual, the
 * mechanism that makes `SELECT ... FOR UPDATE` safe against a concurrent
 * writer, re-evaluates quals against the *locked relation's* substituted
 * tuple when a blocked lock wakes up — but `scopedProjects`'s membership
 * check is `id IN (select ... from project_members ...)`, an uncorrelated
 * subquery Postgres commonly plans as an InitPlan: evaluated exactly ONCE,
 * before the lock wait, never re-run when EPQ substitutes the post-commit
 * tuple. Composed into the same statement as the lock, the scope check can
 * therefore pass on stale data — e.g. a member whose access was revoked by
 * the very transaction this one just waited on can still have their
 * request succeed, because the membership subquery result it's judged
 * against was computed before the revocation committed.
 *
 * Why there are THREE statements, not two: an earlier version of this
 * function locked the bare row first, with no scope predicate at all, then
 * checked scope once after. That let ANY caller — including one with zero
 * relationship to the project — queue on the row's lock for as long as
 * whatever transaction holds it, before ever being told they're
 * unauthorized. Two costs followed, found in a task 4.8 follow-up review:
 * (1) a timing oracle — an unauthorized `NOT_FOUND` returns in single-digit
 * milliseconds when the row is quiescent but takes as long as the
 * contending writer's transaction when it's contended, which is an
 * observable difference the rest of this file works hard not to leak, and
 * (2) pool amplification — any authenticated user can pin a database
 * connection, blocked, against a row they have no rights to.
 *
 * The fix is check -> lock -> re-check: an unlocked `scopedProjects` check
 * first (so an unauthorized caller is rejected before taking any lock, at
 * the same cost as any other unlocked scoped read), THEN the lock, THEN the
 * fresh re-check from the original fix (which remains the sole source of
 * truth — the pre-check is purely a fast path, never trusted on its own,
 * since it's exactly as vulnerable to stale InitPlan data as the original
 * bug). By the time the post-lock check runs, any transaction that changed
 * `project_members` or `projects` for this row and was holding the lock we
 * waited on has already committed, and READ COMMITTED gives every new
 * statement its own snapshot — so it sees the change. Holding the lock for
 * the remainder of the caller's transaction then makes every subsequent
 * write in that transaction safe, including a plain
 * `WHERE eq(projects.id, row.id)` — no concurrent writer can touch this row
 * until the lock is released at commit.
 *
 * Every "not authorized" exit — pre-check, missing row, or post-check —
 * throws the exact same bare `NOT_FOUND`, preserving 404-not-403.
 */
export async function lockScopedProject(
  tx: Tx,
  projectId: string,
  user: AuthUser,
  level: ScopeLevel,
): Promise<typeof projects.$inferSelect> {
  const [precheck] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), inArray(projects.id, scopedProjects(user, level))))
    .limit(1);
  if (!precheck) throw new TRPCError({ code: "NOT_FOUND" });

  const [row] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .for("update");
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });

  const [authorized] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), inArray(projects.id, scopedProjects(user, level))))
    .limit(1);
  if (!authorized) throw new TRPCError({ code: "NOT_FOUND" });

  return row;
}
