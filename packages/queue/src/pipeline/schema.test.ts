import { describe, expect, it } from "vitest";

import { buildRecordReceiptTool } from "./schema";

function categoryEnum(tool: ReturnType<typeof buildRecordReceiptTool>): string[] {
  const properties = tool.input_schema.properties as Record<string, unknown>;
  const items = properties.items as { items: { properties: Record<string, unknown> } };
  const category = items.items.properties.category as { enum: string[] };
  return category.enum;
}

describe("buildRecordReceiptTool", () => {
  it("is strict with additionalProperties false", () => {
    const tool = buildRecordReceiptTool(["household"]);
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
  });

  it("reflects the live category list in the item category enum", () => {
    const tool = buildRecordReceiptTool(["household", "office-supplies"]);
    const enumValues = categoryEnum(tool);
    expect(enumValues).toContain("household");
    expect(enumValues).toContain("office-supplies");
  });

  it("always includes uncategorized even if the live list omits it", () => {
    const tool = buildRecordReceiptTool(["household"]);
    expect(categoryEnum(tool)).toContain("uncategorized");
  });

  it("does not duplicate uncategorized when the live list already has it", () => {
    const tool = buildRecordReceiptTool(["household", "uncategorized"]);
    const enumValues = categoryEnum(tool);
    expect(enumValues.filter((v) => v === "uncategorized")).toHaveLength(1);
  });

  it("requires confidence and items, and marks money fields nullable strings", () => {
    const tool = buildRecordReceiptTool(["household"]);
    expect(tool.input_schema.required).toEqual(["confidence", "items"]);
    const properties = tool.input_schema.properties as Record<
      string,
      { type: unknown } | undefined
    >;
    expect(properties.subtotal?.type).toEqual(["string", "null"]);
    expect(properties.total?.type).toEqual(["string", "null"]);
    expect(properties.confidence?.type).toBe("number");
  });
});
