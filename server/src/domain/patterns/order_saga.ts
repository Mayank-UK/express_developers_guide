import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import { JobQueue, type Job } from '../jobs/job_queue.js';

/**
 * A SAGA (process manager) for a distributed order — the advanced-architecture
 * topic's exhibit, built ON TOP of the existing domain/jobs/job_queue.ts
 * rather than beside it: the saga owns a dedicated JobQueue INSTANCE and every
 * step is a real job in it, so the step lifecycle gets the queue's REAL
 * semantics — FIFO pickup, retry with exponential backoff + jitter, and the
 * dead-letter verdict. Nothing here rebuilds any of that.
 *
 * WHY 'email' JOBS CARRY THE STEPS (an honest constraint, stated plainly):
 * the queue's job types are its teaching surface ('email' | 'report') and its
 * failure-injection contract rides the payload (alwaysFail / forceFailures).
 * A queue-based saga in the wild does exactly this — the step's identity
 * lives in the message body, not the message type. So each forward step is an
 * email job whose payload names the step, and injecting a failure at a step
 * rides the very same alwaysFail knob the background-jobs topic taught.
 *
 * THE JOB-QUEUE INTERPLAY DECISION (deliberate, and load-bearing):
 * a failing forward step IS retried by the queue before the saga gives up —
 * 3 total attempts with ~300ms/~600ms backoff (demo defaults, ±20% jitter).
 * Transient failures are the queue's to absorb; compensation begins ONLY when
 * the queue returns its final verdict (status 'dead', i.e. dead-lettered).
 * That both bounds the wait (≤ ~2s per failing step at demo timing) and
 * matches the real-world rule: compensate on FINAL failure, never on first
 * error — a saga that compensates on every hiccup undoes work that was about
 * to succeed.
 *
 * COMPENSATION SEMANTICS:
 * - every ATTEMPTED forward step is compensated, in REVERSE order — including
 *   the failed one. "Failed" here means failed-to-CONFIRM: the card charge
 *   may still have landed, so refund-card must run regardless.
 * - compensations are IDEMPOTENT BY CONTRACT (release-stock on stock that was
 *   never reserved is a no-op, a second refund-card finds nothing to refund)
 *   and are never failure-injected — in a real system they retry until they
 *   succeed, because a stuck half-compensated saga is worse than the original
 *   failure. The queue's retry budget is exactly that mechanism.
 * - later forward steps after the failure are marked 'skipped' — never run,
 *   never compensated.
 */

export const SAGA_FORWARD_STEPS = ['place-order', 'reserve-stock', 'charge-card', 'ship'] as const;
export type SagaForwardStep = (typeof SAGA_FORWARD_STEPS)[number];

/** The undo for each forward step — run in reverse order on failure. */
export const SAGA_COMPENSATIONS: Readonly<Record<SagaForwardStep, string>> = {
  'place-order': 'cancel-order',
  'reserve-stock': 'release-stock',
  'charge-card': 'refund-card',
  ship: 'cancel-shipment',
};

export type SagaState = 'running' | 'completed' | 'compensated' | 'failed';

export type SagaStepStatus = 'attempted' | 'succeeded' | 'dead-lettered' | 'skipped' | 'compensated';

export interface SagaStepRecord {
  readonly step: string;
  readonly kind: 'forward' | 'compensation';
  /** The queue job that executed it (absent for skipped steps). */
  jobId?: string;
  status: SagaStepStatus;
  /** Queue attempts consumed (0 for skipped). */
  attempts: number;
  readonly at: string;
}

export interface OrderSaga {
  readonly sagaId: string;
  readonly orderId: string;
  /** The injected failure point: this forward step always fails. */
  readonly failAt: SagaForwardStep | 'none';
  state: SagaState;
  readonly steps: SagaStepRecord[];
  readonly startedAt: string;
  finishedAt: string | null;
  lastError?: string;
}

/** Terminal job statuses — everything the saga needs to know about a step. */
const TERMINAL: readonly Job['status'][] = ['succeeded', 'dead'];

/** Poll interval for a step job's terminal state (generous, never racy). */
const STEP_POLL_INTERVAL_MS = 25;
/** Hard budget for one step to reach a terminal state (failing steps: 3 attempts + backoff ≈ 2s). */
const STEP_BUDGET_MS = 20_000;

/** Timer primitive shape — mirrors job_queue.ts (injectable for fake clocks). */
type SagaSetTimerFn = (callback: () => void, ms: number) => unknown;

