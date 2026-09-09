import "server-only";

import { asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  aiUsage as aiUsageTable,
  auditLog,
  backups,
  projectMembers,
  projects,
  receipts,
  users,
} from "@ledgerly/db/schema";
import { displayNameOf } from "@ledgerly/shared/personName";

import { isUniqueViolation } from "../errors";
import { NEEDS_REVIEW_SQL } from "../receiptAccess";
import { scopedProjects } from "../scope";
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

  /**
   * The instance overview (Phase 7 admin screen).
   *
   * `ownerProcedure` already restricts this to the instance owner, and
   * `scopedProjects` short-circuits an owner to every live project — so
   * composing it here is byte-identical in result and free in cost. It is
   * composed anyway, and that is the point: writing a bare unscoped
   * `select * from projects` would put the ONLY enforcement in the procedure
   * ladder, so a future refactor of `ownerProcedure` would silently open this
   * up with nothing in the query to notice. CLAUDE.md's rule is that every
   * project query composes the scope, with no exception carved for the
   * screens where it happens to be a no-op.
   *
   * Soft-deleted projects stay excluded — `scopedProjects` excludes them at
   * every level, and adding an `includeDeleted` bypass would be exactly the
   * second authorization path scope.ts warns against.
   */
  overview: ownerProcedure.query(async ({ ctx }) => {
    const projectRows = await ctx.db
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        createdAt: projects.createdAt,
        archivedAt: projects.archivedAt,
        ownerId: users.id,
        ownerDisplayName: users.displayName,
        ownerFirstName: users.firstName,
        ownerLastName: users.lastName,
        ownerEmail: users.email,
        receiptCount: sql<number>`(
          select count(*)::int from ${receipts}
          where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
        )`,
        needsReviewCount: sql<number>`(
          select count(*)::int from ${receipts}
          where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
            and ${NEEDS_REVIEW_SQL}
        )`,
        totalSpend: sql<string>`(
          select coalesce(sum("receipts"."total"), 0)::numeric(12,2)::text from ${receipts}
          where "receipts"."project_id" = "projects"."id" and "receipts"."deleted_at" is null
        )`,
        memberCount: sql<number>`(
          select count(*)::int from ${projectMembers}
          where "project_members"."project_id" = "projects"."id"
        )`,
      })
      .from(projects)
      // INNER: projects.owner_id is ON DELETE RESTRICT, so it always resolves.
      .innerJoin(users, eq(users.id, projects.ownerId))
      .where(inArray(projects.id, scopedProjects(ctx.user, "read")))
      .orderBy(desc(projects.createdAt));

    const userRows = await ctx.db
      .select({
        id: users.id,
        displayName: users.displayName,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
        onboardedAt: users.onboardedAt,
        lastSeenAt: users.lastSeenAt,
        projectsOwned: sql<number>`(
          select count(*)::int from ${projects}
          where "projects"."owner_id" = "users"."id" and "projects"."deleted_at" is null
        )`,
        receiptsUploaded: sql<number>`(
          select count(*)::int from ${receipts}
          where "receipts"."uploaded_by" = "users"."id" and "receipts"."deleted_at" is null
        )`,
      })
      .from(users)
      .orderBy(asc(users.createdAt));

    return {
      projects: projectRows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
        receiptCount: row.receiptCount,
        needsReviewCount: row.needsReviewCount,
        totalSpend: row.totalSpend,
        memberCount: row.memberCount,
        owner: {
          id: row.ownerId,
          email: row.ownerEmail,
          name: displayNameOf({
            displayName: row.ownerDisplayName,
            firstName: row.ownerFirstName,
            lastName: row.ownerLastName,
            email: row.ownerEmail,
          }),
        },
      })),
      users: userRows.map((row) => ({
        id: row.id,
        email: row.email,
        name: displayNameOf(row),
        role: row.role,
        onboardedAt: row.onboardedAt,
        lastSeenAt: row.lastSeenAt,
        projectsOwned: row.projectsOwned,
        receiptsUploaded: row.receiptsUploaded,
      })),
      totals: {
        userCount: userRows.length,
        projectCount: projectRows.length,
        receiptCount: projectRows.reduce((sum, row) => sum + row.receiptCount, 0),
        needsReviewCount: projectRows.reduce((sum, row) => sum + row.needsReviewCount, 0),
      },
    };
  }),

  /**
   * Backup history — READ ONLY. There is deliberately no procedure here that
   * starts a backup: the backup job, its scheduling, retention and the
   * restore drill are all Phase 9 (docs/PHASES.md 9.1-9.6), and nothing in
   * this repository writes a `backups` row yet.
   *
   * So today this returns an empty list, and that is the correct answer, not
   * an error — the admin screen renders an empty state and disables its
   * trigger button until Phase 9 lands.
   *
   * `path` and `manifest` are deliberately NOT returned. `path` is a host
   * filesystem path and `manifest` is jsonb that can carry more of the same;
   * CLAUDE.md keeps real hostnames and infrastructure detail out of
   * client-visible surfaces, and an operator needs status, size and timing —
   * not a path they cannot act on from a browser. `hasArtifact` carries the
   * only bit the UI actually needs.
   */
  backups: ownerProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: backups.id,
          kind: backups.kind,
          status: backups.status,
          // bigint declared with mode:"number", so this is already a JS
          // number — unlike every count(*) above, which needs an ::int cast.
          sizeBytes: backups.sizeBytes,
          dbIncluded: backups.dbIncluded,
          imagesIncluded: backups.imagesIncluded,
          error: backups.error,
          startedAt: backups.startedAt,
          finishedAt: backups.finishedAt,
          hasArtifact: sql<boolean>`${backups.path} is not null`,
        })
        .from(backups)
        .where(isNull(backups.deletedAt))
        .orderBy(desc(backups.startedAt))
        .limit(input?.limit ?? 50);

      return rows;
    }),
});
