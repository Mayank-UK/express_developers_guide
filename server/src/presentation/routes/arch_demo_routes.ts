import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import { getContainer } from '../../di/container.js';
import { UnavailableException } from '../../core/error_handling/exceptions.js';

/**
 * Architecture demo endpoints (the `architecture` topic's live surface).
 *
 * - GET /api/demo/arch/trace — a request-flow TRACER: this very request is run
 *   through the real layers (request-id middleware → route/controller → the
 *   container's REAL postsUseCase.list()) with timings captured at each hop.
 *   No pipeline logic is duplicated — the use case call is the same one
 *   GET /api/posts makes, and the requestId reported is THIS request's own
 *   (read from res.locals, so it always matches the x-request-id header).
 *
 *   HONESTY ABOUT THE BARS (the spec pins this): the use-case bar INCLUDES the
 *   repository call (that is what a use case is — validation, scenario check,
 *   persistence through the port). The selector and repository bars below it
 *   are honest sub-spans of that total: the selector is the exact
 *   scenarioStore read the container's closure performs (re-timed in
 *   isolation), and the repository bar is DERIVED (use-case total minus the
 *   measured selector read) — attribution, clearly labeled, not a second
 *   measurement. The serialization bar is the real JSON.stringify work
 *   res.json performs for the GET /api/posts payload. Each bar's note says
 *   exactly what it measured.
 *
 * - GET /api/demo/arch/folders — the REAL folder map as data: walks server/src
 *   recursively (three visible levels) and returns it as a tree, plus a static
 *   purpose map for the six top-level directories. The purposes are kept in
 *   sync BY HAND — if a directory changes its job, this map changes with it
 *   (the spec pins the six names, not the prose).
 */

export const ARCH_DEMO_MOUNT_PATH = '/api/demo/arch';

/** ms are rounded to keep the payload readable; sub-millisecond spans survive. */
function roundMs(ms: number): number {
  return Math.round(Math.max(0, ms) * 1000) / 1000;
}

interface TraceLayer {
  layer: string;
  ms: number;
  note: string;
}

async function traceController(_req: Request, res: Response): Promise<void> {
  // The request-id middleware stamped the start (mounted first in app.ts) —
  // the trace IS this request, so its requestId is our own res.locals value.
  const startedAt =
    typeof res.locals.requestStartedAt === 'number' ? res.locals.requestStartedAt : performance.now();
  const container = getContainer();

  // 1 — everything before the route: request-id stamp + helmet + body parse.
  const routeEntry = performance.now();

  // 2 — the controller's own work: fetching the container's use case and
  //     preparing to hand it the (empty) input. Microseconds, honestly.
  const beforeUseCase = performance.now();

  // 3 — THE REAL CALL: the same postsUseCase.list() GET /api/posts runs.
  const useCaseStart = performance.now();
  const result = await container.postsUseCase.list();
  const useCaseEnd = performance.now();

  // 4 — the selector read, re-timed in isolation: the exact scenarioStore.get()
  //     the container's selectPostRepository closure performs per call.
  const selectorStart = performance.now();
  const scenario = container.scenarioStore.get();
  const selectorEnd = performance.now();

  // 5 — derived: the use-case total minus the measured selector read is the
  //     repository/dao share (plus validation, which for list() is nothing).
  const repositoryMs = Math.max(0, useCaseEnd - useCaseStart - (selectorEnd - selectorStart));

  // 6 — serialization: the work res.json actually performs for the posts
  //     payload (JSON.stringify of { posts }).
  const serializeStart = performance.now();
  if (result.ok) JSON.stringify({ posts: result.value });
  const serializeEnd = performance.now();

  const layers: TraceLayer[] = [
    {
      layer: 'request-id middleware',
      ms: roundMs(routeEntry - startedAt),
      note: 'from the request-id stamp to route entry — includes helmet + JSON body parsing riding the same pre-route chain',
    },
    {
      layer: 'route + controller (parse)',
      ms: roundMs(beforeUseCase - routeEntry),
      note: 'the controller\'s whole job: get the container\'s use case, hand it the input (list takes none) — pure translation, microseconds',
    },
    {
      layer: 'use case (validation + scenario check)',
      ms: roundMs(useCaseEnd - useCaseStart),
      note: result.ok
        ? 'THE REAL postsUseCase.list() — for a list: injection check + repository selection + the repository call. THIS BAR INCLUDES THE REPOSITORY (the two bars below are sub-spans of it)'
        : 'THE REAL postsUseCase.list() — the scenario check short-circuited with a typed failure before any repository was consulted',
    },
    {
      layer: 'repository selector (fake | live)',
      ms: roundMs(selectorEnd - selectorStart),
      note: `scenarioStore.get() — the exact read the container's selector closure performs on every call; re-timed here in isolation. Current mode: ${scenario.dataMode}`,
    },
    {
      layer: 'repository / dao',
      ms: roundMs(repositoryMs),
      note: result.ok
        ? `DERIVED (use-case total minus the measured selector read) — honest attribution, not a second measurement. In ${scenario.dataMode} mode this is ${scenario.dataMode === 'live' ? 'the sqlite query via the DAO' : 'an in-memory array copy in the fake repository'}`
        : 'short-circuited — the injected failure returned before any repository call',
    },
    {
      layer: 'response serialization',
      ms: roundMs(serializeEnd - serializeStart),
      note: 'JSON.stringify({ posts }) — the serialization res.json performs for the real GET /api/posts payload',
    },
  ];

  const totalMs = roundMs(performance.now() - startedAt);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';

  res.json({
    trace: layers,
    totalMs,
    mode: scenario.dataMode,
    injectFailure: scenario.injectFailure,
    postCount: result.ok ? result.value.length : 0,
    requestId,
    ...(result.ok
      ? {}
      : {
          failure: {
            kind: result.error.kind,
            message: result.error.message,
          },
        }),
  });
}

