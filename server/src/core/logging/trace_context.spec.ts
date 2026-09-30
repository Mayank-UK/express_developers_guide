import { describe, expect, it } from 'vitest';
import {
  SPAN_RING_CAPACITY,
  buildSpanTree,
  childTraceContext,
  endSpan,
  formatTraceparent,
  generateTraceContext,
  getSpansByTraceId,
  parseTraceparent,
  recordCompletedSpan,
  resetSpanRingForTests,
  spanRingSizeForTests,
  startSpan,
  withSpan,
} from './trace_context.js';

/**
 * The W3C trace-context parser/formatter and the span collector, unit-level.
 * The parser's contract is total: ANY input yields a value or null — never a
 * throw — and the only version that continues a trace is 00.
 */

const VALID_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const VALID_SPAN_ID = 'b7ad6b7169203331';

describe('parseTraceparent — version 00, paranoid and total', () => {
  it('parses a canonical lowercase header', () => {
    const parsed = parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`);
    expect(parsed).toEqual({ version: '00', traceId: VALID_TRACE_ID, parentId: VALID_SPAN_ID, sampled: true });

    const unsampled = parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-00`);
    expect(unsampled?.sampled).toBe(false);
  });

  it('tolerates UPPERCASE hex (the spec makes consumers accept it) and normalizes to lowercase', () => {
    const parsed = parseTraceparent(`00-${VALID_TRACE_ID.toUpperCase()}-${VALID_SPAN_ID.toUpperCase()}-01`);
    expect(parsed).toEqual({ version: '00', traceId: VALID_TRACE_ID, parentId: VALID_SPAN_ID, sampled: true });
  });

  it('parses the flags byte: bit 0 is sampled; higher bits are ignored, not rejected', () => {
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`)?.sampled).toBe(true);
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-03`)?.sampled).toBe(true); // bit 0 set + bit 1 (future) set
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-00`)?.sampled).toBe(false);
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-02`)?.sampled).toBe(false); // future bit only
  });

  it('rejects wrong lengths, garbage, non-hex — always null, never a throw', () => {
    const hostile = [
      '',
      'garbage',
      '00-toolong-traceid-here-01',
      `00-${VALID_TRACE_ID.slice(0, 31)}-${VALID_SPAN_ID}-01`, // 31-hex trace id
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID.slice(0, 15)}-01`, // 15-hex span id
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-1`, // 1-hex flags
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-0G`, // non-hex flags
      `00-${'g'.repeat(32)}-${VALID_SPAN_ID}-01`, // non-hex trace id
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}`, // missing field
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01-extra`, // trailing field
      `xx-anything-at-all-here`, // does not even look like the shape
    ];
    for (const header of hostile) {
      expect(parseTraceparent(header), `"${header}"`).toBeNull();
      expect(() => parseTraceparent(header), `"${header}"`).not.toThrow();
    }
    expect(parseTraceparent(undefined)).toBeNull();

    // Surrounding whitespace is TOLERATED (trimmed), the way real header
    // handling is — the anchor rejects structural garbage, not polite space.
    expect(parseTraceparent(` 00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01 `)?.traceId).toBe(VALID_TRACE_ID);
  });

  it('rejects the forbidden/future versions (ff, 01) — a fresh trace, not a guess', () => {
    expect(parseTraceparent(`ff-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`)).toBeNull(); // reserved
    expect(parseTraceparent(`01-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`)).toBeNull(); // future version: cannot interpret
    expect(parseTraceparent(`000-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`)).toBeNull(); // 3-char version field
  });

  it('rejects all-zero ids (spec-invalid) and takes the FIRST of multiple values', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${VALID_SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();

    const doubled = `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01, 00-${'f'.repeat(32)}-${'e'.repeat(16)}-00`;
    expect(parseTraceparent(doubled)?.traceId).toBe(VALID_TRACE_ID);
  });
});

describe('formatTraceparent + context generation', () => {
  it('formats canonically: version 00, lowercase, sampled as 01/00', () => {
    expect(formatTraceparent({ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, sampled: true })).toBe(
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`,
    );
    expect(formatTraceparent({ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, sampled: false })).toBe(
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-00`,
    );
    // Round-trip: what we format, we parse.
    expect(parseTraceparent(formatTraceparent({ traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, sampled: true })))
      .toEqual({ version: '00', traceId: VALID_TRACE_ID, parentId: VALID_SPAN_ID, sampled: true });
  });

  it('generates fresh identities and children of a trace', () => {
    const root = generateTraceContext();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);

    const child = childTraceContext(root);
    expect(child.traceId).toBe(root.traceId); // same trace
    expect(child.spanId).not.toBe(root.spanId); // NEW span
    expect(generateTraceContext().traceId).not.toBe(root.traceId); // fresh traces differ
  });
});

describe('the span collector — withSpan, trees, and the ring bound', () => {
  it('withSpan records ok spans with parent linkage, duration ≥ 0, and the context for children', async () => {
    resetSpanRingForTests();
    const root = generateTraceContext();

    const outcome = await withSpan(
      'parent work',
      async (parentCtx) => {
        const nested = await withSpan('child work', async () => 7, parentCtx);
        return { value: nested.result, childContext: parentCtx };
      },
      root,
    );

    expect(outcome.result.value).toBe(7);
    expect(outcome.result.childContext.traceId).toBe(root.traceId); // the fn received a context to propagate
    expect(outcome.span.status).toBe('ok');
    expect(outcome.span.durationMs).not.toBeNull();
    expect(outcome.span.durationMs!).toBeGreaterThanOrEqual(0);

    const spans = getSpansByTraceId(root.traceId);
    expect(spans.map((entry) => entry.name)).toEqual(['parent work', 'child work']);
    // Linkage: the parent's id, not its name, is what ties the tree together.
    expect(spans[0]!.parentId).toBe(root.spanId);
    expect(spans[1]!.parentId).toBe(spans[0]!.spanId);

    const tree = buildSpanTree(root.traceId);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.span.name).toBe('parent work');
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.span.name).toBe('child work');
  });

  it('an async ERROR closes the span as error, records the message, and RETHROWS', async () => {
    resetSpanRingForTests();
    const root = generateTraceContext();

    await expect(
      withSpan(
        'doomed',
        async () => {
          throw new Error('kaboom');
        },
        root,
      ),
    ).rejects.toThrow('kaboom');

    const [span] = getSpansByTraceId(root.traceId);
    expect(span?.name).toBe('doomed');
    expect(span?.status).toBe('error');
    expect(span?.durationMs).not.toBeNull(); // CLOSED despite the throw
    expect(span?.attributes).toMatchObject({ error: 'kaboom' });
  });

  it('recordCompletedSpan carries externally-derived timing (and clamps inversion to 0)', () => {
    resetSpanRingForTests();
    const span = recordCompletedSpan({
      name: 'remote worker',
      traceId: VALID_TRACE_ID,
      parentId: VALID_SPAN_ID,
      startedAtMs: 1_000,
      endedAtMs: 1_150,
    });
    expect(span.durationMs).toBe(150);
    expect(span.status).toBe('ok');

    const inverted = recordCompletedSpan({
      name: 'clock skew',
      traceId: VALID_TRACE_ID,
      parentId: null,
      startedAtMs: 2_000,
      endedAtMs: 1_000, // ended "before" it started — degrade, never negative
    });
    expect(inverted.durationMs).toBe(0);
  });

  it('endSpan is idempotent; a root span with no parent starts the tree', () => {
    resetSpanRingForTests();
    const open = startSpan('http GET /x', null);
    expect(open.span.status).toBe('open');
    expect(open.span.parentId).toBeNull();
    expect(open.context.traceId).toBe(open.span.traceId);

    endSpan(open.span, 'ok', { httpStatus: 200 });
    const before = open.span.durationMs;
    endSpan(open.span, 'error'); // second close: no-op
    expect(open.span.status).toBe('ok');
    expect(open.span.durationMs).toBe(before);
  });

  it('an evicted/remote parent degrades to a ROOT instead of vanishing', () => {
    resetSpanRingForTests();
    const remoteParent = generateTraceContext();
    const local = startSpan('child of a span the ring never saw', remoteParent);
    endSpan(local.span, 'ok');

    const tree = buildSpanTree(remoteParent.traceId);
    // The parent is absent from the ring — the child still appears, as a root.
    expect(tree).toHaveLength(1);
    expect(tree[0]!.span.spanId).toBe(local.span.spanId);
  });

  it('the ring is BOUNDED: it never outgrows SPAN_RING_CAPACITY', () => {
    resetSpanRingForTests();
    const parent = generateTraceContext();
    for (let index = 0; index < SPAN_RING_CAPACITY + 25; index += 1) {
      const opened = startSpan(`span ${String(index)}`, parent);
      endSpan(opened.span, 'ok');
    }
    expect(spanRingSizeForTests()).toBe(SPAN_RING_CAPACITY);
    // Oldest evicted, newest retained.
    const names = getSpansByTraceId(parent.traceId).map((span) => span.name);
    expect(names).not.toContain('span 0');
    expect(names[names.length - 1]).toBe(`span ${String(SPAN_RING_CAPACITY + 24)}`);
  });
});
