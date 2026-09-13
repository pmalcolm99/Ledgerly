/**
 * packages/shared/src/receiptSort.ts — how a project's receipts are ordered.
 *
 * In `shared` for the same reason `themes.ts` is: the list of valid values is
 * needed by the `z.enum` on the server (so an unknown value is a 400, not a
 * silently-ignored setting), by the column default in the schema, and by the
 * dropdown in the browser. One list, three consumers.
 *
 * `date_desc` is first and is the default because it is what the project page
 * did before there was a choice — an existing user's list must not reorder
 * itself the day this ships.
 */

export const RECEIPT_SORTS = [
  "date_desc",
  "date_asc",
  "name_asc",
  "name_desc",
  "added_desc",
  "added_asc",
] as const;

export type ReceiptSort = (typeof RECEIPT_SORTS)[number];

export const DEFAULT_RECEIPT_SORT: ReceiptSort = "date_desc";

export const RECEIPT_SORT_LABELS: Record<ReceiptSort, string> = {
  date_desc: "Newest purchase first",
  date_asc: "Oldest purchase first",
  name_asc: "Merchant A–Z",
  name_desc: "Merchant Z–A",
  added_desc: "Recently added",
  added_asc: "First added",
};

export function isReceiptSort(value: string): value is ReceiptSort {
  return (RECEIPT_SORTS as readonly string[]).includes(value);
}
