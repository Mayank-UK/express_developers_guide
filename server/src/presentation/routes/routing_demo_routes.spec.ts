import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { ROUTING_DEMO_MOUNT_PATH } from './routing_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

const MOUNT = ROUTING_DEMO_MOUNT_PATH; // /api/demo/routing

const EXPECTED_PATTERNS = [
  'GET /projects',
  'POST /projects',
  'GET /projects/:projectId',
  'GET /projects/:projectId/tasks/:taskId',
  'GET /search',
  'GET /files/*splat',
] as const;

describe('GET /api/demo/routing/catalog', () => {
  it('serves the machine-readable route table for all six patterns', async () => {
    const res = await request(createApp()).get(`${MOUNT}/catalog`);

    expect(res.status).toBe(200);
    expect(res.body.mountPath).toBe(MOUNT);
    expect(res.body.routeCount).toBe(6);
    expect(res.body.routes.map((route: { method: string; pattern: string }) => `${route.method} ${route.pattern}`)).toEqual([
      ...EXPECTED_PATTERNS,
    ]);

    // Every fullPath is what a client must actually call: mount + pattern.
    for (const route of res.body.routes as Array<{
      method: string;
      pattern: string;
      fullPath: string;
      purpose: string;
      params: string[];
      examplePath: string;
    }>) {
      expect(route.fullPath).toBe(`${MOUNT}${route.pattern}`);
      expect(route.purpose).toMatch(/./);
      expect(Array.isArray(route.params)).toBe(true);
      // The editable default must be a real, resolvable call.
      expect(route.examplePath.startsWith(`${MOUNT}/`)).toBe(true);
    }
  });

  it('describes each pattern with its parameter names', async () => {
    const res = await request(createApp()).get(`${MOUNT}/catalog`);
    const byPattern = Object.fromEntries(
      (res.body.routes as Array<{ pattern: string; params: string[] }>).map((r) => [r.pattern, r.params]),
    );

    expect(byPattern['/projects/:projectId']).toEqual(['projectId']);
    expect(byPattern['/projects/:projectId/tasks/:taskId']).toEqual(['projectId', 'taskId']);
    expect(byPattern['/files/*splat']).toEqual(['splat']);
    expect(byPattern['/projects']).toEqual([]);
    expect(byPattern['/search']).toEqual([]);
  });
});

describe('GET /api/demo/routing/projects — static path', () => {
  it('lists the fake projects and echoes which route matched', async () => {
    const res = await request(createApp()).get(`${MOUNT}/projects`);

    expect(res.status).toBe(200);
    expect(res.body.matched).toEqual({
      method: 'GET',
      pattern: '/projects',
      fullPath: `${MOUNT}/projects`,
    });
    expect(res.body.projects).toHaveLength(3);
    expect(res.body.projects.map((project: { id: string }) => project.id)).toEqual([
      'apollo',
      'borealis',
      'cascade',
    ]);
  });
});

describe('POST /api/demo/routing/projects — method dispatch', () => {
  it('answers 201 Created and echoes the parsed JSON body', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/projects`)
      .set('content-type', 'application/json')
      .send({ name: 'new-project', tasks: 7 });

    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.matched).toEqual({
      method: 'POST',
      pattern: '/projects',
      fullPath: `${MOUNT}/projects`,
    });
    expect(res.body.created).toEqual({ name: 'new-project', tasks: 7 });
  });

  it('rejects a non-object body (or none) with a 400 envelope', async () => {
    const noBody = await request(createApp()).post(`${MOUNT}/projects`);
    expect(noBody.status).toBe(400);
    expect(noBody.body.error.code).toBe('validation_failed');
    expect(noBody.body.error.parameter).toBe('body');

    // An array is valid JSON but not an object body.
    const array = await request(createApp())
      .post(`${MOUNT}/projects`)
      .set('content-type', 'application/json')
      .send([1, 2]);
    expect(array.status).toBe(400);
    expect(array.body.error.parameter).toBe('body');
    expect(array.body.error.requestId).toMatch(UUID_RE);
  });
});

describe('GET /api/demo/routing/projects/:projectId — named parameter', () => {
  it('echoes the captured parameter and finds the matching project', async () => {
    const res = await request(createApp()).get(`${MOUNT}/projects/apollo`);

    expect(res.status).toBe(200);
    expect(res.body.matched.pattern).toBe('/projects/:projectId');
    expect(res.body.params).toEqual({ projectId: 'apollo' });
    expect(res.body.found).toEqual({ id: 'apollo', name: 'Apollo', owner: 'ada', openTasks: 3 });
  });

  it('separates "route matched" from "resource exists": valid slug, unknown project', async () => {
    const res = await request(createApp()).get(`${MOUNT}/projects/zeppelin`);

    expect(res.status).toBe(200); // the route matched; the lookup is not a routing question
    expect(res.body.params.projectId).toBe('zeppelin');
    expect(res.body.found).toBeNull();
  });

  it('validates the parameter at the boundary: bare numbers are a 400', async () => {
    for (const raw of ['42', '123', '_x']) {
      const res = await request(createApp()).get(`${MOUNT}/projects/${raw}`);
      expect(res.status, `projectId=${raw}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('projectId');
      expect(res.body.error.requestId).toMatch(UUID_RE);
    }
  });
});

