import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OutboxRelayDemo from './outbox_relay_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The outbox walkthrough against stubs shaped like the real payloads. The
 * crash-recovery test drives a STATEFUL model of the relay (the breaker spec's
 * pattern): the crash run publishes but does not mark, the recovery run ships
 * the still-due row again with alreadyDelivered true, and the stream ends up
 * carrying the same outbox id twice — the duplicate the UI must surface.
 */

const ENQUEUE_URL = '/api/demo/msg/outbox/enqueue';
const LEDGER_URL = '/api/demo/msg/outbox';
const RELAY_URL = '/api/demo/msg/outbox/relay';
const STREAM_URL = '/api/demo/msg/outbox/stream';

const ENQUEUED_ROW = {
  topic: 'post.updated',
  publishedAt: null,
  attempts: 0,
  createdAt: '2026-09-29T10:00:00.000Z',
  nextAttemptAt: '2026-09-29T10:00:00.000Z',
  payload: { postId: 'p1', title: 'Enqueued, not just updated', changedBy: 'the spec' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OutboxRelayDemo — enqueue', () => {
  it('commits visibly: the row lands in the ledger as queued, not published yet', async () => {
    stubApiFetch([
      {
        url: ENQUEUE_URL,
        method: 'POST',
        body: {
          crash: false,
          enqueued: true,
          rolledBack: false,
          post: { id: 'p1', title: 'Enqueued, not just updated' },
          outboxRowCount: 1,
          outboxRows: [ENQUEUED_ROW],
          note: 'one transaction.',
        },
      },
    ]);

    render(<OutboxRelayDemo />);
    fireEvent.click(screen.getByTestId('outbox-enqueue'));

    const result = await screen.findByTestId('outbox-enqueued');
    expect(result).toHaveTextContent('enqueued');
    expect(result).toHaveTextContent('Enqueued, not just updated');
    // The row renders in BOTH the enqueue result and the ledger panel.
    const rows = screen.getAllByTestId('outbox-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveTextContent('post.updated');
    expect(rows[0]).toHaveTextContent('queued — not published yet');
    expect(rows[0]).toHaveTextContent('attempts 0');
  });

  it('the crash checkbox rolls back BOTH writes — the atomicity proof, on screen', async () => {
    stubApiFetch([
      {
        url: ENQUEUE_URL,
        method: 'POST',
        body: {
          crash: true,
          enqueued: false,
          rolledBack: true,
          post: { id: 'p1', title: 'the ORIGINAL title' },
          outboxRowCount: 0,
          outboxRows: [],
          note: 'rolled back.',
        },
      },
    ]);

    render(<OutboxRelayDemo />);
    expect(screen.getByTestId('outbox-stream-idle')).toBeDefined(); // evidence panel starts unloaded
    fireEvent.click(screen.getByTestId('outbox-crash-checkbox'));
    fireEvent.click(screen.getByTestId('outbox-enqueue'));

    const rollback = await screen.findByTestId('outbox-rollback');
    expect(rollback).toHaveTextContent('rolled back BOTH writes');
    expect(rollback).toHaveTextContent('the ORIGINAL title');
    expect(rollback).toHaveTextContent('0 row(s)');
    expect(screen.queryByTestId('outbox-enqueued')).toBeNull();
  });
});

describe('OutboxRelayDemo — the at-least-once duplicate, end to end', () => {
  it('crash-after-publish leaves the row due; recovery ships it AGAIN and the stream shows ×2', async () => {
    // A tiny model of the relay: rows live in state, the crash run returns
    // after the first XADD without marking, the recovery run re-ships it.
    const rows: Record<string, unknown>[] = [
      { ...ENQUEUED_ROW, payload: { ...ENQUEUED_ROW.payload, title: 'Ship me twice' } },
    ];
    const streamEntries: { outboxId: number; id: string }[] = [];
    let entrySeq = 0;
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
        if (url === RELAY_URL && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { crashAfterPublish?: boolean };
          const due = rows.filter((row) => row.publishedAt === null);
          if (body.crashAfterPublish === true) {
            entrySeq += 1;
            streamEntries.push({ outboxId: 1, id: `1759100000000-${String(entrySeq)}` });
            return json({
              crashedAfterPublish: { outboxId: 1 },
              published: [],
              failedRetries: [],
              skippedNotDue: 0,
              rows: rows.map((row) => ({ ...row })),
            });
          }
          const published = due.map((row) => {
            entrySeq += 1;
            const entryId = `1759100000000-${String(entrySeq)}`;
            const alreadyDelivered = streamEntries.some((entry) => entry.outboxId === 1);
            streamEntries.push({ outboxId: 1, id: entryId });
            row.publishedAt = '2026-09-29T10:00:05.000Z';
            return { topic: 'post.updated', entryId, markedPublished: true, alreadyDelivered };
          });
          return json({
            crashedAfterPublish: null,
            published,
            failedRetries: [],
            skippedNotDue: 0,
            rows: rows.map((row) => ({ ...row })),
          });
        }
        if (url === STREAM_URL && method === 'GET') {
          return json({ entries: streamEntries.map((entry) => ({ ...entry })) });
        }
        return json({ error: { code: 'not_found', message: `no fetch stub for ${url}` } }, 404);
      }),
    );

    render(<OutboxRelayDemo />);

    // The crash: publish happens, mark does not.
    fireEvent.click(screen.getByTestId('outbox-relay-crash'));
    const crash = await screen.findByTestId('outbox-crash');
    expect(crash).toHaveTextContent('outbox id 1');

    // Recovery: the still-due row ships AGAIN — flagged as the duplicate.
    fireEvent.click(screen.getByTestId('outbox-relay-run'));
    await waitFor(() => {
      expect(screen.getByTestId('outbox-published')).toHaveTextContent('already delivered');
    });

    // And the stream carries the proof: the same outbox id, twice.
    fireEvent.click(screen.getByTestId('outbox-refresh-stream'));
    await waitFor(() => expect(screen.getAllByTestId('outbox-stream-entry').length).toBe(2));
    const duplicate = await screen.findByTestId('outbox-duplicates');
    expect(duplicate).toHaveTextContent('outbox id 1 delivered ×2');
    expect(duplicate).toHaveTextContent('deduplicate');
  });
});

