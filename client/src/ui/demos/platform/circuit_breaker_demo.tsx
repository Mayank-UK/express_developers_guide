import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `reliability:breaker` — THE WATCHABLE BREAKER: the real
 * CircuitBreaker (server domain/reliability/) around a flaky dependency you
 * steer. The state badge is the machine (CLOSED green / OPEN red / HALF_OPEN
 * amber); CALL fires one request and shows its outcome + ms (rejected-fast is
 * visibly ~0ms); AUTO-CALL ×5 fills the transition timeline; the cooldown
 * counts down while OPEN (server-computed remaining, ticked locally between
 * polls — clamped at zero, never negative).
 */

const BASE_URL = '/api/demo/reliability';
const POLL_MS = 1000;

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_DANGER =
  'w-fit rounded-md border border-error px-sm py-xs text-body-sm text-error hover:bg-error hover:text-on-error disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

type BreakerState = 'closed' | 'open' | 'half_open';
type FlakyMode = 'healthy' | 'failing' | 'slow';
type CallOutcome = 'success' | 'failure' | 'rejected-fast';

interface HistoryEntry {
  at: string;
  from: string;
  to: string;
  reason: string;
}

interface BreakerStatus {
  state: BreakerState;
  consecutiveFailures: number;
  totalRejected: number;
  lastFailureAt: string | null;
  openedAt: string | null;
  config: { failureThreshold: number; cooldownMs: number; halfOpenSuccesses: number; timeoutMs: number | null };
}

interface StatusBody {
  breaker: BreakerStatus;
  cooldownRemainingMs: number;
  flaky: { mode: FlakyMode; modes: FlakyMode[]; latenciesMs: Record<string, number>; timeoutMs: number };
  history: HistoryEntry[];
}

interface CallBody {
  outcome: CallOutcome;
  ms: number;
  breakerState: BreakerState;
  cooldownRemainingMs: number;
  value?: { mode: string; note: string };
  failure?: { kind: string; message: string; details?: Record<string, unknown> };
  note?: string;
}

const STATE_BADGE: Record<BreakerState, { label: string; className: string }> = {
  closed: {
    label: 'CLOSED',
    className:
      'rounded-md border border-secondary bg-secondary px-sm py-xs font-mono text-body-sm font-semibold text-on-secondary',
  },
  open: {
    label: 'OPEN',
    className: 'rounded-md border border-error bg-error px-sm py-xs font-mono text-body-sm font-bold text-on-error',
  },
  half_open: {
    label: 'HALF_OPEN',
    className:
      'rounded-md border border-warning bg-warning px-sm py-xs font-mono text-body-sm font-semibold text-on-surface',
  },
};

