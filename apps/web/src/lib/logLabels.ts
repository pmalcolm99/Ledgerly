/**
 * apps/web/src/lib/logLabels.ts — turning a log row into a sentence.
 *
 * The sibling of `receiptLabels.ts`, and the reason `app_events.event` stores a
 * stable code rather than prose: the wording lives here, where it can be
 * improved without a migration and where it cannot drift from the metadata
 * beside it.
 *
 * **An unrecognised code is rendered, not hidden.** A log that silently drops
 * what it does not understand is not a log — it is a log with a blind spot
 * exactly where a new, unfamiliar failure would appear. Unknown codes fall
 * through to the raw code plus their metadata.
 */

type Meta = Record<string, unknown>;

function str(meta: Meta, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(meta: Meta, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" ? value : null;
}

function mb(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Why an email did not arrive, in the words someone would use.
 *
 * These are the reason codes `pipeline/email.ts` returns, and between them they
 * answer the question this whole feature exists for. "project_setting_off" in
 * particular is the one that would have saved a side-by-side debugging session.
 */
const EMAIL_SKIP: Record<string, string> = {
  receipt_not_found: "the receipt no longer exists",
  project_setting_off: "receipt emails are turned off for that project",
  already_sent: "it had already been sent once",
  recipient_not_a_member: "the recipient is not a member of that project",
};

const EMAIL_FAILURE: Record<string, string> = {
  SMTP_NOT_CONFIGURED: "no SMTP settings are configured",
  SMTP_UNDECRYPTABLE: "the stored SMTP settings cannot be decrypted",
  SMTP_SEND_FAILED: "the relay rejected it",
  RECEIPT_RENDER_MISSING: "the receipt image was not ready",
  EMAIL_SEND_FAILED: "an unclassified send failure",
};

export type LogRow = {
  source: "activity" | "system";
  event: string;
  metadata: Meta;
  actorName: string | null;
};

/** The one-line sentence. Never ends in a full stop — these read as list rows,
 *  not paragraphs. */
export function logLabel(row: LogRow): string {
  const m = row.metadata;
  const who = row.actorName ?? "Someone";

  switch (row.event) {
    // --- email, the reason this feature exists -------------------------
    case "email.sent": {
      const trigger = str(m, "reason") === "auto" ? "automatically" : "on request";
      return `Receipt email sent ${trigger}`;
    }
    case "email.skipped":
      return `Receipt email not sent — ${EMAIL_SKIP[str(m, "reason") ?? ""] ?? str(m, "reason") ?? "unknown reason"}`;
    case "email.gave_up":
      return `Receipt email failed — ${EMAIL_FAILURE[str(m, "reason") ?? ""] ?? str(m, "reason") ?? "unknown reason"}`;
    case "email.enqueue_failed":
      return "Receipt email could not be queued, so it was never attempted";

    // --- extraction ----------------------------------------------------
    case "extraction.failed":
      return `Could not read a receipt — ${str(m, "reason") ?? "unknown reason"}`;
    case "extraction.status_write_failed":
      return "Could not record an extraction failure — the receipt may be stuck as pending";

    // --- backup --------------------------------------------------------
    case "backup.complete": {
      const size = mb(num(m, "sizeBytes"));
      const images = num(m, "images");
      const parts = [size, images ? `${images} images` : null].filter(Boolean);
      return `Backup complete${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
    }
    case "backup.failed":
      return `Backup failed — ${str(m, "reason") ?? "unknown reason"}`;
    case "backup.interrupted":
      return `${num(m, "count") ?? "Some"} backups were interrupted by a restart`;
    case "backup.schedule_unregistered":
      return str(m, "source") === "undecryptable"
        ? "No scheduled backup is running — the saved schedule cannot be decrypted"
        : "No scheduled backup is running";

    // --- system --------------------------------------------------------
    case "system.internal_error":
      return `Server error in ${str(m, "path") ?? "an unknown call"} — ${str(m, "message") ?? str(m, "code") ?? "no detail"}`;

    // --- upload --------------------------------------------------------
    case "upload.persist_failed":
      return `Could not save an uploaded file${str(m, "filename") ? ` (${str(m, "filename")})` : ""} — ${str(m, "error") ?? "unknown reason"}`;
    case "upload.status_write_failed":
      return "An upload failed and could not be marked failed — the receipt may be stuck as pending";

    // --- audit rows, i.e. things a person did --------------------------
    case "receipt.updated":
      return `${who} edited a receipt`;
    case "receipt.deleted":
      return `${who} deleted a receipt`;
    case "receipt.reextract_requested":
      return `${who} asked for a receipt to be read again`;
    case "receipt.email_requested":
      return `${who} emailed a receipt`;
    case "receipt.field_dismissed":
      return `${who} marked ${str(m, "field") ?? "a field"} as genuinely blank`;
    case "receipt.field_undismissed":
      return `${who} undid a dismissed field`;
    case "receipt.flag_acknowledged":
      return `${who} accepted a warning on a receipt (${str(m, "flag") ?? "unknown"})`;
    case "receipt.flag_unacknowledged":
      return `${who} undid an accepted warning`;
    case "project.created":
      return `${who} created a project`;
    case "project.updated":
      return `${who} edited a project`;
    case "project.archived":
      return `${who} archived a project`;
    case "project.unarchived":
      return `${who} unarchived a project`;
    case "project.deleted":
      return `${who} deleted a project`;
    case "project.email_receipts_on":
      return `${who} turned receipt emails ON for a project`;
    case "project.email_receipts_off":
      return `${who} turned receipt emails OFF for a project`;
    case "owner_override.performed":
      return `${who} used instance-owner override on a project they are not a member of`;
    case "member.permission_granted":
      return `${who} added a member`;
    case "member.permission_changed":
      return `${who} changed a member's permission`;
    case "member.removed":
      return `${who} removed a member`;
    case "category.created":
      return `${who} created a category`;
    case "category.updated":
      return `${who} renamed a category`;
    case "category.deleted":
      return `${who} deleted a category`;
    case "receipt_item.created":
      return `${who} added a line item`;
    case "receipt_item.updated":
      return `${who} edited a line item`;
    case "receipt_item.deleted":
      return `${who} deleted a line item`;
    case "export.generated":
      return `${who} exported a project`;
    case "backup.requested":
      return `${who} started a backup`;
    case "backup.downloaded":
      return `${who} downloaded a backup`;
    case "app_config.updated":
      return `${who} changed a setting (${settingName(str(m, "key"))})`;
    case "app_config.cleared":
      return `${who} cleared a setting (${settingName(str(m, "key"))})`;
    case "user.sub_relinked":
      return `${who} re-linked an account to a new identity`;
    case "user.identity_conflict":
      return "Someone signed in with an identity that conflicts with an existing account";
    case "instance.owner_elected":
      return "The instance owner was elected on first sign-in";

    default:
      // Deliberately not "Unknown event". The code is the most useful thing
      // available, and hiding it would hide exactly the new failure a reader
      // is most likely to be looking for.
      return row.event;
  }
}

/** `app_config` keys are opaque strings; these are the three that exist. */
function settingName(key: string | null): string {
  switch (key) {
    case "anthropic_api_key":
      return "Claude API key";
    case "smtp_config":
      return "email settings";
    case "backup_schedule":
      return "backup schedule";
    default:
      return key ?? "unknown";
  }
}

/** Colour for the row's dot. Audit rows have no level — they are neither good
 *  nor bad news, they are a record. */
export function levelColor(level: string | null): string {
  switch (level) {
    case "error":
      return "bg-danger";
    case "warn":
      return "bg-warning";
    case "info":
      return "bg-success";
    default:
      return "bg-default-300";
  }
}
