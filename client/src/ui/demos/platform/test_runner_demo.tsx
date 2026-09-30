import { useCallback, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `testing:runner` — the testing topic's in-app test
 * runner. RUN calls GET /api/demo/testing/run, which executes a curated
 * twelve-case suite against the SERVER'S OWN pure modules on every request;
 * this component renders the verdict: a summary strip, one row per case
 * (pass/fail chip, behavior statement, module of origin, wall time), and
 * expected-vs-actual on any failure. The inject-a-failure selector (populated
 * from the last run's case ids) asks the server to flip one case red — the
 * honesty proof that the harness reports failures instead of always painting
 * green.
 */

const RUN_URL = '/api/demo/testing/run';

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

interface RunnerCase {
  id: string;
  name: string;
  module: string;
  passed: boolean;
  expected: string;
  actual: string;
  ms: number;
}

interface RunnerPayload {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  cases: RunnerCase[];
  injectFailureFor: string | null;
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRun(raw: unknown): RunnerPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.cases)) return null;
  if (typeof raw.total !== 'number' || typeof raw.passed !== 'number') return null;
  if (typeof raw.failed !== 'number' || typeof raw.durationMs !== 'number') return null;
  const cases = raw.cases.filter(
    (entry): entry is RunnerCase =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.module === 'string' &&
      typeof entry.passed === 'boolean' &&
      typeof entry.expected === 'string' &&
      typeof entry.actual === 'string' &&
      typeof entry.ms === 'number',
  );
  if (cases.length !== raw.cases.length) return null;
  return {
    total: raw.total,
    passed: raw.passed,
    failed: raw.failed,
    durationMs: raw.durationMs,
    cases,
    injectFailureFor: typeof raw.injectFailureFor === 'string' ? raw.injectFailureFor : null,
    note: typeof raw.note === 'string' ? raw.note : '',
  };
}

export default function TestRunnerDemo(): ReactNode {
  const [result, setResult] = useState<RunnerPayload | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [injectId, setInjectId] = useState('');
  const mounted = useRef(true);

  const run = useCallback(async (injectFailureFor: string): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const url =
        injectFailureFor === '' ? RUN_URL : `${RUN_URL}?injectFailureFor=${encodeURIComponent(injectFailureFor)}`;
      const response = await fetch(url);
      if (!mounted.current) return;
      if (!response.ok) throw new Error('HTTP error');
      const parsed = parseRun(await response.json());
      if (!mounted.current) return;
      if (parsed === null) throw new Error('malformed payload');
      setResult(parsed);
    } catch {
      if (mounted.current) {
        setError('the runner could not reach the server — is it running?');
      }
    } finally {
      if (mounted.current) setRunning(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="tr-summary-intro" className="text-body-sm text-on-surface">
        These are not fixtures: every case below calls the server&apos;s real pure modules on
        every RUN — the Range parser, the locale negotiator, the JWT service, the job
        queue&apos;s backoff math (through a fake clock). A red case on a plain run means the
        app drifted from the behavior this topic teaches.
      </p>

      <div className="flex flex-wrap items-center gap-xs">
        <button
          type="button"
          data-testid="tr-run-button"
          className={BUTTON_PRIMARY}
          onClick={() => void run(injectId)}
          disabled={running}
        >
          {running ? 'running…' : 'run the suite'}
        </button>

        {result !== null && (
          <select
            aria-label="inject a failure"
            data-testid="tr-inject-select"
            className="rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface"
            value={injectId}
            onChange={(event) => setInjectId(event.target.value)}
          >
            <option value="">run honestly (no injection)</option>
            {result.cases.map((entry) => (
              <option key={entry.id} value={entry.id}>
                inject failure: {entry.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error !== null && (
        <p data-testid="tr-error" className="text-caption text-error">
          {error}
        </p>
      )}

      {running && result === null && (
        <p data-testid="tr-loading" className="text-body-sm text-on-surface-variant">
          executing the twelve cases against this running process…
        </p>
      )}

      {result !== null && (
        <div className="flex flex-col gap-sm">
          <div data-testid="tr-summary" className="flex flex-wrap gap-xs">
            <span className={CHIP_STRONG}>total: {String(result.total)}</span>
            <span className={CHIP_STRONG}>passed: {String(result.passed)}</span>
            <span
              className={`rounded-md border border-outline px-xs py-xxs font-mono text-caption font-semibold ${
                result.failed > 0 ? 'text-error' : 'text-on-surface'
              }`}
            >
              failed: {String(result.failed)}
            </span>
            <span className={CHIP}>{String(result.durationMs)}ms</span>
            {result.injectFailureFor !== null && (
              <span data-testid="tr-injected-note" className={CHIP}>
                one failure injected: {result.injectFailureFor}
              </span>
            )}
          </div>

          <div className="flex max-h-96 flex-col gap-xxs overflow-y-auto">
            {result.cases.map((entry) => (
              <div
                key={entry.id}
                data-testid="tr-case"
                className="flex flex-col gap-xxs rounded-md border border-outline p-xs"
              >
                <div className="flex flex-wrap items-baseline gap-x-xs gap-y-xxs">
                  <span
                    data-testid="tr-case-chip"
                    className={`rounded border border-outline px-xxs font-mono text-caption font-semibold ${
                      entry.passed ? 'text-on-surface' : 'text-error'
                    }`}
                  >
                    {entry.passed ? 'PASS' : 'FAIL'}
                  </span>
                  <span className="text-body-sm text-on-surface">{entry.name}</span>
                  <span className={CHIP}>{String(entry.ms)}ms</span>
                </div>
                <p className="font-mono text-caption text-on-surface-variant">
                  module: {entry.module}
                </p>
                {!entry.passed && (
                  <div
                    data-testid="tr-case-detail"
                    className="flex flex-col gap-xxs rounded border border-outline bg-surface-variant p-xxs font-mono text-caption"
                  >
                    <p data-testid="tr-case-expected" className="text-on-surface">
                      expected: {entry.expected}
                    </p>
                    <p data-testid="tr-case-actual" className="text-error">
                      actual: {entry.actual}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="text-caption text-on-surface-variant">{result.note}</p>
        </div>
      )}
    </div>
  );
}
