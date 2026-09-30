import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StallDiagnosisDemo from './stall_diagnosis_demo';
import { stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The stall diagnosis over STUBBED SEQUENCES of the three real endpoints.
 * The metrics stub is a per-URL FIFO queue, because the story is temporal:
 * baseline (max 9ms) → blocking probe (303.4ms) → three polls whose max JUMPS
 * to 340 and stays flat (the cumulative histogram absorbing the stall) →
 * deferred probe (10.2ms) → three flat polls. The polls land 500ms apart in
 * real time, so budgets are generous — the same discipline the files
 * workbench spec learned under load.
 */

const METRICS_URL = '/api/demo/obs/metrics';
const BLOCKING_URL = '/api/demo/node/blocking?workMs=300';
const DEFERRED_URL = '/api/demo/node/deferred?workMs=300';

function metrics(max: number, mean = 1.4) {
  return {
    uptimeSeconds: 412,
    memory: { rssBytes: 1, heapTotalBytes: 1, heapUsedBytes: 1, externalBytes: 1 },
    eventLoopDelayMs: { mean, p99: max, max, note: 'cumulative since process start' },
    requests: { total: 1, byStatusClass: {}, inFlight: 0, durations: { count: 0, p50Ms: null, p95Ms: null } },
  };
}

/** Per-URL FIFO queue stub: same endpoint, different answer each call — the order a live server produces. */
function stubSequences(queues: Record<string, unknown[]>): void {
  const served: Record<string, number> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const index = served[url] ?? 0;
      served[url] = index + 1;
      const queue = queues[url];
      const body = queue !== undefined ? queue[index] : undefined;
      if (body === undefined) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { code: 'not_found', message: `no queued stub for ${url} call #${String(index + 1)}` } }),
        };
      }
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StallDiagnosisDemo — phase 1: the baseline', () => {
  it('renders the real histogram readings (mean/max) from the metrics endpoint', async () => {
    stubSequences({ [METRICS_URL]: [metrics(9, 1.213)] });

    render(<StallDiagnosisDemo />);
    fireEvent.click(screen.getByTestId('stall-baseline-button'));

    const baseline = await screen.findByTestId('stall-baseline', {}, { timeout: 4000 });
    expect(baseline).toHaveTextContent('mean: 1.213ms');
    expect(baseline).toHaveTextContent('max: 9ms');
    expect(baseline).toHaveTextContent('cumulative since process start');
  });
});

describe('StallDiagnosisDemo — phase 2: the stall, caught in the act', () => {
  it('renders the probe measurement, three poll bars with the max spike, and the verdict', async () => {
    stubSequences({
      [METRICS_URL]: [metrics(9, 1.213), metrics(340, 4.1), metrics(341, 4.1), metrics(341, 4.1)],
      [BLOCKING_URL]: [{ mode: 'blocking', workMs: 300, eventLoopDelayMs: 303.4 }],
    });

    render(<StallDiagnosisDemo />);
    // Baseline first — the verdict's "jumped X → Y" needs the before-reading.
    fireEvent.click(screen.getByTestId('stall-baseline-button'));
    await screen.findByTestId('stall-baseline', {}, { timeout: 4000 });

    fireEvent.click(screen.getByTestId('stall-run-button'));

    // The three polls land 500ms apart (real timers). The verdict element
    // renders as soon as poll 1 arrives — so wait for the THIRD bar, then
    // assert on the completed sequence.
    await waitFor(
      () => {
        expect(screen.getAllByTestId('stall-poll-row')).toHaveLength(3);
      },
      { timeout: 8000 },
    );
    const verdict = screen.getByTestId('stall-verdict');
    expect(screen.getByTestId('stall-probe')).toHaveTextContent('303.4ms');
    expect(verdict).toHaveTextContent('9ms → 340ms');
    expect(verdict).toHaveTextContent('every concurrent request waited');

    const rows = screen.getAllByTestId('stall-poll-row');
    // The spike is labeled: poll 1 shows the jumped max, polls 2–3 stay flat.
    expect(rows[0]).toHaveTextContent('max 340ms');
    expect(rows[2]).toHaveTextContent('max 341ms');
    expect(screen.getAllByTestId('stall-poll-bar')).toHaveLength(3);
  }, 12000);
});

describe('StallDiagnosisDemo — phase 3: the control', () => {
  it('renders the sliced workload\u2019s probe (~one slice) and the flat histogram verdict', async () => {
    stubSequences({
      [METRICS_URL]: [metrics(9, 1.213), metrics(340), metrics(341), metrics(341), metrics(341), metrics(341), metrics(341)],
      [BLOCKING_URL]: [{ mode: 'blocking', workMs: 300, eventLoopDelayMs: 303.4 }],
      [DEFERRED_URL]: [{ mode: 'deferred', workMs: 300, eventLoopDelayMs: 10.2 }],
    });

    render(<StallDiagnosisDemo />);
    fireEvent.click(screen.getByTestId('stall-baseline-button'));
    await screen.findByTestId('stall-baseline', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('stall-run-button'));
    // The verdict renders after poll 1 — wait for all THREE bars so the stall
    // phase has fully settled (and the control button re-enabled) before
    // firing the next phase.
    await waitFor(
      () => {
        expect(screen.getAllByTestId('stall-poll-row')).toHaveLength(3);
      },
      { timeout: 8000 },
    );

    fireEvent.click(screen.getByTestId('stall-control-button'));

    const verdict = await screen.findByTestId('stall-control-verdict', {}, { timeout: 6000 });
    expect(screen.getByTestId('stall-control-probe')).toHaveTextContent('10.2ms');
    expect(verdict).toHaveTextContent('same 300ms of work');
    expect(verdict).toHaveTextContent('341ms'); // the histogram did not move past the stall phase

    const rows = screen.getAllByTestId('stall-control-row');
    expect(rows).toHaveLength(3);
    // Flat across all three control polls — no new stall was absorbed.
    expect(rows.every((row) => row.textContent?.includes('max 341ms'))).toBe(true);
  }, 12000);
});

describe('StallDiagnosisDemo — failure states', () => {
  it('degrades to the error strip when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<StallDiagnosisDemo />);
    fireEvent.click(screen.getByTestId('stall-baseline-button'));

    await screen.findByTestId('stall-error');
    expect(screen.getByTestId('stall-summary')).toBeDefined();
  });
});
