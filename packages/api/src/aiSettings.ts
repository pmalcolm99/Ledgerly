import "server-only";

import { z } from "zod";
import type { Database } from "@ledgerly/db";
import {
  DEFAULT_EXTRACTION_PROMPT,
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
} from "@ledgerly/shared/extractionPrompt";
import { DEFAULT_EMAIL_GATE, EMAIL_GATES } from "@ledgerly/shared/emailGate";
import type { EmailGate } from "@ledgerly/shared/emailGate";

import { SECRET_KEYS, SecretError, readSecret, readSecretMetadata } from "./secrets";

/**
 * packages/api/src/aiSettings.ts — how extraction is tuned, in one place
 * (D-47).
 *
 * Mirrors `backupSchedule.ts` 1:1, including the part worth saying out loud
 * again: **none of this is a secret.** It lives in the encrypted `app_config`
 * store because that table has exactly one storage format
 * (`value_encrypted bytea NOT NULL`), not because a model id needs protecting.
 * `describeAiSettings` returns every value in full, deliberately — an operator
 * has to be able to see what they set.
 *
 * ## Why these moved off the environment
 *
 * `AI_MODEL_PASS1`, `AI_MODEL_PASS2`, `AI_ESCALATE_BELOW` and `AI_CONCURRENCY`
 * were env-only, which meant changing a model was an `.env` edit plus a
 * container restart on a box the operator may not have a shell on. Worse, the
 * one setting that most wanted changing was invisible: D-12's 2026-09-10
 * amendment set both models to Sonnet 5, and `extract.ts` skips the ladder
 * entirely when `modelPass1 === modelPass2` — so the escalation path existed,
 * never ran, and the admin screen reported a 0% escalation rate that read as a
 * bug rather than as the configuration saying so.
 *
 * ## Resolution order, and which way it points
 *
 * `app_config` → environment → zod default, the same order and for the same
 * reason as `resolveAiKey`: **the stored value wins.** An operator who types a
 * setting into the admin screen and watches the environment silently override
 * it has no way to tell what went wrong. The environment as a bootstrap default
 * that the UI can supersede is explainable; the reverse is not.
 *
 * ## What takes effect when
 *
 * `worker.ts` resolves the API key per job already, so the models, the
 * threshold, the prompt and the rescan toggle ride along in that same per-job
 * read and go live immediately. **Concurrency does not**: BullMQ takes it in
 * the `Worker` constructor, which runs once at `startWorkers()`. The mutation
 * says so rather than pretending — the same honesty `applyBackupSchedule` uses
 * for a post-commit effect it cannot guarantee.
 */

/** Re-exported so server callers have one import; DEFINED in
 *  `packages/shared/src/emailGate.ts` beside the predicate that reads it, so
 *  the send path and the release path cannot drift apart again. */
export { DEFAULT_EMAIL_GATE, EMAIL_GATES, type EmailGate } from "@ledgerly/shared/emailGate";

export const aiSettingsSchema = z.object({
  modelPass1: z.string().trim().min(1).max(200).optional(),
  modelPass2: z.string().trim().min(1).max(200).optional(),
  escalateBelow: z.number().min(0).max(1).optional(),
  concurrency: z.number().int().min(1).max(32).optional(),
  /**
   * Re-read with the escalation model when the first reading comes back
   * needing review. Off would mean the ladder only ever climbs on low
   * confidence — which is the case D-12 already covers — so this is the new
   * half: a reading that is confident and still wrong.
   */
  rescanOnReview: z.boolean().optional(),
  emailGate: z.enum(EMAIL_GATES).optional(),
  /** An override for `DEFAULT_EXTRACTION_PROMPT`. Absent means "use the
   *  shipped one", which is how Revert works — it deletes rather than
   *  storing a copy, so a later improvement to the default reaches an
   *  instance that reverted. */
  prompt: z.string().min(MIN_PROMPT_CHARS).max(MAX_PROMPT_CHARS).optional(),
});

export type StoredAiSettings = z.infer<typeof aiSettingsSchema>;

/** Every value resolved — no optionals, because the caller needs a number, not
 *  a decision about where to get one. */
export type AiSettings = {
  modelPass1: string;
  modelPass2: string;
  escalateBelow: number;
  concurrency: number;
  rescanOnReview: boolean;
  emailGate: EmailGate;
  prompt: string;
  /** Whether `prompt` differs from the shipped default. Drives the
   *  "customised" chip and whether Revert is offered at all. */
  promptCustomised: boolean;
};