/**
 * What a SagaManager runs on. TIMING AND THE QUEUE ARE FULLY INJECTABLE
 * (`now`, `setTimeoutFn`, `queue`) so specs can drive the whole state machine
 * on a fake clock — same discipline as the queue and the circuit breaker
 * (its siblings in determinism). Defaults are the real primitives and a fresh
 * dedicated queue, which is what the demo singleton below wires.
 */
export interface SagaManagerOptions {
  /** Epoch-ms clock — the saga's single time authority (timestamps + budgets). */
  now?: () => number;
  /** Timer primitive — polling rides it; a fake clock advances it, never sleeps. */
  setTimeoutFn?: SagaSetTimerFn;
  /** The saga's dedicated queue — defaults to a fresh JobQueue. */
  queue?: JobQueue;
}

export class SagaManager {
  /** The saga's OWN queue instance — the jobs demo's board stays clean. */
  private readonly queue: JobQueue;
  private readonly sagas = new Map<string, OrderSaga>();
  private nextSagaNumber = 0;
  private readonly now: () => number;
  private readonly setTimeoutFn: SagaSetTimerFn;

  constructor(options: SagaManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.queue = options.queue ?? new JobQueue();
  }

  list(): readonly OrderSaga[] {
    return [...this.sagas.values()];
  }

  get(sagaId: string): OrderSaga | undefined {
    return this.sagas.get(sagaId);
  }

  /** ISO timestamp from the injected clock — one time authority per saga. */
  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Starts an order saga and returns IMMEDIATELY — the state machine runs in
   * the background (steps are real queue jobs with real latency), and the UI
   * polls GET /saga/:id until the state is terminal.
   */
  start(orderId: string, failAt: SagaForwardStep | 'none'): OrderSaga {
    this.nextSagaNumber += 1;
    const saga: OrderSaga = {
      sagaId: `saga_${String(this.nextSagaNumber)}`,
      orderId,
      failAt,
      state: 'running',
      steps: [],
      startedAt: this.isoNow(),
      finishedAt: null,
    };
    this.sagas.set(saga.sagaId, saga);
    void this.run(saga); // floating by design — the record IS the progress log
    return saga;
  }

  /** Demo/spec reset: a fresh manager drops sagas and the queue's jobs. */
  clear(): void {
    this.queue.clear();
    this.sagas.clear();
    this.nextSagaNumber = 0;
  }

  // ---- the state machine ---------------------------------------------------

  private async run(saga: OrderSaga): Promise<void> {
    try {
      for (const step of SAGA_FORWARD_STEPS) {
        if (saga.state !== 'running') return; // defensive — a reset can interleave
        const record: SagaStepRecord = {
          step,
          kind: 'forward',
          status: 'attempted',
          attempts: 0,
          at: this.isoNow(),
        };
        saga.steps.push(record);
        const outcome = await this.runStepJob(saga, step, record, saga.failAt === step);

        if (outcome === 'succeeded') {
          record.status = 'succeeded';
          continue;
        }
        if (outcome === 'dead-lettered') {
          record.status = 'dead-lettered';
          // Every later forward step is skipped — never run, never compensated.
          for (const later of SAGA_FORWARD_STEPS.slice(SAGA_FORWARD_STEPS.indexOf(step) + 1)) {
            saga.steps.push({
              step: later,
              kind: 'forward',
              status: 'skipped',
              attempts: 0,
              at: this.isoNow(),
            });
          }
          await this.compensate(saga);
          // compensate() flips the state to 'failed' itself if a compensation
          // could not complete — only an intact unwind says 'compensated'.
          if (saga.state === 'running') saga.state = 'compensated';
          saga.finishedAt = this.isoNow();
          return;
        }
        // outcome === 'timeout' — cannot happen with the queue's own bounded
        // retries, but a saga must never hang silently: it fails LOUDLY.
        saga.state = 'failed';
        saga.lastError = `step "${step}" never reached a terminal state within ${String(STEP_BUDGET_MS)}ms`;
        saga.finishedAt = this.isoNow();
        return;
      }
      saga.state = 'completed';
      saga.finishedAt = this.isoNow();
    } catch (error) {
      saga.state = 'failed';
      saga.lastError = error instanceof Error ? error.message : String(error);
      saga.finishedAt = this.isoNow();
    }
  }

