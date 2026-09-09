import "server-only";

import { asc, eq, exists, inArray, isNotNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { projects, users } from "@ledgerly/db/schema";
import { displayNameOf } from "@ledgerly/shared/personName";

import { scopedProjects } from "../scope";
import { protectedProcedure, router } from "../trpc";

/**
 * packages/api/src/routers/users.ts — the member picker's directory
 * (Phase 7).
 *
 * `members.add` takes a raw `userId`, and until now nothing could turn a
 * person into one: there was no way to enumerate users at all, so member
 * management was unreachable from a UI.
 *
 * ACCEPTED TRADE, recorded as D-33: this enumerates every onboarded user on
 * the instance to any caller who can manage members of any project. On a
 * self-hosted family instance that is the intended trade — a picker is worth
 * more than directory secrecy among people who already share projects — but
 * it is a real disclosure and is written down rather than left implicit.
 */

export const usersRouter = router({
  /**
   * Gated on holding `manage` (floor `full`) somewhere, OR being the instance
   * owner — and both halves are read from the database in one statement, not
   * from `ctx.user`.
   *
   * The role is re-read live because `ctx.user.role` came from the JWT at
   * request entry and is stale if this caller was demoted since (the M-5
   * discipline used throughout this package).
   *
   * The `role = 'owner'` disjunct is not redundant, and the reason is a real
   * trap: `scopedProjects` short-circuits the instance owner to *every live
   * project*, but on a fresh instance there are none, so that subquery is
   * empty. A pure "do you manage anything" gate would therefore hand the
   * instance owner an empty picker at exactly the moment they are setting the
   * instance up and have no projects yet.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    // The live role first, in its own statement. `scopedProjects` SHORT-
    // CIRCUITS on `user.role === "owner"`, so computing `hasManage` from
    // `ctx.user` — whose role came from the JWT at request entry — would let a
    // demoted instance owner keep the directory. The scope below is composed
    // against a user object carrying the role as the database has it now.
    const [liveRole] = await ctx.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    if (!liveRole) throw new TRPCError({ code: "FORBIDDEN" });
    const liveUser = { ...ctx.user, role: liveRole.role };

    const [caller] = await ctx.db
      .select({
        role: users.role,
        hasManage: exists(
          ctx.db
            .select({ one: sql`1` })
            .from(projects)
            .where(inArray(projects.id, scopedProjects(liveUser, "manage"))),
        ),
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    if (!caller || (caller.role !== "owner" && caller.hasManage !== true)) {
      // FORBIDDEN, not NOT_FOUND: there is no entity here whose existence
      // could leak, and FORBIDDEN is in CLIENT_SAFE_CODES so the UI can tell
      // "you may not" from "something broke".
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const rows = await ctx.db
      .select({
        id: users.id,
        displayName: users.displayName,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      // Only onboarded users: a JIT-provisioned row with no name yet is not
      // someone you can meaningfully add to a project (D-28).
      .where(isNotNull(users.onboardedAt))
      .orderBy(asc(sql`coalesce(${users.displayName}, ${users.firstName}, ${users.email})`));

    // `role`, `cf_access_sub`, `theme` and `last_seen_at` are deliberately not
    // returned. A member picker needs none of them, and `role` is
    // admin-surface data that `admin.overview` already carries under an
    // owner-only gate.
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: displayNameOf(row),
    }));
  }),
});
