import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PostsWorkbenchDemo from './posts_workbench_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SCENARIO_URL = '/api/demo/scenario';
const POSTS_URL = '/api/posts';

const SEED_POSTS = [
  {
    id: '0f1c2b3a-0000-4000-8000-000000000003',
    title: 'Failures are values here',
    body: 'Repositories and use cases return Result values instead of throwing.',
    author: 'the guide',
    createdAt: '2026-09-24T09:10:00.000Z',
    updatedAt: '2026-09-24T09:10:00.000Z',
  },
  {
    id: '0f1c2b3a-0000-4000-8000-000000000002',
    title: 'The dependency rule, concretely',
    body: 'Presentation may import domain; data implements domain interfaces.',
    author: 'the guide',
    createdAt: '2026-09-24T09:05:00.000Z',
    updatedAt: '2026-09-24T09:05:00.000Z',
  },
];

const CREATED_POST = {
  id: '9b8c7d6e-0000-4000-8000-00000000feed',
  title: 'Designed, not accreted',
  body: 'Nouns in paths, semantics in methods, one error envelope.',
  author: 'you',
  createdAt: '2026-09-28T18:55:00.000Z',
  updatedAt: '2026-09-28T18:55:00.000Z',
};

interface MethodRoute {
  method: string;
  url: string;
  status?: number;
  body?: unknown;
}

/** Minimal JSON Response stand-in (text + json both provided). */
function jsonResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/**
 * Method-aware fetch double: the shared stubApiFetch dispatches on URL only,
 * but the workbench's scenario endpoint answers BOTH GET and PATCH at one
 * URL. Entries are consumed in order when duplicated (so a route can answer
 * 200 the first time and 503 the next); the last entry is sticky.
 */
function stubMethodFetch(routes: readonly MethodRoute[]): ReturnType<typeof vi.fn> {
  const remaining = routes.map((route) => ({ ...route, consumed: false }));
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const matches = remaining.filter((route) => route.method === method && route.url === url);
    if (matches.length === 0) {
      return jsonResponse({ error: { code: 'not_found', message: `no fetch stub for ${method} ${url}` } }, 404);
    }
    const route = matches.find((candidate) => !candidate.consumed) ?? matches[matches.length - 1]!;
    route.consumed = true;
    return jsonResponse(route.body, route.status ?? 200);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('PostsWorkbenchDemo — initial load', () => {
  it('renders the collection, the scenario, a 2xx critique, and logs the two mount calls', async () => {
    const fetchMock = (() => {
      stubMethodFetch([
        { method: 'GET', url: SCENARIO_URL, body: { dataMode: 'fake', injectFailure: false } },
        { method: 'GET', url: POSTS_URL, body: { posts: SEED_POSTS } },
      ]);
      return vi.mocked(fetch);
    })();

    render(<PostsWorkbenchDemo />);

    await screen.findByTestId('posts-workbench-list');
    const rows = screen.getAllByTestId('posts-workbench-post-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Failures are values here');
    expect(rows[1]).toHaveTextContent('The dependency rule, concretely');

    expect(screen.getByTestId('posts-workbench-mode')).toHaveTextContent('fake');
    expect(screen.getByTestId('posts-workbench-inject')).toHaveTextContent('off');
    expect(screen.getByTestId('posts-workbench-list-critique')).toHaveTextContent('2xx');
    expect(screen.getByTestId('posts-workbench-list-critique')).toHaveTextContent('200');

    // The log recorded both mount fires, newest first (the list load last).
    const logRows = screen.getAllByTestId(/^posts-workbench-log-row-\d+$/);
    expect(logRows).toHaveLength(2);
    expect(logRows[0]).toHaveTextContent('GET /api/posts 200');
    expect(logRows[1]).toHaveTextContent(`GET ${SCENARIO_URL} 200`);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to an error state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<PostsWorkbenchDemo />);

    const envelope = await screen.findByTestId('posts-workbench-list-envelope');
    expect(envelope).toHaveTextContent('could not reach the server');
    expect(screen.getByTestId('posts-workbench-list-critique')).toHaveTextContent('network failure');
    // The log row for the failed call shows ERR, not a status.
    expect(screen.getByTestId('posts-workbench-log-row-0')).toHaveTextContent('ERR');
  });
});

