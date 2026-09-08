import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getEnv } from "@ledgerly/config/env";
import { projectMembers, receipts, users } from "@ledgerly/db/schema";

import { recordAudit } from "../audit";
import { lockScopedProject } from "../scope";
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
      // Unlocked -- only to learn projectId. A second delete on an
      // already-deleted (or nonexistent) receipt is NOT_FOUND, not an
      // idempotent no-op, same convention `projects.delete` uses via
      // scopedProjects's liveness predicate.
      const [precheck] = await tx
        .select({ projectId: receipts.projectId })
        .from(receipts)
        .where(and(eq(receipts.id, input.id), isNull(receipts.deletedAt)))
        .limit(1);
      if (!precheck) throw new TRPCError({ code: "NOT_FOUND" });

      const project = await lockScopedProject(tx, precheck.projectId, ctx.user, "add");

      // Re-read now that the project lock is held: closes the window
      // between the precheck above and this lock (a concurrent delete of
      // the SAME receipt would itself need this same project lock, per
      // this file's own convention, so by the time we hold it any such
      // delete has either already committed -- visible here -- or is
      // blocked behind us).
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, input.id), isNull(receipts.deletedAt)))
        .limit(1);
      if (!receipt) throw new TRPCError({ code: "NOT_FOUND" });

      // M-5: re-read the caller's OWN role inside the transaction rather
      // than trusting `ctx.user.role`, which was resolved from the JWT at
      // request entry -- stale if a concurrent admin action demoted this
      // user between then and now. Cheap (one indexed row), and it means
      // the escalation guard below depends on nothing resolved outside
      // this transaction's own snapshot.
      const [caller] = await tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, ctx.user.id));
      const isInstanceOwner = caller?.role === "owner";
      const isProjectOwner = project.ownerId === ctx.user.id;
      if (!isInstanceOwner && !isProjectOwner) {
        const [membership] = await tx
          .select({ permission: projectMembers.permission })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, receipt.projectId),
              eq(projectMembers.userId, ctx.user.id),
            ),
          )
          .limit(1);
        const callerIsFull = membership?.permission === "full";
        if (!callerIsFull && receipt.uploadedBy !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
      }

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
});
