import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { REDIS_DEMO_MOUNT_PATH } from './redis_demo_routes.js';
import {
  REDIS_MESSAGE_RING_CAP,
  REDIS_DEMO_NAMESPACE,
  appendCapped,
  subscribe,
  publish,
  toDemoKey,
  type ReceivedMessage,
} from '../../data/redis/redis_playground.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * The redis demo endpoints over HTTP, in two worlds:
 *
 * - DEFAULT SUITE (no REDIS_TEST_URI): the feature is OFF (appConfig forces
 *   redisUrl '' under test). Specs prove the graceful degradation contract —
 *   status answers instantly with configured:false, data endpoints answer the
 *   canonical 503 envelope, and input-shape errors still 400 without Redis.
 *   The pure units (key namespacing, the message ring cap) run always.
 * - REDIS_TEST_URI SET: a live compose redis; the full structure tour with
 *   real replies, the TTL countdown dying on schedule, and the pub/sub
 *   round-trip through a real second connection.
 */

const MOUNT = REDIS_DEMO_MOUNT_PATH; // /api/demo/redis

/** Pure units: no server, no socket — the FLUSH-safety and cap arguments. */
describe('redis playground pure units (always on, Redis not involved)', () => {
  it('toDemoKey namespaces bare keys and leaves namespaced keys untouched', () => {
    expect(toDemoKey('ttl:watch')).toBe(`${REDIS_DEMO_NAMESPACE}ttl:watch`);
    expect(toDemoKey(`${REDIS_DEMO_NAMESPACE}ttl:watch`)).toBe(`${REDIS_DEMO_NAMESPACE}ttl:watch`);
    // The namespace is the FLUSH boundary — everything the demo may delete
    // matches it, which is why FLUSHDB is never called.
    expect(`${REDIS_DEMO_NAMESPACE}anything`).toMatch(/^guide:demo:/);
  });

  it('appendCapped keeps only the newest REDIS_MESSAGE_RING_CAP messages', () => {
    const ring: ReceivedMessage[] = [];
    for (let index = 0; index < REDIS_MESSAGE_RING_CAP + 10; index += 1) {
      appendCapped(ring, {
        channel: 'guide:demo:channel',
        message: `m${String(index)}`,
        receivedAt: new Date(index).toISOString(),
      });
    }
    expect(ring).toHaveLength(REDIS_MESSAGE_RING_CAP);
    expect(ring[0]).toMatchObject({ message: 'm10' }); // the oldest ten dropped
    expect(ring[ring.length - 1]).toMatchObject({ message: `m${String(REDIS_MESSAGE_RING_CAP + 9)}` });
  });
});

