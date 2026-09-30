import type { Topic } from '../types.js';

/**
 * The request/response topic: the two objects every handler receives.
 * Concept-first (a request is a readable stream, a response is a writable
 * one — everything else is a convenience built over those), then the Express
 * req/res surface: the parsed request view, body parsing, the response method
 * families, status codes and this repo's error envelope, streaming with real
 * backpressure handling, content negotiation, cookies and redirects.
 * Snippets from this repo are marked verbatim; illustrative sketches say so
 * in their captions.
 */
export const topicRequestResponse: Topic = {
  id: 'request-response',
  title: 'Request and Response Handling',
  subtitle:
    'The full req/res reference: payloads, streaming, and content negotiation.',
  group: 'middleware-request',
  order: 3,
  sections: [
    {
      id: 'reqres-request',
      title: 'The request object',
      lead: 'req is a readable stream wearing a parsed view. The stream is the truth; the view — params, query, headers, body — is what middleware has managed to make of it so far.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-request:two-views',
          body: `Concept first, framework-free: what arrives at your server is not an object — it is a sequence of bytes on a socket, framed by an HTTP request line and headers. Node exposes that as a readable stream (IncomingMessage): you can read it chunk by chunk, or you can let someone else read it for you and hand you the result. Express's req is that stream plus a parsed view built on top: req.method and req.originalUrl from the request line, req.headers as a lowercased map, req.params and req.query filled in by the router, req.body — famously — filled in only by a body-parsing middleware that matched the request's content-type. That last caveat is the number-one Express 5 surprise: with only express.json() mounted (this app's exact setup), a POST with Content-Type: text/plain arrives with req.body UNDEFINED — not {}, undefined. The bytes are still there, unconsumed, in the stream; no parser claimed them.\n\nThe parsed view has convenience accessors worth knowing by name: req.get('X-Custom') (case-insensitive header read), req.protocol and req.secure (http vs https), req.ip (the socket's remote address — which behind a reverse proxy is the PROXY's address, not the client's, unless you opt in with app.set('trust proxy', ...) so Express honors X-Forwarded-For; this app deliberately does not set it, so req.ip stays honest about what it is), and req.accepts() for negotiation (next sections). The inspector demo below exercises the whole surface: fire it with different methods, paths, query strings, and content types, and watch the parsed view change while the stream underneath stays the same bytes.`,
        },
        {
          kind: 'code',
          id: 'reqres-request:parsed-view',
          language: 'ts',
          caption:
            'The parsed view in use — verbatim posts_controllers.ts (dedented): thin controllers reading params and body (via the httpRequest DTO makeExpressCallback builds from req). The inspect endpoint\u2019s rawest read of the same view, from http_demo_routes.ts, quoted in the comments',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `// a thin controller reads the view, never the stream (dedented — the
// DTO's params/body are req's, copied through by the adapter; the commas are
// real: these methods live inside the frozen controllers object):
async detail(httpRequest: HttpRequest): Promise<HttpResponse> {
  const result = await getPost(httpRequest.params.id); // from the PATH
  if (!result.ok) throw failureToException(result.error);
  return { status: 200, body: result.value };
},
async create(httpRequest: HttpRequest): Promise<HttpResponse> {
  const result = await createPost(httpRequest.body);   // from a PARSER
  if (!result.ok) throw failureToException(result.error);
  return { status: 201, body: result.value };
},

// the inspect endpoint reads the view at its rawest (http_demo_routes.ts —
// every expression as written there, verbatim):
//   const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';
//   res.status(200).json({
//     method: req.method,                    // request line, verbatim verb
//     path: req.originalUrl.split('?')[0],  // as the CLIENT wrote it (req.path is mount-relative)
//     query: { ...req.query } as Record<string, unknown>, // strings (and arrays) — never numbers
//     headers,                               // Node lowercases every name; we sort for a stable read
//   });`,
        },
        {
          kind: 'text',
          id: 'reqres-request:defaults-are-strings',
          body: `Two habits prevent most req-view bugs. First: everything parsed from the wire arrives as a string (or array of strings) until YOU convert it. ?limit=5 gives you '5'; the routing topic's search handler converts and bounds it explicitly, and rejects garbage — because Number('abc') is NaN, and NaN limits have a way of reaching SQL. Second: distinguish "absent" from "empty". req.query.limit is undefined when the key is missing but '' when the client sent ?limit= — different intents (client omitted it vs client explicitly cleared it) that often deserve different handling, and the body-parser analogue is the undefined-vs-{} gotcha above. The view is a convenience; treat its edge cases as contract, not accident.`,
        },
        {
          kind: 'demo',
          id: 'reqres-request:inspector-demo',
          demoId: 'reqres:inspector',
          title: 'The request inspector',
          description:
            'Fire any method at /api/demo/reqres/inspect with a path, query, and content type of your choosing: the reflected view shows the request line, the parsed query, the header map (x- headers and the correlation id highlighted), and the body as the server actually got it — parsed when a parser matched, raw from the stream when nothing did.',
        },
      ],
    },
    {
      id: 'reqres-body',
      title: 'Reading the body',
      lead: 'Bodies do not parse themselves. Express ships one parser by default and a family of siblings; whatever none of them claims stays raw in the stream — and the stream is yours to read.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-body:parsers',
          body: `This app mounts exactly one parser, app-wide, before any route (order is load-bearing — a parser mounted after the handlers hands them an empty req.body): express.json() claims requests whose Content-Type is application/json and replaces the stream's contents with the parsed value on req.body. Its siblings exist for the other content types: express.urlencoded({ extended: false }) for HTML form posts (application/x-www-form-urlencoded — the default of every <form> in the browser; extended: false uses the querystring-style parser, which is what you want unless you deliberately need qs nested keys), express.text() for text/* into req.body as a string, express.raw() for everything else into a Buffer. Each one, like every built-in, calls next() whether it matched or not — which is precisely why an unmatched content-type leaves req.body undefined and the bytes unconsumed. Pick parsers by what your API actually accepts, mount them at the narrowest scope that covers it, and let the unmatched content-types fail visibly (a 400 from the controller that expected JSON) rather than silently.\n\nSize limits are part of parsing, not an afterthought: every body parser takes a limit option (express.json() defaults to 100kb), and a body that exceeds it fails with a 413 before your handler ever runs — through the normal error pipeline, envelope and all. Never mount an unbounded parser on a public route.`,
        },
        {
          kind: 'code',
          id: 'reqres-body:parser-mounts',
          language: 'ts',
          caption:
            'server/src/presentation/routes/webhooks_demo_routes.ts — verbatim: the parser this app REALLY mounts at its root (its 100kb limit pinned explicitly; the sibling family, not mounted here, in the comments)',
          source: 'server/src/presentation/routes/webhooks_demo_routes.ts',
          code: `// this app is a JSON API, so ONE parser at the root (app.ts mounts this —
// it is express.json() with the webhooks topic's raw-body verify hook):
export const webhookJsonBodyParser = json({
  limit: '100kb',   // PINNED at the default — the budget is written down, not inherited
  verify: (req, _res, buf) => {
    const request = req as typeof req & { rawBody?: Buffer; originalUrl?: string };
    const path = (request.originalUrl ?? '').split('?')[0];
    if (request.method === 'POST' && path === WEBHOOK_RECEIVE_PATH) {
      request.rawBody = buf;   // the EXACT bytes — never reconstruct them
    }
  },
});

// the rest of the family, each with an explicit limit (defaults are 100kb) —
// mount only what your API accepts:
//   app.use(express.urlencoded({ extended: false, limit: '56kb' })); // form posts → req.body object
//   app.use(express.text({ type: 'text/plain', limit: '32kb' }));   // text/plain → req.body string
//   app.use(express.raw({ type: 'application/octet-stream', limit: '1mb' })); // → req.body Buffer
// a body over the limit never reaches a handler — the parser fails with 413
// through the error pipeline, canonical envelope included.`,
        },
        {
          kind: 'text',
          id: 'reqres-body:streaming-a-request',
          body: `When no parser matches — or the body is legitimately huge (an upload, a CSV import) — you read the request the way Node meant: as an async iterable of Buffers. That is what this topic's inspector endpoint does for the text/plain case: since express.json() declined the content-type, the handler consumes the stream itself, caps what it keeps, and reports the raw string alongside the parsed view so you can SEE which path the body took. The same shape (accumulate chunks, enforce a cap yourself, decode once at the end) is the honest foundation for any streaming upload pipeline — the Files & Media topic builds the production version with multer. One rule makes it safe: if you respond before consuming the whole request, destroy or drain the stream first, or the socket may be reset out from under the response.`,
        },
        {
          kind: 'code',
          id: 'reqres-body:stream-read',
          language: 'ts',
          caption:
            'server/src/presentation/routes/reqres_demo_routes.ts — verbatim from the inspector handler: reading the body the parser did not want (cap + truncation flag exactly as shipped)',
          source: 'server/src/presentation/routes/reqres_demo_routes.ts',
          code: `// express.json() did not match this content-type → req.body is undefined
// and the bytes are still ours to consume from the stream:
const chunks: Buffer[] = [];
let keptBytes = 0;
let sawMore = false;
for await (const chunk of req) {          // IncomingMessage is an async iterable
  if (keptBytes >= BODY_RAW_CAP) {        // past the cap…
    sawMore = true;
    continue;                             // …but keep consuming to the end (socket hygiene)
  }
  const room = BODY_RAW_CAP - keptBytes;
  const slice = chunk.subarray(0, room);  // partial chunk → keep only what fits
  chunks.push(Buffer.from(slice));
  keptBytes += slice.length;
  if (slice.length < chunk.length) sawMore = true;
}
const raw = Buffer.concat(chunks).toString('utf8');
if (raw !== '') {
  bodyRaw = raw.slice(0, BODY_RAW_CAP);   // absent vs empty, still distinguished
  bodyRawTruncated = sawMore;
}`,
        },
      ],
    },
    {
      id: 'reqres-response',
      title: 'The response object',
      lead: 'res is a writable stream wearing a method library: eight families of convenience covering everything from a JSON reply to a file download. All of them funnel into the same rule — you get exactly ONE response.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-response:families',
          body: `The response is where Express earns its ergonomics. Underneath, res is Node's ServerResponse — a writable stream you could push bytes into directly — and every convenience method is a wrapper over "set headers, write body, end". The families worth memorizing: payload methods (res.send for strings/buffers with content-type sniffing, res.json for objects with JSON serialization, res.jsonp for the callback-wrapped legacy variant); header methods (res.set to write one or many, res.append to add without overwriting, res.type to set Content-Type shorthand, res.attachment to mark a download); control methods (res.status to set the status code — chainable, which is why res.status(201).json(...) reads as a sentence — and res.redirect for the 3xx family); cookie methods (res.cookie / res.clearCookie, next section); file methods (res.sendFile streams a file from disk with the right content-type and range handling, res.download does the same plus Content-Disposition: attachment — the Files & Media topic uses them for real); and the raw streaming methods (res.write / res.end) for when the body is being produced incrementally. This app touches exactly three of these across its whole edge — res.json, res.status (both live in the single makeExpressCallback adapter line every controller funnels through), and the occasional res.set in middleware — which is itself the lesson: a JSON API needs very little of the library, but you should know what the rest is for.\n\nThe rule that binds them all: one request, one response. The moment any payload method runs — send, json, sendFile, even redirect — the status and headers are frozen and the body starts leaving; every later attempt to set headers fails with the canonical error "Err HTTPHeadersSent: Cannot set headers after they are sent to the client" (inspect res.headersSent if you must ask). The failure mode it guards against is a handler that answers AND calls next(): the request falls through to another handler that tries to answer again. That is why the middleware topic's exit discipline exists — respond OR call next(), never both.`,
        },
        {
          kind: 'code',
          id: 'reqres-response:methods-table',
          language: 'txt',
          caption: 'The response method families — and what each is FOR',
          code: `family      methods                          use it for
----------  -------------------------------  ----------------------------------------
payload     res.send / res.json / res.jsonp  one-shot bodies (send sniffs type, json serializes)
headers     res.set / res.append / res.type  metadata BEFORE the first byte (append keeps existing)
status      res.status(code)                 the status line; chainable: res.status(201).json(x)
redirect    res.redirect(code, url)          3xx + Location (301/302 rewrite methods; 307/308 don\u2019t)
cookies     res.cookie / res.clearCookie     Set-Cookie with options (httpOnly, sameSite, maxAge)
files       res.sendFile / res.download      stream a file / stream it AS a download
stream      res.write / res.end              incremental bodies — you own the framing
ending      res.end()                        terminate with no body (204, HEAD, drain the socket)`,
        },
        {
          kind: 'code',
          id: 'reqres-response:one-response',
          language: 'ts',
          caption:
            'This repo\u2019s whole response vocabulary, verbatim from make_express_callback.ts — the one line every posts controller\u2019s { status, body } funnels through. The bug the ONE-response rule exists to prevent, illustrative, in the comments',
          source: 'server/src/presentation/routes/make_express_callback.ts',
          code: `// ONE line carries this entire API's responses (verbatim) — controllers
// return { status, body } and this adapter is the only place res is touched
// on the way out:
res.status(httpResponse.status).json(httpResponse.body); // status chains INTO the payload method

// the classic double-answer (illustrative — this is the bug, do not copy it):
//   app.get('/posts', (req, res, next) => {
//     res.json({ posts: [] });        // answer #1 — headers sent, body starts leaving
//     next();                         // …and control keeps flowing: WRONG
//   });
// the next matching route (or the 404 catch-all) tries to answer again:
//   → Err HTTPHeadersSent: Cannot set headers after they are sent to the client
//
// checking is possible but is a code smell — fix the control flow instead:
//   if (res.headersSent) { … }`,
        },
        {
          kind: 'demo',
          id: 'reqres-response:methods-demo',
          demoId: 'reqres:methods',
          title: 'The response-methods playground',
          description:
            'Make the server answer with one of seven response families — json, text, a chosen status code, a 307 redirect, a security-attribute cookie, a chunked ndjson stream, an attachment — and read what comes back: the status line, the headers that family sets, the body, and the verdict naming the method that produced it.',
        },
      ],
    },
    {
      id: 'reqres-status',
      title: 'Status codes and the error envelope',
      lead: 'The status line is your API contract\u2019s first word. Choose it deliberately, and let exactly one place render failures — here, the global error middleware and its canonical envelope.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-status:choosing',
          body: `A status code is a machine-readable summary of what happened, and clients branch on it before they ever parse your body. The working set for an API is smaller than the registry: 200 OK for success with a body, 201 Created when the request made a new resource (this repo's POST /api/posts answers 201), 204 No Content for success with deliberately nothing to say (a DELETE — note res.status(204).end() sends NO body; a body on a 204 is a protocol violation); among client errors, 400 for malformed input, 401 for unauthenticated, 403 for unauthorized, 404 for absent (this app's catch-all renders it for any unrouted path), 409 for conflicts (duplicate key, stale version), 413 for oversized bodies, and 418 when the kettle is short and stout; 500 for the server's own failures and 503 for "deliberately unavailable right now". Two disciplines: never answer errors with 200 and an error body (clients that only check res.ok will misread you), and keep the mapping in one place — which is what this repo's error pipeline does. Handlers throw typed exceptions; the global error middleware decides the status; nobody else renders failures. The result is that every failure this app produces, from a bad query parameter to an injected crash, arrives in the same envelope: { error: { code, message, requestId } }.`,
        },
        {
          kind: 'code',
          id: 'reqres-status:envelope-verbatim',
          language: 'ts',
          caption: 'server/src/presentation/middleware/error_middleware.ts — condensed to the envelope logic (logging elided, annotations added): the one renderer of the error envelope',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `export function errorHandler(
  err: unknown,                  // the 4-arg shape is the recognition — and ANYTHING can arrive here
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = extractRequestId(res);

  // …headersSent guard elided: once streaming began, no envelope is possible —
  // the handler logs and delegates via next(err) instead…

  if (err instanceof AppException) {
    const { failure } = err;                  // typed exceptions carry the status INSIDE them
    const errorBody: Record<string, unknown> = {
      ...(failure.details ?? {}),             // details merge under the canonical keys…
      code: err.code,                         // …which win on collision
      message: failure.message,
      requestId,                              // correlation: the same id rides x-request-id
    };
    res.status(err.statusCode).json({ error: errorBody });   // status chains into the payload
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
          kind: 'text',
          id: 'reqres-status:happy-vs-error',
          body: `The division of labor is worth stating precisely because it generalizes: happy-path responses belong to the handler that earned them (res.json / res.status(201).json / res.type('text/plain').send — the response-methods demo above fires one real example of each family), and failure responses belong to the error pipeline alone. A handler's job on failure is to THROW something typed — ValidationException, NotFoundException, or an AppException carrying a status — and let the middleware translate. Note the boundary the demo's status mode deliberately draws: it uses res.status(4xx).json(...) to SHOW you a status line, with an ordinary body — a chosen status is not a failure, so it never touches the error pipeline. The moment a request actually FAILS — an unknown mode, a status outside the safe list — the same endpoint stops answering itself and throws a ValidationException, and the envelope arrives from the one place that renders it.`,
        },
      ],
    },
    {
      id: 'reqres-streaming',
      title: 'Streaming responses',
      lead: 'A body does not have to exist before it starts leaving. When the first byte is ready before the last one, res.write the chunks as they come — and honor backpressure, or become the outage you read about later.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-streaming:when',
          body: `res.send builds the entire body in memory, then hands it to the socket with Content-Length set — perfect for payloads that already exist (every JSON reply in this app). Streaming is for the other case: the body is being PRODUCED while the response is already leaving — a database cursor, a file transform, telemetry as it is sampled, an LLM emitting tokens. Set every header first (they lock at the first write — the ONE-response rule again), then res.write chunks and res.end when finished; without a known length, Node frames the body with Transfer-Encoding: chunked, and the client's fetch resolves only when the terminating chunk arrives. The Node.js topic's streaming demo does exactly this — identical telemetry two ways, buffered (Content-Length set after the whole body exists) versus streamed line by line — and proves the bytes arrive identical; only the delivery strategy differs.`,
        },
        {
          kind: 'code',
          id: 'reqres-streaming:verbatim',
          language: 'ts',
          caption: 'server/src/presentation/routes/node_demo_routes.ts — verbatim: the buffered/stream fork from the node topic\u2019s demo',
          source: 'server/src/presentation/routes/node_demo_routes.ts',
          code: `if (mode === 'buffered') {
  res.send(lines.join(''));         // whole body built first → Content-Length set
  return;
}

// Stream: one line per write, a deliberate setImmediate pause between writes
// so the incremental delivery is observable. (A real endpoint with large
// chunks would also honor write() returning false — backpressure — but
// 1000 × ~100 bytes never approaches the socket\u2019s high-water mark.)
let index = 0;
const writeNext = (): void => {
  if (index >= lines.length) {
    res.end();
    return;
  }
  res.write(lines[index]);
  index += 1;
  setImmediate(writeNext);
};
writeNext();`,
        },
        {
          kind: 'text',
          id: 'reqres-streaming:backpressure',
          body: `That parenthetical is the entire next lesson, so say it plainly: the demo deliberately skips backpressure because its chunks are tiny. res.write returns FALSE when the socket's buffer is full — the client (or the network between you) is consuming slower than you are producing. Write anyway and your data piles up in the server's memory: a slow mobile client on a large payload means one connection quietly holding megabytes, and a thousand of them means an outage with no interesting stack trace. The CORRECT pattern is to treat write() returning false as a pause signal: stop writing and resume on the stream's 'drain' event, which fires when the buffer empties. This topic's response-methods demo streams five ndjson lines the simple way (small enough to be safe, same trade-off as the node demo, and the demo copy says so) — here is the real thing to copy when chunks are not tiny:`,
        },
        {
          kind: 'code',
          id: 'reqres-streaming:backpressure-pattern',
          language: 'ts',
          caption:
            'server/src/presentation/routes/files_demo_routes.ts — verbatim: the backpressure-honoring write loop this repo really runs (the files topic\'s pipeline-demo endpoint; its unit test drives it with a fake sink that returns false)',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          code: `export async function writeLinesWithBackpressure(
  sink: BackpressureSink,
  lines: readonly string[],
): Promise<{ drainEvents: number; pausedMs: number }> {
  let drainEvents = 0;
  let pausedMs = 0;
  for (const line of lines) {
    if (sink.write(line)) continue; // buffer has room — keep producing
    drainEvents += 1;
    const pausedAt = performance.now();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      sink.once('drain', finish);
      sink.once('close', finish); // client went away — stop waiting
    });
    pausedMs += performance.now() - pausedAt;
  }
  return { drainEvents, pausedMs: Math.round(pausedMs * 10) / 10 };
}
// res is a valid BackpressureSink: write() returns false when the socket's
// buffer is full, and 'drain' fires when the client catches up — produce on
// demand, pause when the socket says so, never balloon memory.`,
        },
      ],
    },
    {
      id: 'reqres-negotiation',
      title: 'Content negotiation and format',
      lead: 'One resource, several representations. The client states a preference in Accept; the server picks, names its choice in Content-Type, and tells caches the choice varies — res.format is the Express shape of that contract.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-negotiation:concept',
          body: `Negotiation is a request-view question and a response-view answer. The client sends Accept: application/json;q=0.9, text/plain with q-values ranking the acceptable media types (q=0 means explicitly unacceptable; absent means 1); the server picks the best representation it can produce, names it in Content-Type, and sets Vary: Accept so no cache along the path mistakes one client's JSON for another client's HTML. Express gives you two layers. The accessor layer, req.accepts(['json', 'text']) — returns the best match or false — for when the choice threads through your own branching. The controller layer, res.format({ json: fn, text: fn, default: fn }) — runs exactly the branch the client asked for, answers 406 Not Acceptable when nothing matches and no default is given (Express 5 changed the fallthrough: an unmatched format now 406s instead of silently passing to the next route). This app implements negotiation by hand in the http inspect router — parsing q-values, serializing one fact object three ways — because the HTTP & the Web topic wanted the machinery visible; its live negotiator is the interactive version of this section, and the pattern it demonstrates is exactly what res.format automates:`,
        },
        {
          kind: 'code',
          id: 'reqres-negotiation:format',
          language: 'ts',
          caption:
            'Bottom, verbatim from http_demo_routes.ts — the manual choice, Content-Type, and Vary this repo really ships. Top, in the comments: res.format, the Express automation of the same contract',
          source: 'server/src/presentation/routes/http_demo_routes.ts',
          code: `// the Express automation of "one resource, several representations" —
// matches the request's Accept against the keys and runs the first
// acceptable branch, 406ing when nothing matches and no default is given:
//   res.format({
//     json: () => res.json(facts),               // Accept: application/json (or */*)
//     text: () => res.type('text/plain').send(asPlainText(facts)),
//     html: () => res.type('text/html').send(asHtml(facts)),
//     default: () => res.status(406).json({ /* envelope */ }),
//   });

// this repo\u2019s manual version (verbatim) — same contract, machinery exposed:
// parse Accept\u2019s q-values, pick, name the choice, vary:
const chosen = chooseRepresentation(parseAccept(accept)); // higher q wins, ties to earlier
res.setHeader('Content-Type', CONTENT_TYPES[chosen]);
res.setHeader('Vary', 'Accept');               // caches: the answer VARIES with Accept
res.status(200).send(body);`,
        },
      ],
    },
    {
      id: 'reqres-cookies',
      title: 'Cookies and redirects',
      lead: 'Two small response features with outsized security semantics: Set-Cookie\u2019s attribute set decides who can read your session, and the 3xx family\u2019s method-preservation rules decide what happens to the request body on the way somewhere else.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-cookies:cookie',
          body: `res.cookie(name, value, options) writes a Set-Cookie header — nothing more, which is exactly why its options matter: they are the cookie's security model. httpOnly: true takes the cookie out of document.cookie's reach, which is the difference between an XSS bug and an XSS incident; secure: true restricts it to HTTPS connections; sameSite: 'strict' (or 'lax') keeps the browser from attaching it to cross-site requests, defanging whole classes of CSRF; maxAge (milliseconds) sets the friendly relative expiry; path/domain/signed round out the set. Reading cookies back needs middleware — the Cookie header arrives as one unparsed string until cookie-parser (or your own parsing) populates req.cookies; this app writes a teaching cookie in the demo below but reads none, so it mounts no parser. res.clearCookie(name, options) expires a cookie — with the SAME path/domain options it was set with, or it clears a different cookie than you think (a mismatched clearCookie is a classic "logout doesn't work" bug). Cookies are state you park on the client; the Authentication topic builds real sessions on them.`,
        },
        {
          kind: 'code',
          id: 'reqres-cookies:cookie-verbatim',
          language: 'ts',
          caption: 'server/src/presentation/routes/reqres_demo_routes.ts — verbatim (annotations added): the demo\u2019s teaching cookie, with the attribute set that matters',
          source: 'server/src/presentation/routes/reqres_demo_routes.ts',
          code: `res
  .cookie('teaching_cookie', 'baked', {
    httpOnly: true,        // invisible to document.cookie — XSS cannot exfiltrate it
    sameSite: 'strict',    // never attached to cross-site requests — CSRF resistance
    maxAge: 60_000,        // relative expiry (ms) → Max-Age=60
  })
  .json({
    mode: 'cookie',
    set: true,
    note: 'the real lesson is in the Set-Cookie response header — HttpOnly, SameSite=Strict, Max-Age=60',
  });`,
        },
        {
          kind: 'text',
          id: 'reqres-cookies:redirects',
          body: `res.redirect(status, url) answers with a 3xx and a Location header — the client is expected to repeat the request at the new URL. The family splits on one question: what happens to the method and body on the repeat? 301 Moved Permanently and 302 Found are the historic pair, and by long-standing browser behavior BOTH can rewrite a POST into a GET on the follow-up — the body is dropped, which corrupts any non-idempotent redirect. 307 Temporary Redirect and 308 Permanent Redirect are the modern, well-behaved pair: the method and body are preserved exactly. Rule of thumb: redirecting a GET, any of them works; redirecting anything with a body, use 307/308; and remember 301 is cached aggressively by browsers — a "temporary" 301 is very hard to take back. The demo's redirect mode answers 307 deliberately, and the client fires it with fetch's redirect: 'manual' so the 3xx itself is what you inspect instead of the silently-followed destination.`,
        },
        {
          kind: 'code',
          id: 'reqres-cookies:redirect-verbatim',
          language: 'ts',
          caption:
            'server/src/presentation/routes/reqres_demo_routes.ts — the demo\u2019s redirect, verbatim — 307 so the method and body survive the trip',
          source: 'server/src/presentation/routes/reqres_demo_routes.ts',
          code: `res.redirect(307, REDIRECT_TARGET);
// → HTTP/1.1 307 Temporary Redirect
//   Location: /api/demo/reqres/redirect-target   (the REDIRECT_TARGET constant)
//   Content-Type: text/plain; charset=utf-8   (Express\u2019s tiny human-readable body)

// the cheat sheet:
// res.redirect('/new')          → 302 Found          (historic default; POST may become GET)
// res.redirect(301, '/new')     → permanent           (cached aggressively by browsers)
// res.redirect(307, '/new')     → temporary, method+body preserved  ← use for non-GET
// res.redirect(308, '/new')     → permanent, method+body preserved`,
        },
      ],
    },
    {
      id: 'reqres-live',
      title: 'Drive both endpoints from a terminal',
      lead: 'The inspector and the response playground, no browser needed: curl the same endpoints the demos above drive — where nothing hides a header.',
      blocks: [
        {
          kind: 'text',
          id: 'reqres-live:intro',
          body: `Both interactive demos now live beside the objects they teach — the request inspector at the end of "The request object", the response-methods playground at the end of "The response object". The curls below drive the same two endpoints from a terminal, which is the more honest view of several lessons: the inspector answers every method and reports exactly what the server received — the request line, the parsed query, the lowercased header map, and the body BOTH ways (parsed when a parser claimed it, raw from the stream when one did not; POST it JSON and then text/plain to watch the body-undefined gotcha happen live). The respond?mode= curls fire one response family each — res.json, a chosen status (204 sends no body at all), the 307 redirect with its Location header, the cookie with its security attributes (Set-Cookie is a forbidden header a browser's fetch hides from JavaScript — the terminal does not), a five-line chunked stream, and a Content-Disposition attachment. The -i output IS the lesson: status line, headers, body, one family at a time.`,
        },
        {
          kind: 'code',
          id: 'reqres-live:curl',
          language: 'bash',
          caption: 'drive both demo endpoints yourself (-i: the response headers are half of every lesson here)',
          code: `# The inspector, three content types — note body (parsed) vs bodyRaw (from the stream):
curl -si localhost:4000/api/demo/reqres/inspect?probe=cli
curl -si -X POST -H 'content-type: application/json' -d '{"hello":"inspector"}' \\
  localhost:4000/api/demo/reqres/inspect
curl -si -X POST -H 'content-type: text/plain' -d 'still just bytes' \\
  localhost:4000/api/demo/reqres/inspect

# Custom headers travel — only the x- prefixed ones come back from the echo:
curl -si -X PUT -H 'x-teaching-one: a' -H 'x-teaching-two: b' \\
  localhost:4000/api/demo/reqres/echo-custom-headers

# One response family per mode — the -i output IS the lesson:
curl -si 'localhost:4000/api/demo/reqres/respond?mode=json'
curl -si 'localhost:4000/api/demo/reqres/respond?mode=status&status=418'   # → 418, envelope-free on purpose
curl -si 'localhost:4000/api/demo/reqres/respond?mode=status&status=204'   # → 204, NO body
curl -si 'localhost:4000/api/demo/reqres/respond?mode=redirect'            # → 307 + Location (curl does NOT follow without -L)
curl -si 'localhost:4000/api/demo/reqres/respond?mode=cookie'              # → Set-Cookie with HttpOnly; SameSite=Strict; Max-Age=60
curl -si 'localhost:4000/api/demo/reqres/respond?mode=stream'              # → Transfer-Encoding: chunked, five ndjson lines
curl -si 'localhost:4000/api/demo/reqres/respond?mode=download'            # → Content-Disposition: attachment`,
        },
      ],
    },
  ],
};
