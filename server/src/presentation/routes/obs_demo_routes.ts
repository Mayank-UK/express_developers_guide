import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { Router, type Request, type Response } from 'express';
import { NotFoundException, ValidationException } from '../../core/error_handling/exceptions.js';
import {
  LEVEL_LABELS,
  LOG_RING_CAPACITY,
  getRecentLogs,
  type LevelLabel,
} from '../../core/logging/log_ring.js';
import { snapshotRequestMetrics } from '../../core/logging/request_metrics.js';
import {
  SPAN_RING_CAPACITY,
  buildSpanTree,
  formatTraceparent,
  getSpansByTraceId,
  parseTraceparent,
  recordCompletedSpan,
  resetSpanRingForTests,
  withSpan,
  type TraceContext,
} from '../../core/logging/trace_context.js';
// Deliberate teaching exception (the dependency rule is presentation → domain
// ← data; same note as db_demo_routes.ts): this exhibit imports the mongo/redis
// CLIENTS directly because live availability probing of the optional services
// is itself part of what the observability topic teaches.
import { getMongoConnection, isMongoConfigured } from '../../data/mongo/mongo_client.js';
import { getRedisClient, isRedisConfigured } from '../../data/redis/redis_client.js';
import { JobQueue, type Job } from '../../domain/jobs/job_queue.js';
import { getContainer } from '../../di/container.js';
import { getRunningGrpcServer } from '../grpc/grpc_server.js';

/**
 * Observability demo endpoints (the `observability` topic's live surface).
 * Thin controllers over three exhibits, each teaching a real production
 * pattern at demo scale:
 *
 * - GET  /api/demo/obs/logs       → the in-memory log ring (core/logging/
 *                                  log_ring.ts) with limit + minLevel filters.
 * - GET  /api/demo/obs/metrics    → hand-rolled process metrics: uptime,
 *                                  memory, event-loop delay (a REAL
 *                                  monitorEventLoopDelay histogram enabled at
 *                                  module load), and the request counters the
 *                                  request-logger middleware maintains.
 * - GET  /api/demo/obs/health     → readiness-shaped check strip (liveness is
 *                                  GET /api/health): http + sqlite probed for
 *                                  real, optional services reported honestly
 *                                  as ok / down / off.
 * - POST /api/demo/obs/make-noise → fires a controlled burst (3×200, 404,
 *                                  400, 503) at THIS app so the log viewer has
 *                                  something to show; failure injection is
 *                                  toggled around the 503 and always restored.
 * - POST /api/demo/obs/trace/run   → runs a REAL span chain (route handler →
 *                                  usecase → sqlite step → traced job enqueue)
 *                                  and records the queue worker's span under
 *                                  the PROPAGATED trace context — the
 *                                  producer/consumer link, one traceId across
 *                                  the HTTP request and the background job.
 * - GET  /api/demo/obs/trace/spans → one trace's span waterfall (flat + tree),
 *                                  by ?traceId= — the window the ring holds.
 * - POST /api/demo/obs/trace/reset → clears the span ring + the traced-job
 *                                  queue (specs/demos start clean).
 */

export const OBS_DEMO_MOUNT_PATH = '/api/demo/obs';

// --- /logs -------------------------------------------------------------------

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return LOG_RING_CAPACITY;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ValidationException('"limit" must be a positive integer', {
      parameter: 'limit',
      received: String(raw),
    });
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) {
    throw new ValidationException('"limit" must be a positive integer', {
      parameter: 'limit',
      received: String(raw),
    });
  }
  return Math.min(parsed, LOG_RING_CAPACITY);
}

function parseMinLevel(raw: unknown): LevelLabel | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !(LEVEL_LABELS as readonly string[]).includes(raw)) {
    throw new ValidationException('"minLevel" must be a pino level', {
      parameter: 'minLevel',
      validValues: [...LEVEL_LABELS],
    });
  }
  return raw as LevelLabel;
}

