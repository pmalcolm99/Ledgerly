import { describe, expect, it } from "vitest";

import { buildExtractionRequest } from "./anthropicRequest";
import { buildRecordReceiptTool } from "./schema";

const tool = buildRecordReceiptTool(["uncategorized"]);
const imageBytes = Buffer.from("fake-jpeg-bytes");

describe("buildExtractionRequest", () => {
  it("builds the Haiku shape: budget_tokens thinking, no output_config", () => {
    const request = buildExtractionRequest("claude-haiku-4-5", imageBytes, tool);
    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: expect.any(Number) });
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
