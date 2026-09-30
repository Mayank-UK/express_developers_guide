import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  __storeSizeForTests,
  resetSessionStoreForTests,
} from '../../domain/auth/session_store.js';
import { getDemoJobQueue, resetJobQueueForTests } from '../../domain/jobs/job_queue.js';
import { isMongoConfigured } from '../../data/mongo/mongo_client.js';
import { isRedisConfigured } from '../../data/redis/redis_client.js';
import { SCALING_DEMO_MOUNT_PATH, type ScalingStateResponse } from './scaling_demo_routes.js';

/**
 * The state inspector's whole claim is that its counts are LIVE — measured
 * from the real module state this process serves with. So the spec drives
 * that state through the REAL surfaces (the login route creates a session;
 * the demo queue's stats say the depth) and pins the response against them.
 */

interface FullState extends ScalingStateResponse {
  statelessOrShared: ScalingStateResponse['statelessOrShared'];
}

function statefulByName(body: FullState, name: string) {
  const item = body.stateful.find((entry) => entry.name === name);
  expect(item).toBeDefined();
  return item!;
}

describe('GET /api/demo/scaling/state — shape', () => {
  it('reports THIS process (pid, uptime, replicas 1) and the honest note', async () => {
    const res = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    expect(res.status).toBe(200);

    const body = res.body as FullState;
    expect(body.process.pid).toBe(process.pid);
    expect(body.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.process.replicas).toBe(1);
    expect(body.process.note).toContain('ITS OWN process');
  });

  it('lists the four hazards, every one breaking scaling with a named fix', async () => {
    const res = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    const body = res.body as FullState;

    expect(body.stateful.map((entry) => entry.name)).toEqual([
      'sessions',
      'rate limiter counters',
      'job queue',
      'SSE connections',
    ]);
    for (const item of body.stateful) {
      expect(item.shared).toBe(false);
      expect(item.breaksScaling).toBe(true);
      expect(item.fix.length).toBeGreaterThan(0);
      expect(item.where.length).toBeGreaterThan(0);
    }
  });

  it('lists the shared/single-writer stores with live configured flags', async () => {
    const res = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    const body = res.body as FullState;

    expect(body.statelessOrShared.map((entry) => entry.name)).toEqual([
      'posts (sqlite)',
      'mongo events',
      'redis cache',
    ]);
    const posts = body.statelessOrShared[0]!;
    expect(posts.shared).toBe('filesystem volume (one file, one writer)');
    expect(posts.note).toContain('NOT multi-replica');
    expect(body.statelessOrShared[1]!.configured).toBe(isMongoConfigured());
    expect(body.statelessOrShared[2]!.configured).toBe(isRedisConfigured());
  });

  it('the verdict names the hazard count', async () => {
    const res = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    const body = res.body as FullState;
    expect(body.verdict).toContain('scaling hazards');
    expect(body.verdict).toContain(String(body.stateful.length));
    expect(body.verdict).toContain('fix column');
  });
});

describe('GET /api/demo/scaling/state — the counts are LIVE', () => {
  it('sessions: 0 on a clean store, then > 0 after a REAL login through the auth route', async () => {
    resetSessionStoreForTests();

    const before = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    expect(statefulByName(before.body as FullState, 'sessions').count).toBe(0);

    const login = await request(createApp())
      .post('/api/demo/auth/login')
      .send({ username: 'alice', password: 'guide-demo-pw' });
    expect(login.status).toBe(200);

    const after = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    const count = statefulByName(after.body as FullState, 'sessions').count;
    expect(count).toBeGreaterThan(0);
    // Live means live: the response count IS the store's size, not a copy.
    expect(count).toBe(__storeSizeForTests());

    resetSessionStoreForTests();
  });

  it('job queue: the reported depth equals the real queue stats at request time', async () => {
    resetJobQueueForTests();
    const queuedBefore = getDemoJobQueue().stats().queued;

    const res = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    const item = statefulByName(res.body as FullState, 'job queue');
    expect(item.count).toBeGreaterThanOrEqual(0);
    expect(item.count).toBe(queuedBefore);
  });

  it('SSE connections: 0 when no ticker stream is open in this process', async () => {
    const res = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    expect(statefulByName(res.body as FullState, 'SSE connections').count).toBe(0);
  });

  it('rate limiter counters: not exposed (null count) but honestly configured', async () => {
    const res = await request(createApp()).get(`${SCALING_DEMO_MOUNT_PATH}/state`);
    const item = statefulByName(res.body as FullState, 'rate limiter counters');

    expect(item.count).toBeNull();
    expect(item.configured).toBe(true);
    expect(item.countNote).toContain('module-private');
    expect(item.countNote).toContain('not exposed');
    // The honest fallback: report what the limiters are configured to do.
    expect(item.configuration).toContain('3 per 30s');
    expect(item.configuration).toContain('5 per 60s');
  });
});
