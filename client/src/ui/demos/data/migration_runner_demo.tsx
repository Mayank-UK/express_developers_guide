import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:migrations` — the sql-node topic's live view of the
 * REAL migration runner (server/src/data/migrations). A fresh demo handle
 * loads with every .sql file pending; APPLY runs them in order and the
 * response shows before/after plus the idempotency proof (a second run that
 * applies nothing) and the tables/indexes the DDL really created.
 */

const MIGRATIONS_URL = '/api/demo/db/migrations';
const APPLY_URL = '/api/demo/db/migrations/apply';

interface MigrationState {
  applied: string[];
  pending: string[];
  files: string[];
}

interface ApplyOutcome extends MigrationState {
  appliedThisRun: string[];
  secondRunApplied: string[];
  tables: string[];
  indexes: string[];
}

type PendingState =
  | { kind: 'loading' }
  | { kind: 'ready'; state: MigrationState }
  | { kind: 'failed'; problem: string };

type ApplyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: ApplyOutcome }
  | { kind: 'failed'; problem: string };

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_PENDING =
  'rounded-md border border-outline bg-secondary px-xs py-xxs font-mono text-caption font-semibold text-on-secondary';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : [];
}

function parseMigrationState(value: unknown): MigrationState | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const applied = parseStringArray(record.applied);
  const pending = parseStringArray(record.pending);
  const files = parseStringArray(record.files);
  if (applied === null || pending === null || files === null) return null;
  return { applied, pending, files };
}

function parseApplyOutcome(value: unknown): ApplyOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const base = parseMigrationState(value);
  if (base === null) return null;
  const record = value as Record<string, unknown>;
  const appliedThisRun = parseStringArray(record.appliedThisRun);
  const secondRunApplied = parseStringArray(record.secondRunApplied);
  const tables = parseStringArray(record.tables);
  const indexes = parseStringArray(record.indexes);
  if (appliedThisRun === null || secondRunApplied === null || tables === null || indexes === null) {
    return null;
  }
  return { ...base, appliedThisRun, secondRunApplied, tables, indexes };
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

function FileList({ title, files, badge }: { title: string; files: readonly string[]; badge: ReactNode }): ReactNode {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-xxs">
      <p className="text-caption font-semibold text-on-surface-variant">{title}</p>
      {files.map((file) => (
        <p key={file} className="flex flex-wrap items-center gap-xs font-mono text-caption">
          <span className="text-on-surface">{file}</span>
          {badge}
        </p>
      ))}
    </div>
  );
}

export default function MigrationRunnerDemo(): ReactNode {
  const [pendingState, setPendingState] = useState<PendingState>({ kind: 'loading' });
  const [applyState, setApplyState] = useState<ApplyState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(MIGRATIONS_URL);
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseMigrationState(parsed.value) : null;
        if (shaped === null) {
          setPendingState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a migration state:\n${text}`,
          });
          return;
        }
        setPendingState({ kind: 'ready', state: shaped });
      } catch {
        if (aliveRef.current) {
          setPendingState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  }, []);

  const apply = (): void => {
    setApplyState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(APPLY_URL, { method: 'POST' });
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseApplyOutcome(parsed.value) : null;
        if (shaped === null) {
          setApplyState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not an apply outcome:\n${text}`,
          });
          return;
        }
        setApplyState({ kind: 'answered', outcome: shaped });
      } catch {
        if (aliveRef.current) {
          setApplyState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const outcome = applyState.kind === 'answered' ? applyState.outcome : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="migration-runner-summary" className="text-body-sm text-on-surface">
        The real runner (<span className="font-mono">server/src/data/migrations</span>) on a fresh in-memory
        handle: both numbered .sql files start PENDING, APPLY runs them in name order (each inside its own
        transaction), and a second run applies NOTHING — the idempotency that lets boot call the runner
        unconditionally.
      </p>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">a fresh handle, before the runner</h3>
        {pendingState.kind === 'loading' && (
          <p data-testid="migration-runner-loading" className="text-body-sm text-on-surface-variant">
            reading the migration state…
          </p>
        )}
        {pendingState.kind === 'failed' && (
          <pre data-testid="migration-runner-failed" className={PRE}>
            {pendingState.problem}
          </pre>
        )}
        {pendingState.kind === 'ready' && (
          <>
            <FileList
              title="pending (applied to no database yet)"
              files={pendingState.state.pending}
              badge={<span className={CHIP_PENDING}>PENDING</span>}
            />
            <p data-testid="migration-runner-applied-before" className="font-mono text-caption text-on-surface-variant">
              applied: {pendingState.state.applied.length === 0 ? '[] — a brand-new database' : pendingState.state.applied.join(', ')}
            </p>
          </>
        )}
        <button
          type="button"
          data-testid="migration-runner-apply"
          onClick={apply}
          disabled={applyState.kind === 'loading'}
          className={BUTTON_PRIMARY}
        >
          {applyState.kind === 'loading' ? 'applying…' : 'apply pending migrations'}
        </button>
      </div>

      {applyState.kind === 'loading' && (
        <p data-testid="migration-runner-applying" className="text-body-sm text-on-surface-variant">
          running the files in order, one transaction each…
        </p>
      )}
      {applyState.kind === 'failed' && (
        <pre data-testid="migration-runner-apply-failed" className={PRE}>
          {applyState.problem}
        </pre>
      )}

      {outcome !== null && (
        <div data-testid="migration-runner-result" className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">after APPLY</h3>
            <span data-testid="migration-runner-applied-count" className={CHIP_OK}>
              {outcome.appliedThisRun.length} applied this run
            </span>
            <span data-testid="migration-runner-second-run" className={CHIP}>
              second run applied: {outcome.secondRunApplied.length} — idempotent
            </span>
          </div>

          <FileList
            title="now applied, in order"
            files={outcome.applied}
            badge={<span className={CHIP_OK}>APPLIED</span>}
          />

          <p data-testid="migration-runner-tables" className="font-mono text-caption text-on-surface-variant">
            tables: {outcome.tables.join(', ')}
          </p>
          <p data-testid="migration-runner-indexes" className="font-mono text-caption text-on-surface-variant">
            indexes: {outcome.indexes.join(', ')} — both created by step 0002, never by editing 0001
          </p>
          <p data-testid="migration-runner-pending-after" className="font-mono text-caption text-on-surface-variant">
            pending now: {outcome.pending.length === 0 ? '[] — the database is at head' : outcome.pending.join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}
