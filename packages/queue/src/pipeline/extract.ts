import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { aiUsage, categories, receiptItems, receipts } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import { recordEvent } from "@ledgerly/api/events";

import { arithmeticHint, buildExtractionRequest } from "./anthropicRequest";
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
import { itemsReconcile } from "@ledgerly/shared/receiptValidation";
import { formatMoney, parseMoney } from "@ledgerly/shared/money";
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
  /**
   * Re-read with the escalation model when the first reading does not
   * reconcile (D-47). Defaults off so existing callers and tests are
   * unaffected; `worker.ts` passes the admin's setting.
   */
  rescanOnReview?: boolean;
  /**
   * Record the ordinary steps as well as the failures (D-48). Resolved once
   * per job by the worker and threaded down rather than read here, so a
   * verbose run costs the same one settings read as a quiet one.
   */
  verboseLogging?: boolean;
  /**
   * Injectable clock, matching `pipeline/backup.ts`'s `deps.now`. The date
   * confirmation compares the receipt's date against today, so without this a
   * test would either have to move its fixtures forward every week or assert
   * on behaviour that changes with the calendar.
   */
  now?: () => Date;
  /**
   * The system prompt, resolved from `app_config` by the caller (D-47).
   * Optional so every existing test keeps working against the shipped default;
   * `worker.ts` always passes the resolved value.
   */
  systemPrompt?: string;
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
  hint?: string;
  systemPrompt?: string;
}): Promise<PassResult> {
  const { db, client, model, imageBytes, tool, receiptId, pass, escalated, hint, systemPrompt } =
    params;
  const request = buildExtractionRequest(model, imageBytes, tool, hint, systemPrompt);
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

/**
 * The line totals from a model response, defensively.
 *
 * `items` is model output, so an entry can be null or missing `line_total`
 * entirely — this file's whole posture is to not trust its shape (the
 * `undefined`-vs-null lesson from the first real extraction run). An earlier
 * version of the reconciliation check mapped straight over the array and
 * crashed on a null item, which the "drops a malformed item" test caught.
 */
function pricedItems(input: RecordReceiptInput): { lineTotal: string | null }[] {
  return (Array.isArray(input.items) ? input.items : [])
    .filter((item): item is NonNullable<(typeof input.items)[number]> => item != null)
    .map((item) => ({ lineTotal: item.line_total ?? null }));
}

/**
 * Re-reads the receipt once, quoting the model its own failed arithmetic.
 *
 * Returns the retry's result only if it reconciles; otherwise the original
 * stands. Two readings that both fail to add up are not better than one, and
 * silently preferring the newer one would make the outcome depend on which
 * wrong answer arrived last.
 *
 * Never throws. A receipt that extracted successfully must not be lost to a
 * failure in an optional second opinion — the first reading is already good
 * enough to persist, and `arithmetic_mismatch_items` will flag it for review
 * exactly as it did before this existed.
 */
async function retryIfItemsDoNotReconcile(params: {
  db: Database;
  client: AnthropicMessagesClient;
  previous: PassResult;
  model: string;
  imageBytes: Buffer;
  tool: Anthropic.Tool;
  receiptId: string;
  escalated: boolean;
  systemPrompt?: string;
  verboseLogging?: boolean;
}): Promise<PassResult> {
  const { db, client, previous, model, imageBytes, tool, receiptId, escalated, systemPrompt } =
    params;

  const check = itemsReconcile({
    subtotal: previous.input.subtotal ?? null,
    items: pricedItems(previous.input),
  });
  if (!check || check.reconciles) return previous;

  console.warn(
    `[ledgerly] items do not reconcile receipt=${receiptId} ` +
      `items=${formatMoney(check.itemsCents)} subtotal=${formatMoney(check.subtotalCents)} ` +
      "— re-reading once with the discrepancy quoted back",
  );

  try {
    const retry = await runPass({
      db,
      client,
      model,
      imageBytes,
      tool,
      receiptId,
      pass: 2,
      escalated,
      systemPrompt,
      hint: arithmeticHint({
        itemsSum: formatMoney(check.itemsCents),
        subtotal: formatMoney(check.subtotalCents),
        difference: formatMoney(Math.abs(check.subtotalCents - check.itemsCents)),
      }),
    });

    const after = itemsReconcile({
      subtotal: retry.input.subtotal ?? null,
      items: pricedItems(retry.input),
    });
    await logStep(db, params.verboseLogging ?? false, {
      event: "extraction.corrective_reread",
      entityId: receiptId,
      metadata: {
        model,
        itemsSum: formatMoney(check.itemsCents),
        subtotal: formatMoney(check.subtotalCents),
        reconciled: after?.reconciles === true,
      },
    });

    if (after?.reconciles) {
      console.log(`[ledgerly] corrected reading reconciles receipt=${receiptId}`);
      return retry;
    }
    // Kept as a log rather than a flag: `runSanityChecks` is about to raise
    // `arithmetic_mismatch_items` on the persisted reading anyway, and the user
    // can acknowledge it if the receipt genuinely does not add up.
    console.warn(`[ledgerly] re-read still does not reconcile receipt=${receiptId}`);
    return previous;
  } catch (error) {
    console.error(`[ledgerly] corrective re-read failed receipt=${receiptId}:`, error);
    return previous;
  }
}

/**
 * An `app_events` row that only exists when verbose logging is on (D-48).
 *
 * One helper rather than an `if` at each site, for the reason `recordEvent`
 * itself is one function: the property that matters — that logging can never
 * affect the job — has to hold at every call, and the way to guarantee that is
 * to give callers one thing to call. `recordEvent` already swallows its own
 * failures, so this adds only the switch.
 */
async function logStep(
  db: Database,
  verbose: boolean,
  entry: { event: string; entityId: string; metadata: Record<string, unknown> },
): Promise<void> {
  if (!verbose) return;
  await recordEvent(db, {
    level: "info",
    category: "extraction",
    event: entry.event,
    entityType: "receipt",
    entityId: entry.entityId,
    metadata: entry.metadata,
  });
}

/** At most zero — see the call site. `null` passes through as "no credit". */
export function clampToCredit(value: string | null): string | null {
  if (value === null) return null;
  const cents = parseMoney(value);
  return cents > 0 ? formatMoney(-cents) : value;
}

function shouldEscalate(input: RecordReceiptInput, escalateBelow: number): boolean {
  return (
    input.total === null ||
    input.transaction_date === null ||
    input.items.length === 0 ||
    normalizeConfidence(input.confidence) < escalateBelow
  );
}

/**
 * How far back a date has to be before it is worth a second read (D-47).
 *
 * A week. Receipts are usually uploaded within a few days, so a date older
 * than that is either a genuinely delayed upload — common, and fine — or a
 * misread year or month, which is the failure this catches. Cheap to check,
 * and it costs an extra call only on the receipts where it might matter.
 */
const DATE_CONFIRM_DAYS = 7;

export function dateIsStale(iso: string | null, now: Date = new Date()): boolean {
  if (iso === null) return false;
  const cutoff = new Date(now.getTime() - DATE_CONFIRM_DAYS * 24 * 60 * 60 * 1000);
  return iso < cutoff.toISOString().slice(0, 10);
}

/**
 * Why a second read is worth paying for, or `null` when it is not (D-47).
 *
 * ONE mechanism for three triggers, rather than three re-reads bolted on in
 * sequence. Each one on its own would be another billable call per receipt;
 * together they are still at most one, because a single independent second
 * reading answers all three questions at once.
 *
 * The distinction that matters is which triggers need a DIFFERENT model:
 *
 *  - `confidence` and `review` do. The model said it could not read this well,
 *    or read it into something that cannot be true. Asking the same model
 *    again buys a second identical answer for a second identical price — which
 *    is exactly the waste `modelPass2 !== modelPass1` already guards.
 *  - `date` does not. The question there is not "can a better model read it"
 *    but "do two independent reads agree", and two samples from the same model
 *    are independent enough to answer that. So this one fires even on an
 *    instance that has never configured an escalation model.
 */
export type SecondOpinionReason = "confidence" | "date" | "review";

export function secondOpinionReason(params: {
  input: RecordReceiptInput;
  escalateBelow: number;
  rescanOnReview: boolean;
  hasDistinctModel: boolean;
  now?: Date;
}): SecondOpinionReason | null {
  if (params.hasDistinctModel && shouldEscalate(params.input, params.escalateBelow)) {
    return "confidence";
  }
  if (dateIsStale(normalizeDate(params.input.transaction_date), params.now)) return "date";
  // "Needs review" here is the pre-persist approximation of `NEEDS_REVIEW_SQL`:
  // the numbers do not reconcile. It deliberately does not include missing
  // fields — a receipt with no printed phone number is not a receipt that was
  // read badly, and re-reading it would cost a call to learn the same thing.
  if (params.hasDistinctModel && params.rescanOnReview) {
    const check = itemsReconcile({
      subtotal: normalizeMoney(params.input.subtotal),
      items: pricedItems(params.input),
    });
    if (check && !check.reconciles) return "review";
  }
  return null;
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
  const {
    db,
    anthropicClient,
    uploadsDir,
    maxMegapixels,
    modelPass1,
    modelPass2,
    escalateBelow,
    rescanOnReview = false,
    verboseLogging = false,
    systemPrompt,
    now,
  } = deps;
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
  /** Set when two independent reads disagreed about the date. Stored on the
   *  row, because it is a fact about the reading that cannot be re-derived
   *  from the saved values later. */
  let dateUnconfirmed = false;

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
      systemPrompt,
    });
  } else {
    await logStep(db, verboseLogging, {
      event: "extraction.started",
      entityId: receiptId,
      metadata: { model: modelPass1, pass: 1 },
    });
    const pass1 = await runPass({
      db,
      client: anthropicClient,
      model: modelPass1,
      imageBytes,
      tool,
      receiptId,
      pass: 1,
      escalated: false,
      systemPrompt,
    });
    await logStep(db, verboseLogging, {
      event: "extraction.pass_complete",
      entityId: receiptId,
      metadata: {
        model: modelPass1,
        pass: 1,
        confidence: normalizeConfidence(pass1.input.confidence),
        items: Array.isArray(pass1.input.items) ? pass1.input.items.length : 0,
      },
    });

    // ONE second opinion, three reasons to want it (D-47). See
    // `secondOpinionReason` for why the date trigger is the only one that does
    // not require a distinct model: it asks whether two independent reads
    // agree, not whether a better model can do more.
    //
    // Escalating to the SAME model for the other two is a second identical
    // paid call for an identical answer. With pass 1 on Sonnet (D-12 amended)
    // that is the normal configuration, not an exotic one, so the ladder has
    // to know when it has nowhere to climb — otherwise every low-confidence
    // receipt quietly costs double for nothing.
    const hasDistinctModel = modelPass2 !== modelPass1;
    const reason = secondOpinionReason({
      input: pass1.input,
      escalateBelow,
      rescanOnReview,
      hasDistinctModel,
      now: now?.(),
    });

    finalPass = pass1;

    if (!reason) {
      await logStep(db, verboseLogging, {
        event: "extraction.no_second_opinion",
        entityId: receiptId,
        // Recorded because "why did it NOT escalate" is the other half of the
        // question, and with both models equal the answer is usually
        // `ladderDisabled` rather than anything about this receipt.
        metadata: { ladderDisabled: !hasDistinctModel, rescanOnReview },
      });
    }

    if (reason) {
      const model = hasDistinctModel ? modelPass2 : modelPass1;
      // When the trigger is "this does not add up", hand the model the actual
      // discrepancy rather than asking it to read again blind. Without this a
      // non-reconciling receipt costs three calls: pass 1, an uninformed
      // second opinion, and then `retryIfItemsDoNotReconcile` with the hint.
      // With it, the second opinion IS the informed read and the retry below
      // short-circuits when it worked.
      const reconcile =
        reason === "review"
          ? itemsReconcile({
              subtotal: normalizeMoney(pass1.input.subtotal),
              items: pricedItems(pass1.input),
            })
          : null;

      let secondPass: PassResult | null = null;
      try {
        secondPass = await runPass({
          db,
          client: anthropicClient,
          model,
          imageBytes,
          tool,
          receiptId,
          pass: 2,
          // `escalated` is the ai_usage accounting flag and means "cost more
          // than pass 1 would have", so it tracks the MODEL changing, not the
          // fact of a second call. A same-model date confirmation is a second
          // call at pass-1 prices.
          escalated: hasDistinctModel,
          systemPrompt,
          ...(reconcile
            ? {
                hint: arithmeticHint({
                  itemsSum: formatMoney(reconcile.itemsCents),
                  subtotal: formatMoney(reconcile.subtotalCents),
                  difference: formatMoney(Math.abs(reconcile.subtotalCents - reconcile.itemsCents)),
                }),
              }
            : {}),
        });
      } catch (error) {
        // A RECEIPT THAT EXTRACTED SUCCESSFULLY MUST NOT BE LOST TO A FAILURE
        // IN AN OPTIONAL SECOND OPINION — the rule `retryIfItemsDoNotReconcile`
        // states thirty lines above, and this call has to follow it too. It
        // matters more here than there: the date trigger fires on ANY receipt
        // older than a week, so uploading a shoebox of old receipts would
        // otherwise put every one of them through a call that can fail the job,
        // re-run a pass that has already been paid for, and end at
        // `extraction_status='failed'` with no data at all.
        console.error(`[ledgerly] second opinion failed receipt=${receiptId}:`, error);
      }

      if (secondPass) {
        escalated = hasDistinctModel;
        console.log(
          `[ledgerly] second opinion receipt=${receiptId} reason=${reason} model=${model}`,
        );
        await logStep(db, verboseLogging, {
          event: "extraction.second_opinion",
          entityId: receiptId,
          // `reason` is the whole point of this row: "why did it read the
          // receipt twice" is the question the verbose log exists to answer,
          // and the console line that used to carry it is not something an
          // operator can reach.
          metadata: {
            reason,
            model,
            escalated: hasDistinctModel,
            confidence: normalizeConfidence(secondPass.input.confidence),
          },
        });

        // The date check falls out of having two readings, whatever the reason
        // for the second one. Two independent reads landing on the same date is
        // the evidence that makes a genuinely old receipt quiet; a disagreement
        // is the flag.
        const firstDate = normalizeDate(pass1.input.transaction_date);
        const secondDate = normalizeDate(secondPass.input.transaction_date);
        dateUnconfirmed = firstDate !== null && firstDate !== secondDate;

        // A same-model read taken ONLY to check the date answers one question,
        // and must not silently replace a better reading of everything else:
        // it is a second sample from the same model, so its merchant, items and
        // confidence are no more authoritative than pass 1's. Taking it
        // wholesale would make the outcome depend on which sample arrived last
        // — the inverse of the rule `retryIfItemsDoNotReconcile` follows.
        const dateCheckOnly = reason === "date" && !hasDistinctModel;
        if (!dateCheckOnly) {
          finalPass =
            secondDate === null && firstDate !== null
              ? // A second read that lost the date must not take the first
                // read's answer with it — that turns "unconfirmed" into
                // "missing", which is strictly less information. Copied into a
                // new object rather than mutated: `runPass` returns the SAME
                // reference as `rawScrubbed`, so mutating it would write a date
                // the model never returned into `extraction_raw` — the audit
                // trail you reach for when diagnosing exactly this flag.
                { ...secondPass, input: { ...secondPass.input, transaction_date: firstDate } }
              : secondPass;
        }
      }
    }

    // One corrective retry when the reading does not add up.
    //
    // Distinct from escalation, and deliberately not gated on the model
    // differing: escalation answers "the model could not read something", and
    // re-running the same model blind would produce the same answer. This
    // answers "the model read something that cannot be true" and hands it the
    // discrepancy, which is new information. That is why it is worth a call
    // even when both passes are the same model.
    //
    // It exists because a prompt can only describe the receipt layouts someone
    // thought of. The arithmetic check catches the ones nobody did — the
    // Lowe's "379.00 DISCOUNT EACH -18.95" sub-line, whose net price is already
    // on the item line above it, was read as a separate negative item and
    // subtracted the discount twice. The gap was exactly the receipt's own
    // printed TOTAL SAVINGS.
    //
    // Bounded: at most one retry, only when the numbers disagree, and the
    // retry's answer is kept only if it actually reconciles — a second wrong
    // reading must not replace a first wrong reading with more confidence.
    finalPass = await retryIfItemsDoNotReconcile({
      db,
      client: anthropicClient,
      previous: finalPass,
      model: escalated ? modelPass2 : modelPass1,
      imageBytes,
      tool,
      receiptId,
      escalated,
      systemPrompt,
      verboseLogging,
    });

    // The corrective re-read can replace the whole reading, including the date
    // carried forward above. A `date_unconfirmed` flag on a receipt whose date
    // is now null would say two readings disagreed about a date that is not
    // there — noise on top of the `transaction_date` missing-field token that
    // already covers it.
    if (normalizeDate(finalPass.input.transaction_date) === null) dateUnconfirmed = false;
  }

  await logStep(db, verboseLogging, {
    event: "extraction.finished",
    entityId: receiptId,
    metadata: {
      model: finalPass.model,
      pass: forcePass2 || escalated ? 2 : 1,
      escalated,
      dateUnconfirmed,
    },
  });

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
  const tip = normalizeMoney(input.tip);
  const total = normalizeMoney(input.total);
  // Clamped to at most zero. The prompt asks for a negative and the column,
  // the sanity check and the project rollup all assume one, but nothing in
  // `normalizeMoney` enforces a sign — it canonicalises notation, not meaning.
  // A credit returned as "5.00" would make the receipt-level check overshoot by
  // twice the credit (caught, as an arithmetic flag) AND make the project
  // rollup understate unitemised spend by the same amount (not caught at all,
  // because no per-project check exists). A positive "discount" is not a
  // meaningful value here, so it is corrected rather than stored and flagged.
  const transactionDiscount = clampToCredit(normalizeMoney(input.transaction_discount));
  // D-47. A receipt whose printed prices already include tax — fuel, most
  // often — has a sales tax of zero by construction, whatever the model
  // returned in the field. Forcing it here rather than trusting the model to
  // send "0.00" means a memo line reading "INCLUDES $2.14 TAX" cannot end up
  // added on top of a price that already contains it.
  const taxIncluded = input.tax_included_in_prices === true;
  const salesTax = taxIncluded ? "0.00" : normalizeMoney(input.sales_tax);
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
    transactionDiscount,
    dateUnconfirmed,
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
  // A tax-inclusive receipt has no separate tax to read, so a blank one is the
  // right answer rather than a gap someone should go and fill in (D-47).
  if (salesTax === null && !taxIncluded) missingFields.push("sales_tax");
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
        transactionDiscount,
        taxIncluded,
        dateUnconfirmed,
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
