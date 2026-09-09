import "server-only";

import { z } from "zod";
import type { Database } from "@ledgerly/db";

import { SECRET_KEYS, SecretError, readSecret, readSecretMetadata } from "./secrets";

/**
 * packages/api/src/smtp.ts — where the SMTP settings come from (D-44).
 *
 * Mirrors `aiKey.ts` deliberately, including the parts that look like
 * over-engineering until the day they are not:
 *
 * - There is **no environment fallback**. The Claude key has one because a
 *   fresh instance must be able to extract before anyone visits the admin
 *   screen. Email has no such bootstrap problem — an instance with no SMTP
 *   config simply does not send email — so adding a second source would be
 *   two places to look and nothing gained.
 * - **`undecryptable` is a real state.** Rotate `MASTER_KEY`, or restore a
 *   dump onto an instance with a different one, and the stored row is
 *   ciphertext nobody can read. Reporting that as "not configured" would send
 *   an operator hunting for a setting that is right there, and would make the
 *   admin screen quietly wrong about the state of the system.
 *
 * ## The password never leaves this package
 *
 * `SmtpConfig` (with the password) is what the queue's transport needs.
 * `SmtpDescription` (without it, and with no field capable of holding it) is
 * what a tRPC procedure may return. That is the same by-construction
 * protection `AiKeyDescription` gets, for the same reason: a later edit
 * cannot leak a secret through a type that has nowhere to put one.
 */

/**
 * What a relay needs. Modelled on smtp2go/Postmark/SES-SMTP, which is the
 * shape this instance actually uses — not on a general-purpose mail library's
 * full option surface.
 *
 * `fromName` is separate from `fromAddress` because relays reject a From
 * header they cannot parse, and building `"Name" <addr>` in one free-text
 * field is exactly where that goes wrong.
 */
export const smtpConfigSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /**
   * Implicit TLS (port 465) vs STARTTLS (587/25). Named `secure` to match
   * what every SMTP client calls it; it does NOT mean "unencrypted when
   * false" — a STARTTLS connection on 587 is still encrypted, it just
   * negotiates after connecting.
   */
  secure: z.boolean(),
  user: z.string().trim().max(255),
  password: z.string().max(512),
  fromAddress: z.string().trim().email().max(320),
  fromName: z.string().trim().max(120),
});

export type SmtpConfig = z.infer<typeof smtpConfigSchema>;

export type SmtpSource = "app_config" | "none" | "undecryptable";

export type ResolvedSmtp = {
  /** Carries the password. Never returned over tRPC, never logged. */
  config: SmtpConfig | null;
  source: SmtpSource;
};

/**
 * Resolves the config for actual use — sending, or a connection test.
 *
 * The plaintext in the return value is why this must never be called from a
 * procedure that returns its result. Use `describeSmtpConfig` for anything
 * user-facing.
 *
 * A row that decrypts but no longer parses (a config written by an older
 * version whose shape has since changed) is reported as `undecryptable`
 * rather than thrown: from the operator's seat both mean "the stored row is
 * unusable, replace it", and the admin screen must stay reachable either way.
 */
export async function resolveSmtpConfig(
  db: Database,
  masterKeyBase64: string,
): Promise<ResolvedSmtp> {
  let stored: string | null;
  try {
    stored = await readSecret(db, SECRET_KEYS.smtp, masterKeyBase64);
  } catch (error) {
    if (error instanceof SecretError) return { config: null, source: "undecryptable" };
    throw error;
  }
  if (!stored) return { config: null, source: "none" };

  const parsed = smtpConfigSchema.safeParse(JSON.parse(stored) as unknown);
  if (!parsed.success) return { config: null, source: "undecryptable" };
  return { config: parsed.data, source: "app_config" };
}

/**
 * The user-facing description. Every non-secret field, plus a HINT of the
 * password — never the password.
 *
 * There is no `password` field on this type at all, which is the mechanism.
 */
export type SmtpDescription = {
  source: SmtpSource;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  user: string | null;
  fromAddress: string | null;
  fromName: string | null;
  /**
   * The LENGTH ONLY — deliberately not `secrets.ts`'s `secretHint`.
   *
   * That helper returns the last four characters above a 12-character floor,
   * and its docblock argues the case for a 100-plus character Anthropic key,
   * where four characters is negligible. SMTP relay passwords are routinely
   * 12-20 characters, so the same rule would disclose a quarter to a third of
   * the secret to everything that sees this response — React Query's cache,
   * devtools, a browser extension. The hint only has to answer "is one
   * stored", and a length answers that.
   */
  passwordHint: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};

export async function describeSmtpConfig(
  db: Database,
  masterKeyBase64: string,
): Promise<SmtpDescription> {
  const { config, source } = await resolveSmtpConfig(db, masterKeyBase64);
  const metadata = source === "app_config" ? await readSecretMetadata(db, SECRET_KEYS.smtp) : null;

  return {
    source,
    host: config?.host ?? null,
    port: config?.port ?? null,
    secure: config?.secure ?? null,
    user: config?.user ?? null,
    fromAddress: config?.fromAddress ?? null,
    fromName: config?.fromName ?? null,
    passwordHint: config?.password ? `${config.password.length} characters` : null,
    updatedAt: metadata?.updatedAt ?? null,
    updatedBy: metadata?.updatedBy ?? null,
  };
}

/** Serialises a config for `writeSecret`. One place, so the stored shape and
 *  the parse in `resolveSmtpConfig` cannot drift apart. */
export function serializeSmtpConfig(config: SmtpConfig): string {
  return JSON.stringify(config);
}

/**
 * Merges a submitted patch onto the stored config.
 *
 * Exists for one reason: the password is write-only, so the admin form cannot
 * round-trip it. Submitting the form with the password box left blank must
 * mean "keep the stored password", not "set the password to empty string" —
 * otherwise editing the port silently breaks authentication.
 */
export function mergeSmtpConfig(
  existing: SmtpConfig | null,
  patch: Omit<SmtpConfig, "password"> & { password?: string },
): { ok: true; config: SmtpConfig } | { ok: false; message: string } {
  const password = patch.password ?? existing?.password ?? "";
  if (patch.user.length > 0 && password.length === 0) {
    return {
      ok: false,
      message: "This server needs a password to go with that username.",
    };
  }
  const parsed = smtpConfigSchema.safeParse({ ...patch, password });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Those settings are invalid." };
  }
  return { ok: true, config: parsed.data };
}
