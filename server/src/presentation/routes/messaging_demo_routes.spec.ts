import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { MESSAGING_DEMO_MOUNT_PATH } from './messaging_demo_routes.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import { closeRedis } from '../../data/redis/redis_client.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * The messaging demo endpoints over HTTP, in the same two worlds every
 * redis-optional spec uses:
 *
 * - DEFAULT SUITE (no REDIS_TEST_URI): the stream/relay surfaces answer the
 *   canonical 503 envelope (optional service off), input-shape errors still
 *   400 — and the outbox ENQUEUE half is exercised fully, because it is pure
 *   sqlite: the atomicity proof (business write + outbox row commit together,
 *   crash rolls back both) needs no broker at all. That is the pattern's
 *   first selling point, proven here on purpose.
 * - REDIS_TEST_URI SET (live compose redis): the full stream lab round-trip —
 *   produce, consumer-group consume with ack, pending inspection, XAUTOCLAIM
 *   reclaim, the poison-message DLQ path, and the relay's at-least-once
 *   duplicate after crashAfterPublish. Every scenario resets first: shared
 *   redis, virgin lab.
 */

const MOUNT = MESSAGING_DEMO_MOUNT_PATH; // /api/demo/msg
const FIRST_POST = SEED_POSTS[0]!;

afterAll(async () => {
  await closeRedis();
});

// --- the outbox enqueue half: pure sqlite, always on ------------------------------------

