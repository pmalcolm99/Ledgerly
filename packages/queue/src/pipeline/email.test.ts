import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestProjectWithMembers,
  getCleanPool,
  withCleanDatabase,
} from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { projects, receiptItems, receipts } from "@ledgerly/db/schema";
import { receiptFilePath, writeReceiptFile } from "@ledgerly/api/storage";

import { EmailError, processReceiptEmail } from "./email";
import type { EmailDeps, EmailTransport } from "./email";

let db: ReturnType<typeof drizzle<typeof schema>>;
let uploadsDir: string;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-email-test-"));
});

afterEach(async () => {
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await getCleanPool().end();
});

type SentMessage = Parameters<EmailTransport["sendMail"]>[0];

function fakeTransport(): { transport: EmailTransport; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    transport: {
      sendMail: vi.fn(async (message: SentMessage) => {
        sent.push(message);
      }),
    },
  };
}

function deps(transport: EmailTransport | null): EmailDeps {
  return {
    db,
    transport,
    from: { address: "receipts@example.com", name: "Ledgerly" },
    uploadsDir,
    maxMegapixels: 100,
    appOrigin: "https://receipts.example.com",
  };
}

async function seed(
  opts: { emailReceipts: boolean; members?: "reader"[] } = { emailReceipts: true },
) {
  const { project, users } = await createTestProjectWithMembers(db, {
    ownerKey: "owner",
    members: (opts.members ?? []).map((key) => ({ key, permission: "read" as const })),
  });
  await db
    .update(projects)
    .set({ emailReceipts: opts.emailReceipts })
    .where(eq(projects.id, project.id));

  const [receipt] = await db
    .insert(receipts)
    .values({
      projectId: project.id,
      extractionStatus: "ok",
      imageKey: "webp",
      thumbKey: "webp",
      merchantName: "Costco",
      transactionDate: "2026-09-09",
      subtotal: "20.00",
      total: "21.60",
    })
    .returning({ id: receipts.id });
  if (!receipt) throw new Error("seed: no receipt");

  await db.insert(receiptItems).values({
    receiptId: receipt.id,
    lineNo: 1,
    description: "Printer paper",
    lineTotal: "24.00",
  });

  const bytes = await sharp({
    create: { width: 900, height: 1400, channels: 3, background: { r: 220, g: 220, b: 220 } },
  })
    .webp()
    .toBuffer();
  await writeReceiptFile(
    receiptFilePath(uploadsDir, project.id, receipt.id, "display", "webp"),
    bytes,
  );

  return { project, users, receiptId: receipt.id };
}

