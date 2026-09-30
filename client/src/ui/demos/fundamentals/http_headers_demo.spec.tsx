import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import HttpHeadersDemo from './http_headers_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const INSPECT_URL = '/api/demo/http/inspect?via=browser-demo';
const NEGOTIATE_URL = '/api/demo/http/negotiate';
const REQUEST_ID = '8f14e45f-4e2b-4c1a-9f7c-2a3b4c5d6e7f';

/** The inspect reply shaped exactly like the server's echo. */
const inspectRoute = {
  url: INSPECT_URL,
  text: JSON.stringify({
    method: 'GET',
    httpVersion: '1.1',
    path: '/api/demo/http/inspect',
    query: { via: 'browser-demo' },
    headers: {
      accept: 'application/json',
      host: 'localhost:5173',
      'user-agent': 'stub-agent',
      'x-request-id': REQUEST_ID,
    },
    requestId: REQUEST_ID,
  }),
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Accept',
    'x-teaching-header': 'set-by-the-server',
    'x-request-id': REQUEST_ID,
  },
};

/** The negotiate reply for a given chosen representation. */
function negotiateRoute(
  acceptKey: 'json' | 'text' | 'html',
  body: string,
): { url: string; text: string; headers: Record<string, string> } {
  const contentType =
    acceptKey === 'json'
      ? 'application/json; charset=utf-8'
      : acceptKey === 'text'
        ? 'text/plain; charset=utf-8'
        : 'text/html; charset=utf-8';
  return { url: NEGOTIATE_URL, text: body, headers: { 'content-type': contentType, vary: 'Accept' } };
}

const JSON_BODY = JSON.stringify(
  {
    resource: '/api/demo/http/negotiate',
    lesson: 'One resource, several representations.',
    acceptHeader: 'application/json',
    chosenRepresentation: 'application/json; charset=utf-8',
  },
  null,
  2,
);

const TEXT_BODY = [
  'resource: /api/demo/http/negotiate',
  'lesson: One resource, several representations.',
  'accept: text/plain',
  'chosen representation: text/plain; charset=utf-8',
  '',
].join('\n');

const HTML_BODY = `<!doctype html>
<html lang="en"><body><dl><dt>accept</dt><dd>text/html</dd></dl></body></html>
`;

