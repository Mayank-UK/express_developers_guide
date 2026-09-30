import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit_breaker.js';
import { FlakyService } from './flaky_service.js';
import { FakeTimerHost } from '../../test_support/index.js';

/**
 * The breaker's clock and timers are injectable, so these specs drive a FAKE
 * clock deterministically (the shared FakeTimerHost from test_support — one
 * implementation serving every fake-clock spec): advance(ms) fires every due
 * timer in scheduled order, letting microtask continuations run between
 * firings. NO real sleeps anywhere in this file — the 4000ms cooldown and
 * the 300ms/800ms deadline drama all happen inside advance().
 */

interface Harness {
  readonly host: FakeTimerHost;
  readonly breaker: CircuitBreaker;
  readonly flaky: FlakyService;
}

function makeHarness(overrides: Record<string, never> = {}): Harness {
  const host = new FakeTimerHost();
  const breaker = new CircuitBreaker({
    name: 'spec-dependency',
    failureThreshold: 3,
    cooldownMs: 4000,
    halfOpenSuccesses: 2,
    timeoutMs: 300,
    now: () => host.nowMs,
    setTimeoutFn: host.setTimeoutFn,
    clearTimeoutFn: host.clearTimeoutFn,
    ...overrides,
  });
  const flaky = new FlakyService({
    setTimeoutFn: host.setTimeoutFn,
    clearTimeoutFn: host.clearTimeoutFn,
  });
  return { host, breaker, flaky };
}

const healthyCall = (h: Harness) => h.breaker.execute((signal) => h.flaky.call(signal));
const failingCall = () => Promise.reject(new Error('dependency said no'));

/**
 * Starts one call through the breaker, then advances the fake clock `ms` so
 * the simulated hop's timer (or the deadline's) actually fires — the pattern
 * every flaky-service test needs: the promise cannot settle until a timer
 * does, and only advance() fires timers.
 */
async function callAndAdvance(h: Harness, ms: number) {
  const promise = healthyCall(h);
  await h.host.advance(ms);
  return promise;
}

describe('CircuitBreaker — CLOSED: healthy calls pass', () => {
  it('succeeds, stays closed, and resets the consecutive-failure streak on success', async () => {
    const h = makeHarness();
    const first = await callAndAdvance(h, 50); // the ~50ms simulated hop
    expect(first.ok).toBe(true);
    expect(h.breaker.stats().state).toBe('closed');
    expect(h.breaker.stats().consecutiveFailures).toBe(0);

    // A failure, then a success: the streak must RESET, not accumulate.
    const failed = await h.breaker.execute(failingCall);
    expect(failed.ok).toBe(false);
    expect(h.breaker.stats().consecutiveFailures).toBe(1);
    await callAndAdvance(h, 50);
    expect(h.breaker.stats().consecutiveFailures).toBe(0);
    expect(h.breaker.stats().state).toBe('closed');
  });

  it('stats shape: the documented fields, with nulls before anything happened', () => {
    const h = makeHarness();
    const stats = h.breaker.stats();
    expect(stats).toMatchObject({
      name: 'spec-dependency',
      state: 'closed',
      consecutiveFailures: 0,
      lastFailureAt: null,
      openedAt: null,
      totalRejected: 0,
    });
    expect(stats.config).toEqual({
      failureThreshold: 3,
      cooldownMs: 4000,
      halfOpenSuccesses: 2,
      timeoutMs: 300,
    });
  });
});

describe('CircuitBreaker — the trip: 3 consecutive failures OPEN it', () => {
  it('opens exactly at the threshold and records the transition', async () => {
    const h = makeHarness();
    for (let i = 0; i < 2; i += 1) {
      const failed = await h.breaker.execute(failingCall);
      expect(failed.ok).toBe(false);
      expect(h.breaker.stats().state, `after ${String(i + 1)} failures`).toBe('closed');
    }
    await h.breaker.execute(failingCall); // the third
    const stats = h.breaker.stats();
    expect(stats.state).toBe('open');
    expect(stats.consecutiveFailures).toBe(3);
    expect(stats.openedAt).not.toBeNull();
    expect(stats.lastFailureAt).not.toBeNull();

    const history = h.breaker.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from: 'closed', to: 'open' });
    expect(history[0]?.reason).toContain('threshold');
  });

  it('the 4th call is rejected FAST without running the operation', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) await h.breaker.execute(failingCall);

    let operationRan = false;
    const rejected = await h.breaker.execute(async () => {
      operationRan = true;
      return 'never';
    });
    expect(rejected.ok).toBe(false);
    expect(operationRan).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.kind).toBe('unavailable');
      expect(rejected.error.details?.rejectedFast).toBe(true);
      expect(rejected.error.details?.cooldownRemainingMs).toBe(4000);
    }
    expect(h.breaker.stats().totalRejected).toBe(1);
  });

  it('cooldownRemainingMs counts down (server-computed, no client clock math)', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) await h.breaker.execute(failingCall);
    expect(h.breaker.cooldownRemainingMs()).toBe(4000);
    await h.host.advance(1500);
    expect(h.breaker.cooldownRemainingMs()).toBe(2500);
    await h.host.advance(2500);
    expect(h.breaker.cooldownRemainingMs()).toBe(0);
  });
});

