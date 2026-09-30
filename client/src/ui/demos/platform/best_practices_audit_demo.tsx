import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `best:checklist` — THE SELF-AUDIT: the running app
 * checks itself against the best-practices checklist (real headers via
 * self-fetch, real process listeners, a real source-grep of the DAO) and
 * this component renders the report card: checks grouped by category with
 * pass/warn/fail chips, the evidence each grade rests on, and the summary
 * counts. The point is not this app's score — it's that a checklist you
 * can EXECUTE beats one you can only read.
 */

const BASE_URL = '/api/demo/best/audit';

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';

type AuditStatus = 'pass' | 'warn' | 'fail';

interface AuditCheck {
  readonly id: string;
  readonly category: string;
  readonly practice: string;
  readonly status: AuditStatus;
  readonly evidence: string;
}

interface AuditBody {
  readonly checks: AuditCheck[];
  readonly summary: { pass: number; warn: number; fail: number; total: number };
  readonly note: string;
}

const STATUS_CHIP: Record<AuditStatus, { label: string; className: string }> = {
  pass: {
    label: 'pass',
    className:
      'rounded-md border border-secondary bg-secondary px-xs py-xxs font-mono text-caption font-semibold text-on-secondary',
  },
  warn: {
    label: 'warn',
    className:
      'rounded-md border border-warning bg-warning px-xs py-xxs font-mono text-caption font-bold text-on-surface',
  },
  fail: {
    label: 'fail',
    className:
      'rounded-md border border-error bg-error px-xs py-xxs font-mono text-caption font-bold text-on-error',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAudit(raw: unknown): AuditBody {
  if (!isRecord(raw) || !Array.isArray(raw.checks) || !isRecord(raw.summary)) {
    throw new Error('malformed audit');
  }
  const checks = raw.checks.filter(
    (entry): entry is AuditCheck =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.category === 'string' &&
      typeof entry.practice === 'string' &&
      typeof entry.evidence === 'string' &&
      (entry.status === 'pass' || entry.status === 'warn' || entry.status === 'fail'),
  );
  return {
    checks,
    summary: {
      pass: typeof raw.summary.pass === 'number' ? raw.summary.pass : 0,
      warn: typeof raw.summary.warn === 'number' ? raw.summary.warn : 0,
      fail: typeof raw.summary.fail === 'number' ? raw.summary.fail : 0,
      total: typeof raw.summary.total === 'number' ? raw.summary.total : checks.length,
    },
    note: typeof raw.note === 'string' ? raw.note : '',
  };
}

export default function BestPracticesAuditDemo(): ReactNode {
  const [audit, setAudit] = useState<AuditBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const aliveRef = useRef(true);

  const runAudit = useCallback(async (): Promise<void> => {
    setRunning(true);
    try {
      const response = await fetch(BASE_URL);
      if (!aliveRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const parsed = parseAudit(await response.json());
      if (!aliveRef.current) return;
      setAudit(parsed);
      setError(null);
    } catch {
      if (aliveRef.current) {
        setError('the audit API is unreachable — run it against the dev server for the full board');
      }
    } finally {
      if (aliveRef.current) setRunning(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void runAudit();
    return () => {
      aliveRef.current = false;
    };
  }, [runAudit]);

  // Group by category, preserving the server's first-seen order.
  const categories: { title: string; checks: AuditCheck[] }[] = [];
  for (const check of audit?.checks ?? []) {
    const existing = categories.find((category) => category.title === check.category);
    if (existing === undefined) categories.push({ title: check.category, checks: [check] });
    else existing.checks.push(check);
  }

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="audit-summary-line" className="text-body-sm text-on-surface">
        The app grades itself:{' '}
        <span data-testid="audit-summary" className="font-mono font-semibold">
          {audit === null
            ? '…'
            : `${String(audit.summary.pass)} pass / ${String(audit.summary.warn)} warn / ${String(audit.summary.fail)} fail`}
        </span>{' '}
        — pass is verified against the running process; warn means the check could not OBSERVE
        (self-fetch unavailable), not that it passed.
      </p>

      <div className="flex flex-wrap items-center gap-xs">
        <button
          type="button"
          data-testid="audit-run"
          className={BUTTON_PRIMARY}
          disabled={running}
          onClick={() => void runAudit()}
        >
          {running ? 'auditing…' : 'run audit'}
        </button>
        {audit !== null && <span className={CHIP}>{String(audit.summary.total)} checks</span>}
      </div>

      {error !== null && (
        <p data-testid="audit-error" className="text-caption text-error">
          {error}
        </p>
      )}

      {categories.map((category) => (
        <section key={category.title} data-testid="audit-group" className="flex flex-col gap-xs rounded-md border border-outline p-sm">
          <span data-testid="audit-group-title" className="text-caption font-semibold text-on-surface">
            {category.title}
          </span>
          {category.checks.map((check) => (
            <div
              key={check.id}
              data-testid="audit-check"
              className="flex flex-col gap-xxs rounded-md border border-outline bg-surface p-xs"
            >
              <div className="flex flex-wrap items-center gap-xs">
                <span data-testid="audit-chip" className={STATUS_CHIP[check.status].className}>
                  {STATUS_CHIP[check.status].label}
                </span>
                <span className="text-caption font-semibold text-on-surface">{check.practice}</span>
                <span className={CHIP}>{check.id}</span>
              </div>
              <p data-testid="audit-evidence" className="font-mono text-caption text-on-surface-variant">
                {check.evidence}
              </p>
            </div>
          ))}
        </section>
      ))}

      {audit !== null && audit.note !== '' && (
        <p className="text-caption text-on-surface-variant">{audit.note}</p>
      )}
    </div>
  );
}