describe('POST /api/demo/msg/outbox/enqueue — the transactional outbox enqueue (pure sqlite)', () => {
  it('commits the post update AND the outbox row in one transaction', async () => {
    // Each spec file runs in its own vitest worker: this is the file's first
    // touch of the process-global in-memory handle, so it starts virgin.
    const res = await request(createApp())
      .post(`${MOUNT}/outbox/enqueue`)
      .send({ title: 'Enqueued, not just updated', changedBy: 'the outbox spec' });

    expect(res.status).toBe(200);
    expect(res.body.crash).toBe(false);
    expect(res.body.enqueued).toBe(true);
    expect(res.body.rolledBack).toBe(false);
    expect(res.body.post.title).toBe('Enqueued, not just updated');
    expect(res.body.outboxRowCount).toBe(1);

    const row = res.body.outboxRows[0];
    expect(row).toMatchObject({
      topic: 'post.updated',
      publishedAt: null,
      attempts: 0,
    });
    expect(row.payload).toMatchObject({
      postId: FIRST_POST.id,
      title: 'Enqueued, not just updated',
      changedBy: 'the outbox spec',
    });
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.nextAttemptAt).toBe(row.createdAt); // due immediately
  });

  it('crash=true rolls back BOTH writes — no change, no message (the atomicity proof)', async () => {
    const before = await request(createApp()).get(`${MOUNT}/outbox`);
    const rowsBefore = before.body.rows as unknown[];

    const res = await request(createApp())
      .post(`${MOUNT}/outbox/enqueue`)
      .send({ title: 'this title must never persist', crash: true });

    expect(res.status).toBe(200); // observing the rollback IS the successful outcome
    expect(res.body.crash).toBe(true);
    expect(res.body.enqueued).toBe(false);
    expect(res.body.rolledBack).toBe(true);
    // Neither half landed: the post kept its previous title…
    expect(res.body.post.title).not.toBe('this title must never persist');
    // …and the ledger did not grow.
    expect(res.body.outboxRowCount).toBe(rowsBefore.length);

    const after = await request(createApp()).get(`${MOUNT}/outbox`);
    expect((after.body.rows as unknown[]).length).toBe(rowsBefore.length);
    for (const row of after.body.rows as { payload: { title: string } }[]) {
      expect(row.payload.title).not.toBe('this title must never persist');
    }
  });

  it('answers 404 for an unknown post and 400 for malformed input', async () => {
    const unknown = await request(createApp())
      .post(`${MOUNT}/outbox/enqueue`)
      .send({ postId: 'nope', title: 'x' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');

    for (const body of ['a string', [1], { title: 42 }, { title: '   ' }]) {
      const res = await request(createApp()).post(`${MOUNT}/outbox/enqueue`).send(body);
      expect(res.status, `body ${String(JSON.stringify(body))}`).toBe(400);
      expect(res.body.error.code, `body ${String(JSON.stringify(body))}`).toBe('validation_failed');
      expect(res.body.error.requestId, `body ${String(JSON.stringify(body))}`).toMatch(UUID_RE);
    }
  });

  it('lists the ledger with its teaching note', async () => {
    const res = await request(createApp()).get(`${MOUNT}/outbox`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.note).toContain('published_at NULL');
  });
});

// --- the default-suite degradation contract -----------------------------------------------

describe.skipIf(process.env.REDIS_TEST_URI !== undefined)(
  'messaging demo with the feature OFF (the default suite world)',
  () => {
    it('stream + relay endpoints answer the canonical 503 unavailable envelope', async () => {
      for (const [method, url] of [
        ['post', `${MOUNT}/stream/produce`],
        ['post', `${MOUNT}/stream/consume`],
        ['get', `${MOUNT}/stream/pending`],
        ['post', `${MOUNT}/stream/reclaim`],
        ['get', `${MOUNT}/stream/dlq`],
        ['get', `${MOUNT}/stream/info`],
        ['post', `${MOUNT}/outbox/relay`],
        ['get', `${MOUNT}/outbox/stream`],
      ] as const) {
        const res = method === 'get'
          ? await request(createApp()).get(url)
          : await request(createApp()).post(url).send({});
        expect(res.status, `${method.toUpperCase()} ${url}`).toBe(503);
        expect(res.body.error.code, `${method.toUpperCase()} ${url}`).toBe('service_unavailable');
        expect(res.body.error.requestId, `${method.toUpperCase()} ${url}`).toMatch(UUID_RE);
      }
    });

    it('input-shape errors still answer 400 without consulting redis', async () => {
      const attempts = [
        { url: `${MOUNT}/stream/consume`, body: { ack: 'yes' } },
        { url: `${MOUNT}/stream/consume`, body: { count: 0 } },
        { url: `${MOUNT}/stream/consume`, body: { consumer: 42 } },
        { url: `${MOUNT}/stream/produce`, body: 'a string' },
        { url: `${MOUNT}/outbox/relay`, body: { crashAfterPublish: true, failPublish: true } },
      ] as const;
      for (const { url, body } of attempts) {
        const res = await request(createApp()).post(url).send(body);
        expect(res.status, `${url} ${String(JSON.stringify(body))}`).toBe(400);
        expect(res.body.error.code).toBe('validation_failed');
      }
    });
  },
);

// --- the live world: a real redis stream, real consumer group -----------------------------

describe.skipIf(process.env.REDIS_TEST_URI === undefined)(
  'the stream lab against live redis (REDIS_TEST_URI set)',
  () => {
    it('produces with XADD and consumes via the consumer group with XACK', async () => {
      await request(createApp()).post(`${MOUNT}/stream/reset`).expect(200);

      const produce = await request(createApp())
        .post(`${MOUNT}/stream/produce`)
        .send({ message: { kind: 'order', id: 7 } });
      expect(produce.status).toBe(201);
      expect(produce.body.id).toMatch(/^\d+-\d+$/);
      expect(produce.body.fields).toMatchObject({ retryCount: 0 });
      expect(produce.body.fields.payload).toEqual({ kind: 'order', id: 7 });
      expect(produce.body.streamLength).toBe(1);

      const consume = await request(createApp())
        .post(`${MOUNT}/stream/consume`)
        .send({ consumer: 'w1' });
      expect(consume.status).toBe(200);
      expect(consume.body.consumer).toBe('w1');
      expect(consume.body.empty).toBe(false);
      expect(consume.body.messages).toHaveLength(1);
      expect(consume.body.messages[0].outcome).toBe('acked');
      expect(consume.body.messages[0].fields.payload).toEqual({ kind: 'order', id: 7 });

      // Acked = gone from the PEL; a second read has nothing NEW ('>').
      const again = await request(createApp()).post(`${MOUNT}/stream/consume`).send({ consumer: 'w1' });
      expect(again.status).toBe(200);
      expect(again.body.empty).toBe(true);
      expect(again.body.messages).toEqual([]);

      const info = await request(createApp()).get(`${MOUNT}/stream/info`);
      expect(info.status).toBe(200);
      expect(info.body.stream.length).toBe(1);
      expect(info.body.dlq.length).toBe(0);
      expect(info.body.groups).toHaveLength(1);
      expect(info.body.groups[0]).toMatchObject({ name: 'lab-workers', pending: 0 });
      expect(info.body.groups[0].consumers).toBeGreaterThanOrEqual(1);
    });

    it('round-trips pending + reclaim: unacked work returns via XAUTOCLAIM (visibility timeout)', async () => {
      await request(createApp()).post(`${MOUNT}/stream/reset`).expect(200);
      await request(createApp())
        .post(`${MOUNT}/stream/produce`)
        .send({ message: 'claimed after the crash' })
        .expect(201);

      // The worker processes but dies before XACK (ack:false).
      const crashed = await request(createApp())
        .post(`${MOUNT}/stream/consume`)
        .send({ consumer: 'w1', ack: false });
      expect(crashed.status).toBe(200);
      expect(crashed.body.messages[0].outcome).toBe('left-pending');

      // XPENDING: the entry is NOT lost — it names its consumer and clocks idle time.
      const pending = await request(createApp()).get(`${MOUNT}/stream/pending`);
      expect(pending.status).toBe(200);
      expect(pending.body.summary.total).toBe(1);
      expect(pending.body.summary.perConsumer).toEqual([{ consumer: 'w1', count: 1 }]);
      expect(pending.body.entries).toHaveLength(1);
      expect(pending.body.entries[0].consumer).toBe('w1');
      expect(pending.body.entries[0].idleMs).toBeGreaterThanOrEqual(0);
      expect(pending.body.entries[0].deliveries).toBe(1);
      expect(pending.body.entries[0].id).toMatch(/^\d+-\d+$/);

      // The consumer filter narrows the same inspection.
      const filtered = await request(createApp()).get(`${MOUNT}/stream/pending?consumer=w1`);
      expect(filtered.body.entries).toHaveLength(1);
      const other = await request(createApp()).get(`${MOUNT}/stream/pending?consumer=nobody`);
      expect(other.body.entries).toEqual([]);

      // XAUTOCLAIM after the idle threshold: a live worker takes it over.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const reclaim = await request(createApp())
        .post(`${MOUNT}/stream/reclaim`)
        .send({ minIdleMs: 10, consumer: 'w2' });
      expect(reclaim.status).toBe(200);
      expect(reclaim.body.reclaimed).toHaveLength(1);
      expect(reclaim.body.reclaimed[0].acked).toBe(true);
      expect(reclaim.body.reclaimed[0].fields.payload).toBe('claimed after the crash');

      const after = await request(createApp()).get(`${MOUNT}/stream/pending`);
      expect(after.body.summary.total).toBe(0);
      expect(after.body.entries).toEqual([]);
    });

    it('dead-letters a poison message after the retry budget — moved, not lost', async () => {
      await request(createApp()).post(`${MOUNT}/stream/reset`).expect(200);
      await request(createApp())
        .post(`${MOUNT}/stream/produce`)
        .send({ message: 'poison' })
        .expect(201);

      const outcomes: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const res = await request(createApp())
          .post(`${MOUNT}/stream/consume`)
          .send({ consumer: 'w1', fail: true });
        expect(res.status).toBe(200);
        expect(res.body.messages).toHaveLength(1);
        outcomes.push(res.body.messages[0].outcome as string);
        // The retry counter rides the message header, incrementing per requeue.
        expect(res.body.messages[0].fields.retryCount).toBe(attempt - 1);
      }
      // 2 requeues (retryCount 0→1→2), then the 3rd failed attempt dead-letters.
      expect(outcomes).toEqual(['requeued', 'requeued', 'dead-lettered']);

      const dlq = await request(createApp()).get(`${MOUNT}/stream/dlq`);
      expect(dlq.status).toBe(200);
      expect(dlq.body.entries).toHaveLength(1);
      expect(dlq.body.entries[0].fields.payload).toBe('poison');
      expect(dlq.body.entries[0].fields.originalId).toMatch(/^\d+-\d+$/);
      expect(dlq.body.entries[0].fields.retryCount).toBe(3); // attempts spent
      expect(dlq.body.entries[0].fields.reason).toContain('3');

      // The original left the stream AND the PEL — only the DLQ copy remains.
      const pending = await request(createApp()).get(`${MOUNT}/stream/pending`);
      expect(pending.body.summary.total).toBe(0);
      const info = await request(createApp()).get(`${MOUNT}/stream/info`);
      expect(info.body.dlq.length).toBe(1);
    });
  },
);

