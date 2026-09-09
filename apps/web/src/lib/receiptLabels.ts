/**
 * apps/web/src/lib/receiptLabels.ts — the human-readable half of the
 * extraction vocabulary.
 *
 * The pipeline emits machine tokens: eleven `missing_fields` values, four
 * `validation_flags`, and about eighteen `extraction_error` strings. None of
 * them are showable as-is. This is the single translation table, so a token
 * added to the pipeline shows up as a missing entry here rather than as
 * `merchant_name` leaking onto the screen in three different places.
 */

/** The 11 tokens `pipeline/extract.ts` can put in `missing_fields`. */
export const MISSING_FIELD_LABELS: Record<string, string> = {
  merchant_name: "Merchant",
  merchant_address: "Address",
  merchant_phone: "Phone",
  transaction_date: "Date",
  transaction_time: "Time",
  subtotal: "Subtotal",
  sales_tax: "Sales tax",
  total: "Total",
  card_last4: "Card last 4",
  payment_method: "Payment method",
  items: "Line items",
};

/** Which form control each token corresponds to, for the review queue's
 *  "fix a field, next receipt" flow. `items` has no single input — it is
 *  handled by the line-item table — so it is deliberately absent. */
export const MISSING_FIELD_TO_INPUT: Record<string, string> = {
  merchant_name: "merchantName",
  merchant_address: "merchantAddress",
  merchant_phone: "merchantPhone",
  transaction_date: "transactionDate",
  transaction_time: "transactionTime",
  subtotal: "subtotal",
  sales_tax: "salesTax",
  total: "total",
  card_last4: "cardLast4",
  payment_method: "paymentMethod",
};

export function missingFieldLabel(token: string): string {
  return MISSING_FIELD_LABELS[token] ?? token.replace(/_/g, " ");
}

/** The 4 `validation_flags`. Each says what is wrong in terms of what the
 *  user can see on the receipt in their hand. */
export const VALIDATION_FLAG_LABELS: Record<string, string> = {
  arithmetic_mismatch_total: "Subtotal + tax + tip doesn't match the total",
  arithmetic_mismatch_items: "Line items don't add up to the subtotal",
  date_in_future: "The date is in the future",
  date_too_old: "The date looked wrong and was cleared",
};

export function validationFlagLabel(flag: string): string {
  return VALIDATION_FLAG_LABELS[flag] ?? flag.replace(/_/g, " ");
}

/**
 * `extraction_error` strings, from ingest and from the AI pass. Split by
 * whether the user can do anything about it — a failed render is worth
 * re-uploading a clearer photo for, an overloaded API is worth retrying.
 */
const EXTRACTION_ERROR_LABELS: Record<string, string> = {
  // ingest
  RECEIPT_NOT_FOUND: "This receipt's record went missing during processing.",
  STAGING_FILE_MISSING: "The uploaded file went missing before it could be processed.",
  IMAGE_DECODE_FAILED: "That image couldn't be read. Try photographing it again.",
  PDFTOPPM_UNAVAILABLE: "PDF support isn't available on the server right now.",
  PDF_RASTERIZATION_FAILED: "That PDF couldn't be rendered. Try a photo instead.",
  RENDER_WRITE_FAILED: "The server couldn't save the processed image.",
  UPLOAD_PERSISTENCE_FAILED: "The upload didn't finish saving. Try uploading it again.",
  // AI
  AI_RATE_LIMITED: "The extraction service was busy. Try re-extracting shortly.",
  AI_OVERLOADED: "The extraction service was overloaded. Try re-extracting shortly.",
  AI_API_ERROR: "The extraction service returned an error.",
  AI_CONNECTION_FAILED: "Couldn't reach the extraction service.",
  AI_REQUEST_REJECTED: "The extraction service rejected the request. Check the server's API key.",
  AI_CALL_FAILED: "The extraction call failed.",
  AI_NO_TOOL_USE: "The extraction service didn't return any structured data.",
  AI_INVALID_RESPONSE: "The extraction service returned something unreadable.",
  EXTRACTION_RENDER_FAILED: "Couldn't prepare the image for extraction.",
  AI_EXTRACTION_FAILED: "Extraction failed.",
};

export function extractionErrorLabel(error: string | null): string | null {
  if (!error) return null;
  return EXTRACTION_ERROR_LABELS[error] ?? "Extraction failed. You can still fill this in by hand.";
}

/** Every field on a receipt can be typed in by hand, so a failed extraction
 *  is never a dead end — this is the line that says so. */
export const EXTRACTION_FAILED_HINT = "You can still fill in the details by hand.";

export type ReceiptReviewState = "clear" | "needs-review" | "processing" | "failed";

/**
 * One place that decides which badge a receipt gets. Note `missing_fields`
 * is checked independently of `extraction_status`: a receipt with unread
 * fields but clean arithmetic is still `'ok'`, and it still needs review.
 */
export function receiptReviewState(receipt: {
  extractionStatus: string;
  missingFields: readonly string[];
  validationFlags?: readonly string[];
}): ReceiptReviewState {
  if (receipt.extractionStatus === "pending") return "processing";
  if (receipt.extractionStatus === "failed") return "failed";
  if (receipt.missingFields.length > 0 || (receipt.validationFlags?.length ?? 0) > 0) {
    return "needs-review";
  }
  return "clear";
}
