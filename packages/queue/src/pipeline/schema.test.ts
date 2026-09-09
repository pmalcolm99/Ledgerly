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

  it("marks money fields as nullable strings", () => {
    const tool = buildRecordReceiptTool(["household"]);
    // The `required` list is asserted by the completeness invariant below —
    // this assertion USED to pin it to `["confidence", "items"]`, which is
    // the incomplete list that let the model omit fields and produced a
    // TypeError in `normalizeMoney`. A test that encodes a bug is worse than
    // no test, so it is gone rather than updated.
    const properties = tool.input_schema.properties as Record<
      string,
      { type: unknown } | undefined
    >;
    expect(properties.subtotal?.type).toEqual(["string", "null"]);
    expect(properties.total?.type).toEqual(["string", "null"]);
    expect(properties.confidence?.type).toBe("number");
  });

  /**
   * The invariant, not the list.
   *
   * `required` was `["confidence", "items"]` while `RecordReceiptInput` typed
   * every field as `string | null`. Strict mode's contract is
   * `additionalProperties: false` PLUS a complete `required` list, with
   * nullability carried by the `["string","null"]` unions — so the model was
   * free to omit fields, and `normalizeMoney(undefined)` threw
   * `TypeError: Cannot read properties of undefined (reading 'replace')`
   * after a successful, billed call.
   *
   * Asserted as "every property is required" rather than by re-listing the
   * names, so adding a field to the schema and forgetting `required` fails
   * here instead of in production.
   */
  it("requires every property it declares, at both levels", () => {
    const tool = buildRecordReceiptTool(["uncategorized"]);
    const schema = tool.input_schema as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());

    const items = schema.properties.items as {
      items: { required: string[]; properties: Record<string, unknown> };
    };
    expect([...items.items.required].sort()).toEqual(Object.keys(items.items.properties).sort());
  });

  /** Confirmed against the live API (task 6.3, D-12): a complete `required`
   *  list whose optional fields are `["string","null"]` unions is accepted by
   *  strict mode, and both models return every key with absent values as
   *  explicit null. This pins the shape that was verified. */
  it("expresses optional fields as null unions, not by omission from required", () => {
    const tool = buildRecordReceiptTool(["uncategorized"]);
    const schema = tool.input_schema as { properties: Record<string, { type?: unknown }> };

    expect(schema.properties.tip?.type).toEqual(["string", "null"]);
    expect(schema.properties.card_last4?.type).toEqual(["string", "null"]);
    // `confidence` is genuinely always present and is a plain number.
    expect(schema.properties.confidence?.type).toBe("number");
  });
});
