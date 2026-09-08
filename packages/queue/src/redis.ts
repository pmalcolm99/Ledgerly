import "server-only";

import IORedis, { type RedisOptions } from "ioredis";

/**
 * packages/queue/src/redis.ts — connection options BullMQ needs, parsed
 * from `REDIS_URL`. Originally minimal Phase 2 scaffolding; Phase 5 is the
 * first real consumer (`ingestWorker.ts`, `rateLimit.ts`'s caller,
 * `queue.ts`).
 */
export function redisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  // The logical Redis database index (`redis://host:port/N`) — task 5.9
  // review finding M-7: this was silently dropped, which defeated
  // TEST_REDIS_URL's whole point (a distinct db number sharing the same
  // container/port as REDIS_URL, scripts/test-redis.sh) and could point a
  // test run at a developer's real dev-loop Redis instead.
  const dbSegment = url.pathname.replace(/^\//, "");
  const db = dbSegment === "" ? undefined : Number(dbSegment);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    ...(db !== undefined && Number.isInteger(db) ? { db } : {}),
    // BullMQ requires this on the connection it's given.
    maxRetriesPerRequest: null,
  };
}

let sharedConnection: IORedis | undefined;
let sharedConnectionUrl: string | undefined;

/**
 * Lazy singleton so importing this module never opens a connection by
 * itself — only the first actual queue/worker construction does.
 *
 * Keyed on the URL it was first created with: the singleton previously
 * ignored the `redisUrl` argument on every call after the first, so a
 * second, different URL (e.g. a test passing `TEST_REDIS_URL` after
 * something else in the same process already called this with the real
 * `REDIS_URL`) would silently reuse the FIRST connection rather than
 * connecting to the URL it was actually given (review finding M-7). A
 * mismatched second call now fails loudly instead of connecting to the
 * wrong Redis.
 */
export function getRedisConnection(redisUrl: string): IORedis {
  if (!sharedConnection) {
    sharedConnection = new IORedis(redisConnectionOptions(redisUrl));
    sharedConnectionUrl = redisUrl;
  } else if (sharedConnectionUrl !== redisUrl) {
    throw new Error(
      `getRedisConnection: already connected to ${sharedConnectionUrl}; cannot also connect to ` +
        `${redisUrl} in the same process. Each process must use exactly one Redis URL.`,
    );
  }
  return sharedConnection;
}
