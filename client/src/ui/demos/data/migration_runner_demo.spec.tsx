import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MigrationRunnerDemo from './migration_runner_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const MIGRATIONS_URL = '/api/demo/db/migrations';
const APPLY_URL = '/api/demo/db/migrations/apply';

const FILES = ['0001_create_tags_tables.sql', '0002_add_indexes.sql'] as const;

const PENDING_BODY = {
  handle: ':memory:',
  applied: [],
  pending: [...FILES],
  files: [...FILES],
  note: 'fresh handle before the runner runs',
};

const APPLY_BODY = {
  handle: ':memory:',
  applied: [...FILES],
  pending: [],
  files: [...FILES],
  before: { applied: [], pending: [...FILES], files: [...FILES] },
  appliedThisRun: [...FILES],
  after: { applied: [...FILES], pending: [], files: [...FILES] },
  secondRunApplied: [],
  tables: ['demo_posts', 'posts_tags', 'schema_migrations', 'tags'],
  indexes: ['idx_posts_tags_tag_id', 'idx_tags_name'],
  note: 'each file applied inside one transaction',
};

describe('MigrationRunnerDemo — the fresh handle', () => {
  it('loads with every file pending and nothing applied', async () => {
    stubApiFetch([{ url: MIGRATIONS_URL, body: PENDING_BODY }]);

    render(<MigrationRunnerDemo />);

    const section = await screen.findByTestId('migration-runner-summary');
    expect(section).toBeInTheDocument();

    const pendingPanel = screen.getByText('pending (applied to no database yet)').parentElement;
    expect(pendingPanel).toHaveTextContent('0001_create_tags_tables.sql');
    expect(pendingPanel).toHaveTextContent('0002_add_indexes.sql');

    expect(screen.getByTestId('migration-runner-applied-before')).toHaveTextContent(
      '[] — a brand-new database',
    );
  });

  it('degrades to a failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<MigrationRunnerDemo />);

    const failed = await screen.findByTestId('migration-runner-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});

describe('MigrationRunnerDemo — APPLY', () => {
  it('posts, then renders order, idempotency, and the created schema', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: MIGRATIONS_URL, body: PENDING_BODY },
        { url: APPLY_URL, body: APPLY_BODY },
      ]);
      return vi.mocked(fetch);
    })();

    render(<MigrationRunnerDemo />);
    await screen.findByTestId('migration-runner-applied-before');

    fireEvent.click(screen.getByTestId('migration-runner-apply'));

    const result = await screen.findByTestId('migration-runner-result');
    expect(result).toHaveTextContent('0001_create_tags_tables.sql');
    expect(result).toHaveTextContent('0002_add_indexes.sql');

    expect(screen.getByTestId('migration-runner-applied-count')).toHaveTextContent('2 applied this run');
    expect(screen.getByTestId('migration-runner-second-run')).toHaveTextContent(
      'second run applied: 0 — idempotent',
    );
    expect(screen.getByTestId('migration-runner-tables')).toHaveTextContent(
      'demo_posts, posts_tags, schema_migrations, tags',
    );
    expect(screen.getByTestId('migration-runner-indexes')).toHaveTextContent(
      'idx_posts_tags_tag_id, idx_tags_name',
    );
    expect(screen.getByTestId('migration-runner-pending-after')).toHaveTextContent(
      '[] — the database is at head',
    );

    // APPLY was a POST against the apply endpoint (the first call was the GET).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(APPLY_URL);
  });

  it('renders the failure panel when apply is rejected', async () => {
    stubApiFetch([
      { url: MIGRATIONS_URL, body: PENDING_BODY },
      {
        url: APPLY_URL,
        status: 500,
        body: { error: { code: 'internal_error', message: 'boom' } },
      },
    ]);

    render(<MigrationRunnerDemo />);
    await screen.findByTestId('migration-runner-applied-before');

    fireEvent.click(screen.getByTestId('migration-runner-apply'));

    const failed = await screen.findByTestId('migration-runner-apply-failed');
    expect(failed).toHaveTextContent('500');
    expect(failed).toHaveTextContent('internal_error');
  });
});
