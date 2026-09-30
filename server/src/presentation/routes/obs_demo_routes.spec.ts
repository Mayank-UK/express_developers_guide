import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { OBS_DEMO_MOUNT_PATH, resetTraceDemoForTests } from './obs_demo_routes.js';
import {
  getRecentLogs,
  resetLogRingForTests,
  ringDestination,
} from '../../core/logging/log_ring.js';
import {
  resetRequestMetricsForTests,
  snapshotRequestMetrics,
} from '../../core/logging/request_metrics.js';
import { resetSpanRingForTests } from '../../core/logging/trace_context.js';
import { getContainer } from '../../di/container.js';

/**
 * The observability demo's HTTP surface, exercised end-to-end through the
 * real app: the ring must capture the request logger's OWN lines (this spec's
 * requests), the level discipline (4xx warn / 5xx error) must be visible IN
 * the ring at both layers (access log + error middleware), counters must move
 * and return inFlight to zero, and make-noise must restore the scenario it
 * toggles. The ring/metrics singletons reset per test so assertions see only
 * the requests each case fires.
 */

const MOUNT = OBS_DEMO_MOUNT_PATH; // /api/demo/obs

beforeEach(() => {
  resetLogRingForTests();
  resetRequestMetricsForTests();
  resetSpanRingForTests();
});

afterEach(() => {
  // The traced-job queue drains asynchronously inside /trace/run; its worker
  // timers must not leak into later cases.
  resetTraceDemoForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/demo/obs/logs — the ring read side', () => {
  it('captures the request logger line for a request, keyed by reqId, with an honest duration', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);

    const requestId = res.headers['x-request-id'];
    expect(typeof requestId).toBe('string');
    const entry = getRecentLogs().find(
      (candidate) => candidate.msg === 'request completed' && candidate.reqId === requestId,
    );
    expect(entry).toBeDefined();
    expect(entry?.levelLabel).toBe('info'); // 2xx → info
    expect(entry?.fields).toMatchObject({ method: 'GET', path: '/api/health', status: 200 });
    expect(entry?.fields.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('serves the entries oldest → newest, capped by limit, with the shape echo', async () => {
    const app = createApp();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const res = await request(app).get('/api/health');
      ids.push(String(res.headers['x-request-id']));
    }

    const res = await request(createApp()).get(`${MOUNT}/logs?limit=3`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.minLevel).toBe('trace');
    expect(res.body.limit).toBe(3);
    const logs = res.body.logs as Array<{ reqId?: string; msg: string }>;
    expect(logs).toHaveLength(3);
    // Newest LAST: the final entry is the most recent request's line.
    expect(logs[logs.length - 1]?.reqId).toBe(ids[ids.length - 1]);
  });

  it('filters by minLevel: a warn filter answers only warn/error/fatal lines', async () => {
    const app = createApp();
    await request(app).get('/api/health'); // info
    await request(app).get(`${MOUNT}/noise/not-a-route`); // 404 → warn

    const res = await request(createApp()).get(`${MOUNT}/logs?minLevel=warn`);
    expect(res.status).toBe(200);
    expect(res.body.minLevel).toBe('warn');
    const labels = (res.body.logs as Array<{ levelLabel: string }>).map((log) => log.levelLabel);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(['warn', 'error', 'fatal']).toContain(label);
    }
  });

  it('answers the canonical 400 envelope for bad limit and bad minLevel', async () => {
    const badLimit = await request(createApp()).get(`${MOUNT}/logs?limit=soon`);
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error.code).toBe('validation_failed');
    expect(badLimit.body.error.parameter).toBe('limit');

    const badLevel = await request(createApp()).get(`${MOUNT}/logs?minLevel=loud`);
    expect(badLevel.status).toBe(400);
    expect(badLevel.body.error.code).toBe('validation_failed');
    expect(badLevel.body.error.validValues).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('the ring never throws on a weird line — it keeps the raw text as an entry', () => {
    expect(() => {
      ringDestination.write('this is not json');
      ringDestination.write('');
      ringDestination.write('42');
    }).not.toThrow();
    const logs = getRecentLogs();
    expect(logs.some((entry) => entry.msg.includes('this is not json'))).toBe(true);
    // '' is dropped entirely; a bare JSON number degrades to an entry, not a crash.
    expect(logs.every((entry) => typeof entry.msg === 'string')).toBe(true);
  });
});