// --- the live world: the relay's at-least-once proof ---------------------------------------

describe.skipIf(process.env.REDIS_TEST_URI === undefined)(
  'the transactional outbox relay against live redis (REDIS_TEST_URI set)',
  () => {
    it('ships due rows once, marks them published, and ships nothing on a dry run', async () => {
      await request(createApp()).post(`${MOUNT}/outbox/reset`).expect(200);
      await request(createApp())
        .post(`${MOUNT}/outbox/enqueue`)
        .send({ title: 'Relay me once', changedBy: 'the relay spec' })
        .expect(200);

      const first = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({});
      expect(first.status).toBe(200);
      expect(first.body.crashedAfterPublish).toBeNull();
      expect(first.body.published).toHaveLength(1);
      expect(first.body.published[0]).toMatchObject({ topic: 'post.updated', markedPublished: true, alreadyDelivered: false });
      expect(first.body.published[0].entryId).toMatch(/^\d+-\d+$/);
      expect(first.body.failedRetries).toEqual([]);
      expect(first.body.skippedNotDue).toBe(0);

      const row = (first.body.rows as { publishedAt: string | null; attempts: number }[]).find(
        (candidate) => candidate.publishedAt !== null,
      );
      expect(row).toBeDefined();

      const second = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({});
      expect(second.body.published).toEqual([]); // marked rows are never due again

      const stream = await request(createApp()).get(`${MOUNT}/outbox/stream`);
      expect(stream.body.entries).toHaveLength(1); // exactly one delivery
    });

    it('PROVES at-least-once: crashAfterPublish leaves the row unmarked, the next run ships the DUPLICATE', async () => {
      await request(createApp()).post(`${MOUNT}/outbox/reset`).expect(200);
      await request(createApp())
        .post(`${MOUNT}/outbox/enqueue`)
        .send({ title: 'Ship me twice', changedBy: 'the crash spec' })
        .expect(200);

      // The crash: publish happens, mark does not.
      const crash = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({ crashAfterPublish: true });
      expect(crash.status).toBe(200);
      expect(crash.body.crashedAfterPublish).toMatchObject({ outboxId: expect.any(Number) });
      expect(crash.body.published).toEqual([]); // nothing was MARKED
      const unmarked = (crash.body.rows as { publishedAt: string | null }[]).find(
        (row) => row.publishedAt === null,
      );
      expect(unmarked).toBeDefined();
      // …but the stream already carries the entry (the publish DID happen).
      const afterCrash = await request(createApp()).get(`${MOUNT}/outbox/stream`);
      expect(afterCrash.body.entries).toHaveLength(1);

      // Recovery: the still-due row ships AGAIN — the duplicate, detected.
      const recovery = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({});
      expect(recovery.status).toBe(200);
      expect(recovery.body.published).toHaveLength(1);
      expect(recovery.body.published[0].alreadyDelivered).toBe(true); // THE proof
      expect(recovery.body.published[0].markedPublished).toBe(true);

      const stream = await request(createApp()).get(`${MOUNT}/outbox/stream`);
      expect(stream.body.entries).toHaveLength(2); // two deliveries, same outbox id
      const [first, second] = stream.body.entries as { outboxId: number }[];
      expect(second.outboxId).toBe(first.outboxId);

      // A dedup consumer (or idempotent handling) resolves it: the relay's
      // third run has nothing due, and the ledger shows exactly one publish mark.
      const dry = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({});
      expect(dry.body.published).toEqual([]);
      const rows = (dry.body.rows as { publishedAt: string | null }[]);
      expect(rows.filter((row) => row.publishedAt !== null)).toHaveLength(1);
    });

    it('failPublish backs off monotonically: attempts grow and an immediate re-run ships nothing', async () => {
      await request(createApp()).post(`${MOUNT}/outbox/reset`).expect(200);
      await request(createApp())
        .post(`${MOUNT}/outbox/enqueue`)
        .send({ title: 'The broker is down', changedBy: 'the backoff spec' })
        .expect(200);

      const first = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({ failPublish: true });
      expect(first.status).toBe(200);
      expect(first.body.published).toEqual([]);
      expect(first.body.failedRetries).toHaveLength(1);
      expect(first.body.failedRetries[0].attempts).toBe(1);
      const firstDeadline = first.body.failedRetries[0].nextAttemptAt as string;
      expect(firstDeadline).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // The backoff is a REAL delay: while it stands, even a healthy relay
      // run ships nothing (the row is simply not due).
      const immediate = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({});
      expect(immediate.body.published).toEqual([]);
      expect(immediate.body.skippedNotDue).toBe(1);

      // Once attempt 1's backoff (~200ms) lapses, the row is due again; a
      // second outage increments attempts and pushes the deadline FURTHER out
      // (attempt 2 backs off ~400ms) — monotonically, never backwards.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({ failPublish: true });
      expect(second.body.failedRetries).toHaveLength(1);
      expect(second.body.failedRetries[0].attempts).toBe(2);
      expect((second.body.failedRetries[0].nextAttemptAt as string) > firstDeadline).toBe(true);

      // And when the backoff lapses with the broker healthy, it ships cleanly.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const clean = await request(createApp()).post(`${MOUNT}/outbox/relay`).send({});
      expect(clean.body.published).toHaveLength(1);
      expect(clean.body.published[0].markedPublished).toBe(true);
    });
  },
);
