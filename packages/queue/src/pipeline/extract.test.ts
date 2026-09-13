import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
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
import { aiUsage, receiptItems, receipts } from "@ledgerly/db/schema";
import { receiptFilePath, writeReceiptFile } from "@ledgerly/api/storage";

import { ExtractError, processReceiptExtraction } from "./extract";
import type { AnthropicMessagesClient, ProcessReceiptExtractionDeps } from "./extract";

let db: ReturnType<typeof drizzle<typeof schema>>;
let uploadsDir: string;

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
  uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledgerly-extract-test-"));
});

afterEach(async () => {
  await fs.rm(uploadsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await getCleanPool().end();
});

async function insertReceiptWithRender(
  projectId: string,
  overrides: Partial<typeof receipts.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(receipts)
    .values({
      projectId,
      extractionStatus: "pending",
      imageKey: "webp",
      thumbKey: "webp",
      ...overrides,
    })
    .returning({ id: receipts.id });
  if (!row) throw new Error("failed to insert test receipt");

  const displayPath = receiptFilePath(uploadsDir, projectId, row.id, "display", "webp");
  const bytes = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .webp()
    .toBuffer();
  await writeReceiptFile(displayPath, bytes);

  return row.id;
}

function fakeClient(
  responses: Array<{ input: Record<string, unknown>; inputTokens?: number; outputTokens?: number }>,
): AnthropicMessagesClient {
  let call = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const response = responses[Math.min(call, responses.length - 1)];
        call++;
        if (!response) throw new Error("fakeClient: no response configured");
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: "tool_use",
          stop_sequence: null,
          content: [
            {
              type: "tool_use",
              id: "toolu_test",
              name: "record_receipt",
              input: response.input,
            },
          ],
          usage: {
            input_tokens: response.inputTokens ?? 1000,
            output_tokens: response.outputTokens ?? 100,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            server_tool_use: null,
            inference_geo: null,
          },
        } as unknown as Awaited<ReturnType<AnthropicMessagesClient["messages"]["create"]>>;
      }),
    },
  };
}

function cleanRecordReceiptInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    merchant_name: "Ace Hardware",
    merchant_address: "123 Main St",
    merchant_phone: "555-1234",
    transaction_date: "2026-01-15",
    transaction_time: "14:30",
    subtotal: "10.00",
    sales_tax: "1.00",
    tip: null,
    total: "11.00",
    card_last4: "1234",
    payment_method: "credit",
    confidence: 0.95,
    items: [
      {
        description: "Hammer",
        quantity: "1",
        unit_price: "10.00",
        line_total: "10.00",
        category: "tools-equipment",
      },
    ],
    ...overrides,
  };
}

/**
 * A clock pinned two days after `cleanRecordReceiptInput`'s date, so the
 * fixture reads as a RECENT receipt.
 *
 * Without this every test in this file would trip D-47's stale-date second
 * opinion — the fixture date is fixed, so it drifts further into the past every
 * week — and the call-count assertions below would start failing on a calendar
 * boundary rather than on a code change.
 */
const FRESH_NOW = new Date("2026-01-17T12:00:00Z");

function deps(client: AnthropicMessagesClient): ProcessReceiptExtractionDeps {
  return {
    now: () => FRESH_NOW,
    db,
    anthropicClient: client,
    uploadsDir,
    maxMegapixels: 100,
    modelPass1: "claude-haiku-4-5",
    modelPass2: "claude-sonnet-5",
    escalateBelow: 0.6,
  };
}

