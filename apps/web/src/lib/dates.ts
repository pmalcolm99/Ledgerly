/**
 * Date rendering. Fixed locale and an explicit UTC time zone, both
 * deliberate: a `date` column is a calendar day with no zone, and formatting
 * it in the viewer's local zone shifts it backwards for anyone west of UTC —
 * a receipt bought on the 1st shows as the 31st. Fixing the locale also keeps
 * the server render and the client hydration byte-identical.
 */
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return DATE_FORMAT.format(parsed);
}

export function formatDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start && !end) return "No dates set";
  if (start && !end) return `From ${formatDate(start)}`;
  if (!start && end) return `Until ${formatDate(end)}`;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

/** `time` columns arrive as HH:MM:SS; seconds are noise on a receipt. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 5);
}
