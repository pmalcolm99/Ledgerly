import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { projectMembers, projects, users } from "@ledgerly/db/schema";
import { displayNameOf } from "@ledgerly/shared/personName";
import type { AuthUser } from "@ledgerly/auth/types";

import { recordAudit } from "../audit";
import type { Tx } from "../audit";
import { isForeignKeyViolation, isUniqueViolation } from "../errors";
import { lockScopedProject, scopedProjects } from "../scope";
import { protectedProcedure, router } from "../trpc";
import { auditOwnerOverrideIfApplicable } from "./projects";

/**
 * packages/api/src/routers/members.ts — membership management (task 4.3).
 *
 * Every mutation's entry gate is `scopedProjects(user, "manage")` — floor
 * `full`, per scope.ts. That's what "only full members, the project owner,
 * or the instance owner may manage members at all" means at the query
 * layer, and it's why a `read`/`read_add` member calling any procedure here
 * gets NOT_FOUND, not a bespoke FORBIDDEN: they fail the same scope gate
 * every other unauthorized project access fails.
 *
 * The escalation guards below are checks *beyond* that gate — they're
 * about which row within an already-authorized project gets touched, which
 * `scopedProjects` deliberately does not reach into (docs/SCHEMA.md
 * §project_members "Escalation guard").
 */

const RANK = { read: 0, read_add: 1, full: 2 } as const;

const PROJECT_MEMBERS_PK = "project_members_project_id_user_id_pk";
const PROJECT_MEMBERS_USER_FK = "project_members_user_id_users_id_fk";

const permissionEnum = z.enum(["read", "read_add", "full"]);

const addInput = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  permission: permissionEnum,
});

const updatePermissionInput = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  permission: permissionEnum,
});

const removeInput = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
});

const listInput = z.object({ projectId: z.string().uuid() });

type ManageContext = {
  project: typeof projects.$inferSelect;
  isProjectOwner: boolean;
  isInstanceOwner: boolean;
  /** The caller's own project_members.permission. null for the project
   * owner and the instance owner, neither of whom necessarily has (or
   * needs) a row read here. */
  callerLevel: "read" | "read_add" | "full" | null;
};

/**
 * Loads the target project (locked, and freshly re-checked against
 * `scopedProjects(user, "manage")` — see `lockScopedProject` in scope.ts
 * for why those must be two statements, not one; task 4.8 review finding
 * H-1), and derives the caller's own standing relative to it. Throws
 * NOT_FOUND if the scope gate fails — the same 404-not-403 discipline as
 * every other project access.
 */
async function loadManageContext(
  tx: Tx,
  projectId: string,
  user: AuthUser,
): Promise<ManageContext> {
  const project = await lockScopedProject(tx, projectId, user, "manage");

  const isProjectOwner = project.ownerId === user.id;
  const isInstanceOwner = user.role === "owner";

  let callerLevel: ManageContext["callerLevel"] = null;
  if (!isProjectOwner && !isInstanceOwner) {
    const [membership] = await tx
      .select({ permission: projectMembers.permission })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)))
      .limit(1);
    if (!membership) {
      // lockScopedProject's fresh "manage" recheck just confirmed a
      // full-or-better membership row exists for this exact user — this
      // branch is reachable only if that guarantee is ever violated
      // elsewhere, which is a bug worth failing loudly on rather than
      // silently downgrading to "read" (task 4.8 review finding L-1).
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }
    callerLevel = membership.permission;
  }

  return { project, isProjectOwner, isInstanceOwner, callerLevel };
}

/**
 * "Cannot grant a permission level above your own" — a no-op for the
 * project owner and the instance owner, who have no ceiling. Note: as
 * currently scoped, this guard is unreachable through the public
 * procedures, because the "manage" gate already requires `full` to get in,
 * and `full` has no level above it to be blocked from. It stays live
 * insurance against a future 4th permission level, or a future loosening
 * of the manage gate — kept per docs/SCHEMA.md's escalation-guard
 * paragraph even though no test today can make it fail through this API.
 */
function assertNotAboveOwnLevel(ctx: ManageContext, requested: "read" | "read_add" | "full"): void {
  if (ctx.isProjectOwner || ctx.isInstanceOwner) return;
  if (RANK[requested] > RANK[ctx.callerLevel ?? "read"]) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You cannot grant a permission level higher than your own.",
    });
  }
}

