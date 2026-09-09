import "server-only";

import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { categories, projectMembers, projects, receiptItems, receipts } from "@ledgerly/db/schema";

import { recordAudit } from "../audit";
import type { Tx } from "../audit";
import { isUniqueViolation } from "../errors";
import { NEEDS_REVIEW_SQL } from "../receiptAccess";
import { lockScopedProject, scopedProjects } from "../scope";
import { protectedProcedure, router } from "../trpc";

/**
 * Per-project rollups as CORRELATED scalar subqueries in the select list.
 *
 * This is one round trip, so it is not an N+1 — "N+1" means N round trips,
 * not N index probes. Each subquery correlates on `projects.id`, so it runs
 * only for projects the outer WHERE already admitted, and probes
 * `receipts_project_date_idx` on its leading `project_id` column.
 *
 * The alternative shapes are both wrong here. A second query keyed on the ids
 * the first returned is the N+1. A non-correlated `GROUP BY project_id`
 * subquery aggregates every receipt on the instance and then throws away the
 * rows the caller cannot see — doing the work, and the disclosure, before the
 * scope is applied.
 *
 * TWO CASTS THAT ARE NOT OPTIONAL (D-21):
 *   `count(*)` is bigint, which the pg driver hands back as a STRING. Typing
 *   it `sql<number>` without `::int` is a lie that only shows up when someone
 *   adds two counts and gets "12" + "5" === "125".
 *   `sum(numeric)` is numeric, also a string. It stays a string all the way to
 *   the display formatter; typing it `sql<number>` is the single easiest way
 *   to introduce a float into money in this codebase.
 *
 * COLUMN REFERENCES ARE WRITTEN OUT, QUALIFIED, ON PURPOSE.
 *
 * On drizzle-orm 0.41.0, interpolating a column into a `sql` template inside a
 * select list renders it BARE, with no table prefix. Verified by printing
 * `.toSQL()`:
 *
 *   db.select({ id: projects.id,
 *               n: sql`(select count(*) from ${receipts}
 *                       where ${receipts.projectId} = ${projects.id})` })
 *     .from(projects)
 *
 *   -> select "id", (select count(*) from "receipts"
 *                    where "project_id" = "id") from "projects"
 *
 * Inside a correlated subquery both sides then bind to the INNER table, so
 * that predicate is `receipts.project_id = receipts.id` — never true. Every
 * rollup silently returned 0 and the dashboard read "0 receipts, $0.00" for
 * every project. It fails as a plausible number rather than an error, which is
 * why the rollup tests assert real counts and not just types.
 *
 * (A code reading of drizzle's `buildQueryFromSourceParams` suggests columns
 * are always qualified. They are not on this path and this version — hence the
 * transcript above rather than a claim. Re-run it before relying on the
 * opposite.)
 *
 * A nested `SQL` object, like NEEDS_REVIEW_SQL below, IS rendered qualified,
 * so it is safe to embed as-is.
 */
const receiptRollups = {
  receiptCount: sql<number>`(
    select count(*)::int from ${receipts}
    where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
  )`,
  totalSpend: sql<string>`(
    select coalesce(sum("receipts"."total"), 0)::numeric(12,2)::text from ${receipts}
    where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
  )`,
  needsReviewCount: sql<number>`(
    select count(*)::int from ${receipts}
    where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
      and ${NEEDS_REVIEW_SQL}
  )`,
  /** `sum` skips NULLs, so without this the dashboard total silently
   *  understates whenever a receipt's total could not be read, and nothing on
   *  screen says so. */
  receiptsMissingTotal: sql<number>`(
    select count(*)::int from ${receipts}
    where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
      and "receipts"."total" is null
  )`,
  /** D-17: totals sum without regard to currency, which is correct only while
   *  every row shares one. Returning the distinct set lets the UI refuse to
   *  show a total rather than show a meaningless one. */
  currencies: sql<string[]>`(
    select coalesce(array_agg(distinct "receipts"."currency"), '{}') from ${receipts}
    where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
  )`,
};

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

  /**
   * The landing screen's data (task 7.3). Extended in Phase 7 to carry the
   * rollups the project list renders — total spend, receipt count, and the
   * needs-review badge — in the same single query.
   */
  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const conditions = [inArray(projects.id, scopedProjects(ctx.user, "read"))];
    if (input?.status) conditions.push(eq(projects.status, input.status));

    return ctx.db
      .select({
        id: projects.id,
        ownerId: projects.ownerId,
        name: projects.name,
        description: projects.description,
        startDate: projects.startDate,
        endDate: projects.endDate,
        status: projects.status,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        archivedAt: projects.archivedAt,
        ...receiptRollups,
      })
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt));
  }),

  /**
   * The dashboard header and its spend-by-category chart (task 7.3).
   *
   * Two statements, and BOTH compose `scopedProjects` — the second does not
   * get to assume the first authorized anything.
   *
   * THE TWO NUMBERS DO NOT RECONCILE, BY CONSTRUCTION. `totalSpend` is
   * `sum(receipts.total)`; `byCategory` sums `receipt_items.line_total`. They
   * differ by sales tax, tip, receipts whose line items were never extracted,
   * and every receipt flagged `arithmetic_mismatch_items`. `byCategoryTotal`
   * is returned as its own field precisely so the UI can show the gap
   * honestly instead of implying a reconciliation that does not exist.
   *
   * Tax and tip are deliberately NOT apportioned pro-rata across categories.
   * This is a tax record; inventing per-category numbers would be worse than
   * showing an unallocated remainder.
   */
  stats: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        from: z.string().date().optional(),
        to: z.string().date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [header] = await ctx.db
        .select({
          id: projects.id,
          name: projects.name,
          description: projects.description,
          startDate: projects.startDate,
          endDate: projects.endDate,
          status: projects.status,
          ownerId: projects.ownerId,
          ...receiptRollups,
        })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            inArray(projects.id, scopedProjects(ctx.user, "read")),
          ),
        )
        .limit(1);
      if (!header) throw new TRPCError({ code: "NOT_FOUND" });

      const itemConditions = [
        eq(receipts.projectId, input.projectId),
        // Composed again, independently of the header query above.
        inArray(receipts.projectId, scopedProjects(ctx.user, "read")),
        isNull(receipts.deletedAt),
      ];
      if (input.from) itemConditions.push(gte(receipts.transactionDate, input.from));
      if (input.to) itemConditions.push(lte(receipts.transactionDate, input.to));

      const byCategory = await ctx.db
        .select({
          categoryId: categories.id,
          name: categories.name,
          color: categories.color,
          itemCount: sql<number>`count(*)::int`,
          spend: sql<string>`coalesce(sum(${receiptItems.lineTotal}), 0)::numeric(12,2)::text`,
        })
        .from(receiptItems)
        .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
        // LEFT: an item with no category is a real, displayable bucket
        // ("Unassigned"), and is NOT the same thing as the seeded
        // `uncategorized` system category — both can appear in one chart.
        .leftJoin(categories, eq(categories.id, receiptItems.categoryId))
        .where(and(...itemConditions))
        .groupBy(categories.id, categories.name, categories.color)
        .orderBy(sql`sum(${receiptItems.lineTotal}) DESC NULLS LAST`);

      return { project: header, byCategory };
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
