"use client";

import { formatMoneyDisplay } from "@ledgerly/shared/moneyDisplay";
import { parseMoney } from "@ledgerly/shared/money";

/**
 * Spend by category, as plain CSS bars.
 *
 * No chart library: this is five to fifteen horizontal bars, it must render
 * on a phone over a tunnel, and it has to be theme-aware across five themes.
 * A dependency buys nothing here and costs a bundle.
 *
 * THE TWO TOTALS DO NOT RECONCILE, AND THIS COMPONENT SAYS SO. The header
 * total is `sum(receipts.total)`; these bars are `sum(receipt_items
 * .line_total)`. They differ by sales tax, tip, order-level credits, and every
 * receipt whose line items were never extracted. Showing them side by side as
 * though they were the same number would be quietly wrong on a tax record.
 *
 * D-47: that gap used to be ONE row labelled "Tax, tip and unitemised", which
 * was four unrelated things added together. Tax and tip are facts about a
 * receipt; a discount is a credit; unitemised spend is the only one of the
 * four that means something went unread and might want attention. Summing them
 * made the one actionable number the hardest to see. They are now separate
 * rows, and "unitemised" is what is left after the other three are named.
 */

/** Deterministic fallback hue for a category with no colour set, so the same
 *  category is always the same colour without storing one. */
function hueFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${hash} 45% 45%)`;
}

export function SpendByCategory({
  byCategory,
  totalSpend,
  totals,
}: {
  byCategory: Array<{
    categoryId: string | null;
    name: string | null;
    color: string | null;
    itemCount: number;
    spend: string;
  }>;
  /** The total over the SAME receipts as `byCategory` — the filtered one, not
   *  the project header's lifetime figure. They differ whenever a date filter
   *  is applied, and the remainder below is the difference between them. */
  totalSpend: string;
  /** Server-side sums over the same receipts as `byCategory` (D-47). */
  totals?: { salesTax: string; tip: string; transactionDiscount: string };
}) {
  const itemsCents = byCategory.reduce((sum, row) => sum + safeCents(row.spend), 0);
  const totalCents = safeCents(totalSpend);
  const taxCents = safeCents(totals?.salesTax);
  const tipCents = safeCents(totals?.tip);
  // Stored negative, so this ADDS to the accounted-for side.
  const discountCents = safeCents(totals?.transactionDiscount);
  // What is left once every named component is subtracted: line items the
  // model never read. The honest remainder, and the only one of these four
  // that is a prompt to go and look at something.
  const unitemisedCents = totalCents - itemsCents - taxCents - tipCents - discountCents;

  if (byCategory.length === 0) {
    return (
      <p className="text-sm text-default-500">
        No line items yet. Categories appear here once receipts have been read.
      </p>
    );
  }

  // Scale bars against whichever is larger, so a remainder row cannot overflow
  // the track when line items exceed the receipt totals.
  const scale = Math.max(itemsCents + Math.max(unitemisedCents, 0) + taxCents + tipCents, 1);

  const extraRows: { label: string; cents: number }[] = [
    { label: "Sales tax", cents: taxCents },
    { label: "Tip", cents: tipCents },
    { label: "Discounts and credits", cents: discountCents },
    { label: "Unitemised", cents: unitemisedCents },
  ].filter((row) => row.cents !== 0);

  return (
    <div className="flex flex-col gap-2">
      {byCategory.map((row) => {
        const cents = safeCents(row.spend);
        const label = row.categoryId ? (row.name ?? "Unnamed") : "Unassigned";
        return (
          <div key={row.categoryId ?? "unassigned"} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">
                {label}
                <span className="ml-1.5 text-xs text-default-400">
                  {row.itemCount} {row.itemCount === 1 ? "item" : "items"}
                </span>
              </span>
              <span className="shrink-0 tabular-nums">{formatMoneyDisplay(row.spend)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-content3">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max((cents / scale) * 100, cents > 0 ? 1.5 : 0)}%`,
                  background:
                    row.color ?? (row.categoryId ? hueFor(row.categoryId) : "hsl(0 0% 45%)"),
                }}
              />
            </div>
          </div>
        );
      })}

      {extraRows.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1 border-t border-divider pt-2">
          {extraRows.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-3 text-sm text-default-500"
            >
              <span>{row.label}</span>
              <span className="shrink-0 tabular-nums">
                {formatMoneyDisplay(centsToNumeric(row.cents))}
              </span>
            </div>
          ))}
          {/* A NEGATIVE unitemised remainder means the line items add up to
              more than the receipts claim — which is the aggregate face of
              `arithmetic_mismatch_items`, and worth saying rather than
              rendering as a quietly negative row. */}
          {unitemisedCents < 0 ? (
            <p className="text-xs text-warning">
              Some receipts&apos; line items add up to more than their stated total. Worth checking.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** These strings come from `numeric` columns and always parse; a bad one is a
 *  bug upstream, and a chart is not the place to throw over it. */
function safeCents(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    return parseMoney(value);
  } catch {
    return 0;
  }
}

function centsToNumeric(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
