import type { Topic } from '../types.js';

/**
 * The Exception Handling topic — the guide's tour of ITS OWN error pipeline.
 * Every code block below is this app's real running source (the pipeline was
 * built in the architecture-core task and has been load-bearing under every
 * topic since); the demo at the end injects failures into it live.
 */
export const topicExceptionHandling: Topic = {
  id: 'exception-handling',
  title: 'Exception Handling',
  subtitle:
    'The error pipeline this app runs: typed failures, envelopes, and request-scoped logging.',
  group: 'platform',
  order: 1,
  sections: [
    {
      id: 'errors-two-worlds',
      title: 'Errors as values, errors as throws',
      lead:
        'This app deliberately lives in both worlds: failures are VALUES inside the domain and exceptions only AT THE EDGE. The border between the two is one function.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-two-worlds:divide',
          body: `THE TWO WORLDS. Inside the domain and data layers, a failure is a VALUE: use cases return Result<_, Failure>, a tagged union you must unwrap before you can touch the success value. The type checker enforces that you looked; control flow stays explicit (you can SEE the failure branch the way you can see an if); nothing unwinds the stack; and a failure can be stored, logged, mapped, retried, or returned onward like any other data — because it IS data. At the HTTP edge, Express's native idiom is the THROW: handlers throw, middleware calls next(err), and a four-argument error middleware at the end of the chain renders the response. Fighting either world's grain is how code rots: a domain that THROWS for expected outcomes forces every caller into try/catch (and TypeScript cannot tell you which calls can fail, or make you handle them), while a route layer that threads Result values through response code ends up hand-rendering errors in a dozen controllers — the exact per-route improvisation the next section kills. THE CONVERSION POINT is failureToException, called in exactly one place per controller: \`if (!result.ok) throw failureToException(result.error)\`. Every posts controller in this app is that line plus a return — look at the verbatim block below and notice the controllers are three lines each. THE PAYOFFS of keeping the border this thin: (1) domain code is framework-free — PostsUseCase has never heard of Express, which is why gRPC reuses it verbatim and the job queue reuses its Failure vocabulary; (2) the taxonomy lives in ONE file that both worlds share (a Failure kind knows its HTTP status, but the DOMAIN never mentions HTTP — the maps sit beside the type, and only the presentation edge reads them); (3) tests of the domain assert on RETURNED values, not on thrown ones — no toReject gymnastics for the boring paths. WHY NOT EVERYTHING THROWS (the Go question): yes, Go does errors-as-values everywhere with no exceptions at all, and you can run Node that way — the cost is that EVERY function in the chain becomes fallible plumbing, including the ones that genuinely cannot fail. This app draws the pragmatic line: EXPECTED failures (bad input, missing row, unavailable dependency, rate limit) are values, because callers have real decisions to make about them; UNEXPECTED failures (bugs, invariant violations) throw — nobody six layers up has a useful decision to make about a null dereference, and the stack unwinding that values forbid is exactly the information a bug report wants. The error middleware at the edge is where both kinds finally meet.`,
        },
        {
          kind: 'code',
          id: 'errors-two-worlds:verbatim-result',
          language: 'ts',
          caption: 'Verbatim — the domain half: failures as VALUES (core/result/result.ts)',
          source: 'server/src/core/result/result.ts',
          code: `import type { Failure } from '../error_handling/failures.js';

/**
 * The Result type used by every use case. Domain and data layers signal
 * failures as VALUES (never by throwing), so control flow stays explicit and
 * the presentation edge decides how failures map onto HTTP.
 */
export type Result<T, E extends Failure = Failure> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E extends Failure>(error: E): Result<never, E> {
  return { ok: false, error };
}`,
        },
        {
          kind: 'code',
          id: 'errors-two-worlds:verbatim-edge',
          language: 'ts',
          caption:
            'Verbatim — the edge half: every posts controller is this same conversion (presentation/controllers/posts_controllers.ts, dedented; makeExpressCallback relays the throw to the error middleware)',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `async list(_httpRequest: HttpRequest): Promise<HttpResponse> {
  const result = await listPosts();
  if (!result.ok) throw failureToException(result.error);  // ← the border
  return { status: 200, body: { posts: result.value } };
},

async detail(httpRequest: HttpRequest): Promise<HttpResponse> {
  const result = await getPost(httpRequest.params.id);
  if (!result.ok) throw failureToException(result.error);  // ← same line
  return { status: 200, body: result.value };
},

async create(httpRequest: HttpRequest): Promise<HttpResponse> {
  const result = await createPost(httpRequest.body);
  if (!result.ok) throw failureToException(result.error);  // ← same line
  return { status: 201, body: result.value };
}`,
        },
        {
          kind: 'code',
          id: 'errors-two-worlds:verbatim-conversion',
          language: 'ts',
          caption:
            'Verbatim — failureToException itself (core/error_handling/exceptions.ts): a table lookup, not a chain of ifs — the taxonomy IS the mapping',
          source: 'server/src/core/error_handling/exceptions.ts',
          code: `export function failureToException(source: Failure): AppException {
  return new EXCEPTION_BY_KIND[source.kind](source.message, source.details, source.cause);
}`,
        },
      ],
    },
    {
      id: 'errors-taxonomy',
      title: 'The taxonomy: eight kinds, one envelope',
      lead:
        'One discriminated Failure type, two maps, and every error the app produces — from a 400 on a bad email field to a 503 from a dead database — renders as the same envelope.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-taxonomy:one-table',
          body: `EIGHT KINDS COVER THE APP. validation (400) — the input was wrong, and details say which fields; unauthorized (401) — I do not know who you are; forbidden (403) — I know who you are, and no; not_found (404) — the thing you named does not exist (or you may not learn that it does — the authorization topic's 404-before-403); conflict (409) — the request collides with current state (duplicate id, stale version); rate_limited (429) — too much, too fast; unavailable (503) — a dependency is down, THIS is probably temporary, retry later; internal (500) — a bug, our fault, page a human. The pair of maps beside the kind list is the entire HTTP story: FAILURE_HTTP_STATUS and FAILURE_ERROR_CODE. The STATUS is for the browser/curl/monitor; the MACHINE CODE (validation_failed, service_unavailable…) is for the CLIENT PROGRAMMER — stable across refactors in a way prose messages never are, greppable in logs, switchable in client code. HTTP statuses alone are too coarse for that (what exactly does a bare 400 mean?) and prose messages alone are too fragile (you cannot version-control a client against English sentences). WHY ONE TAXONOMY END-TO-END instead of per-route freedom: a client that must handle YOUR errors cannot write \`if (code === 'validation_failed')\` if half your endpoints invent their own spellings; a monitor that alerts on 5xx ratios needs statuses to MEAN the same thing on every route; and the error middleware (next section) can only be fifteen lines long because it never has to guess — kind → status + code is a table lookup. This is also why the taxonomy file says "nothing else in the codebase invents status codes or error codes": the discipline is one map, consulted everywhere, and the linter-shaped pressure of having ONE obvious place makes drift visible. THE ENVELOPE every failure renders as: \`{ error: { code, message, requestId, …details } }\`. code and message you have met; requestId is the correlation id the request-id middleware stamped BEFORE anything could fail (the logging section makes it earn its keep); details is the failure's optional payload merged FLAT into the envelope — a validation failure carries \`fields: { title: 'must be a string' }\`, the rate limiter carries retry hints, and the canonical keys (code, message, requestId) win on collision, so a detail can never impersonate the envelope's spine.`,
        },
        {
          kind: 'code',
          id: 'errors-taxonomy:verbatim-maps',
          language: 'ts',
          caption: 'Verbatim — the whole taxonomy in one file (core/error_handling/failures.ts)',
          source: 'server/src/core/error_handling/failures.ts',
          code: `export const FAILURE_KINDS = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'unavailable',
  'internal',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface Failure {
  readonly kind: FailureKind;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export const FAILURE_HTTP_STATUS: Readonly<Record<FailureKind, number>> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export const FAILURE_ERROR_CODE: Readonly<Record<FailureKind, string>> = {
  validation: 'validation_failed',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  rate_limited: 'rate_limited',
  unavailable: 'service_unavailable',
  internal: 'internal_error',
};`,
        },
        {
          kind: 'code',
          id: 'errors-taxonomy:envelope-table',
          language: 'text',
          caption: 'The contract as a table — also served live by GET /api/demo/errors/taxonomy, sourced FROM the maps above',
          code: `kind           HTTP  machine code          typical source
─────────────  ────  ────────────────────  ─────────────────────────────────────────
validation     400   validation_failed      use-case input checks, body parsers
unauthorized   401   unauthorized           session/JWT/API-key guards
forbidden      403   forbidden              scope + ownership guards (authz topic)
not_found      404   not_found              unknown :id, AND the 404 catch-all
conflict       409   conflict               duplicate ids, stale versions
rate_limited   429   rate_limited           the limiter (security topic)
unavailable    503   service_unavailable    injected failures, redis/mongo down
internal       500   internal_error         bugs, invariant violations`,
        },
      ],
    },
    {
      id: 'errors-middleware',
      title: 'The error-handling middleware',
      lead:
        'Fifteen lines at the end of the chain that turn any thrown thing into the one envelope — registered LAST, because order is everything.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-middleware:signature-and-order',
          body: `THE FOUR-ARG SIGNATURE IS THE CONTRACT. Express identifies error-handling middleware by ARITY: \`(err, req, res, next)\` — four parameters, err first. Not a flag, not a registration call: the function's length decides whether Express treats it as the error destination or as ordinary middleware. TypeScript keeps the signature honest, and the price of a typo is severe in a specific quiet way: an error handler registered with THREE args silently becomes normal middleware that never runs on errors — your crashes fall through to Express's default HTML error page, which is how this bug ships to production unnoticed (it is invisible until the first real 500). REGISTERED LAST, AND THE ORDER IN app.ts IS LOAD-BEARING: request-id first (so even errors carry a correlation id — an error without a requestId is a log line nobody can correlate), then helmet, then body parsing, then routes, then the 404 catch-all, then errorHandler. Every middleware mounted BEFORE the handler can next(err) into it; anything mounted after it never gets the chance (Express stops at the FIRST error middleware that does not itself call next(err) — this handler never does, it always responds). WHAT IT DOES, IN ORDER: MAP (AppException → its failure's status + code; anything else → best-effort extraction), LOG (one structured line carrying the error, the status, and the requestId), ENVELOPE (the response body). THE APP-EXCEPTION BRANCH is the happy path: err.statusCode and err.code are getters over the taxonomy maps, so the middleware just trusts them and merges the failure's details flat — canonical keys winning, as the taxonomy section promised. THE FALLBACK BRANCH earns its keep at the edges Express controls, not you: a body-parser rejection (malformed JSON → 400) arrives as an http-errors-style object with statusCode but no Failure inside; a stray plain Error from some dependency arrives as just an Error. extractStatusCode reads statusCode THEN status (the http-errors convention and the older Node convention, in that order); extractCode keeps the error's own machine-readable code when it has a string one, else falls back to internal_error for 5xx and request_failed for 4xx; extractMessage keeps the message when there is a non-empty one and hides it behind "Internal server error" never — note the honesty trade-off: this app is a teaching app, so the fallback DOES surface err.message on 500s; a product facing the open internet would return a generic message to the client and keep the real one for the log, because exception messages leak stack-adjacent facts (file paths, SQL, library versions). Both branches were proven live by the demo routes: /api/demo/middleware/error-path throws a plain Error on purpose (async — see the next section) and renders 500 internal_error with its message kept; POST /api/posts with malformed JSON renders 400 request_failed through the same fallback.`,
        },
        {
          kind: 'code',
          id: 'errors-middleware:verbatim-handler',
          language: 'ts',
          caption: 'Verbatim — the whole handler (presentation/middleware/error_middleware.ts)',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `function extractStatusCode(err: unknown): number {
  if (typeof err === 'object' && err !== null) {
    const candidate = err as HttpErrorLike;
    if (typeof candidate.statusCode === 'number') return candidate.statusCode;
    if (typeof candidate.status === 'number') return candidate.status;
  }
  return 500;
}

function extractCode(err: unknown, statusCode: number): string {
  if (typeof err === 'object' && err !== null) {
    const candidate = err as HttpErrorLike;
    if (typeof candidate.code === 'string') return candidate.code;
  }
  return statusCode >= 500 ? 'internal_error' : 'request_failed';
}

function extractMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  return 'Internal server error';
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = extractRequestId(res);

  // An error arriving AFTER the response started (an SSE ticker flushed its
  // headers, a download rejected mid-file) cannot be rendered — res.status()
  // would itself throw ERR_HTTP_HEADERS_SENT and bury the original failure.
  // Delegate to Express's default handler, which ends the connection.
  if (res.headersSent) {
    logger.error(
      { err, requestId },
      'error after response started — delegating to express default handler',
    );
    return next(err);
  }

  if (err instanceof AppException) {
    const { failure } = err;
    // Level discipline (the observability topic's refinement): 4xx is the
    // CLIENT's problem — expected traffic noise, warn; 5xx is OURS — error.
    // Same rule the request-logger middleware applies to its access lines.
    const logLine = { err, statusCode: err.statusCode, requestId, failureKind: failure.kind };
    if (err.statusCode >= 500) logger.error(logLine, 'request failed');
    else logger.warn(logLine, 'request failed');
    // Details merge under the canonical keys; canonical keys win on collision.
    const errorBody: Record<string, unknown> = {
      ...(failure.details ?? {}),
      code: err.code,
      message: failure.message,
      requestId,
    };
    res.status(err.statusCode).json({ error: errorBody });
    return;
  }

  const statusCode = extractStatusCode(err);

  // Same 4xx/5xx level split as the AppException branch (body-parser's 400s
  // land here too — they are warn, not error).
  if (statusCode >= 500) logger.error({ err, statusCode, requestId }, 'unhandled request error');
  else logger.warn({ err, statusCode, requestId }, 'unhandled request error');

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
          id: 'errors-middleware:verbatim-order',
          language: 'ts',
          caption: 'Verbatim — the order that makes it work (src/app.ts, abridged)',
          source: 'server/src/app.ts',
          code: `app.use(requestIdMiddleware);      // 1. correlation id FIRST — errors carry it too
app.use(traceMiddleware);          // 2. trace ids ride beside it (observability topic)
app.use(requestLoggerMiddleware);  // 3. access lines need the id + the start stamp
app.use(
  helmet({
    /* … the pinned CSP audit — security topic … */
  }),
);                                 // 4. security headers on every response
app.use(webhookJsonBodyParser);    // 5. body parsing (its rejects land in the fallback branch)
app.use('/api', apiRouter);        // 6. routes
app.use(docsRouter);               //    (/docs, beside /api)

// 7. 404 catch-all — plain middleware (no wildcard path), so it behaves the
//    same across Express 4/5 wildcard-syntax differences.
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

// 8. Error-handling middleware must be registered last.
app.use(errorHandler);`,
        },
      ],
    },
    {
      id: 'errors-async',
      title: 'Async errors in Express 5',
      lead:
        'The most famous Express 4 footgun is gone: rejected promises from async handlers reach the error middleware on their own. What still needs your hands: callbacks Express never sees.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-async:express5',
          body: `THE EXPRESS 4 TRAP, for the record, because you will meet it in every codebase older than this one: middleware chains are synchronous plumbing — when a handler is an ASYNC function, it returns a PROMISE, and a rejected promise does not call next(err) by itself. The request hangs (no response, client times out), the rejection maybe prints to stderr as an unhandled rejection, and the beautiful error middleware you wrote never hears about it. The era's answer was the asyncHandler WRAPPER — \`const wrap = fn => (req,res,next) => fn(req,res,next).catch(next)\` — and whole libraries (express-async-errors, then express-async-handler) existed to patch this one seam. EXPRESS 5 (this app's major version) closes it: a rejected promise from a handler or middleware is caught and forwarded to the error pipeline automatically. Every async controller you have read in this guide relies on that — \`if (!result.ok) throw failureToException(result.error)\` inside an async function "just works", no wrapper, no .catch, and the error-path spec in the middleware topic proves the full chain end to end. If your search of a legacy Express 4 codebase finds the wrapper pattern, do not modernize the wrappers — bump the major and delete them. WHAT STILL NEEDS YOUR HANDS — Express can only forward rejections from things IT AWAITS. Code that runs OUTSIDE the request's async flow never reaches next(err) no matter the version: (1) EVENT-EMITTER CALLBACKS — a redis client's 'error' event, a socket's, a stream's — these have no request in scope at all; this app's rule (learned the hard way in the mongo topic, where a missing listener on the connection's 'error' event could KILL the process) is: every long-lived emitter gets an 'error' listener the day it is created, doing domain-appropriate triage; (2) setTimeout/setInterval CALLBACKS — a throw inside one is an uncaughtException, not a request error (the scheduler in the jobs topic wraps its tick in exactly that discipline); (3) FIRE-AND-FORGET PROMISES inside a handler — \`void notifyHooks()\` returns before the request ends; if you want the request to OWN that failure, await it (or do not start it — the jobs topic's whole argument); if you do not, it belongs to the process-level nets two sections down. For non-route async contexts (startup, schedulers), this app's guard is withGuards — verbatim below: AppExceptions rethrow untouched, anything unknown is wrapped in an InternalException with the cause PRESERVED, so even out-of-band failures arrive typed at whatever catches them.`,
        },
        {
          kind: 'code',
          id: 'errors-async:verbatim-guards',
          language: 'ts',
          caption:
            'Verbatim — the out-of-band guard (core/error_handling/guards.ts), for NON-route contexts only',
          source: 'server/src/core/error_handling/guards.ts',
          code: `/**
 * Wraps promise-returning work in NON-route contexts (startup, schedulers,
 * event handlers): AppExceptions rethrow untouched; anything unknown is
 * wrapped in an InternalException with the original error preserved as cause.
 * Express 5 route handlers do not need this — they forward rejected promises
 * to the error middleware automatically.
 */
export async function withGuards(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppException) throw err;
    throw new InternalException('unexpected internal error', undefined, err);
  }
}`,
        },
        {
          kind: 'code',
          id: 'errors-async:verbatim-exploding',
          language: 'ts',
          caption:
            'Verbatim — the live proof route (presentation/routes/middleware_demo_routes.ts). An async handler throwing a PLAIN Error (not an AppException): Express 5 forwards the rejection, the fallback branch extracts 500 / internal_error, and the message survives. Fire it in the demo below.',
          source: 'server/src/presentation/routes/middleware_demo_routes.ts',
          code: `/**
 * Async + throw: Express 5 forwards the rejected promise down the stack
 * looking for a 4-arg error middleware (Express 4 needed a wrapper for this).
 */
async function explodingHandler(_req: Request, res: Response): Promise<void> {
  pushStage(res, 4, 'handler');
  throw new Error('demo handler exploded on purpose');
}`,
        },
      ],
    },
    {
      id: 'errors-notfound',
      title: 'The 404 problem',
      lead:
        'A 404 is not an error — it is a routing decision. That distinction is why the catch-all is plain middleware, not a thrown exception.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-notfound:catch-all',
          body: `WHY THE ERROR HANDLER CANNOT DO IT: the error middleware only runs when something calls next(err) or throws — but a request that matches NO route throws nothing. It falls out the bottom of the middleware stack with every middleware having passed it along, and Express's DEFAULT behavior is its own HTML 404 page ("Cannot GET /nope") — not JSON, not your envelope, not your requestId. The fix is a CATCH-ALL mounted after every route and BEFORE the error handler: plain middleware (no path), which in Express runs for any request that reached that point unmatched. It renders the envelope BY HAND — code not_found, message built from req.method and req.originalUrl, requestId from res.locals — because at this point there is no Failure and no exception; the app is not failing, it is ANSWERING ("no such route, and here is everything we do have"). Express 5 note, visible in the app.ts comment: the catch-all deliberately uses NO wildcard path pattern. Express 5 changed the wildcard syntax (* → *splat, and bare * is an error at registration), and the routing topic documented the array-shaped surprises that came with it — a pathless app.use sidesteps the entire version dance, which is why it behaves identically in 4 and 5. THE CONCEPTUAL LINE this draws: 404-the-ROUTE-MISS is a routing fact the framework is best placed to state; 404-the-RESOURCE ("GET /api/posts/does-not-exist") is a DOMAIN outcome — the use case returns a not_found Failure, the controller converts it, and it flows through the error middleware like any other failure. Same status, two different origins, one envelope — and only one of them is an "error" in the pipeline sense. THE ADVANCED COUSIN is 405 Method Not Allowed: the path exists but the method does not (GET against the POST-only /api/graphql → 405 + Allow: POST is the one 405 this app serves). Express core does NOT do this for you — no route matched means no route matched, it cannot know you meant a sibling method — so a hand-rolled 405 means inspecting the router's own layer stack to see which methods WOULD have matched, which is why this app teaches 405 in prose (the routing topic) and ships only the catch-all: for an API of any size, the cheap 90% is the catch-all plus per-resource guards, and the full 405 matrix is a framework-level feature you buy (or write) once, not per-route.`,
        },
        {
          kind: 'code',
          id: 'errors-notfound:verbatim-catchall',
          language: 'ts',
          caption: 'Verbatim — the catch-all, in context (src/app.ts)',
          source: 'server/src/app.ts',
          code: `// 404 catch-all — plain middleware (no wildcard path), so it behaves the
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

// Error-handling middleware must be registered last.
app.use(errorHandler);`,
        },
        {
          kind: 'code',
          id: 'errors-notfound:verbatim-domain-404',
          language: 'ts',
          caption:
            'Verbatim — versus the DOMAIN 404, a resource that does not exist (presentation/controllers/posts_controllers.ts)',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `async detail(httpRequest: HttpRequest): Promise<HttpResponse> {
  const result = await getPost(httpRequest.params.id);
  if (!result.ok) throw failureToException(result.error); // not_found Failure → 404 envelope
  return { status: 200, body: result.value };
}`,
        },
      ],
    },
    {
      id: 'errors-injection',
      title: 'Failure injection: chaos engineering at toy scale',
      lead:
        'An error pipeline you have never watched fail is a hypothesis. This app can make any layer fail on demand — that is what the scenario toggles are FOR.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-injection:why',
          body: `THE DISCIPLINE: every failure mode this topic describes is one click away, all the time, in every environment — because the alternative is waiting for production to rehearse your error handling for you. The mechanism is the SCENARIO STORE (core/scenario — the same runtime toggles the data topics use to flip fake/live): a single boolean, injectFailure, readable by any layer through the container, flippable at runtime via PATCH /api/demo/scenario, seeded from SCENARIO_INJECT_FAILURE in the environment so a compose service can boot pre-broken. WHAT IT TOUCHES — one toggle, two demonstrations of the two worlds: DemoService.status() RETURNS \`fail(failure('unavailable', 'failure injection is ON'))\` — the VALUE path: the failure travels as data out of the domain, the controller converts it at the edge, and GET /api/demo/status answers 503 service_unavailable without a single throw anywhere; the posts pipeline consults the same flag inside its use cases, so EVERY /api/posts request (and its gRPC and GraphQL twins, which reuse the use cases) fails with the same envelope while the toggle is on. THE THROW PATH has its own dedicated endpoint: GET /api/demo/error?failure=<kind> builds the Failure for any of the eight kinds and THROWS failureToException of it — one endpoint that can produce the entire taxonomy table on demand. THAT BOTH PATHS END IN THE SAME ENVELOPE is the lesson the demo below is built to show: a returned unavailable and a thrown one are indistinguishable at the wire — same status, same code, same requestId field — because the conversion point (section 1) guarantees it. REAL CHAOS ENGINEERING scales this idea with blast radius and randomness (Chaos Monkey killing instances, toxiproxy corrupting latencies between services, fault-injection middlewares flipping a PERCENTAGE of requests); the toy version keeps it deterministic ON/OFF because the goal here is OBSERVABILITY of the pipeline, not statistical confidence in resilience — you are learning what your error handling DOES, one deliberate failure at a time, with the network tab open. READING THE ENVELOPE IN DEVTOOLS: open the console demo, fire a kind, then in the browser's network panel inspect the failed request — status and code in the summary line, the full envelope in the response tab, and the matching x-request-id RESPONSE header (request-id middleware) confirming the envelope's requestId is not decorative: grep the server log for that UUID and you have the exact log line for that exact response. The 4xx-vs-5xx reading discipline: 4xx envelopes tell the CLIENT programmer what they did (fix the request); 5xx envelopes tell YOU something broke (fix the app, and the requestId is your entry point).`,
        },
        {
          kind: 'code',
          id: 'errors-injection:verbatim-value-path',
          language: 'ts',
          caption:
            'Verbatim — THE VALUE PATH: the domain RETURNS the failure (domain/demo/demo_service.ts)',
          source: 'server/src/domain/demo/demo_service.ts',
          code: `async status(): Promise<Result<DemoStatus, Failure>> {
  const scenario = this.scenarioStore.get();
  if (scenario.injectFailure) {
    return fail(failure('unavailable', 'failure injection is ON'));
  }
  return ok({
    app: 'express_developers_guide',
    scenario,
    timestamp: new Date().toISOString(),
  });
}`,
        },
        {
          kind: 'code',
          id: 'errors-injection:verbatim-throw-path',
          language: 'ts',
          caption:
            'Verbatim — both edges, injectable (presentation/routes/demo_routes.ts): the controller converts the value path exactly like posts; the throw path is one endpoint that can produce all eight kinds. The toggle itself is runtime, validated, reversible: curl -X PATCH localhost:4000/api/demo/scenario -H \'content-type: application/json\' -d \'{"injectFailure":true}\'',
          source: 'server/src/presentation/routes/demo_routes.ts',
          code: `// …the controller converts the value path at the edge, exactly like posts:
async function statusController(_req: Request, res: Response): Promise<void> {
  const result = await getContainer().demoService.status();
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

// THE THROW PATH — one endpoint, all eight kinds:
async function failureDemoController(req: Request, _res: Response): Promise<void> {
  const kind = parseFailureKind(req.query.failure);   // unknown kind → 400 validation envelope
  throw failureToException(failure(kind, \`injected demo failure of kind "\${kind}"\`));
}`,
        },
        {
          kind: 'demo',
          id: 'errors-injection:explorer-demo',
          demoId: 'errors:explorer',
          title: 'The error explorer: every failure kind, injectable, on demand',
          description:
            'Real endpoints — the taxonomy table served from the actual failure maps, a TRY button per kind firing GET /api/demo/error, the failure-injection toggle flipping GET /api/demo/status between 200 and the 503 envelope (the Result path), and the fallback branch live: a thrown plain Error (500) and a body-parser 400. Every envelope renders with its requestId checked against the x-request-id header.',
        },
      ],
    },
    {
      id: 'errors-logging',
      title: 'What logs when things fail',
      lead:
        'One structured line per failure, keyed by the same requestId the client just received. The line IS the debugging workflow: envelope in hand, grep the id, read the story.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-logging:anatomy',
          body: `THE LINE. When a request fails, pino emits ONE structured line — \`logger.error({ err, statusCode, requestId, failureKind }, 'request failed')\` for AppExceptions (the fallback branch logs the same shape minus failureKind, message 'unhandled request error'). Read it as a sentence: err is the error SERIALIZED by pino (message and stack for Errors; the object itself for the AppException, which is why the failure kind and its details ride along), statusCode is what the client actually received, requestId is the correlation key, failureKind is the taxonomy discriminant — the field your log query groups by when you ask "are we suddenly throwing more validation failures than usual?". In development the logger routes through pino-pretty for human eyes; staging and production log the same facts as JSON for machines — same line, two dialects. THE CORRELATION TRIANGLE is the whole design: the SAME UUID appears (1) in the response envelope's requestId field — the client has it, support tickets quote it; (2) in the x-request-id response HEADER — middleware tooling and API gateways log headers without parsing bodies; (3) in the server's log line — \`grep <uuid>\` over the logs finds the failure AND every request-scoped line before it (when the observability topic adds request logging, the same id ties them together). It works only because the request-id middleware is mounted FIRST — before helmet, before parsing, before anything that could fail — and stores the id on res.locals, where the error middleware reads it back out at the far end of the chain. SEVERITY, BY FAULT: the middleware logs 4xx failures at WARN and 5xx at ERROR — a client sending garbage (400) is expected traffic noise, a database dying (503) is ours — so a log-based ALERT can key on level and 4xx chatter never drowns the 5xx signal at 3am. (This level discipline was the observability topic's refinement and has landed in the code — same rule the request-logger applies to its access lines; failureKind and statusCode in the line carry the finer distinction.) Same honesty note the security topic made about pino redaction: none is configured — the discipline this app actually uses is masking secrets AT SOURCE (tokens are masked before they ever reach a Failure), which the auth topics show in practice.`,
        },
        {
          kind: 'code',
          id: 'errors-logging:verbatim-request-id',
          language: 'ts',
          caption:
            'Verbatim — the id stamped first (presentation/middleware/request_id_middleware.ts, mounted FIRST)',
          source: 'server/src/presentation/middleware/request_id_middleware.ts',
          code: `export function requestIdMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  // …requestStartedAt stamped here too — the perf topic's self-timing clock…
  res.setHeader('x-request-id', requestId);
  next();
}`,
        },
        {
          kind: 'code',
          id: 'errors-logging:verbatim-error-branch',
          language: 'ts',
          caption:
            'Verbatim — the line emitted last (presentation/middleware/error_middleware.ts), level split by fault: 4xx warn, 5xx error',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `if (err instanceof AppException) {
  const { failure } = err;
  // Level discipline (the observability topic's refinement): 4xx is the
  // CLIENT's problem — expected traffic noise, warn; 5xx is OURS — error.
  const logLine = { err, statusCode: err.statusCode, requestId, failureKind: failure.kind };
  if (err.statusCode >= 500) logger.error(logLine, 'request failed');
  else logger.warn(logLine, 'request failed');
  // …then the envelope, carrying the SAME requestId:
  const errorBody: Record<string, unknown> = {
    ...(failure.details ?? {}),
    code: err.code,
    message: failure.message,
    requestId,
  };
  res.status(err.statusCode).json({ error: errorBody });
  return;
}`,
        },
        {
          kind: 'code',
          id: 'errors-logging:verbatim-dialects',
          language: 'ts',
          caption:
            "Verbatim — the two dialects (core/logging/logger.ts): dev gets pino-pretty, prod gets raw JSON — and EVERY environment tee's into the in-memory ring the observability demo renders",
          source: 'server/src/core/logging/logger.ts',
          code: `export const logger =
  appConfig.nodeEnv === 'development'
    ? pino(
        { level: appConfig.logLevel },
        pino.multistream([
          {
            stream: nodeRequire('pino-pretty')({
              // …colorize / translateTime / ignore options…
            }),
            level: appConfig.logLevel,
          },
          { stream: ringDestination, level: appConfig.logLevel },
        ]),
      )
    : pino(
        { level: appConfig.logLevel },
        pino.multistream([
          { stream: process.stdout, level: appConfig.logLevel },
          { stream: ringDestination, level: appConfig.logLevel },
        ]),
      );`,
        },
      ],
    },
    {
      id: 'errors-process',
      title: 'Process-level safety nets',
      lead:
        'Below the error middleware there is nothing but the process — and this app deliberately lets the process die. Fail fast, restart clean, shut down gracefully.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-process:nets',
          body: `THE HONEST STATE FIRST: server.ts registers exactly FOUR process.on calls — SIGINT and SIGTERM (the graceful drain below), plus uncaughtException and unhandledRejection handlers that LOG FATAL AND EXIT DELIBERATELY (landed by the observability task after this topic first documented their absence as a deferral). That shape is a DECISION, and it is worth understanding because the tempting "add handlers so the process never crashes" reflex is usually wrong. WHAT DEFAULTS DO TODAY: an uncaughtException (a throw no try/catch caught — the setTimeout callback from the async section, an emitter 'error' with no listener) crashes the process, after Node emits the event; since Node 15 an unhandledRejection does the same (before 15 it only warned — the era of silently leaked rejections). CRASHING IS OFTEN CORRECT because a process that survived an uncaught exception is in an UNKNOWN state: the throw interrupted SOMETHING — maybe mid-write, maybe between two mutations — and any invariants that code was maintaining are now suspect. Continuing to serve on top of a corrupted state converts one failure into many, silently. The correct architecture is fail fast + SUPERVISION: the process dies, the process MANAGER (Docker's restart policy, Kubernetes, pm2 — the deployment topic's whole subject) restarts it in a clean state in seconds, and your log pipeline (the line the crash produced) is how you learn why. WHAT HANDLERS ARE ACTUALLY FOR: a registered uncaughtException handler PREVENTS the crash — which means if you register one, you have taken responsibility for the unknown state. The defensible middle most production apps adopt is a handler that LOGS the failure properly and then EXITS DELIBERATELY (process.exit(1), letting the supervisor restart) — you get clean logs for the crash instead of the default's stack dump, without the pretense of continuing. This app ships exactly that middle (see the handlers below the drain): log FATAL with everything known, give stdout a 100ms beat to flush, exit non-zero, and let the supervisor start a CLEAN process. THE ONE NET THAT IS FULLY BUILT is GRACEFUL SHUTDOWN: SIGINT/SIGTERM (Ctrl-C, docker stop, k8s rolling deploy) trigger a drain that closes, in order, the gRPC listener, the optional mongo connection, BOTH redis connections (commands + subscriber — the redis topic explains why two), the websocket hub (its sockets would otherwise hold server.close() open), and finally the HTTP server — each step's failure swallowed on purpose so the chain still reaches server.close(), with a 10-second force-exit timer (unref'd) because server.close() waits on keep-alive connections that may never go quiet. That is the failure-story for the process ENDING on purpose; uncaught crashes end it immediately, and the supervisor's restart is the recovery. The reliability topic adds the last leg — health checks so the supervisor KNOWS when to restart.`,
        },
        {
          kind: 'code',
          id: 'errors-process:verbatim-shutdown',
          language: 'ts',
          caption:
            'Verbatim — the graceful drain and the process-level nets (src/server.ts — all four process.on calls)',
          source: 'server/src/server.ts',
          code: `/** Graceful shutdown: stop accepting connections, finish in-flight work, exit. */
function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down gracefully');
  // Stop the gRPC listener first (it only fronts the same use cases), then
  // drain the optional mongo connection, then BOTH redis connections (the
  // commands client and the pub/sub subscriber — a no-op each when never
  // opened), then close the chat hub (its websockets would otherwise hold
  // server.close() open until the force-exit timer), then close HTTP — a
  // failure on any path still reaches server.close().
  void grpcServerPromise
    .then((handle) => handle?.stop())
    .catch(() => undefined)
    .finally(() => {
      void closeMongoConnection()
        .catch(() => undefined)
        .finally(() => {
          void closeRedis()
            .catch(() => undefined)
            .finally(() => {
              void chatHub
                .close()
                .catch(() => undefined)
                .finally(() => {
                  server.close(() => {
                    logger.info('http server closed');
                    process.exit(0);
                  });
                });
            });
        });
    });
  // Safety net: server.close() waits on keep-alive connections; don't hang forever.
  const forceExitTimer = setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Process-level safety nets — the LAST line of defense (the exception-handling
// topic documented their absence as a deliberate deferral; this is the
// observability task landing them). An exception that unwinds past every
// handler, or a rejected promise nobody awaited, means the process's state is
// SUSPECT: locks may be held, invariants may be half-applied, memory may be
// leaking. The honest move is NOT "log it and keep running" — a corrupted
// process serving traffic is worse than a gap in traffic — it is: log FATAL
// with everything we know, then exit non-zero and let the supervisor (Docker
// restart policy, compose, pm2, Kubernetes — the deployment topic's cast)
// start a CLEAN process. The 100ms grace gives the stdout pipe a beat to
// flush the fatal line before the exit truncates it.
process.on('uncaughtException', (err: Error) => {
  logger.fatal({ err }, 'uncaught exception — exiting so the supervisor restarts a clean process');
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal(
    { err: reason },
    'unhandled promise rejection — exiting so the supervisor restarts a clean process',
  );
  setTimeout(() => process.exit(1), 100);
});`,
        },
      ],
    },
    {
      id: 'errors-live',
      title: 'The failure explorer from a terminal',
      lead:
        'The real pipeline over curl: fire every kind in the taxonomy, flip the injection toggle, and compare the two worlds — plus the fallback branch — all answered as envelopes.',
      blocks: [
        {
          kind: 'text',
          id: 'errors-live:intro',
          body: `THE EXPLORER panel lives in the Failure injection section above; this tour runs the same three stops from a terminal. THE TAXONOMY TABLE is served by GET /api/demo/errors/taxonomy — which does not restate the table but assembles it FROM the failure maps themselves, so the rows you fire can never drift from the code that enforces them; each kind answers GET /api/demo/error?failure=<kind> with the result: status, the envelope with code, message and requestId, and the match confirming the envelope's requestId equals the x-request-id response header — the correlation triangle in miniature. THE INJECTION STOP is the two-worlds lesson as curls: the scenario endpoint shows the live toggle state; flip injectFailure (PATCH /api/demo/scenario), call GET /api/demo/status, and watch the VALUE path answer the 503 service_unavailable envelope — then fire any taxonomy kind and compare: the THROW path's envelope is byte-for-byte the same shape. Same pipeline, two doors. THE FALLBACK STOP exercises the branch the taxonomy never produces: a plain Error thrown by the middleware topic's error-path route (async throw → Express 5 forwarding → 500 internal_error with the message kept), and a malformed-JSON POST to /api/posts (body-parser reject → the generic extraction → 400 request_failed — an http-errors-style error with NO Failure inside, mapped by convention). Every result carries its requestId; copy one into the server's log stream and you are doing the real debugging workflow. The curl block below runs the identical tour.`,
        },
        {
          kind: 'code',
          id: 'errors-live:curl',
          language: 'bash',
          caption: 'The whole pipeline from a terminal — taxonomy, both worlds, the fallback, correlation',
          code: `# 1. The taxonomy as data — assembled FROM the failure maps, never restated:
curl -s localhost:4000/api/demo/errors/taxonomy | jq '.kinds'

# 2. The throw path: any kind on demand; note the requestId + matching header:
curl -si 'localhost:4000/api/demo/error?failure=validation' | grep -Ei 'x-request-id|^HTTP'
curl -s 'localhost:4000/api/demo/error?failure=unavailable' | jq .error

# 3. An unknown kind → the validation envelope WITH merged details (validValues):
curl -s 'localhost:4000/api/demo/error?failure=bogus' | jq .error

# 4. The value path: flip the toggle, watch /status become the SAME envelope shape:
curl -s -X PATCH localhost:4000/api/demo/scenario \\
  -H 'content-type: application/json' -d '{"injectFailure":true}' | jq
curl -si localhost:4000/api/demo/status | grep -Ei 'x-request-id|^HTTP'
curl -s localhost:4000/api/demo/status | jq .error

# 5. …and the posts pipeline fails the same way while the toggle is on:
curl -s localhost:4000/api/posts | jq '.error.code, .error.requestId'

# 6. The fallback branch, part 1 — a plain Error (no Failure inside) → 500:
curl -s localhost:4000/api/demo/middleware/error-path | jq .error

# 7. The fallback branch, part 2 — body-parser reject → 400 request_failed:
curl -s -X POST localhost:4000/api/posts \\
  -H 'content-type: application/json' -d '{"title": ' | jq .error

# 8. The route-miss 404 (the catch-all, not the error middleware):
curl -s localhost:4000/api/no/such/route | jq .error

# 9. Put it back — the envelope becomes the status payload again:
curl -s -X PATCH localhost:4000/api/demo/scenario \\
  -H 'content-type: application/json' -d '{"injectFailure":false}' | jq`,
        },
      ],
    },
  ],
};
