import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { aiUsage, categories, receiptItems, receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";

import { buildExtractionRequest } from "./anthropicRequest";
import {
  normalizeConfidence,
  normalizeDate,
  normalizeMoney,
  normalizeQuantity,
  normalizeTime,
} from "./normalize";
import { regenerateExtractionRender } from "./render";
import { buildRecordReceiptTool } from "./schema";
import type { RecordReceiptInput, RecordReceiptItemInput } from "./schema";
import { normalizeCardLast4, scrubLuhnSequences } from "./scrub";
import { runSanityChecks } from "./validate";
import type { ValidationInput } from "./validate";

/**
 * packages/queue/src/pipeline/extract.ts — the `receipt-extract` per-job
 * processor body (tasks 6.4-6.8, ARCHITECTURE.md §6). Deliberately
 * Worker-agnostic (no BullMQ import here), mirroring `pipeline/ingest.ts`
 * — `worker.ts` wraps this in an actual BullMQ `Worker` and owns retry/
 * failure-state bookkeeping; this function only throws.
 */

export type ExtractJobData = { receiptId: string; forcePass2?: boolean };

/** Mirrors `IngestError` (`pipeline/ingest.ts`): a stable `reason` code,
 * never a detail-carrying message (BullMQ persists `Error.message` as the
 * job's `failedReason` in Redis). Reason codes are prefixed distinctly
 * from ingest's own (`PDFTOPPM_UNAVAILABLE` etc.) so an operator reading
 * `extraction_error` alone can tell which pipeline stage failed — this is
 * `docs/STATE.md`'s Phase 5 carried-forward LOW item, resolved without a
 * new column.
 *
 * `retryable` (review finding M-4): a 400/401/403/404 from the Anthropic
 * API will not fix itself on retry (a malformed request, a bad API key, a
 * revoked key) — `worker.ts` throws BullMQ's `UnrecoverableError` for
 * these instead of burning all 3 attempts with backoff delays on an error
 * that cannot succeed. 429/529/connection failures, and any structural
 * response-shape failure, stay retryable (their default). */
export class ExtractError extends Error {
  reason: string;
  retryable: boolean;
  constructor(reason: string, opts: { retryable?: boolean } = {}) {
    super(reason);
    this.name = "ExtractError";
    this.reason = reason;
    this.retryable = opts.retryable ?? true;
  }
}

/** The subset of the real Anthropic SDK client this pipeline calls —
 * injected so tests use a fake instead of a real API key/network call.
 * `worker.ts` constructs the real `Anthropic` client in production. */
export type AnthropicMessagesClient = {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
};

export type ProcessReceiptExtractionDeps = {
  db: Database;
  anthropicClient: AnthropicMessagesClient;
  uploadsDir: string;
  maxMegapixels: number;
  modelPass1: string;
  modelPass2: string;
  escalateBelow: number;
};

type PassResult = {
  model: string;
  input: RecordReceiptInput;
  rawScrubbed: unknown;
};

/** Structural gate only — must be an object with an `items` array. Every
 * individual FIELD is validated (and degrades to null rather than
 * throwing) by `normalize.ts` and the item filter in
 * `mapItems` below (review finding H-3) — rejecting the whole response
 * over one malformed field would discard an otherwise-good extraction,
 * against CLAUDE.md's "a null field is fine" philosophy. This function
 * only catches a response so malformed that field-by-field mapping
 * couldn't even proceed (not an object, or `items` isn't an array). */
function isRecordReceiptInputShape(value: unknown): value is RecordReceiptInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "confidence" in value &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

/** Maps an Anthropic SDK error to a stable `ExtractError` reason, most-
 * specific-first per the `claude-api` skill's error-handling guidance —
 * never a single broad `catch` that loses the retryable/non-retryable
 * distinction. `worker.ts`'s BullMQ-level backoff is what actually retries
 * (task 6.9); this classifies both the "why" that ends up in
 * `extraction_error` and (M-4) whether retrying can possibly help. */
/**
 * One line an operator can act on, for a call that never returned.
 *
 * `[ledgerly] ai call failed receipt=<id> model=<model> pass=<n>
 *  status=404 type=not_found_error message=model: claude-haiku-4-5`
 *
 * Deliberately server-side only. The UI still gets a status and a reason code
 * (ARCHITECTURE.md §6.4: "errors surfaced to the UI carry a status and a job
 * id, not a provider message") — this is the other half of that sentence,
 * which was never written.
 */
function logProviderError(receiptId: string, model: string, pass: number, error: unknown): void {
  const where = `receipt=${receiptId} model=${model} pass=${pass}`;
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { type?: string; message?: string } | undefined;
    console.error(
      `[ledgerly] ai call failed ${where} status=${error.status ?? "none"} ` +
        `type=${body?.type ?? error.name} message=${body?.message ?? error.message}`,
    );
    return;
  }
  console.error(`[ledgerly] ai call failed ${where}:`, error);
}

