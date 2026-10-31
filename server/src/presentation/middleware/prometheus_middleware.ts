import type { NextFunction, Request, Response } from 'express';
import { observeHttpDuration } from '../../core/metrics/prometheus_metrics.js';

/**
 * The prom-client observer: ONE histogram observation per settled request,
 * into the registry GET /metrics serves (core/metrics/prometheus_metrics.ts).
 *
 * It follows the request-logger middleware's settle discipline exactly (see
 * request_logger_middleware.ts — this file is its metrics twin):
 * - observation happens on the FIRST of response 'finish' / connection
 *   'close', so aborted requests are counted once and a request can never
 *   double-record;
 * - duration covers middleware + handler + serialization — the same honest
 *   wall-clock the access log prints, in SECONDS (the Prometheus convention)
 *   rather than milliseconds.
 *
 * The `route` label is the route PATTERN, reconstructed at settle time from
 * req.baseUrl + req.route.path (routing has run by then, and Express leaves
 * both on the request — /api/health reads back as '/api' + '/health').
 * Raw paths are deliberately NOT labeled: the 404 catch-all answers every
 * imaginable URL, and a path-labeled histogram would mint a new time series
 * per miss — unbounded cardinality. Unmatched requests all bucket as
 * 'unmatched'; patterns like /api/posts/:id collapse their instances too.
 *
 * Mount order (see app.ts): after the request-id/logger middleware, before
 * every route including the catch-all — so even 404s get observed.
 */
export function prometheusMiddleware(req: Request, res: Response, next: NextFunction): void {
  // The request-id middleware stamped this; the fallback keeps the duration
  // meaningful even if someone reorders the chain later (same guard as the
  // request logger).
  const startedAt =
    typeof res.locals.requestStartedAt === 'number' ? res.locals.requestStartedAt : performance.now();

  // First-of-two wins, same guard as the request logger.
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;

    // Route PATTERN, never the raw path (cardinality — see the header). The
    // typeof guard keeps a non-string route.path (RegExp/array in exotic
    // setups) from becoming a label at all.
    const routePath = req.route?.path;
    const route = typeof routePath === 'string' ? `${req.baseUrl}${routePath}` : 'unmatched';

    observeHttpDuration(
      { method: req.method, route, status: res.statusCode },
      (performance.now() - startedAt) / 1000,
    );
  };

  res.once('finish', () => settle());
  res.once('close', () => settle());

  next();
}