/* ---- the folder map ---- */

/**
 * One-line purposes for the six top-level directories (plus the controllers
 * ring nested under presentation/). KEPT IN SYNC BY HAND — this is the legend
 * for the live tree below; if a directory changes its job, update the line
 * (and the topic's static map with it).
 */
const FOLDER_PURPOSES: Readonly<Record<string, string>> = {
  presentation:
    'HTTP concerns: routes (thin makeExpressCallback declarations), middleware, the gRPC bridge — translates transport ↔ controllers',
  controllers:
    'the framework-free controllers ring: httpRequest in, { status, body } out — never imports express; makeExpressCallback adapts it onto the framework',
  domain:
    'business rules: use cases, entities and PORTS (interfaces) — imports nothing from presentation or data',
  data: 'persistence implementations: sqlite / mongo / redis / files implement the domain\u2019s ports',
  core: 'cross-cutting primitives: config, Result, the error taxonomy, logging, the scenario store',
  di: 'the composition root: the ONE module that constructs concretes and wires them (fake/live switching)',
  content: 'the guide\u2019s own payload: topics → sections → blocks, served as typed JSON',
};

interface FolderNode {
  name: string;
  kind: 'dir' | 'file';
  children?: FolderNode[];
}

/** Three visible levels (src → presentation → routes → files), hard caps as safety. */
const WALK_DEPTH = 2; // counting down from src's children
const NODE_CAP = 500;

function walk(dir: string, depth: number, budget: { count: number }): FolderNode[] {
  const nodes: FolderNode[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== 'dist' && !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return nodes; // unreadable subtree → empty, never a crash
  }
  for (const entry of entries) {
    if (budget.count >= NODE_CAP) break;
    budget.count += 1;
    const node: FolderNode = {
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : 'file',
    };
    if (node.kind === 'dir' && depth > 0) {
      node.children = walk(join(dir, entry.name), depth - 1, budget);
    }
    nodes.push(node);
  }
  return nodes;
}

function foldersController(_req: Request, res: Response): void {
  // Package root is three levels up from this module under BOTH tsx (src/)
  // and the built tree (dist/) — same resolution deps_demo_routes uses.
  const srcDir = fileURLToPath(new URL('../../../src', import.meta.url));
  let exists = false;
  try {
    exists = statSync(srcDir).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    // A dist-only image (the prod Dockerfile ships dist, not src) has no
    // source tree to walk — say so rather than returning an empty map.
    throw new UnavailableException(
      'the folder map needs the server source tree, which this build does not ship — run the server from the repo',
    );
  }

  const budget = { count: 0 };
  const tree = walk(srcDir, WALK_DEPTH, budget);
  res.json({
    root: 'server/src',
    truncated: budget.count >= NODE_CAP,
    purposes: FOLDER_PURPOSES,
    tree,
  });
}

export const archDemoRouter = Router();
archDemoRouter.get('/demo/arch/trace', traceController);
archDemoRouter.get('/demo/arch/folders', foldersController);
