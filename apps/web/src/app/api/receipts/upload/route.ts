import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";

import { handleUpload } from "./handler";

/**
 * apps/web/src/app/api/receipts/upload/route.ts — thin Next.js Route
 * Handler binding. See ./handler.ts for the actual logic; this file exists
 * only because Next.js's route type-checker rejects any named export from
 * a route.ts file besides the recognized HTTP-method/config exports, so
 * `handleUpload` can't be exported from here for tests to call directly.
 */
export async function POST(request: Request): Promise<Response> {
  return handleUpload(request, { db: getDb(), env: getEnv() });
}
