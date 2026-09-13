import "server-only";

import { z } from "zod";
import type { Database } from "@ledgerly/db";

import { SECRET_KEYS, SecretError, readSecret } from "./secrets";

/**
 * packages/api/src/modelCatalog.ts — the list of models the admin screen
 * offers, refreshed once a day (D-47).
 *
 * ## Why this is not just a fetch
 *
 * `GET /v1/models` is not a complete answer to "what can I pick?", for two
 * reasons this app already learned the hard way and recorded in D-12:
 *
 * 1. **It returns dated snapshots only** — `claude-haiku-4-5-20251001` — and
 *    never the undated aliases this app is actually built around
 *    (`claude-sonnet-5`). D-12's first amendment says so explicitly: the
 *    absence of an alias from that endpoint proved nothing, because aliases
 *    are not listed. A dropdown built from the endpoint alone would not
 *    contain the value that is currently configured, and the admin would
 *    watch their own setting vanish from its own selector.
 * 2. **It carries no capability data.** The response is
 *    `{id, display_name, created_at, type}`. Whether a model can read an image
 *    is not in there, so vision has to be decided locally.
 *
 * So the catalogue is a UNION — curated aliases, whatever the API returned,
 * and the two ids currently in use — deduped, never just the API's answer.
 *
 * ## Refresh policy
 *
 * Once per UTC day, and only when an owner opens the settings page. There is no
 * scheduler behind this: an instance nobody administers does not need a fresh
 * model list, and a background job that calls a third-party API on a timer is a
 * thing to maintain and pay for. `admin.aiSettings` reports `catalogStale`, the
 * client fires `admin.refreshModelCatalog` once, and the mutation re-checks
 * staleness server-side so two tabs opening at once still make one call.
 */

const modelEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  /** `false` means "known not to accept images"; `null` means "unrecognised —
   *  we do not know". The UI distinguishes them: unknown is offered with a
   *  warning, known-bad is not offered at all. */
  vision: z.boolean().nullable(),
});

export const modelCatalogSchema = z.object({
  /** ISO instant of the last successful API fetch, or null when the catalogue
   *  has only ever been the built-in list. */
  fetchedAt: z.string().nullable(),
  models: z.array(modelEntrySchema),
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

/**
 * The undated aliases this codebase is built around, which `GET /v1/models`
 * will never return.
 *
 * Undated aliases are the right default for this app: they follow the family
 * forward, so an instance keeps getting the current snapshot without an
 * operator editing anything. A dated id is the right choice only when
 * reproducibility matters more than currency, and that is a deliberate act —
 * which is why they come from the API list rather than being curated here.
 */
const KNOWN_ALIASES: ModelEntry[] = [
  { id: "claude-opus-5", displayName: "Claude Opus 5", vision: true },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", vision: true },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", vision: true },
];

/**
 * Vision capability, decided locally because the API does not report it.
 *
 * Matching on family substrings rather than exact ids, the same way
 * `capabilityForModel` in the queue package decides the request shape — and
 * for the same reason: model ids are free text here (D-12) so that re-pointing
 * at a new one is a config change rather than a code change, and an exact-match
 * table would defeat that the day a new snapshot ships.
 *
 * Returning `null` rather than `false` for an unrecognised id is the important
 * part. A new model family this list has never heard of is far more likely to
 * be vision-capable than not, so hiding it would be actively wrong — the admin
 * would be unable to select a model that works. Unknown is offered with a
 * warning; only families known NOT to read images are excluded.
 */
export function visionCapability(id: string): boolean | null {
  const lower = id.toLowerCase();
  // Pre-3 Claude models and the text-only embedding/instant lineage. Everything
  // from Claude 3 onward reads images.
  if (/claude-(instant|1|2)(\b|[-.])/.test(lower)) return false;
  if (/claude-(3|4|5|opus|sonnet|haiku)/.test(lower)) return true;
  return null;
}

const anthropicModelsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().min(1).optional(),
    }),
  ),
});

/** The built-in catalogue, used before any fetch has ever succeeded and as the
 *  floor every later merge builds on. */
export function builtInCatalog(): ModelCatalog {
  return { fetchedAt: null, models: [...KNOWN_ALIASES] };
}

/**
 * Merges API results, the curated aliases, and the ids currently configured.
 *
 * `configured` is what stops the selector from losing the admin's own setting:
 * an id typed into `.env` months ago, or an alias the API does not list, still
 * appears and still shows as selected. Sorted so the list is stable between
 * refreshes rather than reordering under the cursor.
 */
export function mergeCatalog(params: {
  fromApi: ModelEntry[];
  configured: string[];
  fetchedAt: string | null;
}): ModelCatalog {
  const byId = new Map<string, ModelEntry>();
  for (const entry of [...KNOWN_ALIASES, ...params.fromApi]) {
    byId.set(entry.id, entry);
  }
  for (const id of params.configured) {
    if (!byId.has(id)) byId.set(id, { id, displayName: id, vision: visionCapability(id) });
  }
  const models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { fetchedAt: params.fetchedAt, models };
}

export type CatalogFetchResult =
  { ok: true; catalog: ModelCatalog } | { ok: false; message: string };

/**
 * Fetches the live model list.
 *
 * Deliberately a plain `fetch`, not `@anthropic-ai/sdk`, for the reason
 * `aiKey.ts`'s `testAiKey` gives at length: that package lives in
 * `packages/queue` only, so the credential-consuming client stays unreachable
 * from anything `apps/web` bundles. Adding it here to save a few lines would
 * throw that containment away for a request with no body.
 */
export async function fetchModelCatalog(
  apiKey: string,
  configured: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the Anthropic API (${error instanceof Error ? error.name : "network error"}).`,
    };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "The API key was rejected (401/403). Check the key itself." };
    }
    return { ok: false, message: `The Anthropic API returned ${response.status}.` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: "The Anthropic API returned a response that was not JSON." };
  }
  const parsed = anthropicModelsResponse.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      message: "The Anthropic API returned a model list in an unexpected shape.",
    };
  }

  const fromApi: ModelEntry[] = parsed.data.data.map((model) => ({
    id: model.id,
    displayName: model.display_name ?? model.id,
    vision: visionCapability(model.id),
  }));

  return {
    ok: true,
    catalog: mergeCatalog({ fromApi, configured, fetchedAt: new Date().toISOString() }),
  };
}

/** Reads the stored catalogue, falling back to the built-in list. Unreadable
 *  and unparseable both degrade to the built-in one — a settings screen must
 *  not be unusable because a cache went bad. */
export async function readModelCatalog(
  db: Database,
  masterKeyBase64: string,
): Promise<ModelCatalog> {
  let stored: string | null;
  try {
    stored = await readSecret(db, SECRET_KEYS.modelCatalog, masterKeyBase64);
  } catch (error) {
    if (error instanceof SecretError) return builtInCatalog();
    throw error;
  }
  if (!stored) return builtInCatalog();
  try {
    const parsed = modelCatalogSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : builtInCatalog();
  } catch {
    return builtInCatalog();
  }
}

export function serializeModelCatalog(catalog: ModelCatalog): string {
  return JSON.stringify(catalog);
}

/**
 * Whether the catalogue is due a refresh.
 *
 * Per UTC DAY rather than a rolling 24 hours, because the user's rule was "once
 * per day, when an admin visits" — a rolling window would make an admin who
 * checks in every 23 hours never refresh at all.
 */
export function catalogIsStale(catalog: ModelCatalog, now: Date = new Date()): boolean {
  if (catalog.fetchedAt === null) return true;
  return catalog.fetchedAt.slice(0, 10) !== now.toISOString().slice(0, 10);
}
