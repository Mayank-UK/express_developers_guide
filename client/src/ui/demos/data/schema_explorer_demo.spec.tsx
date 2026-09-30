import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SchemaExplorerDemo from './schema_explorer_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SCHEMA_URL = '/api/demo/db/schema';
const PLAN_URL = '/api/demo/db/plan';

const SCHEMA_BODY = {
  handle: ':memory:',
  foreignKeysEnforced: true,
  note: 'per-connection PRAGMA note',
  tables: [
    {
      name: 'posts',
      ddl: 'CREATE TABLE posts (\n    id TEXT PRIMARY KEY\n)',
      rowCount: 3,
      columns: [
        { name: 'id', type: 'TEXT', notNull: true, defaultValue: null, primaryKey: true },
        { name: 'title', type: 'TEXT', notNull: true, defaultValue: null, primaryKey: false },
      ],
      indexes: [{ name: 'sqlite_autoindex_posts_1', unique: true, origin: 'pk', columns: ['id'] }],
      foreignKeys: [],
    },
    {
      name: 'comments',
      ddl: 'CREATE TABLE comments (\n    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE\n)',
      rowCount: 3,
      columns: [
        { name: 'id', type: 'INTEGER', notNull: true, defaultValue: null, primaryKey: true },
        { name: 'post_id', type: 'TEXT', notNull: true, defaultValue: null, primaryKey: false },
        {
          name: 'created_at',
          type: 'TEXT',
          notNull: true,
          defaultValue: "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          primaryKey: false,
        },
      ],
      indexes: [{ name: 'idx_comments_post_id', unique: false, origin: 'c', columns: ['post_id'] }],
      foreignKeys: [
        {
          referencesTable: 'posts',
          column: 'post_id',
          referencesColumn: 'id',
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION',
        },
      ],
    },
  ],
};