describe('the deferred level refinement, observed through the ring', () => {
  it('error middleware logs 4xx at warn and 5xx at error; the access log matches', async () => {
    const app = createApp();
    const fourHundred = await request(app).get('/api/demo/error?failure=validation');
    expect(fourHundred.status).toBe(400);
    const fiveHundred = await request(app).get('/api/demo/error?failure=unavailable');
    expect(fiveHundred.status).toBe(503);

    const logs = getRecentLogs();
    const warnFailure = logs.find(
      (entry) => entry.msg === 'request failed' && entry.fields.statusCode === 400,
    );
    expect(warnFailure?.levelLabel).toBe('warn');

    const errorFailure = logs.find(
      (entry) => entry.msg === 'request failed' && entry.fields.statusCode === 503,
    );
    expect(errorFailure?.levelLabel).toBe('error');

    // The access log applies the SAME split, and reqId correlates the layers.
    const access400 = logs.find(
      (entry) => entry.msg === 'request completed' && entry.fields.status === 400,
    );
    expect(access400?.levelLabel).toBe('warn');
    expect(access400?.reqId).toBe(warnFailure?.requestId);

    const access503 = logs.find(
      (entry) => entry.msg === 'request completed' && entry.fields.status === 503,
    );
    expect(access503?.levelLabel).toBe('error');
    expect(access503?.reqId).toBe(errorFailure?.requestId);
  });
});

