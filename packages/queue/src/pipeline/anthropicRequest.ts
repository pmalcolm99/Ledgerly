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

Rules, all non-negotiable:
- Return null rather than guessing. A null field the user fills in by hand is fine; a confidently wrong value is not.
- Never invent a line item that is not printed on the receipt.
- card_last4 is exactly the last 4 digits of a payment card, or null. Never return a full card number under any field.
- Assign every item a category from the given enum. Use "uncategorized" when genuinely unclear rather than forcing a bad fit.
- Report your honest confidence in the 0.0-1.0 field — a low number for a blurry or partial receipt is more useful than a falsely confident one.

Call record_receipt exactly once with your best extraction.`;

const MAX_TOKENS = 4096;

export function buildExtractionRequest(
  model: string,
  imageBytes: Buffer,
  tool: Anthropic.Tool,
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
        ],
      },
    ],
  };
}
