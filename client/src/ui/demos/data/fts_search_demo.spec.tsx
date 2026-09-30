import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import FtsSearchDemo from './fts_search_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SEARCH_URL = '/api/demo/db/search';

const FTS_SQL = `SELECT
  p.id,
  p.title,
  snippet(posts_fts, 1, '[', ']', '…', 8) AS excerpt,
  rank
FROM posts_fts
JOIN posts p ON p.rowid = posts_fts.rowid
WHERE posts_fts MATCH ?
ORDER BY rank`;

const LIKE_SQL = `SELECT id, title
FROM posts
WHERE title LIKE '%' || ? || '%' OR body LIKE '%' || ? || '%'`;

function searchBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    query: 'database',
    fts: {
      sql: FTS_SQL,
      rows: [
        {
          id: 'post-fts-2',
          title: 'Migrations for every database',
          excerpt: 'a [database] migration is schema-as-code…',
          rank: -2.5,
        },
        {
          id: 'post-fts-1',
          title: 'Indexes are the database',
          excerpt: '…the [database] planner walks the index…',
          rank: -1.234,
        },
      ],
      planSteps: ['SEARCH posts USING VIRTUAL TABLE INDEX idx_fts_posts_fts(MATCH=?)'],
      verb: 'SEARCH',
      usedIndex: true,
    },
    like: {
      sql: LIKE_SQL,
      rows: [{ id: 'post-fts-1', title: 'Indexes are the database' }],
      planSteps: ['SCAN posts'],
      verb: 'SCAN',
      usedIndex: false,
    },
    verdict: 'FTS5 walks its inverted index and returns bm25-ranked rows; LIKE scans posts.',
    ...overrides,
  };
}

describe('FtsSearchDemo', () => {
  it('fires the urlencoded term and renders both engines side by side with their plans', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: `${SEARCH_URL}?q=database`, body: searchBody() }]);
      return vi.mocked(fetch);
    })();

    render(<FtsSearchDemo />);

    fireEvent.click(screen.getByTestId('fts-search-fire'));

    const ftsSide = await screen.findByTestId('fts-search-fts-side');
    expect(ftsSide).toHaveTextContent('bm25-ranked');
    expect(screen.getAllByTestId('fts-search-fts-row')).toHaveLength(2);
    expect(screen.getAllByTestId('fts-search-fts-row')[0]).toHaveTextContent('Migrations for every database');
    expect(screen.getAllByTestId('fts-search-fts-row')[1]).toHaveTextContent('Indexes are the database');
    // bm25 ordering is the server's ORDER BY rank — the more negative score first here.
    expect(screen.getAllByTestId('fts-search-fts-row')[0]).toHaveTextContent('-2.500');
    expect(screen.getAllByTestId('fts-search-fts-excerpt')[0]).toHaveTextContent('[database]');
    expect(screen.getByTestId('fts-search-fts-plan')).toHaveTextContent('SEARCH · USING INDEX');
    expect(screen.getByTestId('fts-search-fts-sql')).toHaveTextContent('posts_fts MATCH ?');
    expect(screen.getByTestId('fts-search-fts-sql')).toHaveTextContent('SEARCH posts USING VIRTUAL TABLE INDEX');

    const likeSide = screen.getByTestId('fts-search-like-side');
    expect(likeSide).toHaveTextContent("LIKE '%…%'");
    expect(screen.getAllByTestId('fts-search-like-row')).toHaveLength(1);
    expect(screen.getByTestId('fts-search-like-plan')).toHaveTextContent('SCAN · NO INDEX');
    expect(screen.getByTestId('fts-search-like-sql')).toHaveTextContent("title LIKE '%' || ? || '%'");

    expect(screen.getByTestId('fts-search-verdict')).toHaveTextContent('bm25-ranked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${SEARCH_URL}?q=database`);
  });

  it('an edited term is sent urlencoded verbatim', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        {
          url: `${SEARCH_URL}?q=${encodeURIComponent('"full phrase" OR sqlite')}`,
          body: searchBody({ query: '"full phrase" OR sqlite' }),
        },
      ]);
      return vi.mocked(fetch);
    })();

    render(<FtsSearchDemo />);

    fireEvent.change(screen.getByTestId('fts-search-term'), {
      target: { value: '"full phrase" OR sqlite' },
    });
    fireEvent.click(screen.getByTestId('fts-search-fire'));

    expect(await screen.findByTestId('fts-search-fts-side')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`${SEARCH_URL}?q=${encodeURIComponent('"full phrase" OR sqlite')}`);
  });

  it('zero matches on both sides renders the empty states, not a gap', async () => {
    stubApiFetch([
      {
        url: `${SEARCH_URL}?q=${encodeURIComponent('zzzznotaword')}`,
        body: searchBody({
          query: 'zzzznotaword',
          fts: { sql: FTS_SQL, rows: [], planSteps: ['SEARCH posts USING VIRTUAL TABLE INDEX idx_fts_posts_fts(MATCH=?)'], verb: 'SEARCH', usedIndex: true },
          like: { sql: LIKE_SQL, rows: [], planSteps: ['SCAN posts'], verb: 'SCAN', usedIndex: false },
        }),
      },
    ]);

    render(<FtsSearchDemo />);

    fireEvent.change(screen.getByTestId('fts-search-term'), { target: { value: 'zzzznotaword' } });
    fireEvent.click(screen.getByTestId('fts-search-fire'));

    expect(await screen.findByTestId('fts-search-fts-empty')).toHaveTextContent('no matches');
    expect(screen.getByTestId('fts-search-like-empty')).toHaveTextContent('read every row');
  });

  it('renders the failure panel for an invalid FTS5 query (400 envelope)', async () => {
    stubApiFetch([
      {
        url: `${SEARCH_URL}?q=${encodeURIComponent("'")}`,
        status: 400,
        body: { error: { code: 'validation_failed', message: '"q" is not a valid FTS5 query' } },
      },
    ]);

    render(<FtsSearchDemo />);

    fireEvent.change(screen.getByTestId('fts-search-term'), { target: { value: "'" } });
    fireEvent.click(screen.getByTestId('fts-search-fire'));

    const failed = await screen.findByTestId('fts-search-failed');
    expect(failed).toHaveTextContent('400');
    expect(failed).toHaveTextContent('validation_failed');
  });

  it('degrades to a failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<FtsSearchDemo />);

    fireEvent.click(screen.getByTestId('fts-search-fire'));

    const failed = await screen.findByTestId('fts-search-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});
