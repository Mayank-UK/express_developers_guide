import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OrderSagaDemo from './order_saga_demo';
import { stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The saga console against a STATEFUL stub (the breaker spec's pattern): the
 * start endpoint answers a running saga, and the detail endpoint answers the
 * running shape for the first N polls, then the terminal shape — the same
 * choreography the real queue-driven manager produces. The server spec pins
 * the LIVE contract: retries before dead-letter, reverse compensations over
 * attempted steps, attempts=3 on the failed step.
 */

const START_URL = '/api/demo/patterns/saga/start';
const DETAIL_URL = '/api/demo/patterns/saga/saga_1';
const RESET_URL = '/api/demo/patterns/saga/reset';

const RUNNING = {
  sagaId: 'saga_1',
  orderId: 'ord-42',
  failAt: 'charge-card',
  state: 'running',
  finishedAt: null,
  steps: [
    { step: 'place-order', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_1' },
    { step: 'reserve-stock', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_2' },
    { step: 'charge-card', kind: 'forward', status: 'pending', attempts: 1, jobId: 'job_3' },
    { step: 'ship', kind: 'forward', status: 'pending', attempts: 0 },
  ],
};

const COMPENSATED = {
  sagaId: 'saga_1',
  orderId: 'ord-42',
  failAt: 'charge-card',
  state: 'compensated',
  finishedAt: '2026-09-29T10:00:09.123Z',
  steps: [
    { step: 'place-order', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_1' },
    { step: 'reserve-stock', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_2' },
    { step: 'charge-card', kind: 'forward', status: 'dead-lettered', attempts: 3, jobId: 'job_3' },
    { step: 'ship', kind: 'forward', status: 'skipped', attempts: 0 },
    { step: 'refund-card', kind: 'compensation', status: 'compensated', attempts: 0, jobId: 'job_4' },
    { step: 'release-stock', kind: 'compensation', status: 'compensated', attempts: 0, jobId: 'job_5' },
    { step: 'cancel-order', kind: 'compensation', status: 'compensated', attempts: 0, jobId: 'job_6' },
  ],
};

const COMPLETED = {
  sagaId: 'saga_1',
  orderId: 'ord-42',
  failAt: 'none',
  state: 'completed',
  finishedAt: '2026-09-29T10:00:04.456Z',
  steps: [
    { step: 'place-order', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_1' },
    { step: 'reserve-stock', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_2' },
    { step: 'charge-card', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_3' },
    { step: 'ship', kind: 'forward', status: 'succeeded', attempts: 0, jobId: 'job_4' },
  ],
};

/** detail answers `running` for the first `runningPolls` GETs, then `terminal`. */
function stubSagaWorld(runningPolls: number, terminal: Record<string, unknown>): void {
  let detailCalls = 0;
  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === START_URL && method === 'POST') return json({ saga: RUNNING }, 201);
      if (url === DETAIL_URL && method === 'GET') {
        detailCalls += 1;
        return json({ saga: detailCalls <= runningPolls ? RUNNING : terminal });
      }
      if (url === RESET_URL && method === 'POST') return json({ reset: true, note: 'fresh manager.' });
      return json({ error: { code: 'not_found', message: `no fetch stub for ${url}` } }, 404);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OrderSagaDemo — start', () => {
  it('starts into RUNNING with the four forward steps and the failure-injection chip', async () => {
    stubSagaWorld(99, COMPENSATED);

    render(<OrderSagaDemo />);
    fireEvent.click(screen.getByTestId('saga-start'));

    const badge = await screen.findByTestId('saga-state', {}, { timeout: 4000 });
    expect(badge).toHaveTextContent('RUNNING');
    expect(screen.getByTestId('saga-failat-chip')).toHaveTextContent('failure injected at: charge-card');
    const rows = screen.getAllByTestId('saga-step-row');
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row).toHaveTextContent('forward');
    }
    expect(screen.getByTestId('saga-steps')).toHaveTextContent('place-order');
    expect(screen.getByTestId('saga-steps')).toHaveTextContent('ship');
  });
});

describe('OrderSagaDemo — the compensated run', () => {
  it('settles COMPENSATED with the dead-lettered step and the compensations unwinding in reverse', async () => {
    stubSagaWorld(1, COMPENSATED);

    render(<OrderSagaDemo />);
    fireEvent.click(screen.getByTestId('saga-start'));

    const badge = await screen.findByText('COMPENSATED', {}, { timeout: 4000 });
    expect(badge).toBeDefined();

    const rows = screen.getAllByTestId('saga-step-row');
    expect(rows.length).toBe(7);
    // The failing forward step: retried by the queue, then dead-lettered.
    expect(rows[2]).toHaveTextContent('charge-card');
    expect(rows[2]).toHaveTextContent('dead-lettered');
    expect(rows[2]).toHaveTextContent('attempts ×3');
    // The rest of the forward work was skipped.
    expect(rows[3]).toHaveTextContent('ship');
    expect(rows[3]).toHaveTextContent('skipped');
    // Compensations run in REVERSE over attempted steps — the failed one first.
    expect(rows[4]).toHaveTextContent('refund-card');
    expect(rows[5]).toHaveTextContent('release-stock');
    expect(rows[6]).toHaveTextContent('cancel-order');
    for (const row of [rows[4], rows[5], rows[6]]) {
      expect(row).toHaveTextContent('compensation');
      expect(row).toHaveTextContent('compensated');
    }
    expect(screen.getByTestId('saga-state')).toHaveTextContent('COMPENSATED');
    expect(screen.getByText('finished 10:00:09Z')).toBeDefined();
  });
});

describe('OrderSagaDemo — the completed run', () => {
  it('settles COMPLETED with all four forward steps succeeded', async () => {
    stubSagaWorld(0, COMPLETED);

    render(<OrderSagaDemo />);
    fireEvent.click(screen.getByTestId('saga-start'));

    await screen.findByText('COMPLETED', {}, { timeout: 4000 });
    const rows = screen.getAllByTestId('saga-step-row');
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row).toHaveTextContent('succeeded');
      expect(row).toHaveTextContent('attempts ×0');
    }
    expect(screen.queryByTestId('saga-failat-chip')).toBeNull();
  });
});

describe('OrderSagaDemo — failure states and reset', () => {
  it('degrades to the error strip when the saga API is unreachable', async () => {
    stubNetworkFailure();

    render(<OrderSagaDemo />);
    fireEvent.click(screen.getByTestId('saga-start'));

    await screen.findByTestId('saga-error');
    expect(screen.getByTestId('saga-summary')).toBeDefined();
    expect(screen.getByTestId('saga-empty')).toBeDefined();
  });

  it('reset returns the console to the empty state', async () => {
    stubSagaWorld(0, COMPLETED);

    render(<OrderSagaDemo />);
    fireEvent.click(screen.getByTestId('saga-start'));
    await screen.findByText('COMPLETED', {}, { timeout: 4000 });

    fireEvent.click(screen.getByTestId('saga-reset'));
    await waitFor(() => {
      expect(screen.getByTestId('saga-empty')).toBeDefined();
    });
    expect(screen.queryByTestId('saga-state')).toBeNull();
  });
});
