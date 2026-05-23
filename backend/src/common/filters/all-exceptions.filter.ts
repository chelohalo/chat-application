import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // If a stream already started writing, the connection is half-broken and
    // we can't change the status code. Just close it; the consumer will see
    // EOF and surface "Connection lost".
    if (res.headersSent) {
      this.logger.warn(
        `Exception after headers sent on ${req.method} ${req.url}: ${(exception as Error).message}`,
      );
      try {
        res.end();
      } catch {
        /* swallow */
      }
      return;
    }

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = isHttp ? exception.getResponse() : null;

    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? (payload as { message: string | string[] }).message
        : isHttp
          ? exception.message
          : 'Internal server error';

    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : HttpStatus[status] ?? 'Error';

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    };

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status}: ${JSON.stringify(message)}`,
        (exception as Error).stack,
      );
    }

    res.status(status).json(body);
  }
}