function classifyAnthropicError(error: unknown): ExtractError {
  // Most-specific-first: RateLimitError/InternalServerError both extend
  // APIError, and APIConnectionError extends APIError too -- checking the
  // base class first would swallow the distinction task 6.9's backoff
  // policy (429 and 529 specifically) needs.
  if (error instanceof Anthropic.RateLimitError) return new ExtractError("AI_RATE_LIMITED");
  if (error instanceof Anthropic.InternalServerError) {
    return new ExtractError(error.status === 529 ? "AI_OVERLOADED" : "AI_API_ERROR");
  }
  if (error instanceof Anthropic.APIConnectionError)
    return new ExtractError("AI_CONNECTION_FAILED");
  // A malformed request (e.g. a strict-mode schema rejection — the exact
  // shape D-12 is Provisional on), a bad/revoked API key, or a
  // permission/model-access problem: retrying the identical request
  // cannot succeed. Distinct from RateLimitError/InternalServerError/
  // APIConnectionError, which genuinely can.
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError
  ) {
    return new ExtractError("AI_REQUEST_REJECTED", { retryable: false });
  }
  if (error instanceof Anthropic.APIError) return new ExtractError("AI_API_ERROR");
  return new ExtractError("AI_CALL_FAILED");
}

async function recordUsage(
  db: Database,
  params: {
    receiptId: string;
    model: string;
    pass: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number | null;
    escalated: boolean;
    ok: boolean;
  },
): Promise<void> {
  await db.insert(aiUsage).values({
    receiptId: params.receiptId,
    model: params.model,
    pass: params.pass,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    latencyMs: params.latencyMs,
    escalated: params.escalated,
    ok: params.ok,
  });
}

async function runPass(params: {
  db: Database;
  client: AnthropicMessagesClient;
  model: string;
  imageBytes: Buffer;
  tool: Anthropic.Tool;
  receiptId: string;
  pass: number;
  escalated: boolean;
}): Promise<PassResult> {
  const { db, client, model, imageBytes, tool, receiptId, pass, escalated } = params;
  const request = buildExtractionRequest(model, imageBytes, tool);
  const startedAt = Date.now();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create(request);
  } catch (error) {
    // No `usage` exists at all for a call that never got a response --
    // nothing to record here (M-5 covers the two branches below, which DO
    // have billable usage despite failing).
    //
    // Log the PROVIDER's own account of the failure, server-side. Without
    // this the operator sees only a reason code: a 404 for an invalid model
    // id and a 401 for a revoked key both arrive as AI_REQUEST_REJECTED, and
    // the UI's advice ("check the API key") sends them after the wrong thing
    // entirely — which is exactly what happened with `claude-haiku-4-5`.
    //
    // Status, error type and message only. Never the request (it carries the
    // receipt image) and never the key: `Anthropic.APIError` does not include
    // headers in these fields, and nothing here touches `client`.
    logProviderError(receiptId, model, pass, error);
    throw classifyAnthropicError(error);
  }
  const latencyMs = Date.now() - startedAt;
  const usageRow = {
    receiptId,
    model,
    pass,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    latencyMs,
    escalated,
  };

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    // Review finding M-5: this call was billed (real `usage` counts came
    // back) even though it produced nothing usable -- record it as a
    // failed call rather than letting it vanish from admin.aiUsage's
    // spend/escalation-rate accounting.
    await recordUsage(db, { ...usageRow, ok: false });
    throw new ExtractError("AI_NO_TOOL_USE");
  }

  // Never string-match a tool call's serialized input -- escaping differs
  // across models. `toolUse.input` is already parsed JSON by the SDK, but
  // the scrub below re-serializes/walks it structurally regardless of
  // that, so this holds even if a future SDK version changes that detail.
  const { scrubbed } = scrubLuhnSequences(toolUse.input);

  if (!isRecordReceiptInputShape(scrubbed)) {
    await recordUsage(db, { ...usageRow, ok: false });
    throw new ExtractError("AI_INVALID_RESPONSE");
  }

  await recordUsage(db, { ...usageRow, ok: true });
  return { model, input: scrubbed, rawScrubbed: scrubbed };
}