describe('OutboxRelayDemo — backoff, failure states, reset evidence', () => {
  it('failPublish shows the retry state: attempts and the pushed-out next try', async () => {
    stubApiFetch([
      {
        url: RELAY_URL,
        method: 'POST',
        body: {
          crashedAfterPublish: null,
          published: [],
          failedRetries: [{ attempts: 1, nextAttemptAt: '2026-09-29T10:00:01.200Z' }],
          skippedNotDue: 0,
          rows: [{ ...ENQUEUED_ROW, attempts: 1, nextAttemptAt: '2026-09-29T10:00:01.200Z' }],
        },
      },
    ]);

    render(<OutboxRelayDemo />);
    fireEvent.click(screen.getByTestId('outbox-relay-fail'));

    const retry = await screen.findByTestId('outbox-retry');
    expect(retry).toHaveTextContent('publish failed');
    expect(retry).toHaveTextContent('attempts 1');
    expect(retry).toHaveTextContent('backs off to 10:00:01Z');
    expect(screen.getAllByTestId('outbox-row')[0]).toHaveTextContent('next try 10:00:01Z');
  });

  it('degrades to the error strip when the lab is unreachable', async () => {
    stubNetworkFailure();

    render(<OutboxRelayDemo />);
    fireEvent.click(screen.getByTestId('outbox-enqueue'));

    await screen.findByTestId('outbox-error');
    expect(screen.getByTestId('outbox-summary')).toBeDefined();
  });

  it('the ledger refresh lists rows from GET /api/demo/msg/outbox', async () => {
    stubApiFetch([{ url: LEDGER_URL, body: { rows: [ENQUEUED_ROW], note: 'the ledger.' } }]);

    render(<OutboxRelayDemo />);
    fireEvent.click(screen.getByTestId('outbox-refresh-ledger'));

    const row = await screen.findByTestId('outbox-row');
    expect(row).toHaveTextContent('post.updated');
    expect(row).toHaveTextContent('queued — not published yet');
  });
});
