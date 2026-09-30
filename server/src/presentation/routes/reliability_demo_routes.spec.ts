import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  getReliabilityDemoWorld,
  resetReliabilityDemoWorld,
} from '../../domain/reliability/flaky_service.js';
import { RELIABILITY_DEMO_MOUNT_PATH } from './reliability_demo_routes.js';

/**
 * The routes over the REAL breaker + flaky simulator (real timers, demo-snappy
 * latencies: ~50ms hops, a 300ms deadline). The state-machine choreography at
 * fake-clock speed lives in circuit_breaker.spec.ts; these specs pin the HTTP
 * surface: the status shape, mode validation, the mode-switch-keeps-breaker
 * contract, the ~0ms rejected-fast call, the slow-mode timeout, and the
 * transition timeline the client renders.
 */

interface BreakerStats {
  name: string;
  state: string;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  openedAt: string | null;
  totalRejected: number;
  config: Record<string, unknown>;
}

interface StatusBody {
  breaker: BreakerStats;
  cooldownRemainingMs: number;
  flaky: { mode: string; modes: string[]; latenciesMs: Record<string, number>; timeoutMs: number };
  history: { at: string; from: string; to: string; reason: string }[];
  note: string;
}

interface CallBody {
  outcome: 'success' | 'failure' | 'rejected-fast';
  ms: number;
  breakerState: string;
  cooldownRemainingMs: number;
  value?: { mode: string; note: string };
  failure?: { kind: string; message: string; details?: Record<string, unknown> };
  note?: string;
}

const app = createApp();

async function setMode(mode: string) {
  return request(app).post(`${RELIABILITY_DEMO_MOUNT_PATH}/mode`).send({ mode });
}

async function callOnce() {
  return request(app).post(`${RELIABILITY_DEMO_MOUNT_PATH}/call`);
}

beforeEach(() => {
  resetReliabilityDemoWorld();
});

afterEach(() => {
  resetReliabilityDemoWorld();
});

describe('GET /api/demo/reliability/status — the watchable state', () => {
  it('reports the fresh breaker, healthy flaky mode, and the documented config', async () => {
    const res = await request(app).get(`${RELIABILITY_DEMO_MOUNT_PATH}/status`);
    expect(res.status).toBe(200);

    const body = res.body as StatusBody;
    expect(body.breaker).toMatchObject({
      name: 'flaky-inventory-service',
      state: 'closed',
      consecutiveFailures: 0,
      totalRejected: 0,
    });
    expect(body.breaker.config).toMatchObject({
      failureThreshold: 3,
      cooldownMs: 4000,
      halfOpenSuccesses: 2,
      timeoutMs: 300,
    });
    expect(body.flaky.mode).toBe('healthy');
    expect(body.flaky.modes).toEqual(['healthy', 'failing', 'slow']);
    expect(body.flaky.latenciesMs).toEqual({ healthy: 50, failing: 50, slow: 800 });
    expect(body.history).toEqual([]);
    expect(body.cooldownRemainingMs).toBe(0);
    expect(typeof body.note).toBe('string');
  });
});

describe('POST /api/demo/reliability/mode — steering the dependency', () => {
  it('rejects an unknown mode with the canonical 400 envelope', async () => {
    const res = await setMode('sometimes');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('switches the mode but KEEPS the breaker state (open it, then heal it)', async () => {
    await setMode('failing');
    for (let i = 0; i < 3; i += 1) await callOnce();

    const switched = await setMode('healthy');
    expect(switched.status).toBe(200);
    expect((switched.body as StatusBody).flaky.mode).toBe('healthy');
    expect((switched.body as StatusBody).breaker.state).toBe('open');
    expect((switched.body as StatusBody).cooldownRemainingMs).toBeGreaterThan(0);
  });
});

describe('POST /api/demo/reliability/call — outcomes through the breaker', () => {
  it('healthy calls succeed (outcome success, real ms)', async () => {
    const res = await callOnce();
    expect(res.status).toBe(200);

    const body = res.body as CallBody;
    expect(body.outcome).toBe('success');
    expect(body.ms).toBeGreaterThanOrEqual(30); // the ~50ms simulated hop
    expect(body.ms).toBeLessThan(2000); // generous upper bound, still a real timer
    expect(body.breakerState).toBe('closed');
    expect(body.value?.mode).toBe('healthy');
  });

  it('3 failing calls OPEN the circuit; the 4th is rejected-fast under 5ms', async () => {
    await setMode('failing');
    for (let i = 0; i < 3; i += 1) {
      const res = await callOnce();
      expect((res.body as CallBody).outcome).toBe('failure');
      expect((res.body as CallBody).failure?.kind).toBe('unavailable');
    }

    const status = await request(app).get(`${RELIABILITY_DEMO_MOUNT_PATH}/status`);
    expect((status.body as StatusBody).breaker.state).toBe('open');

    const rejected = await callOnce();
    expect(rejected.status).toBe(200); // a rejection is a successful OBSERVATION
    const body = rejected.body as CallBody;
    expect(body.outcome).toBe('rejected-fast');
    expect(body.ms).toBeLessThan(5); // no dependency latency — the whole point
    expect(body.failure?.details?.rejectedFast).toBe(true);
    expect(body.breakerState).toBe('open');
    expect(body.note).toContain('~0ms');
  });

  it('slow mode counts as failure via the 300ms deadline (timeouts trip breakers)', async () => {
    await setMode('slow');
    const res = await callOnce();
    expect(res.status).toBe(200);

    const body = res.body as CallBody;
    expect(body.outcome).toBe('failure');
    expect(body.failure?.details?.timedOut).toBe(true);
    // The deadline fired at ~300ms — NOT the 800ms the dependency needed.
    expect(body.ms).toBeGreaterThanOrEqual(250);
    expect(body.ms).toBeLessThan(750);
    expect(body.breakerState).toBe('closed'); // one failure of three — not open yet
  });

  it('records the state transitions the client renders as a timeline', async () => {
    await setMode('failing');
    for (let i = 0; i < 3; i += 1) await callOnce();

    const status = await request(app).get(`${RELIABILITY_DEMO_MOUNT_PATH}/status`);
    const history = (status.body as StatusBody).history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from: 'closed', to: 'open' });
    expect(typeof history[0]?.at).toBe('string');
    expect(new Date(history[0]?.at ?? 0).toString()).not.toBe('Invalid Date');
  });
});

describe('POST /api/demo/reliability/reset — a fresh breaker', () => {
  it('returns the breaker to CLOSED with the healthy mode, zero rejections', async () => {
    await setMode('failing');
    for (let i = 0; i < 3; i += 1) await callOnce();

    const res = await request(app).post(`${RELIABILITY_DEMO_MOUNT_PATH}/reset`);
    expect(res.status).toBe(200);
    const body = res.body as StatusBody;
    expect(body.breaker.state).toBe('closed');
    expect(body.breaker.totalRejected).toBe(0);
    expect(body.flaky.mode).toBe('healthy');
    expect(body.history).toEqual([]);

    // And the fresh world is the one the routes serve.
    expect(getReliabilityDemoWorld().breaker.stats().state).toBe('closed');
  });
});