describe('PostsWorkbenchDemo — create', () => {
  it('creates a post (201) and shows it appended, newest first, with the POST logged', async () => {
    const fetchMock = (() => {
      stubMethodFetch([
        { method: 'GET', url: SCENARIO_URL, body: { dataMode: 'fake', injectFailure: false } },
        { method: 'GET', url: POSTS_URL, body: { posts: SEED_POSTS } },
        { method: 'POST', url: POSTS_URL, status: 201, body: CREATED_POST },
      ]);
      return vi.mocked(fetch);
    })();

    render(<PostsWorkbenchDemo />);
    await screen.findByTestId('posts-workbench-list');

    fireEvent.change(screen.getByTestId('posts-workbench-field-title'), {
      target: { value: 'Designed, not accreted' },
    });
    fireEvent.change(screen.getByTestId('posts-workbench-field-body'), {
      target: { value: 'Nouns in paths, semantics in methods, one error envelope.' },
    });
    fireEvent.change(screen.getByTestId('posts-workbench-field-author'), { target: { value: 'you' } });
    fireEvent.click(screen.getByTestId('posts-workbench-create'));

    await screen.findByTestId('posts-workbench-create-result');
    expect(screen.getByTestId('posts-workbench-create-result')).toHaveTextContent('201 Created');
    expect(screen.getByTestId('posts-workbench-create-result')).toHaveTextContent('Designed, not accreted');
    expect(screen.getByTestId('posts-workbench-create-critique')).toHaveTextContent('2xx');
    expect(screen.getByTestId('posts-workbench-create-critique')).toHaveTextContent('201');

    // The created post landed ON TOP of the collection (newest first).
    const rows = screen.getAllByTestId('posts-workbench-post-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Designed, not accreted');

    // The POST carried exactly the form, as JSON.
    const postCall = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toEqual({
      title: 'Designed, not accreted',
      body: 'Nouns in paths, semantics in methods, one error envelope.',
      author: 'you',
    });

    // Three fires total: scenario + list on mount, then the create.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('posts-workbench-log-row-0')).toHaveTextContent('POST /api/posts 201');
  });

  it('renders the 400 envelope with field-level errors when validation rejects', async () => {
    stubMethodFetch([
      { method: 'GET', url: SCENARIO_URL, body: { dataMode: 'fake', injectFailure: false } },
      { method: 'GET', url: POSTS_URL, body: { posts: SEED_POSTS } },
      {
        method: 'POST',
        url: POSTS_URL,
        status: 400,
        body: {
          error: {
            code: 'validation_failed',
            message: 'post payload is invalid',
            requestId: '9a1f5c33-7e42-4b08-b5d6-8c7e2f1a0b4c',
            fields: {
              title: 'must be a string of 1 to 120 characters (got 0)',
              surprise: 'unknown field — only title, body and author are accepted',
            },
          },
        },
      },
    ]);

    render(<PostsWorkbenchDemo />);
    await screen.findByTestId('posts-workbench-list');

    fireEvent.click(screen.getByTestId('posts-workbench-create'));

    const envelope = await screen.findByTestId('posts-workbench-create-envelope');
    expect(envelope).toHaveTextContent('400');
    const fieldErrors = screen.getAllByTestId('posts-workbench-create-field-error');
    expect(fieldErrors).toHaveLength(2);
    expect(fieldErrors[0]).toHaveTextContent(/^title — /);
    expect(fieldErrors[1]).toHaveTextContent(/^surprise — /);
    expect(envelope).toHaveTextContent('validation_failed');
    expect(screen.getByTestId('posts-workbench-create-critique')).toHaveTextContent('4xx');
    // The collection is untouched by the failed create.
    expect(screen.getAllByTestId('posts-workbench-post-row')).toHaveLength(2);
  });
});

