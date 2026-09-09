import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createContext } from "@ledgerly/api";
import { getEnv } from "@ledgerly/config/env";
import { getReceiptExtractQueue } from "@ledgerly/queue/queue";
import { getRedisConnection } from "@ledgerly/queue/redis";

/**
 * The tRPC HTTP handler. `createContext` resolves identity once per request
 * from the raw headers and passes `ctx.user` down (D-24) — the middleware
 * attaches nothing and is not trusted.
 *
 * `enqueueReceiptExtract` and `rateLimitRedis` are supplied here, not
 * inside `packages/api` (`trpc.ts`'s own comments explain why:
 * `@ledgerly/queue` already depends on `@ledgerly/api`, so the reverse
 * import would be circular). This is the only place in the app a tRPC
 * procedure's queue/Redis side effects are wired up — currently just
 * `receipts.reextract`.
 */
function handler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () =>
      createContext({
        headers: request.headers,
        enqueueReceiptExtract: async ({ receiptId, forcePass2 }) => {
          await getReceiptExtractQueue(getEnv().REDIS_URL).add(
            "extract",
            { receiptId, forcePass2 },
            { jobId: receiptId },
          );
        },
        rateLimitRedis: getRedisConnection(getEnv().REDIS_URL),
      }),
  });
}

export { handler as GET, handler as POST };
