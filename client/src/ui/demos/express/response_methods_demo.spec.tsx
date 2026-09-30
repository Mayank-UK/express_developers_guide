import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ResponseMethodsDemo from './response_methods_demo';
import { stubApiFetch, stubNetworkFailure, type StubRoute } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = '/api/demo/reqres/respond';
const REQUEST_ID = '9a1f5c33-7e42-4b08-b5d6-8c7e2f1a0b4c';

/** The teaching Set-Cookie the real cookie mode produces. */
const TEACHING_COOKIE =
  'teaching_cookie=baked; Max-Age=60; Path=/; HttpOnly; SameSite=Strict';

function modeRoute(
  mode: string,
  status: number,
  text: string,
  headers: Record<string, string>,
): StubRoute {
  return {
    url: `${BASE}?mode=${mode}`,
    status,
    text,
    headers: { 'x-request-id': REQUEST_ID, ...headers },
  };
}

describe('ResponseMethodsDemo — idle render', () => {
  it('renders the seven family buttons and the status dropdown, fetching nothing', () => {
    const fetchMock = (() => {
      stubApiFetch([]);
      return vi.mocked(fetch);
    })();

    render(<ResponseMethodsDemo />);

    for (const mode of ['json', 'text', 'status', 'redirect', 'cookie', 'stream', 'download']) {
      expect(screen.getByTestId(`reqres-methods-mode-${mode}`)).toBeEnabled();
    }
    expect(screen.getByTestId('reqres-methods-status')).toHaveValue('409');
    expect(screen.getByTestId('reqres-methods-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('reqres-methods-result')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ResponseMethodsDemo — mode=json', () => {
  it('shows the status line, the Content-Type row, the body, and the res.json verdict', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        modeRoute(
          'json',
          200,
          JSON.stringify({
            mode: 'json',
            producedBy: 'res.json(object)',
            lesson: 'res.json serializes and sets Content-Type',
          }),
          { 'content-type': 'application/json; charset=utf-8' },
        ),
      ]);
      return vi.mocked(fetch);
    })();

    render(<ResponseMethodsDemo />);
    fireEvent.click(screen.getByTestId('reqres-methods-mode-json'));

    await screen.findByTestId('reqres-methods-result');

    const status = screen.getByTestId('reqres-methods-status-line');
    expect(status).toHaveTextContent('200');
    expect(status).toHaveTextContent('OK');
    expect(status).toHaveTextContent(`${BASE}?mode=json`);

    expect(screen.getByTestId('reqres-methods-header-content-type')).toHaveTextContent(
      'application/json; charset=utf-8',
    );
    expect(screen.getByTestId('reqres-methods-body')).toHaveTextContent('"producedBy": "res.json(object)"');
    expect(screen.getByTestId('reqres-methods-verdict')).toHaveTextContent('res.json(object)');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firedCall = fetchMock.mock.calls[0];
    if (firedCall === undefined) throw new Error('expected the fired request');
    expect(String(firedCall[0])).toBe(`${BASE}?mode=json`);
    expect(firedCall[1]?.method).toBe('GET');
  });
});

