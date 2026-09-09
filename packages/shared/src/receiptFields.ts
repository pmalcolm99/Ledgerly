/**
 * packages/shared/src/receiptFields.ts — the `missing_fields` vocabulary.
 *
 * Lives in `shared` because three layers need the identical list and any
 * drift between them is silent: `pipeline/extract.ts` writes these tokens,
 * `packages/api` validates them as a zod enum on the dismiss procedures, and
 * the UI maps them to labels and form controls. A token misspelled in any one
 * of those produces a badge nothing can ever clear.
 *
 * `tip` is deliberately absent: most receipts have no tip, so extraction never
 * reports one as missing. `items` has no column — it is derived from whether
 * the receipt has any line items.
 */

export const MISSING_FIELD_BY_COLUMN = {
  merchantName: "merchant_name",
  merchantAddress: "merchant_address",
  merchantPhone: "merchant_phone",
  transactionDate: "transaction_date",
  transactionTime: "transaction_time",
  subtotal: "subtotal",
  salesTax: "sales_tax",
  total: "total",
  cardLast4: "card_last4",
  paymentMethod: "payment_method",
} as const;

export type EditableReceiptColumn = keyof typeof MISSING_FIELD_BY_COLUMN;

/**
 * Written as a literal tuple, not spread from the map above: `z.enum`
 * requires a non-empty tuple type, and a spread of `Object.values` erases
 * that. The type-level check below is what keeps the two in step — if a token
 * is added to the map and not here, this file stops compiling.
 */
export const MISSING_FIELD_TOKENS = [
  "merchant_name",
  "merchant_address",
  "merchant_phone",
  "transaction_date",
  "transaction_time",
  "subtotal",
  "sales_tax",
  "total",
  "card_last4",
  "payment_method",
  "items",
] as const;

export type MissingFieldToken = (typeof MISSING_FIELD_TOKENS)[number];

type _TokensCoverMap =
  (typeof MISSING_FIELD_BY_COLUMN)[EditableReceiptColumn] extends MissingFieldToken ? true : never;
const _tokensCoverMap: _TokensCoverMap = true;
void _tokensCoverMap;

export function isMissingFieldToken(value: string): value is MissingFieldToken {
  return (MISSING_FIELD_TOKENS as readonly string[]).includes(value);
}
