import "server-only";

/**
 * packages/api/src/rateLimit.ts — per-user upload rate limit (task 5.9,
 * ARCHITECTURE.md §5).
 *
 * `packages/api` has no dependency on `ioredis` (see the D-07 module
 * layout — `packages/api` sits above `packages/db`, not above
 * `packages/queue`). Rather than adding one just for this, the Redis
 * client is passed in by the caller, typed to the minimal structural
 * interface below — `apps/web`'s upload Route Handler already depends on
 * `@ledgerly/queue`/`ioredis` and constructs the real connection via
 * `getRedisConnection` (packages/queue/src/redis.ts).
 */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

// Fixed window, not sliding: a user can admit up to `limitPerMinute` just
// before a bucket boundary and another full `limitPerMinute` just after,
// i.e. up to ~2x the configured rate in the worst case at a boundary. A
// sliding window would close that, at the cost of a more expensive Lua
// script (a sorted set per user instead of one counter). Accepted
// trade-off for a limit whose purpose is "stop a runaway client/script",
// not a hard billing/quota boundary.
const WINDOW_SECONDS = 60;

// Atomic check-then-increment. Redis executes a Lua script single-threaded,
// so two concurrent requests from the same user can never both pass the
// check before either increments — the alternative (GET then INCRBY as two
// round trips) has exactly that race.
const RATE_LIMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
if current + cost > limit then
  return 0
end
redis.call('INCRBY', KEYS[1], cost)
redis.call('EXPIRE', KEYS[1], window)
return 1
`;

/**
 * Admits or rejects an entire upload request atomically, at a cost of one
 * per file in the batch — not one call per file. A 5-file request either
 * fits within the caller's remaining budget for this minute or the whole
 * request is rejected; there is no partial admission of a batch, which
 * keeps "which files got through" purely a per-file guard question
 * (magic-byte/size/megapixel), never entangled with rate limiting.
 */
export async function checkUploadRateLimit(
  redis: RateLimitRedis,
  userId: string,
  cost: number,
  limitPerMinute: number,
): Promise<RateLimitResult> {
  const minuteBucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const key = `upload_rate:${userId}:${minuteBucket}`;

  const result = await redis.eval(RATE_LIMIT_SCRIPT, 1, key, cost, limitPerMinute, WINDOW_SECONDS);

  if (result === 1) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  // The window is fixed (not sliding), so the caller can retry as soon as
  // the current minute bucket rolls over.
  const secondsIntoWindow = Math.floor(Date.now() / 1000) % WINDOW_SECONDS;
  return { allowed: false, retryAfterSeconds: WINDOW_SECONDS - secondsIntoWindow };
}