function logsController(req: Request, res: Response): void {
  const limit = parseLimit(req.query.limit);
  const minLevel = parseMinLevel(req.query.minLevel);
  const logs = getRecentLogs({ limit, minLevel });
  res.json({
    logs,
    count: logs.length,
    capacity: LOG_RING_CAPACITY,
    minLevel: minLevel ?? 'trace',
    limit,
    // Teaching note: this response cannot contain its OWN access line — the
    // request logger writes on 'finish', which fires after this JSON is sent.
    note: 'oldest → newest; the ring is a 200-line window, reset on restart',
  });
}

// --- /metrics ----------------------------------------------------------------

// Created + enabled ONCE per process (module load), never per request: the
// histogram accumulates from boot, so mean/percentiles describe the process's
// whole life, not the last read. reset() exists on IntervalHistogram but is
// deliberately NOT called — cumulative-since-boot is the honest framing.
const eventLoopMonitor: ELDHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();

function metricsController(_req: Request, res: Response): void {
  const memory = process.memoryUsage();
  // The histogram reports NANOSECONDS (verified empirically: a ~22ms stall
  // reads max ≈ 22_118_399) and percentiles is a Map — .get(), not indexing.
  // With few samples the higher percentile keys are absent, so p99 degrades
  // honestly down the ladder to p90 → mean.
  const toMs = (nanoseconds: number | undefined): number | null =>
    nanoseconds === undefined ? null : Math.round((nanoseconds / 1e6) * 1000) / 1000;
  const loopMeanMs = toMs(eventLoopMonitor.mean) ?? 0;
  const loopP99Ms =
    toMs(eventLoopMonitor.percentiles.get(99)) ??
    toMs(eventLoopMonitor.percentiles.get(90)) ??
    loopMeanMs;
  const loopMaxMs = toMs(eventLoopMonitor.max) ?? 0;

  res.json({
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
    },
    eventLoopDelayMs: {
      mean: loopMeanMs,
      p99: loopP99Ms,
      max: loopMaxMs,
      note: 'cumulative since process start (monitor enabled at module load, never reset)',
    },
    // Counters from the request-logger middleware — note this very request is
    // IN the inFlight count (it settles after the response finishes).
    requests: snapshotRequestMetrics(),
  });
}

// --- /health (readiness-shaped demo) ------------------------------------------

type CheckState = 'ok' | 'down' | 'off';
type CheckResult = { state: CheckState; note: string };

function checkSqlite(): CheckResult {
  // sqlite is EMBEDDED — there is no server to ping. The honest cheap check
  // is a real trivial query on a THROWAWAY in-memory handle: it proves the
  // driver loads and executes in this process, without ever touching the
  // app's guide.db (opening THAT from a health route would lazily create and
  // seed the file — a side effect a probe must not have).
  try {
    const probe = new Database(':memory:');
    probe.prepare('SELECT 1 AS one').get();
    probe.close();
    return { state: 'ok', note: 'embedded — probed on a throwaway :memory: handle' };
  } catch {
    return { state: 'down', note: 'better-sqlite3 probe failed' };
  }
}

async function checkMongo(): Promise<CheckResult> {
  if (!isMongoConfigured()) {
    return { state: 'off', note: 'MONGO_URI unset — the optional service is disabled' };
  }
  try {
    const connection = await getMongoConnection(); // bounded: 1.5s fail-fast
    return connection !== null && connection.readyState === 1
      ? { state: 'ok', note: 'connected' }
      : { state: 'down', note: 'configured but not answering' };
  } catch {
    return { state: 'down', note: 'probe threw' };
  }
}

async function checkRedis(): Promise<CheckResult> {
  if (!isRedisConfigured()) {
    return { state: 'off', note: 'REDIS_URL unset — the optional service is disabled' };
  }
  try {
    const client = await getRedisClient(); // bounded: ~1.2s connect timeout
    return client !== null && client.status === 'ready'
      ? { state: 'ok', note: 'connected' }
      : { state: 'down', note: 'configured but not answering' };
  } catch {
    return { state: 'down', note: 'probe threw' };
  }
}

