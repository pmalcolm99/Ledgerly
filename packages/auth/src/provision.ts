import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditLog, instanceState, users } from "@ledgerly/db/schema";
import type * as schema from "@ledgerly/db/schema";
import { getEnv } from "@ledgerly/config";

import type { AccessIdentity, AuthUser } from "./types";

/**
 * packages/auth/src/provision.ts — JIT provisioning and the atomic
 * first-owner election (tasks 3.4/3.5, contract §4).
 */

export type AuthDatabase = NodePgDatabase<typeof schema>;
type AuthTx = Parameters<Parameters<AuthDatabase["transaction"]>[0]>[0];

/**
 * Injected rather than read inline from `env`, so both D-27 branches are
 * testable without mutating the environment — the same reason
 * `verifyAccessJwt` takes its config as a parameter.
 */
export type ProvisionOptions = {
  /** D-27. Default false; on only during a deliberate IdP migration. */
  allowSubRelink: boolean;
};

export function currentProvisionOptions(): ProvisionOptions {
  return { allowSubRelink: getEnv().ACCESS_ALLOW_SUB_RELINK };
}

export type ProvisionOutcome = {
  user: AuthUser;
  /** A `users` row was inserted by this call. */
  created: boolean;
  /** This call won the first-owner election. */
  electedOwner: boolean;
  /** Case A: the email refresh hit `users_email_lower_key` and was skipped.
   * The request still succeeds — see D-27. */
  emailRefreshSkipped: boolean;
  /** Case B under `ACCESS_ALLOW_SUB_RELINK`: an existing row's
   * `cf_access_sub` was reassigned to this identity. */
  relinked: boolean;
  /** The `cf_access_sub` that was displaced by a relink. The relink UPDATE
   * overwrites the column in place, so without carrying it out here the old
   * value would exist nowhere — not in the row, not in the audit trail. */
  previousSub: string | null;
};

/**
 * Case B with `ACCESS_ALLOW_SUB_RELINK=false`. A *new* `sub` arrived
 * carrying an email an existing row already holds — the signature of a
 * Cloudflare Access identity-provider change (D-27). Surfaced as a clean
 * rejection with an audit trail, never as an unhandled 23505 returning a
 * 500 with a Postgres constraint name in the body.
 */
export class IdentityConflictError extends Error {
  readonly reason = "identity_conflict" as const;
  constructor(readonly sub: string) {
    super("An account with this email already exists under a different identity.");
    this.name = "IdentityConflictError";
  }
}

const EMAIL_UNIQUE_INDEX = "users_email_lower_key";

/** `last_seen_at` is coarsened so the steady state stays one SELECT per
 * request and zero writes. Without this, D-03's "one user row read per
 * request" quietly becomes one row *write* per request. */
const LAST_SEEN_GRANULARITY_MS = 15 * 60 * 1000;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === constraint;
}

async function writeAudit(
  db: AuthDatabase | AuthTx,
  entry: {
    action: string;
    entityId: string | null;
    actorUserId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: "user",
    entityId: entry.entityId,
    metadata: entry.metadata ?? {},
  });
}

/**
 * Refresh-on-visit (task 3.5). Refreshed from the JWT: `email`,
 * `display_name`, `last_seen_at`, `updated_at`.
 *
 * NEVER touched: `first_name`, `last_name` (user-entered — Forkd's
 * behaviour, and correct), `role` (never promoted or demoted by the auth
 * layer — docs/SCHEMA.md), `theme`, `onboarded_at`, `cf_access_sub`.
 */