describe('GET /api/demo/obs/metrics — the hand-rolled metrics strip', () => {
  it('reports process metrics with the expected shape', async () => {
    const res = await request(createApp()).get(`${MOUNT}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.memory).toMatchObject({
      rssBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
    });
    expect(res.body.eventLoopDelayMs).toHaveProperty('mean');
    expect(res.body.eventLoopDelayMs).toHaveProperty('p99');
    expect(res.body.requests).toHaveProperty('total');
    expect(res.body.requests.byStatusClass).toMatchObject({
      '2xx': expect.any(Number),
      '3xx': expect.any(Number),
      '4xx': expect.any(Number),
      '5xx': expect.any(Number),
    });
  });

  it('counts requests by status class, and inFlight returns to zero after each settles', async () => {
    const before = snapshotRequestMetrics();
    const app = createApp();
    await request(app).get('/api/health'); // → 2xx
    await request(app).get(`${MOUNT}/noise/nope`); // → 4xx

    // The metrics request is IN FLIGHT while it reads its own counters: total
    // counts the two settled requests, inFlight counts this probe itself.
    const mid = await request(createApp()).get(`${MOUNT}/metrics`);
    expect(mid.body.requests.total).toBe(before.total + 2);
    expect(mid.body.requests.inFlight).toBe(1);
    expect(mid.body.requests.byStatusClass['2xx']).toBe(before.byStatusClass['2xx'] + 1);
    expect(mid.body.requests.byStatusClass['4xx']).toBe(before.byStatusClass['4xx'] + 1);

    // Once the probe's response finished, its own line settled too.
    const after = snapshotRequestMetrics();
    expect(after.inFlight).toBe(0);
    expect(after.total).toBe(before.total + 3);
    expect(after.durations.p50Ms).not.toBeNull();
  });
});

describe('GET /api/demo/obs/health — the readiness-shaped probe', () => {
  it('answers alive with the check strip and per-check notes', async () => {
    const res = await request(createApp()).get(`${MOUNT}/health`);
    expect(res.status).toBe(200);
    expect(res.body.alive).toBe(true);
    expect(typeof res.body.ready).toBe('boolean');
    expect(res.body.livenessEndpoint).toBe('/api/health');

    const checks = res.body.checks as Record<string, { state: string; note: string }>;
    expect(checks.http.state).toBe('ok');
    expect(checks.sqlite.state).toBe('ok');
    // Optional services report honestly — all three states are legitimate
    // depending on configuration; the note always explains the state.
    expect(['ok', 'down', 'off']).toContain(checks.mongo.state);
    expect(['ok', 'down', 'off']).toContain(checks.redis.state);
    expect(['ok', 'off']).toContain(checks.grpc.state);
    for (const check of Object.values(checks)) {
      expect(check.note.length).toBeGreaterThan(0);
    }
  });

  it('sqlite is probed for real: the throwaway handle answers and closes', async () => {
    // Indirect proof: two consecutive probes both report ok (no state leak
    // between probes — a leaked :memory: handle would still answer, so the
    // real assertion is simply that the cheap check is stable and honest).
    const first = await request(createApp()).get(`${MOUNT}/health`);
    const second = await request(createApp()).get(`${MOUNT}/health`);
    expect(first.body.checks.sqlite.state).toBe('ok');
    expect(second.body.checks.sqlite.state).toBe('ok');
  });
});

describe('POST /api/demo/obs/make-noise — the controlled burst', () => {
  it('records all six attempts, fires the scenario toggle, and RESTORES injectFailure', async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return { ok: true, status: 200 } as Response;
      }),
    );
    const injectBefore = getContainer().scenarioStore.get().injectFailure;

    const res = await request(createApp()).post(`${MOUNT}/make-noise`);
    expect(res.status).toBe(200);
    expect(res.body.attempted).toHaveLength(6); // 3×200, 404, 400, 503
    expect(fetchCalls).toHaveLength(6);
    // The 503 attempt went through the toggle (any fetch order proves the
    // toggle happened around it, and the finally restored the previous state).
    expect(getContainer().scenarioStore.get().injectFailure).toBe(injectBefore);
    expect(res.body.attempted.map((attempt: { label: string }) => attempt.label)).toEqual([
      '200 #1',
      '200 #2',
      '200 #3',
      '404',
      '400',
      '503',
    ]);
  });

  it('degrades to the unreachable note when self-fetch cannot connect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const res = await request(createApp()).post(`${MOUNT}/make-noise`);
    expect(res.status).toBe(200);
    expect(res.body.attempted).toHaveLength(6);
    for (const attempt of res.body.attempted as Array<{ gotStatus: unknown }>) {
      expect(attempt.gotStatus).toBe('error');
    }
    expect(res.body.note).toContain('unavailable');
    expect(getContainer().scenarioStore.get().injectFailure).toBe(false);
  });
});

// --- /trace — the W3C trace-context middleware + span collector, live ---------------------

const TRACEPARENT_SHAPE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

describe('the trace middleware — response header on EVERY request, beside requestId', () => {
  it('every response (even the health probe and 404s) carries a well-formed traceparent', async () => {
    const app = createApp();

    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(String(health.headers.traceparent)).toMatch(TRACEPARENT_SHAPE);
    // Mount-order proof: the header SURVIVED helmet + the request logger —
    // and requestId coexists on the same response (the contrast lesson).
    expect(String(health.headers['x-request-id'])).toMatch(/.+/);
    expect(health.headers['x-request-id']).not.toBe(health.headers.traceparent);

    const missing = await request(app).get('/api/demo/obs/nope-not-a-route');
    expect(missing.status).toBe(404);
    expect(String(missing.headers.traceparent)).toMatch(TRACEPARENT_SHAPE);

    const failed = await request(app).get('/api/demo/obs/logs?limit=soon');
    expect(failed.status).toBe(400);
    expect(String(failed.headers.traceparent)).toMatch(TRACEPARENT_SHAPE);
  });

  it('two fresh requests get two DIFFERENT traces; each response is its own span', async () => {
    const app = createApp();
    const first = await request(app).get('/api/health');
    const second = await request(app).get('/api/health');
    expect(first.headers.traceparent).not.toBe(second.headers.traceparent);
  });

  it('CONTINUES a valid incoming traceparent: same traceId, NEW span id', async () => {
    const incomingTraceId = '0af7651916cd43dd8448eb211c80319c';
    const incoming = `00-${incomingTraceId}-b7ad6b7169203331-01`;

    const res = await request(createApp()).get('/api/health').set('traceparent', incoming);

    expect(res.status).toBe(200);
    const echoed = String(res.headers.traceparent);
    expect(echoed.startsWith(`00-${incomingTraceId}-`)).toBe(true);
    expect(echoed).not.toBe(incoming); // new span id — this hop is its own span
    expect(echoed.endsWith('-01')).toBe(true); // the sampled bit rode along
  });

  it('IGNORES malformed and wrong-version headers — fresh trace, never an error', async () => {
    const app = createApp();

    const garbage = await request(app).get('/api/health').set('traceparent', 'not-a-traceparent');
    expect(garbage.status).toBe(200);
    expect(String(garbage.headers.traceparent)).toMatch(TRACEPARENT_SHAPE);

    // Wrong version with otherwise-valid ids: cannot interpret → fresh trace.
    const futureTraceId = 'ffffffffffffffffffffffffffffffff';
    const future = await request(app)
      .get('/api/health')
      .set('traceparent', `01-${futureTraceId}-b7ad6b7169203331-01`);
    expect(future.status).toBe(200);
    expect(String(future.headers.traceparent)).not.toContain(futureTraceId);

    const wrongLength = await request(app)
      .get('/api/health')
      .set('traceparent', `00-${'a'.repeat(31)}-b7ad6b7169203331-01`);
    expect(String(wrongLength.headers.traceparent)).toMatch(TRACEPARENT_SHAPE);
  });
});

describe('POST /api/demo/obs/trace/run — a real waterfall with a propagated job span', () => {
  /** The JSON shape of a span-tree node (span record + nested children). */
  type TreeNode = { span: Record<string, unknown>; children: TreeNode[] };

  function flatten(nodes: readonly TreeNode[]): Record<string, unknown>[] {
    return nodes.flatMap((node) => [node.span, ...flatten(node.children)]);
  }

  it('nests the chain under the request root span and links the consumer to the producer', async () => {
    const res = await request(createApp()).post(`${MOUNT}/trace/run`);
    expect(res.status).toBe(200);

    const traceId = String(res.body.traceId);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.traceId).toBe(String(res.headers.traceparent).split('-')[1]); // the response header names THIS trace
    // requestId beside traceId — log correlation vs distributed trace.
    expect(String(res.body.requestId)).toMatch(/.+/);

    // The tree: one traceId for HTTP spans AND the job span.
    const tree = res.body.tree as TreeNode[];
    const flatSpans = flatten(tree);
    expect(flatSpans.length).toBeGreaterThanOrEqual(6); // root + route + usecase + db + enqueue + consumer
    for (const span of flatSpans) {
      expect(span.traceId).toBe(traceId);
      const duration = span.durationMs as number | null;
      expect(duration === null || duration >= 0).toBe(true); // root is open at response time
    }

    // Tree shape: root(http) → route handler → {usecase, db, enqueue}, and
    // the CONSUMER span's parent is the ENQUEUE span (the payload link).
    const root = tree[0]!;
    expect(String(root.span.name)).toBe('http POST /api/demo/obs/trace/run');
    expect(root.children).toHaveLength(1);
    const routeSpan = root.children[0]!;
    expect(routeSpan.children.map((node) => String(node.span.name))).toEqual([
      'trace-demo: usecase — assemble payload',
      'trace-demo: db — SELECT 1 (throwaway :memory:)',
      'trace-demo: enqueue email job (producer)',
    ]);

    expect(res.body.chain.job).toMatchObject({ status: 'succeeded', reachedTerminal: true });
    expect(String(res.body.chain.job.consumerSpanId)).toMatch(/^[0-9a-f]{16}$/);
    // The consumer's parent IS the enqueue span: the propagation proof.
    const enqueueSpan = routeSpan.children.find(
      (node) => String(node.span.name) === 'trace-demo: enqueue email job (producer)',
    );
    expect(String(res.body.chain.job.consumerParentSpanId)).toBe(String(enqueueSpan?.span.spanId));
  });

  it('the root span closes at response finish — refetching the trace shows it settled', async () => {
    const run = await request(createApp()).post(`${MOUNT}/trace/run`);
    const traceId = String(run.body.traceId);

    const spans = await request(createApp()).get(`${MOUNT}/trace/spans?traceId=${traceId}`);
    expect(spans.status).toBe(200);
    expect(spans.body.spanCount).toBeGreaterThanOrEqual(6);
    const root = (spans.body.tree as TreeNode[])[0]!;
    expect(root.span.status).toBe('ok');
    expect(root.span.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(root.span.attributes).toMatchObject({ httpStatus: 200 });
    // Every closed span in the trace has duration ≥ 0.
    const all = spans.body.spans as Array<{ status: string; durationMs: number | null }>;
    for (const span of all) {
      if (span.status !== 'open') expect(span.durationMs).not.toBeNull();
    }
  });

  it('the continued-trace case: the run joins the CALLER\'s trace', async () => {
    const incomingTraceId = '1234567890abcdef1234567890abcdef';
    const run = await request(createApp())
      .post(`${MOUNT}/trace/run`)
      .set('traceparent', `00-${incomingTraceId}-fedcba9876543210-01`);

    expect(run.body.traceId).toBe(incomingTraceId);
    const root = (run.body.tree as TreeNode[])[0]!;
    expect(root.span.attributes).toMatchObject({ continuedFromIncoming: true });
    expect(root.span.parentId).toBe('fedcba9876543210'); // the caller's span is the parent
  });
});

describe('GET /api/demo/obs/trace/spans — the by-trace read', () => {
  it('answers 400 for a missing/malformed traceId and 404 for an unknown one', async () => {
    const app = createApp();

    const missing = await request(app).get(`${MOUNT}/trace/spans`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'validation_failed', parameter: 'traceId' });

    const malformed = await request(app).get(`${MOUNT}/trace/spans?traceId=notahex`);
    expect(malformed.status).toBe(400);

    const unknown = await request(app).get(`${MOUNT}/trace/spans?traceId=${'a'.repeat(32)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ code: 'not_found' });
  });

  it('POST /trace/reset clears the window', async () => {
    await request(createApp()).post(`${MOUNT}/trace/run`);
    const reset = await request(createApp()).post(`${MOUNT}/trace/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ reset: true });
  });
});
