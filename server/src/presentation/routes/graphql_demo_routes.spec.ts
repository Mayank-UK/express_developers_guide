import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { scenarioStore } from '../../core/scenario/scenario.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import { UUID_RE } from '../../test_support/index.js';

const ENDPOINT = '/api/graphql';

/** POSTs one GraphQL request envelope and returns the supertest response. */
function gql(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return request(app).post(ENDPOINT).set('content-type', 'application/json').send(body);
}

beforeEach(() => {
  // Hermetic defaults: fake data, no failure injection (fake mode's seeded
  // posts are identical to SEED_POSTS, in repo order newest-first).
  scenarioStore.set({ dataMode: 'fake', injectFailure: false });
});

afterEach(() => {
  scenarioStore.reset();
});

describe('POST /api/graphql — queries', () => {
  it('answers the posts query with the seeded posts (fake mode) and no errors', async () => {
    const res = await gql(createApp(), { query: '{ posts { id title author createdAt } }' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.posts).toHaveLength(SEED_POSTS.length);
    // Repository order: newest first — the seed ids count UP in time.
    expect(res.body.data.posts.map((post: { id: string }) => post.id)).toEqual(
      [...SEED_POSTS].reverse().map((post) => post.id),
    );
    expect(res.body.data.posts[0]).toEqual({
      id: SEED_POSTS[2]!.id,
      title: 'Failures are values here',
      author: 'the guide',
      createdAt: SEED_POSTS[2]!.createdAt,
    });
  });

  it('runs a query with variables: post($id) resolves the seeded post', async () => {
    const res = await gql(createApp(), {
      query: 'query OnePost($id: ID!) { post(id: $id) { id title } }',
      variables: { id: SEED_POSTS[1]!.id },
    });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.post).toEqual({ id: SEED_POSTS[1]!.id, title: 'The dependency rule, concretely' });
  });

  it('unknown id answers nullable data + a not_found error entry (partial data discipline)', async () => {
    const res = await gql(createApp(), {
      query: 'query($id: ID!) { post(id: $id) { title } }',
      variables: { id: '0f1c2b3a-0000-4000-8000-00000000dead' },
    });

    expect(res.status).toBe(200); // the operation executed; this is a field error
    expect(res.body.data.post).toBeNull(); // post is nullable — data survives
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toBe('no post with id "0f1c2b3a-0000-4000-8000-00000000dead"');
    expect(res.body.errors[0].path).toEqual(['post']);
    expect(res.body.errors[0].extensions.code).toBe('not_found');
    expect(res.body.errors[0].extensions.postId).toBe('0f1c2b3a-0000-4000-8000-00000000dead');
  });

  it('supports aliases — the same field asked for under two names in one request', async () => {
    const res = await gql(createApp(), {
      query: '{ newest: posts { title } allPosts: posts { id } }',
    });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.newest).toHaveLength(3);
    expect(res.body.data.allPosts).toHaveLength(3);
    expect(res.body.data.newest[0].title).toBe('Failures are values here');
  });

  it('introspection answers the schema\'s own shape (queryType name)', async () => {
    const res = await gql(createApp(), { query: '{ __schema { queryType { name } } }' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.__schema.queryType.name).toBe('Query');
  });
});

describe('POST /api/graphql — mutations', () => {
  it('createPost runs the same validation path as REST and the post appears in a later query', async () => {
    const app = createApp();
    const created = await gql(app, {
      query:
        'mutation Create($title: String!, $body: String!, $author: String!) { createPost(title: $title, body: $body, author: $author) { id title createdAt } }',
      variables: { title: 'One endpoint, client-shaped', body: 'The client asked for exactly this.', author: 'you' },
    });

    expect(created.status).toBe(200);
    expect(created.body.errors).toBeUndefined();
    expect(created.body.data.createPost.title).toBe('One endpoint, client-shaped');
    expect(created.body.data.createPost.id).toMatch(UUID_RE);

    const listed = await gql(app, { query: '{ posts { title } }' });
    expect(listed.body.data.posts).toHaveLength(SEED_POSTS.length + 1);
    expect(listed.body.data.posts[0].title).toBe('One endpoint, client-shaped'); // newest first
  });

  it('maps validation failures into a GraphQL error with extensions.code and field details', async () => {
    const res = await gql(createApp(), {
      query: 'mutation { createPost(title: "", body: "b", author: "a") { id } }',
    });

    expect(res.status).toBe(200); // execution happened; the resolver threw
    expect(res.body.data).toBeNull(); // createPost is Post! — non-null propagates
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].extensions.code).toBe('validation_failed');
    expect(res.body.errors[0].extensions.fields.title).toMatch(/must be a string of 1 to 120/);
  });
});

describe('POST /api/graphql — errors', () => {
  it('failure injection surfaces as errors[] with code service_unavailable and data null', async () => {
    scenarioStore.set({ injectFailure: true });
    const res = await gql(createApp(), { query: '{ posts { id } }' });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull(); // [Post!]! — a field error nulls the whole data
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toContain('Failure injection is ON');
    expect(res.body.errors[0].extensions.code).toBe('service_unavailable');
    expect(res.body.errors[0].path).toEqual(['posts']);
  });

  it('a malformed document answers 400 with a syntax error entry', async () => {
    const res = await gql(createApp(), { query: '{ posts ' });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toMatch(/Syntax Error/);
    expect(res.body.errors[0].locations).toEqual([{ line: 1, column: 9 }]);
  });

  it('a well-formed but invalid document answers 400 with the validator message', async () => {
    const res = await gql(createApp(), { query: '{ nope }' });

    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toBe('Cannot query field "nope" on type "Query".');
  });

  it('rejects request envelopes that are not { query, variables?, operationName? }', async () => {
    const missingQuery = await gql(createApp(), { variables: {} });
    expect(missingQuery.status).toBe(400);
    expect(missingQuery.body.errors[0].message).toMatch(/"query"/);
    expect(missingQuery.body.errors[0].extensions.code).toBe('validation_failed');

    const badVariables = await gql(createApp(), { query: '{ posts { id } }', variables: 'nope' });
    expect(badVariables.status).toBe(400);
    expect(badVariables.body.errors[0].message).toMatch(/"variables"/);

    // No JSON body at all (no content-type matched a parser): req.body is
    // undefined, or body-parser's empty special case yields {} — either way
    // the envelope lacks a usable query.
    const noBody = await request(createApp()).post(ENDPOINT);
    expect(noBody.status).toBe(400);
    expect(noBody.body.errors[0].extensions.code).toBe('validation_failed');
    expect(noBody.body.errors[0].message).toMatch(/query/i);
  });

  it('still stamps the request id header (the same middleware chain as REST)', async () => {
    const res = await gql(createApp(), { query: '{ posts { id } }' });
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });
});

describe('GET /api/graphql — POST-only guidance', () => {
  it('answers 405 with an Allow header and a how-to-POST explanation', async () => {
    const res = await request(createApp()).get(ENDPOINT);

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
    expect(res.body.message).toMatch(/POST/i);
    expect(res.body.how.url).toBe(ENDPOINT);
    expect(typeof res.body.how.body.query).toBe('string');
  });
});
