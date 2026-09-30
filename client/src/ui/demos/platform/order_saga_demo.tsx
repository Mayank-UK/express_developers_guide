import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `arch:saga` — the saga runner. An order runs four forward
 * steps (place-order, reserve-stock, charge-card, ship) as REAL queue jobs on
 * a dedicated JobQueue; pick a failing step and the queue retries it (3
 * attempts, backoff) before dead-lettering it — at which point the saga
 * compensates in REVERSE over every attempted step (including the failed one:
 * failed-to-confirm is not did-not-happen). The console polls the saga until
 * it settles: completed (all four landed) or compensated (unwound). The poll
 * is BOUNDED — it stops after MAX_POLLS and waits for a manual nudge, so a
 * stuck queue can never spin this tab forever.
 */

const BASE = '/api/demo/patterns/saga';
const POLL_MS = 500;
const MAX_POLLS = 120;

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
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const SELECT =
  'rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const MALFORMED = 'malformed payload';

type SagaState = 'running' | 'completed' | 'compensated' | 'failed';

interface SagaStep {
  step: string;
  kind: string;
  status: string;
  attempts: number;
  jobId?: string;
}

interface Saga {
  sagaId: string;
  orderId: string;
  failAt: string;
  state: SagaState;
  steps: SagaStep[];
  finishedAt: string | null;
}

const STATE_BADGE: Record<SagaState, { label: string; className: string }> = {
  running: {
    label: 'RUNNING',
    className:
      'rounded-md border border-outline bg-primary px-sm py-xs font-mono text-body-sm font-semibold text-on-primary',
  },
  completed: {
    label: 'COMPLETED',
    className:
      'rounded-md border border-secondary bg-secondary px-sm py-xs font-mono text-body-sm font-bold text-on-secondary',
  },
  compensated: {
    label: 'COMPENSATED',
    className:
      'rounded-md border border-error bg-error px-sm py-xs font-mono text-body-sm font-bold text-on-error',
  },
  failed: {
    label: 'FAILED',
    className:
      'rounded-md border border-error px-sm py-xs font-mono text-body-sm font-bold text-error',
  },
};

const STATUS_CHIP: Record<string, string> = {
  succeeded: 'rounded-md border border-secondary bg-secondary px-xs py-xxs font-mono text-caption font-semibold text-on-secondary',
  compensated: 'rounded-md border border-warning bg-warning px-xs py-xxs font-mono text-caption font-bold text-on-surface',
  'dead-lettered': 'rounded-md border border-error bg-error px-xs py-xxs font-mono text-caption font-bold text-on-error',
  skipped: 'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption text-on-surface-variant',
  pending: CHIP,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSaga(raw: unknown): Saga | null {
  if (!isRecord(raw) || typeof raw.sagaId !== 'string' || typeof raw.state !== 'string') return null;
  if (raw.state !== 'running' && raw.state !== 'completed' && raw.state !== 'compensated' && raw.state !== 'failed') {
    return null;
  }
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.step === 'string')
        .map((entry) => ({
          step: entry.step as string,
          kind: typeof entry.kind === 'string' ? entry.kind : 'forward',
          status: typeof entry.status === 'string' ? entry.status : 'pending',
          attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
          jobId: typeof entry.jobId === 'string' ? entry.jobId : undefined,
        }))
    : [];
  return {
    sagaId: raw.sagaId,
    orderId: typeof raw.orderId === 'string' ? raw.orderId : '',
    failAt: typeof raw.failAt === 'string' ? raw.failAt : 'none',
    state: raw.state,
    steps,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
  };
}

function parseSagaEnvelope(raw: unknown): Saga | null {
  return isRecord(raw) && isRecord(raw.saga) ? parseSaga(raw.saga) : null;
}

function clockOf(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

function kindChip(kind: string): string {
  return kind === 'compensation'
    ? 'rounded-md border border-warning px-xs py-xxs font-mono text-caption font-semibold text-on-surface'
    : CHIP;
}

function statusChip(status: string): string {
  return STATUS_CHIP[status] ?? CHIP;
}

async function callEndpoint(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `HTTP ${String(response.status)}`;
    try {
      const body = (await response.json()) as unknown;
      if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
        message = `${message} — ${body.error.message}`;
      }
    } catch {
      // the status-only message stands
    }
    throw new Error(message);
  }
  return response.json();
}

