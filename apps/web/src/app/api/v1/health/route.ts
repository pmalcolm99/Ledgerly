import IORedis from "ioredis";

import { getEnv } from "@ledgerly/config/env";
import { getPool } from "@ledgerly/db/client";
import { redisConnectionOptions } from "@ledgerly/queue/redis";

/**
 * Deep healthcheck (task 2.9, D-15). `SELECT 1` against the pool and a
 * Redis ping; 503 if either fails. This route is the one endpoint reached
 * without authentication (it is exempt from the middleware matcher —
 * ARCHITECTURE.md §3.2), so the response body carries no detail: no
 * version, no hostname, no error message. A healthcheck that cannot fail
 * is not a healthcheck — Forkd's `/api/v1/health` returns `{status:"ok"}`
 * without touching the database (`docs/reference/FORKD_INFRA.md`), which
 * this deliberately does not inherit.
 */

const CHECK_TIMEOUT_MS = 3_000;

let healthRedis: IORedis | undefined;

/** A separate connection from the one BullMQ workers use (packages/queue's
 * getReceiptExtractQueue/startWorkers): those require
 * `maxRetriesPerRequest: null` so a job command retries forever rather than
 * failing a job over a blip. A healthcheck needs the opposite — a bounded
 * failure — so this client is deliberately configured with a short retry
 * and connect budget instead of reusing that singleton. */
function getHealthRedis(): IORedis {
  if (!healthRedis) {
    healthRedis = new IORedis({
      ...redisConnectionOptions(getEnv().REDIS_URL),
      maxRetriesPerRequest: 1,
      connectTimeout: CHECK_TIMEOUT_MS,
      lazyConnect: true,
    });
    // Never let a Redis connection error crash the process — a failed
    // healthcheck should return 503, not take the server down.
    healthRedis.on("error", () => {});
  }
  return healthRedis;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export async function GET(): Promise<Response> {
  try {
    await withTimeout(getPool().query("SELECT 1"), CHECK_TIMEOUT_MS);
  } catch {
    return unhealthy();
  }

  try {
    const pong = await withTimeout(getHealthRedis().ping(), CHECK_TIMEOUT_MS);
    if (pong !== "PONG") return unhealthy();
  } catch {
    return unhealthy();
  }

  return Response.json({ status: "healthy" }, { status: 200 });
}

function unhealthy(): Response {
  return new Response("unhealthy", {
    status: 503,
    headers: { "content-type": "text/plain" },
  });
}
