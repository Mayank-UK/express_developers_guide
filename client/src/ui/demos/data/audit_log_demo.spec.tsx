import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AuditLogDemo from './audit_log_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const AUDIT_URL = '/api/demo/db/audit/post';

const POST_ROW = (title: string, updatedAt: string) => ({
  id: '0f1c2b3a-0000-4000-8000-000000000001',
  title,
  body: 'The original body of the seeded post.',
  author: 'the guide',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: updatedAt,
});

function auditRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    entity: 'post',
    entityId: '0f1c2b3a-0000-4000-8000-000000000001',
    action: 'update',
    changedBy: 'demo reviewer',
    oldValues: { title: 'Failures are values here', body: 'The original body of the seeded post.' },
    newValues: { title: 'A quieter title', body: 'The original body of the seeded post.' },
    createdAt: '2026-09-29T12:00:00.000Z',
    ...overrides,
  };
}

function patchBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    handle: ':memory:',
    postId: '0f1c2b3a-0000-4000-8000-000000000001',
    changedBy: 'demo reviewer',
    crash: false,
    updated: true,
    rolledBack: false,
    before: POST_ROW('Failures are values here', '2026-01-01T00:00:00.000Z'),
    after: POST_ROW('A quieter title', '2026-09-29T12:00:00.000Z'),
    auditRowCount: 1,
    auditRows: [auditRow()],
    note: 'the posts UPDATE and the audit_log INSERT ran inside ONE transaction — a trail row exists if and only if its change committed.',
    ...overrides,
  };
}

function trailBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    handle: ':memory:',
    postId: '0f1c2b3a-0000-4000-8000-000000000001',
    sql: 'SELECT id, entity, entity_id, action, changed_by, old_values, new_values, created_at\nFROM audit_log\nWHERE entity = ? AND entity_id = ?\nORDER BY id',
    rows: [
      auditRow({
        id: 1,
        changedBy: 'the editor',
        newValues: { title: 'Failures are values here (2nd edition)', body: 'The original body of the seeded post.' },
      }),
      auditRow({
        id: 2,
        changedBy: 'the author',
        oldValues: { title: 'Failures are values here (2nd edition)', body: 'The original body of the seeded post.' },
        newValues: { title: 'Failures are values here (2nd edition)', body: 'The original body of the seeded post. Updated for clarity.' },
      }),
    ],
    note: 'oldest first (ORDER BY id), read through idx_audit_entity — each entry pairs old_values/new_values JSON snapshots.',
    ...overrides,
  };
}

describe('AuditLogDemo — the audited update', () => {
  it('PATCHes the JSON body and renders the committed verdict with the trail row', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: AUDIT_URL, method: 'PATCH', body: patchBody() }]);
      return vi.mocked(fetch);
    })();

    render(<AuditLogDemo />);

    fireEvent.click(screen.getByTestId('audit-log-update'));

    expect(await screen.findByTestId('audit-log-result')).toBeInTheDocument();
    expect(screen.getByTestId('audit-log-verdict')).toHaveTextContent('committed — trail row written');
    expect(screen.getByTestId('audit-log-row-count')).toHaveTextContent('audit rows: 1');
    expect(screen.getByTestId('audit-log-titles')).toHaveTextContent(
      'Failures are values here → A quieter title',
    );
    const rows = screen.getAllByTestId('audit-log-rows-row');
    expect(rows[0]).toHaveTextContent('demo reviewer');
    expect(rows[0]).toHaveTextContent('Failures are values here → A quieter title');
    expect(screen.getByTestId('audit-log-note')).toHaveTextContent('if and only if');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(AUDIT_URL);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'A quieter title', changedBy: 'demo reviewer' });
  });

  it('the crash variant hits ?crash=1 and shows the rollback — unchanged title, no partial row', async () => {
    stubApiFetch([
      {
        url: `${AUDIT_URL}?crash=1`,
        method: 'PATCH',
        body: patchBody({
          crash: true,
          updated: false,
          rolledBack: true,
          before: POST_ROW('Failures are values here', '2026-01-01T00:00:00.000Z'),
          after: POST_ROW('Failures are values here', '2026-01-01T00:00:00.000Z'),
          auditRowCount: 0,
          auditRows: [],
          note: 'the simulated crash hit BETWEEN the post UPDATE and the audit INSERT; the transaction rolled back both.',
        }),
      },
    ]);

    render(<AuditLogDemo />);

    fireEvent.click(screen.getByTestId('audit-log-crash'));

    expect(await screen.findByTestId('audit-log-verdict')).toHaveTextContent(
      'rolled back — post unchanged, no partial audit row',
    );
    expect(screen.getByTestId('audit-log-titles')).toHaveTextContent(
      'Failures are values here → Failures are values here (unchanged — the crash rolled it back)',
    );
    expect(screen.queryByTestId('audit-log-rows-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('audit-log-note')).toHaveTextContent('rolled back both');
  });

  it('an edited title and author travel in the PATCH body', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        {
          url: AUDIT_URL,
          method: 'PATCH',
          body: patchBody({ changedBy: 'the reviewer of record' }),
        },
      ]);
      return vi.mocked(fetch);
    })();

    render(<AuditLogDemo />);

    fireEvent.change(screen.getByTestId('audit-log-title'), { target: { value: 'A louder title' } });
    fireEvent.change(screen.getByTestId('audit-log-changed-by'), { target: { value: 'the reviewer of record' } });
    fireEvent.click(screen.getByTestId('audit-log-update'));

    expect(await screen.findByTestId('audit-log-result')).toBeInTheDocument();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'A louder title', changedBy: 'the reviewer of record' });
  });
});

describe('AuditLogDemo — the trail read', () => {
  it('GETs the scripted trail and renders both audited entries oldest first', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: AUDIT_URL, method: 'GET', body: trailBody() }]);
      return vi.mocked(fetch);
    })();

    render(<AuditLogDemo />);

    fireEvent.click(screen.getByTestId('audit-log-load-trail'));

    expect(await screen.findByTestId('audit-log-trail-result')).toBeInTheDocument();
    expect(screen.getByTestId('audit-log-trail-sql')).toHaveTextContent('ORDER BY id');
    const rows = screen.getAllByTestId('audit-log-trail-rows-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('the editor');
    expect(rows[0]).toHaveTextContent('Failures are values here → Failures are values here (2nd edition)');
    expect(rows[1]).toHaveTextContent('the author');
    expect(rows[1]).toHaveTextContent('Updated for clarity');
    expect(screen.getByTestId('audit-log-trail-note')).toHaveTextContent('oldest first');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(AUDIT_URL);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBeUndefined();
  });

  it('degrades to a failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<AuditLogDemo />);

    fireEvent.click(screen.getByTestId('audit-log-update'));

    const failed = await screen.findByTestId('audit-log-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});
