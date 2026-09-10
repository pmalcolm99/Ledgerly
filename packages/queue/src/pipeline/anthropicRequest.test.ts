import { describe, expect, it } from "vitest";

import { arithmeticHint, buildExtractionRequest } from "./anthropicRequest";
import { buildRecordReceiptTool } from "./schema";

const tool = buildRecordReceiptTool(["uncategorized"]);
const imageBytes = Buffer.from("fake-jpeg-bytes");

describe("buildExtractionRequest", () => {
  /**
   * The regression test for the failure that broke every pass-1 call on the
   * first real run: the API rejects a forced `tool_choice` combined with the
   * `budget_tokens` thinking form —
   *
   *   400 "Thinking may not be enabled when tool_choice forces tool use."
   *
   * This pipeline always forces the tool, so the Haiku request must carry NO
   * `thinking` field. Asserted as absence-of-key, not `toBeUndefined()`, so
   * that sending `thinking: undefined` explicitly (which the SDK would
   * serialise) still fails the test.
   */
  it("builds the Haiku shape with NO thinking field, because tool_choice is forced", () => {
    const request = buildExtractionRequest("claude-haiku-4-5", imageBytes, tool);
    expect("thinking" in request).toBe(false);
    expect(request.tool_choice).toEqual({ type: "tool", name: "record_receipt" });
    expect(request.output_config).toBeUndefined();
  });

  it("builds the Sonnet shape: adaptive thinking + effort", () => {
    const request = buildExtractionRequest("claude-sonnet-5", imageBytes, tool);
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config).toEqual({ effort: "high" });
  });

  it("forces the record_receipt tool via tool_choice", () => {
    const request = buildExtractionRequest("claude-sonnet-5", imageBytes, tool);
    expect(request.tool_choice).toEqual({ type: "tool", name: "record_receipt" });
    expect(request.tools).toEqual([tool]);
  });

  it("base64-encodes the image as a JPEG content block", () => {
    const request = buildExtractionRequest("claude-sonnet-5", imageBytes, tool);
    const content = request.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const imageBlock = (
      content as Array<{ type: string; source?: { media_type: string; data: string } }>
    ).find((b) => b.type === "image");
    expect(imageBlock?.source?.media_type).toBe("image/jpeg");
    expect(imageBlock?.source?.data).toBe(imageBytes.toString("base64"));
  });
});

/**
 * The discount rules, pinned.
 *
 * Not style preferences: the prompt previously said discounts must ALWAYS be
 * emitted as line items, which is right for a whole-order coupon and wrong for
 * the layout where an indented sub-line explains the net price on the item line
 * above it. That instruction made the model subtract the discount twice on a
 * real Lowe's receipt. These assertions exist so the distinction cannot be
 * flattened back into one rule by someone tidying the prompt.
 */
describe("the extraction prompt's discount rules", () => {
  const prompt = buildExtractionRequest("claude-sonnet-5", imageBytes, tool).system as string;

  it("tells the model to work out the receipt's structure first", () => {
    expect(prompt).toMatch(/how THIS receipt is laid out/i);
  });

  it("distinguishes a discount already applied from a standalone discount line", () => {
    // The case that was wrong: net price on the item line, sub-line explains it.
    expect(prompt).toMatch(/MODIFIES THE LINE ABOVE/i);
    expect(prompt).toMatch(/Do NOT also emit/i);
    // The case that was right, and must stay right.
    expect(prompt).toMatch(/ITS OWN LINE/i);
    expect(prompt).toMatch(/NEGATIVE line_total/i);
  });

  it("gives the model the arithmetic test that settles which layout it is", () => {
    expect(prompt).toMatch(/must add up to the subtotal/i);
    expect(prompt).toMatch(/subtracted them twice/i);
  });

  it("warns that a TOTAL SAVINGS figure is not a line item", () => {
    expect(prompt).toMatch(/TOTAL SAVINGS/i);
  });

  it("still carries the sign-notation rule for every format receipts print", () => {
    expect(prompt).toContain("4.50-");
    expect(prompt).toContain("(4.50)");
  });

  it("still forbids inventing a line item and returning a full card number", () => {
    expect(prompt).toMatch(/Never invent a line item/i);
    expect(prompt).toMatch(/Never return a full card number/i);
  });
});

describe("arithmeticHint", () => {
  it("quotes the model its own numbers and the size of the gap", () => {
    const hint = arithmeticHint({ itemsSum: "394.16", subtotal: "416.06", difference: "21.90" });
    expect(hint).toContain("394.16");
    expect(hint).toContain("416.06");
    expect(hint).toContain("21.90");
    // Names the likely cause rather than just asking it to try again.
    expect(hint).toMatch(/DISCOUNT EACH/i);
    // And does not invite it to fudge the numbers into agreement.
    expect(hint).toMatch(/do not invent or adjust/i);
  });
});

describe("the corrective retry's hint reaches the request", () => {
  it("is appended to the user turn, after the image and the instruction", () => {
    const withHint = buildExtractionRequest("claude-sonnet-5", imageBytes, tool, "RE-READ THIS");
    const content = withHint.messages[0]?.content as { type: string; text?: string }[];
    expect(content.at(-1)).toEqual({ type: "text", text: "RE-READ THIS" });
    // The image is still first — the hint is additional context, not a
    // replacement for the receipt.
    expect(content[0]?.type).toBe("image");
  });

  it("is absent when no hint is given, so a first pass is unchanged", () => {
    const plain = buildExtractionRequest("claude-sonnet-5", imageBytes, tool);
    const content = plain.messages[0]?.content as { type: string }[];
    expect(content).toHaveLength(2);
  });
});