function checkGrpc(): CheckResult {
  // gRPC starts in server.ts (or lazily via the demo bridge); under Supertest
  // neither happened, and 'off' says exactly that — not "broken".
  const running = getRunningGrpcServer();
  return running !== undefined
    ? { state: 'ok', note: `guide.v1.PostsService listening on :${String(running.port)}` }
    : { state: 'off', note: 'not started in this process (server.ts or the demo bridge starts it)' };
}

async function readinessController(_req: Request, res: Response): Promise<void> {
  // Optional services probed IN PARALLEL: each is independently bounded
  // (fail-fast clients), so worst case is the slowest probe, not the sum.
  const [mongo, redis] = await Promise.all([checkMongo(), checkRedis()]);
  const checks = { http: { state: 'ok', note: 'you are reading this answer' }, sqlite: checkSqlite(), mongo, redis, grpc: checkGrpc() } as const;

  // Readiness = every check that PARTICIPATES answers ok. 'off' checks are
  // not configured, so they do not block readiness — but 'down' ones do,
  // while the process stays ALIVE (liveness answers 200 regardless).
  const ready = Object.values(checks).every((check) => check.state !== 'down');

  res.json({
    alive: true,
    ready,
    checks,
    livenessEndpoint: '/api/health',
    note: 'liveness = the process is up; readiness = the dependencies it serves answer. A down optional service makes the app NOT ready while it stays alive.',
  });
}

// --- /make-noise --------------------------------------------------------------

interface NoiseAttempt {
  label: string;
  path: string;
  expectedStatus: number;
  gotStatus: number | 'error';
}

/** Self-fetch with a never-throw contract — the demo degrades, never 500s. */
async function fire(origin: string, path: string): Promise<number | 'error'> {
  try {
    const response = await fetch(`${origin}${path}`);
    return response.status;
  } catch {
    return 'error';
  }
}

async function makeNoiseController(req: Request, res: Response): Promise<void> {
  const host = req.get('host');
  const origin = `${req.protocol}://${host ?? '127.0.0.1'}`;
  const attempted: NoiseAttempt[] = [];

  // 3 × 200 — the liveness endpoint (three info lines in the ring).
  for (let index = 1; index <= 3; index += 1) {
    const path = '/api/health';
    attempted.push({
      label: `200 #${String(index)}`,
      path,
      expectedStatus: 200,
      gotStatus: await fire(origin, path),
    });
  }

  // 1 × 404 — a path no router owns: the catch-all envelope + a WARN access line.
  const missing = '/api/demo/obs/noise/does-not-exist';
  attempted.push({ label: '404', path: missing, expectedStatus: 404, gotStatus: await fire(origin, missing) });

  // 1 × 400 — a real validation failure through the error middleware (warn,
  // since this task's level refinement — grep the reqId to see BOTH lines).
  const invalid = '/api/demo/error?failure=validation';
  attempted.push({ label: '400', path: invalid, expectedStatus: 400, gotStatus: await fire(origin, invalid) });

  // 1 × 503 — failure injection toggled around a real domain call, restored
  // in finally no matter what the fetch did (never leave the demo poisoned).
  const scenarioStore = getContainer().scenarioStore;
  const previousInject = scenarioStore.get().injectFailure;
  try {
    scenarioStore.set({ injectFailure: true });
    const unavailable = '/api/demo/status';
    attempted.push({
      label: '503',
      path: unavailable,
      expectedStatus: 503,
      gotStatus: await fire(origin, unavailable),
    });
  } finally {
    scenarioStore.set({ injectFailure: previousInject });
  }

  const unreachable = attempted.some((attempt) => attempt.gotStatus === 'error');
  res.json({
    attempted,
    note: unreachable
      ? 'self-fetch was unavailable at this request origin (nothing was listening) — in a live dev server these requests land in the ring'
      : 'fired against this app over real HTTP — refresh the log viewer to watch the lines land',
  });
}

