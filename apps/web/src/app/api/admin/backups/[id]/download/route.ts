import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";

import { handleBackupDownload } from "./handler";

/**
 * apps/web/src/app/api/admin/backups/[id]/download/route.ts — thin Next.js
 * Route Handler binding. See ./handler.ts for the logic and for why the split
 * exists.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleBackupDownload(request, id, { db: getDb(), env: getEnv() });
}