describe('GET /api/demo/routing/projects/:projectId/tasks/:taskId — multiple parameters', () => {
  it('echoes both captured parameters', async () => {
    const res = await request(createApp()).get(`${MOUNT}/projects/p1/tasks/t9`);

    expect(res.status).toBe(200);
    expect(res.body.matched.pattern).toBe('/projects/:projectId/tasks/:taskId');
    expect(res.body.matched.fullPath).toBe(`${MOUNT}/projects/:projectId/tasks/:taskId`);
    expect(res.body.params).toEqual({ projectId: 'p1', taskId: 't9' });
  });
});

describe('GET /api/demo/routing/search — query string', () => {
  it('echoes the parsed query alongside the raw one', async () => {
    const res = await request(createApp()).get(`${MOUNT}/search?q=express&limit=5`);

    expect(res.status).toBe(200);
    expect(res.body.matched.pattern).toBe('/search');
    expect(res.body.query.raw).toEqual({ q: 'express', limit: '5' }); // raw = strings
    expect(res.body.query.parsed).toEqual({ q: 'express', limit: 5 }); // parsed = typed
    expect(res.body.defaultsApplied).toEqual([]);
  });

  it('applies defaults (q empty, limit 10) and reports which', async () => {
    const res = await request(createApp()).get(`${MOUNT}/search`);

    expect(res.status).toBe(200);
    expect(res.body.query.parsed).toEqual({ q: '', limit: 10 });
    expect(res.body.defaultsApplied).toEqual(['q', 'limit']);
  });

  it('rejects malformed limits and repeated q with 400 envelopes', async () => {
    for (const raw of ['abc', '1.5', '0', '101']) {
      const res = await request(createApp()).get(`${MOUNT}/search?limit=${raw}`);
      expect(res.status, `limit=${raw}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('limit');
    }

    const repeated = await request(createApp()).get(`${MOUNT}/search?q=a&q=b`);
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.parameter).toBe('q');
    expect(repeated.body.error.requestId).toMatch(UUID_RE);
  });
});

describe('GET /api/demo/routing/files/*splat — Express 5 named wildcard', () => {
  it('captures a multi-segment suffix as an array of segments', async () => {
    const res = await request(createApp()).get(`${MOUNT}/files/docs/readme.md`);

    expect(res.status).toBe(200);
    expect(res.body.matched.pattern).toBe('/files/*splat');
    expect(res.body.params.splat).toEqual(['docs', 'readme.md']);
    expect(res.body.suffix).toBe('docs/readme.md');
  });

  it('matches any suffix depth', async () => {
    const deep = await request(createApp()).get(`${MOUNT}/files/a/b/c/d.txt`);
    expect(deep.status).toBe(200);
    expect(deep.body.suffix).toBe('a/b/c/d.txt');

    const single = await request(createApp()).get(`${MOUNT}/files/only.txt`);
    expect(single.status).toBe(200);
    expect(single.body.params.splat).toEqual(['only.txt']);
  });

  it('does NOT match the bare /files prefix — a wildcard needs a segment', async () => {
    // Falls through every router to the app-level 404 catch-all: the wildcard
    // is one-or-more segments, so /files alone is simply an unrouted path.
    const res = await request(createApp()).get(`${MOUNT}/files`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('unmatched sub-paths — the 404 catch-all envelope', () => {
  it('returns the app envelope for an unknown path under the demo mount', async () => {
    const res = await request(createApp()).get(`${MOUNT}/nope`);

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'not_found',
      message: `Cannot GET ${MOUNT}/nope`,
      requestId: expect.any(String),
    });
    expect(res.body.error.requestId).toMatch(UUID_RE);
  });

  it('404s an incomplete multi-param path (missing :taskId segment)', async () => {
    // First-match-wins teaching point: /projects/:projectId matches only ONE
    // segment, so /projects/p1/tasks matches nothing and falls through.
    const res = await request(createApp()).get(`${MOUNT}/projects/p1/tasks`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toBe(`Cannot GET ${MOUNT}/projects/p1/tasks`);
  });

  it('404s a known path with the wrong method instead of routing by path alone', async () => {
    const res = await request(createApp()).delete(`${MOUNT}/projects`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toBe(`Cannot DELETE ${MOUNT}/projects`);
  });
});
