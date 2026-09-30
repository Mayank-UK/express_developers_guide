import { describe, expect, it } from 'vitest';
import { JobQueue, type Job } from './job_queue.js';
import { FakeTimerHost } from '../../test_support/index.js';

/**
 * The queue's clock and timers are injectable, so these specs drive a FAKE
 * clock deterministically (the shared FakeTimerHost from test_support):
 * advance(ms) fires every due timer in scheduled order, letting microtask
 * continuations run between firings (an async handler chain registers its
 * next timer synchronously at each await — the flush makes that visible to
 * the loop). One real-timer case (the serial-worker proof) lives at the
 * bottom with generous bounds.
 */

function makeQueue(host: FakeTimerHost, baseDelayMs?: number): JobQueue {
  return new JobQueue({
    ...(baseDelayMs !== undefined && { baseDelayMs }),
    now: () => host.nowMs,
    setTimeoutFn: host.setTimeoutFn,
    clearTimeoutFn: host.clearTimeoutFn,
  });
}

/** Real-timer poller for the integration cases — generous, never racy. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met within budget');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function events(job: { history: { event: string }[] }): string[] {
  return job.history.map((entry) => entry.event);
}

/** The handler outcome shape (HandlerOutcome is private — this mirrors it). */
type HandlerLike = { ok: boolean; result?: Record<string, unknown>; error?: string };

/**
 * The queue's private seams, reached by cast: runHandler (to inject a THROW)
 * and drainTick (to catch the fire-and-forget promise so the escape is
 * OBSERVED instead of surfacing as a process-level unhandled rejection).
 */
type JobQueueSeams = {
  runHandler: (job: Job) => Promise<HandlerLike>;
  drainTick: () => Promise<void>;
};

describe('JobQueue — enqueue and the success path (fake clock)', () => {
  it('validates type and payload as Result failures, never throws', () => {
    const queue = new JobQueue();
    const unknownType = queue.enqueue('image-resize', {});
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) {
      expect(unknownType.error.kind).toBe('validation');
      expect(unknownType.error.details?.supported).toEqual(['email', 'report']);
    }

    for (const badPayload of ['text', 42, null, ['array']]) {
      const result = queue.enqueue('email', badPayload);
      expect(result.ok, `payload ${String(badPayload)}`).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('validation');
    }
  });

  it('runs an email job to success: enqueued → running → succeeded', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host);

    const enqueued = queue.enqueue('email', { to: 'mentor@example.com', subject: 'Hello' });
    expect(enqueued.ok).toBe(true);
    if (!enqueued.ok) return;
    expect(enqueued.value.id).toMatch(/^job_1$/);
    expect(enqueued.value.status).toBe('queued');
    expect(events(enqueued.value)).toEqual(['enqueued']);

    await host.advance(0); // drain tick fires; handler is now awaiting its latency
    expect(queue.get(enqueued.value.id)?.status).toBe('running');

    await host.advance(250); // past the 80–200ms simulated SMTP hop
    const job = queue.get(enqueued.value.id);
    expect(job?.status).toBe('succeeded');
    expect(job ? events(job) : []).toEqual(['enqueued', 'running', 'succeeded']);
    expect(job?.attempts).toBe(0); // zero failures — the retry budget is untouched
    expect(job?.result).toMatchObject({
      to: 'mentor@example.com',
      subject: 'Hello',
      simulated: true,
    });
    expect(host.pendingCount).toBe(0); // the loop ran out of work — no leaked tick
  });

  it('report jobs succeed with the static teaching row count', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host);
    queue.enqueue('report', { source: 'api' });
    await host.advance(500);
    const job = queue.list()[0];
    expect(job.status).toBe('succeeded');
    expect(job.result).toEqual({ rows: 3 });
  });
});

