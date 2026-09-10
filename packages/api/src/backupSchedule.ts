import "server-only";

import { parseExpression } from "cron-parser";
import { z } from "zod";
import type { Database } from "@ledgerly/db";

import { SECRET_KEYS, SecretError, readSecret, readSecretMetadata } from "./secrets";

/**
 * packages/api/src/backupSchedule.ts — where the nightly backup's cron comes
 * from (task 9.3, D-45).
 *
 * Mirrors `smtp.ts` 1:1, for the same reasons, with one difference worth
 * naming rather than leaving implicit: **a cron string is not a secret.** It
 * lives in the encrypted `app_config` store because that is the store's only
 * format (`value_encrypted bytea NOT NULL`, docs/SCHEMA.md §app_config), not
 * because it needs protecting. Nothing here should be read as claiming
 * otherwise, and nothing about the schedule needs the write-only treatment the
 * SMTP password gets — `describeBackupSchedule` returns the cron in full,
 * deliberately, because an operator has to be able to see what they set.
 *
 * There is **no environment fallback** (D-45). The Claude key has one because a
 * fresh instance must be able to extract before anyone visits the admin
 * screen; a schedule has no equivalent bootstrap problem, and a second source
 * would be a second place to look when backups are not happening.
 *
 * **`undecryptable` is a first-class state**, exactly as in `smtp.ts`. Rotate
 * `MASTER_KEY`, or restore a dump onto an instance holding a different one, and
 * this row becomes ciphertext nobody can read. Reporting that as "no schedule
 * configured" would be the specific failure this phase exists to prevent: the
 * admin screen quietly wrong about whether backups are running.
 */

export const backupScheduleSchema = z.object({
  /**
   * A 5- or 6-field cron pattern, evaluated in the CONTAINER's timezone — UTC
   * unless `TZ` is set in the environment. Worth knowing before wondering why
   * a "3am" backup ran at 8pm.
   */
  cron: z.string().trim().min(1).max(120),
});

export type BackupSchedule = z.infer<typeof backupScheduleSchema>;

export type BackupScheduleSource = "app_config" | "none" | "undecryptable";

export type ResolvedBackupSchedule = {
  schedule: BackupSchedule | null;
  source: BackupScheduleSource;
};

export async function resolveBackupSchedule(
  db: Database,
  masterKeyBase64: string,
): Promise<ResolvedBackupSchedule> {
  let stored: string | null;
  try {
    stored = await readSecret(db, SECRET_KEYS.backupSchedule, masterKeyBase64);
  } catch (error) {
    if (error instanceof SecretError) return { schedule: null, source: "undecryptable" };
    throw error;
  }
  if (!stored) return { schedule: null, source: "none" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stored);
  } catch {
    return { schedule: null, source: "undecryptable" };
  }
  const parsed = backupScheduleSchema.safeParse(parsedJson);
  // A row that decrypts but no longer parses is reported the same way, because
  // from the operator's seat both mean "the stored value is unusable, replace
  // it" — and the screen that replaces it must stay reachable either way.
  if (!parsed.success) return { schedule: null, source: "undecryptable" };
  // A pattern that was valid when written but is not now (a cron-parser upgrade
  // tightening its rules) must not silently become "no schedule". Same
  // treatment: unusable, say so, offer the form.
  if (!validateCron(parsed.data.cron).ok) return { schedule: null, source: "undecryptable" };
  return { schedule: parsed.data, source: "app_config" };
}

export type BackupScheduleDescription = {
  source: BackupScheduleSource;
  cron: string | null;
  /** Computed from the cron, NOT read from Redis. `admin.backupStatus` reports
   *  the scheduler's own next-fire time separately, and the two disagreeing is
   *  the interesting case — see that procedure. */
  nextRunAt: Date | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export async function describeBackupSchedule(
  db: Database,
  masterKeyBase64: string,
): Promise<BackupScheduleDescription> {
  const { schedule, source } = await resolveBackupSchedule(db, masterKeyBase64);
  const metadata =
    source === "app_config" ? await readSecretMetadata(db, SECRET_KEYS.backupSchedule) : null;
  const validated = schedule ? validateCron(schedule.cron) : null;

  return {
    source,
    cron: schedule?.cron ?? null,
    nextRunAt: validated?.ok ? validated.next : null,
    updatedAt: metadata?.updatedAt ?? null,
    updatedBy: metadata?.updatedBy ?? null,
  };
}

/** Serialises for `writeSecret`. One place, so the stored shape and the parse
 *  in `resolveBackupSchedule` cannot drift. */
export function serializeBackupSchedule(schedule: BackupSchedule): string {
  return JSON.stringify(schedule);
}

/**
 * Validates a cron pattern and, as a byproduct, says when it would next fire.
 *
 * Done here rather than by letting `upsertJobScheduler` throw, because the
 * write to `app_config` happens first: a pattern BullMQ rejects would otherwise
 * be persisted as the configured schedule while no scheduler exists to run it
 * — a stored intention with no effect, which is the shape of every silent
 * backup failure.
 *
 * The explicit field count is not redundant. `cron-parser` accepts a 4-field
 * pattern by padding it, so `0 3 * *` parses to something — just not to
 * anything the person typing it meant. Refusing is kinder than scheduling a
 * guess.
 */
export function validateCron(
  cron: string,
): { ok: true; next: Date } | { ok: false; message: string } {
  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length < 5 || fields.length > 6) {
    return {
      ok: false,
      message: "A cron schedule needs 5 fields (minute hour day month weekday), or 6 with seconds.",
    };
  }
  try {
    return { ok: true, next: parseExpression(trimmed).next().toDate() };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `Not a valid cron schedule: ${error.message}`
          : "Not a valid cron schedule.",
    };
  }
}