describe("processReceiptEmail — the automatic send", () => {
  it("sends to the project owner and records the marker", async () => {
    const { users, receiptId } = await seed();
    const { transport, sent } = fakeTransport();

    const outcome = await processReceiptEmail(deps(transport), { receiptId, reason: "auto" });

    expect(outcome).toEqual({ sent: true, to: users.owner!.email });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain("Costco");
    expect(sent[0]?.from).toBe('"Ledgerly" <receipts@example.com>');

    const [row] = await db
      .select({ at: receipts.receiptEmailSentAt })
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(row?.at).toBeInstanceOf(Date);
  });

  /**
   * The reason `receipt_email_sent_at` exists at all. `receipts.reextract`
   * sets `forcePass2` and re-enters the persistence path, which re-enqueues
   * the automatic email — without the marker, every manual re-extract would
   * send a second copy of the same receipt.
   */
  it("does not send twice, which is what re-extract would otherwise cause", async () => {
    const { receiptId } = await seed();
    const { transport, sent } = fakeTransport();

    await processReceiptEmail(deps(transport), { receiptId, reason: "auto" });
    const second = await processReceiptEmail(deps(transport), { receiptId, reason: "auto" });

    expect(second).toEqual({ sent: false, skipped: "already_sent" });
    expect(sent).toHaveLength(1);
  });

  it("skips when the project has the setting off", async () => {
    const { receiptId } = await seed({ emailReceipts: false });
    const { transport, sent } = fakeTransport();

    const outcome = await processReceiptEmail(deps(transport), { receiptId, reason: "auto" });

    expect(outcome).toEqual({ sent: false, skipped: "project_setting_off" });
    expect(sent).toHaveLength(0);
  });

  /** The setting is read at SEND time, not enqueue time, so turning it off
   *  stops mail that is already queued. */
  it("honours the setting being turned off after the job was queued", async () => {
    const { project, receiptId } = await seed({ emailReceipts: true });
    await db.update(projects).set({ emailReceipts: false }).where(eq(projects.id, project.id));

    const { transport, sent } = fakeTransport();
    await processReceiptEmail(deps(transport), { receiptId, reason: "auto" });
    expect(sent).toHaveLength(0);
  });

  it("does not email a soft-deleted receipt", async () => {
    const { receiptId } = await seed();
    await db.update(receipts).set({ deletedAt: new Date() }).where(eq(receipts.id, receiptId));

    const { transport, sent } = fakeTransport();
    const outcome = await processReceiptEmail(deps(transport), { receiptId, reason: "auto" });

    expect(outcome).toEqual({ sent: false, skipped: "receipt_not_found" });
    expect(sent).toHaveLength(0);
  });

  it("fails non-retryably, and marks nothing, when SMTP is not configured", async () => {
    const { receiptId } = await seed();

    await expect(processReceiptEmail(deps(null), { receiptId, reason: "auto" })).rejects.toThrow(
      EmailError,
    );

    const [row] = await db
      .select({ at: receipts.receiptEmailSentAt })
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(row?.at).toBeNull();
  });

  /**
   * The retry-amplification guard.
   *
   * The marker is written after the send, so a crash between the two costs one
   * duplicate on a later re-extract — accepted, because a duplicate
   * notification beats a silent one. But letting the WRITE throw is different:
   * it makes the job retryable after a successful send, and the retry re-reads
   * a marker that is still null. With `attempts: 5`, a database that is
   * briefly unhappy — pool saturation while several extractions land at once,
   * which is exactly when these fire — would turn one delivered message into
   * five.
   */
  it("does not fail the job when the marker write fails, so a retry cannot duplicate the send", async () => {
    const { receiptId } = await seed();
    const { transport, sent } = fakeTransport();

    const base = deps(transport);
    // A Proxy, not a spread: drizzle's db carries its methods on a prototype,
    // so `{...db}` loses `select` and the test would fail before it reached
    // the line under test.
    const dbWithFailingUpdate = new Proxy(base.db, {
      get(target, property, receiver) {
        if (property === "update") {
          return () => {
            throw new Error("connection terminated");
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const outcome = await processReceiptEmail(
      { ...base, db: dbWithFailingUpdate as EmailDeps["db"] },
      { receiptId, reason: "auto" },
    );

    expect(outcome).toEqual({ sent: true, to: expect.any(String) });
    expect(sent).toHaveLength(1);
  });

  it("attaches a JPEG that is small enough to email", async () => {
    const { receiptId } = await seed();
    const { transport, sent } = fakeTransport();

    await processReceiptEmail(deps(transport), { receiptId, reason: "auto" });

    const attachment = sent[0]?.attachments[0];
    expect(attachment?.contentType).toBe("image/jpeg");
    expect(attachment?.filename).toBe(`receipt-${receiptId}.jpg`);
    expect(attachment?.content.length).toBeGreaterThan(0);
    expect(attachment?.content.length).toBeLessThan(300_000);
    // The magic bytes, so a rename cannot pass for a re-encode.
    expect(attachment?.content.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});

describe("processReceiptEmail — the on-demand send", () => {
  it("sends to a project member, ignoring the project setting and the marker", async () => {
    const { users, receiptId } = await seed({ emailReceipts: false, members: ["reader"] });
    const { transport, sent } = fakeTransport();

    const outcome = await processReceiptEmail(deps(transport), {
      receiptId,
      reason: "on_demand",
      toUserId: users.reader!.id,
      requestedBy: users.owner!.id,
    });

    expect(outcome).toEqual({ sent: true, to: users.reader!.email });
    expect(sent[0]?.to).toBe(users.reader!.email);
  });

  /** The second of the two membership checks — the procedure does one, this is
   *  the one that holds if a job is ever enqueued from anywhere else, or if
   *  the recipient was removed from the project between the two. */
  it("refuses a recipient who is not a member of the project", async () => {
    const { users, receiptId } = await seed({ emailReceipts: false });
    const { project: otherProject, users: strangers } = await createTestProjectWithMembers(db, {
      ownerKey: "stranger",
      members: [],
    });
    expect(otherProject.id).toBeTruthy();

    const { transport, sent } = fakeTransport();
    const outcome = await processReceiptEmail(deps(transport), {
      receiptId,
      reason: "on_demand",
      toUserId: strangers.stranger!.id,
      requestedBy: users.owner!.id,
    });

    expect(outcome).toEqual({ sent: false, skipped: "recipient_not_a_member" });
    expect(sent).toHaveLength(0);
  });

  it("does not touch the automatic-send marker", async () => {
    const { users, receiptId } = await seed({ emailReceipts: false, members: ["reader"] });
    const { transport } = fakeTransport();

    await processReceiptEmail(deps(transport), {
      receiptId,
      reason: "on_demand",
      toUserId: users.reader!.id,
      requestedBy: users.owner!.id,
    });

    const [row] = await db
      .select({ at: receipts.receiptEmailSentAt })
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    // Still null: the marker records whether the AUTOMATIC email has gone, and
    // an on-demand send says nothing about that.
    expect(row?.at).toBeNull();
  });
});
