import type { NextFunction, Request, Response } from 'express';
import {
  endSpan,
  formatTraceparent,
  parseTraceparent,
  startSpan,
  type ParsedTraceparent,
  type TraceContext,
} from '../../core/logging/trace_context.js';

/**
 * Distributed-trace middleware — the traceId sibling of requestId. Mounted in
 * app.ts directly AFTER the request-id middleware (which it must not touch)
 * and BEFORE the routes: every request, whatever it ends up doing, opens a
 * root span and answers with a `traceparent` response header.
 *
 * CONTINUE vs GENERATE:
 * - a VALID incoming `traceparent` continues the caller's traceId; this
 *   request's span's parent is the caller's span id (the remoteParent below)
 * - anything else (absent, malformed, wrong version, all-zero ids) is IGNORED
 *   and a fresh traceId is generated — malformed input never throws and never
 *   4xxs: observability must not break the request it observes.
 *
 * requestId vs traceId, one screen apart: requestId (res.locals.requestId,
 * x-request-id) identifies THIS log lines' request inside THIS process;
 * traceId identifies the WORK across services and queues that the request
 * kicked off. The response carries both headers side by side on purpose.
 *
 * HONEST LIMIT (taught in the topic): the demo ring records EVERY span,
 * ignoring the sampled bit — the flags byte is still parsed, propagated, and
 * echoed, because respecting it (dropping unsampled spans) is the collector's
 * job in a production pipeline.
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Node types headers as string | string[] when repeated; join is faithful
  // to "first value wins" because parseTraceparent splits on the comma anyway.
  const rawHeader = req.headers.traceparent;
  const parsed: ParsedTraceparent | null = parseTraceparent(Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader);

  // The REMOTE parent as a context: continuing a trace means this hop's span
  // is a CHILD of the caller's span (same traceId, parent = their span id).
  // Fresh requests pass null and get a brand-new trace.
  const remoteParent: TraceContext | null =
    parsed === null
      ? null
      : { traceId: parsed.traceId, spanId: parsed.parentId, sampled: parsed.sampled };

  // Capture the path NOW (request_logger_middleware.ts's lesson: routers
  // rewrite req.url relative to their mount before anything else runs).
  const { span, context } = startSpan(`http ${req.method} ${req.path}`, remoteParent, {
    continuedFromIncoming: parsed !== null,
  });

  // Handlers parent their spans off THIS context (the local root), and the
  // response header names it — the value a caller would need to keep tracing.
  res.locals.traceContext = context;
  res.setHeader('traceparent', formatTraceparent(context));

  // Root span closes when the response is fully sent (or the socket dies) —
  // the same finish/close race the request logger settles; first event wins.
  let settled = false;
  const close = (): void => {
    if (settled) return;
    settled = true;
    endSpan(span, res.statusCode >= 500 ? 'error' : 'ok', { httpStatus: res.statusCode });
  };
  res.once('finish', close);
  res.once('close', close);

  next();
}
