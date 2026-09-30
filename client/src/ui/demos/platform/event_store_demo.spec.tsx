import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EventStoreDemo from './event_store_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The event-sourced account console against stubs shaped like the real
 * payloads. The server spec pins the LIVE contract: append-time overdraft
 * rejection (409 + withdrawal-rejected event), optimistic-concurrency
 * conflicts (409, nothing written), snapshot boundaries and project()
 * rebuilds — here we prove the console renders each outcome.
 */

const OPEN_URL = '/api/demo/patterns/eventstore/accounts';
const DEPOSIT_URL = '/api/demo/patterns/eventstore/accounts/account-1/deposit';
const WITHDRAW_URL = '/api/demo/patterns/eventstore/accounts/account-1/withdraw';
const VIEW_URL = '/api/demo/patterns/eventstore/accounts/account-1';
const STATS_URL = '/api/demo/patterns/eventstore/stats';

const OPEN = {
  streamId: 'account-1',
  version: 0,
  events: [{ seq: 0, data: { type: 'account-opened', owner: 'Ada' }, recordedAt: '2026-09-29T10:00:00.000Z' }],
  note: 'account-opened appended.',
};

const FULL_VIEW = {
  streamId: 'account-1',
  version: 2,
  balanceCents: 3000,
  owner: 'Ada',
  events: [
    { seq: 0, data: { type: 'account-opened', owner: 'Ada' }, recordedAt: '2026-09-29T10:00:00.000Z' },
    { seq: 1, data: { type: 'money-deposited', amountCents: 5000 }, recordedAt: '2026-09-29T10:00:01.000Z' },
    { seq: 2, data: { type: 'money-withdrawn', amountCents: 2000 }, recordedAt: '2026-09-29T10:00:02.000Z' },
  ],
  load: { usedSnapshot: false, replayedEvents: 3, totalEvents: 3, consistent: true, fullReplayBalanceCents: 3000 },
  history: [
    { type: 'account-opened', amountCents: 0, balanceAfterCents: 0 },
    { type: 'money-deposited', amountCents: 5000, balanceAfterCents: 5000 },
    { type: 'money-withdrawn', amountCents: -2000, balanceAfterCents: 3000 },
  ],
  note: 'the fold.',
};

