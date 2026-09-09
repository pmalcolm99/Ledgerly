import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@ledgerly/db/schema";
import { isOnboarded } from "@ledgerly/auth";

import { THEMES } from "@ledgerly/shared/themes";

import { onboardingProcedure, protectedProcedure, router } from "../trpc";

/** Derived from the theme table so a removed theme immediately stops being
 *  settable, rather than lingering as a value only this file accepts. */
const THEME_IDS = THEMES.map((entry) => entry.id) as unknown as [string, ...string[]];

/**
 * packages/api/src/routers/auth.ts — the onboarding surface (task 3.8).
 *
 * `me` and `completeOnboarding` are `onboardingProcedure`, the explicit
 * opt-out from the onboarding requirement (D-28). Those two are still the
 * only members that gate is expected to have; adding a third to IT is the
 * review trigger.
 *
 * `setTheme` (Phase 7) is deliberately not one of them. It is an ordinary
 * `protectedProcedure`, so it requires completed onboarding like everything
 * else: someone who has not told us their name yet has no business setting a
 * preference, and routing it through the default gate keeps the exemption
 * list at exactly two.
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

  /**
   * Theme preference. Read back server-side in the root layout and applied as
   * a class on <html>, which is what avoids a flash of the default theme on
   * every navigation (FORKD_UI.md's item 5).
   *
   */
  setTheme: protectedProcedure
    .input(z.object({ theme: z.enum(THEME_IDS) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(users)
        .set({ theme: input.theme, updatedAt: new Date() })
        .where(eq(users.id, ctx.user.id));
      return { theme: input.theme };
    }),
});
