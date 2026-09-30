import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';

/**
 * A hand-rolled CIRCUIT BREAKER — the reliability topic's core artifact, in
 * the same spirit as the job queue: the pattern built small enough to read in
 * one sitting, with nothing a production library (opossum,cockpit,resilience4j)
 * would hide.
 *
 * THE STATE MACHINE:
 *
 *   CLOSED ──3 consecutive failures──▶ OPEN ──cooldown elapses──▶ HALF_OPEN
 *      ▲                                  │                          │
 *      └──── 2 probes succeed ────────────┘        probe fails ──────┘
 *                                              (fresh cooldown, back to OPEN)
 *
 * - CLOSED: calls pass through; failures are counted CONSECUTIVELY (a success
 *   resets the streak). This file deliberately picks the consecutive-count
 *   variant over a rolling failure-RATE window: it is simpler to reason about,
 *   it is what you reach for first, and the rolling-rate version differs only
 *   in the bookkeeping of WHEN failures happened (the content names the
 *   tradeoff; production breakers usually rate-count because a slow trickle of
 *   errors forever can never trip a consecutive counter that keeps resetting).
 * - OPEN: calls are rejected FAST — resolved synchronously with an
 *   'unavailable' Failure, the dependency never touched, no latency paid.
 * - HALF_OPEN: after the cooldown, the breaker lets `halfOpenSuccesses` probes
 *   through. All probes succeeding CLOSES the circuit; one failing re-OPENS it
 *   with a FRESH cooldown. Extra calls beyond the probe budget are rejected
 *   fast until the episode resolves.
 *
 * A PER-CALL DEADLINE (`timeoutMs`) is built in: a call that exceeds it counts
 * as a failure — timeouts trip breakers too, which is the point of the demo's
 * 'slow' mode. The deadline races the operation via AbortController; the
 * signal is handed to the operation so well-behaved dependencies can cancel
 * their own work.
 *
 * TIMING IS FULLY INJECTABLE (`now`, `setTimeoutFn`, `clearTimeoutFn`) so the
 * specs drive a fake clock deterministically — the same contract the job queue
 * established. The cooldown transition is evaluated LAZILY (on execute() and
 * on stats()) and recorded in a transition-history ring, so the observable
 * state and the timeline the demo renders can never disagree.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Diagnostic name — surfaces in failures, stats, and logs. */
  readonly name: string;
  /** Consecutive failures that trip CLOSED → OPEN (default 3). */
  readonly failureThreshold?: number;
  /** How long OPEN holds before HALF_OPEN probes are allowed (default 4000). */
  readonly cooldownMs?: number;
  /** HALF_OPEN successes needed to CLOSE again (default 2). */
  readonly halfOpenSuccesses?: number;
  /** Per-call deadline; exceeding it counts as a failure. Omit for none. */
  readonly timeoutMs?: number;
  /** Epoch-ms clock — injectable for deterministic tests. */
  readonly now?: () => number;
  /** Timer primitives — injectable for deterministic tests. */
  readonly setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

export interface CircuitBreakerStats {
  readonly name: string;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  /** ISO instant of the most recent failure (any state); null when none yet. */
  readonly lastFailureAt: string | null;
  /** ISO instant of the most recent OPEN transition; null when never opened. */
  readonly openedAt: string | null;
  /** Calls rejected fast (open circuit + exhausted probe budget). */
  readonly totalRejected: number;
  readonly config: {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
    readonly halfOpenSuccesses: number;
    readonly timeoutMs: number | null;
  };
}

export interface CircuitTransition {
  readonly at: string;
  readonly from: CircuitState;
  readonly to: CircuitState;
  readonly reason: string;
}

/** The deadline raced the dependency and won — thrown internally, never leaks past execute(). */
class CircuitTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`call exceeded the ${String(timeoutMs)}ms deadline`);
    this.name = 'CircuitTimeoutError';
  }
}

/** Newest transitions kept for the demo timeline (the ring drops the oldest). */
const HISTORY_CAP = 20;