describe('JobQueue — retries, backoff bounds, dead-letter (fake clock)', () => {
  it('forceFailures: 2 → exactly 3 attempts then success; backoff ≈ 300ms then 600ms ± 20%', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host, 300);

    const enqueued = queue.enqueue('email', { forceFailures: 2 });
    expect(enqueued.ok).toBe(true);
    await host.advance(5000);

    const job = queue.get('job_1');
    expect(job?.status).toBe('succeeded');
    expect(job?.attempts).toBe(2); // two failures consumed, third try won
    const history = job?.history ?? [];
    expect(history.filter((entry) => entry.event === 'running')).toHaveLength(3);

    const retries = history.filter((entry) => entry.event === 'retry_scheduled');
    expect(retries).toHaveLength(2);
    // base 300: attempt 1 backs off ~300ms, attempt 2 ~600ms — both ± 20%.
    expect(retries[0]?.delayMs).toBeGreaterThanOrEqual(240);
    expect(retries[0]?.delayMs).toBeLessThanOrEqual(360);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[1]?.delayMs).toBeGreaterThanOrEqual(480);
    expect(retries[1]?.delayMs).toBeLessThanOrEqual(720);
    expect(retries[1]?.attempt).toBe(2);

    const last = history[history.length - 1];
    expect(last?.event).toBe('succeeded');
    expect(last?.attempt).toBe(3);
  });

  it('alwaysFail → dead after maxAttempts, and a dead job NEVER auto-runs again', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host, 300);

    queue.enqueue('email', { alwaysFail: true });
    await host.advance(5000);

    const job = queue.get('job_1');
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(3);
    const history = job?.history ?? [];
    const deadEntry = history[history.length - 1];
    expect(deadEntry?.event).toBe('dead_lettered');
    expect(deadEntry?.attempt).toBe(3);
    expect(deadEntry?.lastError).toContain('alwaysFail');

    // runAt is meaningless for dead jobs — prove it: far-future advance adds
    // no history and lights no timer.
    const historyLength = history.length;
    await host.advance(10_000);
    expect(queue.get('job_1')?.history.length).toBe(historyLength);
    expect(queue.get('job_1')?.status).toBe('dead');
    expect(host.pendingCount).toBe(0);
  });

  it('requeue resets attempts but keeps history, and the job RUNS again', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host, 300);

    queue.enqueue('email', { alwaysFail: true });
    await host.advance(5000);
    expect(queue.get('job_1')?.status).toBe('dead');

    // Only dead jobs requeue — a queued/running/succeeded one is refused.
    queue.enqueue('email', {});
    const refusal = queue.requeue('job_2');
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.error.kind).toBe('validation');
    const missing = queue.requeue('job_999');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('not_found');

    const requeued = queue.requeue('job_1');
    expect(requeued.ok).toBe(true);
    if (!requeued.ok) return;
    expect(requeued.value.status).toBe('queued');
    expect(requeued.value.attempts).toBe(0); // fresh retry budget…
    expect(events(requeued.value)).toContain('requeued'); // …but the postmortem survives

    await host.advance(5000);
    const job = queue.get('job_1');
    expect(job?.status).toBe('dead'); // alwaysFail is still always-fail — but it RAN
    expect(job?.attempts).toBe(3);
    expect(job?.history.filter((entry) => entry.event === 'dead_lettered')).toHaveLength(2);
    const requeuedIndex = job?.history.findIndex((entry) => entry.event === 'requeued') ?? -1;
    expect(job?.history.slice(requeuedIndex + 1).map((entry) => entry.event)).toEqual([
      'running',
      'retry_scheduled',
      'running',
      'retry_scheduled',
      'running',
      'dead_lettered',
    ]);
  });
});

describe('JobQueue — the worker lock survives a handler that THROWS (fake clock)', () => {
  /**
   * Expected failures come back as Results; a THROW means the handler has a
   * BUG. The lock reset must be exception-safe or that bug wedges the queue
   * forever — processing stuck true, every later drainTick no-oping at the
   * guard. The queue still cannot KNOW what to do with the marooned job (a
   * real worker leans on process supervision here — the content covers it);
   * what it MUST guarantee is that the NEXT job still drains.
   */
  it('a thrown handler error cannot wedge the lock — the next job still drains', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host);
    const proto = Object.getPrototypeOf(queue) as JobQueueSeams;
    const seams = queue as unknown as JobQueueSeams;
    const escaped: unknown[] = [];
    let handlerCalls = 0;
    seams.runHandler = (job) => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        return Promise.reject(new Error('handler bug: unexpected throw — not a failed Result'));
      }
      return proto.runHandler.call(queue, job);
    };
    seams.drainTick = () =>
      proto.drainTick.call(queue).catch((error) => {
        escaped.push(error);
      });

    queue.enqueue('email', { latencyMs: 50 });
    await host.advance(0); // the drain fires; the handler throws mid-flight
    expect(queue.get('job_1')?.status).toBe('running'); // marooned — the throw skipped outcome application
    expect(escaped).toHaveLength(1); // exactly one escape, captured (not an unhandled rejection)
    expect((escaped[0] as Error).message).toContain('handler bug');

    // The proof: a SECOND, normal job must still drain — with a wedged lock
    // this stays queued forever.
    queue.enqueue('email', { to: 'mentor@example.com' });
    await host.advance(500);
    expect(queue.get('job_2')?.status).toBe('succeeded'); // processing was reset by finally
    expect(host.pendingCount).toBe(0); // the loop ran out of work — no leaked tick
  });
});

