import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { formatQuantityDisplay } from "@ledgerly/shared/numeric";

/**
 * packages/queue/src/pipeline/emailMessage.ts — the receipt email's subject
 * and body (D-44).
 *
 * Pure. No database, no transport, no BullMQ, no `server-only` — it takes a
 * plain object and returns strings, which is what makes the interesting cases
 * (a merchant that could not be read, an uncategorised item, a receipt with
 * no line items at all) testable without a mail server or a Postgres.
 *
 * ## Every field is nullable, and that is the normal case
 *
 * CLAUDE.md's rule is that extraction never fails an upload — unreadable
 * fields land in `missing_fields[]` for review. So the email that announces a
 * receipt must be legible when the merchant, the date and the total are ALL
 * null, because that receipt still exists and still arrives. There is no
 * fallback path here; the null-handling IS the path.
 *
 * ## Plain text is not a courtesy copy
 *
 * Both parts are generated from the same data. A mail client that shows the
 * text part (or a spam filter that scores a message with no text part more
 * harshly) gets the same facts, not a "please view in HTML" stub.
 */

export type EmailReceiptItem = {
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  /** Null means genuinely uncategorised — rendered as such, not as blank. */
  categoryName: string | null;
};

export type EmailReceiptData = {
  projectName: string;
  merchantName: string | null;
  /** ISO `YYYY-MM-DD`, or null when it could not be read. */
  transactionDate: string | null;
  transactionTime: string | null;
  subtotal: string | null;
  salesTax: string | null;
  tip: string | null;
  total: string | null;
  currency: string;
  paymentMethod: string | null;
  cardLast4: string | null;
  items: EmailReceiptItem[];
  /** Fields the extraction could not read. Named in the body so the recipient
   *  knows what to check rather than discovering it in the export. */
  missingFields: string[];
  /** Sanity checks that tripped (ARCHITECTURE.md §6.3). */
  validationFlags: string[];
  /** Absolute URL of the receipt in the app, or null if `APP_HOSTNAME` is not
   *  usable. A link the recipient can act on is most of the value here. */
  receiptUrl: string | null;
};

/** When the merchant could not be read. Used in both the subject and the
 *  body, so the same receipt reads consistently in a mailbox list and open. */
const UNKNOWN_MERCHANT = "Unknown merchant";

/**
 * Collapses CR/LF (and any other control character) out of a value destined
 * for a MIME HEADER.
 *
 * nodemailer already encodes headers, so this is not the only thing standing
 * between a merchant name and header injection — but a merchant name here is
 * MODEL OUTPUT DERIVED FROM A PHOTOGRAPH, which is the least trustworthy
 * string in the application, and "the library probably handles it" is not the
 * standard a header gets. Cheap, total, and it cannot regress if the transport
 * is ever swapped.
 */
function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function money(value: string | null, currency: string): string {
  return formatMoneyDisplay(value, { currency });
}

/**
 * `2026-09-09` -> `9 Sep 2026`. Written out rather than left ISO because a
 * subject line is read at a glance in a list of other subject lines.
 *
 * Formatted from the parts, NOT via `new Date(iso)`: that constructor parses
 * a bare `YYYY-MM-DD` as UTC midnight and then renders it in the local zone,
 * which shifts the date backwards by a day anywhere west of Greenwich. The
 * value is a calendar date off a piece of paper; it has no time zone and must
 * not acquire one.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatEmailDate(iso: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!match) return null;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const name = MONTHS[Number(month) - 1];
  if (!name) return null;
  return `${Number(day)} ${name} ${year}`;
}

/**
 * The subject: merchant and date, both of which may be missing.
 *
 * Ordered merchant-first because that is what a mailbox list truncates to,
 * and the project name is appended so a person running several projects can
 * filter without opening anything.
 */
export function buildSubject(data: EmailReceiptData): string {
  const merchant = headerSafe(data.merchantName ?? "") || UNKNOWN_MERCHANT;
  const date = formatEmailDate(data.transactionDate);
  const total = data.total ? ` — ${money(data.total, data.currency)}` : "";
  const when = date ? ` · ${date}` : "";
  return `Receipt: ${merchant}${when}${total} (${headerSafe(data.projectName)})`;
}

/** Minimal, and applied to EVERY interpolation below. Merchant names, item
 *  descriptions and category names are all model output derived from a
 *  photograph a user supplied — none of it may reach an HTML body unescaped,
 *  regardless of how implausible a `<script>` on a receipt sounds. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const UNCATEGORIZED_LABEL = "Uncategorised";

/** Groups items by category for the body. Order of first appearance, so the
 *  email reads in the order the receipt was printed rather than alphabetically
 *  — the recipient is checking it against a piece of paper. */
export function groupByCategory(
  items: readonly EmailReceiptItem[],
): { category: string; items: EmailReceiptItem[] }[] {
  const groups = new Map<string, EmailReceiptItem[]>();
  for (const item of items) {
    const key = item.categoryName?.trim() || UNCATEGORIZED_LABEL;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups].map(([category, grouped]) => ({ category, items: grouped }));
}

function itemLine(item: EmailReceiptItem, currency: string): string {
  const quantity = formatQuantityDisplay(item.quantity);
  const unit = item.unitPrice ? money(item.unitPrice, currency) : null;
  const detail = [quantity ? `${quantity} ×` : null, unit].filter(Boolean).join(" ");
  return [item.description, detail ? `(${detail})` : null].filter(Boolean).join(" ");
}

const FLAG_LABELS: Record<string, string> = {
  arithmetic_mismatch_total: "the subtotal, tax and total do not add up",
  arithmetic_mismatch_items: "the line items do not add up to the subtotal",
  date_in_future: "the transaction date is in the future",
  date_too_old: "the transaction date is implausibly old",
};

