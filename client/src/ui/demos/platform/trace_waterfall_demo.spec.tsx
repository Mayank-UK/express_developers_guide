import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TraceWaterfallDemo from './trace_waterfall_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom talks to stubs shaped like the real trace payloads (obs_demo_routes +
 * trace_context.ts). The server spec pins the LIVE contract — the real span
 * chain, the propagated consumer span, the open-root-then-settled behavior;
 * here we prove the waterfall renders the tree with its nesting intact and
 * that the refetch settles the root span.
 */

const TRACE_RUN_URL = '/api/demo/obs/trace/run';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPANS_URL = `/api/demo/obs/trace/spans?traceId=${TRACE_ID}`;

interface StubSpan {
  spanId: string;
  parentId: string | null;
  name: string;
  durationMs: number | null;
  status: 'open' | 'ok' | 'error';
  startedAtMs?: number;
}

function span(
  spanId: string,
  name: string,
  durationMs: number | null,
  status: StubSpan['status'],
  parentId: string | null = null,
): StubSpan {
  // startedAtMs always present — the real ring records it on every span.
  return { spanId, parentId, name, durationMs, status, startedAtMs: 1759142400000 };
}

/** The real chain's shape: root (request) → handler → steps → producer → consumer. */
interface ChainSpans {
  root: StubSpan;
  handler: StubSpan;
  usecase: StubSpan;
  db: StubSpan;
  producer: StubSpan;
  consumer: StubSpan;
}

function makeChain(rootDurationMs: number | null, rootStatus: StubSpan['status']): ChainSpans {
  const root = span('aaaa1111aaaa1111', 'GET /api/demo/obs/trace/run', rootDurationMs, rootStatus);
  const handler = span('bbbb2222bbbb2222', 'trace-demo: route handler', 8, 'ok', root.spanId);
  const usecase = span('cccc3333cccc3333', 'trace-demo: usecase — assemble payload', 6.5, 'ok', handler.spanId);
  const db = span('dddd4444dddd4444', 'trace-demo: db — SELECT 1 (throwaway :memory:)', 0.3, 'ok', handler.spanId);
  const producer = span('eeee5555eeee5555', 'trace-demo: enqueue email job (producer)', 0.2, 'ok', handler.spanId);
  const consumer = span('ffff6666ffff6666', 'trace-demo: job worker — email handler (consumer)', 1.1, 'ok', producer.spanId);
  return { root, handler, usecase, db, producer, consumer };
}

const OPEN_CHAIN = makeChain(null, 'open');
const SETTLED_CHAIN = makeChain(9.2, 'ok');

const RUN_TREE = [
  {
    span: OPEN_CHAIN.root,
    children: [
      {
        span: OPEN_CHAIN.handler,
        children: [
          { span: OPEN_CHAIN.usecase, children: [] },
          { span: OPEN_CHAIN.db, children: [] },
          { span: OPEN_CHAIN.producer, children: [{ span: OPEN_CHAIN.consumer, children: [] }] },
        ],
      },
    ],
  },
];

const SETTLED_TREE = [
  {
    span: SETTLED_CHAIN.root,
    children: RUN_TREE[0]!.children,
  },
];

const RUN_BODY = {
  traceId: TRACE_ID,
  requestId: '7a4f2c1e-9b3d-4e8a-a1c2-3d4e5f6a7b8c',
  traceparent: `00-${TRACE_ID}-aaaa1111aaaa1111-01`,
  chain: { usecase: { digestPrefix: 'ab12cd34' }, db: { query: 'SELECT 1' } },
  tree: RUN_TREE,
  note: 'the root span closes when this response finishes — refetch /trace/spans?traceId= to see it settled',
};