export const membersRouter = router({
  /**
   * Anyone who can view the project can see who else has access to it —
   * gated at "read", not "manage": member *management* is `full`-and-up,
   * but member *visibility* is not a privileged action (task 4.8 review
   * finding M-6 — there was previously no way to read a project's
   * membership through the API at all).
   */
  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const [project] = await ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, input.projectId),
          inArray(projects.id, scopedProjects(ctx.user, "read")),
        ),
      )
      .limit(1);
    if (!project) throw new TRPCError({ code: "NOT_FOUND" });

    // Joined to `users` in Phase 7: this previously returned bare UUIDs, which
    // no UI can render. INNER, not LEFT — project_members.user_id is
    // ON DELETE CASCADE, so a membership row cannot outlive its user.
    //
    // Email is exposed to fellow project members deliberately: it is the only
    // thing that disambiguates two people with the same display name, and
    // these are people who already share a project. audit.ts's no-PII rule
    // governs the audit log, not this surface.
    const rows = await ctx.db
      .select({
        userId: projectMembers.userId,
        permission: projectMembers.permission,
        grantedBy: projectMembers.grantedBy,
        grantedAt: projectMembers.grantedAt,
        displayName: users.displayName,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        ownerId: projects.ownerId,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      // Composed here as well as in the probe above. The probe throws first
      // in the same request, so this is not exploitable today — but putting
      // the enforcement in a *preceding statement* rather than in the query
      // is the scattered check CLAUDE.md forbids, and `receipts.get` and
      // `projects.stats` both refuse the same shape. One extra indexed row.
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          inArray(projects.id, scopedProjects(ctx.user, "read")),
        ),
      )
      .orderBy(desc(projectMembers.permission), asc(users.displayName));

    return rows.map((row) => ({
      userId: row.userId,
      permission: row.permission,
      grantedBy: row.grantedBy,
      grantedAt: row.grantedAt,
      email: row.email,
      name: displayNameOf(row),
      isProjectOwner: row.userId === row.ownerId,
    }));
  }),

  add: protectedProcedure.input(addInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (tx) => {
      const manageCtx = await loadManageContext(tx, input.projectId, ctx.user);
      const { project } = manageCtx;

      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot change your own permission level.",
        });
      }
      if (input.userId === project.ownerId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "The project owner's access cannot be modified this way.",
        });
      }
      assertNotAboveOwnLevel(manageCtx, input.permission);

      let member;
      try {
        [member] = await tx
          .insert(projectMembers)
          .values({
            projectId: project.id,
            userId: input.userId,
            permission: input.permission,
            grantedBy: ctx.user.id,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error, PROJECT_MEMBERS_PK)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "That user is already a member of this project.",
          });
        }
        // A nonexistent userId trips project_members' FK to users, not a
        // unique violation — task 4.8 review finding M-3. NOT_FOUND, not a
        // raw 500: same 404-not-403 reasoning as everywhere else, this
        // just isn't confirming which ids are real projects instead of
        // which ids are real users.
        if (isForeignKeyViolation(error, PROJECT_MEMBERS_USER_FK)) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        throw error;
      }
      if (!member) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "member.permission_granted",
        entityType: "project_member",
        entityId: project.id,
        metadata: { userId: input.userId, permission: input.permission, via: "members.add" },
      });
      await auditOwnerOverrideIfApplicable(
        tx,
        ctx.user,
        project,
        "member.permission_granted",
        "members.add",
        input.userId,
      );

      return member;
    });
  }),

  updatePermission: protectedProcedure
    .input(updatePermissionInput)
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const manageCtx = await loadManageContext(tx, input.projectId, ctx.user);
        const { project } = manageCtx;

        if (input.userId === ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You cannot change your own permission level.",
          });
        }
        if (input.userId === project.ownerId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "The project owner's access cannot be modified.",
          });
        }
        assertNotAboveOwnLevel(manageCtx, input.permission);

        const [existing] = await tx
          .select({ permission: projectMembers.permission })
          .from(projectMembers)
          .where(
            and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, input.userId)),
          )
          .limit(1)
          .for("update");
        if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

        const [updated] = await tx
          .update(projectMembers)
          .set({ permission: input.permission })
          .where(
            and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, input.userId)),
          )
          .returning();
        if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "member.permission_changed",
          entityType: "project_member",
          entityId: project.id,
          metadata: {
            userId: input.userId,
            from: existing.permission,
            to: input.permission,
            via: "members.updatePermission",
          },
        });
        await auditOwnerOverrideIfApplicable(
          tx,
          ctx.user,
          project,
          "member.permission_changed",
          "members.updatePermission",
          input.userId,
        );

        return updated;
      });
    }),

  remove: protectedProcedure.input(removeInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (tx) => {
      const { project } = await loadManageContext(tx, input.projectId, ctx.user);

      if (input.userId === project.ownerId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "The project owner cannot be removed." });
      }
      // Self-removal is allowed: leaving a project you belong to is not a
      // privilege escalation, and nothing in the schema/task forbids it.

      const deleted = await tx
        .delete(projectMembers)
        .where(
          and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, input.userId)),
        )
        .returning({ userId: projectMembers.userId, permission: projectMembers.permission });
      const removedRow = deleted[0];
      if (!removedRow) throw new TRPCError({ code: "NOT_FOUND" });

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "member.removed",
        entityType: "project_member",
        entityId: project.id,
        metadata: {
          userId: input.userId,
          previousPermission: removedRow.permission,
          via: "members.remove",
        },
      });
      await auditOwnerOverrideIfApplicable(
        tx,
        ctx.user,
        project,
        "member.removed",
        "members.remove",
        input.userId,
      );

      return { removed: true };
    });
  }),
});