describe('JobQueue — the scheduler (fake clock)', () => {
  it('enqueues a scheduler-sourced report job per tick and stops cleanly', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host);

    const state = queue.setScheduler(true, 1000);
    expect(state).toMatchObject({ running: true, intervalMs: 1000 });

    await host.advance(2500); // ticks at t+1000 and t+2000
    const schedulerJobs = queue
      .list()
      .filter((job) => job.payload.source === 'scheduler');
    expect(schedulerJobs).toHaveLength(2);
    expect(schedulerJobs.every((job) => job.type === 'report')).toBe(true);
    expect(schedulerJobs.map((job) => job.payload.tick)).toEqual([2, 1]); // newest first
    const lastRunAt = queue.stats().scheduler.lastRunAt;
    expect(typeof lastRunAt).toBe('string');
    expect(lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const stopped = queue.setScheduler(false);
    expect(stopped.running).toBe(false);
    const count = queue.list().filter((job) => job.payload.source === 'scheduler').length;
    await host.advance(5000);
    expect(queue.list().filter((job) => job.payload.source === 'scheduler')).toHaveLength(count);
    expect(host.pendingCount).toBe(0); // the chain is gone, not just quiet
  });

  it('replaces the interval, never stacks one (on/off/on is still ONE chain)', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host);

    queue.setScheduler(true, 1000);
    await host.advance(1200); // exactly one tick so far
    expect(queue.list().filter((job) => job.payload.source === 'scheduler')).toHaveLength(1);

    queue.setScheduler(true, 1000); // REPLACE — the chain restarts from now
    await host.advance(1000); // one more tick; a stacked second interval would fire two
    expect(queue.list().filter((job) => job.payload.source === 'scheduler')).toHaveLength(2);

    queue.setScheduler(true, 2000); // and the new cadence is honored (clamped ≥ 1000)
    expect(queue.stats().scheduler.intervalMs).toBe(2000);
    await host.advance(2000); // exactly one more at the slower cadence — a leftover
    // 1000ms chain from the "replaced" configuration would have fired two here.
    expect(queue.list().filter((job) => job.payload.source === 'scheduler')).toHaveLength(3);
  });
});

describe('JobQueue — stats', () => {
  it('reports counters, oldest queued age, scheduler state, and config', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host, 300);

    const empty = queue.stats();
    expect(empty).toMatchObject({
      queued: 0,
      running: 0,
      succeeded: 0,
      dead: 0,
      totalEnqueued: 0,
      oldestQueuedAgeMs: null,
      scheduler: { running: false, intervalMs: 5000 },
      config: { baseDelayMs: 300, maxAttempts: 3 },
    });

    queue.enqueue('email', { forceFailures: 1, latencyMs: 50 });
    expect(queue.stats().queued).toBe(1);
    expect(queue.stats().oldestQueuedAgeMs).toBe(0); // measured at the enqueue instant

    await host.advance(100); // ran once, failed, sitting out its backoff — QUEUED again
    const backing = queue.stats();
    expect(backing.queued).toBe(1);
    expect(backing.oldestQueuedAgeMs).toBeGreaterThanOrEqual(0);
    expect(backing.oldestQueuedAgeMs).toBeLessThanOrEqual(10_000);

    await host.advance(2000); // retry consumed, succeeded
    const done = queue.stats();
    expect(done).toMatchObject({ queued: 0, succeeded: 1, totalEnqueued: 1 });
    expect(done.oldestQueuedAgeMs).toBeNull();
  });

  it('clear() drops jobs AND stops the scheduler', async () => {
    const host = new FakeTimerHost();
    const queue = makeQueue(host);
    queue.setScheduler(true, 1000);
    await host.advance(1100);
    expect(queue.stats().totalEnqueued).toBe(1);

    queue.clear();
    expect(queue.stats()).toMatchObject({
      totalEnqueued: 0,
      queued: 0,
      scheduler: { running: false },
    });
    await host.advance(3000);
    expect(queue.stats().totalEnqueued).toBe(0); // no late tick enqueued anything
  });
});

describe('JobQueue — real-timer integration', () => {
  it('works strictly serially: five 100ms jobs take at least ~5 × 100ms (real timers)', async () => {
    const queue = new JobQueue(); // real clock, real timers, demo defaults
    const startedAt = Date.now();
    for (let index = 0; index < 5; index += 1) {
      const result = queue.enqueue('email', { latencyMs: 100 });
      expect(result.ok).toBe(true);
    }
    await waitUntil(() => queue.stats().succeeded === 5, 8000);
    const elapsed = Date.now() - startedAt;
    // Concurrency-1 proof: 5 × 100ms of handler latency cannot overlap, so the
    // floor is ~500ms (minus a hair of timer slop). A concurrent worker would
    // finish in ~100–200ms.
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(5000); // sanity ceiling
  }, 12_000);
});
