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
 * Admits or rejects a request atomically at the given cost against a
 * fixed one-minute window keyed by the caller-supplied `key` — the
 * general form `checkUploadRateLimit` (task 5.9) and `checkReextractRateLimit`
 * (task 6.10-adjacent, review finding M-3) both build on, each under its
 * own key prefix so the two budgets never share state.
 */
export async function checkRateLimit(
  redis: RateLimitRedis,
  key: string,
  cost: number,
  limitPerMinute: number,
): Promise<RateLimitResult> {
  const minuteBucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const windowedKey = `${key}:${minuteBucket}`;

  const result = await redis.eval(
    RATE_LIMIT_SCRIPT,
    1,
    windowedKey,
    cost,
    limitPerMinute,
    WINDOW_SECONDS,
  );

  if (result === 1) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  // The window is fixed (not sliding), so the caller can retry as soon as
  // the current minute bucket rolls over.
  const secondsIntoWindow = Math.floor(Date.now() / 1000) % WINDOW_SECONDS;
  return { allowed: false, retryAfterSeconds: WINDOW_SECONDS - secondsIntoWindow };
}

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
  return checkRateLimit(redis, `upload_rate:${userId}`, cost, limitPerMinute);
}

// Task 6.10-adjacent, review finding M-3: every `receipts.reextract` call
// forces a Sonnet 5 pass ($3/$15 per MTok, D-12) -- unlike the escalation
// ladder's own triggers, this is directly user-controllable and otherwise
// unmetered. Fixed, not env-tunable (`UPLOAD_RATE_LIMIT_PER_MIN`'s
// equivalent felt like more configuration surface than this narrow
// anti-abuse guard warrants); generous enough that no legitimate reviewer
// workflow hits it.
export const REEXTRACT_RATE_LIMIT_PER_MIN = 10;

export async function checkReextractRateLimit(
  redis: RateLimitRedis,
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(redis, `reextract_rate:${userId}`, 1, REEXTRACT_RATE_LIMIT_PER_MIN);
}

// Phase 8, review finding M-2. An export is the heaviest read in the app and
// the only one that can be parked: a client that opens the connection and
// stops reading (without disconnecting) leaves the writer holding a page of
// rows plus the whole ExcelJS workbook until the request is torn down.
// `MAX_EXPORT_RECEIPTS` bounds one export; this bounds how many a single user
// can have in flight. Same reasoning, and the same fixed-not-configurable
// judgment, as `REEXTRACT_RATE_LIMIT_PER_MIN` above.
export const EXPORT_RATE_LIMIT_PER_MIN = 6;

export async function checkExportRateLimit(
  redis: RateLimitRedis,
  userId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(redis, `export_rate:${userId}`, 1, EXPORT_RATE_LIMIT_PER_MIN);
}

/**
 * The same atomic check, against a window that is not one minute.
 *
 * The per-minute limits above all guard CPU or spend that recovers the moment
 * the burst stops. A relay quota does not: it is a monthly allowance, and the
 * sending reputation behind it is shared with everything else the operator
 * sends and is slow and unpleasant to repair. A per-minute cap alone bounds
 * the burst and not the total — 5/min sustained is over 7,000 messages a day,
 * which exhausts a typical 10,000/month relay plan in under two days.
 *
 * Same fixed-window trade-off as `checkRateLimit`, and it matters even less
 * here: the boundary overshoot is one extra day's budget at a day boundary.
 */
export async function checkWindowedRateLimit(
  redis: RateLimitRedis,
  key: string,
  cost: number,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const result = await redis.eval(
    RATE_LIMIT_SCRIPT,
    1,
    `${key}:${bucket}`,
    cost,
    limit,
    windowSeconds,
  );
  if (result === 1) return { allowed: true, retryAfterSeconds: 0 };
  const secondsIntoWindow = Math.floor(Date.now() / 1000) % windowSeconds;
  return { allowed: false, retryAfterSeconds: windowSeconds - secondsIntoWindow };
}

// D-44. An on-demand receipt email is user-triggered outbound mail. Unlike an
// export, the cost of abuse is not this instance's CPU — it is the sending
// reputation of the relay, which is shared across everything the operator
// sends and is slow and unpleasant to repair. Lower than every other limit
// here for that reason, and still far above any real "send that one again".
export const EMAIL_RECEIPT_RATE_LIMIT_PER_MIN = 5;

// The one that actually bounds the bill. `emailReceipt` needs only READ on the
// project, so any member of any shared project can drive it; the per-minute
// cap bounds the burst but 5/min sustained is >7,000 messages/day, enough to
// exhaust a typical relay plan in under two days. 60/day is far above any
// genuine "send me that one again" and nowhere near a plan-destroying volume.
export const EMAIL_RECEIPT_RATE_LIMIT_PER_DAY = 60;

const ONE_DAY_SECONDS = 24 * 60 * 60;

export async function checkEmailReceiptRateLimit(
  redis: RateLimitRedis,
  userId: string,
): Promise<RateLimitResult> {
  const perMinute = await checkRateLimit(
    redis,
    `email_receipt_rate:${userId}`,
    1,
    EMAIL_RECEIPT_RATE_LIMIT_PER_MIN,
  );
  if (!perMinute.allowed) return perMinute;

  // Checked second, and it consumes from the daily budget only once the
  // per-minute budget has already admitted the request — so a client hammering
  // past the minute limit cannot burn the day's allowance doing it.
  return checkWindowedRateLimit(
    redis,
    `email_receipt_daily:${userId}`,
    1,
    EMAIL_RECEIPT_RATE_LIMIT_PER_DAY,
    ONE_DAY_SECONDS,
  );
}
