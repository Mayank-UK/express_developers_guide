import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import {
  getSpansByTraceId,
  parseTraceparent,
  resetSpanRingForTests,
  type SpanRecord,
} from '../../core/logging/trace_context.js';
import { traceMiddleware } from './trace_middleware.js';

// W3C traceparent continuation, unit-level: the middleware runs against an
// EventEmitter res (it needs once('finish'/'close') and reads res.statusCode),
// the real trace_context module supplies parse/format + the span ring, and
// every case starts from a reset ring so span assertions see only their own
// request's span.

const INBOUND_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const INBOUND_SPAN_ID = 'b7ad6b7169203331';
const VALID_INBOUND = `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`;

function makeReq(options: { method?: string; path?: string; traceparent?: string | string[] } = {}): Request {
  const headers: Record<string, string | string[]> = {};
  if (options.traceparent !== undefined) headers.traceparent = options.traceparent;
  return {
    method: options.method ?? 'GET',
    path: options.path ?? '/api/demo',
    headers,
  } as unknown as Request;
}

interface TraceResDouble extends Response {
  locals: Record<string, unknown>;
  statusCode: number;
}

function makeRes(statusCode = 200): { res: TraceResDouble; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  // An EventEmitter base gives the middleware its once('finish'/'close') hooks;
  // the single cast keeps express's own setHeader signature out of the way.
  const res = Object.assign(new EventEmitter(), {
    locals: { requestId: 'req-0001' } as Record<string, unknown>, // request_id_middleware ran first
    statusCode,
    setHeader: (key: string, value: string): void => {
      headers[key] = value;
    },
  }) as unknown as TraceResDouble;
  return { res, headers };
}

function run(
  req: Request,
  statusCode = 200,
): { res: TraceResDouble; headers: Record<string, string>; next: ReturnType<typeof vi.fn> } {
  const { res, headers } = makeRes(statusCode);
  const next = vi.fn();
  traceMiddleware(req, res, next);
  return { res, headers, next };
}