/** A reason code is a fine thing to store and a poor thing to email. */
function describeFlag(flag: string): string {
  return FLAG_LABELS[flag] ?? flag;
}

export type RenderedEmail = { subject: string; html: string; text: string };

export function renderReceiptEmail(data: EmailReceiptData): RenderedEmail {
  const merchant = data.merchantName?.trim() || UNKNOWN_MERCHANT;
  const date = formatEmailDate(data.transactionDate);
  const groups = groupByCategory(data.items);

  const totals: [string, string | null][] = [
    ["Subtotal", data.subtotal],
    ["Tax", data.salesTax],
    ["Tip", data.tip],
    ["Total", data.total],
  ];
  const shownTotals = totals.filter(([, value]) => value !== null);

  const payment = [data.paymentMethod, data.cardLast4 ? `•••• ${data.cardLast4}` : null]
    .filter(Boolean)
    .join(" ");

  // ---- plain text -------------------------------------------------------
  const text: string[] = [
    merchant,
    [date, data.transactionTime].filter(Boolean).join(" ") || "Date not read",
    `Project: ${data.projectName}`,
    "",
  ];

  if (groups.length === 0) {
    text.push("No line items were read from this receipt.", "");
  } else {
    for (const group of groups) {
      text.push(`${group.category}:`);
      for (const item of group.items) {
        text.push(`  ${itemLine(item, data.currency)}  ${money(item.lineTotal, data.currency)}`);
      }
      text.push("");
    }
  }

  for (const [label, value] of shownTotals) {
    text.push(`${label}: ${money(value, data.currency)}`);
  }
  if (payment) text.push(`Paid with: ${payment}`);

  if (data.missingFields.length > 0) {
    text.push("", `Not read from the image: ${data.missingFields.join(", ")}`);
  }
  for (const flag of data.validationFlags) {
    text.push(`Check: ${describeFlag(flag)}`);
  }
  if (data.receiptUrl) text.push("", `Open in Ledgerly: ${data.receiptUrl}`);
  text.push("", "The receipt image is attached.");

  // ---- html -------------------------------------------------------------
  // Inline styles and a table layout, because that is what mail clients
  // support — Outlook's renderer has no CSS grid and strips <style> blocks.
  const rows: string[] = [];
  for (const group of groups) {
    rows.push(
      `<tr><td colspan="2" style="padding:12px 0 4px;font-size:12px;text-transform:uppercase;` +
        `letter-spacing:.05em;color:#6b7280;">${escapeHtml(group.category)}</td></tr>`,
    );
    for (const item of group.items) {
      rows.push(
        `<tr>` +
          `<td style="padding:4px 8px 4px 0;border-bottom:1px solid #eee;">` +
          `${escapeHtml(itemLine(item, data.currency))}</td>` +
          `<td style="padding:4px 0;border-bottom:1px solid #eee;text-align:right;` +
          `white-space:nowrap;">${escapeHtml(money(item.lineTotal, data.currency))}</td>` +
          `</tr>`,
      );
    }
  }
  if (rows.length === 0) {
    rows.push(
      `<tr><td colspan="2" style="padding:8px 0;color:#6b7280;">` +
        `No line items were read from this receipt.</td></tr>`,
    );
  }

  const totalRows = shownTotals
    .map(
      ([label, value], index) =>
        `<tr><td style="padding:2px 8px 2px 0;text-align:right;${
          index === shownTotals.length - 1 ? "font-weight:600;" : ""
        }">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 0;text-align:right;white-space:nowrap;${
          index === shownTotals.length - 1 ? "font-weight:600;" : ""
        }">${escapeHtml(money(value, data.currency))}</td></tr>`,
    )
    .join("");

  const notes: string[] = [];
  if (data.missingFields.length > 0) {
    notes.push(
      `Not read from the image: ${escapeHtml(data.missingFields.join(", "))}. ` +
        `Worth filling in before you export.`,
    );
  }
  for (const flag of data.validationFlags) {
    notes.push(escapeHtml(`Check: ${describeFlag(flag)}.`));
  }

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,` +
    `sans-serif;font-size:14px;color:#111;max-width:640px;">` +
    `<h1 style="font-size:18px;margin:0 0 2px;">${escapeHtml(merchant)}</h1>` +
    `<p style="margin:0 0 16px;color:#6b7280;">` +
    `${escapeHtml([date, data.transactionTime].filter(Boolean).join(" ") || "Date not read")}` +
    ` · ${escapeHtml(data.projectName)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;` +
    `border-collapse:collapse;">${rows.join("")}</table>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;` +
    `border-collapse:collapse;margin-top:12px;">${totalRows}</table>` +
    (payment
      ? `<p style="margin:12px 0 0;color:#6b7280;">Paid with ${escapeHtml(payment)}</p>`
      : "") +
    (notes.length > 0
      ? `<div style="margin-top:16px;padding:10px 12px;background:#fff8e6;border-radius:6px;` +
        `color:#6b4f00;">${notes.map((note) => `<p style="margin:0 0 4px;">${note}</p>`).join("")}</div>`
      : "") +
    (data.receiptUrl
      ? `<p style="margin:20px 0 0;"><a href="${escapeHtml(data.receiptUrl)}" ` +
        `style="color:#324136;">Open this receipt in Ledgerly</a></p>`
      : "") +
    `<p style="margin:16px 0 0;color:#6b7280;font-size:12px;">The receipt image is attached.</p>` +
    `</div>`;

  return { subject: buildSubject(data), html, text: text.join("\n") };
}
