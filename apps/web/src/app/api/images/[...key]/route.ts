import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";

import { handleImageGet } from "./handler";

/**
 * apps/web/src/app/api/images/[...key]/route.ts — thin Next.js Route
 * Handler binding. See ./handler.ts for the actual logic; this file exists
 * only because Next.js's route type-checker rejects any named export from
 * a route.ts file besides the recognized HTTP-method/config exports, so
 * `handleImageGet` can't be exported from here for tests to call directly.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await params;
  return handleImageGet(request, key, { db: getDb(), env: getEnv() });
}
