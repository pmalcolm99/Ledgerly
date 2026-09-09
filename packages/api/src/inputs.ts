import "server-only";

import { z } from "zod";
import { canonicalizeMoneySign, formatMoney, parseMoney } from "@ledgerly/shared/money";
import { parseQuantityInput } from "@ledgerly/shared/numeric";

/**
 * packages/api/src/inputs.ts — reusable zod fragments for the column shapes
 * users type into.
 *
 * Every validator here mirrors a database constraint. That is deliberate and
 * load-bearing rather than belt-and-braces: `trpc.ts`'s error formatter
 * replaces the message of any code outside `CLIENT_SAFE_CODES` with a flat
 * "Internal server error." A `numeric_value_out_of_range` or a malformed-time
 * `22007` escaping to the client is therefore not just ugly, it is *silent* —
 * the user is told nothing about what they typed wrong. Validating here turns
 * each of those into a BAD_REQUEST whose message survives intact.
 */

/**
 * `numeric(12,2)`. `parseMoney` is the validation (it rejects a third decimal
 * and enforces the column's range); the transform then normalizes, so "5",
 * "5.0" and "05.00" all store as "5.00" and no comparison later has to worry
 * about representation.
 *
 * `canonicalizeMoneySign` runs first so a credit can be typed the way it is
 * printed — `12.34-` or `(12.34)` as well as `-12.34`. That is not only
 * convenience: `inputMode="decimal"` surfaces no minus key on the iOS keypad,
 * so trailing-minus is the form that is actually typeable on the phone this
 * app is used from.
 *
 * Never `parseFloat`, never `Number(x).toFixed(2)` — D-21.
 */
export const moneyString = z
  .string()
  .trim()
  .transform(canonicalizeMoneySign)
  .superRefine((value, ctx) => {
    try {
      parseMoney(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error && error.message.startsWith("Value exceeds")
            ? "That amount is too large."
            : "Enter an amount like 12.34, or -12.34 for a credit.",
      });
    }
  })
  .transform((value) => formatMoney(parseMoney(value)));

/**
 * `numeric(12,3)` — receipt_items.quantity. NOT money: `parseMoney` throws on
 * "0.125", which is ordinary quantity data.
 */
export const quantityString = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    try {
      parseQuantityInput(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a quantity like 2 or 1.5." });
    }
  })
  .transform((value) => parseQuantityInput(value));

/**
 * Mirrors the `receipts_date_sane` CHECK (>= 2000-01-01). Without the refine
 * the CHECK fires as a 23514 and the formatter flattens it.
 */
export const receiptDateString = z
  .string()
  .date()
  .refine((value) => value >= "2000-01-01", {
    message: "Enter a date from 2000 onwards.",
  });

/**
 * `time` column. Postgres accepts HH:MM and HH:MM:SS; anything else is a raw
 * 22007. Normalized to HH:MM:SS so a value round-trips unchanged through the
 * detail form.
 */
export const receiptTimeString = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Enter a time like 14:30.")
  .transform((value) => (value.length === 5 ? `${value}:00` : value));

/**
 * `char(4)`, mirroring the `receipts_card_last4_digits` CHECK.
 *
 * REJECTS rather than truncates. Truncating a pasted 16-digit PAN to its last
 * four would silently accept full card data into the request path, the log
 * pipeline, and any error report along the way — CLAUDE.md's hard rule is that
 * a full card number never exists in this system, not that it is trimmed
 * before storage.
 */
export const cardLast4String = z
  .string()
  .trim()
  .regex(/^[0-9]{4}$/, "Enter the last 4 digits only.");

/** Trims, and maps an empty string to null. A form that clears a text input
 *  submits "", and storing that would make the column and `missing_fields`
 *  disagree about whether the field is present. */
export function nullableText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable();
}
