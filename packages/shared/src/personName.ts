/**
 * packages/shared/src/personName.ts — one fallback chain for a person's name.
 *
 * Four surfaces render a user (`members.list`, `users.list`,
 * `admin.overview`, and a receipt's uploader). Written four times they drift,
 * and the drift shows up as the same person appearing under two different
 * names on two screens.
 *
 * `users.first_name`/`last_name` are nullable until onboarding completes
 * (D-28), and `display_name` is nullable always, so every step of this chain
 * is genuinely reachable.
 */

export type NamedUser = {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
};

export function displayNameOf(user: NamedUser | null | undefined): string {
  if (!user) return "Unknown user";

  const display = user.displayName?.trim();
  if (display) return display;

  const first = user.firstName?.trim() ?? "";
  const last = user.lastName?.trim() ?? "";
  const full = [first, last].filter(Boolean).join(" ");
  if (full) return full;

  const email = user.email?.trim();
  if (email) return email;

  // Reachable: `receipts.uploaded_by` is ON DELETE SET NULL, so a receipt can
  // outlive its uploader and legitimately have no one to name.
  return "Unknown user";
}