describe('HttpHeadersDemo — inspector panel', () => {
  it('renders both panels idle and fetches nothing', () => {
    const fetchMock = (() => {
      stubApiFetch([inspectRoute]);
      return vi.mocked(fetch);
    })();

    render(<HttpHeadersDemo />);

    expect(screen.getByTestId('http-inspect-run')).toHaveTextContent('Inspect my request');
    for (const key of ['json', 'text', 'html'] as const) {
      expect(screen.getByTestId(`http-negotiate-${key}`)).toBeEnabled();
    }
    expect(screen.queryByTestId('http-inspect-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('http-negotiate-result')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the echoed request line, query, and header tables after a run', async () => {
    const fetchMock = (() => {
      stubApiFetch([inspectRoute]);
      return vi.mocked(fetch);
    })();

    render(<HttpHeadersDemo />);
    fireEvent.click(screen.getByTestId('http-inspect-run'));

    const summary = await screen.findByTestId('http-inspect-summary');
    expect(summary).toHaveTextContent('GET /api/demo/http/inspect');
    expect(summary).toHaveTextContent('HTTP/1.1');
    expect(summary).toHaveTextContent('browser-demo'); // the parsed query, echoed
    expect(summary).toHaveTextContent(REQUEST_ID);

    // Request headers as the server saw them — including the highlighted
    // correlation id row a proxy would forward.
    const requestHeaders = await screen.findByTestId('http-inspect-req-headers');
    expect(requestHeaders).toHaveTextContent('accept');
    expect(requestHeaders).toHaveTextContent('application/json');
    expect(requestHeaders).toHaveTextContent('host');
    const highlight = screen.getByTestId('http-inspect-req-headers-highlight');
    expect(highlight).toHaveTextContent('x-request-id');
    expect(highlight).toHaveTextContent(REQUEST_ID);

    // Response headers as the browser received them.
    const responseHeaders = screen.getByTestId('http-inspect-res-headers');
    expect(responseHeaders).toHaveTextContent('x-teaching-header');
    expect(responseHeaders).toHaveTextContent('set-by-the-server');
    expect(responseHeaders).toHaveTextContent('cache-control');
    expect(responseHeaders).toHaveTextContent('no-store');
    expect(responseHeaders).toHaveTextContent('vary');
    expect(responseHeaders).toHaveTextContent('Accept');

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([INSPECT_URL]);
  });
});

describe('HttpHeadersDemo — negotiator panel', () => {
  it('sends Accept: application/json and pretty-prints the JSON body', async () => {
    const fetchMock = (() => {
      stubApiFetch([negotiateRoute('json', JSON_BODY)]);
      return vi.mocked(fetch);
    })();

    render(<HttpHeadersDemo />);
    fireEvent.click(screen.getByTestId('http-negotiate-json'));

    const result = await screen.findByTestId('http-negotiate-result');
    expect(result).toHaveTextContent('Accept: application/json');
    expect(result).toHaveTextContent('Content-Type: application/json; charset=utf-8');
    expect(result).toHaveTextContent('Vary: Accept');

    const body = screen.getByTestId('http-negotiate-body');
    // Pretty-printed JSON: key and value on formatted lines.
    expect(body).toHaveTextContent('"resource": "/api/demo/http/negotiate"');
    expect(body).toHaveTextContent('"chosenRepresentation"');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (firstCall === undefined) throw new Error('expected exactly one fetch call');
    const [url, init] = firstCall;
    expect(String(url)).toBe(NEGOTIATE_URL);
    expect(init?.headers).toEqual({ accept: 'application/json' });
  });

  it('shows the flattened text representation for Accept: text/plain', async () => {
    stubApiFetch([negotiateRoute('text', TEXT_BODY)]);

    render(<HttpHeadersDemo />);
    fireEvent.click(screen.getByTestId('http-negotiate-text'));

    const result = await screen.findByTestId('http-negotiate-result');
    expect(result).toHaveTextContent('Content-Type: text/plain; charset=utf-8');
    const body = screen.getByTestId('http-negotiate-body');
    expect(body).toHaveTextContent('resource: /api/demo/http/negotiate');
    expect(body).toHaveTextContent('chosen representation: text/plain; charset=utf-8');
  });

  it('shows the tiny HTML document for Accept: text/html', async () => {
    stubApiFetch([negotiateRoute('html', HTML_BODY)]);

    render(<HttpHeadersDemo />);
    fireEvent.click(screen.getByTestId('http-negotiate-html'));

    const result = await screen.findByTestId('http-negotiate-result');
    expect(result).toHaveTextContent('Content-Type: text/html; charset=utf-8');
    expect(screen.getByTestId('http-negotiate-body')).toHaveTextContent('<dl>');
  });

  it('shows the server error message when negotiation fails', async () => {
    stubApiFetch([
      {
        url: NEGOTIATE_URL,
        status: 400,
        text: JSON.stringify({
          error: { code: 'validation_failed', message: 'no acceptable representation', requestId: 'r-9' },
        }),
      },
    ]);

    render(<HttpHeadersDemo />);
    fireEvent.click(screen.getByTestId('http-negotiate-json'));

    const alert = await screen.findByTestId('http-negotiate-error');
    expect(alert).toHaveTextContent('no acceptable representation');
    expect(screen.queryByTestId('http-negotiate-result')).not.toBeInTheDocument();
  });

  it('shows a friendly error when the server is unreachable (inspect panel)', async () => {
    stubNetworkFailure();

    render(<HttpHeadersDemo />);
    fireEvent.click(screen.getByTestId('http-inspect-run'));

    const alert = await screen.findByTestId('http-inspect-error');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(screen.queryByTestId('http-inspect-summary')).not.toBeInTheDocument();
  });
});
