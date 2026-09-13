import "server-only";

import { z } from "zod";
import type { Database } from "@ledgerly/db";

import { SECRET_KEYS, SecretError, readSecret } from "./secrets";

/**
 * packages/api/src/logSettings.ts — how much the instance writes down (D-48).
 *
 * ## Why this is a switch rather than the default
 *
 * `app_events` exists to answer "why did nothing happen", and until now it only
 * recorded things that went WRONG — a skip, a failure, an unregistered
 * schedule. That is the right default: one row per failure is a log you can
 * read, and one row per step is a log you scroll past. But it cannot answer
 * "which model read this receipt, and why did it read it twice", which is the
 * question an operator actually has when a receipt comes out wrong and nothing
 * failed.
 *
 * So: off by default, and when on, every step of an extraction gets a row.
 *
 * ## Why a separate key from `ai_settings`
 *
 * It would fit in that blob and save a read. It is kept apart because it is
 * operated from a different screen by someone asking a different question —
 * you turn this on while diagnosing, and off again afterwards, without opening
 * the form that decides which model costs what. Folding it in would mean the
 * Logs tab had to submit the whole extraction config to change one boolean,
 * and a mis-submitted model id is a worse outcome than an extra indexed read.
 *
 * Resolution is `app_config` → off. No environment fallback: unlike a model id
 * there is no bootstrap problem to solve, and a second source would be a second
 * place to look when the log is quieter than expected.
 */

export const logSettingsSchema = z.object({
  /** Record the ordinary steps too, not just the failures. */
  verbose: z.boolean(),
});

export type LogSettings = z.infer<typeof logSettingsSchema>;

export const DEFAULT_LOG_SETTINGS: LogSettings = { verbose: false };

/**
 * Never throws, and degrades to OFF.
 *
 * Every caller is on a path that has already done the expensive thing — an
 * extraction that has been paid for, a user edit that has committed — so a
 * logging preference that cannot be read must not be allowed to affect any of
 * them. Quieter than requested is the safe direction; the alternative is a
 * settings row taking down the pipeline it describes.
 */
export async function resolveLogSettings(
  db: Database,
  masterKeyBase64: string,
): Promise<LogSettings> {
  try {
    const stored = await readSecret(db, SECRET_KEYS.logSettings, masterKeyBase64);
    if (!stored) return DEFAULT_LOG_SETTINGS;
    const parsed = logSettingsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : DEFAULT_LOG_SETTINGS;
  } catch (error) {
    if (!(error instanceof SecretError)) {
      console.error("[ledgerly] could not read the log settings:", error);
    }
    return DEFAULT_LOG_SETTINGS;
  }
}

export function serializeLogSettings(settings: LogSettings): string {
  return JSON.stringify(settings);
}
