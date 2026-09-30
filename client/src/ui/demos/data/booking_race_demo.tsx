import { useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:race` — the check-then-act inventory booking race,
 * fired for real: pick naive (SELECT, await, then an unguarded UPDATE) or
 * safe (the stock > 0 guard inside the one-statement decrement), a concurrency
 * and a starting stock, and watch every attempt's outcome plus the final
 * shelf. The naive mode's oversell (final stock below zero) is rendered as an
 * error chip on purpose — the negative number IS the lesson.
 */

const RACE_URL = '/api/demo/db/race';

const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

interface RaceAttempt {
  attempt: number;
  mode: string;
  succeeded: boolean;
  stockObserved?: number;
  rowsMatched?: number;
  failureKind?: string;
  httpStatus?: number;
  message: string;
}

interface RaceOutcome {
  item: string;
  mode: string;
  concurrency: number;
  initialStock: number;
  attempts: RaceAttempt[];
  successCount: number;
  finalStock: number;
  oversold: boolean;
  sql: { readStock: string; naiveDecrement: string; safeDecrement: string };
  explain: string;
}

type RaceState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: RaceOutcome }
  | { kind: 'failed'; problem: string };

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
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

const MODES = [
  { id: 'naive', label: 'naive — check, then act' },
  { id: 'safe', label: 'safe — guarded UPDATE' },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseRace(value: unknown): RaceOutcome | null {
  if (!isRecord(value)) return null;
  const sql = isRecord(value.sql) ? value.sql : null;
  if (
    sql === null ||
    typeof sql.readStock !== 'string' ||
    typeof sql.naiveDecrement !== 'string' ||
    typeof sql.safeDecrement !== 'string' ||
    !Array.isArray(value.attempts)
  ) {
    return null;
  }
  return {
    item: asString(value.item),
    mode: asString(value.mode),
    concurrency: asNumber(value.concurrency),
    initialStock: asNumber(value.initialStock),
    attempts: value.attempts.filter(isRecord).map((row) => ({
      attempt: asNumber(row.attempt),
      mode: asString(row.mode),
      succeeded: row.succeeded === true,
      stockObserved: typeof row.stockObserved === 'number' ? row.stockObserved : undefined,
      rowsMatched: typeof row.rowsMatched === 'number' ? row.rowsMatched : undefined,
      failureKind: typeof row.failureKind === 'string' ? row.failureKind : undefined,
      httpStatus: typeof row.httpStatus === 'number' ? row.httpStatus : undefined,
      message: asString(row.message, ''),
    })),
    successCount: asNumber(value.successCount),
    finalStock: asNumber(value.finalStock),
    oversold: value.oversold === true,
    sql: {
      readStock: sql.readStock,
      naiveDecrement: sql.naiveDecrement,
      safeDecrement: sql.safeDecrement,
    },
    explain: asString(value.explain, ''),
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

const isWholeNumberInRange = (raw: string, min: number, max: number): boolean => {
  if (!/^\d+$/.test(raw)) return false;
  const parsed = Number(raw);
  return parsed >= min && parsed <= max;
};

export default function BookingRaceDemo(): ReactNode {
  const [mode, setMode] = useState<string>('naive');
  const [concurrency, setConcurrency] = useState<string>('3');
  const [stock, setStock] = useState<string>('1');
  const [raceState, setRaceState] = useState<RaceState>({ kind: 'idle' });

  const stockValid = isWholeNumberInRange(stock, 0, 99);

  const fireRace = (): void => {
    setRaceState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(
          `${RACE_URL}?mode=${mode}&concurrency=${concurrency}&stock=${stock}`,
          { method: 'POST' },
        );
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseRace(parsed.value) : null;
        if (shaped === null) {
          setRaceState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a race outcome:\n${text}`,
          });
          return;
        }
        setRaceState({ kind: 'answered', outcome: shaped });
      } catch {
        setRaceState({
          kind: 'failed',
          problem: 'could not reach the server — is the guide running on :4000?',
        });
      }
    })();
  };

  const outcome = raceState.kind === 'answered' ? raceState.outcome : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="booking-race-summary" className="text-body-sm text-on-surface">
        Book the last item N times at once. The naive implementation reads the stock, does async
        work, then decrements unguarded — every attempt acts on a stale read and the shelf goes
        negative. The safe implementation puts the stock &gt; 0 guard inside the decrement itself,
        one atomic statement; the surplus bookings fail cleanly with 409 instead of overselling.
      </p>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-col gap-xs sm:flex-row sm:items-end">
          <label className="flex flex-col gap-xxs">
            <span className={LABEL}>mode</span>
            <select
              data-testid="booking-race-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
              className={INPUT}
            >
              {MODES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-xxs">
            <span className={LABEL}>concurrent bookings (1–8)</span>
            <select
              data-testid="booking-race-concurrency"
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
              className={INPUT}
            >
              {CONCURRENCY_OPTIONS.map((option) => (
                <option key={option} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-xxs">
            <span className={LABEL}>starting stock (0–99)</span>
            <input
              data-testid="booking-race-stock"
              value={stock}
              onChange={(event) => setStock(event.target.value)}
              spellCheck={false}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="booking-race-fire"
            onClick={fireRace}
            disabled={raceState.kind === 'loading' || !stockValid}
            className={BUTTON_PRIMARY}
          >
            {raceState.kind === 'loading' ? 'racing…' : 'fire the bookings'}
          </button>
        </div>
        {!stockValid && (
          <p data-testid="booking-race-stock-invalid" className="text-caption text-error">
            stock must be a whole number between 0 and 99
          </p>
        )}
      </div>

      {raceState.kind === 'idle' && (
        <p data-testid="booking-race-idle" className="text-body-sm text-on-surface-variant">
          nothing raced yet — try naive, stock 1, concurrency 3 and watch the shelf go below zero
        </p>
      )}
      {raceState.kind === 'failed' && (
        <pre data-testid="booking-race-failed" className={PRE}>
          {raceState.problem}
        </pre>
      )}

      {outcome !== null && (
        <div data-testid="booking-race-result" className="flex flex-col gap-sm">
          <div className="flex flex-wrap items-center gap-sm rounded-md border border-outline p-sm">
            <span className={CHIP}>{outcome.mode}</span>
            <span className={CHIP}>
              started at {String(outcome.initialStock)} · item {outcome.item}
            </span>
            <span
              data-testid="booking-race-final-stock"
              className={outcome.oversold ? CHIP_ERROR : CHIP_OK}
            >
              {outcome.oversold
                ? `final stock: ${String(outcome.finalStock)} · OVERSOLD`
                : `final stock: ${String(outcome.finalStock)}`}
            </span>
            <span data-testid="booking-race-success-count" className={CHIP}>
              {String(outcome.successCount)}/{String(outcome.concurrency)} booked
            </span>
          </div>

          <table data-testid="booking-race-attempts" className="w-full border-collapse text-body-sm">
            <thead>
              <tr>
                {['attempt', 'outcome', 'evidence', 'what happened'].map((column) => (
                  <th
                    key={column}
                    className={`${CELL} font-mono text-caption font-semibold text-on-surface-variant`}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-on-surface">
              {outcome.attempts.map((attempt) => (
                <tr key={attempt.attempt} data-testid="booking-race-attempt-row">
                  <td className={`${CELL} font-mono align-top`}>#{String(attempt.attempt)}</td>
                  <td className={`${CELL} align-top`}>
                    <span className={attempt.succeeded ? CHIP_OK : CHIP_ERROR}>
                      {attempt.succeeded
                        ? 'booked'
                        : `${attempt.failureKind ?? 'failed'} · ${String(attempt.httpStatus ?? '?')}`}
                    </span>
                  </td>
                  <td className={`${CELL} font-mono align-top`}>
                    {attempt.mode === 'naive'
                      ? `read stock=${attempt.stockObserved !== undefined ? String(attempt.stockObserved) : '?'}`
                      : `rows matched=${attempt.rowsMatched !== undefined ? String(attempt.rowsMatched) : '?'}`}
                  </td>
                  <td className={`${CELL} align-top break-words`}>{attempt.message}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <pre data-testid="booking-race-sql" className={PRE}>
            {`-- what every attempt runs first:
${outcome.sql.readStock}

-- naive: the unguarded decrement (check-then-act)
${outcome.sql.naiveDecrement}

-- safe: the guard lives inside the write
${outcome.sql.safeDecrement}`}
          </pre>
          <p data-testid="booking-race-explain" className="text-body-sm text-on-surface">
            {outcome.explain}
          </p>
        </div>
      )}
    </div>
  );
}