export const obsDemoRouter = Router();
obsDemoRouter.get('/demo/obs/logs', logsController);
obsDemoRouter.get('/demo/obs/metrics', metricsController);
obsDemoRouter.get('/demo/obs/health', readinessController);
obsDemoRouter.post('/demo/obs/make-noise', makeNoiseController);
obsDemoRouter.post('/demo/obs/trace/run', traceRunController);
obsDemoRouter.get('/demo/obs/trace/spans', traceSpansController);
// Unauthenticated wipe of the span ring — a deliberate DEMO affordance so any
// visitor can restore the fixture; production resets demand credentials.
obsDemoRouter.post('/demo/obs/trace/reset', traceResetController);

// --- /trace — the span collector's live surface -----------------------------------------

/**
 * The trace demo's OWN JobQueue instance — the jobs demo's board stays clean
 * (the same dedicated-instance decision the saga exhibit made). The queue's
 * worker is the "consumer" half of the propagation lesson: its span is
 * recorded under the traceparent the PRODUCER serialized into the payload.
 */
const traceQueue = new JobQueue();

/** Terminal job statuses — all this controller needs to know. */
const TERMINAL_JOB_STATUS: readonly Job['status'][] = ['succeeded', 'dead'];
const JOB_POLL_INTERVAL_MS = 25;
const JOB_BUDGET_MS = 10_000;

/** Poll-until helper (the saga's waitUntil convention: real timers, generous budget). */
function waitUntilJobTerminal(jobId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const startedAt = Date.now();
    const tick = (): void => {
      const status = traceQueue.get(jobId)?.status ?? 'queued';
      if (TERMINAL_JOB_STATUS.includes(status)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > JOB_BUDGET_MS) {
        resolve(false);
        return;
      }
      setTimeout(tick, JOB_POLL_INTERVAL_MS);
    };
    tick();
  });
}

/** The usecase-ish step: real CPU work (a digest loop), so the duration is measured, not invented. */
async function usecaseStep(): Promise<Record<string, unknown>> {
  let digest = 'trace-demo-payload';
  for (let index = 0; index < 20_000; index += 1) {
    digest = createHash('sha256').update(digest).digest('hex').slice(0, 32);
  }
  return { digestPrefix: digest.slice(0, 8), iterations: 20_000 };
}

/** The db-ish step: a REAL sqlite query on a throwaway :memory: handle (the health probe's pattern). */
function dbStep(): Record<string, unknown> {
  const probe = new Database(':memory:');
  const row = probe.prepare('SELECT 1 AS one').get() as { one: number } | undefined;
  probe.close();
  return { query: 'SELECT 1', answered: row?.one === 1 };
}

/**
 * The demo chain: this handler already runs inside the middleware's ROOT span
 * (res.locals.traceContext); each step opens a CHILD span under it, and the
 * job's payload carries the enqueue span's traceparent — which the worker
 * side records a span under, proving one traceId crossed the process boundary
 * into background work.
 */
