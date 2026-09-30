import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RateLimitException } from '../../core/error_handling/exceptions.js';

/**
 * A hand-rolled FIXED-WINDOW rate limiter (the `security` topic's teaching
 * twin of express-rate-limit, which is mounted for real on /api/demo/security/
 * ping — this one serves /api/demo/security/handmade-ping and the topic walks
 * its code line by line).
 *
 * The algorithm in one breath: keep a Map of key → {count, resetAt}. A request
 * inside the window increments count; count over max → 429 with Retry-After.
 * When now >= resetAt the window has rolled — the entry resets and the count
 * starts over. That's the whole fixed window: O(1) per request, one Map entry
 * per client, and a boundary burst of up to 2×max at a window seam (the
 * honest weakness, taught in the topic; sliding windows and token buckets are
 * the upgrades).
 *
 * The 429 goes through the app's ONE error taxonomy (RateLimitException →
 * rate_limited failure → the canonical envelope), so clients see the same
 * error shape as every other failure — plus x-ratelimit/retry-after headers.
 */

export interface HandmadeRateLimiterOptions {
  /** Window length in milliseconds (the fixed window). */
  windowMs: number;
  /** Requests allowed per window before the 429s start. */
  max: number;
  /** Names the limit in the 429 envelope (which limiter fired). */
  name: string;
}

/** One client's window: how many hits, and when the window rolls over. */
interface WindowEntry {
  count: number;
  resetAt: number;
}

/** Sweep the Map every N checks so dead clients' entries can't accumulate. */
const SWEEP_EVERY_CHECKS = 64;

/**
 * Normalize request IPs to one key. Node represents IPv4 loopback as an
 * IPv4-mapped IPv6 address ("::ffff:127.0.0.1") in some setups and as plain
 * "127.0.0.1" in others (Supertest vs a real socket) — without stripping the
 * prefix, one physical client could hold TWO windows and double the limit.
 */
export function normalizeClientIp(ip: string | undefined): string {
  const raw = ip ?? 'unknown';
  return raw.startsWith('::ffff:') && raw.includes('.') ? raw.slice('::ffff:'.length) : raw;
}

export interface HandmadeRateLimiter extends RequestHandler {
  /** Test hook: wipe every window so suites start from a clean slate. */
  reset(): void;
  /** Read-only peek for teaching/inspection. */
  snapshot(): ReadonlyMap<string, WindowEntry>;
}

export function createHandmadeRateLimiter(options: HandmadeRateLimiterOptions): HandmadeRateLimiter {
  const { windowMs, max, name } = options;
  const windows = new Map<string, WindowEntry>();
  let checks = 0;

  /** Drop entries whose window has rolled — amortized memory bound. */
  function sweep(now: number): void {
    for (const [key, entry] of windows) {
      if (now >= entry.resetAt) windows.delete(key);
    }
  }

  const limiter = ((req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    checks += 1;
    if (checks % SWEEP_EVERY_CHECKS === 0) sweep(now);

    const key = normalizeClientIp(req.ip);
    let entry = windows.get(key);
    if (entry === undefined || now >= entry.resetAt) {
      // First hit, or the window rolled — a fresh window starts now.
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }

    const remaining = Math.max(0, max - entry.count - 1);
    const resetAtSeconds = Math.ceil(entry.resetAt / 1000);
    const retryAfterSeconds = Math.max(0, Math.ceil((entry.resetAt - now) / 1000));
    // Retry-After and x-ratelimit-* are set BEFORE any throw so they survive
    // into the error envelope response (headers already on res persist).
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetAtSeconds));

    if (entry.count >= max) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      throw new RateLimitException(
        `too many requests to ${name}: limit is ${String(max)} per ${String(Math.ceil(windowMs / 1000))}s window — retry after ${String(retryAfterSeconds)}s`,
        {
          limiter: name,
          limit: max,
          windowSeconds: Math.ceil(windowMs / 1000),
          retryAfterSeconds,
          resetAt: new Date(entry.resetAt).toISOString(),
          keyedBy: 'client ip (normalized)',
        },
      );
    }

    entry.count += 1;
    res.locals.handmadeRateLimit = {
      limiter: name,
      count: entry.count,
      limit: max,
      remaining: Math.max(0, max - entry.count),
      windowSeconds: Math.ceil(windowMs / 1000),
      resetAt: new Date(entry.resetAt).toISOString(),
    };
    next();
  }) as HandmadeRateLimiter;

  limiter.reset = (): void => {
    windows.clear();
  };
  limiter.snapshot = (): ReadonlyMap<string, WindowEntry> => windows;

  return limiter;
}
