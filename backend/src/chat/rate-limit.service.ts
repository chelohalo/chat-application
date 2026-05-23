import { Injectable } from '@nestjs/common';

/**
 * Per-session two-window sliding rate limiter.
 *
 * Each session is allowed up to:
 *   - HOUR_MAX requests within HOUR_WINDOW_MS (sustained quota)
 *   - MINUTE_MAX requests within MINUTE_WINDOW_MS (burst guard)
 *
 * On a deny, the closer reset wins so the caller's Retry-After is as low
 * as possible (no point asking them to wait an hour if only the minute
 * burst tripped).
 *
 * State is kept in process memory — same constraint as the in-memory
 * SessionStore, fine for a single-instance deployment. Each consume()
 * call evicts expired timestamps and drops the Map entry entirely when
 * both windows are empty, so inactive sessions don't linger forever.
 *
 * Mirrors `frontend/lib/rate-limit.ts` on purpose: the BFF early-rejects
 * with the same limits to spare the backend, but the backend is the
 * authoritative gate that cannot be bypassed by hitting NestJS directly.
 */

const HOUR_MAX = 20;
const HOUR_WINDOW_MS = 60 * 60 * 1000;
const MINUTE_MAX = 5;
const MINUTE_WINDOW_MS = 60 * 1000;

export const RATE_LIMIT_CONFIG = {
  HOUR_MAX,
  HOUR_WINDOW_MS,
  MINUTE_MAX,
  MINUTE_WINDOW_MS,
} as const;

interface Buckets {
  hourTs: number[];
  minuteTs: number[];
}

export type RateLimitDecision =
  | {
      allowed: true;
      remaining: { hour: number; minute: number };
    }
  | {
      allowed: false;
      retryAfterSec: number;
      reason: 'minute' | 'hour';
    };

@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<string, Buckets>();

  consume(sessionId: string, now: number = Date.now()): RateLimitDecision {
    const hourCutoff = now - HOUR_WINDOW_MS;
    const minuteCutoff = now - MINUTE_WINDOW_MS;

    const existing = this.buckets.get(sessionId);
    const b: Buckets = existing ?? { hourTs: [], minuteTs: [] };
    b.hourTs = b.hourTs.filter((t) => t > hourCutoff);
    b.minuteTs = b.minuteTs.filter((t) => t > minuteCutoff);

    // Decide which (if any) window denies the request. If both deny, the
    // one with the soonest reset is the friendlier Retry-After.
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

      // Persist filtered arrays so a long-idle session doesn't carry
      // stale timestamps forever; evict empty entries entirely.
      this.persist(sessionId, b);

      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        reason,
      };
    }

    b.hourTs.push(now);
    b.minuteTs.push(now);
    this.persist(sessionId, b);

    return {
      allowed: true,
      remaining: {
        hour: HOUR_MAX - b.hourTs.length,
        minute: MINUTE_MAX - b.minuteTs.length,
      },
    };
  }

  private persist(sessionId: string, b: Buckets): void {
    if (b.hourTs.length === 0 && b.minuteTs.length === 0) {
      this.buckets.delete(sessionId);
    } else {
      this.buckets.set(sessionId, b);
    }
  }

  /** Test helper. */
  reset(): void {
    this.buckets.clear();
  }

  /** Test helper. */
  size(): number {
    return this.buckets.size;
  }
}
