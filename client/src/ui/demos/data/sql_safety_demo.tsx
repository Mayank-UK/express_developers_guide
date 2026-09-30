import { useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:sql-safety` — two proofs from the sql-node topic in
 * one panel. INJECTION: the payload you type is fired at a real parameterized
 * lookup (bound as the ? value), matching zero rows while the naive
 * concatenated query is displayed inert. TRANSACTION: the tag move runs its
 * two writes in one better-sqlite3 transaction; the crash variant throws
 * between the writes and BOTH roll back — before/after counts prove it.
 */

const INJECTION_URL = '/api/demo/db/injection';
const TRANSFER_URL = '/api/demo/db/transfer';

const DEFAULT_ATTEMPT = `' OR '1'='1`;

interface InjectionOutcome {
  attempt: string;
  safeQuery: string;
  boundParameter: string;
  matchedCount: number;
  matchedRows: { id: string; title: string }[];
  naiveQuery: string;
  verdict: string;
}

interface TransferOutcome {
  crash: boolean;
  transferred: boolean;
  rolledBack: boolean;
  moved: { tag: string; from: string; to: string };
  writes: string[];
  before: Record<string, number>;
  after: Record<string, number>;
  explain: string;
}

type InjectionState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: InjectionOutcome }
  | { kind: 'failed'; problem: string };

type TransferState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: TransferOutcome }
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

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseInjection(value: unknown): InjectionOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.attempt !== 'string' ||
    typeof record.safeQuery !== 'string' ||
    typeof record.boundParameter !== 'string' ||
    typeof record.naiveQuery !== 'string' ||
    typeof record.matchedCount !== 'number' ||
    !Array.isArray(record.matchedRows)
  ) {
    return null;
  }
  return {
    attempt: record.attempt,
    safeQuery: record.safeQuery,
    boundParameter: record.boundParameter,
    matchedCount: record.matchedCount,
    matchedRows: record.matchedRows.map((row) => ({
      id: String((row as Record<string, unknown>).id ?? '?'),
      title: String((row as Record<string, unknown>).title ?? '?'),
    })),
    naiveQuery: record.naiveQuery,
    verdict: typeof record.verdict === 'string' ? record.verdict : '',
  };
}

function parseCounts(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'number') return null;
    out[key] = raw;
  }
  return out;
}

function parseTransfer(value: unknown): TransferOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const before = parseCounts(record.before);
  const after = parseCounts(record.after);
  if (
    typeof record.transferred !== 'boolean' ||
    typeof record.rolledBack !== 'boolean' ||
    typeof record.explain !== 'string' ||
    before === null ||
    after === null
  ) {
    return null;
  }
  const movedRaw = typeof record.moved === 'object' && record.moved !== null ? record.moved as Record<string, unknown> : {};
  return {
    crash: record.crash === true,
    transferred: record.transferred,
    rolledBack: record.rolledBack,
    moved: {
      tag: String(movedRaw.tag ?? '?'),
      from: String(movedRaw.from ?? '?'),
      to: String(movedRaw.to ?? '?'),
    },
    writes: Array.isArray(record.writes) ? record.writes.map((write) => String(write)) : [],
    before,
    after,
    explain: record.explain,
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

function countsLine(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([post, count]) => `${post}: ${String(count)} tag${count === 1 ? '' : 's'}`)
    .join(' · ');
}

export default function SqlSafetyDemo(): ReactNode {
  const [attempt, setAttempt] = useState<string>(DEFAULT_ATTEMPT);
  const [injectionState, setInjectionState] = useState<InjectionState>({ kind: 'idle' });
  const [transferState, setTransferState] = useState<TransferState>({ kind: 'idle' });

  const fireInjection = (): void => {
    setInjectionState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`${INJECTION_URL}?attempt=${encodeURIComponent(attempt)}`);
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseInjection(parsed.value) : null;
        if (shaped === null) {
          setInjectionState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not an injection outcome:\n${text}`,
          });
          return;
        }
        setInjectionState({ kind: 'answered', outcome: shaped });
      } catch {
        setInjectionState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
      }
    })();
  };

  const runTransfer = (crash: boolean): void => {
    setTransferState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(crash ? `${TRANSFER_URL}?crash=1` : TRANSFER_URL, { method: 'POST' });
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseTransfer(parsed.value) : null;
        if (shaped === null) {
          setTransferState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a transfer outcome:\n${text}`,
          });
          return;
        }
        setTransferState({ kind: 'answered', outcome: shaped });
      } catch {
        setTransferState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
      }
    })();
  };

  const injection = injectionState.kind === 'answered' ? injectionState.outcome : null;
  const transfer = transferState.kind === 'answered' ? transferState.outcome : null;

  return (
    <div className="flex flex-col gap-md">
      {/* ---- injection panel ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">parameterized queries or else</h3>
        <p data-testid="sql-injection-summary" className="text-body-sm text-on-surface-variant">
          Fire a payload at a real lookup on the demo handle. The server binds your attempt as the{' '}
          <span className="font-mono">?</span> PARAMETER — data, never SQL — and shows the naive concatenated
          form as an inert string.
        </p>

        <div className="flex flex-col gap-xs sm:flex-row">
          <input
            data-testid="sql-injection-attempt"
            value={attempt}
            onChange={(event) => setAttempt(event.target.value)}
            spellCheck={false}
            className={INPUT}
          />
          <button
            type="button"
            data-testid="sql-injection-fire"
            onClick={fireInjection}
            disabled={injectionState.kind === 'loading' || attempt.length === 0}
            className={BUTTON_PRIMARY}
          >
            {injectionState.kind === 'loading' ? 'firing…' : 'fire at the lookup'}
          </button>
        </div>

        {injectionState.kind === 'failed' && (
          <pre data-testid="sql-injection-failed" className={PRE}>
            {injectionState.problem}
          </pre>
        )}

        {injection !== null && (
          <div data-testid="sql-injection-result" className="flex flex-col gap-xs">
            <div className="flex flex-wrap items-center gap-sm">
              <span data-testid="sql-injection-count" className={injection.matchedCount === 0 ? CHIP_OK : CHIP}>
                {String(injection.matchedCount)} rows matched
              </span>
              <span className="font-mono text-caption text-on-surface-variant">
                bound as parameter: <span className="text-on-surface">{injection.boundParameter}</span>
              </span>
            </div>
            <pre data-testid="sql-injection-safe-query" className={PRE}>
              {`-- what actually ran (the attempt is the ? value):
${injection.safeQuery}

-- what NOT to do — INERT display, never executed:
${injection.naiveQuery}`}
            </pre>
            {injection.matchedRows.length > 0 && (
              <p data-testid="sql-injection-rows" className="font-mono text-caption text-on-surface-variant">
                {injection.matchedRows.map((row) => row.title).join(' · ')}
              </p>
            )}
            <p data-testid="sql-injection-verdict" className="text-body-sm text-on-surface">
              {injection.verdict}
            </p>
          </div>
        )}
      </section>

      {/* ---- transaction panel ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">a transaction keeps its promise</h3>
        <p data-testid="sql-transaction-summary" className="text-body-sm text-on-surface-variant">
          Move the <span className="font-mono">sqlite</span> tag from <span className="font-mono">post-alpha</span>{' '}
          to <span className="font-mono">post-beta</span>: two writes, one better-sqlite3 transaction. The crash
          variant throws BETWEEN the writes — both must roll back, and the counts must come back identical.
        </p>

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="sql-transaction-transfer"
            onClick={() => runTransfer(false)}
            disabled={transferState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            transfer
          </button>
          <button
            type="button"
            data-testid="sql-transaction-crash"
            onClick={() => runTransfer(true)}
            disabled={transferState.kind === 'loading'}
            className={BUTTON_DANGER}
          >
            transfer with crash
          </button>
        </div>

        {transferState.kind === 'loading' && (
          <p data-testid="sql-transaction-loading" className="text-body-sm text-on-surface-variant">
            running the two writes…
          </p>
        )}
        {transferState.kind === 'failed' && (
          <pre data-testid="sql-transaction-failed" className={PRE}>
            {transferState.problem}
          </pre>
        )}

        {transfer !== null && (
          <div data-testid="sql-transaction-result" className="flex flex-col gap-xs">
            <div className="flex flex-wrap items-center gap-sm">
              <span data-testid="sql-transaction-verdict" className={transfer.transferred ? CHIP_OK : CHIP_ERROR}>
                {transfer.transferred ? 'transferred — both writes committed' : 'rolled back — atomicity kept'}
              </span>
              <span className="font-mono text-caption text-on-surface-variant">
                rolledBack: {String(transfer.rolledBack)} · moved: {transfer.moved.tag} {transfer.moved.from} →{' '}
                {transfer.moved.to}
              </span>
            </div>
            <pre data-testid="sql-transaction-counts" className={PRE}>
              {`before: ${countsLine(transfer.before)}
after:  ${countsLine(transfer.after)}

${transfer.writes.map((write, index) => `${String(index + 1)}. ${write}`).join('\n')}${transfer.crash ? '\n!! a throw between write 1 and write 2 — rolled back together' : ''}`}
            </pre>
            <p data-testid="sql-transaction-explain" className="text-body-sm text-on-surface">
              {transfer.explain}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
