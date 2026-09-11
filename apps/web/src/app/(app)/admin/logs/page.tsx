import { redirect } from "next/navigation";

import { AdminSubNav } from "../../../../components/AdminSubNav";
import { LogsView } from "../../../../components/LogsView";
import { resolveIdentity } from "../../../../server/identity";

/**
 * Instance owner only, the same courtesy check `admin/page.tsx` makes and for
 * the same reason: the `ownerProcedure` gate on `admin.logs` is what actually
 * protects the data, this just avoids rendering a page of permission errors.
 */
export default async function AdminLogsPage() {
  const user = await resolveIdentity();
  if (user?.role !== "owner") redirect("/");
  return (
    <div className="flex flex-col gap-4">
      <AdminSubNav />
      <LogsView />
    </div>
  );
}
