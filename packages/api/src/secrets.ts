import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { appConfig } from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";

import type { Tx } from "./audit";

/**
 * packages/api/src/secrets.ts — the encrypted `app_config` store.
 *
 * `docs/SCHEMA.md` §app_config specifies `value_encrypted bytea NOT NULL`,
 * keyed with `MASTER_KEY`, and states the property that makes it worth having
 * at all: **the archive alone cannot decrypt it**. `MASTER_KEY` lives in the
 * environment and is backed up out-of-band (ARCHITECTURE.md §8.3), so a
 * stolen `pg_dump` yields ciphertext and nothing else. This is the first
 * module to actually write to that table.
 *
 * ## Format
 *
 * AES-256-GCM. The stored blob is `version || iv || tag || ciphertext`:
 *
 *   byte  0        format version (1)
 *   bytes 1..12    96-bit IV, fresh random per write
 *   bytes 13..28   128-bit GCM auth tag
 *   bytes 29..     ciphertext
 *
 * GCM rather than CBC because it is authenticated: a tampered row fails to
 * decrypt rather than yielding attacker-influenced plaintext that then gets
 * used as an API key. The version byte is there so a future key rotation or
 * cipher change can be told apart from corruption instead of guessed at.
 *
 * A fresh random IV per write is not optional — GCM catastrophically loses
 * confidentiality and integrity if an IV is ever reused under the same key.
 *
 * ## What must never happen
 *
 * A decrypted secret must never reach a tRPC return value, a log line, or an
 * error message (CLAUDE.md's hard rule for `ANTHROPIC_API_KEY`). Nothing in
 * this file logs, and `secretHint` below is the only thing callers should put
 * in front of a user.
 */

const FORMAT_VERSION = 1;
const VERSION_AAD = Buffer.from([FORMAT_VERSION]);
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** The `app_config.key` values this app understands. A closed union rather
 *  than free text so a typo is a type error, not a silently-ignored setting. */
export const SECRET_KEYS = {
  anthropicApiKey: "anthropic_api_key",
  /** Phase 9 (D-44). The WHOLE SMTP config as one encrypted JSON blob, not a
   *  password column beside plaintext host/port/user fields. One read, one
   *  decrypt, one atomic write — and no field of it can be left in the clear
   *  by someone adding a column later, because there are no columns. */
  smtp: "smtp_config",
  /**
   * Phase 9 (D-45). The nightly backup's cron pattern.
   *
   * Not a secret, and this is the one member of this union that isn't. It
   * lives here because `app_config` has exactly one storage format and no
   * plaintext column — adding one would be a migration and a second code path
   * through this file to hold a value nobody needs protected. The consequence
   * is real and is handled rather than ignored: a rotated `MASTER_KEY` makes
   * the schedule unreadable, so `backupSchedule.ts` treats `undecryptable` as
   * a first-class state and the admin card says so out loud instead of
   * reporting "no schedule".
   */
  backupSchedule: "backup_schedule",
} as const;
export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

function masterKeyBytes(masterKeyBase64: string): Buffer {
  const key = Buffer.from(masterKeyBase64, "base64");
  // `packages/config` already asserts this at startup (D-14); re-asserted
  // here so the invariant holds for any caller, including a test that builds
  // its own key.
  if (key.length !== 32) {
    throw new SecretError("MASTER_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encryptSecret(plaintext: string, masterKeyBase64: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKeyBytes(masterKeyBase64), iv);
  // The version byte is additional authenticated data, so it is covered by
  // the tag. Without this it is the one field an attacker with DB write
  // access could change freely — and the moment a version 2 exists with
  // different parameters, flipping it back to 1 is a downgrade attack.
  // Free to do now, impossible to retrofit once rows exist in the wild.
  cipher.setAAD(VERSION_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([VERSION_AAD, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(payload: Buffer, masterKeyBase64: string): string {
  if (payload.length < HEADER_BYTES) {
    throw new SecretError("stored secret is truncated");
  }
  if (payload[0] !== FORMAT_VERSION) {
    throw new SecretError(`unsupported stored secret format: ${payload[0]}`);
  }
  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = payload.subarray(HEADER_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", masterKeyBytes(masterKeyBase64), iv);
  decipher.setAAD(payload.subarray(0, 1));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // The underlying error is an opaque "unable to authenticate data"; the
    // useful information for an operator is WHICH of the two causes it is,
    // and we cannot distinguish them, so say both rather than either.
    throw new SecretError(
      "stored secret could not be decrypted — MASTER_KEY has changed, or the row was tampered with",
    );
  }
}

/** Reads and decrypts one secret. `null` when the row does not exist; throws
 *  only when a row exists but cannot be decrypted, which is a real operator
 *  problem that must not be silently swallowed into "not configured". */
export async function readSecret(
  db: Database,
  key: SecretKey,
  masterKeyBase64: string,
): Promise<string | null> {
  const [row] = await db
    .select({ value: appConfig.valueEncrypted })
    .from(appConfig)
    .where(eq(appConfig.key, key))
    .limit(1);
  if (!row) return null;
  return decryptSecret(row.value, masterKeyBase64);
}

export type SecretMetadata = {
  updatedAt: Date;
  updatedBy: string | null;
};

/**
 * The non-secret facts about a stored secret, safe to return to an admin
 * screen.
 *
 * Note what this does NOT buy: `describeAiKey` still calls `readSecret` in
 * order to compute a four-character hint, so the UI request does hold the
 * plaintext in memory for the length of the call. The protection against
 * leaking it is that `AiKeyDescription` has no field capable of carrying it,
 * not that the plaintext was never fetched. Storing the hint as its own
 * column would make the stronger claim true; it is not worth a migration for
 * a value that never leaves the process.
 */
export async function readSecretMetadata(
  db: Database,
  key: SecretKey,
): Promise<SecretMetadata | null> {
  const [row] = await db
    .select({ updatedAt: appConfig.updatedAt, updatedBy: appConfig.updatedBy })
    .from(appConfig)
    .where(eq(appConfig.key, key))
    .limit(1);
  return row ?? null;
}

/** Upserts a secret. Takes a `Tx` so the write and its `audit_log` row share
 *  one transaction, per `audit.ts`'s contract. */
export async function writeSecret(
  tx: Tx,
  key: SecretKey,
  plaintext: string,
  masterKeyBase64: string,
  userId: string,
): Promise<void> {
  const valueEncrypted = encryptSecret(plaintext, masterKeyBase64);
  await tx
    .insert(appConfig)
    .values({ key, valueEncrypted, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { valueEncrypted, updatedBy: userId, updatedAt: new Date() },
    });
}

/** Removes a secret. Returns whether a row actually existed, so a caller can
 *  avoid auditing a clear that cleared nothing. */
export async function deleteSecret(tx: Tx, key: SecretKey): Promise<boolean> {
  const removed = await tx
    .delete(appConfig)
    .where(eq(appConfig.key, key))
    .returning({ key: appConfig.key });
  return removed.length > 0;
}

/**
 * The only representation of a secret that may be shown to a user: the last
 * four characters, plus how long it is.
 *
 * Four characters of a 100-plus character key is the same disclosure a card's
 * `last4` makes, and it is what lets an operator tell "the key I pasted" from
 * "some other key" without the value ever leaving the server whole. Short
 * values get no tail at all, because four characters of a short secret is a
 * meaningful fraction of it.
 */
export function secretHint(plaintext: string): string {
  if (plaintext.length < 12) return `${plaintext.length} characters`;
  return `…${plaintext.slice(-4)} (${plaintext.length} characters)`;
}