export type AiSettingsSource = "app_config" | "env" | "undecryptable";

export type AiSettingsEnvDefaults = {
  modelPass1: string;
  modelPass2: string;
  escalateBelow: number;
  concurrency: number;
};

export type ResolvedAiSettings = {
  settings: AiSettings;
  source: AiSettingsSource;
};

/** The defaults for settings with no environment variable behind them. Stated
 *  once so the resolve path and the admin screen cannot disagree. */
const RESCAN_ON_REVIEW_DEFAULT = true;
const EMAIL_GATE_DEFAULT: EmailGate = DEFAULT_EMAIL_GATE;

function merge(stored: StoredAiSettings | null, env: AiSettingsEnvDefaults): AiSettings {
  const prompt = stored?.prompt ?? DEFAULT_EXTRACTION_PROMPT;
  return {
    modelPass1: stored?.modelPass1 ?? env.modelPass1,
    modelPass2: stored?.modelPass2 ?? env.modelPass2,
    escalateBelow: stored?.escalateBelow ?? env.escalateBelow,
    concurrency: stored?.concurrency ?? env.concurrency,
    rescanOnReview: stored?.rescanOnReview ?? RESCAN_ON_REVIEW_DEFAULT,
    emailGate: stored?.emailGate ?? EMAIL_GATE_DEFAULT,
    prompt,
    promptCustomised: prompt !== DEFAULT_EXTRACTION_PROMPT,
  };
}

export async function resolveAiSettings(
  db: Database,
  masterKeyBase64: string,
  env: AiSettingsEnvDefaults,
): Promise<ResolvedAiSettings> {
  let stored: string | null;
  try {
    stored = await readSecret(db, SECRET_KEYS.aiSettings, masterKeyBase64);
  } catch (error) {
    if (error instanceof SecretError) {
      // Unreadable settings fall back to the environment rather than throwing.
      // This is the one place this module differs from `resolveAiKey`, which
      // deliberately does NOT fall through — and the reason is the blast
      // radius. An unreadable key means extracting with the wrong credential,
      // which must be surfaced, not papered over. Unreadable settings mean
      // extracting with the shipped defaults, which is exactly what a fresh
      // instance does anyway. Refusing to extract at all would be a worse
      // answer to "your MASTER_KEY rotated" than carrying on with defaults and
      // saying so on the admin screen.
      return { settings: merge(null, env), source: "undecryptable" };
    }
    throw error;
  }
  if (!stored) return { settings: merge(null, env), source: "env" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stored);
  } catch {
    return { settings: merge(null, env), source: "undecryptable" };
  }
  const parsed = aiSettingsSchema.safeParse(parsedJson);
  if (!parsed.success) return { settings: merge(null, env), source: "undecryptable" };
  return { settings: merge(parsed.data, env), source: "app_config" };
}

export type AiSettingsDescription = AiSettings & {
  source: AiSettingsSource;
  updatedAt: Date | null;
  updatedBy: string | null;
  /**
   * True when pass 1 and pass 2 are the same model.
   *
   * Surfaced rather than inferred in the UI because it is the condition that
   * silently disables both the confidence ladder and the review rescan —
   * `extract.ts` gates both on `modelPass2 !== modelPass1`. An admin looking
   * at a 0% escalation rate should be told why, not left to work it out.
   */
  ladderDisabled: boolean;
};

export async function describeAiSettings(
  db: Database,
  masterKeyBase64: string,
  env: AiSettingsEnvDefaults,
): Promise<AiSettingsDescription> {
  const { settings, source } = await resolveAiSettings(db, masterKeyBase64, env);
  const metadata =
    source === "app_config" ? await readSecretMetadata(db, SECRET_KEYS.aiSettings) : null;

  return {
    ...settings,
    source,
    updatedAt: metadata?.updatedAt ?? null,
    updatedBy: metadata?.updatedBy ?? null,
    ladderDisabled: settings.modelPass1 === settings.modelPass2,
  };
}

/** Serialises for `writeSecret`. One place, so the stored shape and the parse
 *  in `resolveAiSettings` cannot drift. */
export function serializeAiSettings(settings: StoredAiSettings): string {
  return JSON.stringify(settings);
}
