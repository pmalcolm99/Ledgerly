import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCleanPool, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { auditLog, instanceState, users } from "@ledgerly/db/schema";

import { IdentityConflictError, resolveUserForIdentity } from "./provision";
import type { AuthDatabase, ProvisionOptions } from "./provision";
import type { AccessIdentity } from "./types";

/**
 * Contract §12.3. Requires TEST_DATABASE_URL and a real Postgres (D-18):
 * `SELECT ... FOR UPDATE` semantics are the entire subject of the race
 * test, so there is nothing meaningful to assert against a fake.
 *
 * The whole file uses `withCleanDatabase()` rather than the default
 * per-test rollback wrapper. The race test (case 23) requires genuinely
 * concurrent transactions on separate pool connections, which a single
 * enclosing transaction forecloses — and, worse, would make that test pass
 * for the wrong reason, since one transaction cannot race with itself.
 * Keeping one isolation mode for the file avoids provisioning's own
 * `db.transaction()` calls silently becoming savepoints in some tests and
 * real transactions in others.
 */

const NO_RELINK: ProvisionOptions = { allowSubRelink: false };
const RELINK: ProvisionOptions = { allowSubRelink: true };

let db: AuthDatabase;

function identity(overrides: Partial<AccessIdentity> = {}): AccessIdentity {
  return {
    sub: "cf-sub-alice",
    email: "alice@example.com",
    name: "Alice Example",
    issuedAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

describe("first-owner election (task 3.4)", () => {
  // --- 21 ------------------------------------------------------------
  it("makes the first authenticated user the instance owner", async () => {
    const outcome = await resolveUserForIdentity(db, identity(), NO_RELINK);

    expect(outcome.created).toBe(true);
    expect(outcome.electedOwner).toBe(true);
    expect(outcome.user.role).toBe("owner");

    const [state] = await db.select().from(instanceState).where(eq(instanceState.id, true));
    expect(state?.ownerId).toBe(outcome.user.id);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "instance.owner_elected"));
    expect(audits).toHaveLength(1);
  });

  // --- 22 ------------------------------------------------------------
  it("makes every subsequent user a regular user and leaves owner_id alone", async () => {
    const first = await resolveUserForIdentity(db, identity(), NO_RELINK);
    const second = await resolveUserForIdentity(
      db,
      identity({ sub: "cf-sub-bob", email: "bob@example.com" }),
      NO_RELINK,
    );

    expect(second.electedOwner).toBe(false);
    expect(second.user.role).toBe("user");

    const [state] = await db.select().from(instanceState).where(eq(instanceState.id, true));
    expect(state?.ownerId).toBe(first.user.id);
  });

  // --- 23 — THE RACE -------------------------------------------------
  it.each(Array.from({ length: 20 }, (_, i) => i))(
    "elects exactly one owner under 10 concurrent first requests (run %i)",
    async () => {
      await withCleanDatabase();

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          resolveUserForIdentity(
            db,
            identity({ sub: `cf-sub-${i}`, email: `user${i}@example.com` }),
            NO_RELINK,
          ),
        ),
      );

      const owners = await db.select().from(users).where(eq(users.role, "owner"));
      expect(owners).toHaveLength(1);

      expect(outcomes.filter((o) => o.electedOwner)).toHaveLength(1);

      const [state] = await db.select().from(instanceState).where(eq(instanceState.id, true));
      expect(state?.ownerId).toBe(owners[0]?.id);

      // All ten were provisioned; none was lost to the contention.
      expect(await db.select().from(users)).toHaveLength(10);
    },
  );

  // --- 29 ------------------------------------------------------------
  it("provisions one row when the same sub arrives twice concurrently", async () => {
    const results = await Promise.all([
      resolveUserForIdentity(db, identity(), NO_RELINK),
      resolveUserForIdentity(db, identity(), NO_RELINK),
    ]);

    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(results[0]?.user.id).toBe(results[1]?.user.id);
  });
});

