import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RoutingExplorerDemo from './routing_explorer_demo';
import { stubApiFetch, stubNetworkFailure, type StubRoute } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG_URL = '/api/demo/routing/catalog';
const MOUNT = '/api/demo/routing';

/** Mirrors the server's ROUTING_DEMO_CATALOG (the table the demo must render). */
const CATALOG_ROUTES = [
  {
    method: 'GET',
    pattern: '/projects',
    fullPath: `${MOUNT}/projects`,
    purpose: 'static path — one literal URL, one handler',
    params: [] as string[],
    examplePath: `${MOUNT}/projects`,
  },
  {
    method: 'POST',
    pattern: '/projects',
    fullPath: `${MOUNT}/projects`,
    purpose: 'same path, different verb — the parsed JSON body is echoed back',
    params: [] as string[],
    examplePath: `${MOUNT}/projects`,
  },
  {
    method: 'GET',
    pattern: '/projects/:projectId',
    fullPath: `${MOUNT}/projects/:projectId`,
    purpose: 'named path parameter — validated at the boundary, echoed back',
    params: ['projectId'],
    examplePath: `${MOUNT}/projects/p1`,
  },
  {
    method: 'GET',
    pattern: '/projects/:projectId/tasks/:taskId',
    fullPath: `${MOUNT}/projects/:projectId/tasks/:taskId`,
    purpose: 'multiple named parameters in one pattern',
    params: ['projectId', 'taskId'],
    examplePath: `${MOUNT}/projects/p1/tasks/t9`,
  },
  {
    method: 'GET',
    pattern: '/search',
    fullPath: `${MOUNT}/search`,
    purpose: 'query string — ?q= &limit= parsed, with a default for limit',
    params: [] as string[],
    examplePath: `${MOUNT}/search?q=express&limit=5`,
  },
  {
    method: 'GET',
    pattern: '/files/*splat',
    fullPath: `${MOUNT}/files/*splat`,
    purpose: 'Express 5 named wildcard — captures a multi-segment suffix',
    params: ['splat'],
    examplePath: `${MOUNT}/files/docs/readme.md`,
  },
] as const;

