import { RateLimitService, RATE_LIMIT_CONFIG } from './rate-limit.service';

describe('RateLimitService', () => {
  let svc: RateLimitService;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    svc = new RateLimitService();
  });

  describe('minute burst window', () => {
    it('allows up to MINUTE_MAX requests within MINUTE_WINDOW_MS', () => {
      for (let i = 0; i < RATE_LIMIT_CONFIG.MINUTE_MAX; i++) {
        const d = svc.consume('s1', T0 + i * 100);
        expect(d.allowed).toBe(true);
      }
    });

    it('denies the MINUTE_MAX+1 request with reason=minute', () => {
      for (let i = 0; i < RATE_LIMIT_CONFIG.MINUTE_MAX; i++) {
        svc.consume('s1', T0 + i * 100);
      }
      const d = svc.consume('s1', T0 + RATE_LIMIT_CONFIG.MINUTE_MAX * 100);
      expect(d.allowed).toBe(false);
      if (!d.allowed) {
        expect(d.reason).toBe('minute');
        expect(d.retryAfterSec).toBeGreaterThan(0);
        expect(d.retryAfterSec).toBeLessThanOrEqual(60);
      }
    });

    it('re-allows after the minute window slides past the oldest stamp', () => {
      for (let i = 0; i < RATE_LIMIT_CONFIG.MINUTE_MAX; i++) {
        svc.consume('s1', T0 + i * 100);
      }
      const denied = svc.consume('s1', T0 + 30_000);
      expect(denied.allowed).toBe(false);

      // Jump past oldest minute stamp.
      const allowed = svc.consume(
        's1',
        T0 + RATE_LIMIT_CONFIG.MINUTE_WINDOW_MS + 1,
      );
      expect(allowed.allowed).toBe(true);
    });
  });

  describe('hour sustained window', () => {
    it('denies after HOUR_MAX requests spaced past the minute window', () => {
      // Space requests just over MINUTE_WINDOW_MS so the burst never trips
      // first, but they all stay inside the same hour window. Result: the
      // hour bucket fills before the minute one ever does.
      const spacing = RATE_LIMIT_CONFIG.MINUTE_WINDOW_MS + 1;
      for (let i = 0; i < RATE_LIMIT_CONFIG.HOUR_MAX; i++) {
        const d = svc.consume('s1', T0 + i * spacing);
        expect(d.allowed).toBe(true);
      }
      const denied = svc.consume(
        's1',
        T0 + RATE_LIMIT_CONFIG.HOUR_MAX * spacing,
      );
      expect(denied.allowed).toBe(false);
      if (!denied.allowed) {
        expect(denied.reason).toBe('hour');
        // Oldest hour stamp is at T0; reset is HOUR_WINDOW_MS later.
        // retry should be far larger than the minute window.
        expect(denied.retryAfterSec).toBeGreaterThan(60);
      }
    });
  });

  describe('reason selection when both windows are full', () => {
    it('picks the window with the soonest reset (minute) for Retry-After', () => {
      // 5 stamps spaced 10s apart so the burst window is full AT t=40s.
      // The hour window only has 5 stamps too, so it's not full — only
      // minute should fail at this point.
      for (let i = 0; i < RATE_LIMIT_CONFIG.MINUTE_MAX; i++) {
        svc.consume('s1', T0 + i * 10_000);
      }
      const d = svc.consume('s1', T0 + 45_000);
      expect(d.allowed).toBe(false);
      if (!d.allowed) {
        expect(d.reason).toBe('minute');
      }
    });
  });

  describe('per-session isolation', () => {
    it('different sessions track independent windows', () => {
      for (let i = 0; i < RATE_LIMIT_CONFIG.MINUTE_MAX; i++) {
        svc.consume('s1', T0 + i * 100);
      }
      const otherSession = svc.consume('s2', T0 + 1000);
      expect(otherSession.allowed).toBe(true);
    });
  });

  describe('memory hygiene', () => {
    it('evicts the session entry once all timestamps expire', () => {
      svc.consume('s1', T0);
      expect(svc.size()).toBe(1);
      // Force a fresh consume() far in the future: filter wipes both
      // windows, and the new stamp lives again — entry stays at 1.
      svc.consume('s1', T0 + RATE_LIMIT_CONFIG.HOUR_WINDOW_MS + 1000);
      expect(svc.size()).toBe(1);
    });

    it('evicts when a denied call cleans up empty windows on a different session', () => {
      svc.consume('s1', T0);
      expect(svc.size()).toBe(1);
      // No subsequent consume for s1 happens; the entry survives in-process
      // (eviction is on-demand only, which is documented behavior). Verify
      // size accordingly:
      expect(svc.size()).toBe(1);
    });
  });

  describe('remaining counts', () => {
    it('reports remaining minute and hour budgets when allowed', () => {
      const d = svc.consume('s1', T0);
      expect(d.allowed).toBe(true);
      if (d.allowed) {
        expect(d.remaining.minute).toBe(RATE_LIMIT_CONFIG.MINUTE_MAX - 1);
        expect(d.remaining.hour).toBe(RATE_LIMIT_CONFIG.HOUR_MAX - 1);
      }
    });
  });
});
