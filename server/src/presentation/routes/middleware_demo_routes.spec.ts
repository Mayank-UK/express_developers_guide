import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import type { PipelineStage } from './middleware_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

interface TraceAssertion {
  labels: readonly string[];
  elapsedNonDecreasing: boolean;
}

/**
 * Parses and shape-checks the x-pipeline header: it must exist, be compact
 * JSON (parseable), and contain only { stage, label, elapsedMs } entries.
 */
function headerTrace(res: request.Response): PipelineStage[] {
  const raw = res.headers['x-pipeline'];
  expect(typeof raw).toBe('string');
  const parsed: unknown = JSON.parse(String(raw));
  expect(Array.isArray(parsed)).toBe(true);
  for (const entry of parsed as unknown[]) {
    expect(entry).toMatchObject({
      stage: expect.any(Number),
      label: expect.any(String),
      elapsedMs: expect.any(Number),
    });
  }
  return parsed as PipelineStage[];
}

/** Label order is asserted exactly; elapsed times only relative to each other. */
function assertTrace(stages: readonly PipelineStage[], expected: TraceAssertion): void {
  expect(stages.map((stage) => stage.label)).toEqual(expected.labels);
  if (expected.elapsedNonDecreasing) {
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].elapsedMs, `stage ${String(i)} elapsed vs previous`).toBeGreaterThanOrEqual(
        stages[i - 1].elapsedMs,
      );
    }
  }
  expect(stages[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
}

describe('GET /api/demo/middleware/pipeline', () => {
  it('runs the full stack and returns the four stamped stages in order', async () => {
    const res = await request(createApp()).get('/api/demo/middleware/pipeline');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pipeline)).toBe(true);
    const pipeline = res.body.pipeline as PipelineStage[];
    expect(pipeline.map((stage) => stage.stage)).toEqual([1, 2, 3, 4]);
    assertTrace(pipeline, {
      labels: ['logger', 'auth', 'validator', 'handler'],
      elapsedNonDecreasing: true,
    });
    expect(res.body.stages).toBe(4);
    expect(typeof res.body.note).toBe('string');
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);

    // The header carries the same trace as the body — error paths rely on it.
    assertTrace(headerTrace(res), {
      labels: ['logger', 'auth', 'validator', 'handler'],
      elapsedNonDecreasing: true,
    });
  });

  it('serves an ASCII-only, single-line header value (no header-encoding hazards)', async () => {
    const res = await request(createApp()).get('/api/demo/middleware/pipeline');
    const raw = String(res.headers['x-pipeline']);
    expect(raw).not.toMatch(/[\r\n]/);
    // eslint-disable-next-line no-control-regex
    expect(raw).toMatch(/^[\x20-\x7E]*$/);
  });
});

describe('GET /api/demo/middleware/short-circuit', () => {
  it('answers 401 itself and the trace stops before validator/handler', async () => {
    const res = await request(createApp()).get('/api/demo/middleware/short-circuit');

    expect(res.status).toBe(401);
    // The canonical error envelope, built by the middleware by hand.
    expect(res.body.error).toEqual({
      code: 'unauthorized',
      message: expect.stringContaining('401'),
      requestId: expect.stringMatching(UUID_RE),
    });
    expect(res.body.error.message).toContain('next() was never called');

    // The truncated chain: logger → auth → the recorded short-circuit. The
    // validator and handler stages are absent — they never ran.
    const trace = headerTrace(res);
    assertTrace(trace, {
      labels: ['logger', 'auth', 'short-circuit'],
      elapsedNonDecreasing: true,
    });
    expect(trace.map((stage) => stage.label)).not.toContain('validator');
    expect(trace.map((stage) => stage.label)).not.toContain('handler');
    expect(trace[0]?.stage).toBe(1);
  });
});

describe('GET /api/demo/middleware/error-path', () => {
  it('forwards the async throw through the local error middleware to the global handler', async () => {
    const res = await request(createApp()).get('/api/demo/middleware/error-path');

    // The GLOBAL error handler renders the envelope (not the demo router):
    // a plain Error falls back to 500 / internal_error with its message kept.
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'internal_error',
      message: 'demo handler exploded on purpose',
      requestId: expect.stringMatching(UUID_RE),
    });

    // All five stages ran, error-handler last — annotated, not swallowed.
    assertTrace(headerTrace(res), {
      labels: ['logger', 'auth', 'validator', 'handler', 'error-handler'],
      elapsedNonDecreasing: true,
    });
  });
});
