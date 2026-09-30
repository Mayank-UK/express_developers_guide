import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { RateLimitException } from '../../core/error_handling/exceptions.js';
import {
  createHandmadeRateLimiter,
  type HandmadeRateLimiter,
} from './handmade_rate_limiter.js';

// Unit twin of security_demo_routes.spec.ts's mounted view: here we drive the
// factory DIRECTLY with mock req/res objects so the cases the route spec can't
// reach (per-IP buckets, reset(), window rollover, limit=1) become assertable.

/** The middleware touches only req.ip, res.setHeader, and res.locals. */
function makeReq(ip: string | undefined): Request {
  return { ip } as Request;
}

function makeRes(): Response & { headers: Record<string, string>; locals: Record<string, unknown> } {
  const headers: Record<string, string> = {};
  const res = {
    locals: {},
    setHeader: (key: string, value: string): void => {
      headers[key] = value;
    },
  };
  return Object.assign(res, { headers }) as unknown as Response & {
    headers: Record<string, string>;
    locals: Record<string, unknown>;
  };
}

/**
 * The limiter THROWS its RateLimitException synchronously (the mounted app's
 * error middleware renders it) — run() surfaces whichever way a hit went.
 */
function run(
  limiter: HandmadeRateLimiter,
  ip: string | undefined,
  res = makeRes(),
): { error: unknown; res: typeof res; next: ReturnType<typeof vi.fn> } {
  const next = vi.fn();
  try {
    limiter(makeReq(ip), res, next);
  } catch (error) {
    return { error, res, next };
  }
  return { error: null, res, next };
}

describe('createHandmadeRateLimiter (unit)', () => {
  const NAME = 'login-limiter';
  const WINDOW_MS = 30_000;

  let limiter: HandmadeRateLimiter;

  beforeEach(() => {
    limiter = createHandmadeRateLimiter({ windowMs: WINDOW_MS, max: 3, name: NAME });
  });

  describe('counts down the window, then 429s', () => {
    it('allowed hits pass through next() with the x-ratelimit suite and locals bookkeeping', () => {
      const { error, res, next } = run(limiter, '9.9.9.9');

      expect(error).toBeNull();
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.headers['X-RateLimit-Limit']).toBe('3');
      expect(res.headers['X-RateLimit-Remaining']).toBe('2');
      expect(res.headers['X-RateLimit-Reset']).toMatch(/^\d+$/);
      expect(res.headers['Retry-After']).toBeUndefined();
      expect(res.locals.handmadeRateLimit).toMatchObject({
        limiter: NAME,
        count: 1,
        limit: 3,
        remaining: 2,
        windowSeconds: 30,
      });
    });

    it('the hit after max throws RateLimitException carrying the canonical rate_limited details', () => {
      for (let i = 0; i < 3; i += 1) run(limiter, '9.9.9.9');

      const { error, res, next } = run(limiter, '9.9.9.9');

      // The route spec renders the envelope; the UNIT contract is that the
      // thrown exception maps to rate_limited/429 and names itself in details.
      expect(error).toBeInstanceOf(RateLimitException);
      const err = error as RateLimitException;
      expect(err.statusCode).toBe(429);
      expect(err.code).toBe('rate_limited');
      expect(err.message).toContain(NAME);
      expect(err.message).toContain('3 per 30s window');
      expect(err.failure.details).toMatchObject({
        limiter: NAME,
        limit: 3,
        windowSeconds: 30,
        keyedBy: 'client ip (normalized)',
      });
      const details = err.failure.details as Record<string, unknown>;
      expect(details.retryAfterSeconds).toBeLessThanOrEqual(30);
      expect(details.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO instant

      // Headers are set BEFORE the throw so they survive into the envelope.
      expect(res.headers['Retry-After']).toMatch(/^\d+$/);
      expect(res.headers['X-RateLimit-Remaining']).toBe('0');
      expect(next).not.toHaveBeenCalled();
    });

    it('max=1 allows exactly one hit — the tightest window', () => {
      const single = createHandmadeRateLimiter({ windowMs: WINDOW_MS, max: 1, name: 'one-shot' });

      const first = run(single, '9.9.9.9');
      expect(first.error).toBeNull();
      expect(first.res.headers['X-RateLimit-Remaining']).toBe('0'); // spent on the first hit

      expect(run(single, '9.9.9.9').error).toBeInstanceOf(RateLimitException);
    });
  });

  it('per-IP buckets are independent — one client exhausting does not touch another', () => {
    const strict = createHandmadeRateLimiter({ windowMs: WINDOW_MS, max: 1, name: NAME });

    expect(run(strict, '1.1.1.1').error).toBeNull();
    expect(run(strict, '1.1.1.1').error).toBeInstanceOf(RateLimitException);

    // A different client still has its own full window…
    expect(run(strict, '2.2.2.2').error).toBeNull();
    // …and the IPv4-mapped spelling of the FIRST client shares its bucket
    // (normalizeClientIp: one physical client, one window).
    expect(run(strict, '::ffff:1.1.1.1').error).toBeInstanceOf(RateLimitException);

    expect([...strict.snapshot().keys()].sort()).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('reset() wipes every window — the test seam gives a clean slate', () => {
    expect(run(limiter, '1.1.1.1').error).toBeNull();
    expect(run(limiter, '1.1.1.1').error).toBeNull();
    expect(run(limiter, '1.1.1.1').error).toBeNull();
    expect(run(limiter, '1.1.1.1').error).toBeInstanceOf(RateLimitException);

    limiter.reset();
    expect(limiter.snapshot().size).toBe(0);

    const after = run(limiter, '1.1.1.1');
    expect(after.error).toBeNull();
    expect(after.res.locals.handmadeRateLimit).toMatchObject({ count: 1, remaining: 2 });
  });

  describe('window rollover (fake clock)', () => {
    // The limiter reads Date.now() directly — there is no injectable clock
    // seam (by design: it mirrors what a real mounted middleware sees), so a
    // surgical spy on Date.now is the ONLY deterministic way to roll a window
    // in a unit test. Restored in afterEach.
    const T0 = 1_700_000_000_000;
    let nowSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it('a rolled window starts a fresh count — the blocked client is free again', () => {
      const short = createHandmadeRateLimiter({ windowMs: 1_000, max: 2, name: 'short' });

      expect(run(short, '1.1.1.1').error).toBeNull();
      expect(run(short, '1.1.1.1').error).toBeNull();
      expect(run(short, '1.1.1.1').error).toBeInstanceOf(RateLimitException);

      // Halfway through the window: still blocked, Retry-After rounds up.
      nowSpy.mockReturnValue(T0 + 500);
      const mid = run(short, '1.1.1.1');
      expect(mid.error).toBeInstanceOf(RateLimitException);
      expect(mid.res.headers['Retry-After']).toBe('1');

      // At the reset instant (now >= resetAt) the window has rolled.
      nowSpy.mockReturnValue(T0 + 1_000);
      const fresh = run(short, '1.1.1.1');
      expect(fresh.error).toBeNull();
      expect(fresh.res.locals.handmadeRateLimit).toMatchObject({ count: 1, remaining: 1 });
    });
  });
});
