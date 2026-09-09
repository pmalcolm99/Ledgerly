import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { categories, receiptItems } from "@ledgerly/db/schema";

import { recordAudit } from "../audit";
import type { Tx } from "../audit";
import { isForeignKeyViolation, isUniqueViolation } from "../errors";
import { scrubLuhnSequences } from "@ledgerly/shared/scrub";

import { moneyString, nullableText, quantityString } from "../inputs";
import {
  assertMayEditReceipt,
  loadEditableReceipt,
  recomputeReceiptDerivedState,
} from "../receiptAccess";
import { protectedProcedure, router } from "../trpc";
import { auditOwnerOverrideIfApplicable } from "./projects";

/**
 * packages/api/src/routers/receiptItems.ts — line-item CRUD (task 7.4).
 *
 * Authorization always travels item -> receipt -> project. There is no path
 * that authorizes by item id alone: `scopedProjects` only speaks about
 * projects, so an item is only ever reachable by resolving the project that
 * ultimately owns it and going through `loadEditableReceipt`. Lock order is
 * projects -> receipts -> receipt_items throughout, matching the rest of the
 * package, so no call site here can open a deadlock cycle.
 *
 * `receipt_items` has no `deleted_at` (docs/SCHEMA.md), so `delete` here is a
 * genuine hard delete — the one place in this codebase where a row really
 * goes away. That is the schema's decision, not this file's: an item is a
 * detail of a receipt, and the receipt itself is still soft-deleted.
 */

const CATEGORY_FK = "receipt_items_category_id_categories_id_fk";
const LINE_NO_UNIQUE = "receipt_items_line_key";

/**
 * Confirms a category exists and is live, holding a share lock on it.
 *
 * `ON DELETE RESTRICT` does NOT protect against a *soft*-deleted category —
 * the foreign key never sees `deleted_at`. Worse, without a lock this races
 * `categories.delete`, which counts referencing items before soft-deleting:
 * that count can come back zero at the same moment this transaction assigns
 * the category, and the category is then deleted out from under a live
 * reference. `FOR SHARE` serializes against that procedure's `FOR UPDATE`,
 * closing the window.
 */
async function assertLiveCategory(tx: Tx, categoryId: string): Promise<void> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), isNull(categories.deletedAt)))
    .limit(1)
    .for("share");
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
}

/** Resolves the parent receipt of an item. Unlocked and deliberately
 *  unauthorized — it learns only which receipt to hand to
 *  `loadEditableReceipt`, which is what actually decides. */
async function receiptIdForItem(tx: Tx, itemId: string): Promise<string> {
  const [row] = await tx
    .select({ receiptId: receiptItems.receiptId })
    .from(receiptItems)
    .where(eq(receiptItems.id, itemId))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row.receiptId;
}

