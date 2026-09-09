import { describe, expect, it, vi } from "vitest";

import { testAiKey } from "./aiKey";

/**
 * packages/api/src/aiKeyTest.test.ts — the admin screen's "Test" button.
 *
 * Its whole reason for existing is that a rejected key and an unresolvable
 * model id are indistinguishable from the UI — both surfaced as
 * `AI_REQUEST_REJECTED` during the outage that prompted it. So the assertions
 * that matter are the ones about TELLING THEM APART.
 */

const MODELS = ["claude-haiku-4-5", "claude-sonnet-5"];

function respond(byId: Record<string, number>): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const id = decodeURIComponent(String(input).split("/models/")[1] ?? "");
    const status = byId[id] ?? 200;
    return new Response(status === 200 ? "{}" : "error", { status });
  }) as unknown as typeof fetch;
}

describe("testAiKey", () => {
  it("passes when the key authenticates and every model resolves", async () => {
    const result = await testAiKey("sk-ant-x", MODELS, respond({}));
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([
      { id: "claude-haiku-4-5", ok: true },
      { id: "claude-sonnet-5", ok: true },
    ]);
  });

  it("blames the KEY on a 401, not the model", async () => {
    const result = await testAiKey("sk-ant-bad", MODELS, respond({ "claude-haiku-4-5": 401 }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("key was rejected");
    expect(result.message).not.toContain("model");
  });

  /** The distinction the button exists for. */
  it("blames the MODEL on a 404, and says the key works", async () => {
    const result = await testAiKey("sk-ant-x", MODELS, respond({ "claude-sonnet-5": 404 }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("The key works");
    expect(result.message).toContain("claude-sonnet-5");
    expect(result.models).toEqual([
      { id: "claude-haiku-4-5", ok: true },
      { id: "claude-sonnet-5", ok: false },
    ]);
  });

  it("reports a network failure as unreachable rather than as a bad key", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await testAiKey("sk-ant-x", MODELS, failing);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Could not reach");
  });

  /** The key is in a header on every one of these requests. */
  it("never puts the key in the message", async () => {
    const key = "sk-ant-do-not-leak-me";
    const result = await testAiKey(key, MODELS, respond({ "claude-haiku-4-5": 401 }));
    expect(result.message).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  /** Honesty about scope: a green result must not imply extraction works. */
  it("says what a pass does NOT prove", async () => {
    const result = await testAiKey("sk-ant-x", MODELS, respond({}));
    expect(result.message).toContain("does not exercise the extraction request");
  });
});
