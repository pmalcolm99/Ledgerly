import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@ledgerly/db/schema";
import { isOnboarded } from "@ledgerly/auth";

import { onboardingProcedure, router } from "../trpc";

/**
 * packages/api/src/routers/auth.ts — the onboarding surface (task 3.8).
 *
 * Both procedures here are `onboardingProcedure`, the explicit opt-out from
 * the onboarding requirement (D-28). These are the only two members it is
 * ever expected to have; adding a third is a review trigger.
 */

export const authRouter = router({
  me: onboardingProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    firstName: ctx.user.firstName,
    lastName: ctx.user.lastName,
    displayName: ctx.user.displayName,
    role: ctx.user.role,
    theme: ctx.user.theme,
    onboarded: isOnboarded(ctx.user),
  })),

  completeOnboarding: onboardingProcedure
    .input(
      z.object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // `onboarded_at` is written in the SAME statement as the names, so
      // "either name is null" and "onboarded_at is null" cannot disagree.
      const [updated] = await ctx.db
        .update(users)
        .set({
          firstName: input.firstName,
          lastName: input.lastName,
          onboardedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, ctx.user.id))
        .returning();

      return { onboarded: updated ? isOnboarded(updated) : false };
    }),
});
