import type { Topic } from '../types.js';

/**
 * The middleware topic: the pipeline every request travels. Concept-first
 * (each layer is a function with exactly three exits), then Express specifics
 * — built-ins, mounting levels, error handling, the catalog, custom patterns.
 * Snippets from this repo are marked verbatim; illustrative sketches say so
 * in their captions.
 */
export const topicMiddleware: Topic = {
  id: 'middleware',
  title: 'Middleware',
  subtitle:
    'The pipeline every request travels: built-ins, levels, error handlers, and the third-party catalog.',
  group: 'middleware-request',
  order: 2,
  sections: [
    {
      id: 'mw-model',
      title: 'The middleware model',
      lead: 'A middleware is a function with three inputs and exactly three legal exits. Everything else — routing, auth, parsing, errors — is built out of that one shape.',
      blocks: [
        {
          kind: 'text',
          id: 'mw-model:contract',
          body: `Concept first, framework-free: an HTTP server has a recurring problem. A request arrives, and a whole set of concerns wants a shot at it before your actual page- or API-handling logic runs — logging, parsing, authentication, rate limiting — and the same set wants another shot at the response on the way out. Middleware solves this with the simplest possible contract: a chain of functions, each handed the request, the response, and a callback named next. Do your work, mutate or decorate the request and response as you see fit, and then choose one of three exits.\n\nThe three exits are the entire model. Call next() and control flows to the following layer; the pipeline keeps moving. Respond yourself — res.json(), res.send(), res.sendFile() — and the chain stops dead: no layer registered after yours runs, and your response is the response. Or call next(err), which skips everything until someone willing to handle errors is found. Notice what is NOT on this list: doing nothing. A middleware that neither responds nor calls next() leaves the request hanging until the client gives up — Express will not guess for you, and a stalled request is a real production incident (a leaked socket, a filled connection pool). Every custom middleware you write is a promise to take exactly one of those three exits on every code path, including the error ones.`,
        },
        {
          kind: 'code',
          id: 'mw-model:exits',
          language: 'ts',
          caption:
            'The whole contract — three inputs, three exits, all three REAL: the trace factory (exit 1), the auth short-circuit\'s answer (exit 2), and the demo error layer\'s rethrow (exit 3), verbatim from this topic\u2019s demo router',
          source: 'server/src/presentation/routes/middleware_demo_routes.ts',
          code: `// exit 1 — pass control on; the pipeline keeps flowing (traceMiddleware,
// verbatim — and it is a factory: the label and stage close over):
export function traceMiddleware(label: string, stage: number): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    pushStage(res, stage, label);
    next(); // pass control on — the pipeline keeps flowing
  };
}

// exit 2 — answer the request yourself; NOTHING registered after this layer
// runs (not even later routes). The auth short-circuit's answer, verbatim —
// note it owes callers the SAME envelope the global error handler produces:
res.status(401).json({
  error: {
    code: 'unauthorized',
    message: 'the auth middleware answered 401 itself — next() was never called',
    requestId,
  },
});

// exit 3 — bail out to the error pipeline; everything between here and the
// error-handling middleware is skipped (demoPipelineErrorHandler, verbatim):
next(err);

// What is NOT on this list: doing nothing. A middleware that neither responds
// nor calls next() leaves the request hanging until the client gives up.`,
        },
        {
          kind: 'text',
          id: 'mw-model:truth-table',
          body: `Because each layer chooses an exit, the pipeline behaves like an onion built out of ordinary function calls: the request flows down through every layer that calls next(), reaches the route handler, and — when the handler responds synchronously — control unwinds back up, so a layer can act both before and after the layers beneath it (do work, call next(), then do more work when it returns). One honest caveat for the async world: if the handler awaits anything before responding, next() returns early, so "after the handler" work belongs on the response's own events (res.on('finish')) rather than on the line after next().\n\nThe second consequence of the model is that registration order IS semantics. Middleware and routes share one list, matched top to bottom; the first handler that responds wins. A logger registered after the routes logs nothing (the routes already responded), a body parser registered after the handlers hands them an empty req.body, and an error handler registered anywhere but last never sees errors it could have caught first. This app's src/app.ts is deliberately readable as a sentence for exactly that reason:`,
        },
        {
          kind: 'code',
          id: 'mw-model:app-order',
          language: 'ts',
          caption: 'server/src/app.ts — verbatim (annotations added; helmet and the docs mount elided): five load-bearing stages in registration order',
          source: 'server/src/app.ts',
          code: `app.use(requestIdMiddleware);   // 1. correlation id FIRST — even 404s/500s carry one
// …trace id + request logger + helmet security headers (elided)…
app.use(webhookJsonBodyParser); // 2. body parsing before any handler reads req.body

app.use('/api', apiRouter);     // 3. the route tables (routers are middleware too)

// 4. 404 catch-all — reached only when no route responded
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
          kind: 'code',
          id: 'mw-model:exits-table',
          language: 'txt',
          caption: 'The control-flow truth table — what each layer behavior causes',
          code: `what the layer does                what happens next
--------------------------------  -------------------------------------------
work, then next()                 the next middleware in line runs
respond (res.json / res.send / …)  the chain STOPS — later layers never run
next(err) or throws               everything skipped until a 4-arg error
                                  middleware is found (or Express's default)
neither responds nor calls next   the request HANGS — Express will not guess`,
        },
      ],
    },
    {
      id: 'mw-builtins',
      title: 'Built-in middleware',
      lead: 'Express ships three workhorse layers — json, urlencoded, static — and this app runs exactly one of them. The query parser shows how the boundary between middleware and framework config moves.',
      blocks: [
        {
          kind: 'text',
          id: 'mw-builtins:which',
          body: `express.json() is the one built-in parser this app mounts — in its verify-hook form (see the snippet: the root parser stashes the raw body bytes for the webhooks topic's HMAC demo, a teaching addition that changes nothing about its parsing semantics) — and it reads request bodies with a JSON content-type into req.body, which every POST controller here depends on. It grew siblings over the years — express.urlencoded({ extended: false }) parses classic HTML form posts (application/x-www-form-urlencoded) and you want the non-extended option unless you specifically need qs-style nested keys; express.static(path, options) serves files from disk and is the fastest way to ship a frontend next to an API (the Files & Media topic builds the full upload/download story instead of relying on it). All three are ordinary middleware — you mount them where you want them, and they pass control on with next() whether they matched or not. Two Express 5 behaviors matter here. Strict content-typing: if no parser matched the request's content-type, req.body is undefined — not {}, undefined — so "did a body even arrive?" is a real check your boundary code must make (the routing topic's POST demo trips this live). And what used to be a fourth piece of middleware, query parsing, is now configuration: req.query is populated by the framework itself, with the parser selected by app.set('query parser', …) — Express 5's default is Node's "simple" parser, which means no nested ?a[b]=c objects and repeated keys arrive as arrays. The lesson generalize from: the line between "middleware" and "framework config" is not eternal; what stays true is that boundary inputs arrive as strings until a layer you control makes them otherwise.`,
        },
        {
          kind: 'code',
          id: 'mw-builtins:usage',
          language: 'ts',
          caption:
            'server/src/presentation/routes/webhooks_demo_routes.ts — verbatim: the json parser this app ACTUALLY mounts at its root (express.json() plus the raw-body verify hook; the sibling parsers, not mounted here, in the comments)',
          source: 'server/src/presentation/routes/webhooks_demo_routes.ts',
          code: `// what this app runs — a JSON API, so ONE parser at the root (app.ts
// mounts this; it is express.json() with its 100kb limit PINNED at the
// default and one teaching addition, the verify hook that captures the raw
// bytes for the webhooks topic's HMAC):
export const webhookJsonBodyParser = json({
  limit: '100kb',
  verify: (req, _res, buf) => {
    const request = req as typeof req & { rawBody?: Buffer; originalUrl?: string };
    const path = (request.originalUrl ?? '').split('?')[0];
    if (request.method === 'POST' && path === WEBHOOK_RECEIVE_PATH) {
      request.rawBody = buf;
    }
  },
});

// the siblings, when your API needs them (NOT mounted in this app):
//   app.use(express.urlencoded({ extended: false })); // HTML form posts → req.body
//   app.use(express.static('public'));               // GET /app.js → public/app.js
// query parsing is CONFIG, not middleware (Express 5 default: "simple"):
//   app.set('query parser', 'simple');   // ?q=a&q=b → { q: ['a', 'b'] } — strings only`,
        },
      ],
    },
    {
      id: 'mw-levels',
      title: 'app.use, router.use, and route-level middleware',
      lead: 'The same middleware function can be mounted at three scopes: the whole app, one mounted subtree, or one specific route. Scope narrows, contract stays identical.',
      blocks: [
        {
          kind: 'text',
          id: 'mw-levels:concept',
          body: `app.use(...) mounts a layer for every request the server receives — use it for the truly cross-cutting: correlation ids, body parsing, security headers. router.use(...) mounts it for a subtree: the router is itself middleware (app.use('/api', apiRouter) is a layer that delegates everything under /api into the router's own stack), so a layer on the router runs only for that subtree — auth for /api/admin without touching /health. Route-level middleware is the same idea at the narrowest scope: router.get(path, mw1, mw2, handler) stacks layers in front of THAT one handler — a file-upload parser on the avatar route, a token check on the login route, without any neighbors knowing. The contract never changes — (req, res, next), three exits — only who gets to run.\n\nTwo mechanics worth internalizing. use() matches by path PREFIX and ignores method: app.use('/api', r) fires for every method under /api, which is why method-keyed behavior comes from routes, not from use(). And within a scope, layers run in registration order top to bottom — the routing topic's "first match wins" rule is this same list. This repo uses all three levels on purpose: request-id and json parsing are app-level (everything deserves them, including 404s and 500s); the demo routers are mounted router-level through apiRouter — and this topic's own demo router carries a router-level error middleware that annotates every error leaving it; and each demo route's trace stack is registered route-level, right on the route line:`,
        },
        {
          kind: 'code',
          id: 'mw-levels:three-levels',
          language: 'ts',
          caption:
            'The three scopes. Router-level and route-level, verbatim from this topic\u2019s demo router (middleware_demo_routes.ts); the app-level lines were quoted from src/app.ts two sections up',
          source: 'server/src/presentation/routes/middleware_demo_routes.ts',
          code: `// app-level — every request, every method, every path (app.ts, quoted
// earlier): app.use(requestIdMiddleware) and friends run before ALL of this.

// route-level — only THIS route runs the stack: the stack IS part of the
// route registration (this topic\u2019s demo, verbatim):
middlewareDemoRouter.get(
  '/demo/middleware/pipeline',
  traceMiddleware('logger', 1),    // layer 1
  traceMiddleware('auth', 2),      // layer 2
  traceMiddleware('validator', 3), // layer 3
  pipelineController,              // the handler terminates the chain
);

// router-level — only the subtree a mounted router serves. This app mounts
// ~40 demo routers this way through routes/index.ts (middlewareDemoRouter is
// one of them); a router can also carry its OWN layers — this error handler
// runs for every route registered ABOVE it in THIS router only (and in the
// real file it really is the last line of the router):
middlewareDemoRouter.use(demoPipelineErrorHandler);

// choose the NARROWEST scope that works: an auth check mounted app-level
// will one day lock you out of the login route.`,
        },
        {
          kind: 'text',
          id: 'mw-levels:ordering',
          body: `Ordering consequences compound across scopes: the app-level layers run before any router's stack, and each router's own layers run before its routes. So request-id is stamped before the demo router's first trace middleware — that is why the 401 short-circuit envelope below can include a real requestId — and a body parser mounted on a router would run only for that router's routes, after every app-level layer. When a request falls off the end of everything, the app-level 404 catch-all answers; when anything throws past it, the app-level error handler renders the envelope. One mental model, four scopes deep.`,
        },
      ],
    },
    {
      id: 'mw-error',
      title: 'Error-handling middleware',
      lead: 'Same contract, one extra argument: (err, req, res, next). Express recognizes the 4-arg shape and routes every failure to it — in Express 5, including rejected promises from async handlers.',
      blocks: [
        {
          kind: 'text',
          id: 'mw-error:concept',
          body: `Exit 3 — next(err) — deserves its own machinery, because "what happened" is a different question from "what do we do about it". Express's answer is a second middleware signature: four arguments instead of three, with the error first. The arity IS the registration — you do not flag an error handler, you simply define one, and Express skips past every normal layer (and route) until it finds one. That is why it must be registered last: an error handler mounted mid-stack swallows errors from everything above it and nothing below it can throw yet. In Express 4, an async handler that rejected left the framework helpless (the rejection never reached next), so every codebase carried an asyncHandler wrapper that caught and forwarded. Express 5 closed that gap: a handler that returns a rejected promise is forwarded into the error pipeline automatically — this topic's demo relies on it (its exploding handler is async), and the repo carries no wrapper.\n\nThis app centralizes rendering in one global errorHandler: AppExceptions carry a typed Failure, and the middleware maps it to the canonical envelope { error: { code, message, requestId } } with the failure's details merged in; anything else gets best-effort extraction so even a stray plain Error still produces the same shape. A second pattern sits in front of it in the demo router: a ROUTER-level error middleware that annotates and rethrows — it appends 'error-handler' to the pipeline trace, publishes the header, then hands the original error onward with next(err). Annotate, never swallow: the envelope stays canonical because exactly one place renders it.`,
        },
        {
          kind: 'code',
          id: 'mw-error:verbatim',
          language: 'ts',
          caption: 'server/src/presentation/middleware/error_middleware.ts — verbatim (logging branch shown as shipped; annotations added): the one renderer of the error envelope',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `export function errorHandler(
  err: unknown,                    // the 4-arg shape is the recognition — and ANYTHING can arrive here
  _req: Request,
  res: Response,
  next: NextFunction,              // no longer decorative: the headersSent branch below calls next(err)
): void {
  const requestId = extractRequestId(res);

  // response already streaming? no envelope possible — delegate, don't crash:
  if (res.headersSent) {
    logger.error(
      { err, requestId },
      'error after response started — delegating to express default handler',
    );
    return next(err);
  }

  if (err instanceof AppException) {
    const { failure } = err;
    // Level discipline: 4xx is the CLIENT's problem — warn; 5xx is OURS — error.
    const logLine = { err, statusCode: err.statusCode, requestId, failureKind: failure.kind };
    if (err.statusCode >= 500) logger.error(logLine, 'request failed');
    else logger.warn(logLine, 'request failed');
    const errorBody: Record<string, unknown> = {
      ...(failure.details ?? {}),      // details merge under the canonical keys…
      code: err.code,                  // …which win on collision
      message: failure.message,
      requestId,
    };
    res.status(err.statusCode).json({ error: errorBody });
    return;
  }
  // not one of ours → best-effort extraction, SAME envelope shape
  const statusCode = extractStatusCode(err);
  res.status(statusCode).json({
    error: {
      code: extractCode(err, statusCode),
      message: extractMessage(err),
      requestId,
    },
  });
}`,
        },
        {
          kind: 'code',
          id: 'mw-error:annotate-rethrow',
          language: 'ts',
          caption: 'server/src/presentation/routes/middleware_demo_routes.ts — verbatim: the annotate-and-rethrow pattern, router-scoped',
          source: 'server/src/presentation/routes/middleware_demo_routes.ts',
          code: `function demoPipelineErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,   // the 4-arg shape is what makes Express treat this as an error layer
): void {
  pushStage(res, 5, 'error-handler');  // annotate: the trace gains its fifth stage
  setPipelineHeader(res);              // header BEFORE any response starts — headers lock
  next(err);                           // rethrow: the GLOBAL handler still renders the envelope
}

// registered AFTER the demo routes it guards:
middlewareDemoRouter.use(demoPipelineErrorHandler);`,
        },
      ],
    },
    {
      id: 'mw-catalog',
      title: 'The third-party catalog',
      lead: 'The layers nearly every production app bolts on. None are installed in this guide app on purpose — each gets built or wired properly in its own topic — but you should recognize all of them on sight.',
      blocks: [
        {
          kind: 'text',
          id: 'mw-catalog:survey',
          body: `Middleware is Express's extension point, so the ecosystem's habits live there. The catalog below is the common core — the seven packages you will meet in almost every serious deployment, each as one registration with a one-line "when you reach for it". This app mounts exactly one of them at its root (helmet — the security headers, really on in src/app.ts); the others are deliberately not at the root: the Security topic wires CORS and a rate limiter for real; Files & Media handles uploads with multer; the observability topic owns request logging. Reading them here is about pattern recognition — knowing which pipeline slot each fills, and what its failure mode is.\n\nThe evaluation habit worth building before installing any of them: ask where it sits in the chain (order-sensitivity), what it costs on every request (a header-setter is free; a logger that formats eagerly is not), and what happens when it fails open or closed. A rate limiter that errors open protects nothing; CORS misconfigured permissive is a hole, not a feature. Middleware composes — which also means middleware mistakes compose.`,
        },
        {
          kind: 'code',
          id: 'mw-catalog:snippets',
          language: 'ts',
          caption:
            'The common core. helmet is REAL — verbatim from src/app.ts, the one catalog package this app mounts at the root; the rest are shown as the registrations you will write, with where this guide builds each for real',
          source: 'server/src/app.ts',
          code: `// security headers — reach for helmet FIRST, tune per app. This app REALLY
// runs it (app.ts, verbatim shape; the full CSP directive set is elided):
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        // …the pinned, audited directive set lives in app.ts…
      },
    },
  }),
);

// the rest of the catalog — NOT at the root of this app; each named topic
// builds or wires it for real:
//   import cors from 'cors';                     // the security topic ships a
//   app.use(cors({ origin: 'https://app.example', credentials: true }));  // hand-rolled twin (middleware/cors_middleware.ts)
//   import pinoHttp from 'pino-http';            // per-request logs — this app uses
//   app.use(pinoHttp({ logger }));               // pino + its own request logger middleware
//   import rateLimit from 'express-rate-limit';  // throttle abuse — the security topic
//   app.use('/api', rateLimit({ windowMs: 60_000, limit: 100 }));  // mounts it for real
//   import cookieParser from 'cookie-parser';    // Cookie header → req.cookies (sessions)
//   app.use(cookieParser());                     //  — the auth topics parse by hand instead
//   import multer from 'multer';                 // multipart uploads — ROUTE-level, always
//   app.post('/avatars', multer({ limits: { fileSize: 1024 * 1024 } }).single('avatar'), handler);  //  — files-media, for real
//   import compression from 'compression';       // gzip at the edge — perf topic, route-scoped
//   app.use(compression());`,
        },
      ],
    },
    {
      id: 'mw-custom',
      title: 'Custom middleware patterns',
      lead: 'Four shapes cover most custom layers: decoration, observability, guards, and factories. The interesting decision is not how to write them — it is what belongs in a middleware at all.',
      blocks: [
        {
          kind: 'text',
          id: 'mw-custom:decoration',
          body: `Request decoration is the workhorse: stamp something onto the request that every downstream layer can read, and that survives into the error envelope. The safe per-request carrier is res.locals — an object Express creates fresh for each request, so there is no leakage between requests and no module-level mutable state (the bug class that haunts "just use a module variable" middleware). This app's first middleware is exactly that pattern, mounted before everything so even 404s and 500s carry a correlation id. Note what it does NOT do: parse, validate, or branch. Decoration middleware should be boring.\n\nObservability layers wrap the pipeline rather than participate in it: start a clock before next(), and record when the response actually left — which, in an async world, means res.on('finish'), because the line after next() runs when control unwinds, not when bytes hit the socket. Guard middleware — "is there a token? is the body JSON? is this origin allowed?" — answers transport-shaped questions and short-circuits with an error envelope when they fail. The line this repo draws deliberately: transport shape at the edge (content-type, single-segment params, presence of required fields), meaning in the use case (is this a REAL post id? is the title too long?). Guards ask "is the request well-formed to even attempt?" — domain validation asks "is this attempt any good?" — and only the second one must be testable without HTTP.`,
        },
        {
          kind: 'code',
          id: 'mw-custom:request-id-verbatim',
          language: 'ts',
          caption: 'server/src/presentation/middleware/request_id_middleware.ts — verbatim: decoration in a handful of lines, mounted FIRST in src/app.ts',
          source: 'server/src/presentation/middleware/request_id_middleware.ts',
          code: `export function requestIdMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();          // fresh per request — never shared state
  res.locals.requestId = requestId;        // res.locals: the per-request carrier
  res.setHeader('x-request-id', requestId); // echo it to the client for support conversations
  next();                                  // exit 1, always — this layer never answers
}`,
        },
        {
          kind: 'code',
          id: 'mw-custom:factory-verbatim',
          language: 'ts',
          caption:
            'The factory pattern, verbatim from this topic\u2019s demo router (middleware_demo_routes.ts): registration order IS the stage order',
          source: 'server/src/presentation/routes/middleware_demo_routes.ts',
          code: `export function traceMiddleware(label: string, stage: number): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    pushStage(res, stage, label); // decorate: append { stage, label, elapsedMs }
    next();
  };
}`,
        },
        {
          kind: 'code',
          id: 'mw-custom:timing-verbatim',
          language: 'ts',
          caption:
            'The timing middleware, verbatim — this app\u2019s REAL request logger (request_logger_middleware.ts): res.on(\'finish\') is the honest "after" hook',
          source: 'server/src/presentation/middleware/request_logger_middleware.ts',
          code: `// TIMING middleware: wrap the pipeline, not just the next() call. The
// captured path/method are read BEFORE next() (routers rewrite req.url per
// mount); the line itself is written when the response FINISHES:
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt =
    typeof res.locals.requestStartedAt === 'number' ? res.locals.requestStartedAt : performance.now();

  const path = req.path;
  const method = req.method;

  let settled = false;
  const settle = (aborted: boolean): void => {
    if (settled) return;
    settled = true;

    const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    const reqId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
    const line = { reqId, method, path, status: res.statusCode, durationMs };

    if (aborted) {
      logger.warn({ ...line, aborted: true }, 'request aborted (connection closed early)');
      return;
    }
    if (res.statusCode >= 500) logger.error(line, 'request completed');
    else if (res.statusCode >= 400) logger.warn(line, 'request completed');
    else logger.info(line, 'request completed');
  };

  res.once('finish', () => settle(false)); // fires when the response is DONE
  res.once('close', () => settle(true));   // …or the connection died first

  next();                                  // don\u2019t wait — let the pipeline run
}`,
        },
        {
          kind: 'text',
          id: 'mw-custom:async',
          body: `One pattern this repo deliberately does NOT carry: the async-handler wrapper (try { await handler(req, res, next) } catch (err) { next(err) }). It was mandatory scaffolding in Express 4; Express 5 forwards rejected promises from async handlers into the error pipeline natively, so the wrapper is dead weight — the demo's error-path endpoint proves it by being async, throwing, and arriving at the global handler with no wrapper anywhere. Reach for wrapping only when the wrap itself is the point — timing, transactions, per-route logging — and then wrap once, carefully, in one place.`,
        },
      ],
    },
    {
      id: 'mw-live',
      title: 'See it live',
      lead: 'A pipeline you can misroute on purpose: three runs of a real four-layer stack — happy path, short-circuit, and error — each rendered as the exact chain that ran.',
      blocks: [
        {
          kind: 'text',
          id: 'mw-live:intro',
          body: `Every button below fires a real request through the demo router's stack — logger, auth, validator, handler — where each layer appends a timestamped entry to a per-request trace. The happy path runs all four and lights every card in order, with per-stage elapsed times measured from the first middleware's clock. The short-circuit run shows the auth layer taking exit 2: it answers 401 itself (the canonical envelope, requestId included) and never calls next(), so the validator and handler cards go dark and the chain visibly stops at auth. The error-path run shows exits 3 and the 4-arg machinery: the async handler throws, a router-level error middleware appends 'error-handler' to the trace and rethrows, and the app's global error handler renders the 500 envelope. On the error runs the trace travels in the x-pipeline response header — the body belongs to the error envelope — which is exactly why the demo reads both.`,
        },
        {
          kind: 'code',
          id: 'mw-live:curl',
          language: 'bash',
          caption: 'drive the demo endpoints yourself (-i: the trace header is half the story)',
          code: `# The full stack — four stamped stages, trace in body AND header:
curl -si localhost:4000/api/demo/middleware/pipeline | head -20

# Auth short-circuits: 401 envelope, and x-pipeline stops after 'short-circuit'
# — no validator, no handler. The chain stopped:
curl -si localhost:4000/api/demo/middleware/short-circuit | head -20

# The handler throws (async): 'error-handler' is appended, the error is
# rethrown to the GLOBAL handler, and the 500 envelope comes back canonical:
curl -si localhost:4000/api/demo/middleware/error-path | head -20`,
        },
        {
          kind: 'demo',
          id: 'mw-live:demo',
          demoId: 'middleware:pipeline',
          title: 'The pipeline visualizer',
          description:
            'Three runs of the same real stack. Happy path lights logger → auth → validator → handler in order; short-circuit stops the chain at auth with a 401 envelope beside it; the error path lights error-handler and returns the canonical 500 envelope — the trace rides the x-pipeline header when the body belongs to the error.',
        },
      ],
    },
  ],
};
