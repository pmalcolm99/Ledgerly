import "server-only";

import IORedis, { type RedisOptions } from "ioredis";

/**
 * packages/queue/src/redis.ts — connection options BullMQ needs, parsed
 * from `REDIS_URL`. This is minimal Phase 2 scaffolding: enough for the
 * connection shape to exist and be traceable (ARCHITECTURE.md §8.1's
 * `.next/standalone/node_modules` acceptance criterion for task 2.8), and
 * for Phase 6 (D-19, task 6.1) to build on rather than write from scratch.
 * The queues and workers that use this connection are Phase 6 scope.
 */
export function redisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    // BullMQ requires this on the connection it's given.
    maxRetriesPerRequest: null,
  };
}

let sharedConnection: IORedis | undefined;

/** Lazy singleton so importing this module never opens a connection by
 * itself — only the first actual queue/worker construction does. */
export function getRedisConnection(redisUrl: string): IORedis {
  if (!sharedConnection) {
    sharedConnection = new IORedis(redisConnectionOptions(redisUrl));
  }
  return sharedConnection;
}