const OUTCOME_CHIP: Record<CallOutcome, string> = {
  success: 'rounded-md border border-secondary bg-secondary px-xs py-xxs font-mono text-caption font-semibold text-on-secondary',
  failure: 'rounded-md border border-error bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error',
  'rejected-fast':
    'rounded-md border border-warning bg-warning px-xs py-xxs font-mono text-caption font-bold text-on-surface',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStatus(raw: unknown): StatusBody {
  if (!isRecord(raw) || !isRecord(raw.breaker) || !isRecord(raw.flaky) || !Array.isArray(raw.history)) {
    throw new Error('malformed status');
  }
  const { breaker, flaky, history } = raw;
  const state = breaker.state;
  if (state !== 'closed' && state !== 'open' && state !== 'half_open') {
    throw new Error('malformed breaker state');
  }
  const mode = flaky.mode;
  if (mode !== 'healthy' && mode !== 'failing' && mode !== 'slow') {
    throw new Error('malformed flaky mode');
  }
  return {
    breaker: {
      state,
      consecutiveFailures: typeof breaker.consecutiveFailures === 'number' ? breaker.consecutiveFailures : 0,
      totalRejected: typeof breaker.totalRejected === 'number' ? breaker.totalRejected : 0,
      lastFailureAt: typeof breaker.lastFailureAt === 'string' ? breaker.lastFailureAt : null,
      openedAt: typeof breaker.openedAt === 'string' ? breaker.openedAt : null,
      config: isRecord(breaker.config)
        ? {
            failureThreshold: typeof breaker.config.failureThreshold === 'number' ? breaker.config.failureThreshold : 3,
            cooldownMs: typeof breaker.config.cooldownMs === 'number' ? breaker.config.cooldownMs : 4000,
            halfOpenSuccesses: typeof breaker.config.halfOpenSuccesses === 'number' ? breaker.config.halfOpenSuccesses : 2,
            timeoutMs: typeof breaker.config.timeoutMs === 'number' ? breaker.config.timeoutMs : null,
          }
        : { failureThreshold: 3, cooldownMs: 4000, halfOpenSuccesses: 2, timeoutMs: null },
    },
    cooldownRemainingMs: typeof raw.cooldownRemainingMs === 'number' ? raw.cooldownRemainingMs : 0,
    flaky: {
      mode,
      modes: Array.isArray(flaky.modes) ? (flaky.modes as FlakyMode[]) : ['healthy', 'failing', 'slow'],
      latenciesMs: isRecord(flaky.latenciesMs) ? (flaky.latenciesMs as Record<string, number>) : {},
      timeoutMs: typeof flaky.timeoutMs === 'number' ? flaky.timeoutMs : 300,
    },
    history: history.filter(
      (entry): entry is HistoryEntry => isRecord(entry) && typeof entry.at === 'string' && typeof entry.to === 'string',
    ),
  };
}

/** Guarded read of one call outcome — a malformed body throws, never renders nonsense. */
function parseCall(raw: unknown): CallBody {
  if (!isRecord(raw)) throw new Error('malformed call result');
  const outcome = raw.outcome;
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'rejected-fast') {
    throw new Error('malformed call outcome');
  }
  return {
    outcome,
    ms: typeof raw.ms === 'number' ? raw.ms : -1,
    breakerState:
      raw.breakerState === 'closed' || raw.breakerState === 'open' || raw.breakerState === 'half_open'
        ? raw.breakerState
        : 'closed',
    cooldownRemainingMs: typeof raw.cooldownRemainingMs === 'number' ? raw.cooldownRemainingMs : 0,
    value: isRecord(raw.value) ? { mode: String(raw.value.mode ?? ''), note: String(raw.value.note ?? '') } : undefined,
    failure: isRecord(raw.failure)
      ? {
          kind: String(raw.failure.kind ?? ''),
          message: String(raw.failure.message ?? ''),
          details: isRecord(raw.failure.details) ? raw.failure.details : undefined,
        }
      : undefined,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  };
}

