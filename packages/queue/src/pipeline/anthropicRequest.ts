import type Anthropic from "@anthropic-ai/sdk";

/**
 * packages/queue/src/pipeline/anthropicRequest.ts — per-model request shapes
 * (task 6.4, ARCHITECTURE.md §6.1, D-12).
 *
 * "The two passes are not the same request." Haiku 4.5 rejects
 * `output_config.effort` and takes the older `thinking: {type:"enabled",
 * budget_tokens:N}` form; Sonnet 5 uses `thinking: {type:"adaptive"}` and
 * supports `effort`. Building each request from this table — rather than
 * sending one shape to both — is what D-12 and the `claude-api` skill's
 * per-model thinking-config table both call out as required, not optional.
 *
 * The table now carries a THIRD difference, learned the hard way: this
 * pipeline forces `tool_choice`, and the API rejects a forced tool choice
 * combined with the `budget_tokens` thinking form. So Haiku sends no
 * `thinking` field at all. See `capabilityForModel`.
 */

export type ModelCapability = {
  /** `undefined` means "send no `thinking` field at all" — see the Haiku
   *  branch below for why that is not the same as disabling it. */
  thinking: Anthropic.ThinkingConfigParam | undefined;
  effort: Anthropic.OutputConfig["effort"];
};

/** `AI_MODEL_PASS1`/`AI_MODEL_PASS2` are free-text env vars (re-pointable
 * without a code change, D-12), so this table matches by substring rather
 * than exact model id — "claude-haiku-..." picks the Haiku shape no matter
 * which dated or undated Haiku id is configured; anything else defaults to
 * the Sonnet/adaptive shape, since every other current model in this
 * codebase's lineup (Sonnet 5, and Opus if ever re-pointed there per D-12's
 * "not by default" note) takes the same adaptive + effort request. */
function capabilityForModel(model: string): ModelCapability {
  if (model.includes("haiku")) {
    // NO `thinking` FIELD ON HAIKU. This is not a preference, it is an API
    // constraint, and it is what broke every pass-1 call in the first real
    // run:
    //
    //   400 invalid_request_error
    //   "Thinking may not be enabled when tool_choice forces tool use."
    //
    // Haiku 4.5 takes the older `thinking: {type:"enabled", budget_tokens:N}`
    // form, and THAT form is incompatible with `tool_choice: {type:"tool"}`.
    // Sonnet 5's `{type:"adaptive"}` is not — which is exactly why pass 2
    // worked in production while pass 1 never did, and why the failure looked
    // like a key or model problem rather than a request-shape one.
    //
    // Forced tool use is the property worth keeping: this pipeline needs a
    // `record_receipt` call, not prose. Reading a receipt is perception, not
    // reasoning, so a thinking budget was buying little here anyway.
    // Verified against the live API: Haiku with no `thinking` and a forced
    // tool_choice returns a correct extraction.
    return { thinking: undefined, effort: undefined };
  }
  return {
    thinking: { type: "adaptive" },
    effort: "high",
  };
}

const SYSTEM_PROMPT = `You extract structured data from a single photographed or scanned receipt image.

Work out how THIS receipt is laid out before you read values off it. Receipts differ in structure, not just in wording, and the same number can mean different things in different layouts.

Rules, all non-negotiable:
- Return null rather than guessing. A null field the user fills in by hand is fine; a confidently wrong value is not.
- Never invent a line item that is not printed on the receipt.
- card_last4 is exactly the last 4 digits of a payment card, or null. Never return a full card number under any field.
- Assign every item a category from the given enum. Use "uncategorized" when genuinely unclear rather than forcing a bad fit.
- Report your honest confidence in the 0.0-1.0 field — a low number for a blurry or partial receipt is more useful than a falsely confident one.

DISCOUNTS. Getting these wrong is the single most common extraction error, because two different layouts look similar and mean opposite things. Decide which one you are looking at:

(a) The discount MODIFIES THE LINE ABOVE IT and is already reflected in that line's price. Typical shape — the item's own price on the right is the NET price, and an indented sub-line under it explains how that price was reached:

    295429 GRACO MAGNUM X5        360.05
       379.00 DISCOUNT EACH      -18.95

  Here 379.00 is the list price, 18.95 the discount, and 360.05 the price actually charged (379.00 - 18.95 = 360.05). Emit ONE line item with line_total 360.05. Do NOT also emit a -18.95 item: the discount is already inside 360.05, and adding it again subtracts it twice. Use unit_price for the pre-discount price when it is printed.

(b) The discount is ITS OWN LINE, applied to the order rather than to one item — a whole-order coupon, a store credit, a loyalty award, usually near the totals. Emit it as a line item with a NEGATIVE line_total.

THE TEST THAT SETTLES IT: the line_total values you return must add up to the subtotal. Sum them before you answer. If your sum is BELOW the printed subtotal by exactly the discounts you emitted, you are in case (a) and have subtracted them twice — drop those discount items and keep the net prices. Many receipts also print a "TOTAL SAVINGS" figure; that is a summary of discounts already taken, never a line item.

Signs are written with a leading minus ("-4.50") whatever notation the receipt uses — some print the sign after the number ("4.50-"), some use parentheses ("(4.50)").

Before calling the tool, check your own arithmetic: line items should sum to subtotal, and subtotal + tax + tip should equal total. If they do not, re-read the receipt rather than adjusting a number to make them fit.

Call record_receipt exactly once with your best extraction.`;

/**
 * Appended to the user turn on a corrective retry.
 *
 * Quoting the model its own failed arithmetic works better than asking it to
 * try harder, because it names WHICH constraint broke and by how much — and on
 * the discount layouts above, the size of the gap is usually the discount total
 * itself, which points straight at the mistake.
 */
export function arithmeticHint(params: {
  itemsSum: string;
  subtotal: string;
  difference: string;
}): string {
  return `Your previous reading of this receipt does not reconcile: the line items you returned sum to ${params.itemsSum}, but you reported a subtotal of ${params.subtotal} — a difference of ${params.difference}.

Re-read the receipt and work out why. The most common cause is a discount counted twice: a sub-line such as "379.00 DISCOUNT EACH -18.95" explains the net price printed on the item line above it, so emitting it as its own negative line item subtracts it a second time. If that is what happened, keep the net item prices and drop the separate discount lines.

If instead the receipt genuinely does not add up, return what is printed and lower your confidence — do not invent or adjust a value to force it to balance.`;
}

const MAX_TOKENS = 4096;

export function buildExtractionRequest(
  model: string,
  imageBytes: Buffer,
  tool: Anthropic.Tool,
  /** Corrective feedback for a retry. See `arithmeticHint`. */
  hint?: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const capability = capabilityForModel(model);

  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    ...(capability.thinking ? { thinking: capability.thinking } : {}),
    ...(capability.effort ? { output_config: { effort: capability.effort } } : {}),
    tools: [tool],
    tool_choice: { type: "tool", name: "record_receipt" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageBytes.toString("base64"),
            },
          },
          { type: "text", text: "Extract this receipt." },
          ...(hint ? [{ type: "text" as const, text: hint }] : []),
        ],
      },
    ],
  };
}
