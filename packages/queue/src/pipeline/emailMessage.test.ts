import { describe, expect, it } from "vitest";

import {
  buildSubject,
  formatEmailDate,
  groupByCategory,
  renderReceiptEmail,
  type EmailReceiptData,
} from "./emailMessage";

function base(overrides: Partial<EmailReceiptData> = {}): EmailReceiptData {
  return {
    projectName: "Home office",
    merchantName: "Costco",
    transactionDate: "2026-09-09",
    transactionTime: "14:32:00",
    subtotal: "20.00",
    salesTax: "1.60",
    tip: null,
    total: "21.60",
    currency: "USD",
    paymentMethod: "Visa",
    cardLast4: "4242",
    items: [
      {
        description: "Printer paper",
        quantity: "2",
        unitPrice: "12.00",
        lineTotal: "24.00",
        categoryName: "Office supplies",
      },
      {
        description: "Member discount",
        quantity: null,
        unitPrice: null,
        lineTotal: "-4.00",
        categoryName: null,
      },
    ],
    missingFields: [],
    validationFlags: [],
    receiptUrl: "https://receipts.example.com/receipts/abc",
    ...overrides,
  };
}

describe("formatEmailDate", () => {
  it("formats an ISO date without going through Date", () => {
    expect(formatEmailDate("2026-09-09")).toBe("9 Sep 2026");
    expect(formatEmailDate("2026-01-01")).toBe("1 Jan 2026");
  });

  /**
   * The bug this exists to prevent: `new Date("2026-09-09")` parses as UTC
   * midnight and renders in the local zone, so anywhere west of Greenwich the
   * receipt would be dated the 8th. A transaction date is a calendar date off
   * a piece of paper and has no time zone to be converted between.
   */
  it("does not shift the date in a western time zone", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(formatEmailDate("2026-09-09")).toBe("9 Sep 2026");
    } finally {
      process.env.TZ = previousTz;
    }
  });

  it("returns null for a missing or malformed date", () => {
    expect(formatEmailDate(null)).toBeNull();
    expect(formatEmailDate("not a date")).toBeNull();
    expect(formatEmailDate("2026-13-01")).toBeNull();
  });
});

describe("buildSubject", () => {
  it("names the merchant, the date and the total", () => {
    const subject = buildSubject(base());
    expect(subject).toContain("Costco");
    expect(subject).toContain("9 Sep 2026");
    expect(subject).toContain("$21.60");
    expect(subject).toContain("Home office");
  });

  /**
   * Every extracted field is nullable — that is CLAUDE.md's rule, not an edge
   * case — so the subject line has to survive a receipt where nothing was
   * read. It must never render "undefined" or collapse to "Receipt: ".
   */
  it("stays legible when merchant, date and total are all null", () => {
    const subject = buildSubject(base({ merchantName: null, transactionDate: null, total: null }));
    expect(subject).toBe("Receipt: Unknown merchant (Home office)");
    expect(subject).not.toContain("undefined");
    expect(subject).not.toContain("null");
  });

  it("treats a whitespace-only merchant as missing", () => {
    expect(buildSubject(base({ merchantName: "   " }))).toContain("Unknown merchant");
  });

  /**
   * A merchant name is model output derived from a photograph — the least
   * trustworthy string in the application, and it goes into a MIME header.
   * nodemailer encodes headers, but "the library probably handles it" is not
   * the standard a header gets.
   */
  it("strips CR/LF out of anything that reaches a header", () => {
    const subject = buildSubject(
      base({ merchantName: "Costco\r\nBcc: attacker@example.com", projectName: "P\nX" }),
    );
    expect(subject).not.toContain("\r");
    expect(subject).not.toContain("\n");
    expect(subject).toContain("Costco");
  });
});

describe("groupByCategory", () => {
  it("keeps first-appearance order rather than sorting", () => {
    const groups = groupByCategory([
      { description: "b", quantity: null, unitPrice: null, lineTotal: null, categoryName: "Zed" },
      { description: "a", quantity: null, unitPrice: null, lineTotal: null, categoryName: "Alpha" },
      { description: "c", quantity: null, unitPrice: null, lineTotal: null, categoryName: "Zed" },
    ]);
    expect(groups.map((g) => g.category)).toEqual(["Zed", "Alpha"]);
    expect(groups[0]?.items).toHaveLength(2);
  });

  it("gives a null category a name instead of an empty heading", () => {
    const groups = groupByCategory([
      { description: "x", quantity: null, unitPrice: null, lineTotal: null, categoryName: null },
    ]);
    expect(groups[0]?.category).toBe("Uncategorised");
  });
});

describe("renderReceiptEmail", () => {
  it("includes every line item, its category, and the totals in both parts", () => {
    const { html, text } = renderReceiptEmail(base());
    for (const part of [html, text]) {
      expect(part).toContain("Printer paper");
      expect(part).toContain("Member discount");
      expect(part).toContain("Office supplies");
      expect(part).toContain("Uncategorised");
      expect(part).toContain("$21.60");
    }
  });

  /** A credit is the case the whole money-sign fix exists for; it must not be
   *  rendered as a positive number in the one artifact a person actually
   *  reads. */
  it("renders a credit as negative", () => {
    const { text } = renderReceiptEmail(base());
    expect(text).toContain("-$4.00");
  });

  it("says so, rather than showing nothing, when there are no line items", () => {
    const { html, text } = renderReceiptEmail(base({ items: [] }));
    expect(text).toContain("No line items");
    expect(html).toContain("No line items");
  });

  /** An absent total renders as an em dash, never $0.00 — a receipt whose
   *  total could not be read is not a receipt for nothing. */
  it("never invents a zero for a missing amount", () => {
    const { text } = renderReceiptEmail(base({ subtotal: null, salesTax: null, total: null }));
    expect(text).not.toContain("$0.00");
  });

  it("names the fields that could not be read", () => {
    const { text, html } = renderReceiptEmail(
      base({ missingFields: ["merchant_name", "sales_tax"] }),
    );
    expect(text).toContain("merchant_name");
    expect(html).toContain("sales_tax");
  });

  it("explains a validation flag instead of printing its reason code", () => {
    const { text } = renderReceiptEmail(base({ validationFlags: ["arithmetic_mismatch_total"] }));
    expect(text).toContain("do not add up");
    expect(text).not.toContain("arithmetic_mismatch_total");
  });

  /**
   * Item descriptions and merchant names are model output derived from a
   * photograph a user supplied. Escaping is not about plausibility, it is
   * about there being no path from that data to raw HTML.
   */
  it("escapes HTML in every field it interpolates", () => {
    const { html } = renderReceiptEmail(
      base({
        merchantName: '<script>alert("x")</script>',
        items: [
          {
            description: "<img onerror=x>",
            quantity: null,
            unitPrice: null,
            lineTotal: "1.00",
            categoryName: "<b>cat</b>",
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain("<b>cat</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the link entirely when there is no usable origin", () => {
    const { html, text } = renderReceiptEmail(base({ receiptUrl: null }));
    expect(html).not.toContain('href="null');
    expect(text).not.toContain("Open in Ledgerly");
  });
});
