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
 * .line_total)`. They differ by sales tax, tip, and every receipt whose line
 * items were never extracted. Showing them side by side as though they were
 * the same number would be quietly wrong on a tax record, so the remainder is
 * drawn as its own labelled row rather than left for the user to notice.
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
}: {
  byCategory: Array<{
    categoryId: string | null;
    name: string | null;
    color: string | null;
    itemCount: number;
    spend: string;
  }>;
  totalSpend: string;
}) {
  const itemsCents = byCategory.reduce((sum, row) => sum + safeCents(row.spend), 0);
  const totalCents = safeCents(totalSpend);
  const remainderCents = totalCents - itemsCents;

  if (byCategory.length === 0) {
    return (
      <p className="text-sm text-default-500">
        No line items yet. Categories appear here once receipts have been read.
      </p>
    );
  }

  // Scale bars against whichever is larger, so the remainder row cannot
  // overflow the track when line items exceed the receipt totals.
  const scale = Math.max(itemsCents + Math.max(remainderCents, 0), 1);

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

      {remainderCents !== 0 ? (
        <div className="mt-1 flex flex-col gap-1 border-t border-divider pt-2">
          <div className="flex items-baseline justify-between gap-3 text-sm text-default-500">
            <span>
              {remainderCents > 0 ? "Tax, tip and unitemised" : "Line items exceed receipt totals"}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatMoneyDisplay(centsToNumeric(Math.abs(remainderCents)))}
            </span>
          </div>
          {remainderCents < 0 ? (
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
