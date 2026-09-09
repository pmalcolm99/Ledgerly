import { getEnv } from "@ledgerly/config/env";
import { getDb } from "@ledgerly/db/client";
import { getRedisConnection } from "@ledgerly/queue/redis";

import { handleExportGet } from "./handler";

/**
 * apps/web/src/app/api/projects/[id]/export/route.ts — thin Next.js Route
 * Handler binding. The logic is in ./handler.ts, which takes an injected
 * `db` so tests can point it at the test database; Next's route type-checker
 * rejects any named export from a route.ts besides the recognized HTTP-method
 * and config exports, so `handleExportGet` cannot live here.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  // Redis is constructed here, not inside the handler, for the same reason
  // the upload route does it: `packages/api` deliberately has no ioredis
  // dependency (D-07), so the connection is injected by the app layer.
  return handleExportGet(request, id, {
    db: getDb(),
    rateLimitRedis: getRedisConnection(getEnv().REDIS_URL),
  });
}
