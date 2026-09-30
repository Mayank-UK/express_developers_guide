import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../core/logging/logger.js';
import { requestStarted, requestSettled } from '../../core/logging/request_metrics.js';

/**
 * The access log: ONE structured line per request, written when the response
 * FINISHES — not when the handler returns. The difference is the honest
 * number: 'finish' fires after the last byte of the response reached the
 * socket, so durationMs covers middleware + handler + serialization, exactly
 * what the client experienced. Logging at handler end would systematically
 * under-report (and miss streamed responses entirely).
 *
 * Mount order is load-bearing (see app.ts): AFTER the request-id middleware
 * (this reads res.locals.requestId and res.locals.requestStartedAt) and
 * BEFORE every route — including the 404 catch-all, so unknown paths get
 * their warn line too.
 *
 * Levels are the same discipline the error middleware follows: <400 info,
 * 4xx warn (client's problem — expected traffic noise), 5xx error (ours).
 * The line's reqId is the correlation key: grep it to line this access-log
 * entry up with the error middleware's failure record for the same request.
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  requestStarted();

  // The request-id middleware stamped this; the fallback keeps durationMs
  // meaningful (≥ 0) even if someone reorders the chain later.
  const startedAt =
    typeof res.locals.requestStartedAt === 'number' ? res.locals.requestStartedAt : performance.now();

  // Capture the path NOW, before next(): routers MUTATE req.url to be
  // relative to their mount point, so by the time 'finish' fires req.path
  // would read '/health' for a request to '/api/health'.
  const path = req.path;
  const method = req.method;

  // 'finish' = response fully sent; 'close' = connection died first (client
  // abort). The FIRST of the two wins; the settled guard makes the second a
  // no-op — this is also why inFlight can never leak on an aborted request.
  let settled = false;
  const settle = (aborted: boolean): void => {
    if (settled) return;
    settled = true;

    const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    const reqId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
    const line = { reqId, method, path, status: res.statusCode, durationMs };

    requestSettled(res.statusCode, durationMs);

    if (aborted) {
      // statusCode is whatever had been set when the connection died — often
      // still the 200 default, which is exactly why the line says 'aborted'.
      logger.warn({ ...line, aborted: true }, 'request aborted (connection closed early)');
      return;
    }
    if (res.statusCode >= 500) logger.error(line, 'request completed');
    else if (res.statusCode >= 400) logger.warn(line, 'request completed');
    else logger.info(line, 'request completed');
  };

  res.once('finish', () => settle(false));
  res.once('close', () => settle(true));

  next();
}
