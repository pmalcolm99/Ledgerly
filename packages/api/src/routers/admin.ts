import "server-only";

import { eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { auditLog, users } from "@ledgerly/db/schema";

import { isUniqueViolation } from "../errors";
import { ownerProcedure, router } from "../trpc";

/**
 * packages/api/src/routers/admin.ts — owner-only actions (task 3.7).
 */

const CF_ACCESS_SUB_UNIQUE_INDEX = "users_cf_access_sub_key";

export const adminRouter = router({
  /**
   * Re-link an account (D-06). Reassigns a `cf_access_sub` onto an existing
   * `users` row matched by email — the supported remedy when the Cloudflare
   * Access identity provider changes and a returning user arrives with a
   * new `sub`.
   *
   * This is the deliberate, audited, owner-gated version of the thing
   * `ACCESS_ALLOW_SUB_RELINK` does automatically and temporarily (D-27).
   * Both exist because the env flag covers the case where *everyone*
   * — including the owner — is locked out and this action is unreachable.
   */
  relinkAccount: ownerProcedure
    .input(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        newCfAccessSub: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The whole mutation is one transaction with the target row locked.
      // Read-then-write without it races two concurrent owner calls — or
      // one owner call against a normal login provisioning the same sub —
      // into an unhandled 23505, and leaves the audit row able to claim a
      // relink that did not happen. Found in the task 3.12 review.
      return ctx.db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${input.email}`)
          .limit(1)
          .for("update");

        if (!target) throw new TRPCError({ code: "NOT_FOUND" });

        const [conflict] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.cfAccessSub, input.newCfAccessSub))
          .limit(1);

        if (conflict && conflict.id !== target.id) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "That identity is already linked to a different account.",
          });
        }

        const previousSub = target.cfAccessSub;

        let updatedId: string;
        try {
          const [updated] = await tx
            .update(users)
            .set({ cfAccessSub: input.newCfAccessSub, updatedAt: new Date() })
            .where(eq(users.id, target.id))
            .returning();
          updatedId = updated?.id ?? target.id;
        } catch (error) {
          // Another transaction claimed this sub between the check above
          // and here. Surface it as CONFLICT rather than letting a raw
          // constraint name escape.
          if (isUniqueViolation(error, CF_ACCESS_SUB_UNIQUE_INDEX)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "That identity is already linked to a different account.",
            });
          }
          throw error;
        }

        await tx.insert(auditLog).values({
          actorUserId: ctx.user.id,
          action: "user.sub_relinked",
          entityType: "user",
          entityId: target.id,
          // No email here: the audit row names the identity, not the person.
          metadata: { previousSub, newSub: input.newCfAccessSub, via: "admin.relinkAccount" },
        });

        return { userId: updatedId };
      });
    }),
});