const STATS = {
  streams: 1,
  events: 3,
  snapshotEvery: 5,
  snapshots: [],
  projection: { rebuilds: 0, entries: 3 },
  note: 'stats.',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function setAmount(value: string): void {
  fireEvent.change(screen.getByTestId('eventstore-amount'), { target: { value } });
}

describe('EventStoreDemo — open, deposit, withdraw, fold', () => {
  it('runs the happy path: commands append, the fold and the running balances follow', async () => {
    stubApiFetch([
      { url: OPEN_URL, method: 'POST', status: 201, body: OPEN },
      {
        url: DEPOSIT_URL,
        method: 'POST',
        body: { streamId: 'account-1', version: 1, appended: [{ seq: 1 }], balanceCents: 5000, snapshot: null },
      },
      {
        url: WITHDRAW_URL,
        method: 'POST',
        body: { streamId: 'account-1', withdrawn: true, version: 2, appended: [{ seq: 2 }], balanceCents: 3000 },
      },
      { url: VIEW_URL, body: FULL_VIEW },
      { url: STATS_URL, body: STATS },
    ]);

    render(<EventStoreDemo />);
    expect(screen.getByTestId('eventstore-empty')).toBeDefined();

    fireEvent.click(screen.getByTestId('eventstore-open'));
    await screen.findByTestId('eventstore-stream');
    expect(screen.getByTestId('eventstore-stream')).toHaveTextContent('account-1');
    expect(screen.getByTestId('eventstore-command')).toHaveTextContent('expectedVersion -1');

    setAmount('5000');
    fireEvent.click(screen.getByTestId('eventstore-deposit'));
    await waitFor(() => {
      expect(screen.getByTestId('eventstore-command')).toHaveTextContent('version 1');
    });

    setAmount('2000');
    fireEvent.click(screen.getByTestId('eventstore-withdraw'));
    await waitFor(() => {
      expect(screen.getByTestId('eventstore-command')).toHaveTextContent('version 2');
      expect(screen.getByTestId('eventstore-command')).toHaveTextContent('3000¢');
    });

    const events = screen.getAllByTestId('eventstore-event');
    expect(events.length).toBe(3);
    expect(events[0]).toHaveTextContent('account-opened');
    expect(events[1]).toHaveTextContent('money-deposited 5000¢');
    expect(events[2]).toHaveTextContent('money-withdrawn 2000¢');

    const history = screen.getAllByTestId('eventstore-history-row');
    expect(history.length).toBe(3);
    expect(history[1]).toHaveTextContent('5000¢');
    expect(history[2]).toHaveTextContent('-2000¢');
    expect(history[2]).toHaveTextContent('balance 3000¢');

    expect(screen.getByTestId('eventstore-fold')).toHaveTextContent('full-history fold (3/3 events)');
  });
});

describe('EventStoreDemo — the append-time rejections', () => {
  it('an overdraft renders the refusal strip and the recorded withdrawal-rejected event', async () => {
    stubApiFetch([
      { url: OPEN_URL, method: 'POST', status: 201, body: OPEN },
      {
        url: WITHDRAW_URL,
        method: 'POST',
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'overdraft refused — insufficient funds',
            requestId: '7a4f2c1e-9b3d-4e8a-a1c2-3d4e5f6a7b8c',
            balanceCents: 3000,
            requestedCents: 999999,
          },
        },
      },
      {
        url: VIEW_URL,
        body: {
          ...FULL_VIEW,
          events: [
            ...FULL_VIEW.events,
            { seq: 3, data: { type: 'withdrawal-rejected', amountCents: 999999, reason: 'insufficient funds' } },
          ],
          history: [...FULL_VIEW.history, { type: 'withdrawal-rejected', amountCents: 0, balanceAfterCents: 3000, note: 'refused: insufficient funds' }],
        },
      },
      { url: STATS_URL, body: STATS },
    ]);

    render(<EventStoreDemo />);
    fireEvent.click(screen.getByTestId('eventstore-open'));
    await screen.findByTestId('eventstore-stream');

    setAmount('999999');
    fireEvent.click(screen.getByTestId('eventstore-withdraw'));

    const rejection = await screen.findByTestId('eventstore-rejection');
    expect(rejection).toHaveTextContent('overdraft refused AT APPEND TIME');
    expect(rejection).toHaveTextContent('999999¢');
    expect(rejection).toHaveTextContent('3000¢');
    expect(screen.queryByTestId('eventstore-conflict')).toBeNull();

    // The refusal itself became history — visible in the refreshed stream.
    await waitFor(() => {
      expect(screen.getAllByTestId('eventstore-event').length).toBe(4);
    });
    expect(screen.getAllByTestId('eventstore-event')[3]).toHaveTextContent('withdrawal-rejected');
  });

  it('a stale expectedVersion renders the conflict strip — nothing was written', async () => {
    stubApiFetch([
      { url: OPEN_URL, method: 'POST', status: 201, body: OPEN },
      {
        url: DEPOSIT_URL,
        method: 'POST',
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'stale expectedVersion',
            requestId: '7a4f2c1e-9b3d-4e8a-a1c2-3d4e5f6a7b8c',
            expectedVersion: 0,
            actualVersion: 1,
          },
        },
      },
      { url: VIEW_URL, body: FULL_VIEW },
      { url: STATS_URL, body: STATS },
    ]);

    render(<EventStoreDemo />);
    fireEvent.click(screen.getByTestId('eventstore-open'));
    await screen.findByTestId('eventstore-stream');

    fireEvent.change(screen.getByTestId('eventstore-version'), { target: { value: '0' } });
    setAmount('500');
    fireEvent.click(screen.getByTestId('eventstore-deposit'));

    const conflict = await screen.findByTestId('eventstore-conflict');
    expect(conflict).toHaveTextContent('optimistic-concurrency conflict');
    expect(conflict).toHaveTextContent('expected version 0');
    expect(conflict).toHaveTextContent('stream is at 1');
    expect(conflict).toHaveTextContent('No event was stored');
    expect(screen.queryByTestId('eventstore-rejection')).toBeNull();
  });
});

describe('EventStoreDemo — snapshots, the read model, and failure states', () => {
  it('a snapshot boundary is visible: minted chip, snapshot+tail load, consistency', async () => {
    stubApiFetch([
      { url: OPEN_URL, method: 'POST', status: 201, body: OPEN },
      {
        url: DEPOSIT_URL,
        method: 'POST',
        body: {
          streamId: 'account-1',
          version: 5,
          appended: [{ seq: 5 }],
          balanceCents: 500,
          snapshot: { streamId: 'account-1', version: 5, balanceCents: 500 },
        },
      },
      {
        url: VIEW_URL,
        body: {
          ...FULL_VIEW,
          version: 5,
          balanceCents: 500,
          load: { usedSnapshot: true, replayedEvents: 0, totalEvents: 6, consistent: true, fullReplayBalanceCents: 500 },
        },
      },
      {
        url: STATS_URL,
        body: { ...STATS, events: 6, snapshots: [{ streamId: 'account-1', version: 5, balanceCents: 500 }] },
      },
    ]);

    render(<EventStoreDemo />);
    fireEvent.click(screen.getByTestId('eventstore-open'));
    await screen.findByTestId('eventstore-stream');

    fireEvent.click(screen.getByTestId('eventstore-deposit'));
    await waitFor(() => {
      expect(screen.getByTestId('eventstore-command')).toHaveTextContent('snapshot minted');
    });
    expect(screen.getByTestId('eventstore-fold')).toHaveTextContent('loaded via snapshot + tail (0/6 replayed)');
    expect(screen.getByTestId('eventstore-fold')).toHaveTextContent('snapshot consistent: true');
    expect(screen.getByTestId('eventstore-snapshot')).toHaveTextContent('snapshot at v5 — balance 500¢');
  });

  it('degrades to the error strip when the store is unreachable', async () => {
    stubNetworkFailure();

    render(<EventStoreDemo />);
    fireEvent.click(screen.getByTestId('eventstore-open'));

    await screen.findByTestId('eventstore-error');
    expect(screen.getByTestId('eventstore-summary')).toBeDefined();
    expect(screen.getByTestId('eventstore-empty')).toBeDefined();
  });
});
