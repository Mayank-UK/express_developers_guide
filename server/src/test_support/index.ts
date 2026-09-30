/**
 * Shared SPEC SUPPORT — helpers imported by *.spec.ts files so they stop
 * re-declaring the same regex/fakes verbatim. PRODUCTION CODE MUST NOT
 * IMPORT THIS MODULE: it is test-only infrastructure. Vitest never collects
 * it as a test file (vitest.config.ts includes only *.{test,spec}.ts).
 */

/** Matches the request-id middleware's UUIDs (case-insensitive hex groups). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Injectable clock + timers, hand-built: advance(ms) fires every due timer
 * in scheduled order, letting microtask continuations run between firings
 * (an async handler chain registers its next timer synchronously at each
 * await — the flush makes that visible to the loop). One implementation
 * shared by every spec that drives deterministic time (job queue, circuit
 * breaker, order saga).
 */
export class FakeTimerHost {
  nowMs = 1_700_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly setTimeoutFn = (fn: () => void, ms: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  };

  readonly clearTimeoutFn = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  get pendingCount(): number {
    return this.timers.size;
  }

  /** Fire timers whose deadline is within `ms` of now, in deadline order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      let earliest: { id: number; at: number; fn: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (earliest === undefined || timer.at < earliest.at) earliest = { id, ...timer };
      }
      if (earliest === undefined) break;
      this.timers.delete(earliest.id);
      this.nowMs = Math.max(this.nowMs, earliest.at);
      earliest.fn();
      // Let the async continuation register its follow-up timer before the
      // next selection pass — setImmediate drains every pending microtask.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.nowMs = target;
  }
}
