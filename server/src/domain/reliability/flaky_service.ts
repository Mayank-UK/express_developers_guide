import { CircuitBreaker } from './circuit_breaker.js';

/**
 * A FLAKY DEPENDENCY SIMULATOR — the reliability topic's stand-in for the
 * weather API / payment gateway / third-party recommender you cannot test
 * against. One knob, three positions:
 *
 * - 'healthy' — answers successfully after ~50ms (the good day)
 * - 'failing' — FAILS after ~50ms (the dependency is up and saying no)
 * - 'slow'    — would answer after 800ms, but the demo breaker's 300ms
 *               deadline aborts the call first — slow counts as down
 *
 * The call takes an AbortSignal (handed over by the breaker's deadline race):
 * on abort the simulated hop is CANCELLED, not merely abandoned — the sleep
 * timer is cleared, so the failure mode teaches real cancellation instead of a
 * promise nobody listens to anymore.
 *
 * TIMING IS INJECTABLE (same contract as the job queue / breaker) so specs
 * drive a fake clock: the 800ms "slow" hop never costs 800 real milliseconds
 * in a test.
 */

export const FLAKY_MODES = ['healthy', 'failing', 'slow'] as const;
export type FlakyMode = (typeof FLAKY_MODES)[number];

/** Simulated per-mode latencies (ms) — demo-snappy, honestly documented. */
export const FLAKY_LATENCIES_MS: Readonly<Record<FlakyMode, number>> = {
  healthy: 50,
  failing: 50,
  slow: 800,
};

/** The deadline the demo breaker enforces — 'slow' (800ms) can never beat it. */
export const DEMO_CALL_TIMEOUT_MS = 300;

export interface FlakyServiceOptions {
  readonly setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

export interface FlakyCallResult {
  readonly mode: FlakyMode;
  readonly note: string;
}

export class FlakyService {
  private mode: FlakyMode = 'healthy';
  private readonly setTimeoutFn: (callback: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(options: FlakyServiceOptions = {}) {
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  get currentMode(): FlakyMode {
    return this.mode;
  }

  setMode(mode: FlakyMode): void {
    this.mode = mode;
  }

  /** One simulated hop. Resolves on 'healthy', rejects on 'failing', and on
   * 'slow' resolves eventually — IF nobody aborts first (the breaker will). */
  call(signal?: AbortSignal): Promise<FlakyCallResult> {
    const mode = this.mode;
    return this.sleep(FLAKY_LATENCIES_MS[mode], signal).then(() => {
      if (mode === 'failing') {
        throw new Error('simulated dependency failure — the service answered "no"');
      }
      return {
        mode,
        note:
          mode === 'slow'
            ? 'answered slowly — only reachable with the deadline disabled'
            : 'the dependency answered',
      };
    });
  }

  /**
   * A cancellable sleep: the timer fires with success, an abort signal fires
   * with a rejection, whichever comes first — and the loser is cleaned up.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('aborted before the call started'));
        return;
      }
      let settled = false;
      let handle: unknown;
      const onAbort = (): void => {
        finish(new Error('aborted — the deadline raced the dependency and won'));
      };
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (handle !== undefined) this.clearTimeoutFn(handle);
        signal?.removeEventListener('abort', onAbort);
        if (err !== undefined) reject(err);
        else resolve();
      };
      handle = this.setTimeoutFn(() => finish(), ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

// ---- the demo world ----------------------------------------------------------

export interface ReliabilityDemoWorld {
  readonly breaker: CircuitBreaker;
  readonly flaky: FlakyService;
}

/**
 * The process-global breaker + flaky service the demo routes talk to.
 * Deliberately demo-snappy values (a 4s cooldown you can actually watch) with
 * the production-scale tradeoffs documented in the topic content.
 */
export function createReliabilityDemoWorld(
  options: FlakyServiceOptions = {},
): ReliabilityDemoWorld {
  return {
    breaker: new CircuitBreaker({
      name: 'flaky-inventory-service',
      failureThreshold: 3,
      cooldownMs: 4000,
      halfOpenSuccesses: 2,
      timeoutMs: DEMO_CALL_TIMEOUT_MS,
    }),
    flaky: new FlakyService(options),
  };
}

let demoWorld: ReliabilityDemoWorld | undefined;

export function getReliabilityDemoWorld(): ReliabilityDemoWorld {
  demoWorld ??= createReliabilityDemoWorld();
  return demoWorld;
}

/** Demo/testing reset: a fresh breaker AND a fresh flaky mode (back to healthy). */
export function resetReliabilityDemoWorld(): void {
  demoWorld = undefined;
}
