import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SqlSafetyDemo from './sql_safety_demo';
import { stubApiFetch } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const INJECTION_URL = '/api/demo/db/injection';
const TRANSFER_URL = '/api/demo/db/transfer';

const CLASSIC_PAYLOAD = `' OR '1'='1`;

function injectionBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    attempt: CLASSIC_PAYLOAD,
    safeQuery: 'SELECT id, title, author FROM posts WHERE title = ?',
    boundParameter: CLASSIC_PAYLOAD,
    parameterStyle: 'positional ?',
    matchedCount: 0,
    matchedRows: [],
    naiveQuery: `SELECT id, title, author FROM posts WHERE title = '' OR '1'='1'`,
    naiveNote: 'INERT — a string in this response, never executed.',
    verdict: 'the payload was compared as a literal title — no row has that exact title, so nothing matched',
    ...overrides,
  };
}

function transferBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    crash: false,
    transferred: true,
    rolledBack: false,
    moved: { tag: 'sqlite', from: 'post-alpha', to: 'post-beta' },
    writes: [
      'DELETE FROM posts_tags WHERE post_id = ? AND tag_id = ?',
      'INSERT INTO posts_tags (post_id, tag_id) VALUES (?, ?)',
    ],
    before: { 'post-alpha': 1, 'post-beta': 0 },
    after: { 'post-alpha': 0, 'post-beta': 1 },
    explain: 'both writes committed together — beta now carries the tag and alpha does not',
    ...overrides,
  };
}

describe('SqlSafetyDemo — the injection panel', () => {
  it('prefills the classic payload; FIRE urlencodes it and renders the zero-match proof', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: `${INJECTION_URL}?attempt=${encodeURIComponent(CLASSIC_PAYLOAD)}`, body: injectionBody() },
      ]);
      return vi.mocked(fetch);
    })();

    render(<SqlSafetyDemo />);

    expect((screen.getByTestId('sql-injection-attempt') as HTMLInputElement).value).toBe(CLASSIC_PAYLOAD);

    fireEvent.click(screen.getByTestId('sql-injection-fire'));

    const result = await screen.findByTestId('sql-injection-result');
    expect(result).toBeInTheDocument();
    expect(screen.getByTestId('sql-injection-count')).toHaveTextContent('0 rows matched');
    expect(screen.getByTestId('sql-injection-safe-query')).toHaveTextContent(
      'SELECT id, title, author FROM posts WHERE title = ?',
    );
    // The naive form is displayed — as inert text, clearly labelled.
    expect(screen.getByTestId('sql-injection-safe-query')).toHaveTextContent(
      `WHERE title = '' OR '1'='1'`,
    );
    expect(screen.getByTestId('sql-injection-verdict')).toHaveTextContent('compared as a literal title');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${INJECTION_URL}?attempt=${encodeURIComponent(CLASSIC_PAYLOAD)}`,
    );
  });

  it('an edited payload is sent verbatim (urlencoded) and echoed as the bound parameter', async () => {
    stubApiFetch([
      {
        url: `${INJECTION_URL}?attempt=${encodeURIComponent('x% DROP TABLE posts; --')}`,
        body: injectionBody({
          attempt: 'x% DROP TABLE posts; --',
          boundParameter: 'x% DROP TABLE posts; --',
        }),
      },
    ]);

    render(<SqlSafetyDemo />);

    fireEvent.change(screen.getByTestId('sql-injection-attempt'), {
      target: { value: 'x% DROP TABLE posts; --' },
    });
    fireEvent.click(screen.getByTestId('sql-injection-fire'));

    expect(await screen.findByTestId('sql-injection-result')).toBeInTheDocument();
    expect(screen.getByTestId('sql-injection-verdict')).toHaveTextContent('nothing matched');
  });

  it('shows matched row titles when the attempt happens to equal a real title', async () => {
    stubApiFetch([
      {
        url: `${INJECTION_URL}?attempt=${encodeURIComponent('Failures are values here')}`,
        body: injectionBody({
          attempt: 'Failures are values here',
          boundParameter: 'Failures are values here',
          matchedCount: 1,
          matchedRows: [{ id: '0f1c2b3a-0000-4000-8000-000000000003', title: 'Failures are values here' }],
          verdict: 'the attempt happened to equal a real title — still just a literal equality match',
        }),
      },
    ]);

    render(<SqlSafetyDemo />);

    fireEvent.change(screen.getByTestId('sql-injection-attempt'), {
      target: { value: 'Failures are values here' },
    });
    fireEvent.click(screen.getByTestId('sql-injection-fire'));

    expect(await screen.findByTestId('sql-injection-rows')).toHaveTextContent('Failures are values here');
    expect(screen.getByTestId('sql-injection-count')).toHaveTextContent('1 rows matched');
  });
});

describe('SqlSafetyDemo — the transaction panel', () => {
  it('TRANSFER commits both writes and shows the tag moving', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: TRANSFER_URL, body: transferBody() }]);
      return vi.mocked(fetch);
    })();

    render(<SqlSafetyDemo />);

    fireEvent.click(screen.getByTestId('sql-transaction-transfer'));

    expect(await screen.findByTestId('sql-transaction-result')).toBeInTheDocument();
    expect(screen.getByTestId('sql-transaction-verdict')).toHaveTextContent('transferred — both writes committed');
    expect(screen.getByTestId('sql-transaction-counts')).toHaveTextContent('before: post-alpha: 1 tag');
    expect(screen.getByTestId('sql-transaction-counts')).toHaveTextContent('after: post-alpha: 0 tags');
    expect(screen.getByTestId('sql-transaction-counts')).not.toHaveTextContent('rolled back together');
    expect(screen.getByTestId('sql-transaction-explain')).toHaveTextContent('committed together');

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('POST');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(TRANSFER_URL);
  });

  it('TRANSFER WITH CRASH rolls both writes back — identical counts, rolledBack verdict', async () => {
    stubApiFetch([
      {
        url: `${TRANSFER_URL}?crash=1`,
        body: transferBody({
          crash: true,
          transferred: false,
          rolledBack: true,
          after: { 'post-alpha': 1, 'post-beta': 0 }, // identical to before — atomicity
          explain:
            'the throw inside the transaction rolled back the DELETE too — before and after are identical, which is atomicity',
        }),
      },
    ]);

    render(<SqlSafetyDemo />);

    fireEvent.click(screen.getByTestId('sql-transaction-crash'));

    expect(await screen.findByTestId('sql-transaction-result')).toBeInTheDocument();
    expect(screen.getByTestId('sql-transaction-verdict')).toHaveTextContent('rolled back — atomicity kept');
    const counts = screen.getByTestId('sql-transaction-counts');
    expect(counts).toHaveTextContent('before: post-alpha: 1 tag');
    expect(counts).toHaveTextContent('after: post-alpha: 1 tag');
    expect(counts).toHaveTextContent('a throw between write 1 and write 2 — rolled back together');
    expect(screen.getByTestId('sql-transaction-explain')).toHaveTextContent('atomicity');
  });
});
