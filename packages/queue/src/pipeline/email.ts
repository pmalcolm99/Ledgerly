import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";
import {
  categories,
  projectMembers,
  projects,
  receiptItems,
  receipts,
  users,
} from "@ledgerly/db/schema";
import type { Database } from "@ledgerly/db";
import { displayNameOf } from "@ledgerly/shared/personName";

import { renderEmailAttachment } from "./render";
import { renderReceiptEmail, type EmailReceiptData } from "./emailMessage";

/**
 * packages/queue/src/pipeline/email.ts — sending one receipt email (D-44).
 *
 * Mirrors `pipeline/extract.ts`'s shape: BullMQ-free, dependency-injected,
 * exported as one function the worker calls. The transport is injected for
 * the same reason the Anthropic client is — so the interesting failures can be
 * tested without a mail server.
 *
 * ## Why this is a separate queue and not part of extraction
 *
 * This is the decision that matters most in the whole feature.
 *
 * An inline send inside `processReceiptExtraction` would put a mail relay in
 * the retry path of a job that costs money. A relay hiccup would burn two more
 * PAID Anthropic calls on retry and then write `extraction_status='failed'` on
 * a receipt whose extraction actually succeeded — inverting the rule that file
 * is built around, that a receipt is never lost to a downstream failure.
 *
 * It is also enqueued strictly AFTER `processReceiptExtraction` returns, never
 * inside its persistence transaction: an email that succeeds against a
 * transaction that then rolls back is an email you cannot recall, describing
 * a receipt that does not exist.
 *
 * ## Why this loads its own data instead of calling `receipts.get`
 *
 * `receipts.get` is built around `scopedProjects(ctx.user, "read")`, and the
 * worker has no user. Threading a synthetic user through the scope helper to
 * reuse the procedure would FAKE an authorization decision — precisely what
 * CLAUDE.md's query-layer rule exists to prevent. The worker's authority is
 * the project's own `email_receipts` setting and, for an on-demand send, the
 * membership check below; both are checked here, explicitly, rather than
 * borrowed from a helper that means something else.
 *
 * ## Recipients are user ids, never addresses
 *
 * Job data carries `toUserId`, not an email address, and this module resolves
 * the address after re-checking project membership. An arbitrary destination
 * is therefore unrepresentable rather than merely unvalidated: there is no
 * field in which one could be supplied. The tRPC procedure checks membership
 * too — this is the second check, and the one that holds if a job is ever
 * enqueued from somewhere else.
 */

/** What `nodemailer`'s transport provides, narrowed to what is used. Declared
 *  structurally so this module never imports nodemailer — the credential-
 *  consuming client stays in `emailWorker.ts`, the one file that builds it. */
export type EmailTransport = {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    attachments: { filename: string; content: Buffer; contentType: string }[];
  }): Promise<unknown>;
};

export type EmailJobData =
  | { receiptId: string; reason: "auto" }
  | { receiptId: string; reason: "on_demand"; toUserId: string; requestedBy: string };

export type EmailDeps = {
  db: Database;
  transport: EmailTransport | null;
  from: { address: string; name: string };
  uploadsDir: string;
  maxMegapixels: number;
  /** `https://receipts.example.com`, or null when no usable hostname is set. */
  appOrigin: string | null;
};

/** Mirrors `ExtractError` (`pipeline/extract.ts`): a stable reason code, and
 *  whether retrying could possibly help. A missing SMTP config is not a
 *  transient condition; a relay timing out is. */
export class EmailError extends Error {
  readonly retryable: boolean;
  readonly reason: string;

  constructor(reason: string, opts: { retryable?: boolean } = {}) {
    super(reason);
    this.name = "EmailError";
    this.retryable = opts.retryable ?? true;
    this.reason = reason;
  }
}

