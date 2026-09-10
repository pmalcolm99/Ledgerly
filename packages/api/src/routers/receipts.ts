import "server-only";

import { and, asc, desc, eq, exists, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getEnv } from "@ledgerly/config/env";
import {
  categories,
  projectMembers,
  projects,
  receiptItems,
  receipts,
  users,
} from "@ledgerly/db/schema";
import { displayNameOf } from "@ledgerly/shared/personName";
import { scrubLuhnSequences } from "@ledgerly/shared/scrub";
import { VALIDATION_FLAGS } from "@ledgerly/shared/receiptValidation";

import { recordAudit } from "../audit";
import type { Tx } from "../audit";
import {
  MISSING_FIELD_BY_COLUMN,
  MISSING_FIELD_TOKENS,
  NEEDS_REVIEW_SQL,
  assertMayEditReceipt,
  canEditSql,
  loadEditableReceipt,
  recomputeReceiptDerivedState,
} from "../receiptAccess";
import { checkEmailReceiptRateLimit, checkReextractRateLimit } from "../rateLimit";
import type { EditableReceiptColumn } from "../receiptAccess";
import {
  cardLast4String,
  moneyString,
  nullableText,
  receiptDateString,
  receiptTimeString,
} from "../inputs";
import { scopedProjects } from "../scope";
import { resolveSmtpConfig } from "../smtp";
import { auditOwnerOverrideIfApplicable } from "./projects";
import { deleteReceiptDir } from "../storage";
import { protectedProcedure, router } from "../trpc";

/**
 * packages/api/src/routers/receipts.ts — receipt deletion (Phase 5).
 *
 * Not one of the phase brief's five numbered build items, but a small,
 * necessary addition: "deleting a receipt deletes its image directory"
 * (storage requirement) needs *something* that deletes a receipt. Same
 * judgment-call convention Phase 4 used for `projects.unarchive`. `list`/
 * `get` are deliberately out of scope this phase -- tests reach a receipt
 * via the upload route's response or the DB test harness directly.
 */

const idInput = z.object({ id: z.string().uuid() });

