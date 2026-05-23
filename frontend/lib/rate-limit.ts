/**
 * Per-session sliding-window rate limiter for the BFF /api/chat route.
 *
 * Keyed by sessionId. Allows up to MAX requests within WINDOW_MS.
 * State lives in a module-level Map, which works because Next.js Route Handlers
 * run in the Node.js runtime by default and share process memory.
 *
 * Limits: ≤ 20 requests per hour per session (bonus requirement).
 */

const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS = 20;

interface Window {
  timestamps: number[];
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the next request would be allowed (only when !allowed). */
  retryAfterSec: number;
  /** UNIX millis when the window will fully reset. */
  resetAtMs: number;
}

export function checkRateLimit(
  sessionId: string,
  now: number = Date.now(),
): RateLimitResult {
  const cutoff = now - WINDOW_MS;
  const w = windows.get(sessionId) ?? { timestamps: [] };
  // Drop expired entries.
  w.timestamps = w.timestamps.filter((t) => t > cutoff);

  if (w.timestamps.length >= MAX_REQUESTS) {
    const oldest = w.timestamps[0];
    const retryAfterMs = oldest + WINDOW_MS - now;
    windows.set(sessionId, w);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      resetAtMs: oldest + WINDOW_MS,
    };
  }

  w.timestamps.push(now);
  windows.set(sessionId, w);
  return {
    allowed: true,
    remaining: MAX_REQUESTS - w.timestamps.length,
    retryAfterSec: 0,
    resetAtMs: now + WINDOW_MS,
  };
}

/** Test helper: clear all rate-limit state. */
export function __resetRateLimit(): void {
  windows.clear();
}

export const RATE_LIMIT_CONFIG = { WINDOW_MS, MAX_REQUESTS } as const;