describe('SchemaExplorerDemo — the schema panel', () => {
  it('renders both tables with columns, badges, indexes, and the FK with its ON DELETE policy', async () => {
    stubApiFetch([{ url: SCHEMA_URL, body: SCHEMA_BODY }]);

    render(<SchemaExplorerDemo />);

    const posts = await screen.findByTestId('schema-explorer-table-posts');
    expect(posts).toHaveTextContent('posts');
    expect(posts).toHaveTextContent('3 rows');
    expect(posts).toHaveTextContent('sqlite_autoindex_posts_1');
    expect(posts).toHaveTextContent('PRIMARY KEY');

    const comments = screen.getByTestId('schema-explorer-table-comments');
    expect(comments).toHaveTextContent('idx_comments_post_id');
    expect(comments).toHaveTextContent('CREATE INDEX');
    expect(comments).toHaveTextContent("(post_id)");
    expect(comments).toHaveTextContent("DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))");

    const fk = screen.getByTestId('schema-explorer-fk-comments');
    expect(fk).toHaveTextContent('post_id');
    expect(fk).toHaveTextContent('posts.id');
    expect(fk).toHaveTextContent('ON DELETE CASCADE');
  });

  it('reports the handle and the per-connection FK PRAGMA state', async () => {
    stubApiFetch([{ url: SCHEMA_URL, body: SCHEMA_BODY }]);

    render(<SchemaExplorerDemo />);

    expect(await screen.findByTestId('schema-explorer-handle')).toHaveTextContent(':memory:');
    expect(screen.getByTestId('schema-explorer-fk-pragma')).toHaveTextContent('PRAGMA foreign_keys: ON');
  });

  it('shows a table DDL verbatim via the toggle', async () => {
    stubApiFetch([{ url: SCHEMA_URL, body: SCHEMA_BODY }]);

    render(<SchemaExplorerDemo />);
    await screen.findByTestId('schema-explorer-table-comments');

    expect(screen.queryByTestId('schema-explorer-ddl-comments')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('schema-explorer-ddl-toggle-comments'));
    const ddl = screen.getByTestId('schema-explorer-ddl-comments');
    expect(ddl).toHaveTextContent('CREATE TABLE comments');
    expect(ddl).toHaveTextContent('REFERENCES posts(id) ON DELETE CASCADE');
  });

  it('degrades to a failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<SchemaExplorerDemo />);

    const failed = await screen.findByTestId('schema-explorer-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});

describe('SchemaExplorerDemo — the EXPLAIN QUERY PLAN panel', () => {
  it('the indexed preset renders a SEARCH · USING INDEX verdict with the steps', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: SCHEMA_URL, body: SCHEMA_BODY },
        {
          url: `${PLAN_URL}?preset=indexed`,
          body: {
            source: 'preset',
            sql: "SELECT id, body FROM comments WHERE post_id = 'p1'",
            steps: ['SEARCH comments USING INDEX idx_comments_post_id (post_id=?)'],
            usedIndex: true,
            verb: 'SEARCH',
          },
        },
      ]);
      return vi.mocked(fetch);
    })();

    render(<SchemaExplorerDemo />);
    await screen.findByTestId('schema-explorer-table-posts');

    fireEvent.click(screen.getByTestId('schema-plan-preset-indexed'));

    const result = await screen.findByTestId('schema-plan-result');
    expect(result).toHaveTextContent('indexed lookup');
    expect(screen.getByTestId('schema-plan-verdict')).toHaveTextContent('SEARCH · USING INDEX');
    expect(screen.getByTestId('schema-plan-steps')).toHaveTextContent(
      'SEARCH comments USING INDEX idx_comments_post_id',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the full-scan preset renders SCAN · NO INDEX', async () => {
    stubApiFetch([
      { url: SCHEMA_URL, body: SCHEMA_BODY },
      {
        url: `${PLAN_URL}?preset=scan`,
        body: {
          source: 'preset',
          sql: "SELECT id, body FROM comments WHERE body LIKE '%dependency%'",
          steps: ['SCAN comments'],
          usedIndex: false,
          verb: 'SCAN',
        },
      },
    ]);

    render(<SchemaExplorerDemo />);
    await screen.findByTestId('schema-explorer-table-posts');

    fireEvent.click(screen.getByTestId('schema-plan-preset-scan'));

    expect(await screen.findByTestId('schema-plan-verdict')).toHaveTextContent('SCAN · NO INDEX');
    expect(screen.getByTestId('schema-plan-steps')).toHaveTextContent('SCAN comments');
  });

  it('a custom SELECT is urlencoded and sent as ?sql=', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: SCHEMA_URL, body: SCHEMA_BODY },
        {
          url: `${PLAN_URL}?sql=${encodeURIComponent("SELECT id FROM posts WHERE author = 'the guide'")}`,
          body: {
            source: 'custom',
            sql: "SELECT id FROM posts WHERE author = 'the guide'",
            steps: ['SEARCH posts USING INDEX sqlite_autoindex_posts_1'],
            usedIndex: true,
            verb: 'SEARCH',
          },
        },
      ]);
      return vi.mocked(fetch);
    })();

    render(<SchemaExplorerDemo />);
    await screen.findByTestId('schema-explorer-table-posts');

    fireEvent.click(screen.getByTestId('schema-plan-run-custom'));

    expect(await screen.findByTestId('schema-plan-verdict')).toHaveTextContent('SEARCH');
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${PLAN_URL}?sql=${encodeURIComponent("SELECT id FROM posts WHERE author = 'the guide'")}`,
    );
  });

  it('renders the failure panel for a rejected query (400 envelope)', async () => {
    stubApiFetch([
      { url: SCHEMA_URL, body: SCHEMA_BODY },
      {
        url: `${PLAN_URL}?sql=${encodeURIComponent('DELETE FROM posts')}`,
        status: 400,
        body: { error: { code: 'validation_failed', message: 'SELECT statements only' } },
      },
    ]);

    render(<SchemaExplorerDemo />);
    await screen.findByTestId('schema-explorer-table-posts');

    fireEvent.change(screen.getByTestId('schema-plan-custom-sql'), {
      target: { value: 'DELETE FROM posts' },
    });
    fireEvent.click(screen.getByTestId('schema-plan-run-custom'));

    const failed = await screen.findByTestId('schema-plan-failed');
    expect(failed).toHaveTextContent('400');
    expect(failed).toHaveTextContent('validation_failed');
  });
});
