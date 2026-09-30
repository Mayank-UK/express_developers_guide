import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MongoConsoleDemo from './mongo_console_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATUS_URL = '/api/demo/mongo/status';
const EVENTS_URL = '/api/demo/mongo/events';

const OFF_STATUS = {
  configured: false,
  connected: false,
  connectionState: 'disconnected',
  uri: '',
  model: 'Event',
  indexes: [],
  note: 'MONGO_URI is not set — the MongoDB feature is OFF by design.',
};

const CONNECTED_STATUS = {
  configured: true,
  connected: true,
  connectionState: 'connected',
  uri: '127.0.0.1:27017/express_guide_dev',
  model: 'Event',
  indexes: [
    { name: '_id_', key: { _id: 1 } },
    { name: 'page_1_createdAt_-1', key: { page: 1, createdAt: -1 } },
    { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 60 },
  ],
  note: 'The TTL index makes documents vanish ~60s after creation.',
};

const CREATED_AT = new Date(Date.now() - 30_000).toISOString();

const LIST_BODY = {
  events: [
    {
      id: '68d9f0a1c2e3b4a5d6e7f8a9',
      kind: 'visit',
      page: '/topics/mongodb',
      visitor: 'spec-visitor',
      meta: { from: 'spec' },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ],
  stats: { count: 1, oldest: CREATED_AT, newest: CREATED_AT, ttlSeconds: 60, ttlIndex: 'createdAt_1' },
};

const CREATED_EVENT = {
  id: '68d9f0a1c2e3b4a5d6e7f8aa0',
  kind: 'click',
  page: '/topics/mongodb',
  visitor: 'you',
  meta: { from: 'console' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('MongoConsoleDemo — Mongo off: graceful guidance, never an error', () => {
  it('renders the off panel with the exact compose command and the off chip', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: STATUS_URL, body: OFF_STATUS }]);
      return vi.mocked(fetch);
    })();

    render(<MongoConsoleDemo />);

    const off = await screen.findByTestId('mongo-console-off');
    expect(off).toHaveTextContent('docker compose -f .docker/docker-compose.yml up -d mongo');
    expect(off).toHaveTextContent('MONGO_URI is not set');

    const chip = await screen.findByTestId('mongo-console-connection-chip');
    expect(chip).toHaveTextContent('off — MONGO_URI not set');

    // The off world never asks for the list — no wasted 503.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(STATUS_URL);

    // No form, no list — there is nothing to drive without the service.
    expect(screen.queryByTestId('mongo-console-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mongo-console-event')).not.toBeInTheDocument();
  });

  it('degrades to a failure panel when the server itself is unreachable', async () => {
    stubNetworkFailure();

    render(<MongoConsoleDemo />);

    const failed = await screen.findByTestId('mongo-console-status-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});

describe('MongoConsoleDemo — connected: status, insert, list, TTL visibility', () => {
  function stubConnectedWorld(postBody?: { status: number; body: unknown }): void {
    stubApiFetch([
      { url: STATUS_URL, body: CONNECTED_STATUS },
      { url: EVENTS_URL, method: 'GET', body: LIST_BODY },
      ...(postBody !== undefined
        ? [{ url: EVENTS_URL, method: 'POST', status: postBody.status, body: postBody.body }]
        : [{ url: EVENTS_URL, method: 'POST', status: 201, body: { event: CREATED_EVENT } }]),
    ]);
  }

  it('shows connected state with the TTL index chip, the stats chip, and the event age', async () => {
    stubConnectedWorld();

    render(<MongoConsoleDemo />);

    expect(await screen.findByTestId('mongo-console-connection-chip')).toHaveTextContent('connected');
    expect(screen.getAllByTestId('mongo-console-index-chip').map((chip) => chip.textContent)).toEqual(
      expect.arrayContaining(['createdAt_1 · TTL 60s', 'page_1_createdAt_-1']),
    );
    expect(screen.getByTestId('mongo-console-stats')).toHaveTextContent('1 docs · ttl 60s (createdAt_1)');

    const event = screen.getByTestId('mongo-console-event');
    expect(event).toHaveTextContent('visit');
    expect(event).toHaveTextContent('/topics/mongodb');
    expect(event).toHaveTextContent('by spec-visitor');
    expect(screen.getByTestId('mongo-console-event-age')).toHaveTextContent('age 30s');
  });

  it('insert happy path: POSTs the form as JSON and renders the created id, then refreshes the list', async () => {
    stubConnectedWorld();

    render(<MongoConsoleDemo />);
    await screen.findByTestId('mongo-console-event');

    fireEvent.change(screen.getByTestId('mongo-console-kind'), { target: { value: 'click' } });
    fireEvent.change(screen.getByTestId('mongo-console-page'), { target: { value: '/demo' } });
    fireEvent.change(screen.getByTestId('mongo-console-visitor'), { target: { value: 'tester' } });

    fireEvent.click(screen.getByTestId('mongo-console-submit'));

    const created = await screen.findByTestId('mongo-console-created');
    expect(created).toHaveTextContent(CREATED_EVENT.id);
    expect(created).toHaveTextContent('TTL index deletes it ~60s after createdAt');

    const fetchMock = vi.mocked(fetch);
    const postCall = fetchMock.mock.calls.find(([url, init]) => url === EVENTS_URL && init?.method === 'POST');
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'click', page: '/demo', visitor: 'tester' });
    // meta textarea JSON is parsed before the wire — Mixed takes any shape.
    expect(body.meta).toEqual({ from: 'console' });

    // The list refreshed after the insert (status → list → POST → list).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it('renders the 400 validation envelope with mongoose field details', async () => {
    stubConnectedWorld({
      status: 400,
      body: {
        error: {
          code: 'validation_failed',
          message: 'event failed mongoose validation (1 field error(s))',
          errors: [{ field: 'kind', message: '`scroll` is not a valid enum value for path `kind`.' }],
        },
      },
    });

    render(<MongoConsoleDemo />);
    await screen.findByTestId('mongo-console-event');

    fireEvent.click(screen.getByTestId('mongo-console-submit'));

    const validation = await screen.findByTestId('mongo-console-validation');
    expect(validation).toHaveTextContent('400');
    expect(validation).toHaveTextContent('event failed mongoose validation');
    expect(validation).toHaveTextContent('kind');
    expect(validation).toHaveTextContent('`scroll` is not a valid enum value for path `kind`.');
  });

  it('renders the 503 unavailable outcome when the service goes away mid-session', async () => {
    stubConnectedWorld({
      status: 503,
      body: {
        error: {
          code: 'service_unavailable',
          message:
            'MongoDB is not configured or not reachable — start it with `docker compose -f .docker/docker-compose.yml up -d mongo` and retry',
        },
      },
    });

    render(<MongoConsoleDemo />);
    await screen.findByTestId('mongo-console-event');

    fireEvent.click(screen.getByTestId('mongo-console-submit'));

    const unavailable = await screen.findByTestId('mongo-console-submit-unavailable');
    expect(unavailable).toHaveTextContent('503');
    expect(unavailable).toHaveTextContent('service_unavailable');
    expect(unavailable).toHaveTextContent('docker compose');
  });
});
