import { redirect } from "next/navigation";
import { isOnboarded } from "@ledgerly/auth";

import { resolveIdentity } from "../../server/identity";

/**
 * The authenticated shell, and the onboarding gate for every page inside it
 * (task 3.8, D-28).
 *
 * `/welcome` is NOT exempted from within this layout — it lives outside the
 * `(app)` route group entirely, so its structural placement *is* the
 * exemption. There is no exemption list to maintain and nothing to
 * remember, which is the specific failure D-03 records against Forkd's sync
 * route: an exception carved into a security check that then has to be
 * remembered forever.
 *
 * The gate cannot live in `proxy.ts` despite what PHASES.md task 3.8 lists:
 * it needs `users.onboarded_at`, middleware runs on the Edge Runtime, and
 * `pg` does not run there. ARCHITECTURE.md §3.1 already places it here.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await resolveIdentity();

  // The middleware already rejected unauthenticated requests; this is the
  // Node-layer verification that actually decides (D-24).
  if (!user) redirect("/api/auth/sign-out");
  if (!isOnboarded(user)) redirect("/welcome");

  return <>{children}</>;
}
