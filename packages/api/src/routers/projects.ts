import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { projectMembers, projects } from "@ledgerly/db/schema";

import { recordAudit } from "../audit";
import type { Tx } from "../audit";
import { isUniqueViolation } from "../errors";
import { lockScopedProject, scopedProjects } from "../scope";
import { protectedProcedure, router } from "../trpc";

/**
 * packages/api/src/routers/projects.ts — project CRUD (task 4.2, 4.5).
 *
 * Every procedure builds on `protectedProcedure`. There is no
 * `ownerProcedure` anywhere in this file: instance-owner-ness is expressed
 * purely through `scopedProjects`'s short-circuit, per ARCHITECTURE.md
 * §4.3 — per-project (and instance-wide) authority is a query-level scope,
 * never a different base procedure.
 */

const idInput = z.object({ id: z.string().uuid() });

const createInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, {
    message: "End date must be on or after the start date.",
    path: ["endDate"],
  });

const updateInput = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    startDate: z.string().date().nullable().optional(),
    endDate: z.string().date().nullable().optional(),
  })
  .refine(
    (v) =>
      typeof v.startDate !== "string" || typeof v.endDate !== "string" || v.endDate >= v.startDate,
    { message: "End date must be on or after the start date.", path: ["endDate"] },
  );

const listInput = z
  .object({
    status: z.enum(["active", "archived"]).optional(),
  })
  .optional();

const DUPLICATE_NAME_MESSAGE = "You already have a project with that name.";
const PROJECTS_OWNER_NAME_LIVE_KEY = "projects_owner_name_live_key";