async function traceRunController(req: Request, res: Response): Promise<void> {
  const root = res.locals.traceContext as TraceContext | undefined;

  const { result } = await withSpan('trace-demo: route handler', async (routeCtx) => {
    const usecase = await withSpan('trace-demo: usecase — assemble payload', () => usecaseStep(), routeCtx);
    const db = await withSpan('trace-demo: db — SELECT 1 (throwaway :memory:)', () => Promise.resolve(dbStep()), routeCtx);

    const { result: enqueuedJob } = await withSpan(
      'trace-demo: enqueue email job (producer)',
      async (producerCtx) => {
        // THE PROPAGATION MOMENT: the current span context leaves the process
        // as DATA — a string in the job payload — exactly how it would ride an
        // HTTP header to the next service or a Kafka record header.
        const enqueued = traceQueue.enqueue('email', {
          to: 'student@example.com',
          subject: 'traced by traceparent',
          source: 'trace-demo',
          traceparent: formatTraceparent(producerCtx),
        });
        if (!enqueued.ok) {
          throw new ValidationException(enqueued.error.message, enqueued.error.details);
        }
        return enqueued.value;
      },
      routeCtx,
    );

    // Await the worker's terminal state, then record ITS span from the queue's
    // own history timestamps (running→terminal): the consumer's timing is the
    // worker's real work window, not this poller's observation latency.
    const reachedTerminal = await waitUntilJobTerminal(enqueuedJob.id);
    const job = traceQueue.get(enqueuedJob.id);
    const propagated = parseTraceparent(
      typeof enqueuedJob.payload.traceparent === 'string' ? enqueuedJob.payload.traceparent : undefined,
    );

    let consumerSpanId: string | undefined;
    if (reachedTerminal && job !== undefined && propagated !== null) {
      const runningAt = job.history.find((entry) => entry.event === 'running');
      const settledAt = [...job.history]
        .reverse()
        .find((entry) => entry.event === 'succeeded' || entry.event === 'dead_lettered');
      if (runningAt !== undefined && settledAt !== undefined) {
        const consumer = recordCompletedSpan({
          name: 'trace-demo: job worker — email handler (consumer)',
          traceId: propagated.traceId,
          parentId: propagated.parentId,
          startedAtMs: Date.parse(runningAt.at),
          endedAtMs: Date.parse(settledAt.at),
          status: settledAt.event === 'succeeded' ? 'ok' : 'error',
          attributes: {
            jobId: job.id,
            propagatedTraceparent: enqueuedJob.payload.traceparent,
            note: 'parent = the producer span; timing = the queue worker history (real work window)',
          },
        });
        consumerSpanId = consumer.spanId;
      }
    }

    return {
      usecase: usecase.result,
      db: db.result,
      job: {
        jobId: enqueuedJob.id,
        status: job?.status ?? 'unknown',
        reachedTerminal,
        consumerSpanId,
        consumerParentSpanId: propagated?.parentId,
      },
    };
  }, root);

  const traceId = root?.traceId ?? 'n/a';
  res.json({
    traceId,
    // requestId beside traceId on purpose: THIS log line's correlation id vs
    // the WHOLE trace's identity — the coexistence lesson in one response.
    requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a',
    traceparent: root === undefined ? undefined : formatTraceparent(root),
    chain: result,
    tree: buildSpanTree(traceId),
    note: 'the root span closes when this response finishes — refetch /trace/spans?traceId= to see it settled',
  });
}

function traceSpansController(req: Request, res: Response): void {
  const raw = req.query.traceId;
  if (typeof raw !== 'string' || !/^[0-9a-f]{32}$/.test(raw)) {
    throw new ValidationException('"traceId" must be 32 lowercase hex characters (copy it from a traceparent header or /trace/run)', {
      parameter: 'traceId',
      received: String(raw),
    });
  }
  const spans = getSpansByTraceId(raw);
  if (spans.length === 0) {
    throw new NotFoundException(`no spans in the ring for trace "${raw}" — the ring is a ${String(SPAN_RING_CAPACITY)}-span window; traces age out`, {
      traceId: raw,
    });
  }
  res.json({
    traceId: raw,
    spanCount: spans.length,
    capacity: SPAN_RING_CAPACITY,
    spans,
    tree: buildSpanTree(raw),
  });
}

function traceResetController(_req: Request, res: Response): void {
  resetTraceDemoForTests();
  res.json({ reset: true });
}

/** Test/demo reset: a clean span window and an empty traced-job queue. */
export function resetTraceDemoForTests(): void {
  resetSpanRingForTests();
  traceQueue.clear();
}
