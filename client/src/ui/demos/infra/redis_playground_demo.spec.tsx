import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RedisPlaygroundDemo from './redis_playground_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATUS_URL = '/api/demo/redis/status';
const TOUR_URL = '/api/demo/redis/tour';
const TTL_POST_URL = '/api/demo/redis/ttl';
const TTL_GET_URL = '/api/demo/redis/ttl?key=guide%3Ademo%3Attl%3Awatch';
const PUBLISH_URL = '/api/demo/redis/publish';
const MESSAGES_POLL_URL = '/api/demo/redis/messages?channel=guide%3Ademo%3Achannel';

const OFF_STATUS = {
  configured: false,
  connected: false,
  host: '',
  serverInfo: null,
  note: 'REDIS_URL is not set — the Redis feature is OFF by design.',
};

const CONNECTED_STATUS = {
  configured: true,
  connected: true,
  host: '127.0.0.1:6379',
  serverInfo: { version: '7.4.1' },
  note: 'One connection for commands, one for pub/sub.',
};

const TOUR_STEPS = [
  { structure: 'string', command: 'SET guide:demo:greeting "Hello"', reply: '"OK"', note: 'strings: the atom' },
  { structure: 'counter', command: 'INCR guide:demo:page:views', reply: '1', note: 'atomic counters' },
  { structure: 'hash', command: 'HGETALL guide:demo:profile', reply: '{"name":"Ada"}', note: 'hashes' },
  { structure: 'list', command: 'LRANGE guide:demo:queue 0 -1', reply: '["third","second","first"]', note: 'lists' },
  { structure: 'set', command: 'SMEMBERS guide:demo:tags', reply: '["node","redis"]', note: 'sets' },
  { structure: 'sorted-set', command: 'ZRANGE guide:demo:leaderboard 0 -1 REV WITHSCORES', reply: '[{"member":"grace","score":"250"}]', note: 'leaderboards' },
];

