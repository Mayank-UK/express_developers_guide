import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import EventLoopDemo from './event_loop_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEFERRED_URL = '/api/demo/node/deferred?workMs=300';
const BLOCKING_URL = '/api/demo/node/blocking?workMs=300';

const deferredPayload = { mode: 'deferred', workMs: 300, eventLoopDelayMs: 11.4 };
const blockingPayload = { mode: 'blocking', workMs: 300, eventLoopDelayMs: 303.6 };

describe('EventLoopDemo', () => {
  it('renders the idle state with the run button, fetching nothing', () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: DEFERRED_URL, body: deferredPayload },
        { url: BLOCKING_URL, body: blockingPayload },
      ]);
      return vi.mocked(fetch);
    })();

    render(<EventLoopDemo />);

    expect(screen.getByTestId('event-loop-run')).toHaveTextContent('Run both for 300ms');
    expect(screen.queryByTestId('event-loop-results')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs both endpoints and renders the measured stalls with a verdict', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: DEFERRED_URL, body: deferredPayload },
        { url: BLOCKING_URL, body: blockingPayload },
      ]);
      return vi.mocked(fetch);
    })();

    render(<EventLoopDemo />);
    fireEvent.click(screen.getByTestId('event-loop-run'));

    const results = await screen.findByTestId('event-loop-results');
    expect(results).toBeInTheDocument();

    // Both rows: mode, workload, and the measured event-loop stall.
    expect(screen.getByTestId('event-loop-row-deferred')).toHaveTextContent('deferred');
    expect(screen.getByTestId('event-loop-row-deferred')).toHaveTextContent('11 ms');
    expect(screen.getByTestId('event-loop-row-blocking')).toHaveTextContent('blocking');
    expect(screen.getByTestId('event-loop-row-blocking')).toHaveTextContent('304 ms');

    const verdict = screen.getByTestId('event-loop-verdict');
    expect(verdict).toHaveTextContent('froze the loop for 304 ms');
    expect(verdict).toHaveTextContent('Same work');

    // Both endpoints were hit exactly once, with the 300ms workload.
    const urls = fetchMock.mock.calls.map(([input]) => String(input)).sort();
    expect(urls).toEqual([BLOCKING_URL, DEFERRED_URL]);
  });

  it('shows the server error message when an endpoint fails', async () => {
    stubApiFetch([
      { url: DEFERRED_URL, body: deferredPayload },
      {
        url: BLOCKING_URL,
        status: 400,
        body: { error: { code: 'validation_failed', message: 'bad workMs', requestId: 'r-1' } },
      },
    ]);

    render(<EventLoopDemo />);
    fireEvent.click(screen.getByTestId('event-loop-run'));

    const alert = await screen.findByTestId('event-loop-error');
    expect(alert).toHaveTextContent('bad workMs');
    expect(screen.queryByTestId('event-loop-results')).not.toBeInTheDocument();
  });

  it('shows a friendly error when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<EventLoopDemo />);
    fireEvent.click(screen.getByTestId('event-loop-run'));

    const alert = await screen.findByTestId('event-loop-error');
    expect(alert).toHaveTextContent('Could not reach the server.');
  });
});
