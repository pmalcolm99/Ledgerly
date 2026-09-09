import { redirect } from "next/navigation";

import { AdminView } from "../../../components/AdminView";
import { resolveIdentity } from "../../../server/identity";

/**
 * Instance owner only (brief §7).
 *
 * Checked here as well as in every procedure the screen calls. This check is
 * a courtesy that avoids rendering a page of permission errors; the
 * `ownerProcedure` gate on `admin.overview`, `admin.aiUsage` and
 * `admin.backups` is what actually protects the data.
 */
export default async function AdminPage() {
  const user = await resolveIdentity();
  if (user?.role !== "owner") redirect("/");
  return <AdminView />;
}