describe('redis demo input validation (always on, Redis not involved)', () => {
  it('rejects non-object POST bodies with the canonical 400 envelope', async () => {
    for (const [url, body] of [
      [`${MOUNT}/ttl`, 'a string'],
      [`${MOUNT}/ttl`, [1, 2]],
      [`${MOUNT}/publish`, 'a string'],
    ] as const) {
      const res = await request(createApp()).post(url).send(body);
      expect(res.status, `body ${String(JSON.stringify(body))}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.errors).toEqual([{ field: '$', message: 'must be a JSON object' }]);
    }
  });

  it('rejects a bad seconds / key / blank value with 400s naming the parameter', async () => {
    for (const body of [
      { seconds: 0 },
      { seconds: 601 },
      { seconds: 'many' },
      { seconds: 1.5 },
      { key: 42 },
      { value: '   ' },
    ]) {
      const res = await request(createApp()).post(`${MOUNT}/ttl`).send(body);
      expect(res.status, `body ${String(JSON.stringify(body))}`).toBe(400);
      expect(res.body.error.code, `body ${String(JSON.stringify(body))}`).toBe('validation_failed');
      expect(res.body.error.requestId, `body ${String(JSON.stringify(body))}`).toMatch(UUID_RE);
    }
    expect((await request(createApp()).post(`${MOUNT}/ttl`).send({ seconds: 0 })).body.error.parameter).toBe('seconds');
    expect((await request(createApp()).post(`${MOUNT}/ttl`).send({ key: 42 })).body.error.parameter).toBe('key');
  });

  it('rejects a missing GET ttl key with a 400 naming key', async () => {
    for (const query of ['', '?key=', '?key=++']) {
      const res = await request(createApp()).get(`${MOUNT}/ttl${query}`);
      expect(res.status, `?${query}`).toBe(400);
      expect(res.body.error.parameter, `?${query}`).toBe('key');
    }
  });
});

describe.skipIf(process.env.REDIS_TEST_URI !== undefined)(
  'redis demo with the feature OFF (the default suite world)',
  () => {
    it('status answers instantly: configured false, feature off, no attempt burned', async () => {
      const started = Date.now();
      const res = await request(createApp()).get(`${MOUNT}/status`);

      expect(res.status).toBe(200);
      // The off path answers without touching ioredis: anything close to the
      // ~1.2s connect timeout would prove a connection was attempted.
      expect(Date.now() - started).toBeLessThan(1000);

      expect(res.body).toMatchObject({
        configured: false,
        connected: false,
        host: '',
        serverInfo: null,
      });
      expect(res.body.note).toContain('REDIS_URL');
    });

    it('data endpoints answer the canonical 503 unavailable envelope', async () => {
      const tour = await request(createApp()).get(`${MOUNT}/tour`);
      expect(tour.status).toBe(503);
      expect(tour.body.error.code).toBe('service_unavailable');
      expect(tour.body.error.service).toBe('redis');
      expect(tour.body.error.message).toContain('docker compose');
      expect(tour.body.error.requestId).toMatch(UUID_RE);

      const set = await request(createApp()).post(`${MOUNT}/ttl`).send({});
      expect(set.status).toBe(503);
      expect(set.body.error.code).toBe('service_unavailable');

      const poll = await request(createApp()).get(`${MOUNT}/ttl?key=guide:demo:anything`);
      expect(poll.status).toBe(503);
      expect(poll.body.error.code).toBe('service_unavailable');

      const pub = await request(createApp()).post(`${MOUNT}/publish`).send({});
      expect(pub.status).toBe(503);
      expect(pub.body.error.code).toBe('service_unavailable');

      const messages = await request(createApp()).get(`${MOUNT}/messages`);
      expect(messages.status).toBe(503);
      expect(messages.body.error.code).toBe('service_unavailable');
    });
  },
);

describe.skipIf(!process.env.REDIS_TEST_URI)(
  'redis demo against a LIVE redis (REDIS_TEST_URI set)',
  () => {
    afterAll(async () => {
      // Leave the demo namespace clean for the next experimenter.
      await request(createApp()).get(`${MOUNT}/tour`);
    });

    it('status: configured, connected, and a real server version', async () => {
      const res = await request(createApp()).get(`${MOUNT}/status`);
      expect(res.status).toBe(200);

      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(true);
      // host:port[/db] only — a credential-bearing REDIS_URL could never leak here.
      expect(res.body.host).toMatch(/^[^/@]+/);
      expect(res.body.host).not.toContain('@');
      expect(res.body.serverInfo).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\./) });
    });

    it('tour: all six structure families with real commands and replies', async () => {
      const res = await request(createApp()).get(`${MOUNT}/tour`);
      expect(res.status).toBe(200);

      const steps = res.body.steps as { structure: string; command: string; reply: string; note: string }[];
      const structures = new Set(steps.map((step_) => step_.structure));
      expect([...structures].sort()).toEqual(['counter', 'hash', 'list', 'set', 'sorted-set', 'string']);

      // Real replies, not echoes: the specific values the tour commands produce.
      const byCommand = new Map(steps.map((step_) => [step_.command, step_.reply]));
      expect(steps.length).toBeGreaterThanOrEqual(11);
      expect(byCommand.get(`SET ${REDIS_DEMO_NAMESPACE}greeting "Hello from the express guide"`)).toBe('"OK"');
      expect(JSON.parse(byCommand.get(`GET ${REDIS_DEMO_NAMESPACE}greeting`) ?? 'null')).toBe('Hello from the express guide');
      expect(JSON.parse(steps.filter((step_) => step_.structure === 'counter').map((step_) => step_.reply)[1] ?? 'null')).toBe(2);
      const profile = JSON.parse(steps.filter((step_) => step_.command.startsWith(`HGETALL ${REDIS_DEMO_NAMESPACE}profile`)).map((step_) => step_.reply)[0] ?? 'null');
      expect(profile).toEqual({ name: 'Ada', role: 'engineer' });
      const queue = JSON.parse(steps.filter((step_) => step_.command.startsWith(`LRANGE ${REDIS_DEMO_NAMESPACE}queue`)).map((step_) => step_.reply)[0] ?? 'null');
      expect(queue).toEqual(['third', 'second', 'first']);
      const tags = JSON.parse(steps.filter((step_) => step_.command.startsWith(`SMEMBERS ${REDIS_DEMO_NAMESPACE}tags`)).map((step_) => step_.reply)[0] ?? 'null');
      expect(tags).toEqual(expect.arrayContaining(['node', 'express', 'redis', 'docker']));
      expect(tags).toHaveLength(4);
      const leaderboard = JSON.parse(steps.filter((step_) => step_.command.startsWith(`ZRANGE ${REDIS_DEMO_NAMESPACE}leaderboard`)).map((step_) => step_.reply)[0] ?? 'null');
      expect(leaderboard).toEqual([
        { member: 'grace', score: '250' },
        { member: 'linus', score: '180' },
        { member: 'ada', score: '100' },
      ]);

      // Every key the tour names lives under the demo namespace.
      for (const step_ of steps) {
        if (step_.command.includes(REDIS_DEMO_NAMESPACE)) {
          expect(step_.command).not.toMatch(/(SET|GET|INCR|HSET|LPUSH|SADD|ZADD) (?!guide:demo:)/);
        }
      }
    });

    it('tour is repeatable: a second run produces the same transcript (keys cleaned first)', async () => {
      const first = await request(createApp()).get(`${MOUNT}/tour`);
      const second = await request(createApp()).get(`${MOUNT}/tour`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.steps).toEqual(first.body.steps);
    });

    it('namespacing lives in the SERVICE: a bare key lands under guide:demo:, and the tour clean removes it', async () => {
      // The POST sends a BARE name — no route-side prefixing anymore. The
      // response reports the key redis actually stores: namespaced.
      const set = await request(createApp())
        .post(`${MOUNT}/ttl`)
        .send({ key: 'bare-spec-key', value: 'namespaced by the service', seconds: 60 });
      expect(set.status).toBe(201);
      expect(set.body.key).toBe(`${REDIS_DEMO_NAMESPACE}bare-spec-key`);

      // Polling with the bare name reads the same key (the read namespaces too):
      const poll = await request(createApp()).get(`${MOUNT}/ttl?key=bare-spec-key`);
      expect(poll.status).toBe(200);
      expect(poll.body).toMatchObject({
        key: `${REDIS_DEMO_NAMESPACE}bare-spec-key`,
        exists: true,
        value: 'namespaced by the service',
      });

      // cleanDemoKeys removes EXACTLY the demo namespace — the bare-named
      // entry dies with the tour's reset, which is the FLUSH-safety argument.
      const tour = await request(createApp()).get(`${MOUNT}/tour`);
      expect(tour.status).toBe(200);
      const gone = await request(createApp()).get(`${MOUNT}/ttl?key=bare-spec-key`);
      expect(gone.status).toBe(200);
      expect(gone.body.exists).toBe(false);
      expect(gone.body.value).toBeNull();
    });

    it('TTL: a 10s key counts down; a 1s key is gone ~1.2s later', async () => {
      const set = await request(createApp())
        .post(`${MOUNT}/ttl`)
        .send({ key: 'ttl:spec-watch', value: 'counting down', seconds: 10 });
      expect(set.status).toBe(201);
      expect(set.body).toMatchObject({
        key: `${REDIS_DEMO_NAMESPACE}ttl:spec-watch`,
        value: 'counting down',
        seconds: 10,
      });
      expect(set.body.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const firstPoll = await request(createApp()).get(`${MOUNT}/ttl?key=guide:demo:ttl:spec-watch`);
      expect(firstPoll.status).toBe(200);
      expect(firstPoll.body.exists).toBe(true);
      expect(firstPoll.body.value).toBe('counting down');
      // Ranges, not exact ticks: the first poll sees ~8-10s remaining.
      expect(firstPoll.body.ttlSecondsRemaining).toBeGreaterThanOrEqual(6);
      expect(firstPoll.body.ttlSecondsRemaining).toBeLessThanOrEqual(10);

      const short = await request(createApp()).post(`${MOUNT}/ttl`).send({ seconds: 1 });
      expect(short.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const gone = await request(createApp()).get(`${MOUNT}/ttl?key=${String(short.body.key)}`);
      expect(gone.status).toBe(200);
      expect(gone.body.exists).toBe(false);
      expect(gone.body.ttlSecondsRemaining).toBeNull();
      expect(gone.body.value).toBeNull();
    });

    it('pub/sub: publish round-trips through the server\'s own subscriber', async () => {
      const marker = `spec-${String(Date.now())}`;
      const pub = await request(createApp()).post(`${MOUNT}/publish`).send({ message: marker });
      expect(pub.status).toBe(200);
      expect(pub.body.channel).toBe('guide:demo:channel');
      expect(pub.body.receivers).toBeGreaterThanOrEqual(1); // our subscriber counts
      expect(pub.body.received).toBe(true); // and it actually landed
      expect(
        (pub.body.messages as { message: string }[]).some((entry) => entry.message === marker),
      ).toBe(true);

      const messages = await request(createApp()).get(`${MOUNT}/messages`);
      expect(messages.status).toBe(200);
      expect(
        (messages.body.messages as { channel: string; message: string }[]).some(
          (entry) => entry.channel === 'guide:demo:channel' && entry.message === marker,
        ),
      ).toBe(true);
    });

    it('pub/sub mechanics: subscribe receives, unsubscribe stops receiving', async () => {
      const channel = `guide:demo:spec:${String(Date.now())}`;
      const seen: string[] = [];

      const subscription = await subscribe(channel, (received) => seen.push(received.message));
      if (!subscription.ok) throw new Error(`subscribe failed: ${subscription.error.message}`);

      const before = await publish(channel, 'before-unsubscribe');
      if (!before.ok) throw new Error(`publish failed: ${before.error.message}`);
      expect(before.value.receivers).toBeGreaterThanOrEqual(1);

      // Await the unsubscribe: UNSUBSCRIBE (subscriber connection) and a later
      // PUBLISH (commands connection) are separate sockets with NO ordering
      // guarantee between them — only the server's confirmation makes
      // "receivers: 0" deterministic.
      await subscription.value();
      const after = await publish(channel, 'after-unsubscribe');
      if (!after.ok) throw new Error(`publish failed: ${after.error.message}`);
      expect(after.value.receivers).toBe(0); // nobody is listening now

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(seen).toEqual(['before-unsubscribe']);
    });
  },
);
