import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MiddlewarePipelineDemo from './middleware_pipeline_demo';
import { stubApiFetch, stubNetworkFailure, type StubRoute } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = '/api/demo/middleware';
const HAPPY_URL = `${BASE}/pipeline`;
const SHORT_URL = `${BASE}/short-circuit`;
const ERROR_URL = `${BASE}/error-path`;

const REQUEST_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Traces mirroring the REAL server contract (middleware_demo_routes.spec.ts):
 * happy path stamps 1-4 in the body AND header; the two failure paths carry
 * the truncated trace in the x-pipeline header only.
 */
const HAPPY_TRACE = [
  { stage: 1, label: 'logger', elapsedMs: 0 },
  { stage: 2, label: 'auth', elapsedMs: 0.3 },
  { stage: 3, label: 'validator', elapsedMs: 0.6 },
  { stage: 4, label: 'handler', elapsedMs: 1.1 },
];

const SHORT_TRACE = [
  { stage: 1, label: 'logger', elapsedMs: 0 },
  { stage: 2, label: 'auth', elapsedMs: 0.2 },
  { stage: 3, label: 'short-circuit', elapsedMs: 0.4 },
];

const ERROR_TRACE = [
  { stage: 1, label: 'logger', elapsedMs: 0 },
  { stage: 2, label: 'auth', elapsedMs: 0.2 },
  { stage: 3, label: 'validator', elapsedMs: 0.5 },
  { stage: 4, label: 'handler', elapsedMs: 0.9 },
  { stage: 5, label: 'error-handler', elapsedMs: 1.4 },
];

// Verbatim server bodies: the happy-path note (U+2019 kept) and the two
// canonical error envelopes the demo must render.
const HAPPY_BODY = {
  pipeline: HAPPY_TRACE,
  stages: 4,
  note: 'three middleware layers plus the handler — each stamped relative to the first middleware’s clock',
};

const SHORT_BODY = {
  error: {
    code: 'unauthorized',
    message: 'the auth middleware answered 401 itself — next() was never called',
    requestId: REQUEST_ID,
  },
};

const ERROR_BODY = {
  error: {
    code: 'internal_error',
    message: 'demo handler exploded on purpose',
    requestId: REQUEST_ID,
  },
};

/** Text-form stub: the demo reads response.text() AND the x-pipeline header. */
function traceRoute(url: string, status: number, body: unknown, trace: unknown[]): StubRoute {
  return {
    url,
    status,
    text: JSON.stringify(body),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-pipeline': JSON.stringify(trace),
      'x-request-id': REQUEST_ID,
    },
  };
}

const FLOW_SLOTS = ['logger', 'auth', 'validator', 'handler', 'error-handler'] as const;

/** The five stage cards, in DOM order — registration order is the contract. */
function stageOrder(): string[] {
  const flow = screen.getByTestId('mw-pipeline-flow');
  return Array.from(flow.querySelectorAll('[data-testid^="mw-pipeline-stage-"]')).map(
    (element) => element.getAttribute('data-testid')?.replace('mw-pipeline-stage-', '') ?? '',
  );
}

function expectLit(label: string, elapsed: string): void {
  const card = screen.getByTestId(`mw-pipeline-stage-${label}`);
  expect(card).toHaveTextContent(elapsed);
  expect(card).not.toHaveTextContent('not run');
}

function expectDark(label: string): void {
  expect(screen.getByTestId(`mw-pipeline-stage-${label}`)).toHaveTextContent('not run');
}

