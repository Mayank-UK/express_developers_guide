import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { JOBS_DEMO_MOUNT_PATH } from './jobs_demo_routes.js';
import { getDemoJobQueue, resetJobQueueForTests } from '../../domain/jobs/job_queue.js';

/**
 * The queue's mechanics (backoff math, scheduler set-semantics, dead-job
 * dormancy) are proven deterministically against the fake clock in
 * domain/jobs/job_queue.spec.ts. These specs exercise the HTTP SURFACE over
 * the demo singleton with real timers and generous budgets: the error
 * envelope contract, the lifecycle an API consumer actually observes, list
 * capping, and the one real-timer scheduler integration case.
 */

const MOUNT = JOBS_DEMO_MOUNT_PATH; // /api/demo/jobs

interface HistoryEntry {
  at: string;
  event: string;
  attempt?: number;
  delayMs?: number;
  lastError?: string;
}

interface JobBody {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  history: HistoryEntry[];
  result?: Record<string, unknown>;
}

beforeEach(() => {
  resetJobQueueForTests();
});

afterEach(() => {
  // Never let a running scheduler outlive a spec (open handles in vitest).
  resetJobQueueForTests();
});

/** Real-timer poll of GET /jobs/:id until the predicate holds on the job. */
async function waitJob(
  id: string,
  predicate: (job: JobBody) => boolean,
  timeoutMs = 8000,
): Promise<JobBody> {
  const startedAt = Date.now();
  for (;;) {
    const res = await request(createApp()).get(`${MOUNT}/${id}`);
    expect(res.status).toBe(200);
    const job = res.body.job as JobBody;
    if (predicate(job)) return job;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`job condition not met within ${String(timeoutMs)}ms — last: ${JSON.stringify(job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('POST /api/demo/jobs/enqueue', () => {
  it('accepts a bare type and applies the per-type payload defaults (201)', async () => {
    const res = await request(createApp()).post(`${MOUNT}/enqueue`).send({ type: 'email' });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({
      id: expect.stringMatching(/^job_\d+$/),
      type: 'email',
      status: 'queued',
      attempts: 0,
      payload: { to: 'student@example.com', subject: 'Welcome', forceFailures: 0 },
    });
    expect(res.body.job.history).toEqual([{ at: expect.any(String), event: 'enqueued' }]);
  });

  it('answers the canonical 400 envelope for unknown types and non-object payloads', async () => {
    const unknown = await request(createApp()).post(`${MOUNT}/enqueue`).send({ type: 'resize' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('validation_failed');
    expect(unknown.body.error.supported).toEqual(['email', 'report']);

    const badPayload = await request(createApp())
      .post(`${MOUNT}/enqueue`)
      .send({ type: 'email', payload: 'not-an-object' });
    expect(badPayload.status).toBe(400);
    expect(badPayload.body.error.code).toBe('validation_failed');
    expect(badPayload.body.error.parameter).toBe('payload');
  });

  it('carries a flaky email through retries to success with bounded backoff delays', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/enqueue`)
      .send({ type: 'email', payload: { forceFailures: 2, latencyMs: 60 } });
    expect(res.status).toBe(201);
    const id = res.body.job.id as string;

    const job = await waitJob(id, (candidate) => candidate.status === 'succeeded');
    expect(job.attempts).toBe(2); // two failures consumed, third try won
    expect(job.history.filter((entry) => entry.event === 'running')).toHaveLength(3);

    const retries = job.history.filter((entry) => entry.event === 'retry_scheduled');
    expect(retries).toHaveLength(2);
    // Demo base delay is 300ms: attempt 1 backs off ~300ms, attempt 2 ~600ms (± 20%).
    expect(retries[0]?.delayMs).toBeGreaterThanOrEqual(240);
    expect(retries[0]?.delayMs).toBeLessThanOrEqual(360);
    expect(retries[1]?.delayMs).toBeGreaterThanOrEqual(480);
    expect(retries[1]?.delayMs).toBeLessThanOrEqual(720);
    expect(job.history[job.history.length - 1]).toMatchObject({ event: 'succeeded', attempt: 3 });
    expect(job.result).toMatchObject({ simulated: true });
  }, 10_000);

  it('dead-letters a poison email after three attempts', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/enqueue`)
      .send({ type: 'email', payload: { alwaysFail: true, latencyMs: 40 } });
    const id = res.body.job.id as string;

    const job = await waitJob(id, (candidate) => candidate.status === 'dead');
    expect(job.attempts).toBe(3);
    expect(job.history[job.history.length - 1]).toMatchObject({
      event: 'dead_lettered',
      attempt: 3,
      lastError: expect.stringContaining('alwaysFail'),
    });
  }, 10_000);
});

describe('GET /api/demo/jobs — the board', () => {
  it('lists newest first, capped at 50, with the honest total', async () => {
    const app = createApp();
    for (let index = 0; index < 55; index += 1) {
      const res = await request(app).post(`${MOUNT}/enqueue`).send({
        type: 'email',
        payload: { latencyMs: 2000 }, // keep them queued — the cap is the point
      });
      expect(res.status).toBe(201);
    }
    const list = await request(app).get(MOUNT);
    expect(list.status).toBe(200);
    expect(list.body.jobs).toHaveLength(50);
    expect(list.body.total).toBe(55);
    expect(list.body.limit).toBe(50);
    // Newest first: the last enqueue's id leads the board.
    expect(list.body.jobs[0].id).toBe('job_55');
  });

  it('serves one job with its history, and 404s unknown ids with the envelope', async () => {
    const app = createApp();
    const created = await request(app).post(`${MOUNT}/enqueue`).send({ type: 'report' });
    const id = created.body.job.id as string;

    const found = await request(app).get(`${MOUNT}/${id}`);
    expect(found.status).toBe(200);
    expect(found.body.job.id).toBe(id);
    expect(Array.isArray(found.body.job.history)).toBe(true);

    const missing = await request(app).get(`${MOUNT}/job_9999`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });
});

describe('POST /api/demo/jobs/:id/requeue — dead-letter replay', () => {
  it('refuses anything that is not dead (400) and replays dead jobs with a fresh budget', async () => {
    const app = createApp();
    const alive = await request(app)
      .post(`${MOUNT}/enqueue`)
      .send({ type: 'email', payload: { latencyMs: 2000 } });
    const refusal = await request(app).post(`${MOUNT}/${alive.body.job.id}/requeue`);
    expect(refusal.status).toBe(400);
    expect(refusal.body.error.code).toBe('validation_failed');
    // Real timers: the job may already be queued OR running its 2s handler —
    // either way it is not dead, which is all the refusal promises.
    expect(refusal.body.error.status).toMatch(/^(queued|running)$/);

    const poison = await request(app)
      .post(`${MOUNT}/enqueue`)
      .send({ type: 'email', payload: { alwaysFail: true, latencyMs: 30 } });
    const deadId = poison.body.job.id as string;
    await waitJob(deadId, (candidate) => candidate.status === 'dead');

    const requeued = await request(app).post(`${MOUNT}/${deadId}/requeue`);
    expect(requeued.status).toBe(200);
    expect(requeued.body.job).toMatchObject({ status: 'queued', attempts: 0 });
    expect(requeued.body.job.history.some((entry: HistoryEntry) => entry.event === 'requeued')).toBe(true);

    // The replayed job RUNS again (and, still poisoned, dies again honestly).
    const rerun = await waitJob(deadId, (candidate) =>
      candidate.history.filter((entry) => entry.event === 'dead_lettered').length === 2,
    );
    expect(rerun.status).toBe('dead');
    expect(rerun.attempts).toBe(3);
  }, 12_000);
});

describe('GET /api/demo/jobs/stats + DELETE /api/demo/jobs', () => {
  it('reports the queue counters and config echo', async () => {
    const res = await request(createApp()).get(`${MOUNT}/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      queued: 0,
      running: 0,
      succeeded: 0,
      dead: 0,
      totalEnqueued: 0,
      oldestQueuedAgeMs: null,
      scheduler: { running: false, intervalMs: 5000 },
      config: { baseDelayMs: 300, maxAttempts: 3 },
    });
  });

  it('clears the board and turns the scheduler off', async () => {
    const app = createApp();
    await request(app).post(`${MOUNT}/enqueue`).send({ type: 'report' });
    await request(app).post(`${MOUNT}/scheduler`).send({ running: true, intervalMs: 1000 });
    expect(getDemoJobQueue().stats().scheduler.running).toBe(true);

    const cleared = await request(app).delete(MOUNT);
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(true);
    expect(cleared.body.scheduler.running).toBe(false);

    const stats = await request(app).get(`${MOUNT}/stats`);
    expect(stats.body.totalEnqueued).toBe(0);
    expect(stats.body.scheduler.running).toBe(false);
  });
});

