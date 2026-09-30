import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';

/**
 * Routing demo endpoints (the `routing` topic's live route explorer). The
 * router is itself the teaching artifact: every demo route demonstrates one
 * pattern from the topic — static path, method dispatch, named params,
 * multi-segment wildcard, query parsing — and answers with an echo of WHICH
 * route matched, so the client can show the route table row that responded.
 *
 * ROUTING_DEMO_CATALOG is a machine-readable description of the six demo
 * patterns; GET /api/demo/routing/catalog serves it so the client renders the
 * route table from the server's own description (the "central route registry"
 * pattern from the Routing at scale section, in miniature). The catalog
 * endpoint is deliberately NOT one of the catalogued patterns — it describes
 * the table, it is not a row in it.
 */

/** Where the whole demo sub-app answers — every fullPath starts with this. */
export const ROUTING_DEMO_MOUNT_PATH = '/api/demo/routing';

/** One row of the route table the client renders. */
export interface RoutingDemoRouteInfo {
  method: 'GET' | 'POST';
  /** The pattern as written on the router (relative to the mount path). */
  pattern: string;
  /** What a client must actually call — mount path + pattern. */
  fullPath: string;
  purpose: string;
  /** Parameter names the pattern captures. */
  params: readonly string[];
  /** A working call the client demo prefills into its editable input. */
  examplePath: string;
}

const CATALOG: readonly RoutingDemoRouteInfo[] = [
  {
    method: 'GET',
    pattern: '/projects',
    fullPath: `${ROUTING_DEMO_MOUNT_PATH}/projects`,
    purpose: 'static path — one literal URL, one handler',
    params: [],
    examplePath: `${ROUTING_DEMO_MOUNT_PATH}/projects`,
  },
  {
    method: 'POST',
    pattern: '/projects',
    fullPath: `${ROUTING_DEMO_MOUNT_PATH}/projects`,
    purpose: 'same path, different verb — the parsed JSON body is echoed back',
    params: [],
    examplePath: `${ROUTING_DEMO_MOUNT_PATH}/projects`,
  },
  {
    method: 'GET',
    pattern: '/projects/:projectId',
    fullPath: `${ROUTING_DEMO_MOUNT_PATH}/projects/:projectId`,
    purpose: 'named path parameter — validated at the boundary, echoed back',
    params: ['projectId'],
    examplePath: `${ROUTING_DEMO_MOUNT_PATH}/projects/p1`,
  },
  {
    method: 'GET',
    pattern: '/projects/:projectId/tasks/:taskId',
    fullPath: `${ROUTING_DEMO_MOUNT_PATH}/projects/:projectId/tasks/:taskId`,
    purpose: 'multiple named parameters in one pattern',
    params: ['projectId', 'taskId'],
    examplePath: `${ROUTING_DEMO_MOUNT_PATH}/projects/p1/tasks/t9`,
  },
  {
    method: 'GET',
    pattern: '/search',
    fullPath: `${ROUTING_DEMO_MOUNT_PATH}/search`,
    purpose: 'query string — ?q= &limit= parsed, with a default for limit',
    params: [],
    examplePath: `${ROUTING_DEMO_MOUNT_PATH}/search?q=express&limit=5`,
  },
  {
    method: 'GET',
    pattern: '/files/*splat',
    fullPath: `${ROUTING_DEMO_MOUNT_PATH}/files/*splat`,
    purpose: 'Express 5 named wildcard — captures a multi-segment suffix',
    params: ['splat'],
    examplePath: `${ROUTING_DEMO_MOUNT_PATH}/files/docs/readme.md`,
  },
];

/** The catalog the /catalog endpoint serves (frozen — the table is static). */
export const ROUTING_DEMO_CATALOG: readonly RoutingDemoRouteInfo[] = Object.freeze(
  CATALOG.map((entry) => Object.freeze({ ...entry, params: Object.freeze([...entry.params]) })),
);

/** The `matched` echo every demo response carries: which table row answered. */
function matchedEcho(method: 'GET' | 'POST', pattern: string) {
  const info = CATALOG.find((entry) => entry.method === method && entry.pattern === pattern);
  if (info === undefined) throw new Error(`no catalog entry for ${method} ${pattern}`);
  return { method: info.method, pattern: info.pattern, fullPath: info.fullPath };
}

// --- input parsing (validation lives at the boundary, never in handlers) ------

/**
 * Project ids in this demo are slugs ("p1", "apollo"), never bare numbers —
 * the point is that the ROUTE accepts any segment and the HANDLER decides
 * what a valid id is. Pure numbers are rejected on purpose so the demo can
 * show a 400 from a route that still matched.
 */
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/i;

/**
 * Express 5's types allow string | string[] for any param (a wildcard
 * captures an array); a named single-segment param is always a string at
 * runtime — narrowed here once, defensively, instead of in every handler.
 */
function singleParam(value: string | string[] | undefined, name: string): string {
  if (Array.isArray(value)) {
    throw new ValidationException(`"${name}" path parameter must be a single segment`, {
      parameter: name,
    });
  }
  return value ?? '';
}

function parseProjectId(raw: string): string {
  if (!PROJECT_ID_PATTERN.test(raw)) {
    throw new ValidationException(
      '"projectId" must be a slug like "p1" or "apollo" (a letter, then letters/digits/hyphens)',
      { parameter: 'projectId', received: raw, hint: 'bare numbers are rejected on purpose' },
    );
  }
  return raw;
}

