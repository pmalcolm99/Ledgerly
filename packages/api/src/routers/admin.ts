import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
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
import { getEnv } from "@ledgerly/config/env";
import { displayNameOf } from "@ledgerly/shared/personName";

import {
  describeAiKey,
  resolveAiKey,
  testAiKey as runAiKeyTest,
  validateAiKeyShape,
} from "../aiKey";
import { recordAudit } from "../audit";
import { isUniqueViolation } from "../errors";
import { NEEDS_REVIEW_SQL } from "../receiptAccess";
import { checkRateLimit, checkWindowedRateLimit } from "../rateLimit";
import { scopedProjects } from "../scope";
import { SECRET_KEYS, deleteSecret, writeSecret } from "../secrets";
import { describeBackupSchedule, serializeBackupSchedule, validateCron } from "../backupSchedule";
import {
  describeSmtpConfig,
  mergeSmtpConfig,
  resolveSmtpConfig,
  serializeSmtpConfig,
} from "../smtp";
import { ownerProcedure, router } from "../trpc";
import type { Context } from "../trpc";

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
   * Backup history (Phase 9). Read-only; `createBackup` below is what starts
   * one.
   *
   * `path` and `manifest` are deliberately NOT returned. `path` is a host
   * filesystem path and `manifest` is jsonb that can carry more of the same;
   * CLAUDE.md keeps real hostnames and infrastructure detail out of
   * client-visible surfaces, and an operator needs status, size and timing —
   * not a path they cannot act on from a browser. `hasArtifact` carries the
   * only bit the UI actually needs, and the download route takes a row id and
   * resolves the path server-side.
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

  /**
   * Everything the Backups card needs that is not a history row: the last
   * backup, the configured schedule, and whether anything is actually going to
   * run it (task 9.5's "admin visibility").
   *
   * The two next-run figures are reported separately on purpose.
   * `schedule.nextRunAt` is computed from the cron stored in `app_config`;
   * `nextRunAt` comes from the BullMQ scheduler in Redis. They agree in every
   * healthy state, and the case where they do not — a cron configured with
   * `registered: false` — is precisely the silent failure this phase exists to
   * prevent, so the card renders it as an error rather than papering over it
   * with whichever value is available. Redis is not in any backup, so a
   * `redis_data` loss makes that state ordinary rather than exotic.
   */
  backupStatus: ownerProcedure.query(async ({ ctx }) => {
    const env = getEnv();
    const schedule = await describeBackupSchedule(ctx.db, env.MASTER_KEY);

    const [last] = await ctx.db
      .select({
        id: backups.id,
        kind: backups.kind,
        status: backups.status,
        sizeBytes: backups.sizeBytes,
        imagesIncluded: backups.imagesIncluded,
        error: backups.error,
        startedAt: backups.startedAt,
        finishedAt: backups.finishedAt,
        hasArtifact: sql<boolean>`${backups.path} is not null`,
      })
      .from(backups)
      .where(isNull(backups.deletedAt))
      .orderBy(desc(backups.startedAt))
      .limit(1);

    // Absent in tests and in any caller without Redis wired. Reported as
    // `null` rather than `false`, so "we could not ask" is distinguishable
    // from "we asked and nothing is registered" — the UI must not raise an
    // alarm about the first.
    let scheduler: { registered: boolean; pattern: string | null; nextRunAt: Date | null } | null =
      null;
    if (ctx.readBackupScheduleState) {
      try {
        const state = await ctx.readBackupScheduleState();
        // `pattern` is carried, not dropped. The scheduler being registered is
        // not the same as it being registered with the CRON THAT IS SAVED — and
        // the gap between them is reachable by the ordinary path: the write to
        // `app_config` commits, the reschedule fails on a Redis blip, and Redis
        // goes on holding the OLD scheduler. `registered` is then true, no
        // alarm fires, and the screen shows a next-run computed from the new
        // cron while backups keep running at the old time, indefinitely.
        scheduler = {
          registered: state.registered,
          pattern: state.pattern,
          nextRunAt: state.nextRunAt,
        };
      } catch (error) {
        console.error("[ledgerly] could not read the backup scheduler state:", error);
      }
    }

    return {
      last: last ?? null,
      schedule: { ...schedule, updatedBy: undefined },
      scheduler,
      /** Env-owned, not settable here (D-45) — shown so the card can say what
       *  a backup will actually contain rather than leaving it to be guessed. */
      includeImages: env.BACKUP_INCLUDE_IMAGES,
      retentionDays: env.BACKUP_RETENTION_DAYS,
    };
  }),

  /**
   * Starts a manual backup (task 9.1).
   *
   * The row is inserted here rather than in the worker so the screen shows
   * `running` the instant the button is pressed — and so that a Redis failure
   * a moment later leaves a visible artefact of the request instead of
   * nothing. `backupWorker.ts`'s boot sweep marks any row still `running`
   * after a restart as `failed`, which closes that loop.
   *
   * Refuses while one is already running. Not politeness: two concurrent
   * `pg_dump`s compete for the same disk to produce two archives nobody asked
   * for, and the worker's `concurrency: 1` would queue the second one anyway —
   * so the refusal is honest about what would happen rather than silently
   * accepting a click that does nothing for ten minutes.
   */
  createBackup: ownerProcedure.mutation(async ({ ctx }) => {
    if (ctx.rateLimitRedis) {
      const limit = await checkBackupRateLimit(ctx.rateLimitRedis, ctx.user.id);
      if (!limit.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many backups requested. Try again shortly.",
        });
      }
    }

    const env = getEnv();
    const backupId = await ctx.db.transaction(async (tx) => {
      // Serialises the check below against a concurrent request. Without it
      // this is a read followed by a separate insert, so two clicks inside the
      // rate limit could both see "nothing running" and both insert — and the
      // CONFLICT this procedure advertises would be a guarantee it does not
      // make. An advisory lock rather than `SELECT ... FOR UPDATE`, because
      // there is nothing to lock in the case that matters: `FOR UPDATE` locks
      // the rows it returns, and on "no backup is running" that is none. The
      // same trap `docs/SCHEMA.md` records for the first-owner election.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BACKUP_LOCK_KEY})`);

      const [running] = await tx
        .select({ id: backups.id, startedAt: backups.startedAt })
        .from(backups)
        .where(
          and(
            eq(backups.status, "running"),
            isNull(backups.deletedAt),
            // Only a row that could PLAUSIBLY still be running blocks a new
            // one. BullMQ can fail a stalled job without the retry the failed
            // handler assumes is coming, which leaves the row `running`
            // forever; without this bound, one stalled job would disable the
            // button until the next restart — a backup system that has quietly
            // stopped accepting backups, which is the failure this phase is
            // built to prevent. `PG_DUMP_TIMEOUT_MS` is the longest a dump is
            // allowed to take, so anything older than it is not running.
            gte(backups.startedAt, new Date(Date.now() - RUNNING_BACKUP_MAX_AGE_MS)),
          ),
        )
        .limit(1);
      if (running) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A backup is already running. Wait for it to finish.",
        });
      }

      const [row] = await tx
        .insert(backups)
        .values({
          kind: "manual",
          status: "running",
          dbIncluded: true,
          imagesIncluded: env.BACKUP_INCLUDE_IMAGES,
        })
        .returning({ id: backups.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await recordAudit(tx, {
        actorUserId: ctx.user.id,
        action: "backup.requested",
        entityType: "backup",
        entityId: row.id,
        metadata: { via: "admin.createBackup", includeImages: env.BACKUP_INCLUDE_IMAGES },
      });
      return row.id;
    });

    // Outside the transaction: an enqueue that succeeds against a transaction
    // that then rolls back would leave a job pointing at a row that does not
    // exist. `receipts.emailReceipt` orders it the same way, for the same
    // reason.
    const enqueue = ctx.enqueueBackup;
    if (!enqueue) {
      console.warn(
        `[ledgerly] backup ${backupId} was requested but no queue is wired into this context.`,
      );
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "Backups are not available on this instance right now.",
      });
    }
    try {
      await enqueue({ backupId, kind: "manual" });
    } catch (error) {
      console.error(`[ledgerly] could not enqueue backup ${backupId}:`, error);
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "The backup could not be queued. Check that Redis is reachable.",
      });
    }

    return { ok: true as const, backupId };
  }),

  /**
   * Sets the nightly schedule (task 9.3).
   *
   * Validated BEFORE the write. A pattern BullMQ would reject must not be
   * persisted as the configured schedule while no scheduler exists to run it —
   * a stored intention with no effect is the shape of every silent backup
   * failure, and this one would look correct on the screen that set it.
   *
   * The reschedule happens after the commit and is reported, not swallowed:
   * `app_config` is the source of truth and the worker reconciles from it at
   * boot, so a Redis failure here is recoverable by restarting — but the
   * operator has to be told that restarting is what it now needs.
   */
  setBackupSchedule: ownerProcedure
    .input(z.object({ cron: z.string().trim().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const validated = validateCron(input.cron);
      if (!validated.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: validated.message });
      }

      const env = getEnv();
      await ctx.db.transaction(async (tx) => {
        await writeSecret(
          tx,
          SECRET_KEYS.backupSchedule,
          serializeBackupSchedule({ cron: input.cron }),
          env.MASTER_KEY,
          ctx.user.id,
        );
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "app_config.updated",
          entityType: "app_config",
          // `audit_log.entity_id` is uuid-typed and an app_config row is keyed
          // by text, so the key goes in metadata — the same shape `setSmtp`
          // uses. The cron itself is recorded because "when was this instance
          // supposed to be backing up" is exactly what an audit log should be
          // able to answer, and it is not a credential.
          entityId: null,
          metadata: {
            key: SECRET_KEYS.backupSchedule,
            via: "admin.setBackupSchedule",
            cron: input.cron,
          },
        });
      });

      return {
        ...(await applyBackupSchedule(ctx, input.cron)),
        nextRunAt: validated.next,
      };
    }),

  /** Turns scheduled backups off. Never reads the stored row, so it is also
   *  the recovery path when `MASTER_KEY` no longer matches it — the same
   *  property `clearSmtp` has, and for the same reason. */
  clearBackupSchedule: ownerProcedure.mutation(async ({ ctx }) => {
    const cleared = await ctx.db.transaction(async (tx) => {
      const removed = await deleteSecret(tx, SECRET_KEYS.backupSchedule);
      if (removed) {
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "app_config.cleared",
          entityType: "app_config",
          entityId: null,
          metadata: { key: SECRET_KEYS.backupSchedule, via: "admin.clearBackupSchedule" },
        });
      }
      return removed;
    });

    return { ...(await applyBackupSchedule(ctx, null)), cleared };
  }),
  /**
   * The Claude API key's STATUS — never the key.
   *
   * `describeAiKey` returns a type with no field that can hold a secret (see
   * aiKey.ts), which is what makes this procedure safe by construction rather
   * than by the author remembering to strip a field. What reaches the client
   * is: where the key came from, its last four characters, and who set it.
   *
   * `ownerProcedure`, like everything else on this screen. A key that any
   * member could read the shape of, or worse replace, would be a
   * spend-and-data-exfiltration lever on a shared instance.
   */
  aiKey: ownerProcedure.query(async ({ ctx }) => {
    const env = getEnv();
    const description = await describeAiKey(ctx.db, env.MASTER_KEY, env.ANTHROPIC_API_KEY);

    let updatedByName: string | null = null;
    if (description.updatedBy) {
      const [row] = await ctx.db
        .select({
          displayName: users.displayName,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(eq(users.id, description.updatedBy))
        .limit(1);
      // No email in the fallback chain: this is a settings screen, not the
      // user directory, and it does not need to disclose an address.
      updatedByName = row ? displayNameOf({ ...row, email: null }) : null;
    }

    return {
      source: description.source,
      hint: description.hint,
      updatedAt: description.updatedAt,
      updatedByName,
      /** True when an env fallback exists, so the UI can say what "Clear"
       *  will actually fall back TO rather than implying it disables AI. */
      hasEnvFallback: env.ANTHROPIC_API_KEY.length > 0,
    };
  }),

  /**
   * Stores a Claude API key, encrypted with `MASTER_KEY` (docs/SCHEMA.md
   * §app_config). Write-only: there is no procedure anywhere that returns it.
   *
   * The audit row records that the key changed and nothing about its value —
   * not even the hint. `audit.ts`'s contract is that metadata never carries
   * secrets, and a hint accumulated across many rows is a slow leak.
   */
  setAiKey: ownerProcedure
    .input(z.object({ apiKey: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      const validated = validateAiKeyShape(input.apiKey);
      if (!validated.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: validated.message });
      }

      const env = getEnv();
      await ctx.db.transaction(async (tx) => {
        await writeSecret(
          tx,
          SECRET_KEYS.anthropicApiKey,
          validated.key,
          env.MASTER_KEY,
          ctx.user.id,
        );
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "app_config.updated",
          entityType: "app_config",
          // `audit_log.entity_id` is uuid-typed and this table is keyed by
          // text, so the key name goes in metadata and entityId stays null.
          entityId: null,
          metadata: { key: SECRET_KEYS.anthropicApiKey, via: "admin.setAiKey" },
        });
      });

      // Every receipt that failed purely because there was no usable key is
      // now extractable. Without this, D-39's own headline scenario — boot a
      // fresh instance, upload receipts, then set the key — strands the whole
      // backlog: `reconcilePendingExtractions` only sweeps `pending`, and
      // these are `failed`. The user would have to find and re-extract each
      // one by hand, from a screen that does not say why they failed.
      const requeued = await requeueKeyBlockedReceipts(ctx);
      return { ok: true as const, requeued };
    }),

  /** Removes the stored key, falling back to `ANTHROPIC_API_KEY` from the
   *  environment if one is set — or to no key at all, which fails extraction
   *  with a named reason rather than silently.
   *
   *  Also the recovery path when `MASTER_KEY` no longer matches the stored
   *  row: this never reads the row, so it works on ciphertext nobody can
   *  decrypt. */
  clearAiKey: ownerProcedure.mutation(async ({ ctx }) => {
    const cleared = await ctx.db.transaction(async (tx) => {
      const removed = await deleteSecret(tx, SECRET_KEYS.anthropicApiKey);
      // Only audit an effect that actually happened. An append-only log whose
      // rows assert clears that cleared nothing is a log you cannot reason
      // from later.
      if (removed) {
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "app_config.cleared",
          entityType: "app_config",
          entityId: null,
          metadata: { key: SECRET_KEYS.anthropicApiKey, via: "admin.clearAiKey" },
        });
      }
      return removed;
    });

    // Falling back to a working env key unblocks the same backlog that
    // setting a key does.
    const requeued = cleared ? await requeueKeyBlockedReceipts(ctx) : 0;
    return { ok: true as const, cleared, requeued };
  }),

  /**
   * Checks the configured key against the live API, at zero token cost.
   *
   * Worth having because the two failures that stopped extraction on this
   * instance were indistinguishable from the UI: a rejected key and an
   * unresolvable model id both surfaced as `AI_REQUEST_REJECTED`, and the
   * label blamed the key. This separates them.
   *
   * Rate-limited: an owner-only button that makes an outbound request has no
   * reason to be allowed at click speed.
   */
  testAiKey: ownerProcedure.mutation(async ({ ctx }) => {
    if (ctx.rateLimitRedis) {
      const limit = await checkRateLimit(
        ctx.rateLimitRedis,
        `ai_key_test:${ctx.user.id}`,
        1,
        AI_KEY_TEST_RATE_LIMIT_PER_MIN,
      );
      if (!limit.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many tests. Try again shortly.",
        });
      }
    }

    const env = getEnv();
    const { apiKey, source } = await resolveAiKey(ctx.db, env.MASTER_KEY, env.ANTHROPIC_API_KEY);

    if (source === "undecryptable") {
      return {
        ok: false,
        message:
          "A key is stored but cannot be decrypted — MASTER_KEY does not match this database. Clear it and paste the key again.",
        models: [] as { id: string; ok: boolean }[],
      };
    }
    if (!apiKey) {
      return {
        ok: false,
        message: "No key is configured.",
        models: [] as { id: string; ok: boolean }[],
      };
    }

    return runAiKeyTest(apiKey, [env.AI_MODEL_PASS1, env.AI_MODEL_PASS2]);
  }),

  /**
   * The SMTP settings' STATUS — every field except the password (D-44).
   *
   * `describeSmtpConfig` returns a type with no `password` field at all, which
   * is the same by-construction protection `admin.aiKey` gets. What reaches
   * the client is host/port/security/username/from-address plus a four-
   * character hint of the password.
   */
  smtp: ownerProcedure.query(async ({ ctx }) => {
    const description = await describeSmtpConfig(ctx.db, getEnv().MASTER_KEY);

    let updatedByName: string | null = null;
    if (description.updatedBy) {
      const [row] = await ctx.db
        .select({
          displayName: users.displayName,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(eq(users.id, description.updatedBy))
        .limit(1);
      updatedByName = row ? displayNameOf({ ...row, email: null }) : null;
    }

    return { ...description, updatedBy: undefined, updatedByName };
  }),

  /**
   * Stores the SMTP config, encrypted with `MASTER_KEY` as one JSON blob.
   *
   * `password` is OPTIONAL, and that is load-bearing rather than lenient: the
   * form cannot round-trip a write-only field, so submitting it with the
   * password box blank means "keep the stored password". Without that,
   * changing the port would silently wipe authentication. `mergeSmtpConfig`
   * owns that rule so it cannot be re-derived differently later.
   */
  setSmtp: ownerProcedure
    .input(
      z.object({
        host: z.string().trim().min(1).max(255),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        user: z.string().trim().max(255),
        /** Absent means "unchanged". Empty string is not accepted as a way to
         *  set an empty password — use a server with no username instead. */
        password: z.string().min(1).max(512).optional(),
        fromAddress: z.string().trim().email().max(320),
        fromName: z.string().trim().max(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const env = getEnv();
      const existing = await resolveSmtpConfig(ctx.db, env.MASTER_KEY);
      if (existing.source === "undecryptable" && input.password === undefined) {
        // The stored row cannot be read, so there is no password to keep. Say
        // that plainly rather than merging against null and failing zod with a
        // message about a field the operator did fill in.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "The stored settings cannot be decrypted, so the saved password is unrecoverable. Enter the password again.",
        });
      }

      const merged = mergeSmtpConfig(existing.config, input);
      if (!merged.ok) throw new TRPCError({ code: "BAD_REQUEST", message: merged.message });

      await ctx.db.transaction(async (tx) => {
        await writeSecret(
          tx,
          SECRET_KEYS.smtp,
          serializeSmtpConfig(merged.config),
          env.MASTER_KEY,
          ctx.user.id,
        );
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "app_config.updated",
          entityType: "app_config",
          entityId: null,
          // The host is recorded because "where is this instance sending mail"
          // is the question an audit log should be able to answer. The
          // username and password are not: `audit.ts`'s contract is that
          // metadata never carries a credential, and a username is half of one.
          metadata: { key: SECRET_KEYS.smtp, via: "admin.setSmtp", host: merged.config.host },
        });
      });

      return { ok: true as const };
    }),

  /** Removes the stored SMTP config. There is no environment fallback, so this
   *  turns receipt email off entirely — which is also the recovery path when
   *  `MASTER_KEY` no longer matches the row, since it never reads it. */
  clearSmtp: ownerProcedure.mutation(async ({ ctx }) => {
    const cleared = await ctx.db.transaction(async (tx) => {
      const removed = await deleteSecret(tx, SECRET_KEYS.smtp);
      if (removed) {
        await recordAudit(tx, {
          actorUserId: ctx.user.id,
          action: "app_config.cleared",
          entityType: "app_config",
          entityId: null,
          metadata: { key: SECRET_KEYS.smtp, via: "admin.clearSmtp" },
        });
      }
      return removed;
    });
    return { ok: true as const, cleared };
  }),

  /**
   * Sends one test message to the owner's own address.
   *
   * Real send, not a connection probe. The AI key's Test button taught the
   * lesson this reuses: only the actual operation distinguishes a wrong
   * password from a blocked port from a From address the relay refuses to
   * accept. All three look identical from a settings form.
   *
   * `ctx.sendEmail` is INJECTED, exactly like `enqueueReceiptExtract`, and for
   * the same structural reason — `nodemailer` lives in `packages/queue`, which
   * already depends on this package, so importing it here would be circular
   * AND would put the credential-consuming client one import away from the web
   * bundle. `apps/web`'s tRPC route handler supplies the implementation.
   *
   * Rate-limited: an owner-only button that makes an outbound connection has
   * no business being clickable at click speed.
   */
  testSmtp: ownerProcedure.mutation(async ({ ctx }) => {
    if (ctx.rateLimitRedis) {
      const limit = await checkRateLimit(
        ctx.rateLimitRedis,
        `smtp_test:${ctx.user.id}`,
        1,
        SMTP_TEST_RATE_LIMIT_PER_MIN,
      );
      if (!limit.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many tests. Try again shortly.",
        });
      }
    }

    const { config, source } = await resolveSmtpConfig(ctx.db, getEnv().MASTER_KEY);
    if (source === "undecryptable") {
      return {
        ok: false,
        message:
          "Settings are stored but cannot be decrypted — MASTER_KEY does not match this database. Clear them and enter them again.",
      };
    }
    if (!config) return { ok: false, message: "SMTP is not configured." };
    if (!ctx.sendEmail) {
      return { ok: false, message: "Email sending is not available in this context." };
    }

    try {
      await ctx.sendEmail({
        config,
        to: ctx.user.email,
        subject: "Ledgerly test email",
        text:
          `This is a test message from Ledgerly, sent to confirm the SMTP settings work.\n\n` +
          `Sent via ${config.host}:${config.port}.`,
      });
      return { ok: true, message: `Sent to ${ctx.user.email}. Check that it arrives.` };
    } catch (error) {
      // The relay's own message is the diagnosis and is worth showing: "535
      // authentication failed" or "connect ETIMEDOUT" is what tells the
      // operator which field is wrong. It cannot contain the password — the
      // password is never echoed by an SMTP server — but it is truncated
      // regardless, because an error string is not a place to be relaxed.
      const detail = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
      return { ok: false, message: `The server rejected the message: ${detail}` };
    }
  }),
});