async function refreshUser(
  db: AuthDatabase,
  existing: AuthUser,
  identity: AccessIdentity,
): Promise<ProvisionOutcome> {
  const emailChanged = existing.email !== identity.email;
  const nameChanged = (existing.displayName ?? null) !== identity.name;
  const seenStale =
    existing.lastSeenAt === null ||
    Date.now() - existing.lastSeenAt.getTime() > LAST_SEEN_GRANULARITY_MS;

  if (!emailChanged && !nameChanged && !seenStale) {
    return {
      user: existing,
      created: false,
      electedOwner: false,
      emailRefreshSkipped: false,
      relinked: false,
      previousSub: null,
    };
  }

  const touch = {
    ...(nameChanged ? { displayName: identity.name } : {}),
    ...(seenStale ? { lastSeenAt: new Date() } : {}),
    updatedAt: new Date(),
  };

  try {
    // Wrapped in a transaction so that, when this function is called from
    // INSIDE an enclosing transaction, the unique violation below rolls
    // back only a SAVEPOINT. Without it the 23505 aborts the whole
    // enclosing transaction and the recovery UPDATE fails with 25P02
    // ("current transaction is aborted") — turning a path designed never to
    // fail a request into a 500. The signature takes `db: AuthDatabase`,
    // which invites exactly that composition; the default test harness
    // already wraps every test in a transaction. Found in the task 3.12
    // review.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({ ...touch, ...(emailChanged ? { email: identity.email } : {}) })
        .where(eq(users.id, existing.id))
        .returning();
      return row;
    });
    return {
      user: updated ?? existing,
      created: false,
      electedOwner: false,
      emailRefreshSkipped: false,
      relinked: false,
      previousSub: null,
    };
  } catch (error) {
    if (!isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) throw error;

    // Identify the other side of the collision so the operator can act on
    // it. Contract §4.5 asks for both identities and neither address.
    const [conflicting] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${identity.email}`)
      .limit(1);
    const conflictingUserId = conflicting?.id ?? null;

    // Case A (D-27). The IdP moved this user onto an address another row
    // already holds. Keep the stale email and continue: identity is `sub`,
    // `sub` is unchanged, and the user is authenticated. Failing the
    // request would lock someone out over a display attribute. Neither
    // address is logged.
    console.warn(
      `[ledgerly] WARN: email refresh skipped for sub=${existing.cfAccessSub} — the ` +
        "address reported by the identity provider is already held by another user " +
        `(D-27, conflicting user id=${conflictingUserId ?? "unknown"}). The stale ` +
        "address is retained; use the owner-only re-link action.",
    );

    const [updated] = await db
      .update(users)
      .set(touch)
      .where(eq(users.id, existing.id))
      .returning();
    return {
      user: updated ?? existing,
      created: false,
      electedOwner: false,
      emailRefreshSkipped: true,
      relinked: false,
      previousSub: null,
    };
  }
}

/**
 * Resolves the application user for a verified identity, provisioning on
 * first sight of a `sub`.
 *
 * The fast path below is unlocked and carries every request after the
 * first. The election transaction is entered only when a `sub` has never
 * been seen — serialising every request on the `instance_state` singleton
 * would be a self-inflicted throughput ceiling.
 */
export async function resolveUserForIdentity(
  db: AuthDatabase,
  identity: AccessIdentity,
  options: ProvisionOptions = currentProvisionOptions(),
): Promise<ProvisionOutcome> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.cfAccessSub, identity.sub))
    .limit(1);

  if (existing) return refreshUser(db, existing, identity);

  let outcome: ProvisionOutcome;
  try {
    outcome = await db.transaction(async (tx) => provisionWithinTransaction(tx, identity, options));
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      // Written OUTSIDE the transaction, which has already rolled back —
      // an audit row inside it would vanish with the rollback.
      await writeAudit(db, {
        action: "user.identity_conflict",
        entityId: null,
        metadata: { sub: identity.sub, allowRelink: options.allowSubRelink },
      });
    }
    throw error;
  }

  // Post-commit only. A rolled-back transaction must never leave a log line
  // claiming an owner was elected.
  if (outcome.electedOwner) {
    console.warn(
      `[ledgerly] WARN: first-owner election: ${outcome.user.email} ` +
        `(sub=${outcome.user.cfAccessSub}, user=${outcome.user.id}) is now the instance ` +
        "owner. Verify this is the intended owner.",
    );
    await writeAudit(db, {
      action: "instance.owner_elected",
      entityId: outcome.user.id,
      actorUserId: outcome.user.id,
      // The id, not the address. `audit.ts`'s policy always said so, and this
      // row was the one exception — invisible until the Logs tab started
      // returning audit metadata to a browser verbatim (D-46). The console
      // line above still names the address, because a boot warning telling an
      // operator to "verify this is the intended owner" is useless without it.
      metadata: { userId: outcome.user.id },
    });
  }

  if (outcome.relinked) {
    await writeAudit(db, {
      action: "user.sub_relinked",
      entityId: outcome.user.id,
      metadata: {
        previousSub: outcome.previousSub,
        newSub: identity.sub,
        viaEnvFlag: "ACCESS_ALLOW_SUB_RELINK",
      },
    });
  }

  return outcome;
}

async function provisionWithinTransaction(
  tx: AuthTx,
  identity: AccessIdentity,
  options: ProvisionOptions,
): Promise<ProvisionOutcome> {
  // 1. Take the lock FIRST. docs/SCHEMA.md explains why the brief's
  //    `SELECT ... WHERE role='owner' FOR UPDATE` does not work: on an empty
  //    users table it returns no rows and therefore locks nothing, so two
  //    concurrent first requests both see "no owner" and both insert. The
  //    singleton row always exists, so it always locks.
  const [state] = await tx
    .select({ ownerId: instanceState.ownerId })
    .from(instanceState)
    .where(eq(instanceState.id, true))
    .for("update");

  if (!state) {
    throw new Error(
      "instance_state singleton row is missing — run `pnpm db:seed`. The first-owner " +
        "election has nothing to lock without it (docs/SCHEMA.md §instance_state).",
    );
  }

  // 2. Re-select INSIDE the lock. Two concurrent first requests for the
  //    same sub both miss the fast path; the second blocks here, and on
  //    acquiring the lock must see the row the first inserted. Omit this
  //    and you get a unique violation instead of a shared user.
  const [raced] = await tx.select().from(users).where(eq(users.cfAccessSub, identity.sub)).limit(1);

  if (raced) {
    return {
      user: raced,
      created: false,
      electedOwner: false,
      emailRefreshSkipped: false,
      relinked: false,
      previousSub: null,
    };
  }

  // 3. Case B recovery, only when explicitly enabled (D-27). While this
  //    flag is on, email is temporarily a join key and D-06's guarantee is
  //    suspended — which is why it is default-false, WARNs on every boot,
  //    and audits every write.
  if (options.allowSubRelink) {
    const [byEmail] = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${identity.email}`)
      .limit(1);

    if (byEmail) {
      const previousSub = byEmail.cfAccessSub;
      const [relinked] = await tx
        .update(users)
        .set({
          cfAccessSub: identity.sub,
          displayName: identity.name,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, byEmail.id))
        .returning();
      return {
        user: relinked ?? byEmail,
        created: false,
        electedOwner: false,
        emailRefreshSkipped: false,
        relinked: true,
        previousSub,
      };
    }
  }

  const electedOwner = state.ownerId === null;

  let created: AuthUser | undefined;
  try {
    // 4. INSERT before UPDATE instance_state — instance_state.owner_id
    //    references users(id), so the row must exist first.
    [created] = await tx
      .insert(users)
      .values({
        cfAccessSub: identity.sub,
        email: identity.email,
        displayName: identity.name,
        role: electedOwner ? "owner" : "user",
        lastSeenAt: new Date(),
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) {
      throw new IdentityConflictError(identity.sub);
    }
    throw error;
  }

  if (!created) throw new Error("Failed to insert user row during provisioning.");

  if (electedOwner) {
    await tx.update(instanceState).set({ ownerId: created.id }).where(eq(instanceState.id, true));
  }

  return {
    user: created,
    created: true,
    electedOwner,
    emailRefreshSkipped: false,
    relinked: false,
    previousSub: null,
  };
}
