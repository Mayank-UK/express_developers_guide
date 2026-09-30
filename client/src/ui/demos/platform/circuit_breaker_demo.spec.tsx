import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CircuitBreakerDemo from './circuit_breaker_demo';
import { stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * THE WATCHABLE BREAKER over a STATEFUL stub: the fetch mock runs a tiny model
 * of the real server (a call counter and a mutable world the test can advance
 * between polls), so the spec drives the same choreography the live demo
 * shows — initial CLOSED, three failing calls → OPEN, the fourth rejected-fast
 * at ~0ms, then the heal through HALF_OPEN back to CLOSED.
 */

const STATUS_URL = '/api/demo/reliability/status';
const MODE_URL = '/api/demo/reliability/mode';
const CALL_URL = '/api/demo/reliability/call';
const RESET_URL = '/api/demo/reliability/reset';

interface BreakerWorld {
  state: 'closed' | 'open' | 'half_open';
  mode: 'healthy' | 'failing' | 'slow';
  consecutiveFailures: number;
  totalRejected: number;
  history: { at: string; from: string; to: string; reason: string }[];
  callCount: number;
}

function freshWorld(): BreakerWorld {
  return {
    state: 'closed',
    mode: 'healthy',
    consecutiveFailures: 0,
    totalRejected: 0,
    history: [],
    callCount: 0,
  };
}

function statusBody(world: BreakerWorld) {
  return {
    breaker: {
      name: 'flaky-inventory-service',
      state: world.state,
      consecutiveFailures: world.consecutiveFailures,
      lastFailureAt: null,
      openedAt: null,
      totalRejected: world.totalRejected,
      config: { failureThreshold: 3, cooldownMs: 4000, halfOpenSuccesses: 2, timeoutMs: 300 },
    },
    cooldownRemainingMs: world.state === 'open' ? 4000 : 0,
    flaky: {
      mode: world.mode,
      modes: ['healthy', 'failing', 'slow'],
      latenciesMs: { healthy: 50, failing: 50, slow: 800 },
      timeoutMs: 300,
    },
    history: world.history,
  };
}

/**
 * The model breaker: failing calls count consecutively; the third opens the
 * circuit; the fourth is rejected fast at ~0ms. The test flips `state`
 * manually to simulate the cooldown lapsing and the probes closing it — the
 * REAL state machine is proven server-side (circuit_breaker.spec.ts).
 */
function stubWorld() {
  const world = freshWorld();
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

      if (url === STATUS_URL && method === 'GET') return json(statusBody(world));
      if (url === MODE_URL && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { mode?: string };
        world.mode = (body.mode ?? 'healthy') as BreakerWorld['mode'];
        return json(statusBody(world));
      }
      if (url === CALL_URL && method === 'POST') {
        world.callCount += 1;
        if (world.state === 'open') {
          world.totalRejected += 1;
          return json({
            outcome: 'rejected-fast',
            ms: 0.2,
            breakerState: 'open',
            cooldownRemainingMs: 4000,
            failure: {
              kind: 'unavailable',
              message: 'circuit "flaky-inventory-service" is OPEN — rejected fast',
              details: { rejectedFast: true, cooldownRemainingMs: 4000 },
            },
            note: 'rejected in ~0ms — the dependency was never touched',
          });
        }
        if (world.mode === 'failing') {
          world.consecutiveFailures += 1;
          if (world.consecutiveFailures >= 3) {
            world.state = 'open';
            world.history.unshift({
              at: '2026-09-28T10:00:03.000Z',
              from: 'closed',
              to: 'open',
              reason: '3 consecutive failures (threshold 3)',
            });
          }
          return json({
            outcome: 'failure',
            ms: 51.3,
            breakerState: world.state,
            cooldownRemainingMs: world.state === 'open' ? 4000 : 0,
            failure: { kind: 'unavailable', message: 'simulated dependency failure' },
          });
        }
        return json({
          outcome: 'success',
          ms: 48.9,
          breakerState: world.state,
          cooldownRemainingMs: 0,
          value: { mode: world.mode, note: 'the dependency answered' },
        });
      }
      if (url === RESET_URL && method === 'POST') {
        Object.assign(world, freshWorld());
        return json(statusBody(world));
      }
      return json({ error: { code: 'not_found', message: `no fetch stub for ${url}` } }, 404);
    }),
  );
  return world;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CircuitBreakerDemo — the initial state', () => {
  it('renders the CLOSED badge, the healthy mode, and the empty timeline', async () => {
    stubWorld();
    render(<CircuitBreakerDemo />);

    const badge = await screen.findByTestId('breaker-state', {}, { timeout: 4000 });
    expect(badge).toHaveTextContent('CLOSED');
    expect(screen.getByTestId('breaker-mode')).toHaveTextContent('healthy');
    expect(screen.getByTestId('breaker-counters')).toHaveTextContent('consecutive failures 0');
    expect(screen.getByTestId('breaker-timeline')).toHaveTextContent('no transitions yet');
    expect(screen.queryByTestId('breaker-cooldown')).toBeNull();
  });
});

