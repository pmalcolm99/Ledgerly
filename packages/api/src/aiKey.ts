import "server-only";

import type { Database } from "@ledgerly/db";

import { SECRET_KEYS, SecretError, readSecret, readSecretMetadata, secretHint } from "./secrets";

/**
 * packages/api/src/aiKey.ts — where the Anthropic API key comes from.
 *
 * One resolution order, in one place, used by both the worker (which needs
 * the key) and the admin screen (which needs to describe it):
 *
 *   1. `app_config.anthropic_api_key`, set from the admin page, encrypted
 *      at rest with `MASTER_KEY`.
 *   2. `ANTHROPIC_API_KEY` from the environment.
 *   3. Nothing — extraction fails with a named reason and the receipts sit
 *      in the review queue with their images intact.
 *
 * **The stored value wins over the environment.** An operator who types a key
 * into the admin screen and sees the environment silently override it has no
 * way to tell what went wrong; the reverse — the environment acting as a
 * bootstrap default that the UI can supersede — is explainable and is what
 * makes the screen useful on an instance that already has an env key.
 *
 * `ANTHROPIC_API_KEY` is optional in `packages/config` for this reason: a
 * fresh instance has to be able to boot with no key at all so the owner can
 * set one from the UI. That is a deliberate narrowing of D-14's
 * fail-fast-at-startup rule, argued in D-39: an unset key can no longer stop
 * the process from starting, so it is surfaced instead as a WARN at boot, a
 * banner on the admin screen, and a non-retryable job failure with a reason
 * code — three visible signals rather than one fatal one.
 */

/**
 * `undecryptable` is a real state, not a defensive nicety: rotate
 * `MASTER_KEY`, or restore a `pg_dump` onto an instance with a different one,
 * and the stored row is ciphertext nobody can read. Treating that as "none"
 * would silently fall back to the environment key and hide a serious
 * operator problem; treating it as an exception would take the admin screen
 * down with it — the one screen that can clear the bad row.
 */
export type AiKeySource = "app_config" | "env" | "none" | "undecryptable";

export type ResolvedAiKey = {
  /** Never logged, never returned over tRPC. */
  apiKey: string | null;
  source: AiKeySource;
};

/**
 * Resolves the key for actual use. The plaintext in the return value is why
 * this must never be called from a tRPC procedure that returns its result —
 * use `describeAiKey` for anything user-facing.
 */
export async function resolveAiKey(
  db: Database,
  masterKeyBase64: string,
  envApiKey: string | undefined,
): Promise<ResolvedAiKey> {
  let stored: string | null;
  try {
    stored = await readSecret(db, SECRET_KEYS.anthropicApiKey, masterKeyBase64);
  } catch (error) {
    if (error instanceof SecretError) {
      // Deliberately NOT falling through to the environment key. A stored row
      // that cannot be read means MASTER_KEY is wrong for this database, and
      // quietly extracting with a different key would bury that — the next
      // thing the operator notices would be an empty `app_config` after a
      // restore. Report the state and let the caller decide.
      return { apiKey: null, source: "undecryptable" };
    }
    throw error;
  }

  if (stored && stored.length > 0) return { apiKey: stored, source: "app_config" };
  if (envApiKey && envApiKey.length > 0) return { apiKey: envApiKey, source: "env" };
  return { apiKey: null, source: "none" };
}

export type AiKeyDescription = {
  source: AiKeySource;
  /** Last four characters and a length, or null when nothing is configured.
   *  See `secrets.ts`'s `secretHint` for why four. */
  hint: string | null;
  /** Only populated when the key came from `app_config`. */
  updatedAt: Date | null;
  updatedBy: string | null;
};

/**
 * The user-facing description of the key. Returns a hint, never the key.
 *
 * This is the function a tRPC procedure may call. It deliberately has a
 * different return type from `resolveAiKey` — there is no field on
 * `AiKeyDescription` that could hold a secret, so a future edit cannot leak
 * one through it by accident.
 */
export async function describeAiKey(
  db: Database,
  masterKeyBase64: string,
  envApiKey: string | undefined,
): Promise<AiKeyDescription> {
  const resolved = await resolveAiKey(db, masterKeyBase64, envApiKey);
  const metadata =
    resolved.source === "app_config"
      ? await readSecretMetadata(db, SECRET_KEYS.anthropicApiKey)
      : null;

  return {
    source: resolved.source,
    hint: resolved.apiKey ? secretHint(resolved.apiKey) : null,
    updatedAt: metadata?.updatedAt ?? null,
    updatedBy: metadata?.updatedBy ?? null,
  };
}

/**
 * Shape validation for a key the admin screen submits.
 *
 * Deliberately permissive about the prefix. Anthropic's own keys begin
 * `sk-ant-`, but the SDK's `baseURL` can point at a gateway or proxy that
 * issues its own tokens, and hard-rejecting those would make this screen
 * useless for exactly the operator who most needs it. So: reject the things
 * that are certainly mistakes — empty, whitespace inside, implausibly short,
 * absurdly long — and let anything else through. The real test of a key is a
 * call to the API, which the extraction worker performs.
 */
export function validateAiKeyShape(
  raw: string,
): { ok: true; key: string } | { ok: false; message: string } {
  const key = raw.trim();
  if (key.length === 0)
    return { ok: false, message: "Paste a key, or use Clear to remove the stored one." };
  if (/\s/.test(key)) {
    return {
      ok: false,
      message:
        "That key contains a space or line break — it was probably copied with surrounding text.",
    };
  }
  if (key.length < 20) return { ok: false, message: "That key is too short to be an API key." };
  if (key.length > 512)
    return { ok: false, message: "That key is longer than any API key we expect." };
  return { ok: true, key };
}
