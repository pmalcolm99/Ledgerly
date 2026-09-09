import { describe, expect, it } from "vitest";

import {
  EXTRACTION_POLL_MS,
  extractionRefetchInterval,
  isExtractionPending,
} from "./extractionPolling";

/**
 * apps/web/src/lib/extractionPolling.test.ts
 *
 * Two properties, and they pull in opposite directions: a screen must keep
 * asking while extraction is unfinished (the reported bug was that it never
 * asked at all), and must stop the instant it is finished (a permanent
 * interval on a phone over a tunnel is a real cost).
 */

describe("isExtractionPending", () => {
  it("treats only `pending` as unfinished", () => {
    expect(isExtractionPending("pending")).toBe(true);
  });

  /**
   * `failed` is terminal on purpose — the worker has exhausted its retries
   * and nothing but a manual re-extract will change it. Polling it forever
   * would be the never-stopping poll this replaced.
   */
  it("treats ok, partial and failed as finished", () => {
    expect(isExtractionPending("ok")).toBe(false);
    expect(isExtractionPending("partial")).toBe(false);
    expect(isExtractionPending("failed")).toBe(false);
  });

  it("does not poll on a missing status", () => {
    expect(isExtractionPending(null)).toBe(false);
    expect(isExtractionPending(undefined)).toBe(false);
  });
});

describe("extractionRefetchInterval", () => {
  it("returns the interval when any row is still extracting", () => {
    expect(extractionRefetchInterval(["ok", "pending", "failed"])).toBe(EXTRACTION_POLL_MS);
  });

  /**
   * `false`, not `0` and not `undefined` — that is the only value TanStack
   * Query reads as "stop". `0` would poll as fast as the network allows.
   */
  it("returns false, not 0, when everything is finished", () => {
    const result = extractionRefetchInterval(["ok", "partial", "failed"]);
    expect(result).toBe(false);
    expect(result).not.toBe(0);
  });

  it("returns false for an empty list", () => {
    expect(extractionRefetchInterval([])).toBe(false);
  });
});