describe('MiddlewarePipelineDemo — idle render', () => {
  it('renders the three runs and the five muted stage cards before anything fires', () => {
    stubApiFetch([]);

    render(<MiddlewarePipelineDemo />);

    expect(screen.getByTestId('mw-pipeline-run-happy')).toBeInTheDocument();
    expect(screen.getByTestId('mw-pipeline-run-short-circuit')).toBeInTheDocument();
    expect(screen.getByTestId('mw-pipeline-run-error-path')).toBeInTheDocument();

    // The full stack is visible but dark: card order is the registration
    // order, and every card says "not run".
    expect(stageOrder()).toEqual([...FLOW_SLOTS]);
    for (const label of FLOW_SLOTS) expectDark(label);

    expect(screen.getByTestId('mw-pipeline-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('mw-pipeline-result')).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });
});

describe('MiddlewarePipelineDemo — happy path', () => {
  it('lights all four stages in order with elapsed badges and shows the 200 body', async () => {
    const fetchMock = (() => {
      stubApiFetch([traceRoute(HAPPY_URL, 200, HAPPY_BODY, HAPPY_TRACE)]);
      return vi.mocked(fetch);
    })();

    render(<MiddlewarePipelineDemo />);
    fireEvent.click(screen.getByTestId('mw-pipeline-run-happy'));

    await screen.findByTestId('mw-pipeline-result');

    // All four pipeline stages lit — in registration order — with the trace's
    // own elapsed times; only the 4-arg error-handler stays dark.
    expect(stageOrder()).toEqual([...FLOW_SLOTS]);
    expectLit('logger', '+0.0 ms');
    expectLit('auth', '+0.3 ms');
    expectLit('validator', '+0.6 ms');
    expectLit('handler', '+1.1 ms');
    expectDark('error-handler');

    // The raw outcome: 200 OK on the real URL, trace credited to the body.
    const status = screen.getByTestId('mw-pipeline-status');
    expect(status).toHaveTextContent('200');
    expect(status).toHaveTextContent('OK');
    expect(status).toHaveTextContent(HAPPY_URL);
    expect(screen.getByTestId('mw-pipeline-trace-source')).toHaveTextContent('response body');

    // The pretty-printed server body: trace + stage count + note, verbatim.
    const body = screen.getByTestId('mw-pipeline-body');
    expect(body).toHaveTextContent('"stages": 4');
    expect(body).toHaveTextContent('"label": "handler"');
    expect(body).toHaveTextContent('each stamped relative to the first middleware’s clock');

    // The short-circuit exit line belongs to the other run only.
    expect(screen.queryByTestId('mw-pipeline-exit')).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firedCall = fetchMock.mock.calls[0];
    if (firedCall === undefined) throw new Error('expected the fired request');
    expect(String(firedCall[0])).toBe(HAPPY_URL);
    expect(firedCall[1]?.method).toBe('GET');
  });
});

describe('MiddlewarePipelineDemo — short-circuit', () => {
  it('stops at auth, records the exit, and shows the 401 envelope from the header trace', async () => {
    const fetchMock = (() => {
      stubApiFetch([traceRoute(SHORT_URL, 401, SHORT_BODY, SHORT_TRACE)]);
      return vi.mocked(fetch);
    })();

    render(<MiddlewarePipelineDemo />);
    fireEvent.click(screen.getByTestId('mw-pipeline-run-short-circuit'));

    await screen.findByTestId('mw-pipeline-result');

    // The chain ran logger → auth and stopped: no validator, no handler, no
    // error middleware — 401 envelopes are not errors, they are answers.
    expectLit('logger', '+0.0 ms');
    expectLit('auth', '+0.2 ms');
    expectDark('validator');
    expectDark('handler');
    expectDark('error-handler');

    // The terminal 'short-circuit' entry is surfaced as the recorded exit.
    const exit = screen.getByTestId('mw-pipeline-exit');
    expect(exit).toHaveTextContent('short-circuit');
    expect(exit).toHaveTextContent('stage 3');

    const status = screen.getByTestId('mw-pipeline-status');
    expect(status).toHaveTextContent('401');
    expect(status).toHaveTextContent('Unauthorized');
    expect(status).toHaveTextContent(SHORT_URL);

    // The body belongs to the error envelope; the trace came from the header.
    expect(screen.getByTestId('mw-pipeline-trace-source')).toHaveTextContent('x-pipeline');
    const body = screen.getByTestId('mw-pipeline-body');
    expect(body).toHaveTextContent('"code": "unauthorized"');
    expect(body).toHaveTextContent('the auth middleware answered 401 itself');
    expect(body).toHaveTextContent('next() was never called');
    expect(body).toHaveTextContent(REQUEST_ID);

    // The verdict states the teaching point in plain words.
    expect(screen.getByTestId('mw-pipeline-verdict')).toHaveTextContent(
      'the auth layer responded itself — nothing after it ran',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(SHORT_URL);
  });
});

describe('MiddlewarePipelineDemo — error path', () => {
  it('lights through error-handler and shows the canonical 500 envelope', async () => {
    stubApiFetch([traceRoute(ERROR_URL, 500, ERROR_BODY, ERROR_TRACE)]);

    render(<MiddlewarePipelineDemo />);
    fireEvent.click(screen.getByTestId('mw-pipeline-run-error-path'));

    await screen.findByTestId('mw-pipeline-result');

    // All five stages ran, error-handler last — annotated, not swallowed.
    expectLit('logger', '+0.0 ms');
    expectLit('auth', '+0.2 ms');
    expectLit('validator', '+0.5 ms');
    expectLit('handler', '+0.9 ms');
    expectLit('error-handler', '+1.4 ms');

    const status = screen.getByTestId('mw-pipeline-status');
    expect(status).toHaveTextContent('500');
    expect(status).toHaveTextContent('Internal Server Error');
    expect(status).toHaveTextContent(ERROR_URL);

    // The GLOBAL handler's envelope, rendered from the header-carried trace.
    expect(screen.getByTestId('mw-pipeline-trace-source')).toHaveTextContent('x-pipeline');
    const body = screen.getByTestId('mw-pipeline-body');
    expect(body).toHaveTextContent('"code": "internal_error"');
    expect(body).toHaveTextContent('demo handler exploded on purpose');
    expect(body).toHaveTextContent(REQUEST_ID);

    expect(screen.queryByTestId('mw-pipeline-exit')).not.toBeInTheDocument();
  });
});

describe('MiddlewarePipelineDemo — failure states', () => {
  it('shows a friendly error and keeps the chain dark when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<MiddlewarePipelineDemo />);
    fireEvent.click(screen.getByTestId('mw-pipeline-run-happy'));

    const alert = await screen.findByTestId('mw-pipeline-error');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(screen.queryByTestId('mw-pipeline-result')).not.toBeInTheDocument();
    for (const label of FLOW_SLOTS) expectDark(label);
    expect(screen.queryByTestId('mw-pipeline-exit')).not.toBeInTheDocument();
  });
});
