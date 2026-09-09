/**
 * apps/web/src/lib/extractionPolling.ts — when to keep asking.
 *
 * Extraction is asynchronous: an upload returns as soon as the row exists,
 * and a BullMQ worker fills the fields in seconds-to-a-minute later
 * (ARCHITECTURE.md §6). Nothing pushes that result to the browser, so the
 * only way a screen learns extraction finished is to ask again.
 *
 * Before this existed, the receipt detail page never asked. It fetched once,
 * `staleTime` held the result for 30s, `refetchOnWindowFocus` is off for the
 * tunnel's sake, and there was no `refetchInterval` — so a freshly scanned
 * receipt sat empty until something else invalidated the query. Tapping
 * "Re-extract" appeared to fix it, but only because its `onSuccess`
 * invalidate refetched whatever the PREVIOUS background job had already
 * written; the re-extract it had just queued was still running.
 *
 * The rule here is deliberately narrow: poll only while a row is genuinely
 * unfinished, and stop the moment it is not. A permanent interval on a
 * dashboard reached over a Cloudflare Tunnel is a real battery and bandwidth
 * cost on the phone this app is used from.
 */

/**
 * The statuses that mean "no more updates are coming without user action".
 *
 * `failed` is terminal on purpose: the worker has exhausted its retries and
 * only a manual re-extract will change it. `partial` likewise — the receipt
 * saved, some fields need review, and that is a finished state.
 */
const TERMINAL: readonly string[] = ["ok", "partial", "failed"];

/** 2.5s, matching what the capture card polled at before this was shared. */
export const EXTRACTION_POLL_MS = 2500;

export function isExtractionPending(status: string | null | undefined): boolean {
  return typeof status === "string" && !TERMINAL.includes(status);
}

/**
 * The `refetchInterval` for a query, given the statuses it is watching.
 *
 * Returns `false` — not `0`, not `undefined` — when nothing is pending,
 * because that is the value TanStack Query reads as "stop".
 */
export function extractionRefetchInterval(
  statuses: readonly (string | null | undefined)[],
): number | false {
  return statuses.some(isExtractionPending) ? EXTRACTION_POLL_MS : false;
}
