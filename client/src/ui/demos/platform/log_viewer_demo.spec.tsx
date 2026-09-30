import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LogViewerDemo from './log_viewer_demo';
import { stubApiFetch } from '../../../test/fetch_stub';

/**
 * jsdom talks to stubs of the three observability endpoints (plus the
 * make-noise POST). The server spec pins the LIVE contract: the ring captures
 * the request logger's own lines, level discipline at both layers, counters
 * that return inFlight to zero, and the readiness shape. Here we prove the
 * console renders what those endpoints report — level chips, filter
 * behavior, the noise burst's refresh, metrics, and health chips.
 */

const LOGS_URL_INFO = '/api/demo/obs/logs?limit=100&minLevel=info';
const LOGS_URL_WARN = '/api/demo/obs/logs?limit=100&minLevel=warn';
const METRICS_URL = '/api/demo/obs/metrics';
const HEALTH_URL = '/api/demo/obs/health';
const NOISE_URL = '/api/demo/obs/make-noise';

function logLine(levelLabel: string, msg: string, fields: Record<string, unknown> = {}) {
  return {
    time: 1790625773611,
    level: 30,
    levelLabel,
    msg,
    reqId: '7a4f2c1e-9b3d-4e8a-a1c2-3d4e5f6a7b8c',
    fields,
  };
}

const QUIET_LOGS = [
  logLine('debug', 'scenario store toggled', { dataMode: 'fake' }),
  logLine('info', 'request completed', { method: 'GET', path: '/api/health', status: 200, durationMs: 1.2 }),
];

const NOISY_LOGS = [
  logLine('warn', 'request completed', { method: 'GET', path: '/api/demo/obs/noise/does-not-exist', status: 404, durationMs: 0.9 }),
  logLine('error', 'request failed', { statusCode: 503, failureKind: 'unavailable' }),
];

const METRICS = {
  uptimeSeconds: 412,
  memory: { rssBytes: 96 * 1024 * 1024, heapTotalBytes: 64 * 1024 * 1024, heapUsedBytes: 32 * 1024 * 1024 },
  eventLoopDelayMs: { mean: 1.413, p99: 6.25, max: 9, note: 'cumulative since process start' },
  requests: {
    total: 4127,
    byStatusClass: { '2xx': 4028, '3xx': 0, '4xx': 96, '5xx': 3 },
    inFlight: 1,
    durations: { count: 100, p50Ms: 1.8, p95Ms: 12.4 },
  },
};

