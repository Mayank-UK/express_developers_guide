import { describe, expect, it } from 'vitest';
import { JobQueue } from '../jobs/job_queue.js';
import { SagaManager, startOrderSaga } from './order_saga.js';
import { FakeTimerHost } from '../../test_support/index.js';

/**
 * The saga's clock, timers, AND queue are injectable, so these specs drive the
 * whole state machine deterministically (the shared FakeTimerHost from
 * test_support — one implementation serving every fake-clock spec):
 * advance(ms) fires every due timer in scheduled order, letting microtask
 * continuations run between firings. The injected queue shares the same host,
 * so step jobs, retries, backoff, AND the saga's polling all happen inside
 * advance() — NO real sleeps anywhere.
 */

interface Harness {
  readonly host: FakeTimerHost;
  readonly queue: JobQueue;
  readonly manager: SagaManager;
}

/** A manager whose queue, clock, and timers ALL ride one FakeTimerHost. */
function makeHarness(): Harness {
  const host = new FakeTimerHost();
  const queue = new JobQueue({
    now: () => host.nowMs,
    setTimeoutFn: host.setTimeoutFn,
    clearTimeoutFn: host.clearTimeoutFn,
  });
  const manager = new SagaManager({ now: () => host.nowMs, setTimeoutFn: host.setTimeoutFn, queue });
  return { host, queue, manager };
}

describe('startOrderSaga input validation (the domain boundary)', () => {
  it('rejects a blank or non-string orderId with the typed validation failure', () => {
    for (const bad of ['', '   ', 42, null, { id: 7 }]) {
      const result = startOrderSaga({ orderId: bad as string });
      expect(result.ok, `orderId ${JSON.stringify(bad)} should be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('validation');
        expect(result.error.message).toContain('orderId');
        expect(result.error.details?.parameter).toBe('orderId');
        expect(result.error.details?.received).toBe(bad);
      }
    }
  });

  it('rejects an unknown failAt with the supported list (unchanged behavior)', () => {
    const result = startOrderSaga({ orderId: 'ord-1', failAt: 'deliver-by-drone' as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('validation');
      expect(result.error.details?.parameter).toBe('failAt');
      expect(result.error.details?.supported).toEqual(['place-order', 'reserve-stock', 'charge-card', 'ship', 'none']);
    }
  });
});

describe('the saga on an injected fake clock — steps advance without real sleeping', () => {
  it('runs all four forward steps to completion, riding the injected queue', async () => {
    const { host, queue, manager } = makeHarness();
    const wallStartedAt = Date.now();
    const saga = manager.start('ord-fake', 'none');
    await host.advance(60_000); // minutes of FAKE time in milliseconds of real time

    expect(saga.state).toBe('completed');
    expect(saga.steps.map((step) => [step.step, step.kind, step.status])).toEqual([
      ['place-order', 'forward', 'succeeded'],
      ['reserve-stock', 'forward', 'succeeded'],
      ['charge-card', 'forward', 'succeeded'],
      ['ship', 'forward', 'succeeded'],
    ]);
    // Queue injection proven: every step was a job on the queue WE passed in.
    expect(queue.list()).toHaveLength(4);
    expect(queue.list().every((job) => job.status === 'succeeded')).toBe(true);
    // The fake clock did the waiting — real wall-clock stayed near zero.
    expect(Date.now() - wallStartedAt).toBeLessThan(1_000);
    // Timestamps come from the injected clock (fake epoch = Nov 2023).
    expect(saga.startedAt.startsWith('2023-')).toBe(true);
    expect(new Date(saga.finishedAt ?? '').getTime()).toBeLessThanOrEqual(host.nowMs);
    expect(host.pendingCount).toBe(0); // nothing left armed — the machine parked
  });

  it('retries the failing step to its verdict, then compensates in reverse', async () => {
    const { host, manager } = makeHarness();
    const saga = manager.start('ord-fake', 'charge-card');
    await host.advance(60_000);

    expect(saga.state).toBe('compensated');
    expect(saga.steps.map((step) => [step.step, step.status])).toEqual([
      ['place-order', 'succeeded'],
      ['reserve-stock', 'succeeded'],
      ['charge-card', 'dead-lettered'],
      ['ship', 'skipped'],
      ['refund-card', 'compensated'],
      ['release-stock', 'compensated'],
      ['cancel-order', 'compensated'],
    ]);
    // The queue retried the broken step 3 times before the saga gave up.
    expect(saga.steps.find((step) => step.step === 'charge-card')?.attempts).toBe(3);
  });
});