/** The demo's row key — kept in sync with the component's derivation. */
function rowKey(method: string, pattern: string): string {
  return `${method} ${pattern}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

const catalogRoute: StubRoute = {
  url: CATALOG_URL,
  body: { mountPath: MOUNT, routeCount: CATALOG_ROUTES.length, routes: CATALOG_ROUTES },
};

/** A fired-route stub: text form, because the demo reads response.text(). */
function textRoute(url: string, status: number, body: unknown): StubRoute {
  return {
    url,
    status,
    text: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  };
}

describe('RoutingExplorerDemo — catalog render', () => {
  it('renders the route table served by the server\u2019s catalog', async () => {
    const fetchMock = (() => {
      stubApiFetch([catalogRoute]);
      return vi.mocked(fetch);
    })();

    render(<RoutingExplorerDemo />);

    const table = await screen.findByTestId('routing-explorer-table');
    for (const route of CATALOG_ROUTES) {
      expect(table).toHaveTextContent(route.pattern);
      expect(table).toHaveTextContent(route.purpose);
    }
    // Parameter capture notes next to the patterns that have them.
    expect(table).toHaveTextContent('captures: projectId, taskId');
    expect(table).toHaveTextContent('captures: splat');

    const summary = screen.getByTestId('routing-explorer-summary');
    expect(summary).toHaveTextContent('6 patterns');
    expect(summary).toHaveTextContent(MOUNT);

    // Inputs prefilled with the catalog's example paths — including the query
    // string row and the wildcard row, and the POST row's JSON body textarea.
    expect(screen.getByTestId(`routing-explorer-input-${rowKey('GET', '/search')}`)).toHaveValue(
      `${MOUNT}/search?q=express&limit=5`,
    );
    expect(screen.getByTestId(`routing-explorer-input-${rowKey('GET', '/files/*splat')}`)).toHaveValue(
      `${MOUNT}/files/docs/readme.md`,
    );
    expect(screen.getByTestId(`routing-explorer-body-${rowKey('POST', '/projects')}`)).toHaveValue(
      '{"name": "new-project"}',
    );

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([CATALOG_URL]);
    expect(screen.queryByTestId('routing-explorer-result')).not.toBeInTheDocument();
  });

  it('shows a load error when the catalog cannot be fetched', async () => {
    stubNetworkFailure();

    render(<RoutingExplorerDemo />);

    const alert = await screen.findByTestId('routing-explorer-load-error');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(screen.queryByTestId('routing-explorer-table')).not.toBeInTheDocument();
  });
});

describe('RoutingExplorerDemo — firing routes', () => {
  it('fires a GET param route at its prefilled path and shows the matched echo', async () => {
    const examplePath = `${MOUNT}/projects/p1`;
    const fetchMock = (() => {
      stubApiFetch([
        catalogRoute,
        textRoute(examplePath, 200, {
          matched: { method: 'GET', pattern: '/projects/:projectId', fullPath: `${MOUNT}/projects/:projectId` },
          params: { projectId: 'p1' },
          found: null,
        }),
      ]);
      return vi.mocked(fetch);
    })();

    render(<RoutingExplorerDemo />);
    await screen.findByTestId('routing-explorer-table');

    fireEvent.click(screen.getByTestId(`routing-explorer-fire-${rowKey('GET', '/projects/:projectId')}`));

    const status = await screen.findByTestId('routing-explorer-status');
    expect(status).toHaveTextContent('200');
    expect(status).toHaveTextContent('OK');
    expect(status).toHaveTextContent(examplePath);
    expect(screen.getByTestId('routing-explorer-elapsed')).toHaveTextContent(/ms$/);

    // The response body panel: the matched-route echo and the captured param.
    const body = screen.getByTestId('routing-explorer-body');
    expect(body).toHaveTextContent('"pattern": "/projects/:projectId"');
    expect(body).toHaveTextContent('"projectId": "p1"');

    // GET fired with GET semantics — and nothing else was called after the catalog.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firedCall = fetchMock.mock.calls[1];
    if (firedCall === undefined) throw new Error('expected the fired request');
    expect(String(firedCall[0])).toBe(examplePath);
    expect(firedCall[1]?.method).toBe('GET');
  });

  it('shows the 404 catch-all envelope for an unrouted, edited path', async () => {
    const unrouted = `${MOUNT}/nope`;
    stubApiFetch([
      catalogRoute,
      textRoute(unrouted, 404, {
        error: {
          code: 'not_found',
          message: `Cannot GET ${unrouted}`,
          requestId: 'd0d1d2d3-1111-2222-3333-444455556666',
        },
      }),
    ]);

    render(<RoutingExplorerDemo />);
    await screen.findByTestId('routing-explorer-table');

    // Edit the wildcard row's prefilled path into something unrouted…
    const input = screen.getByTestId(`routing-explorer-input-${rowKey('GET', '/files/*splat')}`);
    fireEvent.change(input, { target: { value: unrouted } });
    expect(input).toHaveValue(unrouted);

    // …fire it, and the fall-through envelope lands in the same panel.
    fireEvent.click(screen.getByTestId(`routing-explorer-fire-${rowKey('GET', '/files/*splat')}`));

    const status = await screen.findByTestId('routing-explorer-status');
    expect(status).toHaveTextContent('404');
    expect(status).toHaveTextContent('Not Found');
    const body = screen.getByTestId('routing-explorer-body');
    expect(body).toHaveTextContent('"code": "not_found"');
    expect(body).toHaveTextContent(`Cannot GET ${unrouted}`);
  });

  it('fires the POST row with its JSON body and shows the 201 echo', async () => {
    const postUrl = `${MOUNT}/projects`;
    const fetchMock = (() => {
      stubApiFetch([
        catalogRoute,
        textRoute(postUrl, 201, {
          matched: { method: 'POST', pattern: '/projects', fullPath: postUrl },
          created: { name: 'new-project' },
        }),
      ]);
      return vi.mocked(fetch);
    })();

    render(<RoutingExplorerDemo />);
    await screen.findByTestId('routing-explorer-table');

    fireEvent.click(screen.getByTestId(`routing-explorer-fire-${rowKey('POST', '/projects')}`));

    const status = await screen.findByTestId('routing-explorer-status');
    expect(status).toHaveTextContent('201');
    expect(status).toHaveTextContent('Created');
    expect(screen.getByTestId('routing-explorer-body')).toHaveTextContent('"name": "new-project"');

    // POST semantics: method, content-type, and the body all travel.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firedCall = fetchMock.mock.calls[1];
    if (firedCall === undefined) throw new Error('expected the fired request');
    expect(String(firedCall[0])).toBe(postUrl);
    expect(firedCall[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name": "new-project"}',
    });
  });

  it('shows a friendly error when the server is unreachable mid-fire', async () => {
    // The catalog loads, but every subsequent fetch throws (network dropped).
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => catalogRoute.body,
          };
        }
        throw new TypeError('Failed to fetch');
      }),
    );

    render(<RoutingExplorerDemo />);
    await screen.findByTestId('routing-explorer-table');

    fireEvent.click(screen.getByTestId(`routing-explorer-fire-${rowKey('GET', '/projects')}`));

    const alert = await screen.findByTestId('routing-explorer-error');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(screen.queryByTestId('routing-explorer-result')).not.toBeInTheDocument();
  });
});