export const receiptItemsRouter = router({
  /**
   * Append a line item.
   *
   * `lineNo` is allocated server-side as `max + 1`, never supplied by the
   * client. Safe under concurrency because every mutation that touches this
   * receipt takes the same project lock first (`loadEditableReceipt`), so the
   * max-then-insert pair is serialized; the unique-violation catch below is
   * belt and braces so a future path that somehow skips the lock surfaces as
   * a CONFLICT the client can retry rather than a raw 500.
   *
   * Insert-in-the-middle and reordering are deliberately not supported:
   * `receipt_items_line_key` is a plain unique index, not DEFERRABLE, so a
   * shift-everything-down renumber collides mid-statement. Deleting an item
   * therefore leaves a gap in `line_no`, which the index tolerates — the UI
   * renders by array position, not by `line_no`.
   */
  create: protectedProcedure
    .input(
      z.object({
        receiptId: z.string().uuid(),
        // NOT NULL in the schema: an item nobody can describe is not an item.
        description: z.string().trim().min(1).max(500),
        sku: nullableText(100).optional(),
        quantity: quantityString.nullable().optional(),
        unitPrice: moneyString.nullable().optional(),
        lineTotal: moneyString.nullable().optional(),
        categoryId: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const access = await loadEditableReceipt(tx, input.receiptId, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);

        if (input.categoryId) await assertLiveCategory(tx, input.categoryId);

        // CLAUDE.md's "never store full card numbers" is unqualified, and a
        // line item is exactly where someone retypes what is printed on a
        // receipt. `receipts.update` scrubs its whole patch for the same
        // reason; this router accepted `description` and `sku` unscrubbed.
        const { scrubbed, redactions } = scrubLuhnSequences({
          description: input.description,
          sku: input.sku ?? null,
        });

        const [next] = await tx
          .select({ nextLineNo: sql<number>`coalesce(max(${receiptItems.lineNo}), 0) + 1` })
          .from(receiptItems)
          .where(eq(receiptItems.receiptId, input.receiptId));

        let item;
        try {
          [item] = await tx
            .insert(receiptItems)
            .values({
              receiptId: input.receiptId,
              lineNo: next?.nextLineNo ?? 1,
              description: scrubbed.description,
              sku: scrubbed.sku,
              quantity: input.quantity ?? null,
              unitPrice: input.unitPrice ?? null,
              lineTotal: input.lineTotal ?? null,
              categoryId: input.categoryId ?? null,
              // A human added this row, so its category (if any) is a human
              // decision and must not carry the AI-assigned styling.
              aiAssignedCategory: false,
            })
            .returning();
        } catch (error) {
          if (isUniqueViolation(error, LINE_NO_UNIQUE)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "The line numbering changed while you were editing. Try again.",
            });
          }
          if (isForeignKeyViolation(error, CATEGORY_FK)) throw new TRPCError({ code: "NOT_FOUND" });
          throw error;
        }
        if (!item) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        await recomputeReceiptDerivedState(tx, input.receiptId);
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt_item.created",
          entityType: "receipt_item",
          entityId: item.id,
          metadata: {
            receiptId: input.receiptId,
            via: "receiptItems.create",
            ...(redactions ? { redactions } : {}),
          },
        });
        await auditOwnerOverrideIfApplicable(
          tx,
          ctx.user,
          access.project,
          "receipt_item.created",
          "receiptItems.create",
        );

        return item;
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        description: z.string().trim().min(1).max(500).optional(),
        sku: nullableText(100).optional(),
        quantity: quantityString.nullable().optional(),
        unitPrice: moneyString.nullable().optional(),
        lineTotal: moneyString.nullable().optional(),
        categoryId: z.string().uuid().nullable().optional(),
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
        const receiptId = await receiptIdForItem(tx, id);
        const access = await loadEditableReceipt(tx, receiptId, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);

        if (input.categoryId) await assertLiveCategory(tx, input.categoryId);

        // Scrubbed over the whole patch, so a field added to the input schema
        // above cannot quietly skip it — same shape as `receipts.update`.
        const { scrubbed, redactions } = scrubLuhnSequences(supplied as Record<string, unknown>);

        const patch: Partial<typeof receiptItems.$inferInsert> = {
          ...(scrubbed as Partial<typeof receiptItems.$inferInsert>),
          updatedAt: new Date(),
        };
        // Only when the category itself is being set: a user fixing a typo in
        // the description has not re-decided the category, and the
        // "AI-assigned" styling (task 7.6) should survive that edit.
        if (changed.includes("categoryId")) patch.aiAssignedCategory = false;

        let updated;
        try {
          [updated] = await tx
            .update(receiptItems)
            .set(patch)
            .where(eq(receiptItems.id, id))
            .returning();
        } catch (error) {
          if (isForeignKeyViolation(error, CATEGORY_FK)) throw new TRPCError({ code: "NOT_FOUND" });
          throw error;
        }
        if (!updated) throw new TRPCError({ code: "NOT_FOUND" });

        await recomputeReceiptDerivedState(tx, receiptId);
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt_item.updated",
          entityType: "receipt_item",
          entityId: id,
          metadata: {
            receiptId,
            fields: changed,
            via: "receiptItems.update",
            ...(redactions ? { redactions } : {}),
          },
        });
        await auditOwnerOverrideIfApplicable(
          tx,
          ctx.user,
          access.project,
          "receipt_item.updated",
          "receiptItems.update",
        );

        return updated;
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const receiptId = await receiptIdForItem(tx, input.id);
        const access = await loadEditableReceipt(tx, receiptId, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);

        // Hard delete: receipt_items has no deleted_at (docs/SCHEMA.md).
        const deleted = await tx
          .delete(receiptItems)
          .where(eq(receiptItems.id, input.id))
          .returning({ id: receiptItems.id, lineNo: receiptItems.lineNo });
        const row = deleted[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });

        // Removing the last item puts the `items` token back into
        // missing_fields, which is what this call recomputes.
        await recomputeReceiptDerivedState(tx, receiptId);
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt_item.deleted",
          entityType: "receipt_item",
          entityId: input.id,
          metadata: { receiptId, lineNo: row.lineNo, via: "receiptItems.delete" },
        });
        await auditOwnerOverrideIfApplicable(
          tx,
          ctx.user,
          access.project,
          "receipt_item.deleted",
          "receiptItems.delete",
        );

        return { id: input.id };
      });
    }),
});
