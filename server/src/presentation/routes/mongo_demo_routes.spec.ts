import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { MONGO_DEMO_MOUNT_PATH } from './mongo_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * The mongo demo endpoints over HTTP, in two worlds:
 *
 * - DEFAULT SUITE (no MONGO_TEST_URI): the feature is OFF (appConfig forces
 *   mongoUri '' under test). Specs prove the graceful degradation contract —
 *   status answers instantly with configured:false, data endpoints answer the
 *   canonical 503 envelope, and input-shape errors still 400 without Mongo.
 * - MONGO_TEST_URI SET: a live compose mongo; full CRUD through HTTP, the
 *   mongoose ValidationError normalized into the canonical envelope, and the
 *   TTL index actually present in the database.
 */

const MOUNT = MONGO_DEMO_MOUNT_PATH; // /api/demo/mongo
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const VALID_EVENT = { kind: 'visit', page: '/topics/mongodb', visitor: 'spec-visitor' };

/** Input-shape validation happens BEFORE any repository call — no Mongo needed. */
describe('mongo demo input validation (always on, Mongo not involved)', () => {
  it('rejects a non-object POST body with the canonical 400 envelope', async () => {
    // (a bare number body is omitted: superagent itself refuses to serialize one)
    for (const body of ['a string', [1, 2]]) {
      const res = await request(createApp()).post(`${MOUNT}/events`).send(body);
      expect(res.status, `body ${String(JSON.stringify(body))}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.errors).toEqual([{ field: '$', message: 'must be a JSON object' }]);
    }
  });

  it('rejects a bad limit and a bad kind filter with 400s naming the parameter', async () => {
    for (const query of ['limit=0', 'limit=101', 'limit=many', 'limit=5&limit=9', 'kind=scroll', 'kind=visit&kind=click']) {
      const res = await request(createApp()).get(`${MOUNT}/events?${query}`);
      expect(res.status, `?${query}`).toBe(400);
      expect(res.body.error.code, `?${query}`).toBe('validation_failed');
      expect(res.body.error.requestId, `?${query}`).toMatch(UUID_RE);
    }
  });

  it('names limit or kind as the offending parameter', async () => {
    const limit = await request(createApp()).get(`${MOUNT}/events?limit=0`);
    expect(limit.body.error.parameter).toBe('limit');
    const kind = await request(createApp()).get(`${MOUNT}/events?kind=scroll`);
    expect(kind.body.error.parameter).toBe('kind');
  });
});

describe.skipIf(process.env.MONGO_TEST_URI !== undefined)(
  'mongo demo with the feature OFF (the default suite world)',
  () => {
    it('status answers instantly: configured false, feature off, no attempt burned', async () => {
      const started = Date.now();
      const res = await request(createApp()).get(`${MOUNT}/status`);

      expect(res.status).toBe(200);
      // The off path answers without touching mongoose: anything close to the
      // 1.5s server-selection timeout would prove a connection was attempted.
      expect(Date.now() - started).toBeLessThan(1000);

      expect(res.body).toMatchObject({
        configured: false,
        connected: false,
        connectionState: 'disconnected',
        uri: '',
        model: 'Event',
      });
      expect(res.body.indexes).toEqual([]);
      expect(res.body.note).toContain('MONGO_URI');
    });

    it('event endpoints answer the canonical 503 unavailable envelope', async () => {
      const post = await request(createApp()).post(`${MOUNT}/events`).send(VALID_EVENT);
      expect(post.status).toBe(503);
      expect(post.body.error.code).toBe('service_unavailable');
      expect(post.body.error.service).toBe('mongo');
      expect(post.body.error.message).toContain('docker compose');
      expect(post.body.error.requestId).toMatch(UUID_RE);

      const list = await request(createApp()).get(`${MOUNT}/events`);
      expect(list.status).toBe(503);
      expect(list.body.error.code).toBe('service_unavailable');

      const clear = await request(createApp()).delete(`${MOUNT}/events`);
      expect(clear.status).toBe(503);
      expect(clear.body.error.code).toBe('service_unavailable');
    });
  },
);

describe.skipIf(!process.env.MONGO_TEST_URI)(
  'mongo demo against a LIVE mongo (MONGO_TEST_URI set)',
  () => {
    afterAll(async () => {
      // Leave the shared spec database clean.
      await request(createApp()).delete(`${MOUNT}/events`);
    });

    it('status: configured, connected, model Event, and BOTH declared indexes live (TTL included)', async () => {
      const res = await request(createApp()).get(`${MOUNT}/status`);
      expect(res.status).toBe(200);

      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(true);
      expect(res.body.connectionState).toBe('connected');
      expect(res.body.model).toBe('Event');

      // host/db only — a credential-bearing configured URI could never leak here.
      expect(res.body.uri).toMatch(/^[^/@]+\/[^/@]+$/);
      expect(res.body.uri).not.toContain('@');

      const names = (res.body.indexes as { name: string }[]).map((index) => index.name);
      expect(names).toEqual(expect.arrayContaining(['page_1_createdAt_-1', 'createdAt_1', '_id_']));

      const ttl = (res.body.indexes as { name: string; expireAfterSeconds?: number }[]).find(
        (index) => index.name === 'createdAt_1',
      );
      expect(ttl?.expireAfterSeconds).toBe(60);
    });

    it('POST creates a document (201) with timestamps and defaults applied', async () => {
      await request(createApp()).delete(`${MOUNT}/events`);

      const res = await request(createApp())
        .post(`${MOUNT}/events`)
        .send({ kind: 'click', page: '/demo', visitor: 'live-spec', meta: { x: 1 } });

      expect(res.status).toBe(201);
      expect(res.body.event).toMatchObject({
        kind: 'click',
        page: '/demo',
        visitor: 'live-spec',
        meta: { x: 1 },
      });
      expect(res.body.event.id).toMatch(/^[0-9a-f]{24}$/); // a BSON ObjectId
      expect(res.body.event.createdAt).toMatch(ISO_RE);
      expect(res.body.event.updatedAt).toMatch(ISO_RE);
    });

    it('POST validation-through-HTTP: mongoose errors normalized into the canonical envelope', async () => {
      const enumRes = await request(createApp())
        .post(`${MOUNT}/events`)
        .send({ kind: 'scroll', page: '/demo', visitor: 'live-spec' });

      expect(enumRes.status).toBe(400);
      expect(enumRes.body.error.code).toBe('validation_failed');
      expect(enumRes.body.error.engine).toBe('mongoose');
      expect(enumRes.body.error.errors).toEqual([
        { field: 'kind', message: '`scroll` is not a valid enum value for path `kind`.' },
      ]);

      const missing = await request(createApp())
        .post(`${MOUNT}/events`)
        .send({ kind: 'visit' });

      expect(missing.status).toBe(400);
      const fields = (missing.body.error.errors as { field: string }[]).map((e) => e.field);
      expect(fields).toEqual(expect.arrayContaining(['page', 'visitor']));
      // The envelope shape is the app's, not mongoose's raw {errors: {$__: …}}.
      expect(missing.body.error._message).toBeUndefined();
    });

    it('GET lists newest-first and reports stats with the TTL facts', async () => {
      await request(createApp()).delete(`${MOUNT}/events`);
      await request(createApp()).post(`${MOUNT}/events`).send({ ...VALID_EVENT, visitor: 'list-spec-a' });
      // createdAt has millisecond precision: separate the inserts so the
      // newest-first ordering below is deterministic.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await request(createApp())
        .post(`${MOUNT}/events`)
        .send({ kind: 'error', page: '/demo', visitor: 'list-spec-b' });

      const res = await request(createApp()).get(`${MOUNT}/events`);
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
      // Newest first: the error event was inserted last.
      expect(res.body.events[0]).toMatchObject({ kind: 'error', visitor: 'list-spec-b' });
      expect(res.body.stats.count).toBe(2);
      expect(res.body.stats.oldest).toMatch(ISO_RE);
      expect(res.body.stats.newest).toMatch(ISO_RE);
      expect(res.body.stats).toMatchObject({ ttlSeconds: 60, ttlIndex: 'createdAt_1' });
    });

    it('GET filters by kind and honors limit', async () => {
      const filtered = await request(createApp()).get(`${MOUNT}/events?kind=error`);
      expect(filtered.status).toBe(200);
      expect(
        (filtered.body.events as { kind: string }[]).every((event) => event.kind === 'error'),
      ).toBe(true);

      const limited = await request(createApp()).get(`${MOUNT}/events?limit=1`);
      expect(limited.body.events).toHaveLength(1);
    });

    it('DELETE clears the collection and the next list sees zero', async () => {
      const cleared = await request(createApp()).delete(`${MOUNT}/events`);
      expect(cleared.status).toBe(200);
      expect(cleared.body.cleared).toBe(true);
      expect(typeof cleared.body.deletedCount).toBe('number');

      const list = await request(createApp()).get(`${MOUNT}/events`);
      expect(list.status).toBe(200);
      expect(list.body.events).toEqual([]);
      expect(list.body.stats.count).toBe(0);
      expect(list.body.stats.oldest).toBeNull();
    });
  },
);
