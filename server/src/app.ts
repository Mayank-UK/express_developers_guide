import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { apiRouter } from './presentation/routes/index.js';
import { docsRouter } from './presentation/routes/docs_routes.js';
import { webhookJsonBodyParser } from './presentation/routes/webhooks_demo_routes.js';
import { errorHandler } from './presentation/middleware/error_middleware.js';
import { requestIdMiddleware } from './presentation/middleware/request_id_middleware.js';
import { requestLoggerMiddleware } from './presentation/middleware/request_logger_middleware.js';
import { traceMiddleware } from './presentation/middleware/trace_middleware.js';

/**
 * Builds the Express app without binding a port, so Supertest can exercise it
 * and server.ts owns the listening socket / lifecycle.
 *
 * Middleware order is load-bearing: request-id first (so even errors carry a
 * correlation id), then the request logger (it needs that id + the start
 * stamp, and must wrap every route including the 404 catch-all), then
 * security headers, then body parsing, then routes, then
 * the 404 catch-all, and the error handler last.
 *
 * Body parsing is the webhook demo's raw-body-capturing json parser (same
 * express.json() semantics for every route, its 100kb body limit PINNED
 * explicitly rather than inherited from body-parser's default — see the
 * parser's own comment in webhooks_demo_routes.ts; it additionally stashes
 * the raw buffer for POST /api/demo/webhooks/receive, whose HMAC signature is
 * computed over the exact bytes — see webhooks_demo_routes.ts). It lives HERE
 * because capture must happen inside the one root parse, before any route
 * runs.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  // Distributed-trace ids ride BESIDE the request id (trace_middleware.ts):
  // requestId stays this process's log-correlation key; traceId is the
  // cross-service identity continued from any inbound traceparent header and
  // echoed on EVERY response. Mounted after requestId (which it must not
  // touch) and before the request logger + routes.
  app.use(traceMiddleware);
  app.use(requestLoggerMiddleware);

  // SECURITY HEADERS, for real: helmet on every response, before any route
  // can answer. The CSP below is written out EXPLICITLY (pinned, commented)
  // rather than inherited from helmet's defaults — the audit that produced it
  // is the realistic integration lesson of the security topic:
  //
  // - Swagger UI at /docs SURVIVES this policy as-is: its scripts are
  //   same-origin files (./swagger-ui-bundle.js → script-src 'self'), and its
  //   inline <style> blocks are covered by style-src 'unsafe-inline', which
  //   helmet's own defaults already carry (the oauth demo's consent page
  //   relies on the same allowance). No CSP loosening was needed — but that is
  //   a verified conclusion, not a guess: the docs specs stay green, and any
  //   future page wanting inline <script> must earn a nonce instead.
  // - upgrade-insecure-requests is a no-op on localhost (browsers treat it as
  //   potentially trustworthy) but would force https on LAN-IP dev visits.
  // - HSTS rides along on plain http in dev — browsers ignore it without TLS,
  //   which is exactly why it is safe to set early and MUST be set once real
  //   TLS terminates in front (see the deployment topic).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'base-uri': ["'self'"],
          'font-src': ["'self'", 'https:', 'data:'],
          'form-action': ["'self'"],
          'frame-ancestors': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'object-src': ["'none'"],
          'script-src': ["'self'"], // same-origin scripts only — /docs assets qualify
          'script-src-attr': ["'none'"], // no inline event handlers, ever
          'style-src': ["'self'", 'https:', "'unsafe-inline'"], // Swagger UI + consent page inline <style>
          'upgrade-insecure-requests': [],
        },
      },
    }),
  );

  app.use(webhookJsonBodyParser);

  // API surface.
  app.use('/api', apiRouter);

  // Documentation surface (Swagger UI at /docs + raw spec at
  // /docs/openapi.json). Mounted on the ROOT app, deliberately NOT under
  // /api: Swagger UI resolves its assets relative to its mount path, and
  // /docs beside /api is the conventional split — see docs_routes.ts.
  app.use(docsRouter);

  // 404 catch-all — plain middleware (no wildcard path), so it behaves the
  // same across Express 4/5 wildcard-syntax differences.
  app.use((req: Request, res: Response) => {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
    res.status(404).json({
      error: {
        code: 'not_found',
        message: `Cannot ${req.method} ${req.originalUrl}`,
        requestId,
      },
    });
  });

  // Error-handling middleware must be registered last.
  app.use(errorHandler);

  return app;
}

export const app: Express = createApp();