  /**
   * Polls the predicate on the INJECTED clock/timer — real timers by default,
   * a fake clock in specs (advance() fires the ticks; nothing ever sleeps).
   */
  private waitUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const startedAt = this.now();
      const tick = (): void => {
        if (predicate()) {
          resolve(true);
          return;
        }
        if (this.now() - startedAt > budgetMs) {
          resolve(false);
          return;
        }
        this.setTimeoutFn(tick, STEP_POLL_INTERVAL_MS);
      };
      tick();
    });
  }

  /**
   * Runs one step as a real queue job and awaits its terminal state.
   * alwaysFail is the injected-failure knob (the jobs topic's own contract);
   * the queue retries it to exhaustion, then dead-letters it — the saga only
   * reacts to the verdict.
   */
  private async runStepJob(
    saga: OrderSaga,
    step: string,
    record: SagaStepRecord,
    alwaysFail: boolean,
  ): Promise<'succeeded' | 'dead-lettered' | 'timeout'> {
    const enqueued = this.queue.enqueue('email', {
      to: 'saga-worker@example.com',
      subject: `order ${saga.orderId}: ${step}`,
      // forceFailures would also work for "fails twice then succeeds" steps;
      // alwaysFail is the clean "this step is broken" injection.
      alwaysFail,
    });
    if (!enqueued.ok) return 'timeout'; // cannot happen for a known type — treated as a hang
    const job = enqueued.value;
    record.jobId = job.id;

    const done = await this.waitUntil(() => TERMINAL.includes(this.queue.get(job.id)?.status ?? 'queued'), STEP_BUDGET_MS);
    const finalJob = this.queue.get(job.id);
    if (!done || finalJob === undefined) return 'timeout';
    record.attempts = finalJob.attempts;
    return finalJob.status === 'succeeded' ? 'succeeded' : 'dead-lettered';
  }

  /**
   * Undoes every ATTEMPTED forward step, in reverse — including the failed
   * one (failed-to-confirm is not did-not-happen). Compensations are jobs
   * too, so they get the queue's retries; they are never failure-injected.
   */
  private async compensate(saga: OrderSaga): Promise<void> {
    const attempted = saga.steps.filter(
      (record) => record.kind === 'forward' && record.status !== 'skipped',
    );
    for (const forward of [...attempted].reverse()) {
      const compensationName = SAGA_COMPENSATIONS[forward.step as SagaForwardStep];
      const record: SagaStepRecord = {
        step: compensationName,
        kind: 'compensation',
        status: 'attempted',
        attempts: 0,
        at: this.isoNow(),
      };
      saga.steps.push(record);
      const outcome = await this.runStepJob(
        saga,
        `${compensationName} (undoes ${forward.step})`,
        record,
        false, // compensations never fail on purpose — see the header
      );
      record.status = outcome === 'succeeded' ? 'compensated' : 'dead-lettered';
      if (outcome !== 'succeeded') {
        // A compensation that dead-letters leaves the saga half-undone — the
        // loudest state a saga has. Real systems page a human here.
        saga.state = 'failed';
        saga.lastError = `compensation "${compensationName}" could not complete`;
      }
    }
  }
}

// --- the demo singleton --------------------------------------------------------

let demoManager: SagaManager | undefined;

export interface SagaStartInput {
  readonly orderId?: string;
  readonly failAt?: SagaForwardStep | 'none';
}

/** Starts (or returns) the demo saga manager's saga — thin validated entry point. */
export function startOrderSaga(input: SagaStartInput): Result<OrderSaga, Failure> {
  // Defensive by contract: the input type says string, but the domain never
  // trusts its caller's runtime — a non-blank string or omission (one is
  // generated), nothing else. Same shape as the failAt rejection below.
  if (input.orderId !== undefined && (typeof input.orderId !== 'string' || input.orderId.trim() === '')) {
    return fail(
      failure('validation', '"orderId" must be a non-blank string (omit it and one is generated)', {
        parameter: 'orderId',
        received: input.orderId,
      }),
    );
  }
  const failAt = input.failAt ?? 'none';
  if (failAt !== 'none' && !SAGA_FORWARD_STEPS.includes(failAt)) {
    return fail(
      failure('validation', `"failAt" must be one of the saga's forward steps or "none"`, {
        parameter: 'failAt',
        received: failAt,
        supported: [...SAGA_FORWARD_STEPS, 'none'],
      }),
    );
  }
  const manager = getDemoSagaManager();
  const orderId = input.orderId ?? `order-${String(manager.list().length + 1)}`;
  return ok(manager.start(orderId, failAt));
}

export function findDemoSaga(id: string): OrderSaga | undefined {
  return getDemoSagaManager().get(id);
}

export function listDemoSagas(): readonly OrderSaga[] {
  return getDemoSagaManager().list();
}

function getDemoSagaManager(): SagaManager {
  demoManager ??= new SagaManager();
  return demoManager;
}

/** Test/demo reset: fresh manager, fresh queue — specs never share sagas. */
export function resetDemoSagaManager(): void {
  demoManager?.clear();
  demoManager = new SagaManager();
}