describe("processReceiptExtraction", () => {
  it("persists a clean pass-1 result without escalating", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    // "tools-equipment" is a seeded system category (withCleanDatabase's
    // seed() call) -- no manual insert needed.
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([{ input: cleanRecordReceiptInput() }]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.extractionStatus).toBe("ok");
    expect(row?.extractionPass).toBe(1);
    expect(row?.extractionModel).toBe("claude-haiku-4-5");
    expect(row?.total).toBe("11.00");
    expect(row?.cardLast4).toBe("1234");
    expect(row?.missingFields).toEqual([]);
    expect(row?.validationFlags).toEqual([]);

    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("Hammer");
    expect(items[0]?.aiAssignedCategory).toBe(true);

    const usage = await db.select().from(aiUsage).where(eq(aiUsage.receiptId, receiptId));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.pass).toBe(1);
    expect(usage[0]?.escalated).toBe(false);
  });

  it("escalates to pass 2 when total is null", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([
      { input: cleanRecordReceiptInput({ total: null }) },
      { input: cleanRecordReceiptInput() },
    ]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.extractionPass).toBe(2);
    expect(row?.extractionModel).toBe("claude-sonnet-5");
    expect(row?.total).toBe("11.00"); // pass 2's clean result

    const usage = await db.select().from(aiUsage).where(eq(aiUsage.receiptId, receiptId));
    expect(usage).toHaveLength(2);
    expect(usage.find((u) => u.pass === 2)?.escalated).toBe(true);
  });

  it("escalates when confidence is below the threshold", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([
      { input: cleanRecordReceiptInput({ confidence: 0.2 }) },
      { input: cleanRecordReceiptInput() },
    ]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("does not escalate a clean, confident pass-1 result", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([{ input: cleanRecordReceiptInput() }]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("sets extraction_status='partial' with validation_flags when a sanity check trips", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([{ input: cleanRecordReceiptInput({ total: "999.00" }) }]);
    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.extractionStatus).toBe("partial");
    expect(row?.validationFlags).toContain("arithmetic_mismatch_total");
  });

  it("forcePass2 calls Sonnet directly, skipping the ladder", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id, { extractionStatus: "ok" });

    const client = fakeClient([{ input: cleanRecordReceiptInput() }]);
    await processReceiptExtraction(deps(client), { receiptId, forcePass2: true });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.extractionModel).toBe("claude-sonnet-5");
    expect(row?.extractionPass).toBe(2);

    const usage = await db.select().from(aiUsage).where(eq(aiUsage.receiptId, receiptId));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.escalated).toBe(false); // manual force, not a ladder escalation
  });

  it("is idempotent: re-extracting replaces items rather than duplicating them", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id, { extractionStatus: "ok" });

    const client = fakeClient([
      { input: cleanRecordReceiptInput() },
      {
        input: cleanRecordReceiptInput({
          items: [
            {
              description: "Hammer",
              quantity: "1",
              unit_price: "10.00",
              line_total: "10.00",
              category: "tools-equipment",
            },
            {
              description: "Nails",
              quantity: "1",
              unit_price: "5.00",
              line_total: "5.00",
              category: "tools-equipment",
            },
          ],
        }),
      },
    ]);
    await processReceiptExtraction(deps(client), { receiptId, forcePass2: true });
    await processReceiptExtraction(deps(client), { receiptId, forcePass2: true });

    // 2, not 3 -- the second run's items REPLACED the first run's, not
    // appended to them.
    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    expect(items).toHaveLength(2);
  });

  /**
   * Acknowledged validation flags get the same lifecycle as dismissed fields:
   * preserved across an automatic re-run, cleared by a manual re-extract.
   *
   * The first half is the one that matters. `runSanityChecks` recomputes flags
   * from scratch every run, so without subtracting the stored
   * acknowledgements, an automatic retry resurrects a warning the user has
   * already dealt with — and puts the receipt back in the review queue.
   */
  it("preserves acknowledged flags across an automatic run and clears them on a manual one", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    // Subtotal that disagrees with the items by more than the $1 tolerance —
    // the discounted-receipt shape, where the printed subtotal has the discount
    // taken twice.
    const mismatched = cleanRecordReceiptInput({
      subtotal: "10.00",
      sales_tax: "1.00",
      total: "11.00",
      items: [
        {
          description: "Windshield",
          quantity: "1",
          unit_price: "45.00",
          line_total: "45.00",
          category: "tools-equipment",
        },
      ],
    });
    const client = fakeClient([
      { input: mismatched },
      { input: mismatched },
      { input: mismatched },
    ]);

    await processReceiptExtraction(deps(client), { receiptId });
    let [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row!.validationFlags).toContain("arithmetic_mismatch_items");

    // The user acknowledges it.
    await db
      .update(receipts)
      .set({ acknowledgedFlags: ["arithmetic_mismatch_items"] })
      .where(eq(receipts.id, receiptId));

    // An AUTOMATIC re-run (no forcePass2) must not resurrect it.
    await db
      .update(receipts)
      .set({ extractionStatus: "pending" })
      .where(eq(receipts.id, receiptId));
    await processReceiptExtraction(deps(client), { receiptId });
    [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row!.acknowledgedFlags).toEqual(["arithmetic_mismatch_items"]);
    expect(row!.validationFlags).not.toContain("arithmetic_mismatch_items");
    expect(row!.extractionStatus).toBe("ok");

    // A MANUAL re-extract is a request for a fresh opinion, so the slate is
    // cleared and the flag comes back — same rule dismissed fields follow.
    await processReceiptExtraction(deps(client), { receiptId, forcePass2: true });
    [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row!.acknowledgedFlags).toEqual([]);
    expect(row!.validationFlags).toContain("arithmetic_mismatch_items");
    expect(row!.extractionStatus).toBe("partial");
  });

  /**
   * The Lowe's receipt, to the cent.
   *
   *   295429 GRACO MAGNUM X5      360.05      <- already the NET price
   *      379.00 DISCOUNT EACH    -18.95      <- explains the line above
   *   110249 SCTCH BLUE           33.23
   *      34.98 DISCOUNT EACH      -1.75
   *   3487097 PS 12-CT            22.78
   *      23.98 DISCOUNT EACH      -1.20
   *   SUBTOTAL: 416.06   TAX: 30.16   TOTAL: 446.22
   *
   * 360.05 + 33.23 + 22.78 = 416.06, so the receipt reconciles perfectly. Read
   * with each DISCOUNT EACH sub-line as its own item, the items sum to 394.16
   * — short by exactly 21.90, the "TOTAL SAVINGS THIS TRIP" printed at the
   * bottom.
   */
  const LOWES_MISREAD = {
    merchant_name: "LOWE'S HOME CENTERS, LLC",
    merchant_address: "1200 EAST CYPRESS AVENUE, REDDING, CA 96002",
    merchant_phone: "(530) 351-0181",
    transaction_date: "2026-09-06",
    transaction_time: null,
    subtotal: "416.06",
    sales_tax: "30.16",
    tip: null,
    total: "446.22",
    card_last4: null,
    payment_method: null,
    confidence: 0.93,
    items: [
      {
        description: "GRACO MAGNUM X5",
        quantity: "1",
        unit_price: "379.00",
        line_total: "360.05",
        category: "tools-equipment",
      },
      {
        description: "DISCOUNT EACH",
        quantity: "1",
        unit_price: "-18.95",
        line_total: "-18.95",
        category: "tools-equipment",
      },
      {
        description: "SCTCH BLUE 1.41 PAINTRS T",
        quantity: "1",
        unit_price: "34.98",
        line_total: "33.23",
        category: "tools-equipment",
      },
      {
        description: "DISCOUNT EACH",
        quantity: "1",
        unit_price: "-1.75",
        line_total: "-1.75",
        category: "tools-equipment",
      },
      {
        description: "PS 12-CT 9X12 PLSTC DC",
        quantity: "1",
        unit_price: "23.98",
        line_total: "22.78",
        category: "tools-equipment",
      },
      {
        description: "DISCOUNT EACH",
        quantity: "1",
        unit_price: "-1.20",
        line_total: "-1.20",
        category: "tools-equipment",
      },
    ],
  };

  /** The same receipt read correctly: net prices, no separate discount rows. */
  const LOWES_CORRECT = {
    ...LOWES_MISREAD,
    items: [
      {
        description: "GRACO MAGNUM X5",
        quantity: "1",
        unit_price: "379.00",
        line_total: "360.05",
        category: "tools-equipment",
      },
      {
        description: "SCTCH BLUE 1.41 PAINTRS T",
        quantity: "1",
        unit_price: "34.98",
        line_total: "33.23",
        category: "tools-equipment",
      },
      {
        description: "PS 12-CT 9X12 PLSTC DC",
        quantity: "1",
        unit_price: "23.98",
        line_total: "22.78",
        category: "tools-equipment",
      },
    ],
  };

  it("re-reads a receipt whose items do not sum to the subtotal, and keeps the correction", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner", members: [] });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([{ input: LOWES_MISREAD }, { input: LOWES_CORRECT }]);
    await processReceiptExtraction(deps(client), { receiptId });

    // Two calls: the first reading, then one corrective re-read.
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    // The retry carried the discrepancy back to the model.
    const retryRequest = vi.mocked(client.messages.create).mock.calls[1]?.[0] as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    const hint = retryRequest.messages[0]?.content.find((c) =>
      c.text?.includes("does not reconcile"),
    );
    expect(hint?.text).toContain("394.16");
    expect(hint?.text).toContain("416.06");
    expect(hint?.text).toContain("21.90");

    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    expect(items).toHaveLength(3);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row!.validationFlags).toEqual([]);
    expect(row!.extractionStatus).toBe("ok");
  });

  it("keeps the FIRST reading when the re-read still does not reconcile", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner", members: [] });
    const receiptId = await insertReceiptWithRender(project.id);

    // Both readings are wrong; the second is wrong differently.
    const alsoWrong = {
      ...LOWES_MISREAD,
      items: [LOWES_MISREAD.items[0]!, LOWES_MISREAD.items[1]!],
    };
    const client = fakeClient([{ input: LOWES_MISREAD }, { input: alsoWrong }]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(2);
    // Six items, not two: two readings that both fail to add up are not better
    // than one, so the original stands rather than the most recent.
    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    expect(items).toHaveLength(6);

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row!.validationFlags).toContain("arithmetic_mismatch_items");
  });

  it("does not re-read a receipt that already adds up", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner", members: [] });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([{ input: LOWES_CORRECT }]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("survives a corrective re-read that throws, keeping the first reading", async () => {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner", members: [] });
    const receiptId = await insertReceiptWithRender(project.id);

    let call = 0;
    const client = {
      messages: {
        create: vi.fn(async (...args: unknown[]) => {
          call += 1;
          if (call === 1) {
            return (
              fakeClient([{ input: LOWES_MISREAD }]).messages.create as (
                ...a: unknown[]
              ) => Promise<unknown>
            )(...args);
          }
          throw new Error("network down");
        }),
      },
    } as unknown as AnthropicMessagesClient;

    // A receipt that extracted successfully must not be lost to a failure in
    // an optional second opinion.
    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row!.extractionStatus).toBe("partial");
    expect(row!.validationFlags).toContain("arithmetic_mismatch_items");
    expect(row!.total).toBe("446.22");
  });

  /** With pass 1 and pass 2 on the same model (the D-12-amended default),
   *  escalating would be a second identical paid call for an identical answer. */
  it("does not escalate when both passes are the same model", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);
    // `total: null` would normally escalate.
    const client = fakeClient([
      { input: cleanRecordReceiptInput({ total: null }) },
      { input: cleanRecordReceiptInput({ total: null }) },
    ]);

    await processReceiptExtraction(
      { ...deps(client), modelPass1: "claude-sonnet-5", modelPass2: "claude-sonnet-5" },
      { receiptId },
    );

    const usage = await db.select().from(aiUsage).where(eq(aiUsage.receiptId, receiptId));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.pass).toBe(1);
  });

  it("is a no-op on an already-completed receipt without forcePass2", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id, { extractionStatus: "ok" });

    const client = fakeClient([{ input: cleanRecordReceiptInput() }]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("is a no-op on a soft-deleted receipt", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id, { deletedAt: new Date() });

    const client = fakeClient([{ input: cleanRecordReceiptInput() }]);
    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("throws RECEIPT_NOT_FOUND for a nonexistent receipt", async () => {
    const client = fakeClient([{ input: cleanRecordReceiptInput() }]);
    await expect(
      processReceiptExtraction(deps(client), { receiptId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(ExtractError);
  });

  it("falls back to uncategorized for a category slug the model invents", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([
      {
        input: cleanRecordReceiptInput({
          items: [
            {
              description: "Widget",
              quantity: "1",
              unit_price: "5.00",
              line_total: "5.00",
              category: "not-a-real-category",
            },
          ],
        }),
      },
    ]);
    await processReceiptExtraction(deps(client), { receiptId });

    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    // "uncategorized" is a seeded system category (withCleanDatabase's
    // seed() call), so the invented slug resolves to that real row's id --
    // the point under test is that the invented slug was rejected outright,
    // not persisted as-is.
    const [uncategorized] = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.slug, "uncategorized"));
    expect(items[0]?.categoryId).toBe(uncategorized?.id);
  });

  it("throws (does not persist) when the API call fails", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client: AnthropicMessagesClient = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    };

    await expect(processReceiptExtraction(deps(client), { receiptId })).rejects.toThrow(
      ExtractError,
    );

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.extractionStatus).toBe("pending"); // untouched -- worker.ts owns failure state
  });

  // Review finding M-4: retryable vs non-retryable classification.
  it("marks a 400 Bad Request as non-retryable", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client: AnthropicMessagesClient = {
      messages: {
        create: vi.fn(async () => {
          throw new Anthropic.BadRequestError(
            400,
            { error: { message: "bad schema" } },
            "Bad request",
            new Headers(),
          );
        }),
      },
    };

    await expect(processReceiptExtraction(deps(client), { receiptId })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("marks a 429 rate limit as retryable", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client: AnthropicMessagesClient = {
      messages: {
        create: vi.fn(async () => {
          throw new Anthropic.RateLimitError(
            429,
            { error: { message: "rate limited" } },
            "Too many requests",
            new Headers(),
          );
        }),
      },
    };

    await expect(processReceiptExtraction(deps(client), { receiptId })).rejects.toMatchObject({
      reason: "AI_RATE_LIMITED",
      retryable: true,
    });
  });

  // Review finding M-5: a billed call that produced nothing usable must
  // still show up in ai_usage (ok:false), not vanish from spend tracking.
  it("records ai_usage with ok:false when the response has no tool_use block", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client: AnthropicMessagesClient = {
      messages: {
        create: vi.fn(async () => ({
          id: "msg_no_tool",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: "end_turn",
          stop_sequence: null,
          content: [{ type: "text", text: "I could not read this receipt." }],
          usage: { input_tokens: 500, output_tokens: 50 },
        })) as unknown as AnthropicMessagesClient["messages"]["create"],
      },
    };

    await expect(processReceiptExtraction(deps(client), { receiptId })).rejects.toMatchObject({
      reason: "AI_NO_TOOL_USE",
    });

    const usage = await db.select().from(aiUsage).where(eq(aiUsage.receiptId, receiptId));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.ok).toBe(false);
    expect(usage[0]?.inputTokens).toBe(500);
  });

  // Review findings H-2/H-3: malformed or DB-constraint-violating model
  // output must degrade gracefully, never abort the persist transaction.
  it("nulls transaction_date rather than violating receipts_date_sane when date_too_old trips", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([
      { input: cleanRecordReceiptInput({ transaction_date: "1999-06-15" }) },
    ]);
    // Would throw a Postgres CHECK violation before the fix.
    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.transactionDate).toBeNull();
    expect(row?.validationFlags).toContain("date_too_old");
    expect(row?.missingFields).toContain("transaction_date");
  });

  it("rejects a nonsensical confidence value to 0 rather than violating receipts_confidence_range", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    // 95 (e.g. a model reporting a percentage) is out of the 0-1 CHECK
    // range and would abort the write before the fix.
    const client = fakeClient([{ input: cleanRecordReceiptInput({ confidence: 95 }) }]);
    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(Number(row?.extractionConfidence)).toBe(0);
  });

  it("nulls a calendar-invalid date rather than violating the date column", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([
      { input: cleanRecordReceiptInput({ transaction_date: "2026-13-45" }) },
    ]);
    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.transactionDate).toBeNull();
    expect(row?.missingFields).toContain("transaction_date");
  });

  it("drops a malformed item instead of crashing on it", async () => {
    const { project } = await createTestProjectWithMembers(db, {
      ownerKey: "owner",
      members: [],
    });
    const receiptId = await insertReceiptWithRender(project.id);

    const client = fakeClient([
      {
        input: cleanRecordReceiptInput({
          items: [
            null, // a malformed array element that would previously crash .map()
            {
              description: "Hammer",
              quantity: "1",
              unit_price: "10.00",
              line_total: "10.00",
              category: "tools-equipment",
            },
          ],
        }),
      },
    ]);
    await processReceiptExtraction(deps(client), { receiptId });

    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("Hammer");
  });
});