describe('traceMiddleware (unit)', () => {
  beforeEach(() => {
    resetSpanRingForTests();
  });

  it('no inbound traceparent → generates a fresh, spec-valid one and opens the root span', () => {
    const { res, headers, next } = run(makeReq());

    const outgoing = headers.traceparent ?? '';
    expect(outgoing).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const parsed = parseTraceparent(outgoing);
    expect(parsed).not.toBeNull();
    expect(next).toHaveBeenCalledTimes(1);

    // The stamped context IS the response header's context.
    const context = res.locals.traceContext as { traceId: string; spanId: string };
    expect(context.traceId).toBe(parsed!.traceId);
    expect(context.spanId).toBe(parsed!.parentId); // the caller of every later span

    // A parentless root span, named after the request it observes.
    const spans = getSpansByTraceId(context.traceId);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.parentId).toBeNull();
    expect(spans[0]?.name).toBe('http GET /api/demo');
    expect(spans[0]?.attributes.continuedFromIncoming).toBe(false);
  });

  it('a valid inbound traceparent continues the SAME traceId with a NEW spanId', () => {
    const { res, headers } = run(makeReq({ traceparent: VALID_INBOUND }));

    const context = res.locals.traceContext as { traceId: string; spanId: string; sampled: boolean };
    expect(context.traceId).toBe(INBOUND_TRACE_ID); // same trace
    expect(context.spanId).not.toBe(INBOUND_SPAN_ID); // but this hop's OWN span
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(headers.traceparent).toBe(`00-${INBOUND_TRACE_ID}-${context.spanId}-01`);

    // The remote parent is recorded as the root span's parent.
    const span = getSpansByTraceId(INBOUND_TRACE_ID)[0] as SpanRecord;
    expect(span.parentId).toBe(INBOUND_SPAN_ID);
    expect(span.attributes.continuedFromIncoming).toBe(true);
  });

  it('the sampled flag is parsed and echoed: flags 00 in, flags 00 out', () => {
    const { res, headers } = run(
      makeReq({ traceparent: `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-00` }),
    );

    expect((res.locals.traceContext as { sampled: boolean }).sampled).toBe(false);
    expect(headers.traceparent?.endsWith('-00')).toBe(true);
  });

  it('repeated traceparent headers (proxy append) join with first value winning', () => {
    const other = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
    const { res } = run(makeReq({ traceparent: [VALID_INBOUND, other] }));

    expect((res.locals.traceContext as { traceId: string }).traceId).toBe(INBOUND_TRACE_ID);
  });

  describe('malformed inbound traceparents are REPLACED, never trusted, never thrown', () => {
    it.each([
      ['outright garbage', 'not-a-traceparent'],
      ['wrong version (ff)', `ff-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`],
      ['too-short trace id', `00-${'a'.repeat(31)}-${INBOUND_SPAN_ID}-01`],
      ['all-zero trace id', `00-${'0'.repeat(32)}-${INBOUND_SPAN_ID}-01`],
      ['all-zero parent id', `00-${INBOUND_TRACE_ID}-${'0'.repeat(16)}-01`],
    ])('%s → fresh trace, request proceeds untouched', (_label, raw) => {
      const { res, headers, next } = run(makeReq({ traceparent: raw }));

      // A fresh valid trace answers — and it is NOT the inbound's trace id
      // (nor the all-zero "unset" id the worst cases carried).
      const parsed = parseTraceparent(headers.traceparent ?? '');
      expect(parsed).not.toBeNull();
      expect(parsed!.traceId).not.toMatch(/^0+$/);
      expect(parsed!.traceId).not.toBe(INBOUND_TRACE_ID);
      expect(next).toHaveBeenCalledTimes(1); // no 4xx, no crash — observability observes

      // And the span records that nothing was continued.
      const span = getSpansByTraceId(parsed!.traceId)[0] as SpanRecord;
      expect(span.parentId).toBeNull();
      expect(span.attributes.continuedFromIncoming).toBe(false);
    });
  });

  it('rides BESIDE the request id: res.locals.requestId and x-request-id are not its business', () => {
    const { res, headers } = run(makeReq());

    expect(res.locals.requestId).toBe('req-0001'); // untouched
    expect(Object.keys(headers)).toEqual(['traceparent']); // no x-request-id collision
  });

  describe('the root span closes with the response', () => {
    it("res 'finish' closes it ok with the http status attached", () => {
      const { res, headers } = run(makeReq());
      const traceId = (res.locals.traceContext as { traceId: string }).traceId;

      res.statusCode = 200; // what the real handler would have set
      res.emit('finish');

      const span = getSpansByTraceId(traceId)[0] as SpanRecord;
      expect(span.status).toBe('ok');
      expect(span.attributes.httpStatus).toBe(200);
      expect(span.endedAtMs).not.toBeNull();
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(headers.traceparent).toBeDefined(); // header was set long before close
    });

    it('a 5xx response closes the span as error', () => {
      const { res } = run(makeReq());
      const traceId = (res.locals.traceContext as { traceId: string }).traceId;

      res.statusCode = 503;
      res.emit('finish');

      expect((getSpansByTraceId(traceId)[0] as SpanRecord).status).toBe('error');
      expect((getSpansByTraceId(traceId)[0] as SpanRecord).attributes.httpStatus).toBe(503);
    });

    it("'close' (aborted socket) settles it too — later events are no-ops", () => {
      const { res } = run(makeReq());
      const traceId = (res.locals.traceContext as { traceId: string }).traceId;

      res.emit('close'); // connection died first
      res.emit('finish'); // must NOT re-close or throw

      const span = getSpansByTraceId(traceId)[0] as SpanRecord;
      expect(span.status).toBe('ok'); // statusCode was still 200 when the socket died
      expect(span.endedAtMs).not.toBeNull();
    });
  });
});
