/**
 * Per-session two-window sliding rate limiter for the BFF /api/chat route.
 *
 * Each session is allowed:
 *   - HOUR_MAX requests within HOUR_WINDOW_MS (sustained quota)
 *   - MINUTE_MAX requests within MINUTE_WINDOW_MS (burst guard)
 *
 * When denying, the window with the closer reset wins so the caller's
 * Retry-After hint is as low as possible.
 *
 * State lives in a module-level Map; Next.js Route Handlers run in the
 * Node.js runtime by default and share process memory across requests.
 *
 * This mirrors `backend/src/chat/rate-limit.service.ts` deliberately so
 * the BFF early-rejects with the same rules as the backend. The backend
 * remains the authoritative gate.
 */

const HOUR_WINDOW_MS = 60 * 60 * 1000;
const HOUR_MAX = 20;
const MINUTE_WINDOW_MS = 60 * 1000;
const MINUTE_MAX = 5;

interface Buckets {
  hourTs: number[];
  minuteTs: number[];
}

const buckets = new Map<string, Buckets>();

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining budget in each window when allowed. */
  remaining: { hour: number; minute: number };
  /** Seconds until the next request would be allowed (only when !allowed). */
  retryAfterSec: number;
  /** Which window tripped, when denied. */
  reason: 'minute' | 'hour' | null;
}

export function checkRateLimit(
  sessionId: string,
  now: number = Date.now(),
): RateLimitResult {
  const hourCutoff = now - HOUR_WINDOW_MS;
  const minuteCutoff = now - MINUTE_WINDOW_MS;

  const b = buckets.get(sessionId) ?? { hourTs: [], minuteTs: [] };
  b.hourTs = b.hourTs.filter((t) => t > hourCutoff);
  b.minuteTs = b.minuteTs.filter((t) => t > minuteCutoff);

  const minuteFull = b.minuteTs.length >= MINUTE_MAX;
  const hourFull = b.hourTs.length >= HOUR_MAX;

  if (minuteFull || hourFull) {
    const minuteRetryMs = minuteFull
      ? b.minuteTs[0] + MINUTE_WINDOW_MS - now
      : Number.POSITIVE_INFINITY;
    const hourRetryMs = hourFull
      ? b.hourTs[0] + HOUR_WINDOW_MS - now
      : Number.POSITIVE_INFINITY;

    const reason: 'minute' | 'hour' =
      minuteRetryMs <= hourRetryMs ? 'minute' : 'hour';
    const retryAfterMs = reason === 'minute' ? minuteRetryMs : hourRetryMs;

    persist(sessionId, b);

    return {
      allowed: false,
      remaining: {
        hour: Math.max(0, HOUR_MAX - b.hourTs.length),
        minute: Math.max(0, MINUTE_MAX - b.minuteTs.length),
      },
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      reason,
    };
  }

  b.hourTs.push(now);
  b.minuteTs.push(now);
  persist(sessionId, b);

  return {
    allowed: true,
    remaining: {
      hour: HOUR_MAX - b.hourTs.length,
      minute: MINUTE_MAX - b.minuteTs.length,
    },
    retryAfterSec: 0,
    reason: null,
  };
}

function persist(sessionId: string, b: Buckets): void {
  if (b.hourTs.length === 0 && b.minuteTs.length === 0) {
    buckets.delete(sessionId);
  } else {
    buckets.set(sessionId, b);
  }
}

/** Test helper: clear all rate-limit state. */
export function __resetRateLimit(): void {
  buckets.clear();
}

export const RATE_LIMIT_CONFIG = {
  HOUR_WINDOW_MS,
  HOUR_MAX,
  MINUTE_WINDOW_MS,
  MINUTE_MAX,
} as const;
