import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StatelessInventoryDemo from './stateless_inventory_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The stateless-inventory demo renders the server's LIVE self-measurement;
 * the spec pins the rendering contract (hazard table + fix column, shared
 * list, verdict, process strip) and that REFRESH re-measures.
 */

const STATE_URL = '/api/demo/scaling/state';

function stateBody() {
  return {
    process: {
      pid: 4242,
      uptimeSeconds: 61,
      replicas: 1,
      note: 'this endpoint measures ITS OWN process',
    },
    stateful: [
      {
        name: 'sessions',
        count: 2,
        shared: false,
        breaksScaling: true,
        where: 'domain/auth/session_store.ts — an in-memory Map',
        fix: 'redis session store (SETEX + TTL) — the redis topic\u2019s structures',
      },
      {
        name: 'rate limiter counters',
        count: null,
        countNote: 'the limiters\u2019 window Maps are module-private',
        configured: true,
        configuration: 'handmade 3 per 30s + express-rate-limit 5 per 60s',
        shared: false,
        breaksScaling: true,
        where: 'presentation/routes/security_demo_routes.ts',
        fix: 'redis-backed counters so the budget is GLOBAL',
      },
      {
        name: 'job queue',
        count: 0,
        shared: false,
        breaksScaling: true,
        where: 'domain/jobs/job_queue.ts',
        fix: 'a shared broker (redis lists/streams)',
      },
      {
        name: 'SSE connections',
        count: 1,
        shared: false,
        breaksScaling: true,
        where: 'presentation/routes/sse_demo_routes.ts',
        fix: 'sticky sessions + redis pub/sub',
      },
    ],
    statelessOrShared: [
      {
        name: 'posts (sqlite)',
        shared: 'filesystem volume (one file, one writer)',
        configured: true,
        note: 'single-writer ok — NOT multi-replica',
      },
      { name: 'mongo events', shared: true, configured: false, note: 'externalized state' },
      { name: 'redis cache', shared: true, configured: true, note: 'the landing spot for the hazards' },
    ],
    verdict: 'This process holds 4 scaling hazards — the fix column shows the way out',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StatelessInventoryDemo — the hazard table', () => {
  it('renders every hazard with its LIVE count, breaks-scaling badge, and the fix column', async () => {
    stubApiFetch([{ url: STATE_URL, body: stateBody() }]);
    render(<StatelessInventoryDemo />);

    const rows = await screen.findAllByTestId('scaling-hazard-row', {}, { timeout: 4000 });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('sessions');
    expect(rows[0]).toHaveTextContent('redis session store'); // the fix column
    expect(rows[1]).toHaveTextContent('not exposed'); // null count renders honestly
    expect(rows[1]).toHaveTextContent('3 per 30s'); // the configured fallback
    expect(rows[3]).toHaveTextContent('SSE connections');

    // LIVE counts render as numbers; every row carries the badge.
    const counts = await screen.findAllByTestId('scaling-hazard-count');
    expect(counts[0]).toHaveTextContent('2');
    expect(screen.getAllByTestId('scaling-hazard-badge')).toHaveLength(4);
    expect(screen.getAllByTestId('scaling-hazard-badge')[0]).toHaveTextContent('breaks scaling');
  });

  it('renders the process strip, the explainer, the shared list, and the verdict', async () => {
    stubApiFetch([{ url: STATE_URL, body: stateBody() }]);
    render(<StatelessInventoryDemo />);

    await screen.findAllByTestId('scaling-hazard-row', {}, { timeout: 4000 });
    expect(screen.getByTestId('scaling-process')).toHaveTextContent('pid 4242');
    expect(screen.getByTestId('scaling-process')).toHaveTextContent('replicas 1');
    expect(screen.getByTestId('scaling-explainer')).toHaveTextContent('DIFFERENT');
    expect(screen.getAllByTestId('scaling-shared-row')).toHaveLength(3);
    expect(screen.getByTestId('scaling-shared')).toHaveTextContent('posts (sqlite)');
    expect(screen.getByTestId('scaling-verdict')).toHaveTextContent('4 scaling hazards');
  });
});

describe('StatelessInventoryDemo — refresh re-measures', () => {
  it('REFRESH refires the fetch and renders the new counts', async () => {
    let callCount = 0;
    let sessions = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount += 1;
        const body = stateBody();
        body.stateful[0]!.count = sessions;
        return {
          ok: true,
          status: 200,
          json: async () => body,
        };
      }),
    );
    render(<StatelessInventoryDemo />);

    await screen.findAllByTestId('scaling-hazard-row', {}, { timeout: 4000 });
    expect(callCount).toBe(1);

    sessions = 7; // the login happened server-side
    fireEvent.click(screen.getByTestId('scaling-refresh'));
    await waitFor(
      () => {
        expect(screen.getAllByTestId('scaling-hazard-count')[0]).toHaveTextContent('7');
      },
      { timeout: 4000 },
    );
    expect(callCount).toBe(2);
  });
});

describe('StatelessInventoryDemo — failure states', () => {
  it('degrades to the error strip when the server is unreachable', async () => {
    stubNetworkFailure();
    render(<StatelessInventoryDemo />);

    const error = await screen.findByTestId('scaling-error', {}, { timeout: 4000 });
    expect(error).toHaveTextContent('unreachable');
    expect(screen.queryByTestId('scaling-hazard-row')).toBeNull();
  });
});
