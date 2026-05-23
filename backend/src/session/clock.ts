import { Injectable } from '@nestjs/common';

/**
 * Injectable wall-clock abstraction so tests can fast-forward time
 * without mocking global Date.now.
 */
export abstract class Clock {
  abstract now(): number;
}

@Injectable()
export class SystemClock extends Clock {
  now(): number {
    return Date.now();
  }
}
