import { formatMoney, parseMoney } from "./money";

/**
 * packages/shared/src/moneyDisplay.ts — the display boundary for money
 * (Phase 7, D-21).
 *
 * `money.ts` deliberately stops at `"1234.50"`: no symbol, no thousands
 * separator, because those are a display concern. This is that display
 * concern, kept in `packages/shared` so a Server Component and a Client
 * Component format a total identically (`Intl` is ECMA-402, not a Node
 * built-in, so it is safe here — see index.ts's boundary note).
 *
 * **There is no float in this module.** `Intl.NumberFormat.format()` accepts
 * an exact decimal *string* and formats it without going through a binary
 * double, so the value never leaves the exact representation `numeric(12,2)`
 * gave us. Verified against the column's maximum: `"9999999999.99"` formats
 * as `$9,999,999,999.99`. This is why the input here is the numeric string
 * the API returns rather than integer cents — no call site has to remember
 * which representation it is holding, and no call site is tempted to write
 * `cents / 100`.
 */

/**
 * `Intl.NumberFormat.format` accepting an exact decimal STRING is Intl
 * NumberFormat V3, standardised in ES2023. Node 22 and every browser this app
 * targets implement it (verified: `"9999999999.99"` formats correctly, i.e.
 * at `numeric(12,2)`'s exact maximum), but this repo compiles against
 * `lib: ["ES2022"]`, whose signature is `(value: number | bigint)`.
 *
 * So the type is widened here rather than the whole repo's `lib` raised for
 * one call. The alternative — `cents / 100` — would put a binary float back
 * into the money path that D-21 exists to keep out, which is a much worse
 * trade than a narrow, documented structural type.
 */
type ExactNumberFormat = { format(value: string | number | bigint): string };

function exactFormatter(options: MoneyDisplayOptions): ExactNumberFormat {
  return new Intl.NumberFormat(options.locale ?? DEFAULT_LOCALE, {
    style: "currency",
    currency: options.currency ?? DEFAULT_CURRENCY,
  }) as unknown as ExactNumberFormat;
}

export type MoneyDisplayOptions = {
  /** ISO-4217. D-17: the column exists, there is no picker; callers pass the
   *  receipt's own `currency` so a future multi-currency UI needs no change
   *  here. */
  currency?: string;
  /** Fixed rather than host-derived, so a server render and the client
   *  hydration that follows it produce byte-identical text. A locale-varying
   *  default is a classic hydration mismatch. */
  locale?: string;
  /** What to render when the value is absent. */
  blank?: string;
};

const DEFAULT_LOCALE = "en-US";
const DEFAULT_CURRENCY = "USD";

/**
 * A missing amount renders as an em dash, **never** as `$0.00`. A receipt
 * whose total could not be read is not a receipt for nothing, and that
 * distinction is the entire premise of the review queue.
 */
export function formatMoneyDisplay(
  value: string | null | undefined,
  options: MoneyDisplayOptions = {},
): string {
  const blank = options.blank ?? "—";
  if (value === null || value === undefined || value.trim() === "") return blank;

  let normalized: string;
  try {
    normalized = formatMoney(parseMoney(value));
  } catch {
    // Every value reaching here comes from a `numeric` column and always
    // parses; a value that does not is a bug upstream. Returning the raw
    // string keeps that bug visible instead of laundering it into `blank`,
    // which would be indistinguishable from a legitimately absent amount —
    // and keeps a display helper from throwing and taking a page down.
    return value;
  }

  return exactFormatter(options).format(normalized);
}

/** Same, for a value already in integer cents (an aggregate computed in the
 *  app rather than read from a column). Routes through `formatMoney` so the
 *  string path above stays the only formatting path. */
export function formatCentsDisplay(
  cents: number | null | undefined,
  options: MoneyDisplayOptions = {},
): string {
  if (cents === null || cents === undefined) return options.blank ?? "—";
  return formatMoneyDisplay(formatMoney(cents), options);
}
