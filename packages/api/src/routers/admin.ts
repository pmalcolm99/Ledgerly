import "server-only";

import { eq, gte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { aiUsage as aiUsageTable, auditLog, users } from "@ledgerly/db/schema";

import { isUniqueViolation } from "../errors";
import { ownerProcedure, router } from "../trpc";

/**
 * $/MTok, matched by substring against `model` (same convention as
 * `pipeline/anthropicRequest.ts`'s capability table — the configured
 * `AI_MODEL_PASS1`/`AI_MODEL_PASS2` are free-text, re-pointable without a
 * code change). D-12's corrected, non-introductory rates. An unrecognized
 * model (e.g. re-pointed at something not in this table) reports `null`
 * cost rather than a silently wrong number.
 */
const PRICING_PER_MTOK: { match: string; input: number; output: number }[] = [
  { match: "haiku", input: 1.0, output: 5.0 },
  { match: "sonnet", input: 3.0, output: 15.0 },
];

function priceForModel(model: string): { input: number; output: number } | null {
  return PRICING_PER_MTOK.find((p) => model.includes(p.match)) ?? null;
}

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

  /**
   * Task 6.10: spend and the pass-1 -> pass-2 escalation rate, per D-12.
   * No UI page consumes this yet — `apps/web/src/app/admin/` doesn't exist
   * until Phase 7 (HeroUI/Tailwind setup is task 7.1) — this procedure is
   * the "admin view" data itself, queryable and tested now; Phase 7 wires
   * a page to it.
   *
   * `escalationRate` is `count(escalated=true) / count(pass=1)` — D-12's
   * literal definition (the automatic ladder), deliberately excluding
   * `receipts.reextract`'s manual force-Sonnet calls (`escalated: false`,
   * `pass: 2`), which aren't ladder escalations and would otherwise skew
   * the rate the ~45% threshold is measured against.
   */
  aiUsage: ownerProcedure
    .input(
      // L-5: bounded (10 years) so a caller can't construct an
      // out-of-range `Date` and turn this into a raw 500.
      z.object({ sinceDays: z.number().int().positive().max(3650).default(30) }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - (input?.sinceDays ?? 30) * 24 * 60 * 60 * 1000);
      const rows = await ctx.db
        .select({
          model: aiUsageTable.model,
          pass: aiUsageTable.pass,
          escalated: aiUsageTable.escalated,
          ok: aiUsageTable.ok,
          inputTokens: aiUsageTable.inputTokens,
          outputTokens: aiUsageTable.outputTokens,
        })
        .from(aiUsageTable)
        .where(gte(aiUsageTable.createdAt, since));

      const byModel = new Map<
        string,
        { calls: number; ok: number; inputTokens: number; outputTokens: number }
      >();
      let pass1Count = 0;
      let escalatedCount = 0;

      for (const row of rows) {
        const entry = byModel.get(row.model) ?? {
          calls: 0,
          ok: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        entry.calls += 1;
        if (row.ok) entry.ok += 1;
        entry.inputTokens += row.inputTokens;
        entry.outputTokens += row.outputTokens;
        byModel.set(row.model, entry);

        if (row.pass === 1) pass1Count += 1;
        if (row.escalated) escalatedCount += 1;
      }

      const models = [...byModel.entries()].map(([model, stats]) => {
        const price = priceForModel(model);
        // L-5: a deliberate exception to D-21's "money is integer cents
        // via packages/shared/money.ts, never a float" rule -- this is a
        // display-only spend *estimate* derived from token counts and a
        // hardcoded price table, not a stored or billed monetary amount,
        // so float precision here is an acceptable, intentional trade.
        const costUsd = price
          ? (stats.inputTokens / 1_000_000) * price.input +
            (stats.outputTokens / 1_000_000) * price.output
          : null;
        return { model, ...stats, costUsd };
      });

      return {
        sinceDays: input?.sinceDays ?? 30,
        totalCalls: rows.length,
        totalCostUsd: models.every((m) => m.costUsd !== null)
          ? models.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
          : null,
        escalationRate: pass1Count > 0 ? escalatedCount / pass1Count : null,
        models,
      };
    }),
});
