import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context, hand-rolled — the observability topic's tracing
 * artifact, in the same spirit as log_ring.ts and request_metrics.ts: no
 * OpenTelemetry SDK (that gets the catalog mention), just the real standard,
 * small enough to read.
 *
 * THE HEADER (version 00):
 *
 *   traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 *                └┬┘ └──────────────┬──────────────┘ └──────┬──────┘ └┬┘
 *              version          trace-id (32 hex)      parent-id (16 hex) flags
 *
 * - trace-id: the WHOLE distributed trace's identity — every hop of one user
 *   action carries the same 16 bytes, across services.
 * - parent-id: the span id of the CALLER — "who caused this work". Each
 *   server hop generates its OWN span id and passes THAT downstream.
 * - flags: 2 hex bits; bit 0 (01) = sampled. Version 00 defines only bit 0.
 *
 * requestId vs traceId — the coexistence that IS the lesson: the request id
 * (request_id_middleware.ts) correlates LOG LINES within this process, one
 * per inbound HTTP request; the trace id correlates WORK across services and
 * processes, many requests per trace. Neither substitutes for the other.
 *
 * PARSING IS PARANOID AND TOTAL: a malformed header is IGNORED (a fresh trace
 * is generated — the standard's own guidance), never a throw, never a 400:
 * observability must not break the request it observes. Uppercase hex is
 * ACCEPTED (the spec tells producers to emit lowercase and consumers to
 * tolerate anything valid), and canonical output is always lowercase.
 */

export const TRACE_VERSION = '00';

/** 32 lowercase hex chars (16 bytes) — 0af7651916cd43dd8448eb211c80319c. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
/** 16 lowercase hex chars (8 bytes) — b7ad6b7169203331. */
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
/** 2 hex chars. */
const FLAGS_PATTERN = /^[0-9a-f]{2}$/;

/**
 * The ANCHORED shape: exactly four `-`-separated hex fields, nothing before
 * or after. Anchoring matters — without ^…$ a garbage string like
 * `xx00-<valid 55 chars>` could PARTIAL-match. Hex letters may arrive
 * uppercase (tolerated), but the VERSION field is compared as-is after
 * lowercasing, and only "00" continues a trace (see parseTraceparent).
 */
const TRACEPARENT_PATTERN = /^([0-9a-fA-F]{2})-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$/;

/** What a parseable header yields — lowercase-normalized, flags decoded. */
export interface ParsedTraceparent {
  /** Always '00' — parseTraceparent accepts nothing else (yet). */
  readonly version: string;
  readonly traceId: string;
  /** The caller's span id — becomes the local root span's parent. */
  readonly parentId: string;
  /** Flags byte decoded to the one bit version 00 defines. */
  readonly sampled: boolean;
}

/** The local span context every new span carries and passes downstream. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

/**
 * Parses a traceparent header VALUE (undefined/absent included). Returns null
 * for ANYTHING unusable — missing header, wrong length, wrong version,
 * non-hex garbage, all-zero ids — and never throws. Multiple header values
 * (proxies sometimes append): the FIRST wins, per the standard.
 */
export function parseTraceparent(header: string | undefined): ParsedTraceparent | null {
  if (typeof header !== 'string') return null;
  const first = header.split(',')[0]?.trim();
  if (first === undefined || first === '') return null;

  const match = TRACEPARENT_PATTERN.exec(first);
  if (match === null) return null;

  const [version, traceId, parentId, flags] = [
    match[1]!.toLowerCase(),
    match[2]!.toLowerCase(),
    match[3]!.toLowerCase(),
    match[4]!.toLowerCase(),
  ];

  // Version gate: 'ff' is explicitly reserved-forbidden, and any future
  // version might redefine the fields' meaning — a version-00 parser cannot
  // safely interpret them, so it starts a fresh trace instead (the standard's
  // forward-compatibility rule).
  if (version !== TRACE_VERSION) return null;

  // All-zero ids are invalid by spec and would collide with "unset".
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  if (!TRACE_ID_PATTERN.test(traceId) || !SPAN_ID_PATTERN.test(parentId) || !FLAGS_PATTERN.test(flags)) {
    return null;
  }

  // Flags: bit 0 = sampled. Higher bits are defined by newer versions and
  // ignored here (masked out, not rejected).
  const sampled = (Number.parseInt(flags, 16) & 0b01) === 0b01;
  return { version, traceId, parentId, sampled };
}

/** Canonical output: always lowercase, version 00, one-line flags byte. */
export function formatTraceparent(context: TraceContext): string {
  return `${TRACE_VERSION}-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/** A fresh identity: new traceId + new spanId (a brand-new trace's first span). */
export function generateTraceContext(sampled = true): TraceContext {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    sampled,
  };
}

/** A CHILD identity: same trace (and sampling decision), NEW span id. */
export function childTraceContext(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: randomBytes(8).toString('hex'), sampled: parent.sampled };
}

// --- the span collector -----------------------------------------------------------------

/**
 * A bounded in-memory ring of span records — log_ring.ts's pattern applied to
 * spans: a WINDOW on recent work, not a ledger (gone on restart, never
 * flushed; production spans go to a collector over OTLP). Root spans are
 * opened for EVERY request (cheap: two object writes), which is why the
 * capacity is a ring bound and not a grow-forever array.
 */
export const SPAN_RING_CAPACITY = 500;

export type SpanStatus = 'open' | 'ok' | 'error';

export interface SpanRecord {
  readonly spanId: string;
  readonly traceId: string;
  /** null = a trace's root; a span whose parent was evicted still names it. */
  readonly parentId: string | null;
  readonly name: string;
  readonly startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  status: SpanStatus;
  readonly attributes: Record<string, unknown>;
}

/** What startSpan/withSpan hand back — the context to pass to children. */
export interface OpenSpan {
  readonly span: SpanRecord;
  readonly context: TraceContext;
}

const ring: SpanRecord[] = [];

function pushSpan(span: SpanRecord): void {
  ring.push(span);
  while (ring.length > SPAN_RING_CAPACITY) ring.shift();
}

/**
 * Opens a span: mints a span id under `parent`'s trace (or a fresh trace when
 * parentless — the root case) and records it as 'open'. Closing happens via
 * endSpan — for request-root spans that is the response's 'finish' event; for
 * withSpan it is the function's return/throw.
 */
export function startSpan(
  name: string,
  parent: TraceContext | null,
  attributes: Record<string, unknown> = {},
): OpenSpan {
  const context = parent === null ? generateTraceContext() : childTraceContext(parent);
  const span: SpanRecord = {
    spanId: context.spanId,
    traceId: context.traceId,
    parentId: parent?.spanId ?? null,
    name,
    startedAtMs: Date.now(),
    endedAtMs: null,
    durationMs: null,
    status: 'open',
    attributes,
  };
  pushSpan(span);
  return { span, context };
}

/** Closes a span (idempotent): duration, status, and any late attributes. */
export function endSpan(
  span: SpanRecord,
  status: 'ok' | 'error' = 'ok',
  extraAttributes: Record<string, unknown> = {},
): void {
  if (span.status !== 'open') return;
  span.status = status;
  span.endedAtMs = Date.now();
  span.durationMs = Math.max(0, span.endedAtMs - span.startedAtMs);
  Object.assign(span.attributes, extraAttributes);
}

/**
 * Records a span whose timing came from SOMEWHERE ELSE — the traced-job
 * consumer, whose start/end are the queue worker's own history timestamps,
 * not this process's wall clock around a function call. Same ring, same
 * shape, honest provenance via attributes.
 */
export function recordCompletedSpan(fields: {
  name: string;
  traceId: string;
  parentId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  status?: 'ok' | 'error';
  attributes?: Record<string, unknown>;
}): SpanRecord {
  const span: SpanRecord = {
    spanId: randomBytes(8).toString('hex'),
    traceId: fields.traceId,
    parentId: fields.parentId,
    name: fields.name,
    startedAtMs: fields.startedAtMs,
    endedAtMs: fields.endedAtMs,
    durationMs: Math.max(0, fields.endedAtMs - fields.startedAtMs),
    status: fields.status ?? 'ok',
    attributes: fields.attributes ?? {},
  };
  pushSpan(span);
  return span;
}

/**
 * The ergonomic half: runs `fn` inside a span that closes NO MATTER WHAT —
 * error paths close the span (as 'error', with the message attached) and the
 * throw rethrows, so tracing never swallows a failure. The fn receives the
 * span's context, which is exactly what a downstream hop (a job payload, an
 * outgoing fetch) must serialize.
 */
export async function withSpan<T>(
  name: string,
  fn: (context: TraceContext) => Promise<T>,
  parent: TraceContext | null = null,
  attributes: Record<string, unknown> = {},
): Promise<{ span: SpanRecord; result: T }> {
  const { span, context } = startSpan(name, parent, attributes);
  try {
    const result = await fn(context);
    endSpan(span, 'ok');
    return { span, result };
  } catch (error) {
    endSpan(span, 'error', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Every span of one trace still in the ring, oldest first. */
export function getSpansByTraceId(traceId: string): SpanRecord[] {
  return ring.filter((span) => span.traceId === traceId);
}

export interface SpanTreeNode {
  readonly span: SpanRecord;
  readonly children: SpanTreeNode[];
}

/**
 * Nests a trace's flat spans into a tree. Roots are parentless spans; a span
 * whose parent id matches NO span in the window (evicted, or born under a
 * remote parent) degrades to a root rather than vanishing — the waterfall
 * stays honest about what the window no longer holds.
 */
export function buildSpanTree(traceId: string): SpanTreeNode[] {
  const spans = getSpansByTraceId(traceId);
  const nodes = new Map<string, SpanTreeNode>(spans.map((span) => [span.spanId, { span, children: [] }]));
  const roots: SpanTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentId === null ? undefined : nodes.get(node.span.parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const byStart = (a: SpanTreeNode, b: SpanTreeNode): number => a.span.startedAtMs - b.span.startedAtMs;
  for (const node of nodes.values()) node.children.sort(byStart);
  return roots.sort(byStart);
}

/** Test-only: a clean window between cases. */
export function resetSpanRingForTests(): void {
  ring.length = 0;
}

/** Test-only: the live length, for the bounded-growth proof. */
export function spanRingSizeForTests(): number {
  return ring.length;
}
