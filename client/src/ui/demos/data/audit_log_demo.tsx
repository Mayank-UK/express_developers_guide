import { useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:audit` — the transactional audit trail: PATCH a post
 * (title + who changed it) and watch the posts UPDATE and the audit_log INSERT
 * commit together — or fire the crash variant, which throws BETWEEN the two
 * writes and rolls both back, leaving the post unchanged and no partial audit
 * row. The read panel replays two scripted audited updates and walks the
 * indexed trail, old_values → new_values per entry.
 */

const AUDIT_URL = '/api/demo/db/audit/post';

const DEFAULT_TITLE = 'A quieter title';
const DEFAULT_CHANGED_BY = 'demo reviewer';

interface AuditEntry {
  id: number;
  changedBy: string;
  action: string;
  oldTitle: string;
  newTitle: string;
  oldBody: string;
  newBody: string;
  createdAt: string;
}

interface AuditPatchOutcome {
  postId: string;
  changedBy: string;
  updated: boolean;
  beforeTitle: string;
  afterTitle: string;
  auditRowCount: number;
  auditRows: AuditEntry[];
  note: string;
}

interface AuditTrailOutcome {
  postId: string;
  sql: string;
  rows: AuditEntry[];
  note: string;
}

type PatchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: AuditPatchOutcome }
  | { kind: 'failed'; problem: string };

type TrailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: AuditTrailOutcome }
  | { kind: 'failed'; problem: string };

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_DANGER =
  'w-fit rounded-md border border-outline bg-error px-sm py-xs text-body-sm font-semibold text-on-error hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const CELL = 'border-b border-outline px-xs py-xs';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** One audit_log row, defensively shaped from the endpoint's contract. */
function parseAuditEntry(value: unknown): AuditEntry {
  const row = isRecord(value) ? value : {};
  const oldValues = isRecord(row.oldValues) ? row.oldValues : {};
  const newValues = isRecord(row.newValues) ? row.newValues : {};
  return {
    id: asNumber(row.id),
    changedBy: asString(row.changedBy),
    action: asString(row.action),
    oldTitle: asString(oldValues.title, ''),
    newTitle: asString(newValues.title, ''),
    oldBody: asString(oldValues.body, ''),
    newBody: asString(newValues.body, ''),
    createdAt: asString(row.createdAt),
  };
}

function parsePatch(value: unknown): AuditPatchOutcome | null {
  if (!isRecord(value)) return null;
  const before = isRecord(value.before) ? value.before : {};
  const after = isRecord(value.after) ? value.after : {};
  if (typeof value.updated !== 'boolean' || !Array.isArray(value.auditRows)) return null;
  return {
    postId: asString(value.postId),
    changedBy: asString(value.changedBy),
    updated: value.updated,
    beforeTitle: asString(before.title, ''),
    afterTitle: asString(after.title, ''),
    auditRowCount: asNumber(value.auditRowCount),
    auditRows: value.auditRows.map((row) => parseAuditEntry(row)),
    note: asString(value.note, ''),
  };
}

function parseTrail(value: unknown): AuditTrailOutcome | null {
  if (!isRecord(value)) return null;
  if (typeof value.sql !== 'string' || !Array.isArray(value.rows)) return null;
  return {
    postId: asString(value.postId),
    sql: value.sql,
    rows: value.rows.map((row) => parseAuditEntry(row)),
    note: asString(value.note, ''),
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') return response.text();
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

/** The trail table shared by both panels — old → new per changed column. */
function AuditTrailTable({ testId, rows }: { testId: string; rows: AuditEntry[] }): ReactNode {
  return (
    <table data-testid={testId} className="w-full border-collapse text-body-sm">
      <thead>
        <tr>
          {['id', 'changed_by', 'action', 'title: old → new', 'body: old → new', 'created_at'].map(
            (column) => (
              <th
                key={column}
                className={`${CELL} font-mono text-caption font-semibold text-on-surface-variant`}
              >
                {column}
              </th>
            ),
          )}
        </tr>
      </thead>
      <tbody className="text-on-surface">
        {rows.map((row) => (
          <tr key={row.id} data-testid={`${testId}-row`}>
            <td className={`${CELL} font-mono align-top`}>#{String(row.id)}</td>
            <td className={`${CELL} font-mono align-top`}>{row.changedBy}</td>
            <td className={`${CELL} font-mono align-top`}>{row.action}</td>
            <td className={`${CELL} font-mono align-top break-all`}>
              {row.oldTitle} → {row.newTitle}
            </td>
            <td className={`${CELL} font-mono align-top break-all`}>
              {row.oldBody} → {row.newBody}
            </td>
            <td className={`${CELL} font-mono align-top`}>{row.createdAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AuditLogDemo(): ReactNode {
  const [title, setTitle] = useState<string>(DEFAULT_TITLE);
  const [changedBy, setChangedBy] = useState<string>(DEFAULT_CHANGED_BY);
  const [patchState, setPatchState] = useState<PatchState>({ kind: 'idle' });
  const [trailState, setTrailState] = useState<TrailState>({ kind: 'idle' });

  const runPatch = (crash: boolean): void => {
    setPatchState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(crash ? `${AUDIT_URL}?crash=1` : AUDIT_URL, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: title.trim(), changedBy: changedBy.trim() }),
        });
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parsePatch(parsed.value) : null;
        if (shaped === null) {
          setPatchState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not an audit outcome:\n${text}`,
          });
          return;
        }
        setPatchState({ kind: 'answered', outcome: shaped });
      } catch {
        setPatchState({
          kind: 'failed',
          problem: 'could not reach the server — is the guide running on :4000?',
        });
      }
    })();
  };

  const loadTrail = (): void => {
    setTrailState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(AUDIT_URL);
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseTrail(parsed.value) : null;
        if (shaped === null) {
          setTrailState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not an audit trail:\n${text}`,
          });
          return;
        }
        setTrailState({ kind: 'answered', outcome: shaped });
      } catch {
        setTrailState({
          kind: 'failed',
          problem: 'could not reach the server — is the guide running on :4000?',
        });
      }
    })();
  };

  const patch = patchState.kind === 'answered' ? patchState.outcome : null;
  const trail = trailState.kind === 'answered' ? trailState.outcome : null;

  return (
    <div className="flex flex-col gap-md">
      {/* ---- the audited update ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          one transaction: post update + audit row
        </h3>
        <p data-testid="audit-log-summary" className="text-body-sm text-on-surface-variant">
          PATCH the seeded post with a new title. The posts UPDATE and the audit_log INSERT run
          inside ONE better-sqlite3 transaction — a trail row exists if and only if its change
          committed. The crash variant throws BETWEEN the writes; both must roll back.
        </p>

        <div className="flex flex-col gap-xs sm:flex-row">
          <label className="flex flex-1 flex-col gap-xxs">
            <span className={LABEL}>new title</span>
            <input
              data-testid="audit-log-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              spellCheck={false}
              className={INPUT}
            />
          </label>
          <label className="flex flex-1 flex-col gap-xxs">
            <span className={LABEL}>changed by</span>
            <input
              data-testid="audit-log-changed-by"
              value={changedBy}
              onChange={(event) => setChangedBy(event.target.value)}
              spellCheck={false}
              className={INPUT}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="audit-log-update"
            onClick={() => runPatch(false)}
            disabled={patchState.kind === 'loading' || title.trim().length === 0 || changedBy.trim().length === 0}
            className={BUTTON_PRIMARY}
          >
            update + audit
          </button>
          <button
            type="button"
            data-testid="audit-log-crash"
            onClick={() => runPatch(true)}
            disabled={patchState.kind === 'loading' || title.trim().length === 0 || changedBy.trim().length === 0}
            className={BUTTON_DANGER}
          >
            crash between the writes
          </button>
        </div>

        {patchState.kind === 'failed' && (
          <pre data-testid="audit-log-failed" className={PRE}>
            {patchState.problem}
          </pre>
        )}

        {patch !== null && (
          <div data-testid="audit-log-result" className="flex flex-col gap-xs">
            <div className="flex flex-wrap items-center gap-sm">
              <span data-testid="audit-log-verdict" className={patch.updated ? CHIP_OK : CHIP_ERROR}>
                {patch.updated
                  ? 'committed — trail row written'
                  : 'rolled back — post unchanged, no partial audit row'}
              </span>
              <span className={CHIP}>post: {patch.postId}</span>
              <span className={CHIP}>changed by: {patch.changedBy}</span>
              <span data-testid="audit-log-row-count" className={CHIP}>
                audit rows: {String(patch.auditRowCount)}
              </span>
            </div>
            <p data-testid="audit-log-titles" className="font-mono text-caption text-on-surface">
              title: {patch.beforeTitle} → {patch.afterTitle}
              {!patch.updated && ' (unchanged — the crash rolled it back)'}
            </p>
            {patch.auditRows.length > 0 && (
              <AuditTrailTable testId="audit-log-rows" rows={patch.auditRows} />
            )}
            <p data-testid="audit-log-note" className="text-body-sm text-on-surface">
              {patch.note}
            </p>
          </div>
        )}
      </section>

      {/* ---- the trail read ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">read the trail</h3>
        <p className="text-body-sm text-on-surface-variant">
          A fresh handle, two scripted audited updates (a title change by the editor, a body change
          by the author), then the indexed trail read — oldest first, old_values/new_values paired.
        </p>

        <button
          type="button"
          data-testid="audit-log-load-trail"
          onClick={loadTrail}
          disabled={trailState.kind === 'loading'}
          className={BUTTON_PRIMARY}
        >
          {trailState.kind === 'loading' ? 'reading…' : 'run the scripted updates + read the trail'}
        </button>

        {trailState.kind === 'failed' && (
          <pre data-testid="audit-log-trail-failed" className={PRE}>
            {trailState.problem}
          </pre>
        )}

        {trail !== null && (
          <div data-testid="audit-log-trail-result" className="flex flex-col gap-xs">
            <div className="flex flex-wrap items-center gap-sm">
              <span className={CHIP}>post: {trail.postId}</span>
              <span className={CHIP}>{String(trail.rows.length)} audit rows, oldest first</span>
            </div>
            <pre data-testid="audit-log-trail-sql" className={PRE}>
              {trail.sql}
            </pre>
            <AuditTrailTable testId="audit-log-trail-rows" rows={trail.rows} />
            <p data-testid="audit-log-trail-note" className="text-body-sm text-on-surface">
              {trail.note}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
