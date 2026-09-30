import type { Topic } from '../types.js';

/**
 * The Express Fundamentals topic — the guide's namesake foundation. Project
 * setup and the toolchain, the app object, request-handler anatomy, the
 * middleware pipeline and the life of a request end to end, error handling
 * first steps, Express 4 vs 5, what the framework deliberately leaves out,
 * static assets and the docs mount, and the day-to-day development loop.
 * Every code sample is the real pattern running in this repository's
 * server/ package.
 */
export const topicExpressFundamentals: Topic = {
  id: 'express-fundamentals',
  title: 'Express Fundamentals',
  subtitle:
    'Setting up a project, the app object, request-handler anatomy, and the day-to-day development loop.',
  group: 'fundamentals',
  order: 4,
  sections: [
    {
      id: 'express-fundamentals:setup',
      title: 'Setting up an Express project',
      lead: 'What a web framework actually adds, and the smallest honest setup: Express 5, TypeScript, ES modules.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:setup:concept',
          body: "Concept first: a web server is a program that opens a socket, parses HTTP, and hands your code a request. Node can do that bare with node:http — but you would immediately start rebuilding routing, URL parsing, body decoding, and error handling by hand. A framework is that shared plumbing, written once and battle-tested.\n\nExpress is deliberately thin: routing, a middleware pipeline, and a small request/response API over node:http. This guide runs on Express 5 with TypeScript and ES modules, and every sample you will read here is the real code running in this repository's server/ package.",
        },
        {
          kind: 'code',
          id: 'express-fundamentals:setup:toolchain',
          language: 'ts',
          caption: 'The actual toolchain from server/package.json and server/tsconfig.json',
          source: 'server/tsconfig.json',
          code: `// server/package.json — ESM first ("type": "module")
//   dependencies:    express ^5.1.0, pino
//   devDependencies: typescript ^5.9, tsx, vitest, supertest, @types/*
//
// server/tsconfig.json — the settings that shape every file:
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",        // ESM: import specifiers end in .js
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,              // non-negotiable for server code
    // …esModuleInterop, skipLibCheck, forceConsistentCasingInFileNames omitted…
  },
  // "include": ["src"] omitted
}`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:setup:esm',
          body: 'One convention trips up every newcomer: with NodeNext modules, a TypeScript file imports another by its compiled path — ./app.js, never ./app.ts. The specifier names the file as it will exist at runtime once tsc has emitted JavaScript. Embrace that rule early and the compiler becomes a safety net instead of an enemy.',
        },
      ],
    },
    {
      id: 'express-fundamentals:app-object',
      title: 'The app object and its settings',
      lead: 'The Express app is a registry — of routes, middleware, and settings — and separating it from listening is what makes it testable.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:app-object:concept',
          body: "Concept first: an application object is a registry. express() returns an app that accumulates three things — routes, middleware, and settings — and knows how to dispatch an incoming request through them. It is also an EventEmitter, which is how attachable libraries later hook into your HTTP server.\n\nThe pattern this repo uses separates two concerns most tutorials merge: building the app and running it. createApp() in server/src/app.ts assembles the pipeline and returns the app without ever opening a port; server/src/server.ts is the only place that calls listen(). That split is why the test suite can drive the entire API through Supertest with no port, no cleanup, and no race conditions.",
        },
        {
          kind: 'code',
          id: 'express-fundamentals:app-object:create',
          language: 'ts',
          caption: 'server/src/app.ts (abbreviated) — app creation without listening',
          source: 'server/src/app.ts',
          code: `import express, { type Express, type Request, type Response } from 'express';
import { apiRouter } from './presentation/routes/index.js';

export function createApp(): Express {
  const app = express();

  // Settings live on the app object: small, global, read-mostly knobs.
  app.disable('x-powered-by');   // stop advertising the framework in headers

  // …trace id, request logger, and helmet security headers mount here (the
  // observability and security topics own them)…
  app.use(webhookJsonBodyParser); // body parsing is middleware, not magic
  app.use('/api', apiRouter);     // every feature router mounts here
  app.use(docsRouter);            // the Swagger UI surface at /docs

  // ... the 404 catch-all and error-handling middleware close the pipeline
  return app;                    // note: no listen() anywhere in this file
}`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:app-object:settings',
          body: 'Settings are string-keyed values read with app.get(name) and written with app.set(name, value); app.disable/app.enable are boolean shorthands. A few are meaningful to Express itself (x-powered-by, etag, the query parser); the rest are yours as a small global config slot.\n\nA senior habit: keep environment configuration — ports, database URLs, secrets — in a validated config object like this repo config layer, not scattered through app.set calls. Reserve app settings for framework behavior. One special case worth knowing: this app maps its Vitest runs (NODE_ENV=test) explicitly onto the development environment, so test behavior never drifts by accident.',
        },
      ],
    },
    {
      id: 'express-fundamentals:request-handler',
      title: 'Anatomy of a request handler',
      lead: 'Route, handler, response: where your code actually runs — and the thin-controller discipline this repo enforces.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:handler:concept',
          body: 'Concept first: every request handler in every framework does the same three things — read input, do work, write output. In Express it is a function of (req, res, next) registered on a method-and-path pair. Input arrives as req.params, req.query, req.body, and req.headers; output goes out through res.status(), res.json(), res.send(). Call next() to pass control down the pipeline, or end the response yourself.\n\nThe failure mode of real-world handlers is doing all three jobs inside one forty-line function. This app enforces something stricter: routes stay thin — parse and validate the input, call one domain use case, map its Result onto a response. Business logic never lives in a controller.',
        },
        {
          kind: 'code',
          id: 'express-fundamentals:handler:thin-controller',
          language: 'ts',
          caption: 'server/src/presentation/routes/demo_routes.ts — a real thin controller, verbatim',
          source: 'server/src/presentation/routes/demo_routes.ts',
          code: `async function statusController(_req: Request, res: Response): Promise<void> {
  const result = await getContainer().demoService.status();
  if (!result.ok) throw failureToException(result.error); // failure -> exception -> error middleware
  res.json(result.value);
}`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:handler:result',
          body: 'Note what the controller does not do: it never inspects error details, never picks an HTTP status for a domain failure, never logs. The domain returns a Result — a success value or a typed Failure, never a thrown exception — and the single failureToException line hands failures to the error-handling middleware, which maps each failure kind to one status code and one envelope shape. One handler, one responsibility.',
        },
        {
          kind: 'demo',
          id: 'express-fundamentals:handler:demo',
          demoId: 'express:app-info',
          title: 'Inspecting the running app',
          description:
            "Query a live endpoint that reports this server's runtime facts — Node and Express versions, environment, uptime, process id, and the current scenario state — the app, observed from outside.",
        },
      ],
    },
    {
      id: 'express-fundamentals:pipeline',
      title: 'The middleware pipeline, end to end',
      lead:
        'Every request walks the same registered chain in order — and the order is load-bearing. Here is the whole spine as this app actually mounts it.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:pipeline:concept',
          body: "Concept first: an Express app is a pipeline. Every request — a hit on /api/posts, a typo'd URL, a malformed body — enters at the top and walks the SAME registered chain in registration order, until some layer ends the response or the chain runs out. Two rules follow. ORDER IS LOAD-BEARING: the request-id middleware must run before anything that might log, so even a 400 from the body parser carries a correlation id; security headers mount before any route can answer; the body parses once, at the root, before any router. And the chain has a fixed SHAPE: request middleware first, routes in the middle, the 404 catch-all when nothing matched, and the error handler last — the only middleware that takes four arguments, which is how Express recognizes it. The middleware topic dissects each kind; this is the whole spine in one read:",
        },
        {
          kind: 'code',
          id: 'express-fundamentals:pipeline:verbatim',
          language: 'ts',
          caption:
            'Verbatim (abridged to the spine) — the mounted chain in execution order (server/src/app.ts)',
          source: 'server/src/app.ts',
          code: `export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  // Distributed-Trace ids ride BESIDE the request id (trace_middleware.ts):
  // requestId stays this process's log-correlation key; traceId is the
  // cross-service identity continued from any inbound traceparent header and
  // echoed on EVERY response. Mounted after requestId (which it must not
  // touch) and before the request logger + routes.
  app.use(traceMiddleware);
  app.use(requestLoggerMiddleware);
  // …helmet security headers, pinned and commented (the security topic)…
  app.use(webhookJsonBodyParser);

  // API surface.
  app.use('/api', apiRouter);
  // …the docs router at /docs, then the 404 catch-all below…
  // Error-handling middleware must be registered last.
  app.use(errorHandler);

  return app;
}`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:pipeline:reading-order',
          body: "Read the chain like a story. requestIdMiddleware stamps the correlation id nothing else may precede; traceMiddleware rides beside it (trace ids continued from inbound headers and echoed on every response — the observability topic's distributed-tracing section); requestLoggerMiddleware wraps EVERYTHING below it, including the 404 catch-all, so every request gets exactly one access line on 'finish'; helmet sets security headers on every response before any route runs; webhookJsonBodyParser is body parsing as explicit middleware — the raw-buffer-capturing wrapper this repo uses so webhook signatures verify over exact bytes. Then the routers: the whole /api surface, the docs at /docs, and finally the two closers — the 404 catch-all and the error handler. And this file never listens: that is the app-object section's app/server split, and the reason Supertest can drive this exact chain without a port.",
        },
      ],
    },
    {
      id: 'express-fundamentals:request-life',
      title: 'The life of a request, end to end',
      lead: 'From the TCP socket to the last flushed byte — one concrete journey through the chain you just met, including where errors jump the rails.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:request-life:journey',
          body: "The full journey, concept first. A client opens a TCP connection to the listening socket (the one server.ts owns); node:http receives the bytes and parses them into a request — method, URL, headers, and eventually a body. Then Express's dispatcher takes over: it walks the registered layers IN MOUNT ORDER, and each layer sees the request with the path of everything before it stripped away — inside a router mounted at '/api', the URL is the remainder. A layer matches on prefix plus (for routes) method and pattern; matching layers run in order until one ENDS the response. If the chain runs out with nothing ended — no route matched — the plain-middleware 404 catch-all answers. And at any point, any layer can throw, reject, or call next(err): normal dispatch stops, Express skips ahead looking for the one four-argument error middleware, and THAT ends the response. Success and failure share the same last stop: the response is serialized, written to the socket, and the request logger's 'finish' hook fires as the bytes leave.",
        },
        {
          kind: 'code',
          id: 'express-fundamentals:request-life:routers',
          language: 'ts',
          caption:
            'server/src/presentation/routes/index.ts — verbatim (elided): every feature router, in the mount order requests actually walk',
          source: 'server/src/presentation/routes/index.ts',
          code: `export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(demoRouter);
apiRouter.use(nodeDemoRouter);
// …thirty-five more routers, one per teaching area — each tried IN THIS ORDER
// until one matches: http, routing, middleware, reqres, validation, graphql,
// webhooks, grpc, the sql/mongo/redis/messaging/caching labs, auth, security,
// files, i18n, realtime, jobs, patterns, deps, env, arch, obs, testing,
// deploy, perf, reliability, scaling, best practices, third party…
apiRouter.use(contentRouter);
apiRouter.use(postsRouter);`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:request-life:walkthrough',
          body: "Now a concrete walk: GET /api/posts. requestIdMiddleware stamps res.locals.requestId and the x-request-id header first — it is registered first on purpose. traceMiddleware continues or creates the traceparent identity. requestLoggerMiddleware records the start and hooks 'finish'. helmet sets security headers. The JSON body parser looks at the request, finds no body to read (GET), and calls next() in microseconds. Then app.use('/api', apiRouter) matches, '/api' is stripped, and the apiRouter above walks its forty child routers in mount order: health's paths do not match, nor the demos'… until postsRouter's GET /posts does. The thin controller calls the use case, the use case calls the repository, res.json serializes the Result's value, and the logger's finish line closes the story — one line per request, requestId attached. Miss every route (GET /api/nope) and the same walk ends one layer later, in the 404 catch-all — which is why it mounts AFTER the routers and BEFORE the error handler. The architecture topic's request-flow tracer runs this identical pipeline against a live endpoint and TIMING-SEGMENTS every layer, so you can watch each step of this narrative as measured milliseconds.",
        },
        {
          kind: 'text',
          id: 'express-fundamentals:request-life:flush',
          body: "The response side of the journey deserves the same attention as the request side. When the handler calls res.json(), Express serializes the value, sets Content-Type and Content-Length, and writes status line, headers, and body to the socket through node:http — and from that first flushed byte onward, the status code is frozen: an error discovered after the flush cannot unsend it — one more reason the error middleware should be a plan, not an afterthought. If instead a handler writes incrementally (the Node topic's streaming demo), Express switches to chunked transfer encoding and no Content-Length is possible — the two delivery contracts you can compare live on that screen. Either way the socket itself usually stays open afterwards: HTTP keep-alive lets the client reuse the connection for its next request, which is why graceful shutdown has to wait on idle sockets (server.close there, in the Node topic's signals section).",
        },
      ],
    },
    {
      id: 'express-fundamentals:error-first-steps',
      title: 'Error handling, first steps',
      lead: 'Three ways a handler fails, one place failures land: the four-argument error middleware every Express app owes itself.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:error-first-steps:three-ways',
          body: "A handler can fail three ways, and all three converge on the same destination. A synchronous throw — Express catches it mid-dispatch and jumps straight to the error middleware. An async handler's rejected promise — Express 5 forwards it identically (in Express 4 it was an unhandled rejection and the request simply hung; the v4-vs-v5 section covers the change). And an explicit next(err) — the manual valve, useful in callback-style code or when you want to fail a request from a non-throwing layer. The destination is recognized BY SIGNATURE: any middleware taking four arguments (err, req, res, next) is an error middleware; Express never routes errors to a three-argument one. One thing that is NOT an error: no route matching. Nothing threw — the request just walked the whole chain — so the 404 comes from the plain catch-all you saw quoted earlier, and only a failing catch-all reaches the error handler.",
        },
        {
          kind: 'code',
          id: 'express-fundamentals:error-first-steps:middleware',
          language: 'ts',
          caption:
            'server/src/presentation/middleware/error_middleware.ts — verbatim (elided): the one error sink this app registers',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = extractRequestId(res);

  // …headersSent guard elided: a failure after streaming began delegates to
  // Express's default handler via next(err) — no envelope is possible then…

  if (err instanceof AppException) {
    const { failure } = err;
    // …log at warn for 4xx / error for 5xx, both with the requestId…
    res.status(err.statusCode).json({ error: errorBody });
    return;
  }
  // …unknown errors: best-effort status/code/message extraction — same envelope…
}`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:error-first-steps:envelope',
          body: "Read what the handler receives and guarantees. The error arrives typed as unknown — honest, because anything can be thrown — and the first branch narrows it: AppException carries a typed failure that already knows its status code, machine code, message, and optional details. Unknown errors get best-effort extraction (statusCode, code, message) — which is how the body parser's malformed-JSON 400s land here with a correct status and no domain code of their own. The output guarantee is the part clients feel: EVERY branch answers the same envelope, { error: { code, message, requestId } }, and echoes the requestId the first middleware stamped — a failure you can correlate in the logs by copying one field out of the response. These are the first steps; the Exception Handling topic owns the whole taxonomy (typed failures, when to throw vs return, the envelope's design) and Testing covers asserting it end to end.",
        },
        {
          kind: 'text',
          id: 'express-fundamentals:error-first-steps:anti-patterns',
          body: "Equally instructive is what this app deliberately does NOT do. No try/catch wrappers around controllers — Express 5 forwards rejected promises, so a wrapper would be ceremony the framework already performs (codebases stuck on Express 4 used the express-async-errors package to buy the same behavior). No res.status(500).json(...) sent inline from a handler — an inline error bypasses the one sink, so it skips the logging discipline and quietly forks your error envelope into two shapes. No per-route error handlers either: one sink registered once at the composition root is what guarantees every failure the same envelope, the same log line, the same requestId. The rule of thumb to carry forward: expected failures come back as Result values the controller maps, unexpected ones travel as thrown typed exceptions to the sink — and the next topic in the guide's error track, Exception Handling, builds the full taxonomy on exactly this foundation.",
        },
      ],
    },
    {
      id: 'express-fundamentals:v4-v5',
      title: 'Express 4 vs Express 5',
      lead:
        'This repo runs Express 5 — and three of the v5 changes actually shape how its code is written. What changed, grounded in this app\u2019s own files.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:v4-v5:what-changed',
          body: 'Three changes you FEEL. (1) REJECTED PROMISES REACH THE ERROR MIDDLEWARE. In Express 4, a throw inside an async handler was an unhandled rejection the framework never saw — the request simply hung. In Express 5, the rejection forwards to the error-handling middleware like any thrown exception. This app\'s entire controller style is built on it: controllers are async, failures are thrown as typed exceptions (the thin controller quoted two sections up), and nobody wraps handlers in try/catch to protect Express from the promise. (2) THE PATH SYNTAX TIGHTENED. v5 moved to path-to-regexp v8: the bare wildcard \'*\' no longer matches everything (a named wildcard like /*splat is required), regex-capable route patterns like /:id(\\d+) are gone, and optional parameters were removed in 5.0 then restored for 5.1. The quote below is this repo\'s own defense: the 404 catch-all is PLAIN MIDDLEWARE with no path at all — identical behavior across both versions\' wildcard syntaxes. (3) THE DEFAULT QUERY PARSER IS \'simple\'. v4 parsed query strings with qs (\'extended\' — nested objects via ?a[b]=c); v5 defaults to the flat querystring parser. This repo never noticed the difference because every query parameter it reads is a flat string. Around the edges, a pile of long-deprecated APIs went away (app.del, res.send(status), and friends) — the official migration guide is the honest inventory, and a Supertest suite that drives real routes catches most breakage mechanically.',
        },
        {
          kind: 'code',
          id: 'express-fundamentals:v4-v5:verbatim-404',
          language: 'ts',
          caption:
            'Verbatim — the version-proof 404 catch-all, with its reason in the comment (server/src/app.ts)',
          source: 'server/src/app.ts',
          code: `  // 404 catch-all — plain middleware (no wildcard path), so it behaves the
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
  });`,
        },
        {
          kind: 'code',
          id: 'express-fundamentals:v4-v5:version',
          language: 'json',
          caption: 'Verbatim — the deliberate floor: express ^5.1.0 in a hand-picked dependency set (server/package.json)',
          source: 'server/package.json',
          code: `  "dependencies": {
    "@grpc/grpc-js": "^1.14.5",
    "better-sqlite3": "^13.0.3",
    "express": "^5.1.0",`,
        },
      ],
    },
    {
      id: 'express-fundamentals:leaves-out',
      title: 'What Express deliberately leaves out',
      lead:
        'Routing, a middleware pipeline, and request/response sugar — and nothing else. The thinness is the philosophy, and this guide is what bolting the rest on looks like.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:leaves-out:philosophy',
          body: "Concept first: Express is deliberately a THIN framework — routing, a middleware pipeline, and a small request/response API over node:http, and it stops there. Everything that makes an app production-grade is ABSENT by design, and you bolt it on in middleware and your own modules: no input validation (this repo validates at the use-case boundary — the validation topic's idioms), no authentication or sessions (the auth topics hand-roll both so the mechanism is visible), no database layer or ORM (better-sqlite3 behind hand-written repositories — the SQL topics teach raw SQL first for exactly this reason), no security headers (helmet, wired by hand below), no structured logging (pino), no error taxonomy (this repo's typed exceptions and one error middleware — the exception-handling topic). The quote below is the philosophy in a few lines: security headers and body parsing wired EXPLICITLY, with the audit trail in comments — nothing implicit, so nothing hidden.",
        },
        {
          kind: 'code',
          id: 'express-fundamentals:leaves-out:verbatim',
          language: 'ts',
          caption:
            'Verbatim — what a thin framework makes YOU wire: security headers and body parsing as explicit mounts (server/src/app.ts)',
          source: 'server/src/app.ts',
          code: `  app.use(
    helmet({
      contentSecurityPolicy: {
        // …useDefaults: false + the pinned, audited directives (the security topic)…
      },
    }),
  );

  app.use(webhookJsonBodyParser);`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:leaves-out:payoff',
          body: "Why layer your own instead of reaching for a batteries-included framework (NestJS, Django, Next.js)? The honest trade, both ways. Thin plus your own layers: every seam is visible, testable, and replaceable — this repo swaps fake and live repositories behind the SAME routes because Express never knew a database existed, and the DI container (the architecture topic) owns every wire. Batteries included: conventions move you faster on day one and tax you at every seam where your problem differs from the framework's opinion. The cost of thinness is DISCIPLINE: with nothing imposing structure, the one-error-middleware, one-validation-idiom, one-logger rules must be decided once, centrally, and enforced by habit — the best-practices topic is that habit, written down. Express's bet, and this guide's, is that understanding each piece you bolt on beats having it pre-installed.",
        },
      ],
    },
    {
      id: 'express-fundamentals:static-docs',
      title: 'Serving static assets and the docs mount',
      lead: 'express.static turns a directory into middleware — and the one static surface this app actually serves is its own API documentation.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:static-docs:static-basics',
          body: 'Static serving in Express is one line of middleware: app.use(express.static("public")) takes a directory and serves its files — GET /app.js returns public/app.js with the right Content-Type, an ETag, and conditional-request handling for free, plus index.html for directory paths and a fallthrough to next() when nothing matches. Because it IS middleware, everything you already read applies: mount order decides whether static files shadow routes or the other way around, and it sits inside the same pipeline as everything else. Serving a whole frontend this way works — but it spends single-threaded event-loop time on bytes that never needed JavaScript, which is why the production stance (bottom of this section) hands static to a proxy. This repo has no public/ directory of its own: the React client is a separate Vite package in development, and its built files are served by nginx in production.',
        },
        {
          kind: 'code',
          id: 'express-fundamentals:static-docs:docs-mount',
          language: 'ts',
          caption:
            'server/src/presentation/routes/docs_routes.ts — verbatim (elided): the docs surface — an exact route, a redirect, then a static-asset mount',
          source: 'server/src/presentation/routes/docs_routes.ts',
          code: `export const DOCS_UI_PATH = '/docs';
export const DOCS_SPEC_PATH = '/docs/openapi.json';

export const docsRouter = Router();

// The raw spec first — exact route wins over the static-asset fallthrough.
docsRouter.get(DOCS_SPEC_PATH, (_req, res) => {
  res.json(openApiDocument);
});

// …the bare /docs → /docs/ (301) redirect, as middleware BEFORE the mount —
// the UI's asset URLs are relative, so the trailing slash is load-bearing…

// Serve (static assets, index disabled) then the generated HTML page —
// both /docs/ (req.url '/') and every asset path land here.
docsRouter.use(DOCS_UI_PATH, swaggerServe, swaggerSetup(openApiDocument));`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:static-docs:how-docs-works',
          body: "That mount is express.static in the flesh — swagger-ui-express is a thin wrapper: swaggerServe serves the Swagger UI's own css/js bundle out of its package directory (serve-static underneath), and swaggerSetup(openApiDocument) generates the HTML page wired to that same OpenAPI document. Notice how much of this topic shows up in five lines. Order is load-bearing twice: the exact /docs/openapi.json route registers BEFORE the static mount so it wins, and the redirect middleware runs before both because Express cannot express 'match /docs but not /docs/' as a pattern. Mount path matters: the router rides the ROOT app, not /api, because the UI resolves its assets relative to where it is served — /api/docs would double the prefix on every asset URL.",
        },
        {
          kind: 'text',
          id: 'express-fundamentals:static-docs:caching',
          body: "Caching is where static serving earns its keep. Out of the box, express.static stamps each file with an ETag and Last-Modified, and answers If-None-Match / If-Modified-Since with a cheap 304 Not Modified — the file's bytes never move again until it changes (the Caching topic demonstrates the same conditional-request machinery by hand on a dynamic endpoint). The production refinement is fingerprinting: bundled assets get content-hashed filenames, so they can carry Cache-Control: public, max-age=31536000, immutable — the hash IS the version, the file can never change under the same URL, and browsers stop revalidating entirely. HTML files are the exception (their names never change), so they stay no-cache and reference the hashed assets. That strategy lives wherever the files are served — express.static options, nginx config, or a CDN's rules — and it is one more reason the boundary at the bottom of this section matters.",
        },
        {
          kind: 'code',
          id: 'express-fundamentals:static-docs:nginx',
          language: 'nginx',
          caption:
            '.docker/client/default.conf — verbatim (elided): production static serving — nginx owns the files, Express sees only /api',
          source: '.docker/client/default.conf',
          code: `server {
    # the built React client's files live here — nginx, not Express, owns them
    root   /usr/share/nginx/html;
    index  index.html;

    # Proxy API calls to the Express server (compose service name).
    location /api/ {
        proxy_pass http://server:4000;
        # …websocket upgrade + host headers…
    }

    # SPA history fallback: unknown paths serve the app, which renders the 404 view.
    location / {
        try_files $uri $uri/ /index.html;
    }`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:static-docs:production-stance',
          body: "The production stance, visible in that config: static belongs to the proxy. nginx serves the client's built files straight off disk — kernel-speed file delivery, zero event-loop time, cache headers and gzip configured where the files live — and forwards ONLY /api/ to Express, so every request reaching your middleware chain is work that actually needs JavaScript. The try_files fallback is the SPA's router: unknown paths return index.html and the client-side router renders the 404 view, because client-side routes like /topics/express-fundamentals have no file behind them. The same division of labor scales one more notch to a CDN in front of nginx for assets with long-lived hashes. The Deployment topic owns this whole reverse-proxy story — TLS termination, proxy headers, the Docker wiring; this section's claim is only the boundary: static at the edge, dynamic in the loop.",
        },
      ],
    },
    {
      id: 'express-fundamentals:workflow',
      title: 'The development workflow',
      lead: 'Edit, reload, verify: the tight loop this repo is tuned for.',
      blocks: [
        {
          kind: 'text',
          id: 'express-fundamentals:workflow:concept',
          body: 'Concept first: backend feedback is slower than frontend feedback — you cannot watch a database row change the way you watch a button re-render. So the workflow has one job: shorten the distance between editing code and proving behavior.\n\nThis repo optimizes for a single loop. npm run dev starts tsx watch, which runs TypeScript directly and restarts on every save — no build step in the inner loop. You exercise endpoints with curl against localhost:4000 while the logs stream past. When a behavior matters, it graduates into a Vitest + Supertest case so it stays proven forever.',
        },
        {
          kind: 'code',
          id: 'express-fundamentals:workflow:loop',
          language: 'json',
          caption: 'The four scripts from server/package.json — the whole dev loop',
          source: 'server/package.json',
          code: `{
  "scripts": {
    "dev": "tsx watch src/server.ts",  // inner loop: run TS directly, reload on save
    "build": "tsc",                    // type-check + emit dist/
    "test": "vitest run",              // behavior stays proven
    "start": "node dist/server.js"     // what production (Docker) runs
  }
}`,
        },
        {
          kind: 'text',
          id: 'express-fundamentals:workflow:testing',
          body: 'Because createApp() is decoupled from listening, Supertest drives the real pipeline — middleware, routing, error envelope, request IDs — by invoking the app object directly. Tests start in milliseconds, need no port housekeeping, and fail with the exact JSON a real client would receive. That same separation lets the production Docker image run node dist/server.js without changing a line.',
        },
      ],
    },
  ],
};
