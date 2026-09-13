/**
 * packages/shared/src/extractionPrompt.ts — the system prompt the extraction
 * pipeline sends, and the value "Revert to default" reverts to (D-47).
 *
 * ## Why it lives in `shared`
 *
 * It was a module constant in `packages/queue/src/pipeline/anthropicRequest.ts`,
 * which is the right home for it right up until the admin screen can edit it.
 * `packages/api` cannot import `packages/queue` (D-07) — that containment is
 * what keeps `@anthropic-ai/sdk` and the credential-consuming client
 * unreachable from anything `apps/web` bundles — so the default has to sit
 * somewhere both can see, or "revert to default" would have nothing to compare
 * against and no value to write.
 *
 * The same split `receiptValidation.ts` and `receiptFields.ts` already make:
 * the vocabulary is shared, the caller is not.
 *
 * ## What is editable and what is not
 *
 * This prose is editable from the admin screen. **The tool schema is not** —
 * `packages/queue/src/pipeline/schema.ts` carries the JSON contract, the
 * `required` list strict mode demands, and the per-field rules that make the
 * response parseable at all. That division is deliberate: a bad edit here can
 * degrade an extraction, but it cannot make the response unparseable, cannot
 * remove a field the database expects, and cannot defeat the Luhn scrub. The
 * blast radius of the editable surface is "worse readings", not "broken app".
 *
 * `anthropicRequest.test.ts` asserts a dozen specific phrases from this string.
 * Those assertions are not ceremony — every one of them is a line that was
 * added to fix a real misread, and the test is what stops a future tidy-up
 * quietly undoing one.
 */

export const DEFAULT_EXTRACTION_PROMPT = `You extract structured data from a single photographed or scanned receipt image.

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
 * Bounds on a prompt the admin screen will accept.
 *
 * A lower bound because an empty or one-word system prompt is almost certainly
 * a mis-paste rather than an intention, and the failure it produces — steadily
 * worse extractions with no error anywhere — is the kind this codebase keeps
 * having to hunt down. An upper bound because the prompt is sent on every
 * single extraction call, so its length is a per-receipt cost.
 */
export const MIN_PROMPT_CHARS = 200;
export const MAX_PROMPT_CHARS = 20_000;
