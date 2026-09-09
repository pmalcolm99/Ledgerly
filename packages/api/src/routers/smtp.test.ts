import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  mkTestUser,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { appConfig, auditLog, receipts } from "@ledgerly/db/schema";
import type { AuthUser } from "@ledgerly/auth/types";

import { appRouter } from "../root";
import type { Context } from "../trpc";
import { SECRET_KEYS, encryptSecret } from "../secrets";
import { resolveSmtpConfig } from "../smtp";

/**
 * packages/api/src/routers/smtp.test.ts — D-44's obligations on the API side.
 *
 * 1. Only the instance owner can read or change the SMTP settings.
 * 2. The password NEVER comes back over tRPC, in any shape.
 * 3. Saving with the password field omitted keeps the stored password —
 *    otherwise correcting a typo in the port silently breaks authentication.
 * 4. `receipts.emailReceipt` cannot address anyone outside the project.
 */

const MASTER_KEY = randomBytes(32).toString("base64");
const PASSWORD = "s3cret-relay-password";

beforeAll(() => {
  process.env.MASTER_KEY = MASTER_KEY;
});

let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxFor = (user: AuthUser | null, extra: Partial<Context> = {}): Context => ({
  db,
  user,
  ...extra,
});

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

const SETTINGS = {
  host: "mail.relay.example",
  port: 587,
  secure: false,
  user: "apikey",
  fromAddress: "receipts@example.com",
  fromName: "Ledgerly",
};

async function storeSettings(password = PASSWORD): Promise<void> {
  await db.insert(appConfig).values({
    key: SECRET_KEYS.smtp,
    valueEncrypted: encryptSecret(JSON.stringify({ ...SETTINGS, password }), MASTER_KEY),
  });
}

describe("admin.smtp — authorization", () => {
  it("a non-owner is refused on read and on every write", async () => {
    const member = await mkTestUser(db, "member");
    const caller = appRouter.createCaller(ctxFor(member as unknown as AuthUser));

    await expect(caller.admin.smtp()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.setSmtp({ ...SETTINGS, password: PASSWORD })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.admin.clearSmtp()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.admin.testSmtp()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("admin.smtp — the password never comes back", () => {
  it("returns every other field, and no field that could hold the password", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await storeSettings();

    const result = await appRouter.createCaller(ctxFor(owner as unknown as AuthUser)).admin.smtp();

    expect(result.host).toBe(SETTINGS.host);
    expect(result.port).toBe(587);
    expect(result.user).toBe("apikey");
    // A LENGTH, not a tail. `secretHint`'s last-four rule is calibrated for a
    // 100-plus character API key; a relay password is often 12-20, where four
    // characters is a third of it.
    expect(result.passwordHint).toBe(`${PASSWORD.length} characters`);
    expect(result.passwordHint).not.toContain(PASSWORD.slice(-4));

    // The strong form of the assertion: the password must not appear ANYWHERE
    // in the serialised response, however it might have been nested.
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(Object.keys(result)).not.toContain("password");
  });
});

describe("admin.setSmtp — blank password means unchanged", () => {
  it("keeps the stored password when the field is omitted", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await storeSettings();

    await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      // The port changed; the password was not retyped, because the form
      // cannot show it.
      .admin.setSmtp({ ...SETTINGS, port: 465, secure: true });

    const { config } = await resolveSmtpConfig(db, MASTER_KEY);
    expect(config?.port).toBe(465);
    expect(config?.secure).toBe(true);
    expect(config?.password).toBe(PASSWORD);
  });

  it("stores a new password when one is supplied", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await storeSettings();

    await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setSmtp({ ...SETTINGS, password: "a-new-password" });

    const { config } = await resolveSmtpConfig(db, MASTER_KEY);
    expect(config?.password).toBe("a-new-password");
  });

  /** With nothing stored there is no password to keep, and a username with no
   *  password would authenticate against nothing. */
  it("refuses a first save that supplies a username but no password", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await expect(
      appRouter.createCaller(ctxFor(owner as unknown as AuthUser)).admin.setSmtp(SETTINGS),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("audits the change, recording the host and never the credentials", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.setSmtp({ ...SETTINGS, password: PASSWORD });

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "app_config.updated"));
    expect(rows).toHaveLength(1);
    const metadata = JSON.stringify(rows[0]?.metadata);
    expect(metadata).toContain(SETTINGS.host);
    expect(metadata).not.toContain(PASSWORD);
    expect(metadata).not.toContain(SETTINGS.user);
  });
});

describe("admin.smtp — an undecryptable row", () => {
  it("is reported as its own state rather than as not-configured", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await db.insert(appConfig).values({
      key: SECRET_KEYS.smtp,
      valueEncrypted: encryptSecret(
        JSON.stringify({ ...SETTINGS, password: PASSWORD }),
        randomBytes(32).toString("base64"),
      ),
    });

    const result = await appRouter.createCaller(ctxFor(owner as unknown as AuthUser)).admin.smtp();
    expect(result.source).toBe("undecryptable");
    expect(result.passwordHint).toBeNull();
  });

  /** The recovery path must not require psql: clearing never reads the row. */
  it("can still be cleared", async () => {
    const owner = await mkTestUser(db, "owner", "owner");
    await db.insert(appConfig).values({
      key: SECRET_KEYS.smtp,
      valueEncrypted: encryptSecret("{}", randomBytes(32).toString("base64")),
    });

    const result = await appRouter
      .createCaller(ctxFor(owner as unknown as AuthUser))
      .admin.clearSmtp();
    expect(result.cleared).toBe(true);
    expect(await db.select().from(appConfig)).toHaveLength(0);
  });
});

