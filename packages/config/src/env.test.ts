import { describe, expect, it, vi } from "vitest";

import { parseEnv } from "./env";

// A structurally valid 32-byte key, generated fresh per test run. Never a
// real deployment secret — just something that decodes to the right length.
const VALID_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const VALID_AUD = "a".repeat(64);

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgres://user:pass@localhost:5432/ledgerly",
    MASTER_KEY: VALID_MASTER_KEY,
    ANTHROPIC_API_KEY: "test-key",
    ...overrides,
  };
}

describe("parseEnv", () => {
  it("parses a minimal valid environment and applies defaults", () => {
    const env = parseEnv(baseEnv());
    expect(env.APP_PORT).toBe(3000);
    expect(env.REDIS_URL).toBe("redis://redis:6379");
    expect(env.AI_MODEL_PASS1).toBe("claude-haiku-4-5");
    expect(env.AI_MODEL_PASS2).toBe("claude-sonnet-5");
    expect(env.DEFAULT_CURRENCY).toBe("USD");
    expect(env.DEV_AUTH_BYPASS).toBe(false);
  });

  it("lists every problem, not just the first, when required vars are missing", () => {
    let error: Error | undefined;
    try {
      parseEnv({});
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("DATABASE_URL");
    expect(error?.message).toContain("MASTER_KEY");
    expect(error?.message).toContain("ANTHROPIC_API_KEY");
  });

  it("throws when DEV_AUTH_BYPASS=true and NODE_ENV=production (D-05)", () => {
    expect(() =>
      parseEnv(
        baseEnv({
          NODE_ENV: "production",
          DEV_AUTH_BYPASS: "true",
          CF_ACCESS_AUD: VALID_AUD,
          CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        }),
      ),
    ).toThrow(/DEV_AUTH_BYPASS/);
  });

  it("parses when DEV_AUTH_BYPASS=true and NODE_ENV=development", () => {
    const env = parseEnv(baseEnv({ NODE_ENV: "development", DEV_AUTH_BYPASS: "true" }));
    expect(env.DEV_AUTH_BYPASS).toBe(true);
  });

  it("throws in production without CF_ACCESS_AUD", () => {
    expect(() =>
      parseEnv(
        baseEnv({
          NODE_ENV: "production",
          CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        }),
      ),
    ).toThrow(/CF_ACCESS_AUD/);
  });

  it("throws in production without CF_ACCESS_TEAM_DOMAIN", () => {
    expect(() =>
      parseEnv(
        baseEnv({
          NODE_ENV: "production",
          CF_ACCESS_AUD: VALID_AUD,
        }),
      ),
    ).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
  });

  it("throws on a non-64-hex CF_ACCESS_AUD, regardless of environment", () => {
    expect(() => parseEnv(baseEnv({ CF_ACCESS_AUD: "not-a-valid-aud-tag" }))).toThrow(
      /CF_ACCESS_AUD/,
    );
  });

  it("throws when MASTER_KEY does not decode to exactly 32 bytes", () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    expect(() => parseEnv(baseEnv({ MASTER_KEY: shortKey }))).toThrow(/MASTER_KEY/);
  });

  it("throws when MASTER_KEY is not valid base64", () => {
    expect(() => parseEnv(baseEnv({ MASTER_KEY: "not base64 at all!!" }))).toThrow(/MASTER_KEY/);
  });

  it("parses and WARNs on every boot when ACCESS_ALLOW_SUB_RELINK=true (D-27)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = parseEnv(baseEnv({ ACCESS_ALLOW_SUB_RELINK: "true" }));

    expect(env.ACCESS_ALLOW_SUB_RELINK).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("ACCESS_ALLOW_SUB_RELINK");

    warnSpy.mockRestore();
  });

  it("does not WARN when ACCESS_ALLOW_SUB_RELINK is left at its default", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    parseEnv(baseEnv());

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