describe('CircuitBreaker — HALF_OPEN: probes, healing, and re-tripping', () => {
  it('after the cooldown a probe goes through; 2 successes CLOSE the circuit', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) await h.breaker.execute(failingCall);
    await h.host.advance(4000); // cooldown lapses — evaluated lazily by stats()

    expect(h.breaker.stats().state).toBe('half_open');
    expect(h.breaker.history().map((entry) => entry.to)).toEqual(['open', 'half_open']);

    // Probe 1 succeeds — still half_open (2 needed).
    const probe1 = await callAndAdvance(h, 50);
    expect(probe1.ok).toBe(true);
    expect(h.breaker.stats().state).toBe('half_open');

    // Probe 2 succeeds — CLOSED, streak reset.
    const probe2 = await callAndAdvance(h, 50);
    expect(probe2.ok).toBe(true);
    const stats = h.breaker.stats();
    expect(stats.state).toBe('closed');
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.openedAt).toBeNull();
    expect(h.breaker.history().map((entry) => `${entry.from}>${entry.to}`)).toEqual([
      'closed>open',
      'open>half_open',
      'half_open>closed',
    ]);
  });

  it('a failing probe re-OPENS with a FRESH cooldown', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) await h.breaker.execute(failingCall);
    await h.host.advance(4000);
    expect(h.breaker.stats().state).toBe('half_open');

    const failedProbe = await h.breaker.execute(failingCall);
    expect(failedProbe.ok).toBe(false);
    expect(h.breaker.stats().state).toBe('open');

    // Fresh cooldown: only 1s in, the circuit still rejects.
    await h.host.advance(1000);
    const stillRejected = await h.breaker.execute(failingCall);
    expect(stillRejected.ok).toBe(false);
    if (!stillRejected.ok) expect(stillRejected.error.details?.rejectedFast).toBe(true);
    expect(h.breaker.cooldownRemainingMs()).toBe(3000);

    // A FULL fresh cooldown later, half_open returns — the story can retry.
    await h.host.advance(3000);
    expect(h.breaker.stats().state).toBe('half_open');
  });

  it('caps concurrent probes at halfOpenSuccesses; extras are rejected fast', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) await h.breaker.execute(failingCall);
    await h.host.advance(4000);

    // Fire three probes before any settles: two run, the third is rejected.
    const probes = [
      h.breaker.execute((signal) => h.flaky.call(signal)),
      h.breaker.execute((signal) => h.flaky.call(signal)),
      h.breaker.execute((signal) => h.flaky.call(signal)),
    ];
    await h.host.advance(50); // the two admitted probes complete (healthy, 50ms)
    const settled = await Promise.all(probes);
    expect(settled.map((r) => r.ok)).toEqual([true, true, false]);
    if (!settled[2]?.ok) {
      expect(settled[2]?.error.details?.rejectedFast).toBe(true);
    }
    // Both probes succeeded — the circuit closed.
    expect(h.breaker.stats().state).toBe('closed');
    expect(h.breaker.stats().totalRejected).toBe(1);
  });
});

describe('CircuitBreaker — timeouts trip breakers too (the slow dependency)', () => {
  it('an 800ms call against a 300ms deadline counts as a failure and cancels the hop', async () => {
    const h = makeHarness();
    h.flaky.setMode('slow');

    const slow = await callAndAdvance(h, 300); // the deadline fires; the hop needed 800
    expect(slow.ok).toBe(false);
    if (!slow.ok) {
      expect(slow.error.kind).toBe('unavailable');
      expect(slow.error.details?.timedOut).toBe(true);
      expect(slow.error.details?.timeoutMs).toBe(300);
      expect(slow.error.message).toContain('deadline');
    }
    expect(h.breaker.stats().consecutiveFailures).toBe(1);
    // The abort actually CANCELLED the simulated hop — no orphaned timers.
    expect(h.host.pendingCount).toBe(0);
  });

  it('three slow calls open the circuit (slow IS down)', async () => {
    const h = makeHarness();
    h.flaky.setMode('slow');
    for (let i = 0; i < 3; i += 1) {
      await callAndAdvance(h, 300); // each deadline fires before the 800ms hop
    }
    expect(h.breaker.stats().state).toBe('open');
  });
});

describe('CircuitBreaker — the history ring', () => {
  it('is capped at 20 transitions (oldest dropped, newest kept)', async () => {
    const h = makeHarness();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      for (let i = 0; i < 3; i += 1) await h.breaker.execute(failingCall);
      await h.host.advance(4000);
      await callAndAdvance(h, 50);
      await callAndAdvance(h, 50);
    }
    const history = h.breaker.history();
    expect(history.length).toBeLessThanOrEqual(20);
    expect(history.length).toBeGreaterThanOrEqual(18); // 9 cycles × 3 transitions = 27 → capped
    // The newest transition is the last cycle's close.
    expect(history[history.length - 1]?.to).toBe('closed');
  });
});