function shouldEscalate(input: RecordReceiptInput, escalateBelow: number): boolean {
  return (
    input.total === null ||
    input.transaction_date === null ||
    input.items.length === 0 ||
    normalizeConfidence(input.confidence) < escalateBelow
  );
}

type MappedItem = {
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  categorySlug: string;
};

/** Maps and validates items, silently dropping any element that isn't
 * even shape-plausible (H-3: a null/non-object array element, or one
 * missing `description`/`category` as strings, would otherwise throw a
 * TypeError mid-map and crash the whole job). Each surviving item's own
 * fields still go through the same total, never-throw normalizers as the
 * receipt-level fields. */
function mapItems(rawItems: unknown[], categoryIdBySlug: Map<string, string>): MappedItem[] {
  const mapped: MappedItem[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Partial<RecordReceiptItemInput>;
    if (typeof item.description !== "string" || typeof item.category !== "string") continue;

    mapped.push({
      description: item.description,
      quantity: normalizeQuantity(typeof item.quantity === "string" ? item.quantity : null),
      unitPrice: normalizeMoney(typeof item.unit_price === "string" ? item.unit_price : null),
      lineTotal: normalizeMoney(typeof item.line_total === "string" ? item.line_total : null),
      categorySlug: categoryIdBySlug.has(item.category) ? item.category : "uncategorized",
    });
  }
  return mapped;
}