export type EmailOutcome =
  | { sent: true; to: string }
  /** Not a failure. The project has the setting off, the automatic email has
   *  already gone, or the receipt is gone — all normal, all worth naming so a
   *  log line says which. */
  | { sent: false; skipped: string };

type LoadedReceipt = NonNullable<Awaited<ReturnType<typeof loadReceiptForEmail>>>;

/**
 * Everything one email needs, in two queries.
 *
 * Standalone rather than a call into `packages/api`'s router — see the header.
 * Soft-deleted receipts and projects are excluded here rather than in the
 * caller, so there is no path through this module that emails a deleted
 * receipt.
 */
export async function loadReceiptForEmail(db: Database, receiptId: string) {
  const [row] = await db
    .select({
      receipt: receipts,
      projectName: projects.name,
      projectId: projects.id,
      projectOwnerId: projects.ownerId,
      emailReceipts: projects.emailReceipts,
    })
    .from(receipts)
    .innerJoin(projects, eq(projects.id, receipts.projectId))
    .where(and(eq(receipts.id, receiptId), isNull(receipts.deletedAt), isNull(projects.deletedAt)))
    .limit(1);
  if (!row) return null;

  const items = await db
    .select({
      description: receiptItems.description,
      quantity: receiptItems.quantity,
      unitPrice: receiptItems.unitPrice,
      lineTotal: receiptItems.lineTotal,
      categoryName: categories.name,
    })
    .from(receiptItems)
    .leftJoin(categories, eq(categories.id, receiptItems.categoryId))
    .where(eq(receiptItems.receiptId, receiptId))
    .orderBy(asc(receiptItems.lineNo));

  return { ...row, items };
}

/**
 * The address to send to, having re-established that the recipient may see
 * this project at all.
 *
 * The owner is authorised by owning the project, checked first and
 * independently of `project_members` — `projects.create` does insert an owner
 * row there, but ownership is authority in its own right (`scope.ts`
 * short-circuits on it) and this must not depend on that row still existing.
 * Everyone else must have one. A user removed from the project between the
 * request and the job running therefore does not receive the email, which is
 * the correct outcome and the reason this check lives here rather than only in
 * the procedure that enqueued.
 */
async function resolveRecipient(
  db: Database,
  loaded: LoadedReceipt,
  data: EmailJobData,
): Promise<{ address: string; name: string } | null> {
  const userId = data.reason === "auto" ? loaded.projectOwnerId : data.toUserId;

  if (userId !== loaded.projectOwnerId) {
    const [membership] = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, loaded.projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    if (!membership) return null;
  }

  const [user] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  return { address: user.email, name: displayNameOf(user) };
}

