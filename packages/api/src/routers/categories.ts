import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { categories, receiptItems, receipts } from "@ledgerly/db/schema";

import { recordAudit } from "../audit";
import type { Tx } from "../audit";
import { isUniqueViolation } from "../errors";
import { scopedProjects } from "../scope";
import { protectedProcedure, router } from "../trpc";

/**
 * packages/api/src/routers/categories.ts — the instance-wide taxonomy (D-20,
 * task 7.6).
 *
 * `scopedProjects` does not apply here: categories belong to the instance,
 * not to a project, so there is no project scope to compose. The gates are
 * therefore stated per-procedure, and the reasoning is recorded as D-33:
 *
 *   list    any onboarded user   — every line-item editor needs the picker.
 *   create  any onboarded user   — D-20's premise is "user-extensible", and a
 *                                  bad category is cosmetic and recoverable.
 *   update  creator or instance owner
 *   delete  creator or instance owner
 *   is_system rows: nobody, ever, including the instance owner.
 *
 * Create and mutate are deliberately asymmetric. Adding a category is purely
 * additive; renaming or deleting one changes every historical report and every
 * past export for everyone on the instance, which is not a thing one user
 * should be able to do to another's data.
 */

const SLUG_UNIQUE = "categories_slug_live_key";

/**
 * The slug is derived server-side and never accepted from the client. It is
 * the stable key an export is written against and the value the extraction
 * tool enum is built from at call time (D-20) — a client-supplied slug lets a
 * user collide with, or impersonate, a seeded system category.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  if (!slug) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That name has no letters or numbers in it.",
    });
  }
  return slug;
}

/** Loads a category for mutation under a row lock, and enforces the two
 *  rules that apply to every write: system rows are immutable, and only the
 *  creator or the instance owner may touch a user row. Re-reads `is_system`
 *  inside the transaction rather than trusting a prior read, because a
 *  check-then-write races a concurrent seed. */
async function loadMutableCategory(
  tx: Tx,
  id: string,
  user: { id: string; role: string },
): Promise<typeof categories.$inferSelect> {
  const [row] = await tx
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
    .limit(1)
    .for("update");
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });

  if (row.isSystem) {
    throw new TRPCError({
      code: "FORBIDDEN",
      // D-20: the 13 seeded categories cannot be renamed or deleted, so an
      // export's meaning is stable over time. The CHECK constraint enforces
      // the delete half; this enforces the rename half.
      message: "Built-in categories cannot be changed.",
    });
  }
  if (user.role !== "owner" && row.createdBy !== user.id) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the person who created a category, or the instance owner, can change it.",
    });
  }
  return row;
}

