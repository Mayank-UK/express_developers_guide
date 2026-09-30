import { Router, type Request, type Response } from 'express';
import {
  NotFoundException,
  ValidationException,
  failureToException,
} from '../../core/error_handling/exceptions.js';
import {
  JOB_TYPES,
  SCHEDULER_INTERVAL_MS_MAX,
  SCHEDULER_INTERVAL_MS_MIN,
  getDemoJobQueue,
} from '../../domain/jobs/job_queue.js';

/**
 * Background-jobs demo endpoints (the `background-jobs` topic's live surface).
 * The queue itself is domain/jobs/job_queue.ts (the teaching artifact); these
 * controllers stay thin — parse/validate input, call the queue, map Result to
 * an HTTP response, exactly the posts pipeline's contract.
 *
 * - POST   /api/demo/jobs/enqueue        {type, payload?} → 201 + the job.
 *   payload optional: email defaults to a welcome message, report to
 *   {source:'api'}. Failure-injection knobs (alwaysFail / forceFailures /
 *   latencyMs) ride the payload — they are the demo's point.
 * - GET    /api/demo/jobs                → the job board (newest first, capped
 *   at 50 entries in the response; `total` reports the uncapped count).
 * - GET    /api/demo/jobs/stats          → queue counters + scheduler state.
 * - GET    /api/demo/jobs/:id            → one job, history and all.
 * - POST   /api/demo/jobs/:id/requeue    → replay a DEAD job (fresh retry
 *   budget, kept history). Anything not dead answers the canonical 400 —
 *   requeueing a succeeded job is how duplicate emails happen.
 * - DELETE /api/demo/jobs                → clear the board + scheduler off.
 * - POST   /api/demo/jobs/scheduler      {running, intervalMs?} → the cron-ish
 *   scheduler toggle (intervalMs clamped 1000–60000; set semantics — one
 *   chain of ticks, replaceable, never stacked).
 */

export const JOBS_DEMO_MOUNT_PATH = '/api/demo/jobs';

/** How many job cards the response will carry — the board is a window, not a ledger. */
const LIST_LIMIT = 50;

/** Per-type payload defaults when the client enqueues without one. */
const PAYLOAD_DEFAULTS: Record<(typeof JOB_TYPES)[number], Record<string, unknown>> = {
  email: { to: 'student@example.com', subject: 'Welcome', forceFailures: 0 },
  report: { source: 'api' },
};

function enqueueController(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // A missing/garbage type flows into the queue's own validation (unknown
  // types are its Result failure, not the route's) — the cast only satisfies
  // the compiler; runtime garbage fails the includes() check either way.
  const type = body.type as string;
  const payload =
    body.payload === undefined ? PAYLOAD_DEFAULTS[type as (typeof JOB_TYPES)[number]] : body.payload;

  const result = getDemoJobQueue().enqueue(type, payload);
  if (!result.ok) throw failureToException(result.error);
  res.status(201).json({ job: result.value });
}

function listController(_req: Request, res: Response): void {
  const all = getDemoJobQueue().list();
  res.json({ jobs: all.slice(0, LIST_LIMIT), total: all.length, limit: LIST_LIMIT });
}

function statsController(_req: Request, res: Response): void {
  res.json(getDemoJobQueue().stats());
}

function jobDetailController(req: Request, res: Response): void {
  // Express 5 types route params as string | string[] — String() is the house normalization.
  const id = String(req.params.id);
  const job = getDemoJobQueue().get(id);
  if (job === undefined) {
    throw new NotFoundException(`no job with id "${id}"`, { jobId: id });
  }
  res.json({ job });
}

function requeueController(req: Request, res: Response): void {
  const result = getDemoJobQueue().requeue(String(req.params.id));
  if (!result.ok) throw failureToException(result.error);
  res.json({ job: result.value });
}

function clearController(_req: Request, res: Response): void {
  getDemoJobQueue().clear();
  res.json({ cleared: true, scheduler: getDemoJobQueue().stats().scheduler });
}

function schedulerController(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.running !== 'boolean') {
    throw new ValidationException('"running" must be a boolean', {
      parameter: 'running',
      received: typeof body.running,
    });
  }
  let intervalMs: number | undefined;
  if (body.intervalMs !== undefined) {
    if (typeof body.intervalMs !== 'number' || !Number.isFinite(body.intervalMs)) {
      throw new ValidationException('"intervalMs" must be a number (milliseconds)', {
        parameter: 'intervalMs',
        received: typeof body.intervalMs,
      });
    }
    intervalMs = body.intervalMs; // clamped by the queue (1000–60000)
  }
  const scheduler = getDemoJobQueue().setScheduler(body.running, intervalMs);
  res.json({
    scheduler,
    clampedTo: `${String(SCHEDULER_INTERVAL_MS_MIN)}–${String(SCHEDULER_INTERVAL_MS_MAX)}ms`,
  });
}

export const jobsDemoRouter = Router();
// GET literals before '/demo/jobs/:id' (POST-only literals cannot collide with it).
jobsDemoRouter.post('/demo/jobs/enqueue', enqueueController);
jobsDemoRouter.get('/demo/jobs', listController);
jobsDemoRouter.get('/demo/jobs/stats', statsController);
jobsDemoRouter.get('/demo/jobs/:id', jobDetailController);
jobsDemoRouter.post('/demo/jobs/:id/requeue', requeueController);
jobsDemoRouter.delete('/demo/jobs', clearController);
jobsDemoRouter.post('/demo/jobs/scheduler', schedulerController);
