import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ErrorExplorerDemo from './error_explorer_demo';

/**
 * jsdom talks to a MUTABLE in-memory stand-in for the error-pipeline
 * endpoints: the scenario state flips exactly like the server's scenarioStore
 * (PATCH mutates, /status answers 200 or the 503 envelope by that state), and
 * every error response carries a fresh requestId in BOTH the envelope and the
 * x-request-id header so the demo's correlation note is exercised for real.
 * The pipeline itself is proven end-to-end in the SERVER specs.
 */

const TAXONOMY_URL = '/api/demo/errors/taxonomy';
const ERROR_URL = '/api/demo/error';
const SCENARIO_URL = '/api/demo/scenario';
const STATUS_URL = '/api/demo/status';
const PLAIN_ERROR_URL = '/api/demo/middleware/error-path';
const POSTS_URL = '/api/posts';

/** The real contract (server spec pins this against the imported maps). */
const TAXONOMY = [
  { kind: 'validation', httpStatus: 400, errorCode: 'validation_failed' },
  { kind: 'unauthorized', httpStatus: 401, errorCode: 'unauthorized' },
  { kind: 'forbidden', httpStatus: 403, errorCode: 'forbidden' },
  { kind: 'not_found', httpStatus: 404, errorCode: 'not_found' },
  { kind: 'conflict', httpStatus: 409, errorCode: 'conflict' },
  { kind: 'rate_limited', httpStatus: 429, errorCode: 'rate_limited' },
  { kind: 'unavailable', httpStatus: 503, errorCode: 'service_unavailable' },
  { kind: 'internal', httpStatus: 500, errorCode: 'internal_error' },
] as const;

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

let calls: RecordedCall[];
let requestIdCounter: number;
let injectFailure: boolean;
let dataMode: 'fake' | 'live';

/** Response stand-in with a case-insensitive headers.get, like fetch's. */
function jsonLike(body: unknown, status: number, requestId?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'x-request-id' && requestId !== undefined ? requestId : null,
    },
    json: async () => body,
  };
}