export const projectsRouter = router({
  /**
   * Creates a project and, in the same transaction, the creator's
   * `project_members` row with `permission: "full"` — task 4.2's
   * acceptance criterion is that a created project always has an owner
   * membership row, which only holds if these two inserts never happen
   * apart.
   */
  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (tx) => {
      let project;
      try {
        [project] = await tx
          .insert(projects)
          .values({
            ownerId: ctx.user.id,
            name: input.name,
            description: input.description ?? null,
            startDate: input.startDate ?? null,
            endDate: input.endDate ?? null,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error, PROJECTS_OWNER_NAME_LIVE_KEY)) {
          throw new TRPCError({ code: "CONFLICT", message: DUPLICATE_NAME_MESSAGE });
        }
        throw error;
      }
      if (!project) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await tx.insert(projectMembers).values({
        projectId: project.id,
        userId: ctx.user.id,
        permission: "full",
        grantedBy: ctx.user.id,
      });

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "project.created",
        entityType: "project",
        entityId: project.id,
        metadata: { ownerId: ctx.user.id, via: "projects.create" },
      });

      return project;
    });
  }),

  /**
   * A single query, a single branch. A nonexistent id and an id that
   * exists but the caller cannot see produce the exact same zero rows from
   * the exact same predicate — that's what makes this 404, never 403.
   * There is deliberately no "look it up, then decide" shape here: that
   * shape is what leaks existence.
   */
  get: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.id), inArray(projects.id, scopedProjects(ctx.user, "read"))))
      .limit(1);

    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const conditions = [inArray(projects.id, scopedProjects(ctx.user, "read"))];
    if (input?.status) conditions.push(eq(projects.status, input.status));

    return ctx.db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt));
  }),

  /**
   * Plain metadata edit — name/description/dates. Not audited beyond the
   * owner-override case (see docs/STATE.md's Phase 4 note): the audit
   * bullet names creation and archival specifically, and auditing every
   * field tweak would be noise. Gated at "manage" (floor full) — the
   * matrix has no separate "edit metadata" column, so this is bundled with
   * general management authority, same as archive/unarchive below.
   *
   * Locks via `lockScopedProject`, not a bare scope-composed UPDATE (task
   * 4.8 review finding H-1/M-1) — see scope.ts's docblock for why a scope
   * check composed into the same statement as a row lock can pass on
   * stale data.
   */
  update: protectedProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const { id } = input;
    return ctx.db.transaction(async (tx) => {
      const row = await lockScopedProject(tx, id, ctx.user, "manage");

      // Archived projects are read-only (docs/SCHEMA.md §projects) — task
      // 4.8 review finding M-4. `archive`/`unarchive`/`delete` still reach
      // archived projects (scope.ts's `manage`/`delete` levels
      // deliberately include them, so a project remains un-archivable and
      // deletable), but plain metadata edits do not.
      if (row.status === "archived") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Archived projects are read-only. Unarchive it first.",
        });
      }

      const patch: Partial<typeof projects.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.startDate !== undefined) patch.startDate = input.startDate;
      if (input.endDate !== undefined) patch.endDate = input.endDate;

      if (Object.keys(patch).length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No fields to update." });
      }

      // Validate the MERGED date pair, not just the fields this call
      // touches (task 4.8 review finding M-2): the zod refine only fires
      // when both dates are supplied together, so a patch touching only
      // one date could otherwise violate `projects_date_order` against the
      // row's *existing* other date and reach the client as a raw 500.
      const effectiveStart = patch.startDate !== undefined ? patch.startDate : row.startDate;
      const effectiveEnd = patch.endDate !== undefined ? patch.endDate : row.endDate;
      if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "End date must be on or after the start date.",
        });
      }

      try {
        const [updated] = await tx
          .update(projects)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(projects.id, row.id))
          .returning();
        if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        // Still no general project.updated row for an ordinary edit (see
        // header comment) — but the override case gets ONE, so that
        // owner_override.performed's `underlyingAction: "project.updated"`
        // names a row that actually exists in the log, rather than a
        // phantom action visible only in metadata (task 4.8 follow-up
        // review finding). An instance owner editing a project they don't
        // own gets the fuller trail; everyone else editing their own
        // project still gets none.
        if (ctx.user.role === "owner" && row.ownerId !== ctx.user.id) {
          await recordAudit(tx, {
            actorUserId: ctx.user.id,
            action: "project.updated",
            entityType: "project",
            entityId: row.id,
            metadata: { via: "projects.update" },
          });
        }
        await auditOwnerOverrideIfApplicable(
          tx,
          ctx.user,
          row,
          "project.updated",
          "projects.update",
        );

        return updated;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (isUniqueViolation(error, PROJECTS_OWNER_NAME_LIVE_KEY)) {
          throw new TRPCError({ code: "CONFLICT", message: DUPLICATE_NAME_MESSAGE });
        }
        throw error;
      }
    });
  }),

  archive: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (tx) => {
      const row = await lockScopedProject(tx, input.id, ctx.user, "manage");

      // Idempotent: archiving an already-archived project is a no-op, not
      // a second audit row with a bumped archivedAt (task 4.8 review
      // finding L-2).
      if (row.status === "archived") return row;

      const [updated] = await tx
        .update(projects)
        .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(projects.id, row.id))
        .returning();
      if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "project.archived",
        entityType: "project",
        entityId: row.id,
        metadata: { via: "projects.archive" },
      });
      await auditOwnerOverrideIfApplicable(
        tx,
        ctx.user,
        row,
        "project.archived",
        "projects.archive",
      );

      return updated;
    });
  }),

  unarchive: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (tx) => {
      const row = await lockScopedProject(tx, input.id, ctx.user, "manage");

      // Idempotent, same reasoning as archive above.
      if (row.status === "active") return row;

      const [updated] = await tx
        .update(projects)
        .set({ status: "active", archivedAt: null, updatedAt: new Date() })
        .where(eq(projects.id, row.id))
        .returning();
      if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "project.unarchived",
        entityType: "project",
        entityId: row.id,
        metadata: { via: "projects.unarchive" },
      });
      await auditOwnerOverrideIfApplicable(
        tx,
        ctx.user,
        row,
        "project.unarchived",
        "projects.unarchive",
      );

      return updated;
    });
  }),

  /**
   * Soft delete only — nothing is ever hard deleted from `projects`
   * (CLAUDE.md). Gated at "delete", NOT "manage": per scope.ts, delete
   * authority is `projects.owner_id` (or the instance owner) only. A
   * `full` member can archive a project but must not be able to delete it.
   * A second delete on an already-deleted project falls out of
   * `lockScopedProject` as NOT_FOUND for free — `scopedProjects`'s
   * liveness predicate always requires `deletedAt IS NULL`, at every level.
   */
  delete: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (tx) => {
      const row = await lockScopedProject(tx, input.id, ctx.user, "delete");

      await tx
        .update(projects)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(projects.id, row.id));

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "project.deleted",
        entityType: "project",
        entityId: row.id,
        metadata: { via: "projects.delete" },
      });
      await auditOwnerOverrideIfApplicable(tx, ctx.user, row, "project.deleted", "projects.delete");

      return { id: row.id };
    });
  }),
});

/**
 * Writes the extra `owner_override.performed` audit row the task's audit
 * bullet calls for — "any instance-owner action taken on a project they do
 * not own" — in addition to (never instead of) the action's own audit row.
 * Shared with `routers/members.ts`, which performs the same check for its
 * three mutations.
 */
export async function auditOwnerOverrideIfApplicable(
  tx: Tx,
  user: { id: string; role: string },
  project: { id: string; ownerId: string },
  underlyingAction: string,
  via: string,
  targetUserId?: string,
): Promise<void> {
  if (user.role !== "owner" || project.ownerId === user.id) return;

  await recordAudit(tx, {
    actorUserId: user.id,
    action: "owner_override.performed",
    entityType: "project",
    entityId: project.id,
    metadata: { underlyingAction, via, ...(targetUserId ? { targetUserId } : {}) },
  });
}