describe('PostsWorkbenchDemo — scenario toggles', () => {
  it('injecting failure shows the 503 envelope in the list panel (PATCH then reload)', async () => {
    stubMethodFetch([
      { method: 'GET', url: SCENARIO_URL, body: { dataMode: 'fake', injectFailure: false } },
      { method: 'GET', url: POSTS_URL, body: { posts: SEED_POSTS } },
      { method: 'PATCH', url: SCENARIO_URL, body: { dataMode: 'fake', injectFailure: true } },
      {
        method: 'GET',
        url: POSTS_URL,
        status: 503,
        body: {
          error: {
            code: 'service_unavailable',
            message: 'Failure injection is ON — this is the demo 503',
            requestId: '9a1f5c33-7e42-4b08-b5d6-8c7e2f1a0b4c',
          },
        },
      },
    ]);

    render(<PostsWorkbenchDemo />);
    await screen.findByTestId('posts-workbench-list');
    expect(screen.queryByTestId('posts-workbench-list-envelope')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('posts-workbench-toggle-failure'));

    const envelope = await screen.findByTestId('posts-workbench-list-envelope');
    expect(envelope).toHaveTextContent('service_unavailable');
    expect(envelope).toHaveTextContent('Failure injection is ON');
    expect(screen.getByTestId('posts-workbench-list-critique')).toHaveTextContent('5xx');
    expect(screen.getByTestId('posts-workbench-inject')).toHaveTextContent('on');
    // The reload fired by the toggle is logged with its 503.
    expect(screen.getByTestId('posts-workbench-log-row-0')).toHaveTextContent('GET /api/posts 503');
  });

  it('switches the data mode and reloads through it (live answers the same resource)', async () => {
    const fetchMock = (() => {
      stubMethodFetch([
        { method: 'GET', url: SCENARIO_URL, body: { dataMode: 'fake', injectFailure: false } },
        { method: 'GET', url: POSTS_URL, body: { posts: SEED_POSTS } },
        { method: 'PATCH', url: SCENARIO_URL, body: { dataMode: 'live', injectFailure: false } },
        { method: 'GET', url: POSTS_URL, body: { posts: SEED_POSTS } },
      ]);
      return vi.mocked(fetch);
    })();

    render(<PostsWorkbenchDemo />);
    await screen.findByTestId('posts-workbench-list');

    fireEvent.click(screen.getByTestId('posts-workbench-toggle-mode'));

    await screen.findByTestId('posts-workbench-mode');
    expect(screen.getByTestId('posts-workbench-mode')).toHaveTextContent('live');
    expect(screen.getAllByTestId('posts-workbench-post-row')).toHaveLength(2);

    const patchCall = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual({ dataMode: 'live' });
  });
});

describe('PostsWorkbenchDemo — request log discipline', () => {
  it('caps the log at the last ten requests', async () => {
    // URL-only stub is enough: this test fires GETs exclusively.
    stubApiFetch([
      { url: SCENARIO_URL, body: { dataMode: 'fake', injectFailure: false } },
      { url: POSTS_URL, body: { posts: SEED_POSTS } },
    ]);

    render(<PostsWorkbenchDemo />);
    await screen.findByTestId('posts-workbench-list');

    for (let round = 0; round < 9; round += 1) {
      fireEvent.click(screen.getByTestId('posts-workbench-reload'));
    }

    // 2 mount fires + 9 reloads = 11 requests; the log keeps the last 10.
    await screen.findByTestId('posts-workbench-log');
    expect(screen.getAllByTestId(/^posts-workbench-log-row-\d+$/)).toHaveLength(10);
    expect(screen.queryByTestId('posts-workbench-log-row-10')).not.toBeInTheDocument();
  });
});
