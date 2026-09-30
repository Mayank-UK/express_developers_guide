import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { logger } from '../../core/logging/logger.js';
import {
  resetRequestMetricsForTests,
  snapshotRequestMetrics,
} from '../../core/logging/request_metrics.js';
import { requestLoggerMiddleware } from './request_logger_middleware.js';

// Same logger-module mock as error_middleware.spec.ts: the real logger prints
// and tees into the in-memory ring (neither belongs in a unit spec), and the
// mock doubles as the spy for the level-discipline assertions below. The
// request_metrics module stays REAL (pure in-memory counters) so the
// started/settled lifecycle is asserted, not just assumed.

vi.mock('../../core/logging/logger.js', () => ({
  logger: {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

interface ResDouble {
  res: Response & { locals: Record<string, unknown>; statusCode: number };
}

function makeRes(locals: Record<string, unknown> = {}): ResDouble['res'] {
  const res = new EventEmitter() as unknown as ResDouble['res'];
  res.locals = locals;
  res.statusCode = 200; // express's default until a handler says otherwise
  return res;
}

function makeReq(options: { method?: string; path?: string } = {}): Request {
  return { method: options.method ?? 'GET', path: options.path ?? '/api/health' } as unknown as Request;
}

function run(req: Request, res: ResDouble['res']): Mock {
  const next = vi.fn();
  requestLoggerMiddleware(req, res, next);
  return next;
}

describe('requestLoggerMiddleware (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRequestMetricsForTests();
  });

  it("one info line on 'finish': method, path, reqId, status, durationMs", () => {
    const res = makeRes({ requestId: 'req-0042', requestStartedAt: performance.now() - 5 });
    run(makeReq(), res);

    res.statusCode = 200;
    res.emit('finish');

    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: 'req-0042',
        method: 'GET',
        path: '/api/health',
        status: 200,
        durationMs: expect.any(Number),
      }),
      'request completed',
    );
      const line = vi.mocked(logger.info).mock.calls[0]?.[0] as unknown as { durationMs: number };
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
      expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    // The settle also drove the REAL metrics: the in-flight gauge returns to 0.
    expect(snapshotRequestMetrics().inFlight).toBe(0);
    expect(snapshotRequestMetrics().total).toBe(1);
  });

  it('an open request holds the in-flight gauge until it settles', () => {
    const res = makeRes({ requestId: 'req-1' });
    run(makeReq(), res);

    expect(snapshotRequestMetrics().inFlight).toBe(1);
    expect(logger.info).not.toHaveBeenCalled(); // nothing logged until finish
  });

  describe('level discipline: <400 info, 4xx warn, 5xx error', () => {
    it.each<[number, 'info' | 'warn' | 'error']>([
      [200, 'info'],
      [204, 'info'],
      [302, 'info'], // 3xx is NOT a client problem — still info
      [404, 'warn'],
      [429, 'warn'],
      [500, 'error'],
      [503, 'error'],
    ])('status %s → logger.%s', (status, level) => {
      const res = makeRes({ requestId: 'req-1' });
      run(makeReq(), res);
      res.statusCode = status;
      res.emit('finish');

      expect(vi.mocked(logger[level as 'info' | 'warn' | 'error'])).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger[level as 'info' | 'warn' | 'error'])).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
        'request completed',
      );
    });
  });

  it("'close' before 'finish' = aborted: warn with aborted:true even on a 200", () => {
    const res = makeRes({ requestId: 'req-abort' });
    run(makeReq(), res);

    res.emit('close'); // client hung up mid-response; statusCode still the 200 default

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: 'req-abort', aborted: true, status: 200 }),
      'request aborted (connection closed early)',
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('the settled guard: finish then close logs exactly ONE line', () => {
    const res = makeRes({ requestId: 'req-1' });
    run(makeReq(), res);

    res.emit('finish');
    res.emit('close'); // sockets can fire both — the second must be a no-op

    const lines = vi.mocked(logger.info).mock.calls.length +
      vi.mocked(logger.warn).mock.calls.length +
      vi.mocked(logger.error).mock.calls.length;
    expect(lines).toBe(1);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('the path is captured BEFORE next() — router rewrites cannot rewrite history', () => {
    // Routers mutate req.url to be mount-relative after this middleware runs;
    // the logged path must stay the ORIGINAL full path.
    let currentPath = '/api/demo/security/ping';
    const req = {
      method: 'GET',
      get path(): string {
        return currentPath;
      },
    } as unknown as Request;

    const res = makeRes({ requestId: 'req-1' });
    const next = run(req, res);
    next(); // downstream routing "runs", rewriting the path
    currentPath = '/security/ping'; // req.path now reads mount-relative

    res.emit('finish');

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/demo/security/ping' }),
      'request completed',
    );
  });

  describe('the defensive fallbacks (mount-order insurance)', () => {
    it("no requestId in locals → reqId 'n/a', still one info line", () => {
      const res = makeRes({}); // request-id middleware never ran
      run(makeReq(), res);
      res.emit('finish');

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ reqId: 'n/a' }),
        'request completed',
      );
    });

    it('no requestStartedAt in locals → durationMs stays a sane number', () => {
      const res = makeRes({ requestId: 'req-1' }); // no requestStartedAt
      run(makeReq(), res);
      res.emit('finish');

      const line = vi.mocked(logger.info).mock.calls[0]?.[0] as unknown as { durationMs: number };
      expect(Number.isFinite(line.durationMs)).toBe(true);
      expect(line.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