/**
 * D-47 — one second opinion, three reasons to want it.
 *
 * `deps()` pins the clock two days after the fixture's date, so these tests
 * move the CLOCK rather than the receipt to make a date stale. The date
 * trigger is the only one that fires without a distinct escalation model, and
 * the tests below are mostly about that asymmetry.
 */
describe("the second opinion (D-47)", () => {
  const STALE_NOW = new Date("2026-03-01T12:00:00Z"); // six weeks after the fixture

  async function newReceipt() {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner", members: [] });
    return insertReceiptWithRender(project.id);
  }

  it("re-reads a stale date even when both passes use the same model", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      { input: cleanRecordReceiptInput() },
      { input: cleanRecordReceiptInput() },
    ]);

    await processReceiptExtraction(
      {
        ...deps(client),
        now: () => STALE_NOW,
        modelPass1: "claude-sonnet-5",
        modelPass2: "claude-sonnet-5",
      },
      { receiptId },
    );

    // Two calls, on an instance with nowhere to escalate TO. The question is
    // "do two reads agree", not "can a better model do more".
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    // They agreed, so no flag — this is the case that keeps a genuinely old
    // receipt quiet instead of asking about every delayed upload.
    expect(row?.dateUnconfirmed).toBe(false);
    expect(row?.validationFlags).not.toContain("date_unconfirmed");
  });

  it("flags the date when the two readings disagree", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      { input: cleanRecordReceiptInput({ transaction_date: "2026-01-15" }) },
      { input: cleanRecordReceiptInput({ transaction_date: "2025-01-15" }) },
    ]);

    await processReceiptExtraction({ ...deps(client), now: () => STALE_NOW }, { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.dateUnconfirmed).toBe(true);
    expect(row?.validationFlags).toContain("date_unconfirmed");
    // The flag is acknowledgeable like any other, so the receipt is not stuck.
    expect(row?.extractionStatus).toBe("partial");
  });

  /** A second read that lost the date must not take the first read's answer
   *  with it — that turns "unconfirmed" into "missing", which is strictly less
   *  information. */
  it("keeps the first reading's date when the second returns none", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      { input: cleanRecordReceiptInput({ transaction_date: "2026-01-15" }) },
      { input: cleanRecordReceiptInput({ transaction_date: null }) },
    ]);

    await processReceiptExtraction({ ...deps(client), now: () => STALE_NOW }, { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.transactionDate).toBe("2026-01-15");
    expect(row?.dateUnconfirmed).toBe(true);
    expect(row?.missingFields).not.toContain("transaction_date");
  });

  it("does not re-read a recent date", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([{ input: cleanRecordReceiptInput() }]);

    await processReceiptExtraction(deps(client), { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  /**
   * The trigger the user asked for: a confident reading that still does not
   * add up gets a second opinion from the escalation model. D-12's amendment
   * declined this as a REPLACEMENT for fixing the prompt; as a safety net on
   * top of a corrected prompt it is a different proposition.
   */
  it("re-reads with the escalation model when the first reading needs review", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      // Confident, complete, and the items do not reach the subtotal.
      { input: cleanRecordReceiptInput({ subtotal: "50.00", total: "51.00" }) },
      { input: cleanRecordReceiptInput() },
    ]);

    await processReceiptExtraction({ ...deps(client), rescanOnReview: true }, { receiptId });

    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.extractionModel).toBe("claude-sonnet-5");
    expect(row?.validationFlags).toEqual([]);
  });

  it("does not re-read on review when the setting is off", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      { input: cleanRecordReceiptInput({ subtotal: "50.00", total: "51.00" }) },
      { input: cleanRecordReceiptInput({ subtotal: "50.00", total: "51.00" }) },
    ]);

    await processReceiptExtraction({ ...deps(client), rescanOnReview: false }, { receiptId });

    // One extraction call, plus the pre-existing corrective re-read — which is
    // a different mechanism and is NOT what this setting controls.
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  /** A same-model rescan-on-review is a second identical paid call for an
   *  identical answer, so it must not happen. */
  it("does not rescan on review when there is nowhere to escalate to", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      { input: cleanRecordReceiptInput({ subtotal: "50.00", total: "51.00" }) },
      { input: cleanRecordReceiptInput({ subtotal: "50.00", total: "51.00" }) },
    ]);

    await processReceiptExtraction(
      {
        ...deps(client),
        rescanOnReview: true,
        modelPass1: "claude-sonnet-5",
        modelPass2: "claude-sonnet-5",
      },
      { receiptId },
    );

    // Only the corrective re-read, which is deliberately not gated on the
    // model differing because it hands the model new information.
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });
});