export const receiptsRouter = router({
  /**
   * Project receipt list (task 7.3). Ordered by transaction date, newest
   * first, which is the order `receipts_project_date_idx` is declared in
   * (`DESC NULLS LAST`) — matching it means the LIMIT stops an ordered index
   * scan early instead of sorting the project's whole history.
   *
   * The `id DESC` tiebreak is not cosmetic: two receipts bought on the same
   * day, and the large NULL-date bucket (an unread date is one of the 11
   * missing-field tokens), otherwise page inconsistently under a keyset
   * cursor.
   *
   * Keyset, not OFFSET. This list is scrolled on a phone while uploads are
   * landing into it; an offset drifts and duplicates rows as the set grows
   * underneath the reader.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          projectId: z.string().uuid(),
          from: z.string().date().optional(),
          to: z.string().date().optional(),
          categoryId: z.string().uuid().optional(),
          needsReview: z.boolean().optional(),
          uploadedBy: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z
            .object({
              transactionDate: z.string().date().nullable(),
              id: z.string().uuid(),
            })
            .nullish(),
        })
        .refine((v) => !v.from || !v.to || v.to >= v.from, {
          message: "End date must be on or after the start date.",
          path: ["to"],
        }),
    )
    .query(async ({ ctx, input }) => {
      // Probe so the UI can tell "no such project" from "project with no
      // receipts". A convenience: the list query below composes the scope
      // itself and does not trust this.
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

      const conditions = [
        eq(receipts.projectId, input.projectId),
        // Composed again, independently. The probe above is not the gate.
        inArray(receipts.projectId, scopedProjects(ctx.user, "read")),
        isNull(receipts.deletedAt),
      ];

      if (input.from) conditions.push(gte(receipts.transactionDate, input.from));
      if (input.to) conditions.push(lte(receipts.transactionDate, input.to));
      if (input.uploadedBy) conditions.push(eq(receipts.uploadedBy, input.uploadedBy));
      if (input.needsReview) conditions.push(NEEDS_REVIEW_SQL);

      if (input.categoryId) {
        // A correlated EXISTS, never a join. Joining receipt_items multiplies
        // a receipt row once per matching item, forcing a DISTINCT that
        // discards the ordered index scan and makes the keyset LIMIT
        // meaningless — and it invites the planner to drive from
        // receipt_items_category_idx instead, losing the ordering entirely.
        // A semi-join keeps `receipts` the driving, ordered relation.
        conditions.push(
          exists(
            ctx.db
              .select({ one: sql`1` })
              .from(receiptItems)
              .where(
                and(
                  eq(receiptItems.receiptId, receipts.id),
                  eq(receiptItems.categoryId, input.categoryId),
                ),
              ),
          ),
        );
      }

      if (input.cursor) {
        const cursor = input.cursor;
        if (cursor.transactionDate === null) {
          // Already inside the trailing NULL-date bucket.
          conditions.push(
            and(isNull(receipts.transactionDate), lt(receipts.id, cursor.id)) ?? sql`true`,
          );
        } else {
          conditions.push(
            or(
              lt(receipts.transactionDate, cursor.transactionDate),
              and(eq(receipts.transactionDate, cursor.transactionDate), lt(receipts.id, cursor.id)),
              // NULLS LAST: the whole null bucket sorts after any real date.
              isNull(receipts.transactionDate),
            ) ?? sql`true`,
          );
        }
      }

      const rows = await ctx.db
        .select({
          id: receipts.id,
          merchantName: receipts.merchantName,
          transactionDate: receipts.transactionDate,
          transactionTime: receipts.transactionTime,
          total: receipts.total,
          currency: receipts.currency,
          extractionStatus: receipts.extractionStatus,
          extractionError: receipts.extractionError,
          missingFields: receipts.missingFields,
          validationFlags: receipts.validationFlags,
          thumbKey: receipts.thumbKey,
          imageKey: receipts.imageKey,
          uploadedBy: receipts.uploadedBy,
          uploaderDisplayName: users.displayName,
          uploaderFirstName: users.firstName,
          uploaderLastName: users.lastName,
          uploaderEmail: users.email,
          canEdit: canEditSql(ctx.user),
          createdAt: receipts.createdAt,
        })
        .from(receipts)
        // LEFT, not INNER: receipts.uploaded_by is ON DELETE SET NULL, so a
        // receipt can outlive its uploader.
        .leftJoin(users, eq(users.id, receipts.uploadedBy))
        .where(and(...conditions))
        .orderBy(sql`${receipts.transactionDate} DESC NULLS LAST`, desc(receipts.id))
        .limit(input.limit);

      return {
        items: rows.map(toListItem),
        nextCursor:
          rows.length === input.limit && rows.length > 0
            ? {
                transactionDate: rows[rows.length - 1]!.transactionDate,
                id: rows[rows.length - 1]!.id,
              }
            : null,
      };
    }),

  /**
   * Receipt detail (task 7.4). Two statements, and BOTH compose the scope.
   *
   * The tempting shape for the items query is "we already authorized the
   * receipt above, so `WHERE receipt_id = $id` is fine" — that is exactly the
   * scattered permission check CLAUDE.md forbids, and it costs one extra
   * indexed row to not do it.
   */
  get: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select({
        receipt: receipts,
        projectId: projects.id,
        projectName: projects.name,
        projectStatus: projects.status,
        uploaderDisplayName: users.displayName,
        uploaderFirstName: users.firstName,
        uploaderLastName: users.lastName,
        uploaderEmail: users.email,
        canEdit: canEditSql(ctx.user),
      })
      .from(receipts)
      .innerJoin(projects, eq(projects.id, receipts.projectId))
      .leftJoin(users, eq(users.id, receipts.uploadedBy))
      .where(
        and(
          eq(receipts.id, input.id),
          isNull(receipts.deletedAt),
          inArray(receipts.projectId, scopedProjects(ctx.user, "read")),
        ),
      )
      .limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });

    const items = await ctx.db
      .select({
        id: receiptItems.id,
        lineNo: receiptItems.lineNo,
        description: receiptItems.description,
        sku: receiptItems.sku,
        quantity: receiptItems.quantity,
        unitPrice: receiptItems.unitPrice,
        lineTotal: receiptItems.lineTotal,
        aiAssignedCategory: receiptItems.aiAssignedCategory,
        confidence: receiptItems.confidence,
        categoryId: categories.id,
        categoryName: categories.name,
        categoryColor: categories.color,
      })
      .from(receiptItems)
      .innerJoin(receipts, eq(receipts.id, receiptItems.receiptId))
      .leftJoin(categories, eq(categories.id, receiptItems.categoryId))
      .where(
        and(
          eq(receiptItems.receiptId, input.id),
          isNull(receipts.deletedAt),
          // Re-composed deliberately. See the docblock.
          inArray(receipts.projectId, scopedProjects(ctx.user, "read")),
        ),
      )
      .orderBy(asc(receiptItems.lineNo));

    // `extraction_raw` is deliberately not returned: it is scrubbed model
    // output, of no use in the UI, and a needless payload on a phone.
    const { extractionRaw: _extractionRaw, ...receipt } = row.receipt;

    return {
      receipt,
      project: { id: row.projectId, name: row.projectName, status: row.projectStatus },
      uploader: receipt.uploadedBy
        ? {
            id: receipt.uploadedBy,
            name: displayNameOf({
              displayName: row.uploaderDisplayName,
              firstName: row.uploaderFirstName,
              lastName: row.uploaderLastName,
              email: row.uploaderEmail,
            }),
          }
        : null,
      items: items.map((item) => ({
        ...item,
        category: item.categoryId
          ? { id: item.categoryId, name: item.categoryName, color: item.categoryColor }
          : null,
      })),
      permissions: { canEdit: row.canEdit === true },
    };
  }),

  /**
   * The cross-project review queue (task 7.5).
   *
   * Ordered by `created_at`, NOT `transaction_date`. An unread transaction
   * date is one of the eleven missing-field tokens, so ordering the
   * needs-review queue by transaction date would scatter a large share of its
   * own subject matter into the NULL bucket. Upload order is always present
   * and matches how the backlog is actually worked.
   *
   * Gated at `read`, not `add`: a read-only member sees the queue for context
   * and gets `canEdit: false` per row, at no extra query.
   *
   * An empty queue returns an empty list. Task 7.5's acceptance is that the
   * empty state is not an error state, and that has to be true at the API
   * boundary or the UI cannot honour it.
   */
  reviewQueue: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        mineOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.object({ createdAt: z.date(), id: z.string().uuid() }).nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions = [
        isNull(receipts.deletedAt),
        // Never a list of ids fetched into JS and filtered there — scope.ts
        // forbids that shape by name.
        inArray(receipts.projectId, scopedProjects(ctx.user, "read")),
        NEEDS_REVIEW_SQL,
      ];
      if (input.projectId) conditions.push(eq(receipts.projectId, input.projectId));
      if (input.mineOnly) conditions.push(canEditSql(ctx.user));
      if (input.cursor) {
        conditions.push(
          or(
            sql`${receipts.createdAt} > ${input.cursor.createdAt}`,
            and(
              sql`${receipts.createdAt} = ${input.cursor.createdAt}`,
              sql`${receipts.id} > ${input.cursor.id}`,
            ),
          ) ?? sql`true`,
        );
      }

      const rows = await ctx.db
        .select({
          id: receipts.id,
          projectId: receipts.projectId,
          projectName: projects.name,
          merchantName: receipts.merchantName,
          transactionDate: receipts.transactionDate,
          total: receipts.total,
          currency: receipts.currency,
          extractionStatus: receipts.extractionStatus,
          extractionError: receipts.extractionError,
          missingFields: receipts.missingFields,
          validationFlags: receipts.validationFlags,
          thumbKey: receipts.thumbKey,
          canEdit: canEditSql(ctx.user),
          createdAt: receipts.createdAt,
        })
        .from(receipts)
        .innerJoin(projects, eq(projects.id, receipts.projectId))
        .where(and(...conditions))
        .orderBy(asc(receipts.createdAt), asc(receipts.id))
        .limit(input.limit);

      return {
        items: rows.map((row) => ({ ...row, canEdit: row.canEdit === true })),
        nextCursor:
          rows.length === input.limit && rows.length > 0
            ? { createdAt: rows[rows.length - 1]!.createdAt, id: rows[rows.length - 1]!.id }
            : null,
      };
    }),

  /**
   * Edit any extracted field (task 7.4).
   *
   * `currency` is deliberately NOT editable. D-17 keeps the column and defers
   * the UI; exposing it here would be a currency picker admitted by the back
   * door, and project totals sum without regard to currency.
   *
   * Acceptance criterion for 7.4 is "editing clears the field from
   * missing_fields", which is step 3 below. Filling a field also clears any
   * dismissal of it — a real value supersedes "this one is genuinely blank",
   * or the next re-extract would suppress a field the user has since filled.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        merchantName: nullableText(500).optional(),
        merchantAddress: nullableText(1000).optional(),
        merchantPhone: nullableText(100).optional(),
        transactionDate: receiptDateString.nullable().optional(),
        transactionTime: receiptTimeString.nullable().optional(),
        subtotal: moneyString.nullable().optional(),
        salesTax: moneyString.nullable().optional(),
        tip: moneyString.nullable().optional(),
        total: moneyString.nullable().optional(),
        cardLast4: cardLast4String.nullable().optional(),
        paymentMethod: nullableText(200).optional(),
        userNotes: nullableText(10_000).optional(),
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
        const access = await loadEditableReceipt(tx, id, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);
        const { receipt } = access;

        // CLAUDE.md's scrub rule is written about model output, but this
        // procedure accepts free text straight from a person, and a card
        // number pasted into the notes field is the same hazard by a
        // different route. Applied to the whole patch so no future field
        // added above can quietly skip it.
        const { scrubbed: patch, redactions } = scrubLuhnSequences(
          supplied as Record<string, unknown>,
        );

        const missing = new Set(receipt.missingFields);
        const dismissed = new Set(receipt.dismissedFields);

        for (const column of changed) {
          const token = MISSING_FIELD_BY_COLUMN[column as EditableReceiptColumn];
          if (!token) continue; // tip and userNotes have no token
          const value = (patch as Record<string, unknown>)[column];
          if (value === null || value === undefined) {
            // Cleared. It is missing again — unless the user has said it is
            // deliberately blank.
            if (!dismissed.has(token)) missing.add(token);
          } else {
            missing.delete(token);
            dismissed.delete(token);
          }
        }

        await tx
          .update(receipts)
          .set({
            ...(patch as Partial<typeof receipts.$inferInsert>),
            missingFields: [...missing],
            dismissedFields: [...dismissed],
            updatedAt: new Date(),
          })
          .where(eq(receipts.id, receipt.id));

        // Recomputes validation_flags, extraction_status, the `items` token
        // and reviewed_at from the row as it now stands. Without this, a user
        // who corrects a mistyped total keeps the arithmetic_mismatch_total
        // badge forever.
        await recomputeReceiptDerivedState(tx, receipt.id);

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt.updated",
          entityType: "receipt",
          entityId: receipt.id,
          // Field NAMES only, never values: the values include card_last4, a
          // merchant address, and free-text notes. audit.ts's standing rule is
          // that a row names the identity, not the person.
          metadata: {
            fields: changed,
            via: "receipts.update",
            ...(redactions ? { redactions } : {}),
          },
        });
        await auditOwnerOverrideIfApplicable(
          tx,
          ctx.user,
          access.project,
          "receipt.updated",
          "receipts.update",
        );

        return selectEditableReceipt(tx, receipt.id);
      });
    }),

  /**
   * Mark a missing field as intentionally blank, so the review badge clears
   * ("this receipt genuinely has no phone number").
   *
   * A distinct procedure rather than a mode of `update` for three reasons:
   * its input is a token rather than a field value; its audit action is a
   * different kind of statement (a user assertion about reality, not a data
   * correction); and folding it in would need a sentinel value meaning "null,
   * but on purpose", which is precisely the ambiguity `dismissed_fields`
   * exists to remove.
   *
   * Idempotent — dismissing an already-dismissed field is a no-op, not an
   * error, matching `projects.archive`'s convention.
   */
  dismissMissingField: protectedProcedure
    .input(z.object({ id: z.string().uuid(), field: z.enum(MISSING_FIELD_TOKENS) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const access = await loadEditableReceipt(tx, input.id, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);
        const { receipt } = access;

        const dismissed = new Set(receipt.dismissedFields);
        const missing = new Set(receipt.missingFields);
        if (dismissed.has(input.field) && !missing.has(input.field)) return receipt;

        missing.delete(input.field);
        dismissed.add(input.field);

        await tx
          .update(receipts)
          .set({
            missingFields: [...missing],
            dismissedFields: [...dismissed],
            updatedAt: new Date(),
          })
          .where(eq(receipts.id, receipt.id));

        await recomputeReceiptDerivedState(tx, receipt.id);

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt.field_dismissed",
          entityType: "receipt",
          entityId: receipt.id,
          metadata: { field: input.field, via: "receipts.dismissMissingField" },
        });

        return selectEditableReceipt(tx, receipt.id);
      });
    }),

  /**
   * Acknowledges a validation flag: "I have looked at this and the receipt
   * really does say that."
   *
   * `dismissMissingField`'s counterpart for `validation_flags`, and it exists
   * because there was no way at all to clear one. A flag could only be removed
   * by editing the numbers until they agreed — which, on a receipt that
   * genuinely does not reconcile, means inventing data that is not on the
   * paper. Until then such a receipt sat in the review queue permanently with
   * a warning nobody could act on.
   *
   * The case that forced it: a discounted receipt whose printed subtotal
   * already has the discount applied, read by a model that subtracts it again.
   * `arithmetic_mismatch_items` is correct arithmetic over wrong input, and the
   * user cannot fix the input.
   *
   * Removing the flag is not enough on its own — `runSanityChecks` would put it
   * straight back on the next recompute, so the acknowledgement is recorded and
   * subtracted there (`acknowledgedFlags`), which is also what lets
   * `extraction_status` fall back to `ok` and the receipt leave the queue.
   *
   * Idempotent, matching `dismissMissingField`.
   */
  acknowledgeValidationFlag: protectedProcedure
    .input(z.object({ id: z.string().uuid(), flag: z.enum(VALIDATION_FLAGS) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const access = await loadEditableReceipt(tx, input.id, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);
        const { receipt } = access;

        const acknowledged = new Set(receipt.acknowledgedFlags);
        const flags = new Set(receipt.validationFlags);
        if (acknowledged.has(input.flag) && !flags.has(input.flag)) return receipt;

        acknowledged.add(input.flag);

        await tx
          .update(receipts)
          .set({ acknowledgedFlags: [...acknowledged], updatedAt: new Date() })
          .where(eq(receipts.id, receipt.id));

        // Not a hand-edit of `validation_flags` — the recompute subtracts the
        // acknowledgement and re-derives both the flags and the status from
        // one rule. Writing the array here as well would be a second place for
        // that rule to live, and the two would eventually disagree.
        await recomputeReceiptDerivedState(tx, receipt.id);

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt.flag_acknowledged",
          entityType: "receipt",
          entityId: receipt.id,
          metadata: { flag: input.flag, via: "receipts.acknowledgeValidationFlag" },
        });

        return selectEditableReceipt(tx, receipt.id);
      });
    }),

  /** The mirror of `acknowledgeValidationFlag`. The flag comes back only if the
   *  numbers still fail the check — the recompute decides that, not this. */
  unacknowledgeValidationFlag: protectedProcedure
    .input(z.object({ id: z.string().uuid(), flag: z.enum(VALIDATION_FLAGS) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const access = await loadEditableReceipt(tx, input.id, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);
        const { receipt } = access;

        const acknowledged = new Set(receipt.acknowledgedFlags);
        if (!acknowledged.has(input.flag)) return receipt;
        acknowledged.delete(input.flag);

        await tx
          .update(receipts)
          .set({ acknowledgedFlags: [...acknowledged], updatedAt: new Date() })
          .where(eq(receipts.id, receipt.id));

        await recomputeReceiptDerivedState(tx, receipt.id);

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt.flag_unacknowledged",
          entityType: "receipt",
          entityId: receipt.id,
          metadata: { flag: input.flag, via: "receipts.unacknowledgeValidationFlag" },
        });

        return selectEditableReceipt(tx, receipt.id);
      });
    }),

  /** The mirror of `dismissMissingField`. Without it a mis-dismissal is
   *  unrecoverable through the UI. */
  undismissMissingField: protectedProcedure
    .input(z.object({ id: z.string().uuid(), field: z.enum(MISSING_FIELD_TOKENS) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const access = await loadEditableReceipt(tx, input.id, ctx.user);
        assertMayEditReceipt(access, ctx.user.id);
        const { receipt } = access;

        const dismissed = new Set(receipt.dismissedFields);
        if (!dismissed.has(input.field)) return receipt;
        dismissed.delete(input.field);

        const missing = new Set(receipt.missingFields);
        // Only re-raise the badge if the field is in fact still empty.
        const column = (Object.keys(MISSING_FIELD_BY_COLUMN) as EditableReceiptColumn[]).find(
          (key) => MISSING_FIELD_BY_COLUMN[key] === input.field,
        );
        const stillEmpty = column ? receipt[column] === null : true;
        if (stillEmpty) missing.add(input.field);

        await tx
          .update(receipts)
          .set({
            missingFields: [...missing],
            dismissedFields: [...dismissed],
            updatedAt: new Date(),
          })
          .where(eq(receipts.id, receipt.id));

        await recomputeReceiptDerivedState(tx, receipt.id);

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "receipt.field_undismissed",
          entityType: "receipt",
          entityId: receipt.id,
          metadata: { field: input.field, via: "receipts.undismissMissingField" },
        });

        return selectEditableReceipt(tx, receipt.id);
      });
    }),

  /**
   * Soft delete only, matching `projects.delete`'s own convention
   * (CLAUDE.md: nothing is ever hard deleted). Gated at "add" (`read_add`
   * floor) -- `docs/SCHEMA.md`'s permission matrix makes add/edit/delete a
   * `read_add`-level capability restricted to "own only", not a `manage`
   * ceiling. The "own only" restriction is an escalation guard *beyond*
   * that gate, mirroring `members.ts`'s pattern: `scopedProjects`
   * authorizes the project, a further check decides which row within it.
   *
   * Ordering, review finding M-4: the receipt row is read WITHOUT a lock
   * first, purely to learn its `projectId` -- `lockScopedProject` (which
   * does its own check -> lock -> recheck against `projects`) runs BEFORE
   * any lock is taken on the `receipts` row itself. An earlier version
   * locked the receipt first, ahead of authorization, reintroducing
   * exactly the timing oracle / connection-pinning problem `scope.ts`'s
   * own doc comment describes at length for the reason `lockScopedProject`
   * exists: an unauthorized caller could queue on a lock for a row they
   * have no rights to. Taking the `projects` lock (even without writing to
   * it) still serializes this mutation against a concurrent
   * `members.remove`/`updatePermission` on the same project, which also
   * calls `lockScopedProject` -- so the double-delete/stale-authorization
   * race that lock exists to prevent is still closed, just without ever
   * locking a row before proving the caller is allowed to touch it.
   */
  delete: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const result = await ctx.db.transaction(async (tx) => {
      // The whole gate — precheck, lockScopedProject("add"), locked re-read,
      // in-transaction role re-read — now lives in receiptAccess.ts. The
      // ordering guarantees this procedure's original comment described are
      // documented there; this call site is not free to reorder them.
      const access = await loadEditableReceipt(tx, input.id, ctx.user);
      assertMayEditReceipt(access, ctx.user.id);
      const { receipt } = access;

      await tx
        .update(receipts)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(receipts.id, receipt.id));

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "receipt.deleted",
        entityType: "receipt",
        entityId: receipt.id,
        metadata: { via: "receipts.delete" },
      });

      return receipt;
    });

    // Only AFTER the transaction commits -- deleting files first and then
    // failing to commit would be data loss (images gone for a receipt
    // that visually never got deleted); this ordering makes a failure
    // here merely an orphaned directory, logged, never fatal to the
    // mutation (storage.ts's deleteReceiptDir doc comment).
    try {
      await deleteReceiptDir(getEnv().UPLOADS_DIR, result.projectId, result.id);
    } catch (error) {
      console.error(`[ledgerly] failed to delete image directory for receipt ${result.id}:`, error);
    }

    return { id: result.id };
  }),

  /**
   * Manual re-extract (Phase 6): forces the Sonnet path directly, skipping
   * Haiku and the escalation ladder entirely — CLAUDE.md's "manual
   * re-extract action ... which lets the user force the Sonnet path."
   * `pipeline/extract.ts`'s `forcePass2` job-data flag is what a receipt
   * ALREADY marked `extraction_status='ok'` needs to bypass the
   * idempotency no-op that would otherwise skip it; there is no DB column
   * for "force" (it's job data, not persisted state), so this procedure
   * does no DB update of its own beyond the audit row — the extract
   * worker overwrites every extracted field on completion regardless of
   * what they held before.
   *
   * Same gate/escalation-guard shape as `delete` (`"add"` scope,
   * own-only-unless-full-or-owner) — re-extraction is an edit action, not
   * a `manage`-level one. The escalation guard runs BEFORE the
   * imageKey/"still processing" check (review finding L-1) — otherwise a
   * `read_add` member could distinguish "not mine" (FORBIDDEN) from
   * "someone else's, still processing" (BAD_REQUEST) for a receipt they
   * have no rights to, a narrow existence-shaped oracle the ordering
   * closes.
   *
   * Review finding M-3: gated behind `checkReextractRateLimit` (10/min per
   * user) — every call forces a paid Sonnet 5 pass, the escalation
   * ladder's only directly user-triggerable branch, otherwise unmetered
   * unlike the upload path.
   */
  reextract: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    if (ctx.rateLimitRedis) {
      const rateLimit = await checkReextractRateLimit(ctx.rateLimitRedis, ctx.user.id);
      if (!rateLimit.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Too many re-extract requests. Try again in ${rateLimit.retryAfterSeconds}s.`,
        });
      }
    } else {
      // Never crash the mutation over a missing capability (e.g. a test
      // context) -- but this is a spend guard, not a soft feature, so it
      // gets a louder signal than enqueueReceiptExtract's warning below.
      console.warn(
        "[ledgerly] receipts.reextract: no rateLimitRedis in context, limit not enforced",
      );
    }

    const receiptId = await ctx.db.transaction(async (tx) => {
      // Escalation guard FIRST, before the imageKey check below — review
      // finding L-1. Reversed, a `read_add` member could tell "not mine"
      // (FORBIDDEN) apart from "someone else's, still processing"
      // (BAD_REQUEST) for a receipt they have no rights to. Extracting the
      // gate does not change that ordering; it is still this call site's
      // responsibility to run it before anything that can distinguish
      // receipt states.
      const access = await loadEditableReceipt(tx, input.id, ctx.user);
      assertMayEditReceipt(access, ctx.user.id);
      const { receipt } = access;

      if (!receipt.imageKey) {
        // No render yet -- ingest hasn't finished (or failed). Nothing
        // for the extract pipeline to read; regenerateExtractionRender
        // would just fail.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This receipt has not finished processing yet.",
        });
      }

      // Review finding M-2: `receipt-extract` jobs use `jobId: receiptId`
      // for dedup (queue.ts). While a job for this receipt is still
      // waiting/active/delayed (an automatic run mid-retry-backoff, or a
      // near-simultaneous double click), re-adding the same jobId is a
      // silent no-op — the `forcePass2` flag below would be dropped with
      // no error. Setting `extraction_status='pending'` here closes that
      // two ways: it makes the collision harmless to observe (the receipt
      // visibly goes back to pending regardless of whether the enqueue
      // below actually started a NEW job), and it makes `worker.ts`'s
      // startup reconciliation sweep a genuine backstop -- that sweep
      // only ever picks up `pending` receipts, so leaving the row at its
      // prior `ok`/`partial` status would make this receipt permanently
      // unreachable by the sweep if the enqueue silently no-op'd.
      await tx
        .update(receipts)
        .set({ extractionStatus: "pending", extractionError: null, updatedAt: new Date() })
        .where(eq(receipts.id, receipt.id));

      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "receipt.reextract_requested",
        entityType: "receipt",
        entityId: receipt.id,
        metadata: { via: "receipts.reextract" },
      });

      return receipt.id;
    });

    if (ctx.enqueueReceiptExtract) {
      await ctx.enqueueReceiptExtract({ receiptId, forcePass2: true });
    } else {
      // Never crash the mutation over a missing capability (e.g. a test
      // context, or `createCallerFactory` used without wiring it) -- the
      // audit row and authorization already committed, and the row is now
      // `pending`, so the startup reconciliation sweep is a real backstop
      // (see the comment above) rather than a receipt stuck unreachable.
      console.warn(
        `[ledgerly] receipts.reextract: no enqueueReceiptExtract in context, ` +
          `receipt ${receiptId} was authorized but not enqueued`,
      );
    }

    return { id: receiptId };
  }),

  /**
   * Emails one receipt on demand (D-44), regardless of the project's
   * `email_receipts` setting.
   *
   * ## The recipient is a user id, never an address
   *
   * `toUserId` must be a member of the receipt's project — checked here, and
   * checked AGAIN in the worker (`pipeline/email.ts`), because this is the
   * one procedure in the app that causes financial data to leave the system
   * to a destination the caller chose. A free-text address field would make
   * "mail this receipt anywhere" a supported operation of the API; with a
   * user id it is not merely rejected, it is unrepresentable.
   *
   * The caller must be able to READ the receipt. Deliberately read, not edit:
   * a read-only member forwarding a receipt to a fellow member discloses
   * nothing either of them could not already see.
   *
   * ## It enqueues, it does not send
   *
   * `nodemailer` lives in `packages/queue`. This procedure hands the queue a
   * receipt id and a user id and returns; the render, the SMTP connection and
   * the retries all happen out of band. A relay that is slow must not hold a
   * request open, and a relay that is down must not turn a click into an
   * error the user is expected to interpret.
   */
  emailReceipt: protectedProcedure
    .input(z.object({ id: z.string().uuid(), toUserId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.rateLimitRedis) {
        const limit = await checkEmailReceiptRateLimit(ctx.rateLimitRedis, ctx.user.id);
        if (!limit.allowed) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `Too many emails. Try again in ${limit.retryAfterSeconds}s.`,
          });
        }
      } else {
        console.warn(
          "[ledgerly] receipts.emailReceipt: no rateLimitRedis in context, limit not enforced",
        );
      }

      // Checked BEFORE the transaction, and before anything is audited.
      //
      // The worker is where the transport actually lives, so without this the
      // procedure happily reports "queued" on an instance with no relay
      // configured and the message dies in a worker log line the caller
      // cannot see — non-owners cannot read `admin.smtp` at all. One indexed
      // read and a decrypt, on a path already capped at 5/min.
      const smtp = await resolveSmtpConfig(ctx.db, getEnv().MASTER_KEY);
      if (smtp.source === "undecryptable") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Email settings are stored but unreadable. Ask the instance owner to re-enter them.",
        });
      }
      if (!smtp.config) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Email is not set up on this instance.",
        });
      }

      const recipientId = await ctx.db.transaction(async (tx) => {
        // The receipt, scoped. `scopedProjects` is composed INTO the query
        // (CLAUDE.md's query-layer rule) rather than checked beside it.
        const [row] = await tx
          .select({ id: receipts.id, projectId: receipts.projectId, ownerId: projects.ownerId })
          .from(receipts)
          .innerJoin(projects, eq(projects.id, receipts.projectId))
          .where(
            and(
              eq(receipts.id, input.id),
              isNull(receipts.deletedAt),
              inArray(receipts.projectId, scopedProjects(ctx.user, "read")),
            ),
          )
          .limit(1);
        // NOT_FOUND rather than FORBIDDEN: a caller with no access to this
        // project must not be able to learn the receipt exists.
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });

        // The owner is a member by definition and has no `project_members`
        // row; everyone else must have one.
        if (input.toUserId !== row.ownerId) {
          const [membership] = await tx
            .select({ userId: projectMembers.userId })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, row.projectId),
                eq(projectMembers.userId, input.toUserId),
              ),
            )
            .limit(1);
          if (!membership) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "That person is not a member of this project.",
            });
          }
        }

        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          // `_requested`, not `.emailed`, and the distinction is the point:
          // this row commits before the job is queued and long before anything
          // is delivered, so a row asserting "emailed" would assert an effect
          // that had not happened — the same defect `clearAiKey` was fixed
          // for. It records the authorised request, which is exactly what
          // occurred here. Matches `receipt.reextract_requested`'s convention.
          action: "receipt.email_requested",
          entityType: "receipt",
          entityId: row.id,
          // The recipient is recorded as an ID, not an address — audit.ts's
          // no-PII rule. "Who did this leave to" is answerable by joining to
          // `users`, which is the same disclosure boundary every other row
          // here respects.
          metadata: { via: "receipts.emailReceipt", toUserId: input.toUserId },
        });

        return input.toUserId;
      });

      if (!ctx.enqueueReceiptEmail) {
        // Same policy as `reextract`: never crash a mutation over a missing
        // capability (a test context, or `createCallerFactory` used without
        // wiring it). The audit row says "requested", which remains true.
        console.warn(
          `[ledgerly] receipts.emailReceipt: no enqueueReceiptEmail in context, ` +
            `receipt ${input.id} was authorized but not enqueued`,
        );
        return { ok: true as const, queued: false as const };
      }

      try {
        await ctx.enqueueReceiptEmail({
          receiptId: input.id,
          toUserId: recipientId,
          requestedBy: ctx.user.id,
        });
      } catch (error) {
        // A capability that EXISTS and FAILS is a different case from one that
        // is absent, and it must not reach the client as the errorFormatter's
        // flat "Internal server error." — that reads as a bug, when the true
        // statement is "nothing was sent, try again". Logged at the same
        // volume as the branch above so the committed audit row can be
        // reconciled against reality.
        console.error(
          `[ledgerly] receipts.emailReceipt: enqueue failed for receipt ${input.id} ` +
            `(the request was authorized and audited, but nothing was queued):`,
          error,
        );
        // SERVICE_UNAVAILABLE, not INTERNAL_SERVER_ERROR: the latter is
        // outside `CLIENT_SAFE_CODES`, so its message would be replaced with
        // the flat "Internal server error." and the one fact worth conveying —
        // that nothing was sent — would be lost.
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Couldn't queue the email. Nothing was sent — try again.",
        });
      }

      return { ok: true as const, queued: true as const };
    }),
});

/** Shapes a list row, collapsing the four uploader columns into one name. */
function toListItem<
  T extends {
    uploaderDisplayName: string | null;
    uploaderFirstName: string | null;
    uploaderLastName: string | null;
    uploaderEmail: string | null;
    uploadedBy: string | null;
    canEdit: unknown;
  },
>(row: T) {
  const { uploaderDisplayName, uploaderFirstName, uploaderLastName, uploaderEmail, ...rest } = row;
  return {
    ...rest,
    canEdit: row.canEdit === true,
    uploaderName: row.uploadedBy
      ? displayNameOf({
          displayName: uploaderDisplayName,
          firstName: uploaderFirstName,
          lastName: uploaderLastName,
          email: uploaderEmail,
        })
      : null,
  };
}

/**
 * The row shape the three edit mutations return.
 *
 * `extraction_raw` is deliberately excluded, matching `receipts.get`: it is
 * scrubbed model output, of no use in the UI, and shipping it back on every
 * blur-committed field edit is a real payload on a phone over a tunnel.
 * Returned by an explicit projection rather than a `select()` + delete, so a
 * column added to the table later is not silently included.
 */
async function selectEditableReceipt(tx: Tx, receiptId: string) {
  const [row] = await tx
    .select({
      id: receipts.id,
      projectId: receipts.projectId,
      uploadedBy: receipts.uploadedBy,
      merchantName: receipts.merchantName,
      merchantAddress: receipts.merchantAddress,
      merchantPhone: receipts.merchantPhone,
      transactionDate: receipts.transactionDate,
      transactionTime: receipts.transactionTime,
      subtotal: receipts.subtotal,
      salesTax: receipts.salesTax,
      tip: receipts.tip,
      total: receipts.total,
      currency: receipts.currency,
      cardLast4: receipts.cardLast4,
      paymentMethod: receipts.paymentMethod,
      imageKey: receipts.imageKey,
      thumbKey: receipts.thumbKey,
      originalKey: receipts.originalKey,
      extractionStatus: receipts.extractionStatus,
      extractionModel: receipts.extractionModel,
      extractionPass: receipts.extractionPass,
      extractionConfidence: receipts.extractionConfidence,
      extractionError: receipts.extractionError,
      missingFields: receipts.missingFields,
      validationFlags: receipts.validationFlags,
      dismissedFields: receipts.dismissedFields,
      acknowledgedFlags: receipts.acknowledgedFlags,
      userNotes: receipts.userNotes,
      reviewedAt: receipts.reviewedAt,
      createdAt: receipts.createdAt,
      updatedAt: receipts.updatedAt,
    })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .limit(1);
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  return row;
}
