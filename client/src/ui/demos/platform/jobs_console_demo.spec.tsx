import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import JobsConsoleDemo from './jobs_console_demo';

/**
 * jsdom talks to a MUTABLE in-memory stand-in for the real queue endpoints:
 * the stub owns a little job table the tests flip between polls (the demo
 * polls every 1s), and every POST mutates it the way the server would. The
 * queue's real lifecycle is exercised end-to-end in the SERVER specs.
 */

const JOBS_URL = '/api/demo/jobs';
const STATS_URL = '/api/demo/jobs/stats';
/** The poll period is 1s — waits must outlive at least one full interval.
 * (Bumped to 10s: the only explicitly-budgeted sub-4s wait in the client
 * specs, and this file chains poll→POST→re-poll fetch→render rounds that
 * miss shorter budgets under heavy ambient load.) */
const SETTLE = { timeout: 10000 };

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

let calls: RecordedCall[];
let jobsState: Record<string, unknown>[];
let statsState: Record<string, unknown>;

function defaultStats(): Record<string, unknown> {
  return {
    queued: 0,
    running: 0,
    succeeded: 0,
    dead: 0,
    totalEnqueued: 0,
    oldestQueuedAgeMs: null,
    scheduler: { running: false, lastRunAt: null, intervalMs: 5000 },
    config: { baseDelayMs: 300, maxAttempts: 3 },
  };
}

function jsonLike(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
  };
}

beforeEach(() => {
  calls = [];
  jobsState = [];
  statsState = defaultStats();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });

      if (url === JOBS_URL && method === 'GET') {
        return jsonLike({ jobs: jobsState, total: jobsState.length, limit: 50 });
      }
      if (url === STATS_URL && method === 'GET') {
        return jsonLike(statsState);
      }
      if (url === `${JOBS_URL}/enqueue` && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { type: string; payload: Record<string, unknown> };
        const job = {
          id: `job_${String(jobsState.length + 1)}`,
          type: body.type,
          payload: body.payload,
          status: 'queued',
          attempts: 0,
          history: [{ at: '2026-09-28T10:00:00.000Z', event: 'enqueued' }],
        };
        jobsState = [job, ...jobsState];
        statsState = { ...statsState, queued: (statsState.queued as number) + 1, totalEnqueued: (statsState.totalEnqueued as number) + 1 };
        return jsonLike({ job }, 201);
      }
      if (url === `${JOBS_URL}/scheduler` && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { running: boolean };
        statsState = {
          ...statsState,
          scheduler: {
            ...(statsState.scheduler as Record<string, unknown>),
            running: body.running,
            lastRunAt: body.running ? '2026-09-28T10:00:01.000Z' : null,
          },
        };
        return jsonLike({ scheduler: statsState.scheduler });
      }
      if (url.endsWith('/requeue') && method === 'POST') {
        const id = url.slice(JOBS_URL.length + 1, -'/requeue'.length);
        jobsState = jobsState.map((job) =>
          job.id === id
            ? {
                ...job,
                status: 'queued',
                attempts: 0,
                history: [
                  ...((job.history as unknown[]) ?? []),
                  { at: '2026-09-28T10:00:02.000Z', event: 'requeued' },
                ],
              }
            : job,
        );
        const replayed = jobsState.find((job) => job.id === id);
        return jsonLike({ job: replayed });
      }
      if (url === JOBS_URL && method === 'DELETE') {
        jobsState = [];
        statsState = defaultStats();
        return jsonLike({ cleared: true, scheduler: statsState.scheduler });
      }
      return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const byMethodGet = (url: string): RecordedCall[] =>
  calls.filter((call) => call.url === url && call.method === 'GET');

