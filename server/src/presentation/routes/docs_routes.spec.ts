import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  FAILURE_HTTP_STATUS,
  FAILURE_KINDS,
} from '../../core/error_handling/failures.js';

/**
 * The api-documentation topic's own medicine, applied to this app: the docs
 * surface is a CLAIM about the routes, and these tests are the drift check —
 * the served OpenAPI document must describe exactly the API that exists,
 * Swagger UI must actually render, and the raw spec must stay machine-
 * consumable. Paths below are literals on purpose: they are the contract.
 */

describe('GET /docs/openapi.json — the raw spec', () => {
  it('serves the OpenAPI document as JSON covering the real API surface', async () => {
    const res = await request(createApp()).get('/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type'] ?? '').toMatch(/json/);
    expect(res.body.openapi).toBe('3.1.0');
    // The contract matches the routes that actually exist — the whole point.
    // The core surface plus two representative non-CRUD entries; every other
    // demo route group is deliberately out of scope (their topic screens own
    // them) and the info note below must say so honestly.
    expect(Object.keys(res.body.paths)).toEqual([
      '/api/health',
      '/api/content',
      '/api/content/topics/{id}',
      '/api/posts',
      '/api/posts/{id}',
      '/api/demo/scenario',
      '/api/demo/app-info',
      '/api/demo/error',
      '/api/graphql',
    ]);
  });

  it('states its scope honestly in the info section', async () => {
    const res = await request(createApp()).get('/docs/openapi.json');

    const description = res.body.info.description as string;
    // The note must say what the document covers AND where the rest lives:
    expect(description).toContain('CORE resource surface');
    expect(description).toContain('/api/demo/error');
    expect(description).toContain('/api/graphql');
    expect(description).toContain('/api/demo/**');
    expect(description).toContain('topic screens and curl tours');
  });

  it('documents /api/demo/error with the real failure taxonomy, not a retyped copy', async () => {
    const res = await request(createApp()).get('/docs/openapi.json');

    const errorDemo = res.body.paths['/api/demo/error'];
    expect(Object.keys(errorDemo)).toEqual(['get']);

    // The query enum is the taxonomy's kind names, imported at the source:
    expect(errorDemo.get.parameters[0]).toMatchObject({ name: 'failure', in: 'query', required: true });
    expect(errorDemo.get.parameters[0].schema.enum).toEqual([...FAILURE_KINDS]);

    // One response entry per kind, keyed by the real kind→status map
    // (sorted: JSON object keys that look like integers serialize numerically):
    expect(Object.keys(errorDemo.get.responses)).toEqual(
      Object.values(FAILURE_HTTP_STATUS).map(String).sort(),
    );
    // …and every one of them points at the shared envelope schema:
    for (const response of Object.values(
      errorDemo.get.responses as Record<string, { content: Record<string, { schema: { $ref: string } }> }>,
    )) {
      expect(response.content['application/json'].schema.$ref).toBe('#/components/schemas/Error');
    }
  });

  it('documents /api/graphql as the non-CRUD sketch (POST contract + honest GET 405)', async () => {
    const res = await request(createApp()).get('/docs/openapi.json');

    const graphql = res.body.paths['/api/graphql'];
    expect(Object.keys(graphql)).toEqual(['post', 'get']);

    expect(graphql.post.requestBody.required).toBe(true);
    expect(graphql.post.requestBody.content['application/json'].schema.required).toEqual(['query']);
    expect(Object.keys(graphql.post.responses)).toEqual(['200', '400']);
    const okSchema = graphql.post.responses['200'].content['application/json'].schema;
    expect(Object.keys(okSchema.properties)).toEqual(['data', 'errors']);
    // The 400 is the GraphQL errors array, deliberately not the REST envelope:
    expect(graphql.post.responses['400'].content['application/json'].schema.required).toEqual(['errors']);

    expect(Object.keys(graphql.get.responses)).toEqual(['405']);
  });

  it('documents the error envelope as a reusable schema', async () => {
    const res = await request(createApp()).get('/docs/openapi.json');

    const errorSchema = res.body.components.schemas.Error;
    expect(errorSchema.properties.error.required).toEqual([
      'code',
      'message',
      'requestId',
    ]);
    // The documented codes are the failure taxonomy's, nothing invented:
    expect(errorSchema.properties.error.properties.code.enum).toEqual([
      'validation_failed',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'rate_limited',
      'service_unavailable',
      'internal_error',
      'request_failed',
    ]);
    // Every documented error response points at the ONE envelope schema:
    const responseRefs = Object.values(
      res.body.components.responses as Record<string, { content: Record<string, { schema: { $ref: string } }> }>,
    ).map((response) => response.content['application/json'].schema.$ref);
    expect(responseRefs).toEqual([
      '#/components/schemas/Error',
      '#/components/schemas/Error',
      '#/components/schemas/Error',
    ]);
  });

  it('documents the posts operations with the real methods, codes, and validation rules', async () => {
    const res = await request(createApp()).get('/docs/openapi.json');

    const collection = res.body.paths['/api/posts'];
    expect(Object.keys(collection)).toEqual(['get', 'post']);
    expect(collection.post.requestBody.required).toBe(true);
    expect(Object.keys(collection.post.responses)).toEqual(['201', '400', '503']);
    expect(Object.keys(collection.get.responses)).toEqual(['200', '503']);

    const member = res.body.paths['/api/posts/{id}'];
    expect(Object.keys(member)).toEqual(['get']);
    expect(member.get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(Object.keys(member.get.responses)).toEqual(['200', '404', '503']);

    // The input schema mirrors the use case's actual validation:
    const createInput = res.body.components.schemas.CreatePostInput;
    expect(createInput.required).toEqual(['title', 'body', 'author']);
    expect(createInput.additionalProperties).toBe(false);
    expect(createInput.properties.title.maxLength).toBe(120);
    expect(createInput.properties.body.maxLength).toBe(5000);
    expect(createInput.properties.author.maxLength).toBe(80);

    // Scenario: GET + PATCH on one singleton document, PATCH documented with 400.
    const scenario = res.body.paths['/api/demo/scenario'];
    expect(Object.keys(scenario)).toEqual(['get', 'patch']);
    expect(Object.keys(scenario.patch.responses)).toEqual(['200', '400']);
  });

  it('carries working examples drawn from the real seed data', async () => {
    const res = await request(createApp()).get('/docs/openapi.json');

    const postExample = res.body.components.schemas.Post.example;
    expect(postExample.id).toBe('0f1c2b3a-0000-4000-8000-000000000002');
    expect(postExample.title).toBe('The dependency rule, concretely');
    // The posts list example is a real seeded post too:
    const listExample = res.body.paths['/api/posts'].get.responses['200'].content['application/json'].example;
    expect(listExample.posts[0].id).toBe('0f1c2b3a-0000-4000-8000-000000000003');
  });
});

describe('GET /docs — the Swagger UI surface', () => {
  it('redirects the bare /docs to the trailing slash (relative assets)', async () => {
    const res = await request(createApp()).get('/docs');

    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/docs/');
  });

  it('serves Swagger UI at /docs/ wired to the real document', async () => {
    const page = await request(createApp()).get('/docs/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('swagger'); // the UI page actually rendered

    // the UI's init script embeds the served document (proves the wiring):
    const init = await request(createApp()).get('/docs/swagger-ui-init.js');
    expect(init.status).toBe(200);
    expect(init.text).toContain('/api/posts');
  });

  it('serves the UI assets the page references', async () => {
    const css = await request(createApp()).get('/docs/swagger-ui.css');
    expect(css.status).toBe(200);

    const bundle = await request(createApp()).get('/docs/swagger-ui-bundle.js');
    expect(bundle.status).toBe(200);
  });

  it('keeps /docs out of the API namespace and out of the JSON 404 shape', async () => {
    // Docs mount on the ROOT app, not under /api — /api/docs must stay unrouted:
    const res = await request(createApp()).get('/api/docs');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
