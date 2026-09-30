import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';

/**
 * A hand-rolled, in-process JOB QUEUE — the background-jobs topic's core
 * artifact. No Redis, no BullMQ: the queue itself IS the lesson. Every concept
 * a production queue gives you is here, built small enough to read in one
 * sitting: jobs (id/type/payload), a FIFO worker loop (concurrency 1 — say
 * why), attempts with exponential backoff + jitter, a dead-letter state with
 * replay, a cron-ish scheduler, and the stats that make it observable.
 *
 * TIMING IS FULLY INJECTABLE (`now`, `setTimeoutFn`, `clearTimeoutFn`) so the
 * specs drive a fake clock deterministically instead of racing real timers.
 *
 * HONESTY NOTES, because the defaults are deliberately demo-snappy:
 * - baseDelayMs defaults to 300 (retry backoff ≈ 300ms, 600ms, …) so the live
 *   demo shows a full retry cycle in about a second. Real-world backoff is
 *   SECONDS-scale — the content documents a realistic 1000ms base (1s, 2s, 4s)
 *   and the code is identical; only the constant changes.
 * - The email handler uses a SIMULATED sender (injected latency + injected
 *   failures). A real transport (nodemailer) lands with the third-party
 *   services section; the queue's contract does not change when it does.
 * - The report handler counts rows from a STATIC teaching fixture instead of
 *   the posts pipeline: wiring the container in here would point the domain
 *   layer at the composition root (an inverted dependency) and couple the
 *   lesson to the fake/live data-mode toggle. Self-contained is the honest
 *   teaching shape.
 */

export const JOB_TYPES = ['email', 'report'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';

export type JobEvent =
  | 'enqueued'
  | 'running'
  | 'succeeded'
  | 'retry_scheduled'
  | 'dead_lettered'
  | 'requeued';

export interface JobHistoryEntry {
  /** ISO timestamp of the event. */
  at: string;
  event: JobEvent;
  /** 1-based attempt number the event belongs to. */
  attempt?: number;
  /** Backoff applied before the next try (retry_scheduled only). */
  delayMs?: number;
  /** The error that ended the attempt (dead_lettered only). */
  lastError?: string;
}

/** The public job shape — exactly what the demo routes serialize. */
export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  /** Failed attempts so far (retries used); 0 until a run fails. */
  attempts: number;
  history: JobHistoryEntry[];
  createdAt: string;
  /** When the worker may next pick this job up (ISO) — createdAt, or now+backoff after a failure. */
  runAt: string;
  result?: Record<string, unknown>;
  lastError?: string;
}

export interface SchedulerState {
  running: boolean;
  lastRunAt: string | null;
  intervalMs: number;
}

export interface JobQueueStats {
  queued: number;
  running: number;
  succeeded: number;
  dead: number;
  totalEnqueued: number;
  /** Age of the oldest QUEUED job (the alert-worthy number); null when idle. */
  oldestQueuedAgeMs: number | null;
  scheduler: SchedulerState;
  config: { baseDelayMs: number; maxAttempts: number };
}

export interface JobQueueOptions {
  /** Retry backoff base (attempt n waits ≈ base × 2^(n-1) ± 20%). */
  baseDelayMs?: number;
  /** Total tries before a job is dead-lettered. */
  maxAttempts?: number;
  /** Epoch-ms clock — injectable for deterministic tests. */
  now?: () => number;
  /** Timer primitives — injectable for deterministic tests. */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/** The static teaching source the report handler counts — see header note. */
const TEACHING_REPORT_ROWS: readonly { slug: string; author: string }[] = [
  { slug: 'why-background-jobs', author: 'the guide' },
  { slug: 'anatomy-of-a-queue', author: 'the guide' },
  { slug: 'retries-and-backoff', author: 'the guide' },
];

/** DEMO defaults: snappy enough to watch. Real-world values live in content. */
export const DEMO_BASE_DELAY_MS = 300;
export const DEMO_MAX_ATTEMPTS = 3;
export const DEMO_SCHEDULER_INTERVAL_MS = 5000;
export const SCHEDULER_INTERVAL_MS_MIN = 1000;
export const SCHEDULER_INTERVAL_MS_MAX = 60000;

/** Email latency is randomized 80–200ms to feel like a real SMTP hop. */
const EMAIL_LATENCY_MIN_MS = 80;
const EMAIL_LATENCY_MAX_MS = 200;
/** Backoff jitter: ±20% so a fleet of retries cannot sync up. */
const JITTER_FRACTION = 0.2;

type SetTimerFn = (callback: () => void, ms: number) => unknown;

interface JobRecord {
  job: Job;
  createdAtMs: number;
  runAtMs: number;
}

interface HandlerOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export class JobQueue {
  private readonly baseDelayMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: SetTimerFn;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  /** Insertion-ordered (FIFO) job table; list() reads it reversed for newest-first. */
  private readonly jobs = new Map<string, JobRecord>();
  private nextSeq = 0;
  private totalEnqueued = 0;