type SetTimerFn = (callback: () => void, ms: number) => unknown;

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenSuccessesTarget: number;
  private readonly timeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly setTimeoutFn: SetTimerFn;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureAtMs: number | null = null;
  private openedAtMs: number | null = null;
  private totalRejected = 0;
  /** Successes seen in the CURRENT half-open episode. */
  private halfOpenSuccessesSeen = 0;
  /** Probes still allowed through in the current half-open episode. */
  private halfOpenProbesLeft = 0;
  private readonly transitions: CircuitTransition[] = [];

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 4000;
    this.halfOpenSuccessesTarget = options.halfOpenSuccesses ?? 2;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /**
   * Runs one operation THROUGH the breaker. Expected failures come back as
   * Result failures — never throws — in the domain's house style:
   * - rejected fast (open / probe budget spent): 'unavailable' with
   *   details.rejectedFast = true, details.cooldownRemainingMs for the UI;
   * - deadline exceeded: 'unavailable' with details.timedOut = true;
   * - the operation itself failed: 'unavailable' carrying the cause.
   */
  async execute<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<Result<T, Failure>> {
    // Lazy cooldown evaluation — the same check stats() performs, so the two
    // can never disagree about when OPEN became HALF_OPEN.
    this.applyCooldownIfElapsed();

    if (this.state === 'open') {
      this.totalRejected += 1;
      return fail(this.rejectedFastFailure());
    }
    if (this.state === 'half_open' && this.halfOpenProbesLeft <= 0) {
      this.totalRejected += 1;
      return fail(
        failure(
          'unavailable',
          `circuit "${this.name}" is HALF_OPEN and its probe budget is spent — calls are rejected fast until the probes settle`,
          { circuit: this.name, rejectedFast: true },
        ),
      );
    }
    if (this.state === 'half_open') this.halfOpenProbesLeft -= 1;

    try {
      const value = await this.raceDeadline(operation);
      this.recordSuccess();
      return ok(value);
    } catch (err) {
      this.recordFailure();
      return fail(this.failureFor(err));
    }
  }

  /**
   * The observable snapshot. Performs the same lazy cooldown evaluation as
   * execute(), so polling stats() is what advances OPEN → HALF_OPEN — the
   * timeline the demo renders is the truth the next call would experience.
   */
  stats(): CircuitBreakerStats {
    this.applyCooldownIfElapsed();
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.isoOrNull(this.lastFailureAtMs),
      openedAt: this.isoOrNull(this.openedAtMs),
      totalRejected: this.totalRejected,
      config: {
        failureThreshold: this.failureThreshold,
        cooldownMs: this.cooldownMs,
        halfOpenSuccesses: this.halfOpenSuccessesTarget,
        timeoutMs: this.timeoutMs ?? null,
      },
    };
  }

  /** Ms until HALF_OPEN probes are allowed (0 unless currently OPEN). */
  cooldownRemainingMs(): number {
    if (this.state !== 'open' || this.openedAtMs === null) return 0;
    const elapsed = this.now() - this.openedAtMs;
    return Math.max(0, this.cooldownMs - elapsed);
  }

  /** The transition ring, oldest first, capped at HISTORY_CAP. */
  history(): CircuitTransition[] {
    return [...this.transitions];
  }

  // ---- internals -----------------------------------------------------------

  /** Races the operation against the deadline; the signal lets it self-cancel. */
  private raceDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let handle: unknown;
    if (this.timeoutMs !== undefined) {
      const timeoutMs = this.timeoutMs;
      handle = this.setTimeoutFn(() => controller.abort(), timeoutMs);
    }
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new CircuitTimeoutError(this.timeoutMs as number)),
        { once: true },
      );
    });
    const race = Promise.race([operation(controller.signal), deadline]);
    if (handle === undefined) return race; // no deadline configured — nothing to clean up
    return race.finally(() => this.clearTimeoutFn(handle));
  }

  private applyCooldownIfElapsed(): void {
    if (this.state !== 'open' || this.openedAtMs === null) return;
    if (this.now() - this.openedAtMs >= this.cooldownMs) {
      this.transition('half_open', 'cooldown elapsed — probing again');
    }
  }

  private recordSuccess(): void {
    if (this.state === 'half_open') {
      this.halfOpenSuccessesSeen += 1;
      if (this.halfOpenSuccessesSeen >= this.halfOpenSuccessesTarget) {
        this.transition('closed', 'half-open probes all succeeded');
      }
      return;
    }
    // CLOSED: a success resets the consecutive streak — that is the whole
    // point of counting consecutively.
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    this.lastFailureAtMs = this.now();
    this.consecutiveFailures += 1;
    if (this.state === 'half_open') {
      this.transition('open', 'half-open probe failed');
      return;
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.transition(
        'open',
        `${String(this.consecutiveFailures)} consecutive failures (threshold ${String(this.failureThreshold)})`,
      );
    }
  }

  /** The one place state ever changes — the ring is why the demo has a timeline. */
  private transition(to: CircuitState, reason: string): void {
    this.transitions.push({
      at: new Date(this.now()).toISOString(),
      from: this.state,
      to,
      reason,
    });
    if (this.transitions.length > HISTORY_CAP) this.transitions.shift();
    this.state = to;
    if (to === 'open') {
      this.openedAtMs = this.now();
    } else if (to === 'half_open') {
      this.halfOpenSuccessesSeen = 0;
      this.halfOpenProbesLeft = this.halfOpenSuccessesTarget;
    } else {
      this.openedAtMs = null;
      this.consecutiveFailures = 0;
    }
  }

  private rejectedFastFailure(): Failure {
    const remaining = this.cooldownRemainingMs();
    return failure(
      'unavailable',
      `circuit "${this.name}" is OPEN — rejected fast, the dependency was not called (${String(remaining)}ms of cooldown left)`,
      {
        circuit: this.name,
        rejectedFast: true,
        cooldownRemainingMs: remaining,
      },
    );
  }

  private failureFor(err: unknown): Failure {
    if (err instanceof CircuitTimeoutError) {
      return failure(
        'unavailable',
        `circuit "${this.name}": the call exceeded its ${String(err.timeoutMs)}ms deadline — slow counts as down`,
        { circuit: this.name, timedOut: true, timeoutMs: err.timeoutMs },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return failure('unavailable', `circuit "${this.name}": dependency call failed — ${message}`, {
      circuit: this.name,
    });
  }

  private isoOrNull(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
  }
}