/**
 * The `extraction_error` reason codes that mean "this receipt failed only
 * because there was no usable API key". Shared with `packages/queue`'s worker
 * by value rather than by import — `api` cannot import `queue` (D-07) — so
 * `worker.ts` and this list must be changed together. Both are covered by
 * `aiKey.test.ts`.
 */
/** An owner-only outbound probe. Generous enough that a genuine
 *  diagnose-and-retry loop never hits it. */
const AI_KEY_TEST_RATE_LIMIT_PER_MIN = 10;

/** Lower than the AI key's: this one actually delivers a message, and a relay
 *  counts every one against the instance's sending reputation. */
const SMTP_TEST_RATE_LIMIT_PER_MIN = 3;

/**
 * Two tiers, composed the same way as `checkEmailReceiptRateLimit`.
 *
 * A backup is the most expensive thing this instance can be asked to do — a
 * full `pg_dump`, optionally a tar of every image, and a new archive on the
 * volume each time. The per-minute cap stops a double-click or an impatient
 * operator from queueing five; the daily cap is the one that matters, because
 * 2/min sustained would fill the backups volume long before retention got
 * anywhere near pruning it. Both are far above any genuine use: the schedule
 * exists precisely so nobody has to press this button routinely.
 */
const BACKUP_RATE_LIMIT_PER_MIN = 2;