export const categoriesRouter = router({
  /**
   * The picker. Ordered by `sort_order, name`, which is exactly
   * `categories_sort_idx`.
   *
   * `includeCounts` scopes its count through the caller's readable projects.
   * An unscoped count would tell a single-project user how many line items
   * exist across projects they cannot see — a small but real cross-project
   * leak, and the kind that is easy to introduce by writing the obvious query.
   */
  list: protectedProcedure
    .input(z.object({ includeCounts: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      const includeCounts = input?.includeCounts ?? false;

      return ctx.db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          color: categories.color,
          sortOrder: categories.sortOrder,
          isSystem: categories.isSystem,
          createdBy: categories.createdBy,
          itemCount: includeCounts
            ? sql<number>`(
                select count(*)::int from ${receiptItems}
                inner join ${receipts} on "receipts"."id" = "receipt_items"."receipt_id"
                where "receipt_items"."category_id" = "categories"."id"
                  and "receipts"."deleted_at" is null
                  and "receipts"."project_id" in ${scopedProjects(ctx.user, "read")}
              )`
            : sql<number>`0`,
        })
        .from(categories)
        .where(isNull(categories.deletedAt))
        .orderBy(asc(categories.sortOrder), asc(categories.name));
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        color: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #2f7d80.")
          .nullable()
          .optional(),
        sortOrder: z.number().int().min(0).max(9999).default(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = slugify(input.name);

      return ctx.db.transaction(async (tx) => {
        let created;
        try {
          [created] = await tx
            .insert(categories)
            .values({
              name: input.name,
              slug,
              color: input.color ?? null,
              sortOrder: input.sortOrder,
              isSystem: false,
              createdBy: ctx.user.id,
            })
            .returning();
        } catch (error) {
          // The unique index is partial (WHERE deleted_at IS NULL), so a slug
          // freed by a previous soft delete can legitimately be reused — that
          // is D-22 working as intended, not a collision.
          if (isUniqueViolation(error, SLUG_UNIQUE)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "A category with that name already exists.",
            });
          }
          throw error;
        }
        if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "category.created",
          entityType: "category",
          entityId: created.id,
          metadata: { slug, via: "categories.create" },
        });
        return created;
      });
    }),

  /**
   * `slug` is immutable after creation, deliberately. Renaming "Lumber" to
   * "Timber" must not orphan the key every past export was written against,
   * nor silently change what the AI tool enum offers for existing data.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(100).optional(),
        color: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #2f7d80.")
          .nullable()
          .optional(),
        sortOrder: z.number().int().min(0).max(9999).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...supplied } = input;
      const changed = Object.keys(supplied).filter(
        (key) => supplied[key as keyof typeof supplied] !== undefined,
      );
      if (changed.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No fields to update." });
      }

      return ctx.db.transaction(async (tx) => {
        const row = await loadMutableCategory(tx, id, ctx.user);

        const [updated] = await tx
          .update(categories)
          .set(supplied)
          .where(eq(categories.id, row.id))
          .returning();
        if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "category.updated",
          entityType: "category",
          entityId: row.id,
          metadata: { fields: changed, via: "categories.update" },
        });
        return updated;
      });
    }),

  /**
   * Soft delete — and therefore the ONLY guard against orphaning line items
   * is the count below.
   *
   * `receipt_items.category_id` is `ON DELETE RESTRICT`, which D-20 leans on
   * as "a database guarantee rather than an application convention". That
   * guarantee does not fire here: a soft delete is an UPDATE of `deleted_at`,
   * and the foreign key never sees it. The count is the enforcement, and task
   * 7.6's acceptance criterion — blocked with a message naming the count — is
   * exactly this branch.
   *
   * The count is global, NOT scoped to the caller's projects. This procedure
   * is reachable only by the category's creator or the instance owner, and a
   * scoped count would name a number smaller than the real blocker, producing
   * a message that is simply wrong.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const row = await loadMutableCategory(tx, input.id, ctx.user);

        const [usage] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(receiptItems)
          .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
          // Soft-deleted receipts ARE counted. `ON DELETE RESTRICT` never
          // fires on a soft delete, so this count is the only thing standing
          // between a category and a live foreign key pointing at a
          // `deleted_at`-marked row. Excluding them let a category referenced
          // solely by items on soft-deleted receipts be deleted, leaving real
          // orphans — and receipts are soft-deleted precisely so they can come
          // back, with Phase 8's export joining categories.
          .where(eq(receiptItems.categoryId, row.id));

        const count = usage?.count ?? 0;
        if (count > 0) {
          // CONFLICT is in trpc.ts's CLIENT_SAFE_CODES, so this message
          // reaches the user verbatim. Raised under any other code the error
          // formatter would replace it with "Internal server error." and the
          // acceptance criterion would silently fail.
          throw new TRPCError({
            code: "CONFLICT",
            message: `That category is used by ${count} receipt item${count === 1 ? "" : "s"}. Reassign them before deleting it.`,
          });
        }

        await tx.update(categories).set({ deletedAt: new Date() }).where(eq(categories.id, row.id));

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "category.deleted",
          entityType: "category",
          entityId: row.id,
          metadata: { slug: row.slug, via: "categories.delete" },
        });
        return { id: row.id };
      });
    }),
});
