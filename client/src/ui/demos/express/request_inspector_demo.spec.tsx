import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RequestInspectorDemo from './request_inspector_demo';
import { stubApiFetch, stubNetworkFailure, type StubRoute } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const INSPECT_URL = '/api/demo/reqres/inspect?via=inspector-demo';
const REQUEST_ID = '3f2a8c1e-6b4d-4c9a-9f10-2d5e7b8a4c6d';

/** A reflected reply shaped exactly like the server's ANY /inspect echo. */
function inspectRoute(overrides?: Partial<Record<string, unknown>>): StubRoute {
  return {
    url: INSPECT_URL,
    text: JSON.stringify({
      method: 'POST',
      path: '/api/demo/reqres/inspect',
      query: { via: 'inspector-demo' },
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        host: 'localhost:5173',
        'x-inspector-client': 'browser-demo',
        'x-request-id': REQUEST_ID,
      },
      body: { hello: 'inspector' },
      bodyRaw: null,
      bodyRawTruncated: false,
      requestId: REQUEST_ID,
      ...overrides,
    }),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  };
}

describe('RequestInspectorDemo — idle render', () => {
  it('renders the control panel with the body enabled for the POST + JSON default, fetching nothing', () => {
    const fetchMock = (() => {
      stubApiFetch([inspectRoute()]);
      return vi.mocked(fetch);
    })();

    render(<RequestInspectorDemo />);

    expect(screen.getByTestId('reqres-inspector-method')).toHaveValue('POST');
    expect(screen.getByTestId('reqres-inspector-content-type')).toHaveValue('application/json');
    expect(screen.getByTestId('reqres-inspector-path')).toHaveValue(INSPECT_URL);
    expect(screen.getByTestId('reqres-inspector-body')).toBeEnabled();
    expect(screen.getByTestId('reqres-inspector-body')).toHaveValue('{"hello": "inspector"}');
    expect(screen.getByTestId('reqres-inspector-fire')).toHaveTextContent('FIRE POST');
    expect(screen.getByTestId('reqres-inspector-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('reqres-inspector-result')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('RequestInspectorDemo — firing POST with a content type', () => {
  it('sends the chosen content type and body, and renders the reflected parsed body + custom headers', async () => {
    const fetchMock = (() => {
      stubApiFetch([inspectRoute()]);
      return vi.mocked(fetch);
    })();

    render(<RequestInspectorDemo />);
    fireEvent.click(screen.getByTestId('reqres-inspector-fire'));

    await screen.findByTestId('reqres-inspector-result');

    // The request: POST, the chosen content-type header, the body, and the
    // custom x- probe header every fire carries.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firedCall = fetchMock.mock.calls[0];
    if (firedCall === undefined) throw new Error('expected the fired request');
    expect(String(firedCall[0])).toBe(INSPECT_URL);
    expect(firedCall[1]?.method).toBe('POST');
    const headers = firedCall[1]?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-inspector-client']).toBe('browser-demo');
    expect(firedCall[1]?.body).toBe('{"hello": "inspector"}');

    // The reflected view: request line, parsed query, highlighted x- rows,
    // the PARSED body, and the correlation id.
    expect(screen.getByTestId('reqres-inspector-status')).toHaveTextContent('200');
    const requestTable = screen.getByTestId('reqres-inspector-request');
    expect(requestTable).toHaveTextContent('POST /api/demo/reqres/inspect');
    expect(requestTable).toHaveTextContent('via = inspector-demo');

    const probe = screen.getByTestId('reqres-inspector-header-x-x-inspector-client');
    expect(probe).toHaveTextContent('x-inspector-client');
    expect(probe).toHaveTextContent('browser-demo');
    expect(screen.getByTestId('reqres-inspector-header-x-x-request-id')).toHaveTextContent(REQUEST_ID);
    expect(screen.getByTestId('reqres-inspector-request-id')).toHaveTextContent(REQUEST_ID);

    const body = screen.getByTestId('reqres-inspector-body-parsed');
    expect(body).toHaveTextContent('"hello": "inspector"');
    expect(body).toHaveTextContent('parsed');
    expect(screen.queryByTestId('reqres-inspector-body-raw')).not.toBeInTheDocument();
  });

  it('switches to text/plain: sends that content type and renders the RAW stream body', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        inspectRoute({
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'x-request-id': REQUEST_ID },
          body: null,
          bodyRaw: 'still just bytes',
        }),
      ]);
      return vi.mocked(fetch);
    })();

    render(<RequestInspectorDemo />);
    fireEvent.change(screen.getByTestId('reqres-inspector-content-type'), {
      target: { value: 'text/plain' },
    });
    fireEvent.click(screen.getByTestId('reqres-inspector-fire'));

    await screen.findByTestId('reqres-inspector-result');

    const firedCall = fetchMock.mock.calls[0];
    if (firedCall === undefined) throw new Error('expected the fired request');
    const headers = firedCall[1]?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('text/plain');
    expect(firedCall[1]?.body).toBe('{"hello": "inspector"}');

    const raw = screen.getByTestId('reqres-inspector-body-raw');
    expect(raw).toHaveTextContent('still just bytes');
    expect(raw).toHaveTextContent('from the stream');
    expect(screen.queryByTestId('reqres-inspector-body-parsed')).not.toBeInTheDocument();
  });
});