  // ---- the worker loop's plumbing ---------------------------------------
  /** True while a handler is awaiting — this is what makes concurrency 1. */
  private processing = false;
  private drainTimer: unknown;
  /** Guards the fired-before-cleared timer race (stale ticks no-op). */
  private drainGeneration = 0;

  // ---- the scheduler's plumbing -----------------------------------------
  private schedulerRunning = false;
  private schedulerIntervalMs = DEMO_SCHEDULER_INTERVAL_MS;
  private schedulerLastRunAt: string | null = null;
  private schedulerTick = 0;
  private schedulerTimer: unknown;
  /** Bumped on every setScheduler call — pending chained ticks of an older configuration die with it. */
  private schedulerGeneration = 0;

  constructor(options: JobQueueOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? DEMO_BASE_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? DEMO_MAX_ATTEMPTS;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /**
   * Enqueue a job: validate type + payload, mint `job_<seq>`, and wake the
   * worker loop. Returns a Result — the domain never throws for expected
   * failures; the route edge maps this onto the 400 envelope.
   */
  enqueue(type: string, payload: unknown): Result<Job, Failure> {
    if (!JOB_TYPES.includes(type as JobType)) {
      return fail(
        failure('validation', `"type" must be one of the known job types (got "${String(type)}")`, {
          parameter: 'type',
          supported: [...JOB_TYPES],
        }),
      );
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return fail(
        failure('validation', '"payload" must be a JSON object', {
          parameter: 'payload',
          received: Array.isArray(payload) ? 'array' : typeof payload,
        }),
      );
    }

    const nowMs = this.now();
    const at = this.isoFromMs(nowMs);
    const job: Job = {
      id: `job_${(this.nextSeq += 1)}`,
      type: type as JobType,
      payload: { ...(payload as Record<string, unknown>) },
      status: 'queued',
      attempts: 0,
      history: [{ at, event: 'enqueued' }],
      createdAt: at,
      runAt: at,
    };
    this.jobs.set(job.id, { job, createdAtMs: nowMs, runAtMs: nowMs });
    this.totalEnqueued += 1;
    this.scheduleDrain(0);
    return ok(job);
  }

  /** The job table, newest first. */
  list(): Job[] {
    return [...this.jobs.values()].map((record) => record.job).reverse();
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  /**
   * Replay a dead-lettered job: attempts reset (it gets a fresh retry
   * budget), history is KEPT (the postmortem survives the replay). Only dead
   * jobs qualify — requeueing a succeeded job is how duplicate emails happen.
   */
  requeue(id: string): Result<Job, Failure> {
    const record = this.jobs.get(id);
    if (record === undefined) {
      return fail(failure('not_found', `no job with id "${id}"`, { jobId: id }));
    }
    if (record.job.status !== 'dead') {
      return fail(
        failure('validation', `only dead-lettered jobs can be requeued (job is "${record.job.status}")`, {
          jobId: id,
          status: record.job.status,
          hint: 'a succeeded job already ran — requeueing it would duplicate its side effect',
        }),
      );
    }
    const nowMs = this.now();
    record.job.status = 'queued';
    record.job.attempts = 0;
    record.runAtMs = nowMs;
    record.job.runAt = this.isoFromMs(nowMs);
    record.job.history.push({ at: record.job.runAt, event: 'requeued' });
    this.scheduleDrain(0);
    return ok(record.job);
  }

  /** The queue's counters — the two numbers that matter for alerts are here. */
  stats(): JobQueueStats {
    let queued = 0;
    let running = 0;
    let succeeded = 0;
    let dead = 0;
    let oldestQueuedCreatedAtMs: number | undefined;
    for (const record of this.jobs.values()) {
      switch (record.job.status) {
        case 'queued':
          queued += 1;
          if (oldestQueuedCreatedAtMs === undefined || record.createdAtMs < oldestQueuedCreatedAtMs) {
            oldestQueuedCreatedAtMs = record.createdAtMs;
          }
          break;
        case 'running':
          running += 1;
          break;
        case 'succeeded':
          succeeded += 1;
          break;
        case 'dead':
          dead += 1;
          break;
      }
    }
    const nowMs = this.now();
    return {
      queued,
      running,
      succeeded,
      dead,
      totalEnqueued: this.totalEnqueued,
      oldestQueuedAgeMs:
        oldestQueuedCreatedAtMs === undefined ? null : Math.max(0, nowMs - oldestQueuedCreatedAtMs),
      scheduler: this.schedulerState(),
      config: { baseDelayMs: this.baseDelayMs, maxAttempts: this.maxAttempts },
    };
  }

  /**
   * Turn the cron-ish scheduler on/off. SET semantics: exactly one chain of
   * ticks ever runs — every call bumps the generation, so a pending tick from
   * an older configuration fires into a guard and dies instead of stacking a
   * second interval (the classic setScheduler bug the specs hunt for).
   */
  setScheduler(running: boolean, intervalMs: number = DEMO_SCHEDULER_INTERVAL_MS): SchedulerState {
    this.schedulerGeneration += 1;
    if (this.schedulerTimer !== undefined) {
      this.clearTimeoutFn(this.schedulerTimer);
      this.schedulerTimer = undefined;
    }
    this.schedulerRunning = running;
    if (running) {
      this.schedulerIntervalMs = clamp(
        intervalMs,
        SCHEDULER_INTERVAL_MS_MIN,
        SCHEDULER_INTERVAL_MS_MAX,
      );
      this.armSchedulerTick(this.schedulerIntervalMs);
    }
    return this.schedulerState();
  }

  /** Demo/testing reset: drops every job and stops the scheduler. */
  clear(): void {
    this.setScheduler(false);
    this.jobs.clear();
    this.totalEnqueued = 0;
    this.schedulerTick = 0;
  }

  // ---- the worker loop ----------------------------------------------------

  /**
   * Arm the ONE drain tick. If a tick is already pending it is replaced (a
   * sooner deadline must not wait out a later one); generation-guarded so a
   * real-timer tick that fired between scheduling and clearing no-ops instead
   * of racing its replacement.
   */
  private scheduleDrain(delayMs: number): void {
    this.drainGeneration += 1;
    const generation = this.drainGeneration;
    if (this.drainTimer !== undefined) this.clearTimeoutFn(this.drainTimer);
    this.drainTimer = this.setTimeoutFn(() => {
      if (generation !== this.drainGeneration) return; // stale — a newer tick owns the slot
      this.drainTimer = undefined;
      void this.drainTick();
    }, Math.max(0, delayMs));
  }

  /**
   * One drain pass: take the FIRST queued job whose runAt has arrived (FIFO
   * among due jobs), run it, apply the outcome, and keep draining. Work is
   * strictly serial — `processing` is the lock — which keeps the demo's state
   * machine honest; real workers go concurrent with a pool (and pay for it
   * with per-resource rate limits, see the content).
   */
  private async drainTick(): Promise<void> {
    if (this.processing) return;

    const due = [...this.jobs.values()].find(
      (record) => record.job.status === 'queued' && record.runAtMs <= this.now(),
    );
    if (due === undefined) {
      // Nothing due — re-arm for the earliest future runAt (or run out of work).
      const nextRunAtMs = [...this.jobs.values()]
        .filter((record) => record.job.status === 'queued')
        .map((record) => record.runAtMs)
        .sort((a, b) => a - b)[0];
      if (nextRunAtMs !== undefined) this.scheduleDrain(nextRunAtMs - this.now());
      return;
    }

    // The concurrency-1 lock must be exception-safe: handlers report EXPECTED
    // failures as Results, but a handler BUG throws — and without a finally
    // that throw would strand processing at true, so every later drainTick
    // would no-op at the guard and the queue would silently halt. (The
    // outcome block inside the try is synchronous, so holding the lock
    // across it changes nothing.)
    this.processing = true;
    try {
      const { job } = due;
      job.status = 'running';
      job.history.push({ at: this.isoNow(), event: 'running', attempt: job.attempts + 1 });

      const outcome = await this.runHandler(job);

      if (outcome.ok) {
        job.status = 'succeeded';
        job.result = outcome.result;
        job.history.push({ at: this.isoNow(), event: 'succeeded', attempt: job.attempts + 1 });
      } else {
        job.attempts += 1;
        job.lastError = outcome.error;
        if (job.attempts < this.maxAttempts) {
          const delayMs = this.backoffDelayMs(job.attempts);
          const runAtMs = this.now() + delayMs;
          job.status = 'queued';
          due.runAtMs = runAtMs;
          job.runAt = this.isoFromMs(runAtMs);
          job.history.push({
            at: this.isoNow(),
            event: 'retry_scheduled',
            attempt: job.attempts,
            delayMs,
          });
        } else {
          job.status = 'dead';
          job.history.push({
            at: this.isoNow(),
            event: 'dead_lettered',
            attempt: job.attempts,
            lastError: outcome.error,
          });
        }
      }
    } finally {
      this.processing = false;
    }

    this.scheduleDrain(0); // keep draining — there may be more work behind this one
  }

  /**
   * Exponential backoff WITH jitter: attempt n waits base × 2^(n-1), ±20%.
   * The jitter is not decoration — without it every failed job in a burst
   * retries in lockstep and the dependency they all share gets thundering-herded.
   */
  private backoffDelayMs(attempt: number): number {
    const raw = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = raw * JITTER_FRACTION * (Math.random() * 2 - 1);
    return Math.max(1, Math.round(raw + jitter));
  }

  // ---- the handlers -------------------------------------------------------

  private async runHandler(job: Job): Promise<HandlerOutcome> {
    if (job.type === 'email') return this.simulatedEmailSender(job);
    return this.buildReport(job);
  }

  /**
   * The SIMULATED sender: a random 80–200ms latency to feel like an SMTP hop,
   * plus failure injection knobs so retries and dead-lettering are watchable:
   * - alwaysFail: true        → never succeeds (a poison message)
   * - forceFailures: n        → fails the first n attempts, then succeeds
   * - latencyMs: number       → fixed latency override (demos + the serial-worker proof)
   * A REAL transport (nodemailer) lands with the third-party services section;
   * the queue's contract stays exactly this shape.
   */
  private async simulatedEmailSender(job: Job): Promise<HandlerOutcome> {
    const payload = job.payload;
    const latencyMs =
      typeof payload.latencyMs === 'number' && Number.isFinite(payload.latencyMs)
        ? clamp(payload.latencyMs, 10, 2000)
        : EMAIL_LATENCY_MIN_MS + Math.random() * (EMAIL_LATENCY_MAX_MS - EMAIL_LATENCY_MIN_MS);
    await this.sleep(latencyMs);

    if (payload.alwaysFail === true) {
      return { ok: false, error: 'simulated sender: alwaysFail requested — this job can never succeed' };
    }
    const forceFailures =
      typeof payload.forceFailures === 'number' && Number.isFinite(payload.forceFailures)
        ? Math.max(0, Math.floor(payload.forceFailures))
        : 0;
    if (forceFailures > job.attempts) {
      return {
        ok: false,
        error: `simulated sender: injected failure ${String(job.attempts + 1)} of ${String(forceFailures)}`,
      };
    }
    return {
      ok: true,
      result: {
        to: typeof payload.to === 'string' && payload.to !== '' ? payload.to : 'student@example.com',
        subject:
          typeof payload.subject === 'string' && payload.subject !== ''
            ? payload.subject
            : 'Welcome',
        simulated: true,
        latencyMs,
      },
    };
  }

  /**
   * The report job: the queue's "slow but reliable" workload. Row count comes
   * from a static teaching fixture — deliberately NOT the posts pipeline, so
   * the queue stays a self-contained lesson (see the header's honesty notes).
   */
  private async buildReport(_job: Job): Promise<HandlerOutcome> {
    await this.sleep(100);
    return { ok: true, result: { rows: TEACHING_REPORT_ROWS.length } };
  }

  /** Sleep through the INJECTED timer so fake-clock tests stay deterministic. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setTimeoutFn(() => resolve(), ms);
    });
  }

  // ---- the scheduler ------------------------------------------------------

  private armSchedulerTick(delayMs: number): void {
    const generation = this.schedulerGeneration;
    this.schedulerTimer = this.setTimeoutFn(() => {
      if (generation !== this.schedulerGeneration) return; // replaced/off — this chain is dead
      this.schedulerTimer = undefined;
      this.schedulerTick += 1;
      this.schedulerLastRunAt = this.isoNow();
      this.enqueue('report', { source: 'scheduler', tick: this.schedulerTick });
      this.armSchedulerTick(this.schedulerIntervalMs);
    }, Math.max(0, delayMs));
  }

  private schedulerState(): SchedulerState {
    return {
      running: this.schedulerRunning,
      lastRunAt: this.schedulerLastRunAt,
      intervalMs: this.schedulerIntervalMs,
    };
  }

  private isoNow(): string {
    return this.isoFromMs(this.now());
  }

  private isoFromMs(ms: number): string {
    return new Date(ms).toISOString();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---- the demo singleton ----------------------------------------------------

let demoQueue: JobQueue | undefined;

/** The process-global queue the demo routes talk to (demo-snappy defaults). */
export function getDemoJobQueue(): JobQueue {
  demoQueue ??= new JobQueue();
  return demoQueue;
}

/**
 * Test/demo reset: stops the old queue's scheduler, drops its jobs, and hands
 * out a fresh instance (clock/timers are per-instance, so old fake timers
 * cannot leak into the next test).
 */
export function resetJobQueueForTests(): void {
  demoQueue?.clear();
  demoQueue = new JobQueue();
}