describe('ResponseMethodsDemo — mode=status', () => {
  it('sends the chosen code and renders its status line and verdict', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        {
          url: `${BASE}?mode=status&status=418`,
          status: 418,
          text: JSON.stringify({ mode: 'status', chosen: 418, producedBy: 'res.status(418).json(object)' }),
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': REQUEST_ID },
        },
      ]);
      return vi.mocked(fetch);
    })();

    render(<ResponseMethodsDemo />);
    fireEvent.change(screen.getByTestId('reqres-methods-status'), { target: { value: '418' } });
    fireEvent.click(screen.getByTestId('reqres-methods-mode-status'));

    await screen.findByTestId('reqres-methods-result');

    expect(screen.getByTestId('reqres-methods-status-line')).toHaveTextContent('418');
    expect(screen.getByTestId('reqres-methods-status-line')).toHaveTextContent("I'm a teapot");
    expect(screen.getByTestId('reqres-methods-verdict')).toHaveTextContent('res.status(418).json(object)');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}?mode=status&status=418`);
  });

  it('renders the 204 verdict: no body at all', async () => {
    stubApiFetch([
      {
        url: `${BASE}?mode=status&status=204`,
        status: 204,
        text: '',
        headers: { 'x-request-id': REQUEST_ID },
      },
    ]);

    render(<ResponseMethodsDemo />);
    fireEvent.change(screen.getByTestId('reqres-methods-status'), { target: { value: '204' } });
    fireEvent.click(screen.getByTestId('reqres-methods-mode-status'));

    await screen.findByTestId('reqres-methods-result');

    expect(screen.getByTestId('reqres-methods-status-line')).toHaveTextContent('204');
    expect(screen.getByTestId('reqres-methods-body')).toHaveTextContent('(empty body)');
    expect(screen.getByTestId('reqres-methods-verdict')).toHaveTextContent('NO body');
  });
});

describe('ResponseMethodsDemo — mode=redirect', () => {
  it('fires with redirect:"manual" in the fetch init and shows the 307 + Location instead of following', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        modeRoute(
          'redirect',
          307,
          'Found. Redirecting to /api/demo/reqres/redirect-target',
          { location: '/api/demo/reqres/redirect-target', 'content-type': 'text/plain; charset=utf-8' },
        ),
      ]);
      return vi.mocked(fetch);
    })();

    render(<ResponseMethodsDemo />);
    fireEvent.click(screen.getByTestId('reqres-methods-mode-redirect'));

    await screen.findByTestId('reqres-methods-result');

    // THE assertion this demo exists for: the manual redirect in the init.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firedCall = fetchMock.mock.calls[0];
    if (firedCall === undefined) throw new Error('expected the fired request');
    expect(String(firedCall[0])).toBe(`${BASE}?mode=redirect`);
    expect(firedCall[1]?.redirect).toBe('manual');

    // The 3xx itself is the result — status line, Location row, verdict.
    const status = screen.getByTestId('reqres-methods-status-line');
    expect(status).toHaveTextContent('307');
    expect(status).toHaveTextContent('Temporary Redirect');
    expect(screen.getByTestId('reqres-methods-header-location')).toHaveTextContent(
      '/api/demo/reqres/redirect-target',
    );
    expect(screen.getByTestId('reqres-methods-verdict')).toHaveTextContent('res.redirect(307, target)');

    // Not opaque in this environment → no follow-up fetch happened.
    expect(screen.queryByTestId('reqres-methods-opaque')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reqres-methods-followed')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ResponseMethodsDemo — mode=cookie', () => {
  it('shows the Set-Cookie attributes the cookie method set', async () => {
    stubApiFetch([
      modeRoute(
        'cookie',
        200,
        JSON.stringify({ mode: 'cookie', set: true, note: 'the lesson is in Set-Cookie' }),
        { 'content-type': 'application/json; charset=utf-8', 'set-cookie': TEACHING_COOKIE },
      ),
    ]);

    render(<ResponseMethodsDemo />);
    fireEvent.click(screen.getByTestId('reqres-methods-mode-cookie'));

    await screen.findByTestId('reqres-methods-result');

    const cookieRow = screen.getByTestId('reqres-methods-header-set-cookie');
    expect(cookieRow).toHaveTextContent('teaching_cookie=baked');
    expect(cookieRow).toHaveTextContent('HttpOnly');
    expect(cookieRow).toHaveTextContent('SameSite=Strict');
    expect(cookieRow).toHaveTextContent('Max-Age=60');
    expect(screen.getByTestId('reqres-methods-verdict')).toHaveTextContent('res.cookie(name, value');
    expect(screen.queryByTestId('reqres-methods-set-cookie-hidden')).not.toBeInTheDocument();
  });

  it('says so honestly when the environment hides Set-Cookie entirely', async () => {
    stubApiFetch([
      modeRoute(
        'cookie',
        200,
        JSON.stringify({ mode: 'cookie', set: true }),
        { 'content-type': 'application/json; charset=utf-8' },
      ),
    ]);

    render(<ResponseMethodsDemo />);
    fireEvent.click(screen.getByTestId('reqres-methods-mode-cookie'));

    await screen.findByTestId('reqres-methods-result');

    expect(screen.queryByTestId('reqres-methods-header-set-cookie')).not.toBeInTheDocument();
    const note = screen.getByTestId('reqres-methods-set-cookie-hidden');
    expect(note).toHaveTextContent('forbidden response header');
  });
});

describe('ResponseMethodsDemo — mode=stream and mode=download', () => {
  it('shows the chunked transfer encoding and the five ndjson lines', async () => {
    stubApiFetch([
      modeRoute(
        'stream',
        200,
        Array.from({ length: 5 }, (_, i) => `{"seq":${i + 1},"of":5,"mode":"stream"}\n`).join(''),
        { 'content-type': 'application/x-ndjson', 'transfer-encoding': 'chunked', 'x-stream-lines': '5' },
      ),
    ]);

    render(<ResponseMethodsDemo />);
    fireEvent.click(screen.getByTestId('reqres-methods-mode-stream'));

    await screen.findByTestId('reqres-methods-result');

    expect(screen.getByTestId('reqres-methods-header-transfer-encoding')).toHaveTextContent('chunked');
    expect(screen.getByTestId('reqres-methods-header-x-stream-lines')).toHaveTextContent('5');
    const body = screen.getByTestId('reqres-methods-body');
    expect(body).toHaveTextContent('"seq":1');
    expect(body).toHaveTextContent('"seq":5');
  });

  it('shows the Content-Disposition that makes a body a download', async () => {
    stubApiFetch([
      modeRoute(
        'download',
        200,
        'teaching.txt — this body arrives as a download because of one header.\n',
        {
          'content-disposition': 'attachment; filename="teaching.txt"',
          'content-type': 'text/plain; charset=utf-8',
        },
      ),
    ]);

    render(<ResponseMethodsDemo />);
    fireEvent.click(screen.getByTestId('reqres-methods-mode-download'));

    await screen.findByTestId('reqres-methods-result');

    expect(screen.getByTestId('reqres-methods-header-content-disposition')).toHaveTextContent(
      'attachment; filename="teaching.txt"',
    );
    expect(screen.getByTestId('reqres-methods-verdict')).toHaveTextContent('res.download()');
  });
});

describe('ResponseMethodsDemo — failure state', () => {
  it('shows a friendly error instead of a result when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<ResponseMethodsDemo />);
    fireEvent.click(screen.getByTestId('reqres-methods-mode-json'));

    const alert = await screen.findByTestId('reqres-methods-error');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(screen.queryByTestId('reqres-methods-result')).not.toBeInTheDocument();
  });
});
