import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * A hand-rolled CORS middleware (the `security` topic's teaching artifact —
 * the `cors` npm package is the catalog mention, this is the mechanism).
 *
 * The whole lesson in one sentence: CORS is enforced by the BROWSER, not the
 * server. This middleware never blocks a request — it only DECIDES which
 * Access-Control-* headers to attach, and therefore which cross-origin calls
 * a browser will let its page read. A disallowed origin gets NO CORS headers
 * and the request still executes server-side (same-origin calls and curl are
 * unaffected); the browser is what refuses to hand the response to the page.
 *
 * Shape deliberately mirrors the `cors` package's options so the catalog
 * mention maps 1:1: an exact-match ORIGIN ALLOWLIST (never a regex over
 * arbitrary origins, never an echo of the request's Origin), methods,
 * headers, credentials, and a preflight cache max-age.
 */

export interface CorsOptions {
  /** Exact-match origin allowlist ("scheme://host[:port]", no trailing slash). */
  origins: readonly string[];
  /** Methods the allowlisted origins may use (also answers preflights). */
  methods?: readonly string[];
  /** Request headers a preflight may promise (Access-Control-Request-Headers). */
  headers?: readonly string[];
  /** Allow cookies/credentials on cross-origin calls (see below before enabling). */
  credentials?: boolean;
  /** How long a browser may cache one preflight answer (Access-Control-Max-Age). */
  maxAgeSeconds?: number;
}

const DEFAULT_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_HEADERS: readonly string[] = ['Content-Type', 'Authorization'];

/** Origin comparison is exact and case-normalized — allowlist means allowlist. */
function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase();
}

/**
 * The single decision the middleware AND the /cors-check demo endpoint share:
 * is this Origin string on the allowlist, and what ACAO would it earn?
 *
 * Returns the origin to echo (the allowlisted spelling) or null for "no CORS
 * headers" — a null is NOT an error, it is "the browser will block this page
 * from reading the response".
 */
export function evaluateCorsOrigin(
  options: CorsOptions,
  origin: string,
): { allowed: boolean; allowOrigin: string | null; credentials: boolean } {
  const normalized = normalizeOrigin(origin);
  const match = options.origins.find((allowed) => normalizeOrigin(allowed) === normalized);
  return {
    allowed: match !== undefined,
    // Echo the ALLOWLISTED spelling, never the raw request value: with
    // credentials on, Access-Control-Allow-Origin MUST be a single concrete
    // origin — "*" and origin-reflection are how credentialed CORS leaks.
    allowOrigin: match ?? null,
    credentials: options.credentials === true,
  };
}

/**
 * corsMiddleware(options) — mount it and every response under the mount point
 * learns to speak CORS:
 *
 *   actual request, allowed origin  → Access-Control-Allow-Origin (+Vary)
 *   OPTIONS preflight, allowed      → + Allow-Methods/Headers/Max-Age, 204
 *   anything else                   → no CORS headers, request proceeds
 *
 * Every response that consulted the Origin carries `Vary: Origin` — caches
 * must not serve one origin's allowed response to another origin's request.
 */
export function corsMiddleware(options: CorsOptions): RequestHandler {
  const methods = (options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase());
  const headers = options.headers ?? DEFAULT_HEADERS;
  const maxAgeSeconds = options.maxAgeSeconds ?? 600;

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    // No Origin header = same-origin navigation or a non-browser client —
    // CORS has nothing to say; set nothing and continue.
    if (typeof origin !== 'string' || origin === '') {
      next();
      return;
    }

    // The response differs by Origin, whatever we decide below.
    res.setHeader('Vary', 'Origin');

    const verdict = evaluateCorsOrigin(options, origin);
    if (!verdict.allowed) {
      // DENIED — by NOT adding headers, not by erroring: the server ran the
      // request fine; the calling page's browser is the one that will refuse
      // to expose the response. (A preflight it refuses up front.)
      next();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', verdict.allowOrigin as string);
    if (verdict.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // A CORS preflight = OPTIONS + Origin + Access-Control-Request-Method
    // (the fetch spec's exact definition). Answer it here and end with 204 —
    // no route handler ever sees preflights.
    const isPreflight =
      req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
    if (isPreflight) {
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
      res.setHeader('Access-Control-Max-Age', String(maxAgeSeconds));
      res.status(204).end();
      return;
    }

    next();
  };
}
