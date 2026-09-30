import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { scenarioStore } from '../../core/scenario/scenario.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import {
  getRunningGrpcServer,
  startGrpcServer,
  stopGrpcServer,
} from '../grpc/grpc_server.js';
import {
  GRPC_METHOD_PATHS,
  POSTS_PROTO_SOURCE,
  POSTS_SERVICE_DEFINITION,
} from '../grpc/posts_proto.js';
import { UUID_RE } from '../../test_support/index.js';

const STATUS_ENDPOINT = '/api/demo/grpc/status';
const INVOKE_ENDPOINT = '/api/demo/grpc/invoke';

/** POSTs one bridge instruction and returns the supertest response. */
function invoke(app: ReturnType<typeof createApp>, method: string, payload?: unknown) {
  return request(app)
    .post(INVOKE_ENDPOINT)
    .set('content-type', 'application/json')
    .send(payload === undefined ? { method } : { method, payload });
}

beforeEach(() => {
  // Hermetic defaults: fake data, no failure injection — same as the graphql
  // topic's spec (fake mode's seeded posts are identical to SEED_POSTS).
  scenarioStore.set({ dataMode: 'fake', injectFailure: false });
});

afterEach(() => {
  scenarioStore.reset();
});

// The bridge lazily owns one port-0 gRPC server per test file (vitest boots
// routes without server.ts); stopping it here keeps nothing listening.
afterAll(async () => {
  await stopGrpcServer();
});

describe('the loaded proto (runtime loading, no codegen)', () => {
  it('lists exactly the three unary rpcs of guide.v1.PostsService', () => {
    expect(Object.keys(POSTS_SERVICE_DEFINITION).sort()).toEqual(['CreatePost', 'GetPost', 'ListPosts']);
    expect(GRPC_METHOD_PATHS).toEqual({
      ListPosts: '/guide.v1.PostsService/ListPosts',
      GetPost: '/guide.v1.PostsService/GetPost',
      CreatePost: '/guide.v1.PostsService/CreatePost',
    });
  });

  it('serves the proto source byte-identical to the physical posts.proto file', async () => {
    const res = await request(createApp()).get(STATUS_ENDPOINT);
    expect(res.status).toBe(200);
    // The spec's own module URL pins the file beside its loader module.
    const file = readFileSync(new URL('../grpc/posts.proto', import.meta.url), 'utf8');
    expect(res.body.proto).toBe(file);
    expect(res.body.proto).toBe(POSTS_PROTO_SOURCE);
    expect(res.body.proto).toContain('service PostsService');
  });
});

describe('GET /api/demo/grpc/status', () => {
  it('reports the lazy server lifecycle: not running, then running after an invoke', async () => {
    const app = createApp();
    // This spec file boots no server.ts, so before any invoke nothing runs.
    await stopGrpcServer();
    const before = await request(app).get(STATUS_ENDPOINT);
    expect(before.status).toBe(200);
    expect(before.body.running).toBe(false);
    expect(before.body.port).toBeNull();
    expect(before.body.service).toBe('guide.v1.PostsService');
    expect(before.body.methods.map((entry: { method: string }) => entry.method)).toEqual([
      'ListPosts',
      'GetPost',
      'CreatePost',
    ]);

    await invoke(app, 'ListPosts');

    const after = await request(app).get(STATUS_ENDPOINT);
    expect(after.body.running).toBe(true);
    expect(after.body.port).toBeGreaterThan(0);
  });
});

