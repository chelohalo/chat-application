import { NotFoundException } from '@nestjs/common';
import { SessionService } from './session.service';
import { Clock } from './clock';
import { SESSION_IDLE_TIMEOUT_MS } from './session.constants';
import { SessionExpiredException } from '../common/exceptions/session-expired.exception';

class FakeClock extends Clock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

describe('SessionService', () => {
  let clock: FakeClock;
  let svc: SessionService;

  beforeEach(() => {
    clock = new FakeClock();
    clock.set(1_000_000);
    svc = new SessionService(clock);
  });

  it('creates a session with a UUID and empty history', () => {
    const s = svc.create();
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.turns).toEqual([]);
    expect(s.createdAt).toBe(1_000_000);
    expect(s.lastActivityAt).toBe(1_000_000);
  });

  it('retrieves turns in order with incrementing turnIndex', () => {
    const s = svc.create();
    svc.appendTurn(s.id, 'user', 'hello');
    svc.appendTurn(s.id, 'assistant', 'hi there');
    const turns = svc.getHistory(s.id);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ turnIndex: 0, role: 'user', content: 'hello' });
    expect(turns[1]).toMatchObject({ turnIndex: 1, role: 'assistant', content: 'hi there' });
  });

  it('throws NotFound for unknown session id', () => {
    expect(() => svc.getActive('00000000-0000-4000-8000-000000000000')).toThrow(
      NotFoundException,
    );
    expect(() => svc.getHistory('nope')).toThrow(NotFoundException);
    expect(() => svc.delete('nope')).toThrow(NotFoundException);
  });

  it('expires a session after 30 minutes of inactivity (clock-driven)', () => {
    const s = svc.create();
    clock.advance(SESSION_IDLE_TIMEOUT_MS); // exactly at boundary => still active
    expect(() => svc.getActive(s.id)).not.toThrow();

    clock.advance(1); // one ms past boundary
    expect(() => svc.getActive(s.id)).toThrow(SessionExpiredException);
  });

  it('appending a turn refreshes the idle window', () => {
    const s = svc.create();
    clock.advance(SESSION_IDLE_TIMEOUT_MS - 1);
    svc.appendTurn(s.id, 'user', 'still here');
    clock.advance(SESSION_IDLE_TIMEOUT_MS); // boundary from last touch
    expect(() => svc.getActive(s.id)).not.toThrow();
  });

  it('evicts expired session on access so subsequent calls return 404', () => {
    const s = svc.create();
    clock.advance(SESSION_IDLE_TIMEOUT_MS + 1);
    expect(() => svc.getActive(s.id)).toThrow(SessionExpiredException);
    // After eviction, a second access is 404 (unknown), not 410.
    expect(() => svc.getActive(s.id)).toThrow(NotFoundException);
  });

  it('delete removes a known session', () => {
    const s = svc.create();
    svc.delete(s.id);
    expect(svc.has(s.id)).toBe(false);
    expect(() => svc.getActive(s.id)).toThrow(NotFoundException);
  });
});
