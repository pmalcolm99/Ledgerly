import "server-only";

import { asc, isNotNull, sql } from "drizzle-orm";
import { users } from "@ledgerly/db/schema";
import { displayNameOf } from "@ledgerly/shared/personName";

import { protectedProcedure, router } from "../trpc";

/**
 * packages/api/src/routers/users.ts -- the member picker's directory
 * (Phase 7).
 *
 * `members.add` takes a raw `userId`, and until now nothing could turn a
 * person into one: there was no way to enumerate users at all, so member
 * management was unreachable from a UI.
 *
 * ACCEPTED TRADE, recorded as D-33 and REVISED in Phase 10a: this
 * enumerates every onboarded user on the instance -- id, display name and
 * email -- to EVERY onboarded caller.
 *
 * It used to claim less than that. The procedure was gated on holding
 * `manage` somewhere, and D-33 described the disclosure as limited to
 * "any caller who can manage members of any project". Phase 10a finding
 * F-15 showed that gate was inert: `scopedProjects(user, "manage")`
 * qualifies a project's OWNER at every level (scope.ts, `ownerBranch`),
 * `projects.create` is a plain `protectedProcedure` with no quota, and so
 * any caller could satisfy the gate on demand --
 *
 *     users.list            -> FORBIDDEN
 *     projects.create({..}) -> ok, caller is now an owner
 *     users.list            -> every user on the instance
 *     projects.delete({..}) -> tidy up
 *
 * -- and the test that was supposed to prove the control passed anyway,
 * because it only ever tried the first call.
 *
 * No gate here can be meaningful while project creation is unrestricted,
 * and restricting project creation to close a member-picker hole would be
 * the tail wagging the dog. So the gate is gone rather than left standing
 * as decoration: a control that anyone can satisfy is worse than no
 * control, because it makes a reviewer stop looking.
 *
 * What actually bounds this is Cloudflare Access -- every caller is already
 * an identity the instance owner deliberately let in. If that ever stops
 * being true, the fix is to make the directory owner-only and have
 * non-owner managers add members by exact email address, which discloses
 * nothing to someone who does not already know who they are inviting.
 */

export const usersRouter = router({
  /**
   * Deliberately ungated beyond `protectedProcedure` (an authenticated,
   * onboarded caller). See the module docblock: the gate that used to be
   * here could be satisfied by any caller in two calls, so it described a
   * restriction that did not exist.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
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
