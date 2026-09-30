import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../core/logging/logger.js';
import { AppException } from '../../core/error_handling/exceptions.js';

/**
 * Canonical error-handling middleware (Express 5 forwards rejected promises
 * from async handlers here automatically). Every failure leaves the app in the
 * same envelope shape:
 *
 *   { error: { code, message, requestId } }
 *
 * AppExceptions contribute their failure's status/code/message, with the
 * failure's details merged into the envelope when present; anything else falls
 * back to best-effort extraction from unknown errors.
 *
 * ONE exception to "every failure gets an envelope": if the response already
 * started (headers flushed mid-stream — an SSE tick, a download that failed
 * partway), res.status() would itself throw ERR_HTTP_HEADERS_SENT and bury the
 * original error. In that case the middleware logs and delegates to Express's
 * default handler via next(err), which simply cuts the connection.
 */

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
}

function extractStatusCode(err: unknown): number {
  if (typeof err === 'object' && err !== null) {
    const candidate = err as HttpErrorLike;
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
    if (typeof candidate.status === 'number') return candidate.status;
  }
  return 500;
}

function extractCode(err: unknown, statusCode: number): string {
  if (typeof err === 'object' && err !== null) {
    const candidate = err as HttpErrorLike;
    if (typeof candidate.code === 'string') return candidate.code;
  }
  return statusCode >= 500 ? 'internal_error' : 'request_failed';
}

function extractMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  return 'Internal server error';
}

function extractRequestId(res: Response): string {
  const requestId = res.locals.requestId;
  return typeof requestId === 'string' && requestId !== '' ? requestId : 'n/a';
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = extractRequestId(res);

  // An error arriving AFTER the response started (an SSE ticker flushed its
  // headers, a download rejected mid-file) cannot be rendered — res.status()
  // would itself throw ERR_HTTP_HEADERS_SENT and bury the original failure.
  // Delegate to Express's default handler, which ends the connection.
  if (res.headersSent) {
    logger.error(
      { err, requestId },
      'error after response started — delegating to express default handler',
    );
    return next(err);
  }

  if (err instanceof AppException) {
    const { failure } = err;
    // Level discipline (the observability topic's refinement): 4xx is the
    // CLIENT's problem — expected traffic noise, warn; 5xx is OURS — error.
    // Same rule the request-logger middleware applies to its access lines.
    const logLine = { err, statusCode: err.statusCode, requestId, failureKind: failure.kind };
    if (err.statusCode >= 500) logger.error(logLine, 'request failed');
    else logger.warn(logLine, 'request failed');
    // Details merge under the canonical keys; canonical keys win on collision.
    const errorBody: Record<string, unknown> = {
      ...(failure.details ?? {}),
      code: err.code,
      message: failure.message,
      requestId,
    };
    res.status(err.statusCode).json({ error: errorBody });
    return;
  }

  const statusCode = extractStatusCode(err);

  // Same 4xx/5xx level split as the AppException branch (body-parser's 400s
  // land here too — they are warn, not error).
  if (statusCode >= 500) logger.error({ err, statusCode, requestId }, 'unhandled request error');
  else logger.warn({ err, statusCode, requestId }, 'unhandled request error');

  res.status(statusCode).json({
    error: {
      code: extractCode(err, statusCode),
      message: extractMessage(err),
      requestId,
    },
  });
}