export async function processReceiptExtraction(
  deps: ProcessReceiptExtractionDeps,
  data: ExtractJobData,
): Promise<void> {
  const { db, anthropicClient, uploadsDir, maxMegapixels, modelPass1, modelPass2, escalateBelow } =
    deps;
  const { receiptId, forcePass2 = false } = data;

  const [receipt] = await db
    .select({
      id: receipts.id,
      projectId: receipts.projectId,
      deletedAt: receipts.deletedAt,
      extractionStatus: receipts.extractionStatus,
      originalKey: receipts.originalKey,
    })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .limit(1);

  if (!receipt) throw new ExtractError("RECEIPT_NOT_FOUND");
  if (receipt.deletedAt) return; // deleted while queued -- nothing to do

  // Idempotency: a completed extraction is a no-op unless this is an
  // explicit forced re-extract (receipts.reextract always forces Sonnet).
  if (
    !forcePass2 &&
    (receipt.extractionStatus === "ok" || receipt.extractionStatus === "partial")
  ) {
    return;
  }

  // The ONLY source of render-A bytes at extraction time -- render A is
  // never persisted or forwarded through the queue (ARCHITECTURE.md §5).
  // Both passes below reuse this one buffer.
  let imageBytes: Buffer;
  try {
    const regenerated = await regenerateExtractionRender({
      uploadsDir,
      projectId: receipt.projectId,
      receiptId: receipt.id,
      hasOriginal: receipt.originalKey !== null,
      originalExt: receipt.originalKey,
      maxMegapixels,
    });
    imageBytes = regenerated.buffer;
    if (regenerated.warning) {
      console.warn(`[ledgerly] receipt ${receiptId}: ${regenerated.warning}`);
    }
  } catch (error) {
    console.error(
      `[ledgerly] receipt ${receiptId}: failed to produce the extraction render:`,
      error,
    );
    throw new ExtractError("EXTRACTION_RENDER_FAILED");
  }

  const liveCategories = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(isNull(categories.deletedAt));
  const tool = buildRecordReceiptTool(liveCategories.map((c) => c.slug));
  const categoryIdBySlug = new Map(liveCategories.map((c) => [c.slug, c.id]));

  let finalPass: PassResult;
  let escalated = false;

  if (forcePass2) {
    finalPass = await runPass({
      db,
      client: anthropicClient,
      model: modelPass2,
      imageBytes,
      tool,
      receiptId,
      pass: 2,
      escalated: false, // a manual force, not an automatic ladder escalation
    });
  } else {
    const pass1 = await runPass({
      db,
      client: anthropicClient,
      model: modelPass1,
      imageBytes,
      tool,
      receiptId,
      pass: 1,
      escalated: false,
    });

    // Escalating to the SAME model is a second identical paid call for an
    // identical answer. With pass 1 on Sonnet (D-12 amended) that is the normal
    // configuration, not an exotic one, so the ladder has to know when it has
    // nowhere to climb — otherwise every low-confidence receipt quietly costs
    // double for nothing.
    if (modelPass2 !== modelPass1 && shouldEscalate(pass1.input, escalateBelow)) {
      escalated = true;
      finalPass = await runPass({
        db,
        client: anthropicClient,
        model: modelPass2,
        imageBytes,
        tool,
        receiptId,
        pass: 2,
        escalated: true,
      });
    } else {
      finalPass = pass1;
    }
  }

  const input = finalPass.input;

  // `?? null` on every passthrough field, for two distinct reasons:
  //
  //  - `undefined` reaching drizzle's `.set()` means "leave this column
  //    alone", so an omitted field would silently PRESERVE a stale value
  //    from a previous extraction rather than clearing it;
  //  - the `=== null` checks below that build `missing_fields` would miss it,
  //    so the user would never be told the field was not read.
  //
  // A field the model omitted and a field it returned as null are the same
  // fact. See normalize.ts's header for the failure this class of hole
  // actually caused.
  const merchantName = input.merchant_name ?? null;
  const merchantAddress = input.merchant_address ?? null;
  const merchantPhone = input.merchant_phone ?? null;
  let transactionDate = normalizeDate(input.transaction_date);
  const transactionTime = normalizeTime(input.transaction_time);
  const subtotal = normalizeMoney(input.subtotal);
  const salesTax = normalizeMoney(input.sales_tax);
  const tip = normalizeMoney(input.tip);
  const total = normalizeMoney(input.total);
  const cardLast4 = normalizeCardLast4(input.card_last4);
  const paymentMethod = input.payment_method ?? null;
  const confidence = normalizeConfidence(input.confidence);

  // `Array.isArray`, not a truthiness check: `items` is the one field the
  // schema has always required, but this file's contract is to survive any
  // shape the model returns, and `for (const raw of undefined)` throws.
  const items = mapItems(Array.isArray(input.items) ? input.items : [], categoryIdBySlug);

  const validationInput: ValidationInput = {
    subtotal,
    salesTax,
    tip,
    total,
    transactionDate,
    items: items.map((item) => ({ lineTotal: item.lineTotal })),
  };
  // Unacknowledged flags, used below to decide whether a `date_too_old` should
  // null the date and whether each field belongs in `missing_fields`. The
  // EFFECTIVE flags — these minus the user's acknowledgements — are derived
  // inside the transaction, where the stored acknowledgements can be read.
  const { validationFlags } = runSanityChecks(validationInput);

  const missingFields: string[] = [];
  if (merchantName === null) missingFields.push("merchant_name");
  if (merchantAddress === null) missingFields.push("merchant_address");
  if (merchantPhone === null) missingFields.push("merchant_phone");
  // H-2: `receipts_date_sane` CHECKs `transaction_date >= 2000-01-01` --
  // storing a date the sanity check itself just flagged as too old would
  // abort this entire transaction (and, via BullMQ's retry, redo both
  // paid API calls twice more before permanently failing the receipt with
  // NO extracted data at all), directly against ARCHITECTURE.md §6.3's
  // "sanity checks never fail the receipt." `date_in_future` has no such
  // constraint, so that value is kept — more useful to the reviewing user
  // than discarding it.
  if (validationFlags.includes("date_too_old")) transactionDate = null;
  if (transactionDate === null) missingFields.push("transaction_date");
  if (transactionTime === null) missingFields.push("transaction_time");
  if (subtotal === null) missingFields.push("subtotal");
  if (salesTax === null) missingFields.push("sales_tax");
  if (total === null) missingFields.push("total");
  if (cardLast4 === null) missingFields.push("card_last4");
  if (paymentMethod === null) missingFields.push("payment_method");
  if (items.length === 0) missingFields.push("items");

  await db.transaction(async (tx) => {
    // Phase 7: honour the fields the user deliberately marked blank.
    //
    // missingFields above is recomputed from scratch on every run, so without
    // this subtraction a dismissal is silently undone by the next automatic
    // retry — the user clears a badge and it comes back. Read inside the
    // transaction so it reflects any dismissal committed while this (paid,
    // slow) extraction was in flight.
    //
    // A MANUAL re-extract clears the set instead of subtracting it: pressing
    // "re-extract" is an explicit request for a fresh reading of the receipt,
    // which makes the user's earlier "this field is genuinely blank"
    // assertions stale rather than authoritative.
    const [existing] = await tx
      .select({
        dismissedFields: receipts.dismissedFields,
        acknowledgedFlags: receipts.acknowledgedFlags,
      })
      .from(receipts)
      .where(eq(receipts.id, receiptId))
      .limit(1)
      // FOR UPDATE: a plain select under READ COMMITTED takes its own
      // snapshot, so a `dismissMissingField` committing between this read and
      // the update below would be silently overwritten by the value read
      // before it. Extraction holds no other lock on this row.
      .for("update");
    const dismissed = forcePass2 ? [] : (existing?.dismissedFields ?? []);
    const effectiveMissingFields = missingFields.filter((field) => !dismissed.includes(field));

    // Acknowledged validation flags get exactly the treatment dismissed fields
    // get, and for the same reason: an automatic re-run must not resurrect a
    // warning the user has already dealt with, while a MANUAL re-extract is a
    // request for a fresh opinion and clears the slate.
    //
    // Re-run rather than filtered here, so the rule that turns
    // acknowledgements into flags-and-status lives in exactly one place
    // (`runSanityChecks`). The input is unchanged, so the unacknowledged flags
    // it returns are identical to the ones computed above — only the
    // subtraction and the resulting status differ.
    const acknowledged = forcePass2 ? [] : (existing?.acknowledgedFlags ?? []);
    const effective = runSanityChecks({ ...validationInput, acknowledgedFlags: acknowledged });

    const updated = await tx
      .update(receipts)
      .set({
        dismissedFields: dismissed,
        acknowledgedFlags: acknowledged,
        merchantName,
        merchantAddress,
        merchantPhone,
        transactionDate,
        transactionTime,
        subtotal,
        salesTax,
        tip,
        total,
        cardLast4,
        paymentMethod,
        extractionStatus: effective.status,
        extractionModel: finalPass.model,
        extractionPass: forcePass2 || escalated ? 2 : 1,
        extractionConfidence: String(confidence),
        extractionRaw: finalPass.rawScrubbed,
        extractionError: null,
        missingFields: effectiveMissingFields,
        validationFlags: effective.validationFlags,
        updatedAt: new Date(),
      })
      .where(and(eq(receipts.id, receiptId), isNull(receipts.deletedAt)))
      .returning({ id: receipts.id });

    // L-3: soft-deleted between this job's start and here -- the update
    // above was a no-op (its own WHERE excludes it); the items write must
    // be skipped too, or a deleted receipt gets fresh line items attached
    // to a row nothing else in this transaction touched.
    if (updated.length === 0) return;

    // Idempotent under retry and manual re-extract: replace, not append.
    await tx.delete(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    if (items.length > 0) {
      await tx.insert(receiptItems).values(
        items.map((item, index) => ({
          receiptId,
          lineNo: index + 1,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          categoryId: categoryIdBySlug.get(item.categorySlug) ?? null,
          aiAssignedCategory: true,
        })),
      );
    }
  });
}
