import type { Topic } from '../types.js';

/**
 * The routing topic: how a URL finds your code. Concept-first (the route
 * table as the API's contract), then Express 5 specifics. Snippets from this
 * repo are marked verbatim; illustrative sketches say so in their captions.
 */
export const topicRouting: Topic = {
  id: 'routing',
  title: 'Routing',
  subtitle:
    'Methods, path patterns, parameters, and mounted routers — how a URL finds your code.',
  group: 'middleware-request',
  order: 1,
  sections: [
    {
      id: 'routing-what',
      title: 'What routing is',
      lead: 'A route table maps (method, path) → handler. That table is your API\u2019s entire public contract — everything else is implementation.',
      blocks: [
        {
          kind: 'text',
          id: 'routing-what:concept',
          body: `Concept first, framework-free: routing is a lookup. The server receives a request line — a method (GET, POST, …) and a path — and must decide which piece of code, if any, is responsible for answering. A router holds a table of rules, each rule pairing a method-and-pattern with a handler, and matches the incoming request against that table in registration order; the first rule that matches wins and its handler runs. If nothing matches, the request falls off the end of the table, and what happens then (usually a 404) is itself part of your contract.\n\nIt is worth internalizing that the route table IS the API. Clients do not see your controllers, your layers, or your database — they see the set of (method, path) pairs you answer, the shapes you accept and return, and the status codes you emit. Reading a well-organized route table tells you what a service does in ten seconds; that is why this guide keeps every router file small enough to be its own documentation, and why the live demo below renders this server's demo route table from a catalog the server serves about itself.`,
        },
        {
          kind: 'code',
          id: 'routing-what:posts-table',
          language: 'ts',
          caption: 'server/src/presentation/routes/posts_routes.ts — verbatim (annotations added): this app\u2019s posts route table, the whole resource in two statements',
          source: 'server/src/presentation/routes/posts_routes.ts',
          code: `export const postsRouter = Router();
postsRouter
  .route('/posts')
  .get(makeExpressCallback(postsControllers.list))     // list
  .post(makeExpressCallback(postsControllers.create)); // create (201)
postsRouter.route('/posts/:id').get(makeExpressCallback(postsControllers.detail)); // read one

// What a client sees of the posts pipeline — three rows. Each verb is ONE
// declaration line: makeExpressCallback adapts the framework-free controller
// behind it, and the domain does the work (see Routing at scale).`,
        },
        {
          kind: 'demo',
          id: 'routing-what:demo',
          demoId: 'routing:explorer',
          title: 'The route explorer',
          description:
            'Fetch the server\u2019s own route catalog, then fire any row: edit the prefilled path (or the POST body), hit FIRE, and watch the status, elapsed time, matched-pattern echo, and response body come back. Unrouted paths fall through to the 404 catch-all envelope — visible right in the panel.',
        },
      ],
    },
    {
      id: 'routing-methods-paths',
      title: 'Methods and paths',
      lead: 'app.get, app.post, … each add one row keyed by method; app.all matches every method. Paths are patterns, not just strings.',
      blocks: [
        {
          kind: 'text',
          id: 'routing-methods-paths:methods',
          body: `Express exposes one registration function per verb — app.get, app.post, app.put, app.patch, app.delete, app.head, app.options — plus app.all, which registers a handler for every method on a path (handy for logging or auth on an entire subtree). The method is part of the matching key, not a filter applied afterwards: POST /api/posts and GET /api/posts are different rows that usually point at different handlers, and DELETE on a path that only has a GET row matches nothing — you get the 404 catch-all, not your handler with a surprise method. If you want to answer "path exists, verb does not" properly, that is a deliberate 405 (see the ordering section).\n\nPaths are patterns. A literal segment (/posts) matches only itself; a colon-prefixed segment (:id) matches any single segment and captures it into req.params; a named wildcard (*splat) matches one-or-more trailing segments. Optional and repeated segments exist too, but the three workhorses cover almost every real API.`,
        },
        {
          kind: 'code',
          id: 'routing-methods-paths:patterns',
          language: 'ts',
          caption:
            'server/src/presentation/routes/routing_demo_routes.ts — verbatim: the pattern zoo as really registered (the general forms they instance, in the comments; the live demo above runs them for real)',
          source: 'server/src/presentation/routes/routing_demo_routes.ts',
          code: `// The pattern zoo, generalized (app.get('/posts') matches only /posts;
// ':id' captures ONE segment and composes with literals; '*splat' captures
// 1+ trailing segments; app.all covers every method on a subtree):
//   app.get('/posts', handler);              // literal
//   app.get('/posts/:id', handler);          // param
//   app.get('/posts/:id/comments', handler); // params + literals
//   app.get('/files/*splat', handler);       // named wildcard
//   app.all('/admin/*splat', requireRole);   // every method, whole subtree
//
// Express 5 broke from Express 4 here: wildcards must be NAMED (*splat)
// and a bare '*' or regexp-ish patterns like '/posts/(\\d+)?' now throw at
// registration — path-to-regexp 8 compiles a stricter grammar. Params are
// how you capture; validation of what you captured is your handler's job.

// And the real registrations this app serves — specific-before-general,
// multi-param before shorter overlap:
routingDemoRouter.get('/demo/routing/projects', listProjectsController);
routingDemoRouter.post('/demo/routing/projects', createProjectController);
routingDemoRouter.get('/demo/routing/projects/:projectId/tasks/:taskId', projectTaskController);
routingDemoRouter.get('/demo/routing/projects/:projectId', projectDetailController);
routingDemoRouter.get('/demo/routing/search', searchController);
routingDemoRouter.get('/demo/routing/files/*splat', filesSplatController);`,
        },
      ],
    },
    {
      id: 'routing-params-query',
      title: 'Route parameters and query strings',
      lead: ':params carry identity in the path; the query string carries options. Parse both at the boundary — req.params and req.query are strings until you make them otherwise.',
      blocks: [
        {
          kind: 'text',
          id: 'routing-params-query:params',
          body: `A colon segment captures whatever segment sits at that position, as a string. /api/posts/c0a8… arrives with req.params.id === 'c0a8…' — and that is all the router promises. TypeScript's req.params type says string; it cannot say "valid post id", because that is a decision, not a type. Which points at the rule this repo follows everywhere: validate at the boundary. The posts pipeline hands the raw string to PostsUseCase and lets the domain reject it (a Result with a validation failure that the error pipeline renders as a 400 envelope); the routing demo's :projectId route does the same check inline so you can trip it live.\n\nThe query string (?q=express&limit=5) is parsed before your handler sees it, into req.query — but note WHAT parses it. Express 5 switched the default parser to Node's plain querystring module ("simple"): repeated keys become arrays, there is no nested-object syntax, and everything arrives as a string. Express 4's default was the extended qs parser, which accepted ?a[b]=c nesting — so the same URL can mean different things across the two majors. Numbers are never numbers: ?limit=5 gives you the STRING '5' until you parse it, which is why boundary parsing (defaults, ranges, 400s) is a route's first job.`,
        },
        {
          kind: 'code',
          id: 'routing-params-query:posts-verbatim',
          language: 'ts',
          caption:
            'server/src/presentation/controllers/posts_controllers.ts — verbatim (annotation added, dedented from the frozen object): a thin param controller; validation lives in the use case',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `/** GET /api/posts/:id → 200 post */
async detail(httpRequest: HttpRequest): Promise<HttpResponse> {
  // httpRequest.params.id is a string the ROUTE matched — the USE CASE
  // decides whether it names a real post (not_found) or is malformed
  // (validation).
  const result = await getPost(httpRequest.params.id);
  if (!result.ok) throw failureToException(result.error);
  return { status: 200, body: result.value };
}`,
        },
        {
          kind: 'code',
          id: 'routing-params-query:search',
          language: 'ts',
          caption: 'server/src/presentation/routes/routing_demo_routes.ts — verbatim: query parsing with a default, a range, and 400s',
          source: 'server/src/presentation/routes/routing_demo_routes.ts',
          code: `let limit = LIMIT_DEFAULT;                       // 10
if (rawQuery.limit === undefined || rawQuery.limit === '') {
  defaultsApplied.push('limit');                 // absent → default, not error
} else if (
  typeof rawQuery.limit !== 'string' ||
  !/^\\d+$/.test(rawQuery.limit.trim()) ||
  Number(rawQuery.limit.trim()) < LIMIT_MIN ||
  Number(rawQuery.limit.trim()) > LIMIT_MAX
) {
  throw new ValidationException(                 // present but malformed → 400
    \`"limit" query parameter must be a whole number between \${LIMIT_MIN} and \${LIMIT_MAX}\`,
    { parameter: 'limit', defaultValue: LIMIT_DEFAULT, validRange: [LIMIT_MIN, LIMIT_MAX] },
  );
} else {
  limit = Number(rawQuery.limit.trim());         // string → number, only now
}`,
        },
      ],
    },
    {
      id: 'routing-routers',
      title: 'Routers and mounting',
      lead: 'A Router is a mini-app: its own route table and middleware stack, mounted at a prefix. Mounting is how a route table of 6 rows stays readable at 600.',
      blocks: [
        {
          kind: 'text',
          id: 'routing-routers:concept',
          body: `Registering every route on the app object works until it doesn't. Express's answer is the Router: an object with the same get/post/use registration API as the app but no listener, no settings — just a route table and a middleware stack. You build a router per resource (postsRouter, contentRouter, one file each in this repo's presentation/routes/), then mount it: app.use('/api', apiRouter) means "for paths under /api, continue matching in apiRouter's table, with the prefix stripped". Mounting composes — the /api router itself mounts the demo routers — and req.originalUrl still carries the full path while req.url is rewritten per mount, which is exactly how a mini-app can define routes relative to where it was mounted.\n\nTwo pitfalls worth naming. Circular mounting (routerA.use(routerB) while routerB.use(routerA)) does not fail loudly — requests just loop through the stack until they fall out the bottom; keep mounting a one-directional tree: app → area routers → resource routers. And app.use('/api', router) matches ANY method (it is not a route, it is a prefix delegation), so method-keyed behavior still comes from the routes the mounted router defines.`,
        },
        {
          kind: 'code',
          id: 'routing-routers:index-verbatim',
          language: 'ts',
          caption: 'server/src/presentation/routes/index.ts — verbatim (abridged with elisions; annotations added): the mount tree this app\u2019s whole API hangs from',
          source: 'server/src/presentation/routes/index.ts',
          code: `export const apiRouter = Router();

apiRouter.use(healthRouter);      // /api/health…
apiRouter.use(demoRouter);        // /api/demo/…       (architecture demos)
apiRouter.use(nodeDemoRouter);    // /api/demo/node/…  (event loop, streams)
apiRouter.use(httpDemoRouter);    // /api/demo/http/…  (inspect, negotiate)
apiRouter.use(routingDemoRouter); // /api/demo/routing/… (this topic\u2019s explorer)
// …30+ more demo routers, one per topic — middleware, reqres, validation,
// graphql, webhooks, grpc, db, sql-depth, mongo, redis, messaging, caching,
// auth, authz, oauth, security, files, i18n, realtime, jobs, patterns,
// deps, env, arch, obs, testing, deploy, perf, reliability, scaling,
// best-practices, third-party…
apiRouter.use(contentRouter);     // /api/content/…    (the guide you are reading)
apiRouter.use(postsRouter);       // /api/posts…       (the layered pipeline)

// src/app.ts then mounts the tree once: app.use('/api', apiRouter).
// One file owns composition; each resource file owns only its own table.`,
        },
        {
          kind: 'text',
          id: 'routing-routers:organization',
          body: `Organization at scale follows from the mechanism: one file per resource, each exporting a router built top-to-bottom in the order matching should happen; one composition file (index.ts here) that mounts them; the app file that mounts the composition and owns the cross-cutting tail — 404 and error handling. A reader can then navigate from any URL to its handler in two hops: which mounted router's prefix matches, then which row in that router's table. The route-explorer demo above makes the same navigation visible live: its catalog endpoint is a router describing its own table as data.`,
        },
      ],
    },
    {
      id: 'routing-order-404',
      title: 'Route ordering and the 404 catch-all',
      lead: 'First match wins, in registration order — so order is logic. The 404 catch-all works only because it is registered after every route.',
      blocks: [
        {
          kind: 'text',
          id: 'routing-order-404:first-match',
          body: `Express matches a request against the table top-to-bottom and runs the FIRST matching row (a handler that calls next() resumes the scan — that is the Middleware topic's territory). Two consequences. Overlapping patterns make order load-bearing: a specific route registered after a general one that also matches is dead code — the classic bug is app.get('/posts/new', …) registered after app.get('/posts/:id', …), where 'new' is captured as an id and the intended handler never runs. Register specific → general within a router, and in this repo's demo router the multi-param route /projects/:projectId/tasks/:taskId is registered before the shorter /projects/:projectId for exactly that discipline (Express 5's full-path matching makes the overlap smaller than Express 4's, but the habit is free).\n\nThe other consequence: the end of the table is reachable. When every row has had its chance and none matched, execution falls off the routes into whatever middleware was registered next. Register a plain app.use handler there and you own the "nothing matched" case — that is the 404 catch-all, and its position after app.use('/api', apiRouter) is the entire trick. It must be plain middleware (no path pattern) so it behaves identically regardless of path syntax — and it is also where a stricter API would answer 405: inspect req.method against the table's paths, and reply "Method Not Allowed" with an Allow header when the path exists but the verb doesn't.`,
        },
        {
          kind: 'code',
          id: 'routing-order-404:app-verbatim',
          language: 'ts',
          caption: 'server/src/app.ts — verbatim (trace/logger/helmet elided; annotations added): registration order is the contract',
          source: 'server/src/app.ts',
          code: `app.use(requestIdMiddleware);   // 1. correlation id FIRST — even 404s/500s carry one
// …trace id, request logger, and helmet security headers (elided)…
app.use(webhookJsonBodyParser); // 2. body parsing before any handler reads req.body

app.use('/api', apiRouter);     // 3. the route tables

// 4. 404 catch-all — plain middleware (no wildcard path), so it behaves the
// same across Express 4/5 wildcard-syntax differences.
app.use((req: Request, res: Response) => {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
  res.status(404).json({
    error: {
      code: 'not_found',
      message: \`Cannot \${req.method} \${req.originalUrl}\`,
      requestId,
    },
  });
});

app.use(errorHandler);          // 5. error-handling middleware LAST — always`,
        },
        {
          kind: 'text',
          id: 'routing-order-404:fallthrough-live',
          body: `You can trip this live in the demo above: edit any row's path to something the demo router does not define (or fire the prefilled incomplete path /projects/p1/tasks, which has no matching row because :taskId is missing) and you will see the fall-through in action — the request leaves the demo router, leaves the API router, and is answered by the app-level catch-all with the standard not_found envelope, not a bare HTML error page. One request, three tables searched, one deliberate answer.`,
        },
      ],
    },
    {
      id: 'routing-scale',
      title: 'Routing at scale',
      lead: 'Routes stay dumb: parse, delegate, map. The patterns that keep a 300-route API navigable are thin controllers, a registry, and versioned mounts.',
      blocks: [
        {
          kind: 'text',
          id: 'routing-scale:thin-controllers',
          body: `The first scaling move is not about routes at all: keep them thin. A route's job is boundary work — read params/query/body, parse and validate them, call ONE use case, map the Result to a response — never business logic. This repo's posts pipeline is the pattern in miniature: posts_routes.ts is pure declarations (each verb one makeExpressCallback(controller) line), the three controllers it mounts (posts_controllers.ts) are three short methods each, the validation lives in the use case, and neither file imports the data layer. When logic leaks into routes it becomes untestable without HTTP, duplicated across verbs, and invisible to the layer that should own it. Thin routes also age well: the day the handler needs to change (new status code, new envelope), it changes in one predictable place.\n\nThe second move is a central route registry for documentation. Hand-maintained API docs drift; a table the code itself serves cannot. This topic's demo does it deliberately: the catalog endpoint returns the demo router's six patterns as structured data (method, pattern, fullPath, params, purpose), and the client renders the route table FROM that response — the screen you are reading is documented by the server it documents. Grown up, the same idea feeds OpenAPI generation (the API Documentation topic picks that up).\n\nThe third move is versioned mounts. Once clients depend on you, changes must be additive or parallel: mount /api/v1 and /api/v2 routers side by side, share use cases across them, and let the version prefix choose the surface. Because mounting is just prefix delegation, a version is one line at the composition root.`,
        },
        {
          kind: 'code',
          id: 'routing-scale:versioned',
          language: 'ts',
          caption: 'Illustrative — how a v2 would mount beside v1 in this app\'s composition root (today nothing versions; the real seam, quoted from app.ts, is line one)',
          source: 'server/src/app.ts',
          code: `// app.ts today — one prefix, one surface (the REAL line, verbatim):
app.use('/api', apiRouter);

// The day a BREAKING change is unavoidable — v2 mounts beside v1, both live,
// v1 marked deprecated (sunset headers, monitoring on its traffic):
//   app.use('/api/v1', apiV1Router);   // GET /api/v1/posts   (old envelope)
//   app.use('/api/v2', apiV2Router);   // GET /api/v2/posts   (paginated, filtered)
// v2Router can even mount v1 resources it has not revised:
//   v2Router.use(postsRouter);         — identical table, new prefix, zero copies.

// Deprecation, done politely (illustrative middleware on the v1 mount):
//   apiV1Router.use((req, res, next) => {
//     res.set('Deprecation', 'version="v1", date="Wed, 01 Oct 2026 00:00:00 GMT"');
//     res.set('Sunset', 'Wed, 01 Apr 2027 00:00:00 GMT'); // when v1 answers stop
//     next();
//   });
// Then WATCH v1 traffic per client (api keys make this possible) and only
// retire it when the graph hits zero — deprecation is logistics, not law.`,
        },
      ],
    },
    {
      id: 'routing-live',
      title: 'Tour the route table from a terminal',
      lead: 'The route explorer\u2019s own endpoints, no browser needed: the catalog as data, a matched-pattern echo on every row, and the fall-through to the 404 catch-all.',
      blocks: [
        {
          kind: 'text',
          id: 'routing-live:intro',
          body: `The interactive route explorer lives in "What routing is" above; the curls below drive the same endpoints from a terminal. The catalog is the route table as data — six rows covering a static path, method dispatch, a validated parameter, two parameters, a query string, and an Express 5 named wildcard — and every response starts with a matched echo naming the exact pattern that answered. The middle curls fire the interesting rows: a named parameter echoed by the row that matched it, boundary validation rejecting /projects/42 with a 400 envelope (the route matched, the handler said no), query parsing with a default, and the named wildcard capturing a suffix as segments. The last curl is the fall-through: nothing matches, and the app-level 404 catch-all answers with the standard not_found envelope. Pattern, handler, validation, and fall-through: one table, every routing concept, live.`,
        },
        {
          kind: 'code',
          id: 'routing-live:curl',
          language: 'bash',
          caption: 'drive the demo endpoints yourself',
          code: `# The route table as data — what the demo below renders:
curl -s localhost:4000/api/demo/routing/catalog | head -40

# A named parameter, echoed by the row that matched it:
curl -s localhost:4000/api/demo/routing/projects/p1

# Boundary validation — the route matched, the handler said no (400 envelope):
curl -s localhost:4000/api/demo/routing/projects/42

# Query parsing with a default (?limit= omitted → 10):
curl -s 'localhost:4000/api/demo/routing/search?q=express'

# Express 5 named wildcard — the suffix captured as segments:
curl -s localhost:4000/api/demo/routing/files/docs/readme.md

# Nothing matched → the app-level 404 catch-all envelope:
curl -s localhost:4000/api/demo/routing/nope`,
        },
      ],
    },
  ],
};
