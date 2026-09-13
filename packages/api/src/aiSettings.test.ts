import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { getCleanPool, mkTestUser, withCleanDatabase } from "@ledgerly/db/testHarness";
import * as schema from "@ledgerly/db/schema";
import { DEFAULT_EXTRACTION_PROMPT } from "@ledgerly/shared/extractionPrompt";

import { describeAiSettings, resolveAiSettings, serializeAiSettings } from "./aiSettings";
import { SECRET_KEYS, writeSecret } from "./secrets";
import {
  builtInCatalog,
  catalogIsStale,
  fetchModelCatalog,
  mergeCatalog,
  visionCapability,
} from "./modelCatalog";

/**
 * packages/api/src/aiSettings.test.ts — D-47.
 *
 * The assertions that matter are about PRECEDENCE and about the two ways this
 * can silently do nothing: settings that never reach the worker, and a model
 * list that does not contain the model you have configured.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;

// A valid 32-byte key, base64. Fixed rather than random so a failure is
// reproducible.
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const ENV = {
  modelPass1: "claude-sonnet-5",
  modelPass2: "claude-sonnet-5",
  escalateBelow: 0.6,
  concurrency: 3,
};

beforeEach(async () => {
  await withCleanDatabase();
  db = drizzle(getCleanPool(), { schema });
});

afterAll(async () => {
  await getCleanPool().end();
});

async function store(value: string): Promise<void> {
  const user = await mkTestUser(db, "ai-settings");
  await db.transaction(async (tx) => {
    await writeSecret(tx, SECRET_KEYS.aiSettings, value, MASTER_KEY, user.id);
  });
}

describe("resolveAiSettings", () => {
  it("falls back to the environment when nothing is stored", async () => {
    const { settings, source } = await resolveAiSettings(db, MASTER_KEY, ENV);
    expect(source).toBe("env");
    expect(settings.modelPass1).toBe("claude-sonnet-5");
    expect(settings.escalateBelow).toBe(0.6);
    expect(settings.prompt).toBe(DEFAULT_EXTRACTION_PROMPT);
    expect(settings.promptCustomised).toBe(false);
  });

  /** The direction that matters: an operator who types a setting into the admin
   *  screen and watches the environment override it has no way to tell what
   *  went wrong. */
  it("lets the stored value win over the environment", async () => {
    await store(serializeAiSettings({ modelPass1: "claude-opus-5", escalateBelow: 0.9 }));

    const { settings, source } = await resolveAiSettings(db, MASTER_KEY, ENV);
    expect(source).toBe("app_config");
    expect(settings.modelPass1).toBe("claude-opus-5");
    expect(settings.escalateBelow).toBe(0.9);
    // Unset fields still come from the environment — a partial store is a
    // partial override, not a reset.
    expect(settings.modelPass2).toBe("claude-sonnet-5");
    expect(settings.concurrency).toBe(3);
  });

  /**
   * Unlike `resolveAiKey`, this one DOES fall through on an unreadable row.
   * Extracting with the shipped defaults is what a fresh instance does anyway;
   * refusing to extract at all would be a worse answer to a rotated MASTER_KEY.
   */
  it("degrades to the environment when the row cannot be read", async () => {
    await store(serializeAiSettings({ modelPass1: "claude-opus-5" }));
    const otherKey = Buffer.alloc(32, 9).toString("base64");

    const { settings, source } = await resolveAiSettings(db, otherKey, ENV);
    expect(source).toBe("undecryptable");
    expect(settings.modelPass1).toBe("claude-sonnet-5");
  });

  it("reports a row that decrypts but no longer parses as undecryptable", async () => {
    await store(JSON.stringify({ escalateBelow: "not a number" }));
    const { source } = await resolveAiSettings(db, MASTER_KEY, ENV);
    expect(source).toBe("undecryptable");
  });

  it("marks a stored prompt as customised", async () => {
    await store(
      serializeAiSettings({ prompt: `${DEFAULT_EXTRACTION_PROMPT}\n\nAlso: be careful.` }),
    );
    const { settings } = await resolveAiSettings(db, MASTER_KEY, ENV);
    expect(settings.promptCustomised).toBe(true);
  });
});

describe("describeAiSettings", () => {
  /** The condition that switches off both the ladder and the review rescan.
   *  `extract.ts` gates both on the models differing, so an admin staring at a
   *  0% escalation rate should be told why. */
  it("reports the ladder as disabled when both passes are the same model", async () => {
    const description = await describeAiSettings(db, MASTER_KEY, ENV);
    expect(description.ladderDisabled).toBe(true);

    await store(serializeAiSettings({ modelPass2: "claude-opus-5" }));
    const after = await describeAiSettings(db, MASTER_KEY, ENV);
    expect(after.ladderDisabled).toBe(false);
  });
});

describe("the model catalogue", () => {
  it("knows which families can read an image, and admits when it does not", () => {
    expect(visionCapability("claude-sonnet-5")).toBe(true);
    expect(visionCapability("claude-haiku-4-5-20251001")).toBe(true);
    expect(visionCapability("claude-2.1")).toBe(false);
    expect(visionCapability("claude-instant-1.2")).toBe(false);
    // Unknown, not false: a family this list has never heard of is far more
    // likely to read images than not, and hiding it would leave an admin
    // unable to pick a model that works.
    expect(visionCapability("some-future-model")).toBeNull();
  });

  /**
   * THE ASSERTION THIS EXISTS FOR. `GET /v1/models` returns dated snapshots and
   * never the undated aliases this app is built around (D-12), so a catalogue
   * built from the API alone would not contain the value that is configured —
   * and the selector would silently drop the admin's own setting.
   */
  it("keeps the configured model even when the API has never heard of it", () => {
    const catalog = mergeCatalog({
      fromApi: [
        { id: "claude-sonnet-5-20260101", displayName: "Claude Sonnet 5 (dated)", vision: true },
      ],
      configured: ["my-gateway-model", "claude-sonnet-5"],
      fetchedAt: "2026-09-13T00:00:00.000Z",
    });

    const ids = catalog.models.map((m) => m.id);
    expect(ids).toContain("my-gateway-model");
    expect(ids).toContain("claude-sonnet-5-20260101");
    // And the curated alias, which is neither in the API list nor configured.
    expect(ids).toContain("claude-haiku-4-5");
    // Deduped, and stable between refreshes.
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("is stale when never fetched, and once the UTC day rolls over", () => {
    expect(catalogIsStale(builtInCatalog())).toBe(true);

    const fetched = { fetchedAt: "2026-09-13T23:59:00.000Z", models: [] };
    expect(catalogIsStale(fetched, new Date("2026-09-13T00:00:01Z"))).toBe(false);
    expect(catalogIsStale(fetched, new Date("2026-09-14T00:00:01Z"))).toBe(true);
  });

  it("reports a rejected key without throwing", async () => {
    const result = await fetchModelCatalog(
      "sk-bad",
      ["claude-sonnet-5"],
      (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/401/);
  });

  it("reports an unreachable API without throwing", async () => {
    const result = await fetchModelCatalog("sk-x", [], (() =>
      Promise.reject(new Error("boom"))) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });

  it("merges a successful fetch", async () => {
    const body = JSON.stringify({
      data: [{ id: "claude-opus-5-20260301", display_name: "Claude Opus 5" }],
    });
    const result = await fetchModelCatalog(
      "sk-x",
      ["claude-sonnet-5"],
      (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.models.map((m) => m.id)).toContain("claude-opus-5-20260301");
    expect(result.catalog.fetchedAt).not.toBeNull();
  });
});