const SPANS_BODY = {
  traceId: TRACE_ID,
  spanCount: 6,
  capacity: 500,
  spans: [SETTLED_CHAIN.root, SETTLED_CHAIN.handler, SETTLED_CHAIN.usecase, SETTLED_CHAIN.db, SETTLED_CHAIN.producer, SETTLED_CHAIN.consumer].map(
    (entry) => ({ ...entry, startedAtMs: 1759142400000, endedAtMs: 1759142400009 }),
  ),
  tree: SETTLED_TREE,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TraceWaterfallDemo — run, nest, settle', () => {
  it('running the traced request renders the traceId/traceparent/requestId identity block', async () => {
    stubApiFetch([{ url: TRACE_RUN_URL, method: 'POST', body: RUN_BODY }]);

    render(<TraceWaterfallDemo />);
    fireEvent.click(screen.getByTestId('trace-run-button'));

    expect(await screen.findByTestId('trace-id-chip')).toHaveTextContent(TRACE_ID);
    expect(screen.getByTestId('trace-request-chip')).toHaveTextContent(
      'requestId 7a4f2c1e-9b3d-4e8a-a1c2',
    );
    expect(screen.getByTestId('trace-traceparent')).toHaveTextContent(
      `00-${TRACE_ID}-aaaa1111aaaa1111-01`,
    );
  });

  it('the waterfall renders every span with its PARENT/CHILD NESTING — the consumer hangs under the producer', async () => {
    stubApiFetch([{ url: TRACE_RUN_URL, method: 'POST', body: RUN_BODY }]);

    render(<TraceWaterfallDemo />);
    fireEvent.click(screen.getByTestId('trace-run-button'));

    await screen.findByTestId('trace-waterfall');
    const rows = await waitFor(() => screen.getAllByTestId('trace-span-row'));
    expect(rows.length).toBe(6);
    expect(rows[0]).toHaveTextContent('GET /api/demo/obs/trace/run');

    // Nesting: the handler row's children container holds usecase/db/producer,
    // and the PRODUCER's own children container holds the consumer span — the
    // propagation beat, visible as indentation.
    const handlerRow = rows.find((row) => row.textContent?.includes('route handler'));
    expect(handlerRow).toBeDefined();
    const handlerChildren = handlerRow!.parentElement!.querySelector('[data-testid="trace-span-children"]');
    expect(handlerChildren).toBeDefined();
    // 3 direct children (usecase/db/producer) + the consumer nested one deeper.
    expect(within(handlerChildren as HTMLElement).getAllByTestId('trace-span-row').length).toBe(4);
    expect(within(handlerChildren as HTMLElement).getByText(/enqueue email job/)).toBeDefined();

    const producerChildren = (handlerChildren as HTMLElement).querySelectorAll(
      '[data-testid="trace-span-children"]',
    )[0] as HTMLElement | undefined;
    expect(producerChildren).toBeDefined();
    expect(within(producerChildren!).getByText(/job worker/)).toBeDefined();

    // Durations and statuses render per row.
    expect(screen.getAllByTestId('trace-span-status').filter((chip) => chip.textContent === 'ok').length).toBe(5);
    expect(screen.getByTestId('trace-waterfall')).toHaveTextContent('6.5ms');
  });

  it('the run response leaves the ROOT span open; refetching /trace/spans settles it with a real duration', async () => {
    stubApiFetch([
      { url: TRACE_RUN_URL, method: 'POST', body: RUN_BODY },
      { url: SPANS_URL, body: SPANS_BODY },
    ]);

    render(<TraceWaterfallDemo />);
    fireEvent.click(screen.getByTestId('trace-run-button'));
    await screen.findByTestId('trace-waterfall');

    // Root is open in the run response — no duration, the honesty chip.
    expect(screen.getAllByTestId('trace-span-status').some((chip) => chip.textContent === 'open')).toBe(true);
    expect(screen.getByTestId('trace-waterfall')).toHaveTextContent('settles when the response finishes');

    fireEvent.click(screen.getByTestId('trace-refetch-button'));

    expect(await screen.findByTestId('trace-count-chip')).toHaveTextContent('6 spans');
    expect(screen.getByTestId('trace-waterfall')).toHaveTextContent('from /trace/spans');
    // The root row settled: status ok, a real duration on screen.
    await waitFor(() => {
      const rootRow = screen.getAllByTestId('trace-span-row')[0]!;
      expect(rootRow).toHaveTextContent('9.2ms');
      expect(within(rootRow).getByTestId('trace-span-status')).toHaveTextContent('ok');
    });
    expect(screen.queryByText('settles when the response finishes')).toBeNull();
  });

  it('a trace that aged out of the ring renders the 404 envelope as a first-class refetch state', async () => {
    stubApiFetch([
      { url: TRACE_RUN_URL, method: 'POST', body: RUN_BODY },
      {
        url: SPANS_URL,
        status: 404,
        body: {
          error: {
            code: 'not_found',
            message: `no spans in the ring for trace "${TRACE_ID}" — the ring is a 500-span window; traces age out`,
          },
        },
      },
    ]);

    render(<TraceWaterfallDemo />);
    fireEvent.click(screen.getByTestId('trace-run-button'));
    await screen.findByTestId('trace-waterfall');

    fireEvent.click(screen.getByTestId('trace-refetch-button'));
    expect(await screen.findByTestId('trace-spans-failed')).toHaveTextContent('not_found');
    expect(screen.getByTestId('trace-spans-failed')).toHaveTextContent('age out');
    // The run's waterfall stays on screen — the failure only reports the refetch.
    expect(screen.getByTestId('trace-waterfall')).toBeDefined();
  });

  it('degrades to the reachable-server message on a network failure, never a crash', async () => {
    stubNetworkFailure();

    render(<TraceWaterfallDemo />);
    fireEvent.click(screen.getByTestId('trace-run-button'));

    expect(await screen.findByTestId('trace-error')).toHaveTextContent(
      'could not reach the server',
    );
    expect(screen.getByTestId('trace-summary')).toBeDefined();
  });
});
