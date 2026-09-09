import { describe, expect, it } from "vitest";

import { buildExtractionRequest } from "./anthropicRequest";
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
