import { Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Clock } from './clock';
import { Session, Turn, Role } from './session.types';
import { SESSION_IDLE_TIMEOUT_MS } from './session.constants';
import { SessionExpiredException } from '../common/exceptions/session-expired.exception';

@Injectable()
export class SessionService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly clock: Clock) {}

  create(): Session {
    const now = this.clock.now();
    const session: Session = {
      id: uuidv4(),
      createdAt: now,
      lastActivityAt: now,
      turns: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Get a session, enforcing idle expiry. Throws 404 if unknown,
   * 410 if it exists but has been idle past the timeout.
   */
  getActive(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    if (this.isExpired(session)) {
      // Evict on access so memory does not grow unbounded.
      this.sessions.delete(sessionId);
      throw new SessionExpiredException(sessionId);
    }
    return session;
  }

  /**
   * Append a turn and bump lastActivityAt. The caller must have already
   * obtained the session via getActive so idle expiry is enforced.
   */
  appendTurn(sessionId: string, role: Role, content: string): Turn {
    const session = this.getActive(sessionId);
    const turn: Turn = {
      turnIndex: session.turns.length,
      role,
      content,
      createdAt: this.clock.now(),
    };
    session.turns.push(turn);
    session.lastActivityAt = this.clock.now();
    return turn;
  }

  getHistory(sessionId: string): Turn[] {
    return this.getActive(sessionId).turns;
  }

  delete(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    this.sessions.delete(sessionId);
  }

  /** Internal: exposed for tests via type-safe helper. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private isExpired(session: Session): boolean {
    return this.clock.now() - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS;
  }
}
