import type Anthropic from "@anthropic-ai/sdk";

/**
 * packages/queue/src/pipeline/schema.ts — the `record_receipt` tool
 * (task 6.2, ARCHITECTURE.md §6.2, D-20).
 *
 * `strict: true` + `additionalProperties: false` + an explicit `required`
 * list guarantees `tool_use.input` validates against this schema exactly —
 * no parse-and-repair step (D-12). The `category` enum is built here, at
 * call time, from the live `categories` table rather than hardcoded, so a
 * category added through the UI is selectable on the very next call
 * (task 6.2's acceptance criterion). Money fields are `["string","null"]`
 * decimal strings, not numbers — matching D-21's numeric-string convention
 * everywhere else in the codebase (`packages/shared/src/money.ts`), so a
 * value like "12.30" survives round-trip without float error. Confirming
 * strict mode actually accepts a `["string","null"]` union is task 6.3 —
 * see `docs/private/` or the D-12 amendment in `DECISIONS.md` for the
 * outcome.
 */

/** The shape `tool_use.input` takes when strict mode holds (task 6.3) —
 * mirrors `buildRecordReceiptTool`'s schema field-for-field. Cast onto the
 * parsed, scrubbed input in `pipeline/extract.ts`; a light runtime shape
 * guard there is the actual defense if strict mode ever doesn't hold. */
export type RecordReceiptItemInput = {
  description: string;
  quantity: string | null;
  unit_price: string | null;
  line_total: string | null;
  category: string;
};

export type RecordReceiptInput = {
  merchant_name: string | null;
  merchant_address: string | null;
  merchant_phone: string | null;
  transaction_date: string | null;
  transaction_time: string | null;
  subtotal: string | null;
  sales_tax: string | null;
  tip: string | null;
  total: string | null;
  card_last4: string | null;
  payment_method: string | null;
  confidence: number;
  items: RecordReceiptItemInput[];
};

const MONEY_FIELD = {
  type: ["string", "null"] as const,
  description: 'Decimal amount as a string, e.g. "12.34". Null if not printed or illegible.',
};

const NULLABLE_STRING = { type: ["string", "null"] as const };

export function buildRecordReceiptTool(categorySlugs: readonly string[]): Anthropic.Tool {
  // `uncategorized` is a permanent, undeletable system category
  // (packages/db/src/seed.ts) — always available as the honest fallback
  // even if the live fetch somehow raced a delete of every other row.
  const categoryEnum = categorySlugs.includes("uncategorized")
    ? categorySlugs
    : [...categorySlugs, "uncategorized"];

  return {
    name: "record_receipt",
    description:
      "Record the structured data extracted from a receipt image. Return null for any " +
      "field that is not printed on the receipt or is illegible — never guess. A null " +
      "field the user fills in by hand is fine; a confidently wrong value is not.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["confidence", "items"],
      properties: {
        merchant_name: NULLABLE_STRING,
        merchant_address: NULLABLE_STRING,
        merchant_phone: NULLABLE_STRING,
        transaction_date: {
          type: ["string", "null"],
          description: "ISO 8601 date (YYYY-MM-DD) as printed on the receipt, or null.",
        },
        transaction_time: {
          type: ["string", "null"],
          description: "24-hour time (HH:MM or HH:MM:SS) as printed on the receipt, or null.",
        },
        subtotal: MONEY_FIELD,
        sales_tax: MONEY_FIELD,
        tip: MONEY_FIELD,
        total: MONEY_FIELD,
        card_last4: {
          type: ["string", "null"],
          description:
            "Exactly the last 4 digits of a payment card, if printed. Never the full card " +
            "number — if only a full or partial number longer than 4 digits is visible, " +
            "return just the last 4 digits, never the rest.",
        },
        payment_method: NULLABLE_STRING,
        confidence: {
          type: "number",
          description: "Your honest confidence in this extraction as a whole, from 0.0 to 1.0.",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "category"],
            properties: {
              description: {
                type: "string",
                description: "Exactly as printed. Never invent a line item that isn't printed.",
              },
              quantity: {
                type: ["string", "null"],
                description: 'Decimal quantity as a string (e.g. "1", "2.5"), or null.',
              },
              unit_price: MONEY_FIELD,
              line_total: MONEY_FIELD,
              category: {
                type: "string",
                enum: categoryEnum,
                description:
                  'One of the given category slugs. Use "uncategorized" when genuinely ' +
                  "unclear rather than forcing a bad fit.",
              },
            },
          },
        },
      },
    },
  };
}