/**
 * An arbitrary but fixed key for `pg_advisory_xact_lock`, so every caller of
 * `createBackup` contends on the same one. Advisory locks share a single
 * instance-wide namespace, so the value only has to not collide with another
 * use — and this is currently the only one.
 */
const BACKUP_LOCK_KEY = 909_001;

/**
 * How long a `running` row is believed. Matches `PG_DUMP_TIMEOUT_MS` in
 * `packages/queue/src/pipeline/backup.ts` — the longest a dump is permitted to
 * take, so a row older than this cannot still be in progress. Held by value
 * rather than imported, because `api` cannot import `queue` (D-07); the two
 * must be changed together, which is what this comment is for.
 */
const RUNNING_BACKUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const BACKUP_RATE_LIMIT_PER_DAY = 12;
const ONE_DAY_SECONDS = 24 * 60 * 60;

async function checkBackupRateLimit(
  redis: NonNullable<Context["rateLimitRedis"]>,
  userId: string,
): Promise<{ allowed: boolean }> {
  const perMinute = await checkRateLimit(
    redis,
    `backup_create:${userId}`,
    1,
    BACKUP_RATE_LIMIT_PER_MIN,
  );
  if (!perMinute.allowed) return perMinute;
  // Charged only once the per-minute check has admitted the request, so
  // hammering past the minute limit cannot burn the day's allowance.
  return checkWindowedRateLimit(
    redis,
    `backup_create_daily:${userId}`,
    1,
    BACKUP_RATE_LIMIT_PER_DAY,
    ONE_DAY_SECONDS,
  );
}