export default function OrderSagaDemo(): ReactNode {
  const [saga, setSaga] = useState<Saga | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [failAt, setFailAt] = useState('none');
  const aliveRef = useRef(true);
  const pollsRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** One poll of GET /saga/:id — BOUNDED: refuses past MAX_POLLS. */
  const pollNow = useCallback(async (): Promise<void> => {
    if (saga === null) return;
    if (pollsRef.current >= MAX_POLLS) {
      setTimedOut(true);
      return;
    }
    pollsRef.current += 1;
    try {
      const parsed = parseSagaEnvelope(await callEndpoint(`${BASE}/${saga.sagaId}`));
      if (parsed === null) throw new Error(MALFORMED);
      if (!aliveRef.current) return;
      setSaga(parsed);
      setError(null);
    } catch {
      if (aliveRef.current) {
        setError('the saga poll failed — the run continues server-side; press poll now to retry');
      }
    }
  }, [saga]);

  // Auto-poll while the saga is running; the budget in pollNow tears this
  // interval down when it runs out, so nothing loops forever.
  useEffect(() => {
    if (saga?.state !== 'running' || timedOut) return;
    const timer = setInterval(() => void pollNow(), POLL_MS);
    return () => clearInterval(timer);
  }, [saga, timedOut, pollNow]);

  const start = useCallback(async (): Promise<void> => {
    setStarting(true);
    setError(null);
    setTimedOut(false);
    pollsRef.current = 0;
    try {
      const trimmed = orderId.trim();
      const parsed = parseSagaEnvelope(
        await callEndpoint(`${BASE}/start`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ failAt, ...(trimmed !== '' && { orderId: trimmed }) }),
        }),
      );
      if (parsed === null) throw new Error(MALFORMED);
      if (!aliveRef.current) return;
      setSaga(parsed);
    } catch {
      if (aliveRef.current) {
        setError('the saga could not start — is the server running?');
      }
    } finally {
      if (aliveRef.current) setStarting(false);
    }
  }, [failAt, orderId]);

  const reset = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await callEndpoint(`${BASE}/reset`, { method: 'POST' });
      if (!aliveRef.current) return;
      setSaga(null);
      setTimedOut(false);
      pollsRef.current = 0;
    } catch {
      if (aliveRef.current) {
        setError('the saga manager could not be reset — is the server running?');
      }
    }
  }, []);

  const badge = STATE_BADGE[saga?.state ?? 'running'];

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="saga-summary" className="text-body-sm text-on-surface">
        A distributed transaction as a sequence of local ones. Four forward steps run as real queue
        jobs; inject a failure and watch the queue retry it (3 attempts, backoff) before its verdict:
        dead-lettered → the saga stops, skips the rest, and compensates in reverse — including the
        failed step. Terminal states are honest:{' '}
        <span className="font-mono">completed</span> (it all landed) or{' '}
        <span className="font-mono">compensated</span> (it unwound).
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            start an order saga — failure injection included
          </span>
          <span className={CHIP}>POST {BASE}/saga/start</span>
        </div>
        <div className="flex flex-wrap items-end gap-sm">
          <label className="flex w-56 flex-col gap-xxs">
            <span className={LABEL}>order id (optional)</span>
            <input
              data-testid="saga-orderid"
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              spellCheck={false}
              placeholder="auto"
              className={INPUT}
            />
          </label>
          <label className="flex flex-col gap-xxs">
            <span className={LABEL}>fail this step</span>
            <select
              data-testid="saga-failat"
              value={failAt}
              onChange={(event) => setFailAt(event.target.value)}
              className={SELECT}
            >
              <option value="none">none (happy path)</option>
              <option value="place-order">place-order</option>
              <option value="reserve-stock">reserve-stock</option>
              <option value="charge-card">charge-card</option>
              <option value="ship">ship</option>
            </select>
          </label>
          <button
            type="button"
            data-testid="saga-start"
            className={BUTTON_PRIMARY}
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? 'starting…' : 'start the saga'}
          </button>
        </div>
        {error !== null && (
          <p data-testid="saga-error" className="text-caption text-error">
            {error}
          </p>
        )}
      </section>

      {saga === null ? (
        <p data-testid="saga-empty" className="text-caption text-on-surface-variant">
          no saga yet — start one above.
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
            <div className="flex flex-wrap items-center gap-xs">
              <span data-testid="saga-state" className={badge.className}>
                {badge.label}
              </span>
              <span className={CHIP_STRONG}>{saga.orderId !== '' ? saga.orderId : saga.sagaId}</span>
              {saga.failAt !== 'none' && (
                <span data-testid="saga-failat-chip" className={CHIP}>
                  failure injected at: {saga.failAt}
                </span>
              )}
              {saga.finishedAt !== null && (
                <span className={CHIP}>finished {clockOf(saga.finishedAt)}Z</span>
              )}
            </div>
            <p className="text-caption text-on-surface-variant">
              {saga.state === 'running'
                ? `polling GET /api/demo/patterns/saga/${saga.sagaId} every ${String(POLL_MS)}ms — the queue's retries and backoff take a moment`
                : 'terminal — this saga will not change again; start a new one or reset.'}
            </p>
            <div className="flex flex-wrap items-center gap-xs">
              <button
                type="button"
                data-testid="saga-poll"
                className={BUTTON}
                disabled={saga.state !== 'running'}
                onClick={() => void pollNow()}
              >
                poll now
              </button>
              <button
                type="button"
                data-testid="saga-reset"
                className={BUTTON_DANGER}
                onClick={() => void reset()}
              >
                reset
              </button>
            </div>
            {timedOut && (
              <p data-testid="saga-poll-timeout" className="text-caption text-error">
                polling stopped after the budget — the saga may still be grinding through retries;
                press poll now to check again.
              </p>
            )}
          </section>

          <section
            data-testid="saga-steps"
            className="flex max-h-72 flex-col gap-xs overflow-y-auto rounded-md border border-outline bg-surface p-sm"
          >
            <span className="text-caption font-semibold text-on-surface">
              the step log — forward steps, then compensations unwinding in reverse
            </span>
            {saga.steps.map((step, index) => (
              <div
                key={`${step.step}-${String(index)}`}
                data-testid="saga-step-row"
                className="flex flex-wrap items-center gap-xs rounded-md border border-outline p-xs"
              >
                <span className={kindChip(step.kind)}>{step.kind}</span>
                <span className="font-mono text-caption font-semibold text-on-surface">{step.step}</span>
                <span className={statusChip(step.status)}>{step.status}</span>
                <span className={CHIP}>attempts ×{String(step.attempts)}</span>
                {step.jobId !== undefined && <span className={CHIP}>{step.jobId}</span>}
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