describe('POST /api/demo/jobs/scheduler', () => {
  it('validates its input with the canonical envelope', async () => {
    const missing = await request(createApp()).post(`${MOUNT}/scheduler`).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('validation_failed');
    expect(missing.body.error.parameter).toBe('running');

    const badInterval = await request(createApp())
      .post(`${MOUNT}/scheduler`)
      .send({ running: true, intervalMs: 'soon' });
    expect(badInterval.status).toBe(400);
    expect(badInterval.body.error.parameter).toBe('intervalMs');
  });

  it('clamps intervalMs into 1000–60000', async () => {
    const tooFast = await request(createApp())
      .post(`${MOUNT}/scheduler`)
      .send({ running: true, intervalMs: 50 });
    expect(tooFast.status).toBe(200);
    expect(tooFast.body.scheduler).toMatchObject({ running: true, intervalMs: 1000 });
    expect(tooFast.body.clampedTo).toBe('1000–60000ms');

    const tooSlow = await request(createApp())
      .post(`${MOUNT}/scheduler`)
      .send({ running: true, intervalMs: 999_999 });
    expect(tooSlow.body.scheduler.intervalMs).toBe(60000);
  });

  it('the real-timer integration case: ticks enqueue scheduler-sourced jobs, and OFF stops them', async () => {
    const app = createApp();
    const on = await request(app)
      .post(`${MOUNT}/scheduler`)
      .send({ running: true, intervalMs: 1000 });
    expect(on.body.scheduler.running).toBe(true);

    // Generous budget: two ticks at a 1s interval land well inside 4s.
    const startedAt = Date.now();
    let schedulerJobs = 0;
    for (;;) {
      const list = await request(app).get(MOUNT);
      schedulerJobs = (list.body.jobs as JobBody[]).filter(
        (job) => job.payload.source === 'scheduler',
      ).length;
      if (schedulerJobs >= 2) break;
      if (Date.now() - startedAt > 4000) {
        throw new Error(`scheduler did not tick twice within 4s — saw ${String(schedulerJobs)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const off = await request(app).post(`${MOUNT}/scheduler`).send({ running: false });
    expect(off.body.scheduler.running).toBe(false);

    const count = schedulerJobs;
    await new Promise((resolve) => setTimeout(resolve, 1600)); // > 1 interval of silence
    const after = await request(app).get(MOUNT);
    const still = (after.body.jobs as JobBody[]).filter(
      (job) => job.payload.source === 'scheduler',
    ).length;
    expect(still).toBe(count); // off means OFF — no late tick enqueued anything
  }, 10_000);
});