describe('JobsConsoleDemo — the watchable queue', () => {
  it('renders the stats strip and the empty board from the first poll', async () => {
    render(<JobsConsoleDemo />);

    await waitFor(() => {
      expect(screen.getByTestId('jobs-stats')).toHaveTextContent('queued 0');
    }, SETTLE);
    expect(screen.getByTestId('jobs-stats')).toHaveTextContent('dead 0');
    expect(screen.getByTestId('jobs-stats')).toHaveTextContent('oldest —');
    expect(screen.getByTestId('jobs-board')).toHaveTextContent('the queue is empty');
    expect(screen.getByTestId('jobs-scheduler-state')).toHaveTextContent('idle · every 5.0s');
  });

  it('enqueues the flaky preset with the right POST, and the card appears', async () => {
    render(<JobsConsoleDemo />);
    await waitFor(() => {
      expect(screen.getByTestId('jobs-board')).toHaveTextContent('the queue is empty');
    }, SETTLE);

    fireEvent.click(screen.getByTestId('jobs-enqueue-flaky'));

    const post = calls.find((call) => call.url === `${JOBS_URL}/enqueue` && call.method === 'POST');
    expect(post?.body).toBe(
      JSON.stringify({ type: 'email', payload: { forceFailures: 2, latencyMs: 60 } }),
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('jobs-card')).toHaveLength(1);
    }, SETTLE);
    expect(screen.getByTestId('jobs-status-queued')).toBeDefined();
    expect(screen.getByTestId('jobs-attempts')).toHaveTextContent('0/3 attempts');
  });

  it('renders the retry ladder: transitions to succeeded with backoff delays visible in history', async () => {
    render(<JobsConsoleDemo />);
    await waitFor(() => {
      expect(screen.getByTestId('jobs-board')).toHaveTextContent('the queue is empty');
    }, SETTLE);
    fireEvent.click(screen.getByTestId('jobs-enqueue-flaky'));
    await waitFor(() => {
      expect(screen.getAllByTestId('jobs-card')).toHaveLength(1);
    }, SETTLE);

    // The server-side story finishes; the next poll carries the verdict.
    jobsState = [
      {
        id: 'job_1',
        type: 'email',
        payload: { forceFailures: 2, latencyMs: 60 },
        status: 'succeeded',
        attempts: 2,
        history: [
          { at: '2026-09-28T10:00:00.100Z', event: 'enqueued' },
          { at: '2026-09-28T10:00:00.200Z', event: 'running', attempt: 1 },
          { at: '2026-09-28T10:00:00.300Z', event: 'retry_scheduled', attempt: 1, delayMs: 312 },
          { at: '2026-09-28T10:00:00.700Z', event: 'running', attempt: 2 },
          { at: '2026-09-28T10:00:00.800Z', event: 'retry_scheduled', attempt: 2, delayMs: 583 },
          { at: '2026-09-28T10:00:01.400Z', event: 'running', attempt: 3 },
          { at: '2026-09-28T10:00:01.500Z', event: 'succeeded', attempt: 3 },
        ],
      },
    ];
    statsState = { ...defaultStats(), succeeded: 1, totalEnqueued: 1 };

    await waitFor(() => {
      expect(screen.getByTestId('jobs-status-succeeded')).toBeDefined();
    }, SETTLE);
    expect(screen.getByTestId('jobs-attempts')).toHaveTextContent('2/3 attempts');

    fireEvent.click(screen.getByTestId('jobs-history-toggle'));
    const history = await screen.findByTestId('jobs-history');
    expect(history).toHaveTextContent('enqueued');
    expect(history).toHaveTextContent('retry_scheduled · attempt 1');
    expect(history).toHaveTextContent('(+312ms backoff)');
    expect(history).toHaveTextContent('(+583ms backoff)');
    expect(history).toHaveTextContent('succeeded · attempt 3');
    expect(screen.queryByTestId('jobs-requeue')).toBeNull(); // not dead — no replay
  });

  it('dead jobs get the dead chip and a working REQUEUE button', async () => {
    render(<JobsConsoleDemo />);
    jobsState = [
      {
        id: 'job_7',
        type: 'email',
        payload: { alwaysFail: true },
        status: 'dead',
        attempts: 3,
        history: [
          { at: '2026-09-28T10:00:00.000Z', event: 'enqueued' },
          { at: '2026-09-28T10:00:01.000Z', event: 'dead_lettered', attempt: 3, lastError: 'simulated sender: alwaysFail requested' },
        ],
      },
    ];
    statsState = { ...defaultStats(), dead: 1, totalEnqueued: 1 };

    await waitFor(() => {
      expect(screen.getByTestId('jobs-status-dead')).toBeDefined();
    }, SETTLE);
    const requeue = screen.getByTestId('jobs-requeue');
    expect(requeue).toBeDefined();

    fireEvent.click(requeue);
    await waitFor(() => {
      expect(screen.getByTestId('jobs-status-queued')).toBeDefined();
    }, SETTLE);
    const posted = calls.find((call) => call.url === `${JOBS_URL}/job_7/requeue` && call.method === 'POST');
    expect(posted).toBeDefined();
    expect(screen.getByTestId('jobs-attempts')).toHaveTextContent('0/3 attempts'); // fresh budget
  });

  it('scheduler jobs carry the source badge, and the toggle fires the right POST', async () => {
    render(<JobsConsoleDemo />);
    await waitFor(() => {
      expect(screen.getByTestId('jobs-stats')).toHaveTextContent('queued 0');
    }, SETTLE);

    fireEvent.click(screen.getByTestId('jobs-scheduler-toggle'));
    const post = calls.find((call) => call.url === `${JOBS_URL}/scheduler` && call.method === 'POST');
    expect(post?.body).toBe(JSON.stringify({ running: true }));
    await waitFor(() => {
      expect(screen.getByTestId('jobs-scheduler-state')).toHaveTextContent('ticking');
    }, SETTLE);

    // A scheduler-enqueued report job lands on the board with its badge.
    jobsState = [
      {
        id: 'job_2',
        type: 'report',
        payload: { source: 'scheduler', tick: 1 },
        status: 'succeeded',
        attempts: 0,
        history: [
          { at: '2026-09-28T10:00:05.000Z', event: 'enqueued' },
          { at: '2026-09-28T10:00:05.200Z', event: 'succeeded', attempt: 1 },
        ],
      },
    ];
    await waitFor(() => {
      expect(screen.getByTestId('jobs-source-badge')).toHaveTextContent('scheduler · tick 1');
    }, SETTLE);
  });

  it('clear posts DELETE and empties the board', async () => {
    render(<JobsConsoleDemo />);
    jobsState = [
      {
        id: 'job_1',
        type: 'email',
        payload: {},
        status: 'succeeded',
        attempts: 0,
        history: [{ at: '2026-09-28T10:00:00.000Z', event: 'enqueued' }],
      },
    ];
    await waitFor(() => {
      expect(screen.getAllByTestId('jobs-card')).toHaveLength(1);
    }, SETTLE);

    fireEvent.click(screen.getByTestId('jobs-clear'));
    const del = calls.find((call) => call.url === JOBS_URL && call.method === 'DELETE');
    expect(del).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('jobs-board')).toHaveTextContent('the queue is empty');
    }, SETTLE);
  });

  it('an unreachable API shows the error strip without crashing', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<JobsConsoleDemo />);

    await waitFor(() => {
      expect(screen.getByTestId('jobs-error')).toHaveTextContent('unreachable');
    }, SETTLE);
    expect(screen.getByTestId('jobs-summary')).toBeDefined();
  });

  it('stops polling on unmount — no fetch after the interval would have fired', async () => {
    const mounted = render(<JobsConsoleDemo />);
    await waitFor(() => {
      expect(byMethodGet(JOBS_URL).length).toBeGreaterThanOrEqual(1);
    }, SETTLE);

    const before = byMethodGet(JOBS_URL).length;
    mounted.unmount();

    // Wait past one full poll interval; a leaked timer would have fetched.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(byMethodGet(JOBS_URL)).toHaveLength(before);
  });
});