/**
 * Reconciles Redis to the schedule that has just been written, and says
 * whether it worked.
 *
 * Returns `{ ok, message }` rather than throwing, because the write it follows
 * has already committed: throwing here would tell the operator the whole
 * operation failed when the durable half of it succeeded, and they would
 * reasonably retry a thing that does not need retrying. The honest report is
 * "saved, but not yet live".
 */
async function applyBackupSchedule(
  ctx: Pick<Context, "rescheduleBackup">,
  cron: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const reschedule = ctx.rescheduleBackup;
  if (!reschedule) {
    console.warn("[ledgerly] backup schedule changed but no queue is wired into this context.");
    return {
      ok: false,
      message: "Saved. It will take effect the next time the app restarts.",
    };
  }
  try {
    await reschedule(cron);
    return { ok: true };
  } catch (error) {
    console.error("[ledgerly] could not apply the backup schedule:", error);
    return {
      ok: false,
      message: "Saved, but the scheduler could not be updated. Restart the app to apply it.",
    };
  }
}

const KEY_BLOCKED_ERRORS = ["ANTHROPIC_KEY_NOT_CONFIGURED", "ANTHROPIC_KEY_UNDECRYPTABLE"];

/**
 * Re-enqueues every live receipt whose extraction failed only because no
 * usable key was available, and returns how many.
 *
 * `extraction_status` is set back to `pending` inside the same transaction as
 * the enqueue decision, for the reason Phase 6's review finding M-2 records:
 * `receipt-extract` dedupes on `jobId: receiptId`, so a collision with an
 * in-flight job is harmless to observe, and a `pending` row is what the
 * startup reconciliation sweep treats as its backstop if the enqueue itself
 * is lost.
 *
 * Best-effort by design: `ctx.enqueueReceiptExtract` is an optional capability
 * (it is absent in tests and in the RSC caller), and a Redis failure here must
 * not fail the key change the operator actually asked for. The receipts are
 * left `pending`, which the boot sweep will pick up.
 */
async function requeueKeyBlockedReceipts(
  ctx: Pick<Context, "db" | "enqueueReceiptExtract">,
): Promise<number> {
  const blocked = await ctx.db
    .update(receipts)
    .set({ extractionStatus: "pending", extractionError: null, updatedAt: new Date() })
    .where(
      and(
        isNull(receipts.deletedAt),
        eq(receipts.extractionStatus, "failed"),
        inArray(receipts.extractionError, KEY_BLOCKED_ERRORS),
      ),
    )
    .returning({ id: receipts.id });

  if (blocked.length === 0) return 0;

  const enqueue = ctx.enqueueReceiptExtract;
  if (!enqueue) {
    console.warn(
      `[ledgerly] ${blocked.length} receipt(s) reset to pending after an API key change, but no ` +
        "queue is wired into this context — the worker's startup sweep will pick them up.",
    );
    return blocked.length;
  }

  for (const row of blocked) {
    try {
      // `forcePass2: false` — this is a retry of a call that never happened,
      // not an escalation. The ladder decides for itself.
      await enqueue({ receiptId: row.id, forcePass2: false });
    } catch (error) {
      console.error(`[ledgerly] failed to re-enqueue receipt ${row.id} after a key change:`, error);
    }
  }
  return blocked.length;
}