describe('CircuitBreakerDemo — the trip and the ~0ms rejection', () => {
  it('three failing calls OPEN the circuit; the fourth renders rejected-fast at ~0ms', async () => {
    stubWorld();
    render(<CircuitBreakerDemo />);

    await screen.findByTestId('breaker-state', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('breaker-mode-failing'));
    await waitFor(() => {
      expect(screen.getByTestId('breaker-mode')).toHaveTextContent('failing');
    });

    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByTestId('breaker-call'));
      await screen.findByTestId('breaker-last-call', {}, { timeout: 4000 });
      await waitFor(() => {
        expect(screen.getByTestId('breaker-counters')).toHaveTextContent(
          `consecutive failures ${String(i + 1)}`,
        );
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId('breaker-state')).toHaveTextContent('OPEN');
    });
    // The transition landed in the timeline, newest first.
    expect(screen.getByTestId('breaker-timeline')).toHaveTextContent('closed → open');
    expect(screen.getByTestId('breaker-timeline')).toHaveTextContent('threshold');

    fireEvent.click(screen.getByTestId('breaker-call'));
    const last = await screen.findByTestId('breaker-last-call', {}, { timeout: 4000 });
    expect(last).toHaveTextContent('rejected-fast');
    expect(last).toHaveTextContent('0.2 ms');
    expect(last).toHaveTextContent('~0 milliseconds');
    expect(screen.getByTestId('breaker-counters')).toHaveTextContent('rejected 1');

    // OPEN shows the cooldown countdown (server-computed remaining, never negative).
    const cooldown = await screen.findByTestId('breaker-cooldown', {}, { timeout: 4000 });
    expect(cooldown.textContent ?? '').toMatch(/cooldown [0-4]\.\ds/);
  });
});

describe('CircuitBreakerDemo — the heal flow', () => {
  it('OPEN → (cooldown lapses, stubbed) → HALF_OPEN → CLOSED as the probes land', async () => {
    const world = stubWorld();
    render(<CircuitBreakerDemo />);

    await screen.findByTestId('breaker-state', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('breaker-mode-failing'));
    await waitFor(() => {
      expect(screen.getByTestId('breaker-mode')).toHaveTextContent('failing');
    });
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByTestId('breaker-call'));
      await screen.findByTestId('breaker-last-call', {}, { timeout: 4000 });
    }
    await waitFor(() => {
      expect(screen.getByTestId('breaker-state')).toHaveTextContent('OPEN');
    });

    // The cooldown lapses (the poll observes the half-open state — the real
    // breaker's lazy transition, simulated here by flipping the model).
    world.mode = 'healthy';
    world.state = 'half_open';
    world.history.unshift({ at: '2026-09-28T10:00:08.000Z', from: 'open', to: 'half_open', reason: 'cooldown elapsed' });
    await waitFor(
      () => {
        expect(screen.getByTestId('breaker-state')).toHaveTextContent('HALF_OPEN');
      },
      { timeout: 4000 },
    );
    expect(screen.queryByTestId('breaker-cooldown')).toBeNull();

    // Two healthy probes close it.
    world.state = 'closed';
    world.history.unshift({ at: '2026-09-28T10:00:09.000Z', from: 'half_open', to: 'closed', reason: 'probes passed' });
    fireEvent.click(screen.getByTestId('breaker-call')); // probe 1 (model still says closed)
    await waitFor(() => {
      expect(screen.getByTestId('breaker-last-call')).toHaveTextContent('success');
    });
    await waitFor(() => {
      expect(screen.getByTestId('breaker-state')).toHaveTextContent('CLOSED');
    });
    expect(screen.getByTestId('breaker-timeline')).toHaveTextContent('half_open → closed');
  });
});

describe('CircuitBreakerDemo — reset and failure states', () => {
  it('reset returns the badge to CLOSED with an empty timeline', async () => {
    const world = stubWorld();
    render(<CircuitBreakerDemo />);
    await screen.findByTestId('breaker-state', {}, { timeout: 4000 });

    world.state = 'open';
    world.history.unshift({ at: '2026-09-28T10:00:05.000Z', from: 'closed', to: 'open', reason: 'test' });
    await waitFor(
      () => {
        expect(screen.getByTestId('breaker-state')).toHaveTextContent('OPEN');
      },
      { timeout: 4000 },
    );

    fireEvent.click(screen.getByTestId('breaker-reset'));
    await waitFor(
      () => {
        expect(screen.getByTestId('breaker-state')).toHaveTextContent('CLOSED');
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId('breaker-timeline')).toHaveTextContent('no transitions yet');
    expect(screen.queryByTestId('breaker-last-call')).toBeNull();
  });

  it('degrades to the error strip when the server is unreachable', async () => {
    stubNetworkFailure();
    render(<CircuitBreakerDemo />);

    const error = await screen.findByTestId('breaker-error', {}, { timeout: 4000 });
    expect(error).toHaveTextContent('unreachable');
    expect(screen.getByTestId('breaker-state')).toHaveTextContent('CLOSED'); // the honest default
    expect(screen.getByTestId('breaker-summary')).toBeDefined();
  });
});