const Q_MAX_LENGTH = 64;
const LIMIT_DEFAULT = 10;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

function parseSearchQuery(rawQuery: Request['query']): {
  q: string;
  limit: number;
  defaultsApplied: string[];
} {
  const defaultsApplied: string[] = [];

  let q = '';
  if (rawQuery.q === undefined || rawQuery.q === '') {
    defaultsApplied.push('q');
  } else if (typeof rawQuery.q !== 'string') {
    // The simple query parser produces arrays for repeated keys (?q=a&q=b).
    throw new ValidationException('"q" query parameter must be a single value', {
      parameter: 'q',
      received: rawQuery.q,
    });
  } else if (rawQuery.q.length > Q_MAX_LENGTH) {
    throw new ValidationException(`"q" query parameter must be at most ${Q_MAX_LENGTH} characters`, {
      parameter: 'q',
    });
  } else {
    q = rawQuery.q;
  }

  let limit = LIMIT_DEFAULT;
  if (rawQuery.limit === undefined || rawQuery.limit === '') {
    defaultsApplied.push('limit');
  } else if (
    typeof rawQuery.limit !== 'string' ||
    !/^\d+$/.test(rawQuery.limit.trim()) ||
    Number(rawQuery.limit.trim()) < LIMIT_MIN ||
    Number(rawQuery.limit.trim()) > LIMIT_MAX
  ) {
    throw new ValidationException(
      `"limit" query parameter must be a whole number between ${LIMIT_MIN} and ${LIMIT_MAX}`,
      { parameter: 'limit', defaultValue: LIMIT_DEFAULT, validRange: [LIMIT_MIN, LIMIT_MAX] },
    );
  } else {
    limit = Number(rawQuery.limit.trim());
  }

  return { q, limit, defaultsApplied };
}

// --- controllers (thin: parse → echo; no business logic to delegate to) ------

/** Static fake data — the resource the static and param routes serve. */
const PROJECTS: readonly { id: string; name: string; owner: string; openTasks: number }[] = [
  { id: 'apollo', name: 'Apollo', owner: 'ada', openTasks: 3 },
  { id: 'borealis', name: 'Borealis', owner: 'grace', openTasks: 1 },
  { id: 'cascade', name: 'Cascade', owner: 'linus', openTasks: 0 },
];

function listProjectsController(_req: Request, res: Response): void {
  res.json({ matched: matchedEcho('GET', '/projects'), projects: PROJECTS });
}

function createProjectController(req: Request, res: Response): void {
  // Express 5: req.body is undefined unless a body parser matched the request's
  // content-type — so "no JSON object arrived" is a validation failure here,
  // not something to echo back as if it were a project.
  const received: unknown = req.body;
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    throw new ValidationException(
      'POST /projects needs a JSON object body (Content-Type: application/json)',
      { parameter: 'body', fields: { body: 'must be a JSON object' } },
    );
  }
  res.status(201).json({
    matched: matchedEcho('POST', '/projects'),
    created: received,
    note: 'the JSON body exactly as express.json() parsed it, echoed back with 201 Created',
  });
}

function projectDetailController(req: Request, res: Response): void {
  const projectId = parseProjectId(singleParam(req.params.projectId, 'projectId'));
  res.json({
    matched: matchedEcho('GET', '/projects/:projectId'),
    params: { projectId },
    // The route matched a valid slug; whether such a project EXISTS is a data
    // question — unknown-but-valid ids get found: null, not a routing 404.
    found: PROJECTS.find((project) => project.id === projectId.toLowerCase()) ?? null,
  });
}

function projectTaskController(req: Request, res: Response): void {
  res.json({
    matched: matchedEcho('GET', '/projects/:projectId/tasks/:taskId'),
    params: {
      projectId: singleParam(req.params.projectId, 'projectId'),
      taskId: singleParam(req.params.taskId, 'taskId'),
    },
  });
}

function searchController(req: Request, res: Response): void {
  const parsed = parseSearchQuery(req.query);
  res.json({
    matched: matchedEcho('GET', '/search'),
    query: { raw: req.query, parsed: { q: parsed.q, limit: parsed.limit } },
    defaultsApplied: parsed.defaultsApplied,
  });
}

function filesSplatController(req: Request, res: Response): void {
  // Express 5 (path-to-regexp 8): a named wildcard captures an ARRAY of
  // segments — /files/docs/readme.md gives ['docs', 'readme.md'].
  const segments: readonly string[] = Array.isArray(req.params.splat)
    ? req.params.splat.map((segment) => String(segment))
    : [String(req.params.splat ?? '')];
  res.json({
    matched: matchedEcho('GET', '/files/*splat'),
    params: { splat: segments },
    suffix: segments.join('/'),
  });
}

function catalogController(_req: Request, res: Response): void {
  res.json({
    mountPath: ROUTING_DEMO_MOUNT_PATH,
    routeCount: CATALOG.length,
    routes: CATALOG,
  });
}

export const routingDemoRouter = Router();
routingDemoRouter.get('/demo/routing/catalog', catalogController);
routingDemoRouter.get('/demo/routing/projects', listProjectsController);
routingDemoRouter.post('/demo/routing/projects', createProjectController);
routingDemoRouter.get('/demo/routing/projects/:projectId/tasks/:taskId', projectTaskController);
routingDemoRouter.get('/demo/routing/projects/:projectId', projectDetailController);
routingDemoRouter.get('/demo/routing/search', searchController);
routingDemoRouter.get('/demo/routing/files/*splat', filesSplatController);
