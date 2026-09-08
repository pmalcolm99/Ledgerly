import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEdgeEnv } from "./edge";

// edge.ts reads `process.env.X` as literal expressions by design (that's the
// whole point — see the file's own comment). Testing it therefore requires
// mutating process.env and re-importing with a reset module cache, unlike
// env.ts's parseEnv, which is tested as a pure function instead.

const KEYS = [
  "DEV_AUTH_BYPASS",
  "CF_ACCESS_ENABLED",
  "CF_ACCESS_AUD",
  "CF_ACCESS_TEAM_DOMAIN",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("edgeEnv", () => {
  it("parses defaults when none of the four keys are set", async () => {
    for (const key of KEYS) delete process.env[key];
    vi.resetModules();
    const { edgeEnv } = await import("./edge");
    expect(edgeEnv.DEV_AUTH_BYPASS).toBe(false);
    expect(edgeEnv.CF_ACCESS_ENABLED).toBe(false);
    expect(edgeEnv.CF_ACCESS_AUD).toBeUndefined();
  });

  it("throws on a malformed CF_ACCESS_AUD", async () => {
    process.env.CF_ACCESS_AUD = "too-short";
    vi.resetModules();
    await expect(import("./edge")).rejects.toThrow(/CF_ACCESS_AUD/);
  });

  it("accepts a well-formed CF_ACCESS_AUD", async () => {
    process.env.CF_ACCESS_AUD = "b".repeat(64);
    vi.resetModules();
    const { edgeEnv } = await import("./edge");
    expect(edgeEnv.CF_ACCESS_AUD).toBe("b".repeat(64));
  });
});

/**
 * D-05 is enforced in BOTH runtimes. `env.ts` guards the Node process at
 * boot; these cover the independent Edge-side guard, so the middleware can
 * never honour a production dev-bypass even if the Node process started.
 */
describe("parseEdgeEnv — D-05 in the Edge runtime", () => {
  it("refuses DEV_AUTH_BYPASS=true under NODE_ENV=production", () => {
    expect(() => parseEdgeEnv({ NODE_ENV: "production", DEV_AUTH_BYPASS: "true" })).toThrow(
      /DEV_AUTH_BYPASS must not be true when NODE_ENV=production/,
    );
  });

  it("allows DEV_AUTH_BYPASS=true outside production", () => {
    expect(parseEdgeEnv({ NODE_ENV: "development", DEV_AUTH_BYPASS: "true" }).DEV_AUTH_BYPASS).toBe(
      true,
    );
  });

  it("allows production when the bypass is off", () => {
    expect(parseEdgeEnv({ NODE_ENV: "production", DEV_AUTH_BYPASS: "false" }).NODE_ENV).toBe(
      "production",
    );
  });
});
