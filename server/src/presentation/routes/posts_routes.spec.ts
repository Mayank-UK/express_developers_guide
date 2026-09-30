import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { scenarioStore } from '../../core/scenario/scenario.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import { resetContainer } from '../../di/container.js';
import type { Post } from '../../domain/posts/post.js';
import { UUID_RE } from '../../test_support/index.js';

beforeEach(() => {
  // Hermetic defaults regardless of ambient SCENARIO_* environment values.
  scenarioStore.set({ dataMode: 'fake', injectFailure: false });
  // Fresh wiring per test: the fake repository is reborn from the seed and
  // the memoized container is dropped, so every test starts from the same
  // world regardless of declaration order — no within-file ordering coupling.
  resetContainer();
});

afterEach(() => {
  scenarioStore.reset();
});

/** Mirrors the repositories' list order: createdAt DESC, then id DESC. */
function byListOrder(a: Post, b: Post): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

const seedIdsInListOrder = [...SEED_POSTS].sort(byListOrder).map((post) => post.id);
const seedTitlesInListOrder = [...SEED_POSTS].sort(byListOrder).map((post) => post.title);

describe('GET /api/posts', () => {
  it('lists the 3 seeded posts in fake mode (newest first) with a request id', async () => {
    const res = await request(createApp()).get('/api/posts');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
    expect(res.body.posts).toHaveLength(3);
    expect(res.body.posts.map((post: Post) => post.id)).toEqual(seedIdsInListOrder);
    for (const post of res.body.posts) {
      expect(post).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          title: expect.any(String),
          body: expect.any(String),
          author: expect.any(String),
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      );
    }
  });

  it('serves the SAME seed posts from sqlite after toggling dataMode to live', async () => {
    const toggle = await request(createApp())
      .patch('/api/demo/scenario')
      .send({ dataMode: 'live' });

    expect(toggle.status).toBe(200);
    expect(toggle.body).toEqual({ dataMode: 'live', injectFailure: false });

    const res = await request(createApp()).get('/api/posts');

    expect(res.status).toBe(200);
    // Seed parity: identical ids AND titles from the sqlite path — proving the
    // shared seed payload and the :memory: migration/seeding both work.
    expect(res.body.posts.map((post: Post) => post.id)).toEqual(seedIdsInListOrder);
    expect(res.body.posts.map((post: Post) => post.title)).toEqual(seedTitlesInListOrder);
  });

  it('maps failure injection onto the 503 error envelope', async () => {
    const toggle = await request(createApp())
      .patch('/api/demo/scenario')
      .send({ injectFailure: true });

    expect(toggle.status).toBe(200);
    expect(toggle.body).toEqual({ dataMode: 'fake', injectFailure: true });

    const res = await request(createApp()).get('/api/posts');

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'service_unavailable',
      message: 'Failure injection is ON — this is the demo 503',
      requestId: expect.stringMatching(UUID_RE),
    });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('POST /api/posts', () => {
  const validPayload = {
    title: 'A post from the test suite',
    body: 'Created through the fake repository, freshly seeded for this test by the container reset.',
    author: 'vitest',
  };

  it('creates a post (201) and serves it back by id in the same mode', async () => {
    const create = await request(createApp()).post('/api/posts').send(validPayload);

    expect(create.status).toBe(201);
    expect(create.body).toMatchObject(validPayload);
    expect(create.body.id).toMatch(UUID_RE);
    expect(create.body.createdAt).toEqual(create.body.updatedAt);

    const detail = await request(createApp()).get(`/api/posts/${create.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(create.body);
  });

  it('rejects invalid payloads with a 400 validation envelope naming the fields', async () => {
    const cases: ReadonlyArray<{ payload: Record<string, unknown>; field: string }> = [
      { payload: { title: '', body: 'b', author: 'a' }, field: 'title' },
      { payload: { body: 'b', author: 'a' }, field: 'title' },
      { payload: { title: 't', body: 'b', author: '' }, field: 'author' },
      { payload: { title: 't', body: 'x'.repeat(5001), author: 'a' }, field: 'body' },
      { payload: { title: 't'.repeat(121), body: 'b', author: 'a' }, field: 'title' },
      { payload: { title: 't', body: 'b', author: 'a', surprise: true }, field: 'surprise' },
    ];
    for (const { payload, field } of cases) {
      const res = await request(createApp()).post('/api/posts').send(payload);
      expect(res.status, `field ${field}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(Object.keys(res.body.error.fields ?? {}), `field ${field}`).toContain(field);
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('rejects non-object bodies (arrays, null, urlencoded strings)', async () => {
    const bodies: { label: string; send: () => request.Test }[] = [
      { label: '[]', send: () => request(createApp()).post('/api/posts').send([]) },
      { label: '["title"]', send: () => request(createApp()).post('/api/posts').send(['title']) },
      // superagent's send() typing omits null, though sending it is exactly
      // how an empty body is produced at runtime.
      { label: 'null', send: () => request(createApp()).post('/api/posts').send(null as unknown as object) },
      {
        label: '"a string"',
        send: () => request(createApp()).post('/api/posts').send('a string'),
      },
    ];
    for (const { label, send } of bodies) {
      const res = await send();
      expect(res.status, `body ${label}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.fields).toHaveProperty('body');
    }
  });

  it('answers malformed or bare-scalar JSON with a 400 JSON envelope, not an HTML 500', async () => {
    // express.json() runs in strict mode: only objects/arrays parse, so a bare
    // scalar ("42") is a body-parser 400 before the use case ever sees it —
    // the envelope code is the parser fallback, not validation_failed.
    for (const raw of ['{"title": ', '42']) {
      const res = await request(createApp())
        .post('/api/posts')
        .set('Content-Type', 'application/json')
        .send(raw);

      expect(res.status, `raw ${raw}`).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'request_failed',
        message: expect.any(String),
        requestId: expect.stringMatching(UUID_RE),
      });
      expect(res.headers['content-type'] ?? '').toMatch(/json/);
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    }
  });
});

describe('GET /api/posts/:id', () => {
  it('404s with the error envelope for unknown ids', async () => {
    const res = await request(createApp()).get('/api/posts/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'not_found',
      message: expect.any(String),
      requestId: expect.stringMatching(UUID_RE),
    });
    expect(res.body.error.postId).toBe('does-not-exist');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('PATCH /api/demo/scenario', () => {
  it('accepts an empty patch as a no-op returning the current state', async () => {
    const res = await request(createApp()).patch('/api/demo/scenario').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dataMode: 'fake', injectFailure: false });
  });

  it('rejects invalid patches with a 400 validation envelope', async () => {
    const bodies: { label: string; send: () => request.Test }[] = [
      { label: '{dataMode:"fast"}', send: () => request(createApp()).patch('/api/demo/scenario').send({ dataMode: 'fast' }) },
      { label: '{injectFailure:"yes"}', send: () => request(createApp()).patch('/api/demo/scenario').send({ injectFailure: 'yes' }) },
      {
        label: '{dataMode:"live",bogus:1}',
        send: () => request(createApp()).patch('/api/demo/scenario').send({ dataMode: 'live', bogus: 1 }),
      },
      { label: '["fake"]', send: () => request(createApp()).patch('/api/demo/scenario').send(['fake']) },
      { label: '"fake"', send: () => request(createApp()).patch('/api/demo/scenario').send('fake') },
      { label: 'null', send: () => request(createApp()).patch('/api/demo/scenario').send(null as unknown as object) },
    ];
    for (const { label, send } of bodies) {
      const res = await send();
      expect(res.status, `body ${label}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    }
  });
});