function clockOf(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

export default function CircuitBreakerDemo(): ReactNode {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCall, setLastCall] = useState<CallBody | null>(null);
  const [callInFlight, setCallInFlight] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const aliveRef = useRef(true);
  const cooldownEndsAtRef = useRef<number | null>(null);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${BASE_URL}/status`);
      if (!aliveRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const parsed = parseStatus(await response.json());
      if (!aliveRef.current) return;
      setStatus(parsed);
      // The countdown anchor: server-computed remaining + this client's now.
      cooldownEndsAtRef.current =
        parsed.cooldownRemainingMs > 0 ? Date.now() + parsed.cooldownRemainingMs : null;
      setCooldownLeft(parsed.cooldownRemainingMs);
      setError(null);
    } catch {
      if (aliveRef.current) {
        setError('the reliability API is unreachable — the breaker panel keeps retrying every second');
      }
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [loadStatus]);

  // Local countdown ticks between polls — clamped at zero, never negative.
  useEffect(() => {
    const ticker = setInterval(() => {
      const endsAt = cooldownEndsAtRef.current;
      if (endsAt === null) return;
      setCooldownLeft(Math.max(0, endsAt - Date.now()));
    }, 250);
    return () => clearInterval(ticker);
  }, []);

  /** POST helper for the body-less actions (call / reset). */
  const post = useCallback(async (path: string): Promise<unknown> => {
    const response = await fetch(`${BASE_URL}${path}`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    return response.json();
  }, []);

  const setMode = useCallback(
    async (mode: FlakyMode): Promise<void> => {
      setError(null);
      try {
        await fetch(`${BASE_URL}/mode`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
      } catch {
        setError(`could not set the dependency mode to ${mode}`);
      }
      await loadStatus();
    },
    [loadStatus],
  );

  const fireCall = useCallback(async (): Promise<void> => {
    setError(null);
    setCallInFlight(true);
    try {
      const raw = await fetch(`${BASE_URL}/call`, { method: 'POST' });
      if (!raw.ok) throw new Error(`HTTP ${String(raw.status)}`);
      setLastCall(parseCall(await raw.json()));
    } catch {
      setError('the call failed to reach the server');
    } finally {
      setCallInFlight(false);
    }
    await loadStatus();
  }, [loadStatus]);

  const autoCall = useCallback(async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await fireCall();
  }, [fireCall]);

  const reset = useCallback(async (): Promise<void> => {
    setError(null);
    setLastCall(null);
    try {
      await post('/reset');
    } catch {
      setError('could not reset the breaker');
    }
    await loadStatus();
  }, [loadStatus, post]);

  const state = status?.breaker.state ?? 'closed';
  const badge = STATE_BADGE[state];
  const mode = status?.flaky.mode ?? 'healthy';
  const open = state === 'open';

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="breaker-summary" className="text-body-sm text-on-surface">
        A real circuit breaker around a dependency you steer:{' '}
        <code className="font-mono">closed → open → half_open</code>. Three failing calls open it;
        while open, calls bounce off in ~0ms; after the{' '}
        {status ? `${String(status.breaker.config.cooldownMs / 1000)}s` : '4s'} cooldown two healthy
        probes close it. A slow dependency (800ms vs the{' '}
        {status ? String(status.flaky.timeoutMs) : '300'}ms deadline) counts as a failure.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <span data-testid="breaker-state" className={badge.className}>
            {badge.label}
          </span>
          <span data-testid="breaker-mode" className={CHIP}>
            dependency: {mode}
          </span>
          <span data-testid="breaker-counters" className={CHIP}>
            consecutive failures {String(status?.breaker.consecutiveFailures ?? 0)} · rejected{' '}
            {String(status?.breaker.totalRejected ?? 0)}
          </span>
          {open && (
            <span data-testid="breaker-cooldown" className={CHIP_STRONG}>
              cooldown {(cooldownLeft / 1000).toFixed(1)}s
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-xs">
          {(status?.flaky.modes ?? ['healthy', 'failing', 'slow']).map((entry) => (
            <button
              key={entry}
              type="button"
              data-testid={`breaker-mode-${entry}`}
              className={mode === entry ? BUTTON_PRIMARY : BUTTON}
              disabled={mode === entry}
              onClick={() => void setMode(entry)}
            >
              {entry}
              {status ? ` (~${String(status.flaky.latenciesMs[entry] ?? '?')}ms)` : ''}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-xs">
          <button
            type="button"
            data-testid="breaker-call"
            className={BUTTON_PRIMARY}
            disabled={callInFlight}
            onClick={() => void fireCall()}
          >
            {callInFlight ? 'calling…' : 'call'}
          </button>
          <button
            type="button"
            data-testid="breaker-autocall"
            className={BUTTON}
            disabled={callInFlight}
            onClick={() => void autoCall()}
          >
            auto-call ×5
          </button>
          <button type="button" data-testid="breaker-reset" className={BUTTON_DANGER} onClick={() => void reset()}>
            reset
          </button>
        </div>

        {error !== null && (
          <p data-testid="breaker-error" className="text-caption text-error">
            {error}
          </p>
        )}

        {lastCall !== null && (
          <div data-testid="breaker-last-call" className="flex flex-col gap-xxs rounded-md border border-outline p-sm">
            <div className="flex flex-wrap items-center gap-xs">
              <span className={OUTCOME_CHIP[lastCall.outcome]}>{lastCall.outcome}</span>
              <span className={CHIP_STRONG}>{String(lastCall.ms)} ms</span>
              <span className={CHIP}>breaker now: {lastCall.breakerState}</span>
            </div>
            {lastCall.outcome === 'rejected-fast' && (
              <p className="text-caption text-on-surface">
                ~0 milliseconds — the dependency was never touched; this is the load being shed
                that lets it recover.
              </p>
            )}
            {lastCall.outcome === 'failure' && lastCall.failure !== undefined && (
              <p className="font-mono text-caption text-error">{lastCall.failure.message}</p>
            )}
            {lastCall.outcome === 'success' && (
              <p className="font-mono text-caption text-on-surface-variant">
                {lastCall.value?.note ?? 'the dependency answered'}
              </p>
            )}
            {lastCall.note !== undefined && (
              <p className="text-caption text-on-surface-variant">{lastCall.note}</p>
            )}
          </div>
        )}
      </section>

      <section
        data-testid="breaker-timeline"
        className="flex max-h-72 flex-col gap-xxs overflow-y-auto rounded-md border border-outline bg-surface p-sm"
      >
        <span className="text-caption font-semibold text-on-surface">state transitions (newest first)</span>
        {(status?.history.length ?? 0) === 0 && (
          <p className="text-caption text-on-surface-variant">
            no transitions yet — the breaker is doing its boring, wonderful job.
          </p>
        )}
        {status?.history.map((entry, index) => (
          <p key={index} className="font-mono text-caption text-on-surface-variant">
            <span className="text-on-surface">{clockOf(entry.at)}Z</span> · {entry.from} →{' '}
            <span className="text-on-surface">{entry.to}</span> · {entry.reason}
          </p>
        ))}
      </section>
    </div>
  );
}
