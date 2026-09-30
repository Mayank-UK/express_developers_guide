import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { UUID_RE } from '../../test_support/index.js';
import { requestIdMiddleware } from './request_id_middleware.js';

// The middleware's documented contract: it STAMPS a fresh id on every request
// (correlation is per-process). It deliberately never reads an inbound
// x-request-id — the tests below pin that actual behavior rather than the
// honor-inbound pattern other stacks use.

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function makeRes(): Response & { headers: Record<string, string>; locals: Record<string, unknown> } {
  const headers: Record<string, string> = {};
  const locals: Record<string, unknown> = {};
  const res = {
    locals,
    setHeader: (key: string, value: string): void => {
      headers[key] = value;
    },
  };
  return Object.assign(res, { headers }) as unknown as Response & {
    headers: Record<string, string>;
    locals: Record<string, unknown>;
  };
}

function run(req: Request): { res: ReturnType<typeof makeRes>; next: ReturnType<typeof vi.fn> } {
  const res = makeRes();
  const next = vi.fn();
  requestIdMiddleware(req, res, next);
  return { res, next };
}

describe('requestIdMiddleware (unit)', () => {
  it('stamps a fresh UUID into res.locals.requestId AND the x-request-id header', () => {
    const { res, next } = run(makeReq());

    expect(res.locals.requestId).toMatch(UUID_RE);
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
    // Same id in both places — the header is the echo of the locals value.
    expect(res.headers['x-request-id']).toBe(res.locals.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('also stamps requestStartedAt so later handlers can self-time the request', () => {
    const { res } = run(makeReq());

    expect(typeof res.locals.requestStartedAt).toBe('number');
    expect(Number.isFinite(res.locals.requestStartedAt as number)).toBe(true);
    expect((res.locals.requestStartedAt as number) as number).toBeLessThanOrEqual(performance.now());
  });

  it('does NOT honor an inbound x-request-id — a fresh id is always generated', () => {
    // The actual contract (see the middleware's doc comment): inbound ids are
    // ignored, so a caller cannot spoof or steer this process's correlation.
    const { res } = run(makeReq({ 'x-request-id': '11111111-1111-4111-8111-111111111111' }));

    expect(res.locals.requestId).toMatch(UUID_RE);
    expect(res.locals.requestId).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(res.headers['x-request-id']).not.toBe('11111111-1111-4111-8111-111111111111');
  });

  it('a malformed inbound x-request-id is equally ignored — no crash, fresh valid id', () => {
    const { res, next } = run(makeReq({ 'x-request-id': 'not-a-uuid' }));

    expect(res.locals.requestId).toMatch(UUID_RE);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('two requests never share an id', () => {
    const first = run(makeReq()).res;
    const second = run(makeReq()).res;

    expect(first.locals.requestId).not.toBe(second.locals.requestId);
  });
});
