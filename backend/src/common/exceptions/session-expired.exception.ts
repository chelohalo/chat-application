import { HttpException, HttpStatus } from '@nestjs/common';

export class SessionExpiredException extends HttpException {
  constructor(sessionId: string) {
    super(
      {
        statusCode: HttpStatus.GONE,
        error: 'Gone',
        message: `Session ${sessionId} has expired due to inactivity`,
      },
      HttpStatus.GONE,
    );
  }
}
