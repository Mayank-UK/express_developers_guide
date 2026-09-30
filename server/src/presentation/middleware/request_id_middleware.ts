import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Stamps every request with a correlation id before anything else runs, so
 * both success responses and the error envelope can echo it (x-request-id
 * header + res.locals.requestId). Must be mounted FIRST — see src/app.ts.
 *
 * It also stamps requestStartedAt (performance.now()), making EVERY request
 * self-timing: any later handler can compute the pre-route elapsed time as
 * performance.now() - res.locals.requestStartedAt. The architecture topic's
 * request-flow tracer is the first consumer; nothing else reads it (yet).
 */
export function requestIdMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.locals.requestStartedAt = performance.now();
  res.setHeader('x-request-id', requestId);
  next();
}