beforeEach(() => {
  calls = [];
  requestIdCounter = 0;
  injectFailure = false;
  dataMode = 'fake';

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      const requestId = `req-${String((requestIdCounter += 1))}`;

      if (url === TAXONOMY_URL) {
        return jsonLike({ source: 'failures.ts', kinds: TAXONOMY }, 200);
      }
      if (url.startsWith(`${ERROR_URL}?`)) {
        const kind = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('failure') ?? '';
        const match = TAXONOMY.find((row) => row.kind === kind);
        if (match === undefined) {
          return jsonLike(
            {
              error: {
                code: 'validation_failed',
                message: 'unknown or missing "failure" query parameter',
                requestId,
                parameter: 'failure',
                validValues: TAXONOMY.map((row) => row.kind),
              },
            },
            400,
            requestId,
          );
        }
        return jsonLike(
          {
            error: {
              code: match.errorCode,
              message: `injected demo failure of kind "${match.kind}"`,
              requestId,
            },
          },
          match.httpStatus,
          requestId,
        );
      }
      if (url === SCENARIO_URL && method === 'GET') {
        return jsonLike({ dataMode, injectFailure }, 200);
      }
      if (url === SCENARIO_URL && method === 'PATCH') {
        const patch = JSON.parse(String(init?.body)) as { dataMode?: string; injectFailure?: boolean };
        if (patch.dataMode === 'fake' || patch.dataMode === 'live') dataMode = patch.dataMode;
        if (typeof patch.injectFailure === 'boolean') injectFailure = patch.injectFailure;
        return jsonLike({ dataMode, injectFailure }, 200);
      }
      if (url === STATUS_URL && method === 'GET') {
        if (injectFailure) {
          return jsonLike(
            {
              error: {
                code: 'service_unavailable',
                message: 'failure injection is ON',
                requestId,
              },
            },
            503,
            requestId,
          );
        }
        return jsonLike(
          { app: 'express_developers_guide', scenario: { dataMode, injectFailure }, timestamp: '2026-09-28T10:00:00.000Z' },
          200,
          requestId,
        );
      }
      if (url === PLAIN_ERROR_URL) {
        return jsonLike(
          {
            error: {
              code: 'internal_error',
              message: 'demo handler exploded on purpose',
              requestId,
            },
          },
          500,
          requestId,
        );
      }
      if (url === POSTS_URL && method === 'POST') {
        // The demo always sends the deliberately-malformed body — the parser
        // fallback, not the use case, answers.
        return jsonLike(
          {
            error: {
              code: 'request_failed',
              message: 'Unexpected end of JSON input',
              requestId,
            },
          },
          400,
          requestId,
        );
      }
      return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}`, requestId } }, 404, requestId);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ErrorExplorerDemo — the failure pipeline live', () => {
  it('renders the taxonomy table: 8 rows with statuses and machine codes', async () => {
    render(<ErrorExplorerDemo />);

    const table = await screen.findByTestId('errors-taxonomy-table');
    expect(screen.queryByTestId('errors-loading')).toBeNull();
    const rows = screen.getAllByTestId('errors-taxonomy-row');
    expect(rows).toHaveLength(8);
    for (const row of TAXONOMY) {
      expect(table).toHaveTextContent(row.kind);
      expect(table).toHaveTextContent(row.errorCode);
    }
    expect(table).toHaveTextContent('503');
    await waitFor(() => {
      expect(screen.getByTestId('errors-scenario-state')).toHaveTextContent('injectFailure off');
    });
  });

  it('a TRY click fires the kind and renders the envelope with requestId + header match', async () => {
    render(<ErrorExplorerDemo />);
    await screen.findByTestId('errors-taxonomy-table');

    fireEvent.click(screen.getByTestId('errors-try-validation'));

    await waitFor(() => {
      expect(screen.getByTestId('errors-taxonomy-probe')).toBeDefined();
    });
    expect(calls.some((call) => call.url === `${ERROR_URL}?failure=validation` && call.method === 'GET')).toBe(true);
    expect(screen.getByTestId('errors-taxonomy-probe')).toHaveTextContent('400');
    expect(screen.getByTestId('errors-taxonomy-probe-code')).toHaveTextContent('validation_failed');
    expect(screen.getByTestId('errors-taxonomy-probe-request-id').textContent ?? '').toMatch(
      /requestId: req-\d+/,
    );
    expect(screen.getByTestId('errors-taxonomy-probe-match')).toHaveTextContent('MATCH');
    // The envelope body is rendered pretty-printed with the canonical keys.
    expect(screen.getByTestId('errors-taxonomy-probe-body')).toHaveTextContent('"requestId"');
  });

  it('every taxonomy row is wired — firing unavailable renders the 503 envelope', async () => {
    render(<ErrorExplorerDemo />);
    await screen.findByTestId('errors-taxonomy-table');

    fireEvent.click(screen.getByTestId('errors-try-unavailable'));

    await waitFor(() => {
      expect(screen.getByTestId('errors-taxonomy-probe-code')).toHaveTextContent('service_unavailable');
    });
    expect(screen.getByTestId('errors-taxonomy-probe')).toHaveTextContent('503');
    expect(screen.getByTestId('errors-taxonomy-probe-match')).toHaveTextContent('MATCH');
  });

  it('the injection toggle flips /api/demo/status to the 503 envelope (Result path)', async () => {
    render(<ErrorExplorerDemo />);
    await screen.findByTestId('errors-taxonomy-table');

    // Before: the Result path answers a normal 200 payload.
    fireEvent.click(screen.getByTestId('errors-call-status'));
    await waitFor(() => {
      expect(screen.getByTestId('errors-status-probe')).toHaveTextContent('200');
    });
    expect(screen.queryByTestId('errors-status-probe-code')).toBeNull();

    fireEvent.click(screen.getByTestId('errors-toggle-inject'));
    const patch = calls.find((call) => call.url === SCENARIO_URL && call.method === 'PATCH');
    expect(patch?.body).toBe(JSON.stringify({ injectFailure: true }));
    await waitFor(() => {
      expect(screen.getByTestId('errors-scenario-state')).toHaveTextContent('injectFailure on');
    });

    // After: the SAME endpoint answers the 503 envelope — same shape as the
    // throw path above, which is the entire lesson.
    fireEvent.click(screen.getByTestId('errors-call-status'));
    await waitFor(() => {
      expect(screen.getByTestId('errors-status-probe')).toHaveTextContent('503');
    });
    expect(screen.getByTestId('errors-status-probe-code')).toHaveTextContent('service_unavailable');
    expect(screen.getByTestId('errors-status-probe-request-id').textContent ?? '').toMatch(
      /requestId: req-\d+/,
    );
    expect(screen.getByTestId('errors-status-probe-match')).toHaveTextContent('MATCH');
  });

  it('the data-mode toggle PATCHes the other scenario field', async () => {
    render(<ErrorExplorerDemo />);
    await screen.findByTestId('errors-taxonomy-table');

    fireEvent.click(screen.getByTestId('errors-toggle-data-mode'));
    const patch = calls.find((call) => call.url === SCENARIO_URL && call.method === 'PATCH');
    expect(patch?.body).toBe(JSON.stringify({ dataMode: 'live' }));
    await waitFor(() => {
      expect(screen.getByTestId('errors-scenario-state')).toHaveTextContent('dataMode live');
    });
  });

  it('the fallback branch: plain Error → 500 internal_error, malformed JSON → 400 request_failed', async () => {
    render(<ErrorExplorerDemo />);
    await screen.findByTestId('errors-taxonomy-table');

    fireEvent.click(screen.getByTestId('errors-plain-error'));
    await waitFor(() => {
      expect(screen.getByTestId('errors-fallback-probe')).toHaveTextContent('500');
    });
    expect(screen.getByTestId('errors-fallback-probe-code')).toHaveTextContent('internal_error');
    expect(screen.getByTestId('errors-fallback-probe-match')).toHaveTextContent('MATCH');

    fireEvent.click(screen.getByTestId('errors-bad-json'));
    await waitFor(() => {
      expect(screen.getByTestId('errors-fallback-probe')).toHaveTextContent('400');
    });
    expect(screen.getByTestId('errors-fallback-probe-code')).toHaveTextContent('request_failed');
    const post = calls.find((call) => call.url === POSTS_URL && call.method === 'POST');
    expect(post?.body).toBe('{"title": '); // the deliberately-malformed body
  });

  it('an unreachable API shows the error strip without crashing', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<ErrorExplorerDemo />);

    await waitFor(() => {
      expect(screen.getByTestId('errors-error')).toHaveTextContent('unreachable');
    });
    expect(screen.getByTestId('errors-summary')).toBeDefined();
  });
});