describe('POST /api/demo/grpc/invoke — the happy paths', () => {
  it('ListPosts returns the seed posts (fake mode), newest first, camelCase fields', async () => {
    const res = await invoke(createApp(), 'ListPosts');

    expect(res.status).toBe(200);
    expect(res.body.method).toBe('ListPosts');
    expect(res.body.status).toBe('OK');
    expect(res.body.code).toBe(0);
    expect(res.body.response.posts).toHaveLength(SEED_POSTS.length);
    expect(res.body.response.posts.map((post: { id: string }) => post.id)).toEqual(
      [...SEED_POSTS].reverse().map((post) => post.id),
    );
    expect(res.body.response.posts[0]).toEqual({
      id: SEED_POSTS[2]!.id,
      title: 'Failures are values here',
      body: SEED_POSTS[2]!.body,
      author: 'the guide',
      // proto's created_at crossed the loader's keepCase conversion
      createdAt: SEED_POSTS[2]!.createdAt,
      updatedAt: SEED_POSTS[2]!.updatedAt,
    });
  });

  it('GetPost resolves a real seeded post through the real gRPC roundtrip', async () => {
    const res = await invoke(createApp(), 'GetPost', { id: SEED_POSTS[1]!.id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.response.id).toBe(SEED_POSTS[1]!.id);
    expect(res.body.response.title).toBe('The dependency rule, concretely');
  });

  it('CreatePost creates through gRPC and the post appears in a later ListPosts', async () => {
    const app = createApp();
    const created = await invoke(app, 'CreatePost', {
      title: 'A post over HTTP/2',
      body: 'Browser → HTTP bridge → gRPC → the same posts use case.',
      author: 'the guide',
    });

    expect(created.status).toBe(200);
    expect(created.body.status).toBe('OK');
    expect(created.body.response.id).toMatch(UUID_RE);
    expect(created.body.response.title).toBe('A post over HTTP/2');

    const listed = await invoke(app, 'ListPosts');
    expect(listed.body.response.posts).toHaveLength(SEED_POSTS.length + 1);
    expect(listed.body.response.posts[0].title).toBe('A post over HTTP/2');
  });
});

describe('POST /api/demo/grpc/invoke — gRPC statuses (HTTP stays 200)', () => {
  it('GetPost with an unknown id surfaces NOT_FOUND with the message and trailer facts', async () => {
    const res = await invoke(createApp(), 'GetPost', { id: 'post_0000' });

    expect(res.status).toBe(200); // the bridge observed a failed call; that IS the outcome
    expect(res.body.method).toBe('GetPost');
    expect(res.body.status).toBe('NOT_FOUND');
    expect(res.body.code).toBe(5);
    expect(res.body.message).toBe('no post with id "post_0000"');
    expect(res.body.response).toBeUndefined();
    expect(res.body.failure).toEqual({ kind: 'not_found', errorCode: 'not_found' });
  });

  it('CreatePost validation surfaces INVALID_ARGUMENT (the use case owns validation, not the proto)', async () => {
    const res = await invoke(createApp(), 'CreatePost', { title: '', body: 'b', author: 'a' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('INVALID_ARGUMENT');
    expect(res.body.code).toBe(3);
    expect(res.body.message).toContain('post payload is invalid');
    expect(res.body.failure).toEqual({ kind: 'validation', errorCode: 'validation_failed' });
  });

  it('failure injection surfaces UNAVAILABLE — same scenario switch as REST and GraphQL', async () => {
    scenarioStore.set({ injectFailure: true });
    const res = await invoke(createApp(), 'ListPosts');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UNAVAILABLE');
    expect(res.body.code).toBe(14);
    expect(res.body.message).toContain('Failure injection is ON');
    expect(res.body.failure).toEqual({ kind: 'unavailable', errorCode: 'service_unavailable' });
  });
});

describe('POST /api/demo/grpc/invoke — malformed instructions (the only 400s)', () => {
  it('rejects an unknown method name with the 400 envelope', async () => {
    const res = await invoke(createApp(), 'DeletePost');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toContain('"method"');
  });

  it('rejects a payload that is not a JSON object', async () => {
    const res = await invoke(createApp(), 'ListPosts', ['not', 'an', 'object']);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toContain('"payload"');
  });

  it('rejects a non-object body outright', async () => {
    const res = await request(createApp())
      .post(INVOKE_ENDPOINT)
      .set('content-type', 'application/json')
      .send('"just a string"');

    // express.json is strict: a bare scalar never even reaches the controller
    // (the parser itself 400s with request_failed — the same behavior the
    // TypeScript topic's echo demo documents). Either gate means a 400.
    expect(res.status).toBe(400);
    expect(['request_failed', 'validation_failed']).toContain(res.body.error.code);
  });
});

describe('the gRPC server lifecycle', () => {
  it('binds an ephemeral port when asked for 0 and stop() resolves', async () => {
    await stopGrpcServer(); // deterministic: no matter what earlier tests left
    expect(getRunningGrpcServer()).toBeUndefined();

    const handle = await startGrpcServer(0);
    expect(handle.port).toBeGreaterThan(0);
    expect(getRunningGrpcServer()).toBe(handle);

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(getRunningGrpcServer()).toBeUndefined();

    // And the singleton restarts cleanly afterwards.
    const second = await startGrpcServer(0);
    expect(second.port).toBeGreaterThan(0);
  });
});