describe("tax-inclusive and order-level credits (D-47)", () => {
  async function newReceipt() {
    const { project } = await createTestProjectWithMembers(db, { ownerKey: "owner", members: [] });
    return insertReceiptWithRender(project.id);
  }

  /** A fuel receipt: the pump price already contains the tax. Tax is zero by
   *  construction and a blank tax is the right answer, not a gap. */
  it("stores zero tax and does not call it missing when prices include tax", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      {
        input: cleanRecordReceiptInput({
          tax_included_in_prices: true,
          sales_tax: null,
          subtotal: "40.00",
          total: "40.00",
          items: [
            {
              description: "Unleaded 12.5 gal",
              quantity: "12.5",
              unit_price: "3.20",
              line_total: "40.00",
              category: "transportation-fuel",
            },
          ],
        }),
      },
    ]);

    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.taxIncluded).toBe(true);
    expect(row?.salesTax).toBe("0.00");
    expect(row?.missingFields).not.toContain("sales_tax");
    // The receipt still has to add up; it just adds up with zero tax.
    expect(row?.validationFlags).toEqual([]);
  });

  /** The bug this fixes: an order-level coupon used to be emitted as a
   *  negative line item, which dropped the item sum below the subtotal and
   *  flagged a correctly-read receipt. */
  it("keeps an order-level credit out of the item sum", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      {
        input: cleanRecordReceiptInput({
          subtotal: "10.00",
          transaction_discount: "-5.00",
          sales_tax: "1.00",
          total: "6.00",
        }),
      },
    ]);

    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.transactionDiscount).toBe("-5.00");
    expect(row?.validationFlags).toEqual([]);
    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    expect(items).toHaveLength(1);
    expect(items[0]?.lineTotal).toBe("10.00");
  });

  /** Nothing about case (a) changes: a discount already inside a line's price
   *  is still one item at the net price. */
  it("leaves an already-applied line discount alone", async () => {
    const receiptId = await newReceipt();
    const client = fakeClient([
      {
        input: cleanRecordReceiptInput({
          subtotal: "360.05",
          sales_tax: "0.00",
          total: "360.05",
          transaction_discount: null,
          items: [
            {
              description: "GRACO MAGNUM X5",
              quantity: "1",
              unit_price: "379.00",
              line_total: "360.05",
              category: "tools-equipment",
            },
          ],
        }),
      },
    ]);

    await processReceiptExtraction(deps(client), { receiptId });

    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row?.transactionDiscount).toBeNull();
    expect(row?.validationFlags).toEqual([]);
  });
});
