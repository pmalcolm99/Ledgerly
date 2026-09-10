import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createContext } from "@ledgerly/api";
import { getEnv } from "@ledgerly/config/env";
import {
  getBackupQueue,
  getBackupScheduleState,
  getReceiptEmailQueue,
  getReceiptExtractQueue,
  removeBackupSchedule,
  upsertBackupSchedule,
} from "@ledgerly/queue/queue";
import { getRedisConnection } from "@ledgerly/queue/redis";
import { sendOneEmail } from "@ledgerly/queue/emailWorker";

/**
 * The tRPC HTTP handler. `createContext` resolves identity once per request
 * from the raw headers and passes `ctx.user` down (D-24) — the middleware
 * attaches nothing and is not trusted.
 *
 * `enqueueReceiptExtract`, `enqueueReceiptEmail`, `sendEmail`, the three
 * backup capabilities and `rateLimitRedis` are supplied here, not inside
 * `packages/api` (`trpc.ts`'s own comments explain why: `@ledgerly/queue`
 * already depends on `@ledgerly/api`, so the reverse import would be
 * circular). This is the only place in the app a tRPC procedure's queue/Redis
 * side effects are wired up.
 *
 * `sendEmail` is the one that actually holds credentials, and it is the only
 * synchronous send in the application — `admin.testSmtp`, which exists
 * precisely to fail loudly and immediately. Every other message goes through
 * `receipt-email`.
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
        enqueueReceiptEmail: async ({ receiptId, toUserId, requestedBy }) => {
          // No `jobId`: an on-demand re-send must never be deduplicated
          // against a resident job for the same receipt (queue.ts explains).
          await getReceiptEmailQueue(getEnv().REDIS_URL).add("email", {
            receiptId,
            reason: "on_demand",
            toUserId,
            requestedBy,
          });
        },
        sendEmail: sendOneEmail,
        enqueueBackup: async ({ backupId, kind }) => {
          // `jobId: backupId` — the row is the identity of the backup, so a
          // duplicate request for the same row cannot become a second archive.
          // Safe to reuse because the queue sets `removeOnComplete`/
          // `removeOnFail: {count: 0}` (queue.ts spells out what happens when
          // it does not).
          await getBackupQueue(getEnv().REDIS_URL).add(
            "backup",
            { kind, backupId },
            { jobId: backupId },
          );
        },
        rescheduleBackup: async (cron) => {
          const redisUrl = getEnv().REDIS_URL;
          if (cron === null) {
            await removeBackupSchedule(redisUrl);
          } else {
            await upsertBackupSchedule(redisUrl, cron);
          }
        },
        readBackupScheduleState: () => getBackupScheduleState(getEnv().REDIS_URL),
        rateLimitRedis: getRedisConnection(getEnv().REDIS_URL),
      }),
  });
}

export { handler as GET, handler as POST };
