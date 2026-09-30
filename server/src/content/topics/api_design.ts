import type { Topic } from '../types.js';

/**
 * The REST API design topic: resources, representations, the uniform
 * interface, methods and status codes, URLs/pagination/filtering, error
 * envelopes, and versioning — concept-first, then applied to THIS app's own
 * posts pipeline, which is the working example throughout. The posts slice
 * (posts_routes.ts + posts_controllers.ts → post_usecases.ts →
 * sqlite_post_repository.ts → post_dao.ts) is the curriculum: snippets marked
 * verbatim are the real running source; illustrative sketches say so in their
 * captions.
 */
export const topicApiDesign: Topic = {
  id: 'api-design',
  title: 'REST API Design',
  subtitle:
    'Resources, status codes, idempotency, and versioning — designing APIs that age well.',
  group: 'apis',
  order: 1,
  sections: [
    {
      id: 'api-design-what',
      title: 'What REST actually is',
      lead: 'Not a protocol, not a library — an architectural style with a handful of constraints, of which your API probably honors two and a half. Knowing which ones you are skipping, on purpose, is the difference between design and folklore.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-what:constraints',
          body: `REST — REpresentational State Transfer — is a set of architectural constraints Roy Fielding described in his 2000 dissertation for distributed systems built on the web's primitives. Strip away the academic framing and four ideas carry all the weight. RESOURCES: everything worth naming is a resource with an identity (a URL) — a post, a collection of posts, the current runtime scenario. REPRESENTATIONS: clients never touch a resource directly, only representations of it — today that means JSON, but the same resource could answer in XML or HTML if content negotiation asked for it (the HTTP topic demonstrated exactly that). UNIFORM INTERFACE: every resource is manipulated the same way — the same small set of methods (GET, POST, PUT, PATCH, DELETE) with meanings defined once, globally, instead of per endpoint. STATELESSNESS: each request carries everything the server needs to understand it; no client-specific memory between requests, which is what makes load balancing and retries trivial.\n\nNow the field's reality: almost no "REST API" honors all of this. Most are HTTP+JSON APIs that adopt resource URLs, the standard methods, and status codes — the useful three quarters — while skipping hypermedia (HATEOAS), the constraint that says representations should carry links to the next possible actions, letting clients navigate the API like web pages. Skipping HATEOAS is why every client hard-codes URL strings and why "RESTish" is the honest adjective. That is a defensible engineering trade — hypermedia buys evolvability at the cost of tooling and complexity almost no team accepts — but it should be a DECISION, not an accident you cannot name.`,
        },
        {
          kind: 'code',
          id: 'api-design-what:comparison',
          language: 'txt',
          caption: 'The design smell in one column, the resource-oriented fix in the middle, and the real endpoints this app serves in the right',
          code: `RPC-flavored ("RESTish")          resource-oriented                this app (real)
-------------------------------  ------------------------------  --------------------------------
POST /api/getPosts               GET    /api/posts               GET    /api/posts
POST /api/createPost             POST   /api/posts               POST   /api/posts
GET  /api/getPost?id=42          GET    /api/posts/42            GET    /api/posts/:id
POST /api/deletePost             DELETE /api/posts/42            (not implemented — the shape)
POST /api/toggleFailure          PATCH  /api/demo/scenario       PATCH  /api/demo/scenario
GET  /api/getScenario            GET    /api/demo/scenario       GET    /api/demo/scenario

The tell in the left column: VERBS in URLs, one "endpoint" per action, ids in
query strings, and POST doing 100% of the work. Resources + the uniform
interface say it with nouns and five verbs — and the verbs' meanings are
somebody else's spec (HTTP's), not yours to invent per endpoint.`,
        },
        {
          kind: 'text',
          id: 'api-design-what:payoff',
          body: `What do the kept constraints actually buy you? CACHING, because GET is defined as safe — no server state changes — so browsers, proxies and CDNs may cache it; a POST can never be cached precisely because the method's contract says it may change state. RETRIES, because idempotent methods (GET, PUT, DELETE) promise that firing twice has the same effect as once, so a client that timed out can simply retry. GENERIC TOOLING: curl, Postman, Swagger UI, load balancers, and monitoring all speak methods and status codes without knowing anything about your domain. EVOLVABILITY, because the uniform interface is a stable contract surface — new representations can be added beside old ones via content negotiation instead of replacing them.\n\nAnd the honest counterweight: the constraints have friction, which is why GraphQL (client-defined queries over one endpoint) and gRPC (typed RPC over HTTP/2) exist and are covered by their own topics later in this section. REST remains the default for public HTTP APIs because its friction is the lowest for the widest audience — any client that can make an HTTP request can use it, no schema runtime required. This topic teaches you to design that kind of API well; the posts pipeline you met in earlier topics is the running example, and the workbench in the pipeline section below lets you exercise it — including watching it fail.`,
        },
        {
          kind: 'text',
          id: 'api-design-what:trpc',
          body: `tRPC, THE AWARENESS PARAGRAPH. Typed-RPC over plain HTTP, built for the TypeScript monorepo: the server exports a router of procedures, the client imports them as typed functions, and plain POSTs carry JSON over the wire — no schema file, no codegen; the CONTRACT is the shared type system, checked by the same tsc run as the rest of the app. Where it beats REST: an internal API serving its own frontend — the coupling REST abstracts away is a FEATURE there (rename a field and the client build goes red instead of production), input and output types flow end to end, and nothing over-fetches because each procedure returns what its caller asked for. Where it does not: clients you do not compile with — public APIs, mobile and third-party consumers, contracts that must outlive any one stack — and whenever HTTP's own semantics matter (everything-is-a-POST defeats GET caching and CDN semantics). It is the same trade this section keeps meeting in different hats: GraphQL (its own topic) buys client-defined queries for unknown clients, gRPC (its own topic) buys cross-language typed RPC for service-to-service, tRPC buys zero-ceremony typing when BOTH ends are already your TypeScript. This API stays REST deliberately — resources, methods, and status codes ARE this guide's curriculum — which is the sizing rule to leave with: choose the style your CONTRACT needs, not the one your stack makes easiest.`,
        },
      ],
    },
    {
      id: 'api-design-resources',
      title: 'Designing resources',
      lead: 'The hardest part of API design is not any URL — it is deciding what the nouns are. Get the resource model right and the endpoints fall out; get it wrong and no amount of method discipline saves you.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-resources:nouns',
          body: `Three rules cover most of it. NOUNS, NOT VERBS: a URL names a thing, an HTTP method says what to do to it — /api/posts + GET, not /api/getPosts. The moment a verb appears in a path, you have invented a private RPC and forfeited the uniform interface. PLURAL COLLECTIONS: /api/posts is the collection, /api/posts/0f1c2b3a-… is one member — plural keeps collection and item grammar consistent (GET on the collection lists, POST to it creates, GET on a member fetches, PATCH on it updates). SHALLOW NESTING: /api/posts/:id/comments is fine (a child genuinely owned by its parent) but /api/users/:id/posts/:id/comments/:id is a URL that encodes a JOIN — stop at two segments of nesting and flatten the rest, because deep paths break, get copy-pasted wrong, and encode relationships the ids already express. Note what a resource is NOT: a database table. Resources are DOMAIN concepts your clients think in; the posts resource here maps conveniently onto a sqlite table, but /api/demo/scenario is a single configuration document with no table behind it at all — the fake and live repositories both serve it.\n\nWalk through this repo's actual surface: the posts resource is three routes on one router — GET /api/posts (list), POST /api/posts (create), GET /api/posts/:id (fetch one) — and the scenario is a SINGLETON document resource: not a collection at all, just one addressable thing you GET to read and PATCH to modify. The content tree nests exactly one level — /api/content/topics/:id — because topics are owned by content but each has a globally unique slug that makes deeper nesting pointless. Every URL here names a thing; the verbs live in the method line where HTTP defined them.`,
        },
        {
          kind: 'code',
          id: 'api-design-resources:verbatim',
          language: 'ts',
          caption: 'Verbatim route declarations — posts_routes.ts (the collection + member grammar); the singleton scenario document (demo_routes.ts) and the /api mount (app.ts) quoted in the comments',
          source: 'server/src/presentation/routes/posts_routes.ts',
          code: `// posts_routes.ts — the posts resource in two chained declarations:
export const postsRouter = Router();
postsRouter
  .route('/posts')
  .get(makeExpressCallback(postsControllers.list))     // collection: list
  .post(makeExpressCallback(postsControllers.create)); // collection: create
postsRouter.route('/posts/:id').get(makeExpressCallback(postsControllers.detail)); // member: fetch one

// demo_routes.ts — the scenario as a SINGLETON document resource (no :id —
// there is exactly one, addressed by the path itself):
//   demoRouter.get('/demo/scenario', scenarioController);      // read the document
//   demoRouter.patch('/demo/scenario', patchScenarioController); // partial update

// The whole surface mounts under one prefix (app.ts):
//   app.use('/api', apiRouter);   // /api/posts, /api/demo/scenario, /api/content/…`,
        },
        {
          kind: 'text',
          id: 'api-design-resources:identity',
          body: `Two finer points the walkthrough hides. First, IDS ARE ADDRESSES, NOT IDENTITY: the id in /api/posts/:id is how to FIND a post today, not what the post IS — ids can be opaque (this app uses UUIDs minted at create time) and clients should treat them as unguessable handles, never decode meaning out of them. Second, KNOW WHEN A "VERB" IS REALLY A STATE TRANSITION — sometimes an operation genuinely is not a CRUD shape (cancel an order, publish a draft, retry a job). Purists model these as PATCHes on a status field; pragmatists allow POST /api/orders/:id/cancellation when the transition has side effects a plain field edit cannot express (emails, refunds). The rule to keep either way: the URL still names a THING (the cancellation resource), and the operation stays discoverable from the resource instead of a verb soup. This app's scenario toggle is the clean case — "turn failure injection on" is genuinely just PATCH { injectFailure: true } on a document, no action-URL needed.`,
        },
      ],
    },
    {
      id: 'api-design-methods',
      title: 'Methods and status codes',
      lead: 'The uniform interface is a table you memorize once and apply forever: which methods are safe, which are idempotent, and which success code each operation answers with.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-methods:semantics',
          body: `Method semantics are contracts, not conventions. SAFE methods (GET, HEAD, OPTIONS) promise the server's state does not change — which is what makes prefetching and caching legal; a GET that mutates anything is a lie that breaks every piece of web infrastructure above it. IDEMPOTENT methods (GET, HEAD, OPTIONS, PUT, DELETE) promise that repeating the request has the same effect as issuing it once — PUT sets the same state again, DELETE on an already-deleted resource is "already done", so a client that timed out can retry blindly. POST is NEITHER: two identical POSTs create two resources, so retry logic must be deliberate (idempotency keys — the payment APIs' answer). PATCH is officially neither-safe-nor-idempotent, though partial updates sent as JSON merge patches usually behave idempotently in practice.\n\nWhy does this matter beyond trivia? Because infrastructure ACTS on it: caches store GETs, proxies retry idempotent methods and refuse to retry POSTs, browsers preload safe links, and monitoring tools flag 5xx on safe methods differently. This app's own demo relies on it — the workbench fires the same GET /api/posts again and again across scenario toggles precisely because GET is safe and idempotent: no matter how many times the log console shows it, nothing was created or mutated.`,
        },
        {
          kind: 'code',
          id: 'api-design-methods:table',
          language: 'txt',
          caption: 'The design table — method × safe × idempotent × success codes, with where this app actually emits each',
          code: `method   safe   idempotent  success codes      this app emits it for
------   ----   ----------  -----------------  ------------------------------------------
GET      yes    yes         200                every read: posts, content, scenario, health
POST     no     no          201 (create),      POST /api/posts → 201 with the created post
                             200 (actions)     POST /api/demo/ts/echo → 200 (an action)
PUT      no     yes         200 or 204         (none — nothing here is full-replace shaped)
PATCH    no     usually     200               PATCH /api/demo/scenario → 200 with the
                                                updated document (merge-patch style)
DELETE   no     yes         204 (bodyless),    (none — implemented in the delete-shaped
                             200 (with body)    APIs you will build; this app never deletes)
HEAD     yes    yes         (headers only)     (Express answers HEAD for GET routes free)

error codes this app can actually produce — one per failure kind, centrally:
  400 validation_failed   404 not_found   409 conflict   503 service_unavailable
  401/403/429/500 exist in the taxonomy; auth and rate limiting land later`,
        },
        {
          kind: 'text',
          id: 'api-design-methods:codes',
          body: `Choosing the success code is mostly mechanical: 200 for reads and updates that return the resource, 201 + a Location header for creates (the header tells the client where the new thing lives: Location: /api/posts/<id>), 204 for bodyless successes — the natural DELETE answer. This repo's create answers 201 WITH the representation and WITHOUT the Location header — a defensible simplification (the body carries the id, so nothing is lost) that a stricter API would finish with the header; the OpenAPI topic's spec documents the actual behavior, which is the honest move. On the error side, the codes this pipeline really emits: 404 when GET /api/posts/:id names a well-formed id that matches nothing (route matched, resource absent — the routing topic's distinction), and 400 for validation.\n\nThe 422-versus-400 debate deserves its own paragraph because you will hit it in every codebase: 400 means "malformed request", 422 (from WebDAV, RFC 4918) means "well-formed but semantically invalid" — so shouldn't POST /api/posts with a 5000-character body answer 422? In theory, yes; in practice this repo picks 400 for ALL validation failures, and the reasoning is consistency: the failure taxonomy has ONE validation kind mapped to ONE status in ONE place (failures.ts), every client writes one error handler, and no one ever has to remember whether a given rule counts as syntax or semantics. That is the real lesson of status codes — the perfect code matters far less than the CONSISTENT code. Pick your mapping once, write it down in one table the way failures.ts does, and never decide per endpoint again.`,
        },
      ],
    },
    {
      id: 'api-design-urls',
      title: 'URL design, pagination, filtering',
      lead: 'The path names the resource; the query string parameterizes the answer. That split — identity versus options — organizes everything from pagination to sparse fieldsets.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-urls:split',
          body: `The split to internalize: PATH = IDENTITY (which resource), QUERY = OPTIONS (which view of it). /api/posts and /api/posts/42 are different RESOURCES; /api/posts?page=2&author=grace&sort=-createdAt is the same resource, differently viewed. From that split the conventions fall out. PAGINATION: offset style (?page=2&limit=20 or ?offset=20&limit=20 — easy, supports jumping to a page, but breaks under concurrent writes: a row inserted before your offset makes page 2 repeat a row you saw) versus cursor style (?cursor=eyJpZCI6…&limit=20 — the cursor encodes WHERE YOU STOPPED, so inserts never cause skips or duplicates, but random access is gone and cursors must be opaque tokens the server can decode). FILTERING: repeatable field predicates (?author=grace&status=published; repeat keys for ORs — ?tag=express&tag=node); document per field whether match is exact, prefix, or full-text. SORTING: one convention and stick to it — sort=-createdAt,title (leading minus = descending, comma = tiebreaker) mirrors the SQL this app actually runs. SPARSE FIELDSETS: ?fields=title,author asks for a partial representation — the poor man's GraphQL, and a genuine bandwidth saver for mobile clients.\n\nThe honest note about THIS app: GET /api/posts implements none of that. It returns all posts, always, ordered by createdAt DESC, id DESC — literally the ORDER BY in post_dao.ts. At three seeded posts that is the right amount of engineering; at three million it is a denial of service against yourself. Where pagination would slot in is the lesson: not in the route (thin controllers), but as parsed options through the use case into the repository's SQL (LIMIT/OFFSET for the offset style, WHERE (created_at, id) < (…) ROW_NUMBER tricks or keyset predicates for the cursor style) — the layering from the next section is what makes that addition a pipeline change rather than a rewrite.`,
        },
        {
          kind: 'code',
          id: 'api-design-urls:conventions',
          language: 'txt',
          caption: 'The conventions applied to the posts resource (illustrative beyond the first row — this app\'s list endpoint currently returns everything, newest first)',
          code: `GET /api/posts                          # the whole collection (what this app serves)
GET /api/posts?page=2&limit=20          # offset pagination — page arithmetic, unstable
GET /api/posts?cursor=eyJv…&limit=20    # cursor pagination — stable, opaque, no jumping
GET /api/posts?author=grace             # filter: exact match on a field
GET /api/posts?tag=express&tag=node     # filter: repeated key = OR within one field
GET /api/posts?sort=-createdAt,title    # sort: minus = desc, comma = tiebreaker
GET /api/posts?fields=title,author      # sparse fieldset — a partial representation
GET /api/posts/0f1c2b3a-…?fields=title  # fieldsets compose with member fetches too

What this app ACTUALLY runs under GET /api/posts (post_dao.ts, verbatim):
  SELECT id, title, body, author, created_at, updated_at
  FROM posts ORDER BY created_at DESC, id DESC
-- the sort convention you would expose as ?sort=-createdAt,id is already
-- the database's own tiebreaked ordering — conventions should match reality.`,
        },
        {
          kind: 'text',
          id: 'api-design-urls:meta',
          body: `Whatever pagination you pick, answer the CLIENT'S real question: "is there more?" Offset style infers it (page < ceil(total/limit)) and usually ships a total; cursor style cannot count cheaply, so it ships a nextCursor (or null) — and the classy delivery for either is the Link header with rel="next"/rel="prev" URLs, so clients follow links instead of constructing them. Validate every query parameter exactly as strictly as a body field: the routing topic's /search endpoint demonstrated the pattern (limit must be a whole number 1..100, repeated q rejected) because query strings are still request input — an unvalidated ?limit=999999999 is the same bug as an unvalidated body field, wearing shorts. Last rule of URL design: never encode STATE that matters into a URL you are ashamed to see in logs, analytics, or a browser history bar — the query string is public, shareable, cache-keyed input; treat it as part of your contract, because your clients will.`,
        },
      ],
    },
    {
      id: 'api-design-errors',
      title: 'Error responses that work',
      lead: 'Errors are half your API\'s surface area and nearly all of its worst days. A client that can parse your failures programmatically is a client that can recover from them.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-errors:envelope',
          body: `The design goal: a client should never STRING-MATCH an error message to know what went wrong. That demands an envelope with three distinguishable parts, and this app's is the shape to copy: a machine-readable CODE (validation_failed, not_found, service_unavailable — stable, switchable, one per failure kind), a human-readable MESSAGE (safe to display, never a stack trace, never internals), and the REQUEST ID (the correlation key the request-id middleware stamped on every request — when a user pastes it into a bug report, you can find the exact log line). Around those canonical keys, failure DETAILS merge flat: a validation failure carries fields ({ title: "must be a string of 1 to 120 characters (got 0)" }), a not-found carries the id you asked for — extra keys, same shape, one parser.\n\nWhere the envelope gets BUILT is as important as its shape: one error-handling middleware, registered last, that no route ever calls directly. Controllers throw typed exceptions (or Result failures are converted to them at the edge); the middleware owns status-code mapping and body shaping for the entire app in one function. That centralization is why the taxonomy in failures.ts can promise every 400 looks like every other 400 — there is exactly one place that could differ, and it doesn't.`,
        },
        {
          kind: 'code',
          id: 'api-design-errors:verbatim',
          language: 'ts',
          caption: 'Verbatim error_middleware.ts — the AppException branch that shapes every typed failure into the envelope (log-level discipline and details-merge flat; canonical keys win)',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `if (err instanceof AppException) {
  const { failure } = err;
  // Level discipline: 4xx is the CLIENT's problem — warn; 5xx is OURS — error.
  const logLine = { err, statusCode: err.statusCode, requestId, failureKind: failure.kind };
  if (err.statusCode >= 500) logger.error(logLine, 'request failed');
  else logger.warn(logLine, 'request failed');
  // Details merge under the canonical keys; canonical keys win on collision.
  const errorBody: Record<string, unknown> = {
    ...(failure.details ?? {}),       // fields, postId, … ride ALONGSIDE
    code: err.code,                   // machine-readable: validation_failed
    message: failure.message,         // human-readable, display-safe
    requestId,                        // the correlation id from res.locals
  };
  res.status(err.statusCode).json({ error: errorBody });
  return;
}
// anything not an AppException: best-effort extraction, 500 fallback —
// the same envelope shape, never a stack trace, never HTML.`,
        },
        {
          kind: 'text',
          id: 'api-design-errors:problem',
          body: `The standardized cousin of this envelope is RFC 9457 "Problem Details for HTTP APIs" (it obsoleted RFC 7807): content-type application/problem+json with type (a URI identifying the error class), title, status, detail, and instance — plus extension members exactly like this app's flat-merged details. Problem+json's virtue is being a SPEC: off-the-shelf clients and gateways recognize it, and you get the field semantics for free instead of inventing codes. Its cost is negligible. So why does this app ship a custom envelope? Consistency and teaching: the custom shape is derived mechanically from the ONE failure taxonomy (kind → status + code, in one table), the requestId correlation is first-class, and the entire guide's demos — including the workbench below rendering 400s and 503s — speak that one dialect. The transferable rule is not "adopt problem+json"; it is: PICK ONE ERROR SHAPE, derive it in one place, and make every failure — parser errors, validation failures, unknown routes (the 404 catch-all in app.ts uses it), and injected 503s — speak it. The worst API error design is not the wrong envelope; it is three envelopes, chosen by whichever code path happened to fail. Bonus consistency rule the middleware enforces for free: a JSON API answers JSON even when everything is broken — an HTML error page from a 500 is a client crash waiting at the worst possible moment.`,
        },
      ],
    },
    {
      id: 'api-design-versioning',
      title: 'Versioning and evolution',
      lead: 'You will get the design wrong. Versioning is the discipline of getting it wrong WITHOUT taking your clients down with you — and most of it is not versions at all.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-versioning:additive',
          body: `The rule that does most of the work: ADDITIVE CHANGES ARE NOT BREAKING. Adding an optional request field, a new response field, a new endpoint, a new query parameter, a new error code to a documented set — old clients sail through all of it (this is why clients must TOLERATE UNKNOWN KEYS, the forward-compat rule the client API layer of this very app follows when it validates payloads leniently). BREAKING changes are the mirror list: removing or renaming fields, changing types, making an optional field required, TIGHTENING validation (an API that starts 400-ing bodies it used to accept has broken clients just as surely as if it deleted the endpoint), and changing semantics while keeping the shape. The discipline: exhaust additive evolution before you mint a version — most "we need v2" moments are actually "we need a new optional field" moments.\n\nWhen a break is genuinely needed, the two standard mechanisms: PATH VERSIONING (/api/v1/posts, /api/v2/posts) — blunt, visible in every log and curl, cache-friendly, debuggable over the phone, and how Stripe, GitHub, and most public APIs do it; HEADER VERSIONING (Accept: application/vnd.guide.v2+json) — cleaner URLs and no path churn, at the cost of being invisible in casual debugging and harder to test with plain curl. The blunt one wins more often than aesthetics would like, for the same reason status-code consistency wins: visible and boring beats elegant and undiscoverable. This app runs unversioned /api by deliberate choice — it is a teaching surface that has only ever evolved additively — but the seam is already there: app.use('/api', apiRouter) is exactly the line where app.use('/api/v1', apiV1Router) would slot in, and the api-documentation topic's spec documents today's surface as the contract to diff against.`,
        },
        {
          kind: 'code',
          id: 'api-design-versioning:illustrative',
          language: 'ts',
          caption: 'Illustrative — how a v2 would mount beside v1 in this app\'s composition root (today nothing versions; the real seam, quoted from app.ts, is line one)',
          source: 'server/src/app.ts',
          code: `// app.ts today — one prefix, one surface (the REAL line, verbatim):
app.use('/api', apiRouter);

// the day a BREAKING change is unavoidable — v2 mounts beside v1, both live,
// v1 marked deprecated (sunset headers, monitoring on its traffic):
//   app.use('/api/v1', apiV1Router);
//   app.use('/api/v2', apiV2Router);

// deprecation, done politely (illustrative middleware on the v1 mount):
//   apiV1Router.use((req, res, next) => {
//     res.set('Deprecation', 'version="v1", date="Wed, 01 Oct 2026 00:00:00 GMT"');
//     res.set('Sunset', 'Wed, 01 Apr 2027 00:00:00 GMT'); // when v1 answers stop
//     next();
//   });
// then WATCH v1 traffic per client (api keys make this possible) and only
// retire it when the graph hits zero — deprecation is logistics, not law.`,
        },
        {
          kind: 'text',
          id: 'api-design-versioning:hygiene',
          body: `The hygiene that delays versions: never expose implementation details that pin you (database column names as response keys — this repo's rowToPost deliberately maps created_at to createdAt at the boundary, precisely so the wire speaks the API's dialect, not sqlite's); document every field you return as CONTRACT, because clients will depend on whatever you send regardless of what you meant; and keep validation rules documented alongside the fields they guard (a 1..120 title limit is part of the public surface — the OpenAPI topic encodes it as maxLength on the schema). When deprecation day does come: announce in the changelog, mark responses with Deprecation and Sunset headers (the emerging RFC conventions shown above), keep old and new running side by side long enough for your slowest client, and monitor per-client usage of the old surface so retirement is a measured decision instead of a surprise outage. API evolution is customer management with extra steps — the technical part (a second router mounted at a second prefix) is the easy half.`,
        },
      ],
    },
    {
      id: 'api-design-pipeline',
      title: 'The whole pipeline',
      lead: 'One request, five layers, real files: what actually happens between curl GET /api/posts and the JSON on your screen — and why the layering is API design, not just architecture.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-pipeline:journey',
          body: `Follow a POST /api/posts through the real app. The request hits the ROOT middleware chain first: requestIdMiddleware stamps a UUID onto res.locals and the x-request-id response header (so even this request's FAILURES will be traceable), then express.json() parses the body or rejects it with a 400 before any route runs. The apiRouter mounted at /api matches postsRouter, whose rows are pure declarations — one makeExpressCallback(controller) line per verb — and the thin CONTROLLER behind the declaration (posts_controllers.ts, framework-free) does nothing but hand the body — still unknown — to the use case and map the Result to a response: three lines, no validation, no SQL, no status-code arithmetic. The USE CASE (post_usecases.ts) is the domain's gatekeeper: validatePostDraft — the ENTITY's own rules (post.ts), so no caller can bypass them — checks shape (title/body/author, strings, length caps, unknown keys rejected), the scenario check runs (failure injection short-circuits with a typed unavailable failure — the 503 the workbench can switch on), and only then does it call the repository. The REPOSITORY is selected PER CALL from the scenario (fake in-memory or sqlite — the selector closure means toggling dataMode takes effect on the very next request, no rebuild). The sqlite repository maps domain to row and delegates to the DAO — mechanical SQL, no domain concepts — then rowToPost maps the row BACK to the domain shape on the way up. The Result climbs back: ok(post) becomes { status: 201, body: post }, which the makeExpressCallback adapter writes as res.status(201).json(post); any failure becomes a typed exception via failureToException, and the error middleware — registered last — shapes it into the one envelope.\n\nNotice what each layer OWNS: the route owns translation (HTTP ↔ use case), the use case owns rules (validation, orchestration, failure policy), the repository owns persistence dialect (rows ↔ entities, sqlite errors → typed failures), the DAO owns SQL. The API design consequences fall straight out: status codes are decided in exactly two places (the controller for success, one table in failures.ts for errors); the wire contract survives a data-mode swap because both repositories implement the same port; and the same use case could serve a queue consumer or a CLI tomorrow without knowing HTTP exists.`,
        },
        {
          kind: 'code',
          id: 'api-design-pipeline:verbatim',
          language: 'ts',
          caption: 'The whole journey, top to bottom — the use case quoted verbatim (post_usecases.ts, dedented from its object); the layers above and below it quoted in the comments from posts_routes.ts, posts_controllers.ts, sqlite_post_repository.ts, post_dao.ts',
          source: 'server/src/domain/posts/post_usecases.ts',
          code: `// 1. the route declaration (posts_routes.ts) and the thin controller it
//    mounts (posts_controllers.ts) — translate, nothing else:
//   postsRouter
//     .route('/posts')
//     .get(makeExpressCallback(postsControllers.list))
//     .post(makeExpressCallback(postsControllers.create));
//   async create(httpRequest: HttpRequest): Promise<HttpResponse> {
//     const result = await createPost(httpRequest.body);      // unknown in
//     if (!result.ok) throw failureToException(result.error);  // failure → envelope
//     return { status: 201, body: result.value };              // ok → 201 + representation
//   }

// 2. the use case (post_usecases.ts, verbatim) — the entity's gate, scenario,
//    delegation (validatePostDraft lives in post.ts: the use case
//    orchestrates, the entity decides what a valid post IS):
async create(raw: unknown): Promise<Result<Post, Failure>> {
  const validated = validatePostDraft(raw);
  if (!validated.ok) return fail(validated.error);     // 400s are born here
  const injected = injectedFailure();
  if (injected) return fail(injected);                 // the demo 503 is born here
  return selectRepository().create(validated.value);
}

// 3. the repository (sqlite_post_repository.ts) — dialect mapping, per call:
//   async create(input: CreatePostInput): Promise<Result<Post, Failure>> {
//     const now = new Date().toISOString();
//     const post: Post = { id: crypto.randomUUID(), title: input.title, body: input.body,
//                          author: input.author, createdAt: now, updatedAt: now };
//     try {
//       activeDao().insert(postToRow(post));   // domain Post → PostRow (snake_case)
//       return ok(post);
//     } catch (cause) {
//       return fail(toRepositoryFailure('creating a post', cause)); // SQLITE_CONSTRAINT → 409
//     }
//   }

// 4. the DAO (post_dao.ts) — SQL, no domain concepts, throws raw sqlite errors:
//   insert(row: PostRow): void {
//     this.db.prepare(
//       \`INSERT INTO posts (id, title, body, author, created_at, updated_at)
//        VALUES (@id, @title, @body, @author, @created_at, @updated_at)\`,
//     ).run(row);
//   }`,
        },
        {
          kind: 'text',
          id: 'api-design-pipeline:why',
          body: `Why pay five layers for one POST? Because each failure mode gets exactly one home. Bad input dies at the use case (validation), not sprinkled across handlers; infrastructure failures die at the repository (typed from real sqlite errors — a constraint violation becomes a 409 conflict, everything else a 500 with the cause attached for logs), not as raw exceptions crashing the request; transport decisions (status codes, the envelope) live at the edges where they belong; and the fake/live scenario switch works BECAUSE the controller never knew which repository answered. For API design specifically, the payoff is the single most valuable property an API can have: the CONTRACT is enforced by construction. Every path into the domain produces the same shapes, the same failures, the same envelope — there is no second code path that could 400 differently. The workbench below drives this pipeline from outside, like a client: it lists, creates, toggles the scenario, and watches the same three routes answer from fake data, live sqlite, and an injected 503 — one resource, one contract, three backend realities.`,
        },
        {
          kind: 'demo',
          id: 'api-design-pipeline:workbench-demo',
          demoId: 'api:posts-workbench',
          title: 'The posts workbench',
          description:
            'A compact REST client for the posts pipeline: list with a per-response status-code critique, create with the real validation rules (201 and the 400 envelope side by side), scenario toggles for fake/live data and failure injection — and a request log recording the last ten calls you fired.',
        },
      ],
    },
    {
      id: 'api-design-live',
      title: 'The pipeline from a terminal',
      lead: 'The same three routes with nothing between you and the wire: list, create (valid + invalid), toggle fake/live, inject the 503 — and read the status lines and envelopes exactly the way a client sees them.',
      blocks: [
        {
          kind: 'text',
          id: 'api-design-live:intro',
          body: `The interactive workbench now sits at the end of the whole-pipeline section above; this closing tour drives the same surface the raw way, from a terminal. The curl block walks the contract in order: list the collection (newest first — createdAt DESC, id DESC, the ORDER BY post_dao.ts actually runs), create a post and watch 201 arrive with the representation riding the body, then send an unknown-field body and read the 400 envelope with field-level messages — this repo answers 400 for ALL validation, from the one table in failures.ts. Finish with the failure-injection round trip: PATCH the scenario on, fire any request, and the 503 service_unavailable envelope arrives in the same shape as every other failure; switch it back off. Use curl -si for at least the first and last exchanges and read the status line and headers yourself — no critique panel, no request log, just the contract answering. That is the review habit this topic leaves you with: judge an API by what is on the wire, because that is all a client ever sees.`,
        },
        {
          kind: 'code',
          id: 'api-design-live:curl',
          language: 'bash',
          caption: 'drive the same pipeline from a terminal — list, create (valid + invalid), and the failure-injection round trip',
          code: `# the collection (newest first — createdAt DESC, id DESC):
curl -si localhost:4000/api/posts | head -20

# create — 201 + the representation rides the body:
curl -si -X POST -H 'content-type: application/json' \\
  -d '{"title":"Designed, not accreted","body":"Nouns in paths, semantics in methods, one error envelope.","author":"you"}' \\
  localhost:4000/api/posts

# validation — the 400 envelope with field-level messages (422-vs-400: this
# repo answers 400 for ALL validation, from the one table in failures.ts):
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"title":"x","body":"b","author":"a","surprise":true}' \\
  localhost:4000/api/posts | jq
# → error.fields.surprise: "unknown field — only title, body and author are accepted"

# the failure-injection round trip — same resource, 503 envelope:
curl -s -X PATCH -H 'content-type: application/json' \\
  -d '{"injectFailure":true}' localhost:4000/api/demo/scenario | jq
curl -si localhost:4000/api/posts | head -12        # 503 service_unavailable
curl -s -X PATCH -H 'content-type: application/json' \\
  -d '{"injectFailure":false}' localhost:4000/api/demo/scenario | jq`,
        },
      ],
    },
  ],
};