describe("JIT provisioning and refresh (task 3.5)", () => {
  // --- 24 ------------------------------------------------------------
  it("updates the existing row when the IdP email changes, rather than creating a second", async () => {
    const first = await resolveUserForIdentity(db, identity(), NO_RELINK);
    const second = await resolveUserForIdentity(
      db,
      identity({ email: "alice.new@example.com" }),
      NO_RELINK,
    );

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe("alice.new@example.com");
    expect(await db.select().from(users)).toHaveLength(1);
  });

  // --- 25 ------------------------------------------------------------
  it("never overwrites user-entered first_name / last_name from the IdP", async () => {
    const created = await resolveUserForIdentity(db, identity(), NO_RELINK);
    await db
      .update(users)
      .set({ firstName: "Alice", lastName: "Anderson", onboardedAt: new Date() })
      .where(eq(users.id, created.user.id));

    const revisit = await resolveUserForIdentity(
      db,
      identity({ name: "Totally Different Name" }),
      NO_RELINK,
    );

    expect(revisit.user.firstName).toBe("Alice");
    expect(revisit.user.lastName).toBe("Anderson");
    expect(revisit.user.onboardedAt).not.toBeNull();
    // display_name IS kept in sync with the IdP.
    expect(revisit.user.displayName).toBe("Totally Different Name");
  });

  // --- 26 ------------------------------------------------------------
  it("never downgrades a role from the auth layer", async () => {
    const firstOwner = await resolveUserForIdentity(db, identity(), NO_RELINK);
    const promoted = await resolveUserForIdentity(
      db,
      identity({ sub: "cf-sub-bob", email: "bob@example.com" }),
      NO_RELINK,
    );
    // Demote the first-owner-election winner before manually promoting bob:
    // `users_single_owner_key` (Phase 4 task 4.8 review finding M-7) now
    // enforces at most one `role='owner'` row at the database level, and
    // this instance was never designed to support two simultaneous owners
    // — only this test's fixture briefly created that state to exercise
    // the "no downgrade" behavior below.
    await db.update(users).set({ role: "user" }).where(eq(users.id, firstOwner.user.id));
    await db.update(users).set({ role: "owner" }).where(eq(users.id, promoted.user.id));

    const revisit = await resolveUserForIdentity(
      db,
      identity({ sub: "cf-sub-bob", email: "bob@example.com" }),
      NO_RELINK,
    );
    expect(revisit.user.role).toBe("owner");
  });
});

describe("email uniqueness hazards (D-27)", () => {
  // --- 27 — Case A ---------------------------------------------------
  it("keeps the stale email and still authenticates when the refresh collides", async () => {
    await resolveUserForIdentity(db, identity(), NO_RELINK); // holds alice@example.com
    await resolveUserForIdentity(
      db,
      identity({ sub: "cf-sub-bob", email: "bob@example.com" }),
      NO_RELINK,
    );

    // Bob's IdP email changes to one Alice already holds.
    const outcome = await resolveUserForIdentity(
      db,
      identity({ sub: "cf-sub-bob", email: "alice@example.com" }),
      NO_RELINK,
    );

    expect(outcome.emailRefreshSkipped).toBe(true);
    expect(outcome.user.email).toBe("bob@example.com"); // stale, retained
    expect(outcome.user.cfAccessSub).toBe("cf-sub-bob"); // still authenticated
    expect(await db.select().from(users)).toHaveLength(2);
  });

  // --- 28 — Case B, flag off -----------------------------------------
  it("rejects cleanly and audits when a new sub collides on email", async () => {
    await resolveUserForIdentity(db, identity(), NO_RELINK);

    await expect(
      resolveUserForIdentity(db, identity({ sub: "cf-sub-alice-NEW-IDP" }), NO_RELINK),
    ).rejects.toBeInstanceOf(IdentityConflictError);

    // No orphan row, and the failure is recorded rather than swallowed.
    expect(await db.select().from(users)).toHaveLength(1);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "user.identity_conflict"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ sub: "cf-sub-alice-NEW-IDP" });
  });

  // --- 28b — Case B, flag on -----------------------------------------
  it("reassigns the sub onto the existing row when ACCESS_ALLOW_SUB_RELINK is on", async () => {
    const original = await resolveUserForIdentity(db, identity(), NO_RELINK);
    await db
      .update(users)
      .set({ firstName: "Alice", lastName: "Anderson" })
      .where(eq(users.id, original.user.id));

    const relinked = await resolveUserForIdentity(
      db,
      identity({ sub: "cf-sub-alice-NEW-IDP" }),
      RELINK,
    );

    expect(relinked.relinked).toBe(true);
    expect(relinked.user.id).toBe(original.user.id);
    expect(relinked.user.cfAccessSub).toBe("cf-sub-alice-NEW-IDP");
    // The user keeps their identity and their onboarding.
    expect(relinked.user.firstName).toBe("Alice");
    expect(await db.select().from(users)).toHaveLength(1);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "user.sub_relinked"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ newSub: "cf-sub-alice-NEW-IDP" });
  });

  // --- 28c -----------------------------------------------------------
  it("provisions normally with the flag on when the email matches nothing", async () => {
    await resolveUserForIdentity(db, identity(), RELINK);
    const fresh = await resolveUserForIdentity(
      db,
      identity({ sub: "cf-sub-bob", email: "bob@example.com" }),
      RELINK,
    );

    expect(fresh.created).toBe(true);
    expect(fresh.relinked).toBe(false);
    expect(await db.select().from(users)).toHaveLength(2);
  });
});

describe("election preconditions", () => {
  it("fails loudly if the instance_state singleton is missing", async () => {
    await getCleanPool().query("DELETE FROM instance_state");
    await expect(resolveUserForIdentity(db, identity(), NO_RELINK)).rejects.toThrow(
      /instance_state singleton/i,
    );
  });
});