const HEALTH = {
  alive: true,
  ready: false,
  checks: {
    http: { state: 'ok', note: 'you are reading this answer' },
    sqlite: { state: 'ok', note: 'embedded — probed on a throwaway :memory: handle' },
    mongo: { state: 'off', note: 'MONGO_URI unset — the optional service is disabled' },
    redis: { state: 'down', note: 'configured but not answering' },
    grpc: { state: 'off', note: 'not started in this process' },
  },
  livenessEndpoint: '/api/health',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LogViewerDemo — panel 1: the log viewer', () => {
  it('renders ring lines with time, level chips, msg, reqId, and key fields', async () => {
    stubApiFetch([
      { url: LOGS_URL_INFO, body: { logs: QUIET_LOGS, count: 2, minLevel: 'info', limit: 100 } },
      { url: METRICS_URL, body: METRICS },
      { url: HEALTH_URL, body: HEALTH },
    ]);

    render(<LogViewerDemo />);

    const lines = await screen.findAllByTestId('obs-log-line');
    expect(lines.length).toBe(2);
    const chips = screen.getAllByTestId('obs-level-chip').map((chip) => chip.textContent);
    expect(chips).toEqual(['debug', 'info']);
    expect(lines[0]).toHaveTextContent('scenario store toggled');
    expect(lines[1]).toHaveTextContent('request completed');
    expect(lines[1]).toHaveTextContent('method=GET');
    expect(lines[1]).toHaveTextContent('status=200');
    expect(lines[1]).toHaveTextContent('reqId: 7a4f2c1e-9b3');
  });

  it('the minLevel filter rides the request URL and hides the lines below it', async () => {
    stubApiFetch([
      { url: LOGS_URL_INFO, body: { logs: QUIET_LOGS, count: 2, minLevel: 'info', limit: 100 } },
      { url: LOGS_URL_WARN, body: { logs: NOISY_LOGS, count: 2, minLevel: 'warn', limit: 100 } },
      { url: METRICS_URL, body: METRICS },
      { url: HEALTH_URL, body: HEALTH },
    ]);

    render(<LogViewerDemo />);
    await screen.findAllByTestId('obs-log-line');
    expect(screen.getByText('scenario store toggled')).toBeDefined();

    // Filter up to warn: the refetch carries minLevel=warn in the URL (the
    // stub dispatches on exactly that) and only the warn+error set renders.
    fireEvent.click(screen.getByTestId('obs-filter-warn'));

    await waitFor(() => {
      expect(screen.queryByText('scenario store toggled')).toBeNull();
    });
    await waitFor(() => {
      const chips = screen.getAllByTestId('obs-level-chip').map((chip) => chip.textContent);
      expect(chips).toEqual(['warn', 'error']);
    });
    expect(screen.getByText('request failed')).toHaveTextContent('request failed');
  });

  it('make noise posts, reports the attempts, and refreshes warn+error lines into view', async () => {
    // A call-sequence stub: the ring flips to the noisy set only AFTER the
    // burst endpoint fired — exactly the order a live server produces.
    let noiseFired = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method ?? 'GET';
        if (url === NOISE_URL && method === 'POST') {
          noiseFired = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              attempted: [
                { label: '200 #1', path: '/api/health', expectedStatus: 200, gotStatus: 200 },
                { label: '404', path: '/api/demo/obs/noise/does-not-exist', expectedStatus: 404, gotStatus: 404 },
                { label: '400', path: '/api/demo/error?failure=validation', expectedStatus: 400, gotStatus: 400 },
                { label: '503', path: '/api/demo/status', expectedStatus: 503, gotStatus: 503 },
              ],
              note: 'fired against this app over real HTTP — refresh the log viewer to watch the lines land',
            }),
          };
        }
        if (url === LOGS_URL_INFO) {
          const body = noiseFired ? NOISY_LOGS : QUIET_LOGS;
          return {
            ok: true,
            status: 200,
            json: async () => ({ logs: body, count: body.length, minLevel: 'info', limit: 100 }),
          };
        }
        if (url === METRICS_URL) return { ok: true, status: 200, json: async () => METRICS };
        if (url === HEALTH_URL) return { ok: true, status: 200, json: async () => HEALTH };
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { code: 'not_found', message: `no stub for ${url}` } }),
        };
      }),
    );

    render(<LogViewerDemo />);
    await screen.findAllByTestId('obs-log-line');
    expect(screen.queryByText('request failed')).toBeNull();

    fireEvent.click(screen.getByTestId('obs-noise-button'));

    const attempts = await screen.findByTestId('obs-noise-attempts');
    expect(attempts).toHaveTextContent('200 #1→200');
    expect(attempts).toHaveTextContent('503→503');

    await waitFor(() => {
      const chips = screen.getAllByTestId('obs-level-chip').map((chip) => chip.textContent);
      expect(chips).toEqual(['warn', 'error']);
    });
    expect(screen.getByTestId('obs-noise-result')).toHaveTextContent('fired against this app');
  });

  it('degrades to the error strip when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    render(<LogViewerDemo />);
    await screen.findByTestId('obs-error');
    expect(screen.getByTestId('obs-summary')).toBeDefined();
  });
});

describe('LogViewerDemo — panel 2: the metrics strip', () => {
  it('renders uptime, event-loop delay, memory, and the request counters', async () => {
    stubApiFetch([
      { url: LOGS_URL_INFO, body: { logs: QUIET_LOGS, count: 2, minLevel: 'info', limit: 100 } },
      { url: METRICS_URL, body: METRICS },
      { url: HEALTH_URL, body: HEALTH },
    ]);

    render(<LogViewerDemo />);

    const metrics = await screen.findByTestId('obs-metrics');
    expect(metrics).toHaveTextContent('uptime: 412s');
    expect(metrics).toHaveTextContent('event-loop mean: 1.413ms');
    expect(metrics).toHaveTextContent('p99: 6.25ms');
    expect(metrics).toHaveTextContent('rss: 96 MB');
    expect(metrics).toHaveTextContent('requests: 4127');
    expect(screen.getByTestId('obs-inflight')).toHaveTextContent('in flight: 1');
    expect(metrics).toHaveTextContent('4xx: 96');
    expect(metrics).toHaveTextContent('p50: 1.8ms');
    expect(metrics).toHaveTextContent('p95: 12.4ms');
  });
});

describe('LogViewerDemo — panel 3: the readiness probe', () => {
  it('renders a chip per check with its state, and down makes ready false', async () => {
    stubApiFetch([
      { url: LOGS_URL_INFO, body: { logs: QUIET_LOGS, count: 2, minLevel: 'info', limit: 100 } },
      { url: METRICS_URL, body: METRICS },
      { url: HEALTH_URL, body: HEALTH },
    ]);

    render(<LogViewerDemo />);

    const health = await screen.findByTestId('obs-health');
    const chips = screen.getAllByTestId('obs-health-chip').map((chip) => chip.textContent);
    expect(chips).toEqual([
      'http: ok',
      'sqlite: ok',
      'mongo: off',
      'redis: down',
      'grpc: off',
    ]);
    expect(health).toHaveTextContent('alive: true');
    expect(screen.getByTestId('obs-ready-chip')).toHaveTextContent('ready: false');
    expect(health).toHaveTextContent('MONGO_URI unset');
  });
});