describe("receipts.emailReceipt — the recipient must be a project member", () => {
  async function seed() {
    // SMTP has to be configured: the procedure refuses to promise "queued" on
    // an instance with no relay, which is asserted on its own below.
    await storeSettings();
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [{ key: "reader", permission: "read" }],
    });
    const [receipt] = await db
      .insert(receipts)
      .values({ projectId: project.id, extractionStatus: "ok", imageKey: "webp" })
      .returning({ id: receipts.id });
    return { project, users, receiptId: receipt!.id };
  }

  it("enqueues for a member, and audits the recipient by id", async () => {
    const { users, receiptId } = await seed();
    const enqueue = vi.fn(async () => {});

    await appRouter
      .createCaller(ctxFor(users.owner as unknown as AuthUser, { enqueueReceiptEmail: enqueue }))
      .receipts.emailReceipt({ id: receiptId, toUserId: users.reader!.id });

    expect(enqueue).toHaveBeenCalledWith({
      receiptId,
      toUserId: users.reader!.id,
      requestedBy: users.owner!.id,
    });

    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "receipt.email_requested"));
    expect(row?.entityId).toBe(receiptId);
    // An id, never an address — audit.ts's no-PII rule.
    expect(JSON.stringify(row?.metadata)).toContain(users.reader!.id);
    expect(JSON.stringify(row?.metadata)).not.toContain(users.reader!.email);
  });

  it("refuses a recipient who is not a member, and enqueues nothing", async () => {
    const { users, receiptId } = await seed();
    const stranger = await mkTestUser(db, "stranger");
    const enqueue = vi.fn(async () => {});

    await expect(
      appRouter
        .createCaller(ctxFor(users.owner as unknown as AuthUser, { enqueueReceiptEmail: enqueue }))
        .receipts.emailReceipt({ id: receiptId, toUserId: stranger.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(enqueue).not.toHaveBeenCalled();
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "receipt.email_requested")),
    ).toHaveLength(0);
  });

  /** A caller with no access must not be able to learn the receipt exists. */
  it("is NOT_FOUND for a caller outside the project", async () => {
    const { users, receiptId } = await seed();
    const stranger = await mkTestUser(db, "stranger");

    await expect(
      appRouter
        .createCaller(ctxFor(stranger as unknown as AuthUser))
        .receipts.emailReceipt({ id: receiptId, toUserId: users.owner!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  /** Read access is enough on purpose: forwarding to a fellow member discloses
   *  nothing either of them could not already open. */
  it("allows a read-only member to send to another member", async () => {
    const { users, receiptId } = await seed();
    const enqueue = vi.fn(async () => {});

    await appRouter
      .createCaller(ctxFor(users.reader as unknown as AuthUser, { enqueueReceiptEmail: enqueue }))
      .receipts.emailReceipt({ id: receiptId, toUserId: users.owner!.id });

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  /**
   * Without this the button reports "Queued. It will arrive in a moment" on an
   * instance with no relay, and the message dies in a worker log line the
   * caller cannot see — non-owners cannot read `admin.smtp` at all.
   */
  it("refuses, rather than promising delivery, when SMTP is not configured", async () => {
    const { project, users } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const [receipt] = await db
      .insert(receipts)
      .values({ projectId: project.id, extractionStatus: "ok", imageKey: "webp" })
      .returning({ id: receipts.id });
    const enqueue = vi.fn(async () => {});

    await expect(
      appRouter
        .createCaller(ctxFor(users.owner as unknown as AuthUser, { enqueueReceiptEmail: enqueue }))
        .receipts.emailReceipt({ id: receipt!.id, toUserId: users.owner!.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(enqueue).not.toHaveBeenCalled();
    // Nothing audited either: no request was authorised to completion.
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "receipt.email_requested")),
    ).toHaveLength(0);
  });

  /**
   * The audit row commits inside the transaction; the enqueue happens after
   * it. A capability that EXISTS and FAILS must therefore tell the caller
   * that nothing was sent — the flattened "Internal server error." cannot,
   * which is why this is SERVICE_UNAVAILABLE and why that code is on
   * `CLIENT_SAFE_CODES`.
   */
  it("reports a failed enqueue as 'nothing was sent', not as an internal error", async () => {
    const { users, receiptId } = await seed();
    const enqueue = vi.fn(async () => {
      throw new Error("redis is down");
    });

    await expect(
      appRouter
        .createCaller(ctxFor(users.owner as unknown as AuthUser, { enqueueReceiptEmail: enqueue }))
        .receipts.emailReceipt({ id: receiptId, toUserId: users.owner!.id }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