describe('RedisPlaygroundDemo — Redis off: graceful guidance, never an error', () => {
  it('renders the off panel with the exact compose command and the off chip', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: STATUS_URL, body: OFF_STATUS }]);
      return vi.mocked(fetch);
    })();

    render(<RedisPlaygroundDemo />);

    const off = await screen.findByTestId('redis-off');
    expect(off).toHaveTextContent('docker compose -f .docker/docker-compose.yml up -d redis');
    expect(off).toHaveTextContent('REDIS_URL is not set');

    const chip = await screen.findByTestId('redis-status-chip');
    expect(chip).toHaveTextContent('off — REDIS_URL not set');

    // The off world never asks for data — no wasted 503s.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(STATUS_URL);

    // No panels to drive without the service.
    expect(screen.queryByTestId('redis-tour-run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('redis-ttl-set')).not.toBeInTheDocument();
    expect(screen.queryByTestId('redis-publish-send')).not.toBeInTheDocument();
  });

  it('degrades to a failure panel when the server itself is unreachable', async () => {
    stubNetworkFailure();

    render(<RedisPlaygroundDemo />);

    const failed = await screen.findByTestId('redis-status-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});

describe('RedisPlaygroundDemo — connected: tour, TTL countdown, pub/sub', () => {
  it('renders the 503 envelope when the tour runs against a vanished service', async () => {
    stubApiFetch([
      { url: STATUS_URL, body: CONNECTED_STATUS },
      {
        url: TOUR_URL,
        status: 503,
        body: {
          error: {
            code: 'service_unavailable',
            message:
              'Redis is not configured or not reachable — start it with `docker compose -f .docker/docker-compose.yml up -d redis` and retry',
          },
        },
      },
    ]);

    render(<RedisPlaygroundDemo />);
    await screen.findByTestId('redis-status-chip');

    fireEvent.click(screen.getByTestId('redis-tour-run'));

    const failed = await screen.findByTestId('redis-tour-failed');
    expect(failed).toHaveTextContent('service_unavailable');
    expect(failed).toHaveTextContent('docker compose');
  });

  it('tour: renders every command → reply row', async () => {
    stubApiFetch([
      { url: STATUS_URL, body: CONNECTED_STATUS },
      { url: TOUR_URL, body: { steps: TOUR_STEPS } },
    ]);

    render(<RedisPlaygroundDemo />);
    expect(await screen.findByTestId('redis-status-chip')).toHaveTextContent('connected');

    fireEvent.click(screen.getByTestId('redis-tour-run'));

    const rows = await screen.findAllByTestId('redis-tour-row');
    expect(rows).toHaveLength(TOUR_STEPS.length);
    expect(rows[0]).toHaveTextContent('SET guide:demo:greeting "Hello"');
    expect(rows[0]).toHaveTextContent('"OK"');
    expect(rows[5]).toHaveTextContent('ZRANGE guide:demo:leaderboard 0 -1 REV WITHSCORES');
    expect(screen.getAllByTestId('redis-tour-structure').map((chip) => chip.textContent)).toEqual(
      TOUR_STEPS.map((step) => step.structure),
    );
  });

  it('ttl: set then watch counts down and flips to expired', async () => {
    // A sequence stub: the first GET poll sees 7s remaining, the second sees
    // the key gone (the interval polls every second).
    let ttlPolls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        if (url === STATUS_URL) {
          return { ok: true, status: 200, json: async () => CONNECTED_STATUS };
        }
        if (url === TTL_POST_URL && method === 'POST') {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              key: 'guide:demo:ttl:watch',
              value: 'this key expires',
              seconds: 10,
              setAt: new Date().toISOString(),
            }),
          };
        }
        if (url === TTL_GET_URL) {
          ttlPolls += 1;
          return {
            ok: true,
            status: 200,
            json: async () =>
              ttlPolls === 1
                ? { key: 'guide:demo:ttl:watch', exists: true, ttlSecondsRemaining: 7, value: 'this key expires' }
                : { key: 'guide:demo:ttl:watch', exists: false, ttlSecondsRemaining: null, value: null },
          };
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { code: 'not_found', message: `no fetch stub for ${url}` } }),
        };
      }),
    );

    render(<RedisPlaygroundDemo />);
    expect(await screen.findByTestId('redis-status-chip')).toHaveTextContent('connected');

    fireEvent.click(screen.getByTestId('redis-ttl-set'));
    // The set seeds the watch state from the POST reply (full key + seconds).
    const live = await screen.findByTestId('redis-ttl-live');
    expect(live).toHaveTextContent('guide:demo:ttl:watch');
    expect(live).toHaveTextContent('10s');

    fireEvent.click(screen.getByTestId('redis-ttl-watch'));
    const remaining = await screen.findByTestId('redis-ttl-remaining');
    expect(remaining).toHaveTextContent('7s');

    const expired = await screen.findByTestId('redis-ttl-expired', {}, { timeout: 4000 });
    expect(expired).toHaveTextContent('key expired');
  });

  it('publish: receivers chip, receipt proof, and the messages list', async () => {
    const receivedAt = new Date().toISOString();
    const MESSAGES_BODY = [
      { channel: 'guide:demo:channel', message: 'hello from the playground', receivedAt },
    ];
    stubApiFetch([
      { url: STATUS_URL, body: CONNECTED_STATUS },
      {
        url: PUBLISH_URL,
        method: 'POST',
        status: 200,
        body: {
          channel: 'guide:demo:channel',
          message: 'hello from the playground',
          receivers: 1,
          received: true,
          messages: MESSAGES_BODY,
        },
      },
      // The post-publish poll of the messages endpoint (same list a second
      // consumer would read).
      { url: MESSAGES_POLL_URL, body: { channel: 'guide:demo:channel', messages: MESSAGES_BODY } },
    ]);

    render(<RedisPlaygroundDemo />);
    expect(await screen.findByTestId('redis-status-chip')).toHaveTextContent('connected');

    fireEvent.change(screen.getByTestId('redis-publish-channel'), { target: { value: 'guide:demo:channel' } });
    fireEvent.change(screen.getByTestId('redis-publish-message'), { target: { value: 'spec hello' } });
    fireEvent.click(screen.getByTestId('redis-publish-send'));

    const result = await screen.findByTestId('redis-publish-result');
    expect(result).toHaveTextContent('1 receiver');
    expect(result).toHaveTextContent('our subscriber got it');

    const entry = await screen.findByTestId('redis-message-entry');
    expect(entry).toHaveTextContent('guide:demo:channel');
    expect(entry).toHaveTextContent('hello from the playground');
    expect(entry).toHaveTextContent(receivedAt);

    const fetchMock = vi.mocked(fetch);
    const postCall = fetchMock.mock.calls.find(([url, init]) => url === PUBLISH_URL && init?.method === 'POST');
    expect(postCall).toBeDefined();
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ channel: 'guide:demo:channel', message: 'spec hello' });
  });
});
