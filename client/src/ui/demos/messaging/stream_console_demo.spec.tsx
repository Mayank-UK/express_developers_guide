import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StreamConsoleDemo from './stream_console_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom drives the console against stubs shaped like the live lab payloads.
 * The server spec pins the LIVE contract: XADD ids, the ack/pending/reclaim
 * round-trip, and the poison-message DLQ path on real redis — here we prove
 * the console logs what each Redis command actually did.
 */

const PRODUCE_URL = '/api/demo/msg/stream/produce';
const CONSUME_URL = '/api/demo/msg/stream/consume';
const PENDING_URL = '/api/demo/msg/stream/pending?consumer=w1';
const DLQ_URL = '/api/demo/msg/stream/dlq';
const RESET_URL = '/api/demo/msg/stream/reset';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StreamConsoleDemo — produce + consume', () => {
  it('logs the XADD entry id and the acked delivery with its payload', async () => {
    stubApiFetch([
      {
        url: PRODUCE_URL,
        method: 'POST',
        status: 201,
        body: {
          id: '1759100000000-0',
          streamLength: 1,
          maxlen: '~1000 (XADD MAXLEN trims oldest entries)',
          fields: { retryCount: 0, payload: 'hello from the spec' },
          note: 'XADD minted the id and appended the fields.',
        },
      },
      {
        url: CONSUME_URL,
        method: 'POST',
        body: {
          consumer: 'w1',
          empty: false,
          attempts: 3,
          messages: [{ outcome: 'acked', fields: { payload: 'hello from the spec', retryCount: 0 } }],
          note: 'the happy path.',
        },
      },
    ]);

    render(<StreamConsoleDemo />);
    fireEvent.click(screen.getByTestId('stream-produce'));

    const first = await screen.findByTestId('stream-log-entry');
    expect(first).toHaveTextContent('1759100000000-0');
    expect(first).toHaveTextContent('stream length 1');
    expect(first).toHaveTextContent('hello from the spec');

    fireEvent.click(screen.getByTestId('stream-consume'));
    await waitFor(() => expect(screen.getAllByTestId('stream-log-entry').length).toBe(2));
    const entries = screen.getAllByTestId('stream-log-entry');
    expect(entries[0]).toHaveTextContent('acked');
    expect(entries[0]).toHaveTextContent('worker w1');
    expect(entries[0]).toHaveTextContent('retry budget 3');
  });

  it('shows left-pending after an unacked consume, then the XPENDING evidence: holder, idle, deliveries', async () => {
    stubApiFetch([
      {
        url: CONSUME_URL,
        method: 'POST',
        body: {
          consumer: 'w1',
          empty: false,
          attempts: 3,
          messages: [{ outcome: 'left-pending', fields: { payload: 'processed but orphaned', retryCount: 0 } }],
          note: 'the entry sits in the PEL.',
        },
      },
      {
        url: PENDING_URL,
        body: {
          summary: { total: 1, perConsumer: [{ consumer: 'w1', count: 1 }] },
          entries: [{ id: '1759100000000-1', consumer: 'w1', idleMs: 4213, deliveries: 2 }],
          note: 'XPENDING rows.',
        },
      },
    ]);

    render(<StreamConsoleDemo />);
    fireEvent.click(screen.getByTestId('stream-ack')); // ack:false — the worker dies before XACK
    fireEvent.click(screen.getByTestId('stream-consume'));

    const consumeEntry = await screen.findByTestId('stream-log-entry');
    expect(consumeEntry).toHaveTextContent('left-pending');

    fireEvent.click(screen.getByTestId('stream-pending'));
    await waitFor(() => expect(screen.getAllByTestId('stream-log-entry').length).toBe(2));
    const pendingEntry = screen.getAllByTestId('stream-log-entry')[0];
    expect(pendingEntry).toHaveTextContent('PEL total 1');
    expect(pendingEntry).toHaveTextContent('held by w1');
    expect(pendingEntry).toHaveTextContent('idle 4213ms');
    expect(pendingEntry).toHaveTextContent('delivered ×2');
  });

  it('lists the dead-lettered poison message with its spent budget and reason', async () => {
    stubApiFetch([
      {
        url: DLQ_URL,
        body: {
          entries: [
            {
              id: '1759100000001-0',
              fields: {
                payload: 'poison',
                originalId: '1759100000000-5',
                retryCount: 3,
                reason: '3 attempts spent — dead-lettered',
              },
            },
          ],
          note: 'the DLQ.',
        },
      },
    ]);

    render(<StreamConsoleDemo />);
    fireEvent.click(screen.getByTestId('stream-dlq'));

    const entry = await screen.findByTestId('stream-log-entry');
    expect(entry).toHaveTextContent('poison');
    expect(entry).toHaveTextContent('attempts 3');
    expect(entry).toHaveTextContent('3 attempts spent');
    expect(entry).toHaveTextContent('original id 1759100000000-5');
  });

  it('degrades to the error strip when the lab is unreachable', async () => {
    stubNetworkFailure();

    render(<StreamConsoleDemo />);
    fireEvent.click(screen.getByTestId('stream-produce'));

    await screen.findByTestId('stream-error');
    expect(screen.getByTestId('stream-summary')).toBeDefined();
    expect(screen.getByTestId('stream-log-entry')).toHaveTextContent('the call failed');
  });

  it('reset clears the log back to a single fresh-lab entry', async () => {
    stubApiFetch([
      { url: RESET_URL, method: 'POST', body: { reset: true, note: 'DEL + XGROUP CREATE MKSTREAM.' } },
    ]);

    render(<StreamConsoleDemo />);
    expect(screen.getByTestId('stream-idle')).toBeDefined();

    fireEvent.click(screen.getByTestId('stream-reset'));

    await waitFor(() => expect(screen.queryByTestId('stream-idle')).toBeNull());
    expect(screen.getAllByTestId('stream-log-entry').length).toBe(1);
    expect(screen.getByTestId('stream-log-entry')).toHaveTextContent('reset');
  });
});