describe('RequestInspectorDemo — the body enabling logic', () => {
  it('disables and omits the body for GET even with a content type chosen', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        inspectRoute({
          method: 'GET',
          headers: { accept: '*/*', host: 'localhost:5173', 'x-request-id': REQUEST_ID },
          body: null,
          bodyRaw: null,
        }),
      ]);
      return vi.mocked(fetch);
    })();

    render(<RequestInspectorDemo />);
    fireEvent.change(screen.getByTestId('reqres-inspector-method'), { target: { value: 'GET' } });

    // GET + application/json: the textarea is disabled (no body on a GET).
    expect(screen.getByTestId('reqres-inspector-body')).toBeDisabled();

    fireEvent.click(screen.getByTestId('reqres-inspector-fire'));
    await screen.findByTestId('reqres-inspector-result');

    const firedCall = fetchMock.mock.calls[0];
    if (firedCall === undefined) throw new Error('expected the fired request');
    expect(firedCall[1]?.method).toBe('GET');
    expect(firedCall[1]?.body).toBeUndefined();
    const headers = firedCall[1]?.headers as Record<string, string> | undefined;
    expect(headers?.['content-type']).toBeUndefined();

    // Nothing arrived: the none-section, not a body panel.
    expect(screen.getByTestId('reqres-inspector-body-none')).toBeInTheDocument();
    expect(screen.queryByTestId('reqres-inspector-body-parsed')).not.toBeInTheDocument();
  });

  it('disables the body when the content type is (none), for a body-carrying method too', () => {
    stubApiFetch([inspectRoute()]);

    render(<RequestInspectorDemo />);
    fireEvent.change(screen.getByTestId('reqres-inspector-content-type'), {
      target: { value: 'none' },
    });

    expect(screen.getByTestId('reqres-inspector-body')).toBeDisabled();
    expect(screen.getByTestId('reqres-inspector-fire')).toHaveTextContent('FIRE POST');
  });
});

describe('RequestInspectorDemo — failure states', () => {
  it('explains a 404 from an edited path instead of rendering an envelope as reflected data', async () => {
    stubApiFetch([
      {
        url: '/api/demo/reqres/nowhere',
        status: 404,
        text: JSON.stringify({
          error: { code: 'not_found', message: 'Cannot GET /api/demo/reqres/nowhere', requestId: REQUEST_ID },
        }),
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    ]);

    render(<RequestInspectorDemo />);
    fireEvent.change(screen.getByTestId('reqres-inspector-path'), {
      target: { value: '/api/demo/reqres/nowhere' },
    });
    fireEvent.click(screen.getByTestId('reqres-inspector-fire'));

    const alert = await screen.findByTestId('reqres-inspector-error');
    expect(alert).toHaveTextContent('404');
    expect(alert).toHaveTextContent('/api/demo/reqres/inspect');
    expect(screen.queryByTestId('reqres-inspector-result')).not.toBeInTheDocument();
  });

  it('shows a friendly error when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<RequestInspectorDemo />);
    fireEvent.click(screen.getByTestId('reqres-inspector-fire'));

    const alert = await screen.findByTestId('reqres-inspector-error');
    expect(alert).toHaveTextContent('Could not reach the server.');
  });
});
