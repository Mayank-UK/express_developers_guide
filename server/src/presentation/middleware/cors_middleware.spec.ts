import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { corsMiddleware, evaluateCorsOrigin } from './cors_middleware.js';

// Unit twin of security_demo_routes.spec.ts's mounted CORS cases: here the
// factory runs against mock req/res objects, so the cases the route spec can't
// isolate (case normalization, the non-prefall OPTIONS fall-through, custom
// methods/max-age, the absent-wildcard contract) become directly assertable.
// The route-level integration (204 preflight, Vary, denial) stays there.

interface ResDouble {
  headers: Record<string, string>;
  ended: boolean;
  statusCode: number | undefined;
}

function makeReq(options: {
  method?: string;
  origin?: string | undefined;
  requestMethod?: string | undefined;
}): Request {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.requestMethod !== undefined) headers['access-control-request-method'] = options.requestMethod;
  return { method: options.method ?? 'GET', headers } as unknown as Request;
}

/**
 * The middleware touches setHeader, the status().end() preflight chain, and
 * nothing else; the double records headers verbatim plus the status/ended
 * outcome so assertions read real state, not methods.
 */
function makeRes(): Response & ResDouble {
  // Self-referencing double: state lives ON the res object the assertions read
  // (a separate record + Object.assign would copy primitives by value and the
  // mutations would vanish).
  const res = {
    headers: {} as Record<string, string>,
    ended: false,
    statusCode: undefined as number | undefined,
    setHeader: (key: string, value: string): void => {
      res.headers[key] = value;
    },
    status: (code: number): unknown => {
      res.statusCode = code;
      return res;
    },
    end: (): void => {
      res.ended = true;
    },
  };
  return res as unknown as Response & ResDouble;
}

/** Run the middleware once and report what it did to res/next. */
function run(
  middleware: RequestHandler,
  req: Request,
): { res: Response & ResDouble; next: NextFunction } {
  const res = makeRes();
  const next = vi.fn();
  middleware(req, res, next);
  return { res, next };
}

const ALLOWLIST = ['http://localhost:5173', 'https://example.com'] as const;

describe('corsMiddleware (unit)', () => {
  describe('actual (non-preflight) requests', () => {
    it('an allowlisted origin earns the ACAO echo of the allowlisted spelling — and nothing else', () => {
      const { res, next } = run(corsMiddleware({ origins: ALLOWLIST }), makeReq({ origin: 'https://example.com' }));

      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      expect(res.headers['Access-Control-Allow-Origin']).not.toBe('*'); // never a wildcard echo
      expect(res.headers['Vary']).toBe('Origin');
      // Credentials off by default — the header is absent, not 'false'.
      expect(res.headers['Access-Control-Allow-Credentials']).toBeUndefined();
      // An actual request always reaches the route: no short-circuit.
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.ended).toBe(false);
    });

    it('an unknown origin gets NO Access-Control-Allow-Origin — no reflection, but the request proceeds', () => {
      const { res, next } = run(corsMiddleware({ origins: ALLOWLIST }), makeReq({ origin: 'https://evil.example' }));

      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(res.headers['Access-Control-Allow-Credentials']).toBeUndefined();
      // The server never blocks: Vary was still consulted, next runs.
      expect(res.headers['Vary']).toBe('Origin');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('credentials: true adds Access-Control-Allow-Credentials to allowed origins', () => {
      const { res } = run(
        corsMiddleware({ origins: ALLOWLIST, credentials: true }),
        makeReq({ origin: 'https://example.com' }),
      );

      expect(res.headers['Access-Control-Allow-Credentials']).toBe('true');
    });

    it('origin matching is case-normalized: the allowlist spelling is echoed, whatever the case sent', () => {
      // Request uppercased, allowlist canonical → match, canonical echo.
      const upper = run(corsMiddleware({ origins: ALLOWLIST }), makeReq({ origin: 'HTTPS://EXAMPLE.COM' }));
      expect(upper.res.headers['Access-Control-Allow-Origin']).toBe('https://example.com');

      // Allowlist uppercased, request canonical → match, the ALLOWLIST's own
      // spelling is what gets echoed (the list is the source of truth).
      const loudList = corsMiddleware({ origins: ['HTTPS://Example.COM'] });
      const echo = run(loudList, makeReq({ origin: 'https://example.com' }));
      expect(echo.res.headers['Access-Control-Allow-Origin']).toBe('HTTPS://Example.COM');
    });

    it('no Origin header (same-origin / curl): CORS has nothing to say — not even Vary', () => {
      for (const origin of [undefined, '']) {
        const { res, next } = run(corsMiddleware({ origins: ALLOWLIST }), makeReq({ origin }));
        expect(res.headers['Vary']).toBeUndefined();
        expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
        expect(next).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('preflights (OPTIONS + Access-Control-Request-Method)', () => {
    it('an allowed-origin preflight short-circuits: 204, the full suite, and no next()', () => {
      const { res, next } = run(
        corsMiddleware({ origins: ALLOWLIST, credentials: true, methods: ['get', 'delete'], headers: ['X-Trace'], maxAgeSeconds: 60 }),
        makeReq({ method: 'OPTIONS', origin: 'http://localhost:5173', requestMethod: 'DELETE' }),
      );

      expect(res.statusCode).toBe(204);
      expect(res.ended).toBe(true);
      expect(next).not.toHaveBeenCalled(); // no route handler ever sees a preflight
      expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(res.headers['Access-Control-Allow-Credentials']).toBe('true');
      // Methods uppercased on the way out; custom headers and max-age pass through.
      expect(res.headers['Access-Control-Allow-Methods']).toBe('GET, DELETE');
      expect(res.headers['Access-Control-Allow-Headers']).toBe('X-Trace');
      expect(res.headers['Access-Control-Max-Age']).toBe('60');
      expect(res.headers['Vary']).toBe('Origin');
    });

    it('OPTIONS WITHOUT Access-Control-Request-Method is an actual request, not a preflight', () => {
      const { res, next } = run(corsMiddleware({ origins: ALLOWLIST }), makeReq({ method: 'OPTIONS', origin: 'https://example.com' }));

      expect(next).toHaveBeenCalledTimes(1); // falls through to the route
      expect(res.ended).toBe(false);
      expect(res.headers['Access-Control-Allow-Methods']).toBeUndefined();
      expect(res.headers['Access-Control-Max-Age']).toBeUndefined();
    });

    it('a DENIED preflight is not answered here — it falls through with no CORS headers', () => {
      const { res, next } = run(
        corsMiddleware({ origins: ALLOWLIST }),
        makeReq({ method: 'OPTIONS', origin: 'https://evil.example', requestMethod: 'GET' }),
      );

      // The denial happens BEFORE the preflight branch: the browser is the
      // blocker, so this middleware hands the request on rather than 204ing.
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.ended).toBe(false);
      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('there is no wildcard — an allowlist entry is an exact origin', () => {
    it("origins: ['*'] never grants a real origin anything", () => {
      const verdict = evaluateCorsOrigin({ origins: ['*'] }, 'https://example.com');
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowOrigin).toBeNull(); // '*' would be reflection-by-another-name
    });

    it("origins: ['*'] matches only a literally-sent 'Origin: *' (exact string equality)", () => {
      const verdict = evaluateCorsOrigin({ origins: ['*'] }, '*');
      expect(verdict.allowed).toBe(true);
      expect(verdict.allowOrigin).toBe('*');
    });
  });
});