/** `"Ledgerly" <receipts@example.com>`. Built here rather than stored as one
 *  free-text field, because a relay rejects a From header it cannot parse and
 *  that is exactly where hand-assembled ones go wrong.
 *
 *  Quotes, backslashes and control characters are stripped from the display
 *  name. It is operator-supplied rather than model output, so this is belt and
 *  braces — but a From header is not the place to find out that an operator
 *  pasted something with a newline in it. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const HEADER_UNSAFE = /[\u0000-\u001f\u007f]+/g;

function formatFrom(from: { address: string; name: string }): string {
  const name = from.name.replace(/["\\]/g, "").replace(HEADER_UNSAFE, " ").trim();
  if (!name) return from.address;
  return `"${name}" <${from.address}>`;
}

export async function processReceiptEmail(
  deps: EmailDeps,
  data: EmailJobData,
): Promise<EmailOutcome> {
  const loaded = await loadReceiptForEmail(deps.db, data.receiptId);
  if (!loaded) return { sent: false, skipped: "receipt_not_found" };

  if (data.reason === "auto") {
    // The project's setting is the worker's entire authority for an automatic
    // send, so it is read at SEND time, not at enqueue time: turning the
    // setting off must stop mail that is already queued.
    if (!loaded.emailReceipts) return { sent: false, skipped: "project_setting_off" };
    // The once-only marker. `receipts.reextract` re-enters the persistence
    // path, so without this every manual re-extract would send again.
    if (loaded.receipt.receiptEmailSentAt) return { sent: false, skipped: "already_sent" };
  }

  if (!deps.transport) {
    // Non-retryable: no amount of backoff produces an SMTP config. The receipt
    // itself is untouched — this is a notification, not the record.
    throw new EmailError("SMTP_NOT_CONFIGURED", { retryable: false });
  }

  const recipient = await resolveRecipient(deps.db, loaded, data);
  if (!recipient) return { sent: false, skipped: "recipient_not_a_member" };

  if (!loaded.receipt.imageKey) {
    // Ingest has not finished, so there is no render to attach. Retryable: the
    // render usually appears seconds later.
    throw new EmailError("RECEIPT_RENDER_MISSING");
  }

  const attachment = await renderEmailAttachment({
    uploadsDir: deps.uploadsDir,
    projectId: loaded.projectId,
    receiptId: loaded.receipt.id,
    maxMegapixels: deps.maxMegapixels,
  });

  const message: EmailReceiptData = {
    projectName: loaded.projectName,
    merchantName: loaded.receipt.merchantName,
    transactionDate: loaded.receipt.transactionDate,
    transactionTime: loaded.receipt.transactionTime,
    subtotal: loaded.receipt.subtotal,
    salesTax: loaded.receipt.salesTax,
    tip: loaded.receipt.tip,
    total: loaded.receipt.total,
    currency: loaded.receipt.currency,
    paymentMethod: loaded.receipt.paymentMethod,
    cardLast4: loaded.receipt.cardLast4,
    items: loaded.items,
    missingFields: loaded.receipt.missingFields,
    validationFlags: loaded.receipt.validationFlags,
    receiptUrl: deps.appOrigin ? `${deps.appOrigin}/receipts/${loaded.receipt.id}` : null,
  };
  const rendered = renderReceiptEmail(message);

  try {
    await deps.transport.sendMail({
      from: formatFrom(deps.from),
      to: recipient.address,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      attachments: [
        {
          // Named from the receipt id, not the merchant: a merchant name is
          // model output off a photograph and has no business becoming a
          // filename in someone's Downloads folder.
          filename: `receipt-${loaded.receipt.id}.jpg`,
          content: attachment,
          contentType: "image/jpeg",
        },
      ],
    });
  } catch (error) {
    // The relay's own message is the diagnosis and belongs in the log; it must
    // not become the reason code, which is matched on.
    console.error(`[ledgerly] receipt email failed receipt=${loaded.receipt.id}:`, error);
    throw new EmailError("SMTP_SEND_FAILED");
  }

  if (data.reason === "auto") {
    // Written AFTER the send, so a failure to send retries rather than being
    // suppressed by a marker for an email that never went. The cost of that
    // ordering is a possible duplicate if the process dies between the two,
    // and a duplicate notification is a far better failure than a silent one.
    //
    // But the write itself must NOT be allowed to throw, and that is a
    // different point. Letting it propagate makes the whole job retryable
    // AFTER a successful send, and the retry re-reads a marker that is still
    // null — so a database that is briefly unhappy (pool saturation while
    // several extractions land at once, which is exactly when these fire)
    // turns one delivered message into up to five. Swallowing it caps the
    // damage at one possible duplicate on some later re-extract, which is the
    // same failure the paragraph above already accepts.
    try {
      await deps.db
        .update(receipts)
        .set({ receiptEmailSentAt: new Date() })
        .where(eq(receipts.id, loaded.receipt.id));
    } catch (error) {
      console.error(
        `[ledgerly] receipt email sent but the once-only marker could not be written ` +
          `receipt=${loaded.receipt.id} — a re-extract may send a duplicate:`,
        error,
      );
    }
  }

  return { sent: true, to: recipient.address };
}
