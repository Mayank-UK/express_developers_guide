import type { Topic } from '../types.js';

/**
 * The API documentation topic: OpenAPI as the machine-readable contract,
 * spec anatomy, spec-first vs generated approaches, serving Swagger UI at
 * /docs (which this app REALLY does — docs_routes.ts + openapi_document.ts
 * are the working example), and the discipline that keeps the spec honest.
 * Snippets from this repo are verbatim; illustrative sketches say so.
 */
export const topicApiDocumentation: Topic = {
  id: 'api-documentation',
  title: 'API Documentation',
  subtitle:
    'OpenAPI specs and Swagger UI that stay true to the code they describe.',
  group: 'apis',
  order: 2,
  sections: [
    {
      id: 'api-docs-why',
      title: 'Why machine-readable docs',
      lead: 'Prose documentation rots the day after launch. A spec your tools can parse is documentation that other software can hold your code to.',
      blocks: [
        {
          kind: 'text',
          id: 'api-docs-why:contract',
          body: `Start with what documentation is FOR. A client developer reads it to learn the contract: what paths exist, what shapes go in, what shapes and status codes come out, what happens when things fail. Written as prose — a wiki page, a README — that contract lives in a form only humans can read, which means three things go wrong in order: it DRIFTS (someone changes a handler and not the page — now the docs lie, and lying docs are worse than no docs because they are trusted); it cannot be CHECKED (no test can compare "what the page says" against "what the route does"); and it cannot be TOOLED (you cannot generate a client, a mock server, or a diff report from an English paragraph). The fix is to move the contract into a machine-readable format — for HTTP APIs that format is OpenAPI, the vendor-neutral descendant of the Swagger spec — and treat prose as the EXPLANATION layered on top, never the source of truth.\n\nThe mental shift that matters: the spec is not "documentation about the API", it IS the API's type signature — the same role interfaces play in your TypeScript. You would not ship code whose types live in a comment; do not ship an API whose contract lives in a wiki. The REST API design topic built the contract by discipline (one error envelope, one status-code table, one failure taxonomy); this topic makes it inspectable, clickable, and enforceable.`,
        },
        {
          kind: 'code',
          id: 'api-docs-why:unlocks',
          language: 'txt',
          caption: 'What a machine-readable contract unlocks — none of which prose can do',
          code: `capability            what it looks like
-------------------   ----------------------------------------------------------------
interactive docs      Swagger UI (what this app serves at /docs): the spec rendered as
                      a clickable browser with try-it-out against the live server
client generation     typed SDKs from the spec — TypeScript, Python, Go — with the
                      shapes and enums your hand-written types would drift from
mock servers          Prism, WireMock: point them at the spec, develop the client
                      before (or without) the server
contract testing      Dredd / Schemathesis: fire requests at the REAL server and
                      assert responses match the spec — drift becomes a red test
spec-first design     write the spec, agree on it, THEN build — the contract review
                      happens before code exists to defend
diffing in CI         compare the spec against last release: "this PR removes a
                      response field" becomes a visible, blockable event
linting               Spectral rulesets: operationId everywhere, errors documented,
                      no 200-without-schema — style enforcement for contracts`,
        },
      ],
    },
    {
      id: 'api-docs-anatomy',
      title: 'OpenAPI anatomy',
      lead: 'One document, six load-bearing parts. Learn them on a minimal example and every spec you ever read decomposes the same way.',
      blocks: [
        {
          kind: 'text',
          id: 'api-docs-anatomy:parts',
          body: `An OpenAPI document (3.1 — the version where response schemas became real JSON Schema 2020-12) has a fixed anatomy. INFO identifies the API (title, version, description). SERVERS lists the base URLs operations resolve against — this app uses one RELATIVE server ('/'), so the spec works on any host or port it is served from. PATHS is the heart: each path entry maps an HTTP method to an OPERATION carrying a summary, operationId (the unique, codegen-friendly name), PARAMETERS (path, query, header, cookie — typed and documented individually), an optional REQUEST BODY (content-type keyed, with a schema), and RESPONSES — status code → description → content → schema. COMPONENTS is where reusable things live, referenced from anywhere with $ref: schemas (the Post, the error envelope), responses (the 404 every endpoint shares), parameters, headers, and SECURITY SCHEMES (API keys, bearer tokens, OAuth flows — declared here even though this app has none yet; the auth topics will add them to the contract too). TAGS groups operations for the UI. The discipline that separates a maintained spec from a hairball is $REF ECONOMY: define each shape once in components and reference it everywhere — this app defines the error envelope ONE time and every error response points at it, which is the same single-source-of-truth move the error middleware itself makes in code.`,
        },
        {
          kind: 'code',
          id: 'api-docs-anatomy:minimal',
          language: 'ts',
          caption: 'The load-bearing parts on one real operation — this app\'s POST /api/posts, quoted verbatim from openapi_document.ts (the app ships the document as a typed TS object; the YAML you usually see OpenAPI in is the same six parts in another spelling)',
          source: 'server/src/presentation/routes/openapi_document.ts',
          code: `export const openApiDocument = {
  openapi: '3.1.0',                    // the dialect this document speaks
  info: {
    title: 'Express Developers Guide API',
    version: '1.0.0',                  // the API's version, not the spec format's
  },
  servers: [
    {
      url: '/',                        // relative — works on any host/port
      description: 'this server (relative — works on any host/port the app runs on)',
    },
  ],
  // …tags groups operations for the UI (health, content, posts, demo, graphql)…
  paths: {
    '/api/posts': {                    // a PATH — identity, per the design topic
      post: {                          // an OPERATION on that path
        tags: ['posts'],               // UI grouping
        summary: 'Create a post',
        operationId: 'createPost',     // unique — the client-generation handle
        requestBody: {                 // what goes IN (content-type keyed)
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePostInput' },  // defined ONCE
            },
          },
        },
        responses: {                   // what comes OUT — status by status
          201: {
            description: 'Created — the new post rides the body (no Location header on this endpoint; the body is the address).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Post' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },        // shared, defined ONCE
          503: { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
  },
  components: {
    schemas: {
      Error: {                         // THE reusable envelope — one definition
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              // …code (enum of the failure codes), message, requestId…
              fields: {                // validation details merge flat
                type: 'object',
                description: 'validation failures only: field name → human message.',
                additionalProperties: { type: 'string' },
              },
            },
          },
        },
      },
    },
    responses: {
      BadRequest: {                    // every 400 in the file points here
        description: 'Validation failure — the envelope names the offending fields.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
    },
  },
} as const;`,
        },
        {
          kind: 'text',
          id: 'api-docs-anatomy:judgment',
          body: `The parts the minimal example hides, and where judgment lives. PARAMETERS belong in the spec when they are part of the CONTRACT — this app documents the {id} path parameter with format: uuid and an example, because clients deserve to know an id is a UUID and not a slug. EXAMPLES are not decoration: the seed posts in this app have fixed ids and timestamps precisely so the spec's examples are literally true — an example a client can copy, run, and get 200 from is documentation that verifies itself. RESTRICTIONS travel with the schema (minLength/maxLength on title/body/author mirror the use case's actual validation, additionalProperties: false encodes the unknown-fields-are-rejected rule) — that is how the spec and the validator stay in the same conversation, and drift between them becomes visible instead of latent. And descriptions are the PROSE layer's rightful home now: one sentence per operation explaining what it is FOR (this app's POST notes that validation lives in the use case and the representation rides the body — design decisions, recorded where the contract lives, where they cannot rot away from the shapes they explain).`,
        },
      ],
    },
    {
      id: 'api-docs-spec-vs-generated',
      title: 'Spec-first vs generated',
      lead: 'There are three ways to own an OpenAPI file: write it by hand, generate it from code, or design it before the code exists. This app writes it by hand, beside the routes — here is the honest trade.',
      blocks: [
        {
          kind: 'text',
          id: 'api-docs-spec-vs-generated:handwritten',
          body: `HAND-WRITTEN, kept beside the routes (this app's choice): openapi_document.ts is a plain TypeScript object in the routes directory, one file a reviewer can read end to end. The virtues: the spec reads like DOCUMENTATION — intent, tradeoffs, and honest notes ("no Location header on this endpoint; the body is the address") fit naturally; it can describe behavior code does not declare (which status codes a route CAN return, including the injected 503 that no handler signature mentions); and there is no toolchain between you and the contract. The vice: nothing keeps it honest for free — the spec can drift from the handlers exactly the way prose can, just more structurally. That vice is paid down with tests (the next-but-one section) rather than eliminated.\n\nGENERATED from code: decorators on handlers (tsoa, NestJS's @ApiOperation family) or schema-to-spec compilers (zod-to-openapi — you describe shapes once in zod and emit both the validator and the spec). The spec CANNOT drift from what the annotations say — but it can only say what annotations express, which is less than the truth: generated specs chronically under-document error responses (the envelope is obvious to your middleware and invisible to your decorators), miss cross-cutting 503s, and clutter handlers with spec-noise until the code is longer than the document would have been. Generation is the right call when the API is LARGE and boring (CRUD everywhere, uniform shapes); hand-writing wins when the API is your PRODUCT or, as here, your CURRICULUM. SPEC-FIRST is the third door: write the document, review it with consumers, then build the server against it (stubs generated from the spec). It front-loads the design argument — the whole point of a contract — at the cost of process discipline a solo project rarely needs. Real teams blend all three: spec-first for the shape of new areas, hand-tended details, generation for the boring middens.`,
        },
        {
          kind: 'code',
          id: 'api-docs-spec-vs-generated:same-endpoint',
          language: 'ts',
          caption: 'Top (in the comments): the same POST /api/posts in generated style (illustrative zod-to-openapi flavored) — shapes yes, story no. Bottom: what this app actually ships (verbatim fragment from openapi_document.ts)',
          source: 'server/src/presentation/routes/openapi_document.ts',
          code: `// GENERATED style (illustrative): the schema is the single source…
//   const CreatePostInput = z.object({
//     title: z.string().min(1).max(120),
//     body: z.string().min(1).max(5000),
//     author: z.string().min(1).max(80),
//   }).strict().openapi({ ref: 'CreatePostInput' });
// …the validator AND the spec entry both fall out — but note what ISN'T here:
// no 503 (failure injection is invisible to the decorator), no note about
// the missing Location header, no "validation lives in the use case".

// HAND-WRITTEN, as this app ships it (openapi_document.ts, verbatim):
    '/api/posts': {
      post: {
        tags: ['posts'],
        summary: 'Create a post',
        description:
          'Validation lives in the use case (title/body/author, strings of 1..120 / 1..5000 / 1..80 chars, unknown fields rejected); the route stays a thin translator. Answers 201 with the created post — the representation rides the body.',
        operationId: 'createPost',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePostInput' },
            },
          },
        },
        responses: {
          201: {
            description: 'Created — the new post rides the body (no Location header on this endpoint; the body is the address).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Post' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          503: { $ref: '#/components/responses/ServiceUnavailable' },  // the injected one
        },
      },
    },`,
        },
      ],
    },
    {
      id: 'api-docs-serving',
      title: 'Serving Swagger UI',
      lead: 'A spec nobody can click is a file. This app serves the rendered, try-it-out-able spec at /docs — three moving parts, one of which is a mount-point decision.',
      blocks: [
        {
          kind: 'text',
          id: 'api-docs-serving:mount',
          body: `The moving parts: the DOCUMENT (openapi_document.ts — plain data, no dependencies), swagger-ui-express (serves the Swagger UI static bundle and renders the page around your document), and the ROUTE that ties them together (docs_routes.ts). The one decision that deserves thought is the MOUNT POINT: Swagger UI references its own CSS and JS RELATIVE to the page URL (./swagger-ui.css), so it wants a stable home of its own. This app mounts it on the ROOT app at /docs — deliberately NOT under /api, because the spec's paths already start with /api and a nested mount would advertise try-it-out URLs that double the prefix. The split — /docs beside /api — is the convention you will see across the industry (often /api-docs or /swagger). Two more URLs come along for free: /docs redirects to /docs/ (301 — the trailing slash is where the relative assets resolve), and the RAW spec is served at /docs/openapi.json so tooling — code generators, diff checks, your own curl — can consume the contract without scraping HTML. Because the document is a plain object in memory, the spec endpoint is one res.json call; because the server list is relative, the whole thing works on :4000, in Docker, behind a proxy, unchanged.`,
        },
        {
          kind: 'code',
          id: 'api-docs-serving:verbatim',
          language: 'ts',
          caption: 'Verbatim docs_routes.ts (the whole file, minus comments); the app.ts mount it depends on quoted in the comments — the real setup this screen documents',
          source: 'server/src/presentation/routes/docs_routes.ts',
          code: `// docs_routes.ts — the documentation surface:
import { serve as swaggerServe, setup as swaggerSetup } from 'swagger-ui-express';
import { openApiDocument } from './openapi_document.js';

export const DOCS_UI_PATH = '/docs';
export const DOCS_SPEC_PATH = '/docs/openapi.json';

export const docsRouter = Router();

// The raw spec first — exact route wins over the static-asset fallthrough.
docsRouter.get(DOCS_SPEC_PATH, (_req, res) => {
  res.json(openApiDocument);
});

// Bare /docs → /docs/ (301), as a middleware BEFORE the mount: Express's
// non-strict routing cannot express "match /docs but not /docs/" as a route
// pattern, but req.path can tell them apart.
docsRouter.use((req, res, next) => {
  if (req.method === 'GET' && req.path === DOCS_UI_PATH) {
    res.redirect(301, \`\${DOCS_UI_PATH}/\`);
    return;
  }
  next();
});

// Serve (static assets, index disabled) then the generated HTML page.
docsRouter.use(DOCS_UI_PATH, swaggerServe, swaggerSetup(openApiDocument));

// app.ts — mounted on the ROOT app, NOT under /api (the UI's assets are
// relative to the mount path; /docs beside /api is the conventional split):
//   app.use('/api', apiRouter);
//   app.use(docsRouter);`,
        },
        {
          kind: 'text',
          id: 'api-docs-serving:production',
          body: `Production questions worth deciding before someone else decides them for you. SHOULD DOCS BE PUBLIC? For a public API, yes — docs are marketing and onboarding; for an internal or partner API, gate them behind the same auth as everything else (the auth topics' middleware slots in front of docsRouter like any other router). SHOULD THE SPEC MOVE WITH VERSIONS? If you adopt /api/v1 path versioning, serve /docs/v1/openapi.json and /docs/v2/openapi.json — Swagger UI handles multiple documents via the dropdown (swaggerUrls). SHOULD THE SPEC BE PART OF THE REPO? Yes — it is source code in exactly the way tests are: reviewed in PRs, versioned in git, diffable between releases. And keep the spec MACHINE-FETCHABLE in every environment (this app's /docs/openapi.json), because the moment it is, your CI can pull it, lint it, diff it against main, and run contract tests against it — the entire honesty machinery of the next section depends on the spec being reachable as DATA, not just renderable as a page.`,
        },
      ],
    },
    {
      id: 'api-docs-honest',
      title: 'Keeping docs honest',
      lead: 'The spec is a claim about the code. Testing turns the claim into a checked fact — and the error envelope is where the payoff is highest.',
      blocks: [
        {
          kind: 'text',
          id: 'api-docs-honest:drift',
          body: `Hand-written specs drift; generated specs under-describe. Both failure modes meet the same cure: make the spec EXECUTABLE CLAIMS. The strongest form is CONTRACT TESTING — fire real requests at the running server and assert the responses match the documented schemas and status codes (Schemathesis does this exhaustively, fuzzing inputs against the spec; Dredd reads examples and replays them). This app takes the lightweight version: its own suite asserts the served surface matches the documented one — every documented path present, the error envelope shaped as documented, the spec served as parseable JSON. One level up in CI: LINT the spec (Spectral — rules like "every operation has an operationId" and "every 2xx has a schema") and DIFF it against the last released version so a PR that silently deletes a response field says so out loud. None of this is exotic; it is the same discipline you already apply to code, extended one artifact further.\n\nThe single highest-value thing to document — and then test — is the ERROR CONTRACT. Success responses get all the attention, but every client's worst hour is spent parsing failures. This is exactly why the envelope is ONE reusable schema component here: one $ref point means one place to keep true, one shape every documented 400/404/503 points at, and one assertion in the suite that the real middleware emits what the schema says. The validation topic normalized three libraries' native errors into one { field, message } dialect for the same reason — the contract only works if there is exactly one of it.`,
        },
        {
          kind: 'code',
          id: 'api-docs-honest:spec-fragment',
          language: 'ts',
          caption: 'Verbatim from this app\'s own suite (docs_routes.spec.ts) — the drift check: the served spec must list exactly the real API surface, and the error schema must document what the middleware emits',
          source: 'server/src/presentation/routes/docs_routes.spec.ts',
          code: `it('serves the OpenAPI document as JSON covering the real API surface', async () => {
  const res = await request(createApp()).get('/docs/openapi.json');

  expect(res.status).toBe(200);
  expect(res.body.openapi).toBe('3.1.0');
  // The contract matches the routes that actually exist — the whole point:
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

// plus the envelope check — the error schema documents what the middleware
// emits, so the suite asserts both ends agree:
it('documents the error envelope as a reusable schema', async () => {
  const res = await request(createApp()).get('/docs/openapi.json');
  const errorSchema = res.body.components.schemas.Error;
  expect(errorSchema.properties.error.required).toEqual([
    'code',
    'message',
    'requestId',   // exactly the canonical triple
  ]);
});

it('serves Swagger UI at /docs/ wired to the real document', async () => {
  const page = await request(createApp()).get('/docs/');
  expect(page.status).toBe(200);
  expect(page.text).toContain('swagger'); // the UI page actually rendered

  // the UI's init script embeds the served document (proves the wiring):
  const init = await request(createApp()).get('/docs/swagger-ui-init.js');
  expect(init.status).toBe(200);
  expect(init.text).toContain('/api/posts');
});`,
        },
        {
          kind: 'text',
          id: 'api-docs-honest:humans',
          body: `The last mile of honesty is human: examples that WORK and descriptions that EXPLAIN. Every schema in this app's document carries examples drawn from the real seed data — fixed UUIDs, fixed timestamps — so a reader's first copy-paste is a 200, and a spec-driven tool's first generated request is meaningful. Descriptions record the DECISIONS, not just the shapes: why 400 for all validation (one table in failures.ts), why there is no Location header on create (the body is the address), why /docs is not under /api (relative assets). Six months from now those sentences are the only place the reasoning survives — the code shows what, the spec can carry why, and the tested spec is the one place both stay true. That is the whole craft of API documentation: claims about behavior, checked mechanically, explained humanely.`,
        },
      ],
    },
    {
      id: 'api-docs-beyond',
      title: 'Beyond REST docs',
      lead: 'OpenAPI documents request/response APIs. The moment your interface is a graph, an RPC, or an event stream, a different artifact owns the contract — and each one solves documentation more self-updatingly.',
      blocks: [
        {
          kind: 'text',
          id: 'api-docs-beyond:three',
          body: `GRAPHQL (its own topic, next in this section) makes the documentation problem mostly VANISH by construction: the schema IS the contract, and it is introspectable at runtime — GraphiQL and every GraphQL IDE read the live schema's types, fields, and doc-comments straight from the server, so the docs cannot drift because they are generated from the thing itself on every page load. The trade is what you give up for that: the schema describes shapes, not HTTP semantics — caching, status codes, and error behavior move into conventions (errors array, partial data) that are LESS standardized than OpenAPI's, and rate limits and authentication live in headers the schema says nothing about. gRPC flips the problem to COMPILE TIME: the contract is the protobuf IDL file, checked into both the client's and the server's builds — regenerate the stubs and any mismatch is a compile error before anything ships. Documentation tooling renders proto comments into reference sites, and gRPC server REFLECTION exposes the live schema to grpcurl the way GraphQL introspection does. The trade: the contract covers messages, not the transport — deadlines, retry policies, and auth metadata are conventions beside the file, and nothing human-browsable comes for free the way Swagger UI falls out of OpenAPI.\n\nEVENT-DRIVEN APIs — webhooks, streams, message queues (the webhooks and background jobs topics) — have no request to document at all, which is why AsyncAPI exists: the OpenAPI-shaped spec for publish/subscribe contracts — which topics/channels exist, what payload each carries, what your server will POST to YOUR webhook URL and with what retry policy. The failure AsyncAPI exists to prevent is the undocumented webhook: an integration that fires at your endpoint with a shape you agreed on in a Slack message eight months ago. The pattern across all four: every serious interface style grows a machine-readable contract artifact; REST's is the one you have to keep honest by hand or by test, which is exactly why this topic spent its energy there.`,
        },
        {
          kind: 'code',
          id: 'api-docs-beyond:table',
          language: 'txt',
          caption: 'Where the contract lives, per interface style',
          code: `style        contract artifact        who keeps it honest              docs UI
----------   ----------------------   -------------------------------   ------------------
REST/HTTP    OpenAPI document         YOU — tests & CI diffs (this      Swagger UI at /docs
             (this app: /docs/          topic's whole point)
             openapi.json)
GraphQL      the schema itself,        the server — introspection        GraphiQL / any IDE
             introspected at runtime   generates docs from the live      reading live schema
                                       schema; drift is impossible
gRPC         .proto IDL file           the builds — stubs regenerate     generated reference
             (in both codebases)       and mismatches fail COMPILE        sites + grpcurl via
                                                                       server reflection
events/      AsyncAPI document         YOU again — plus the payload      AsyncAPI HTML
webhooks     (channels + payloads      schema registry (JSON Schema /
             + delivery semantics)     CloudEvents) for the envelopes`,
        },
      ],
    },
    {
      id: 'api-docs-live',
      title: 'See it live',
      lead: 'The app you are reading serves its own spec at /docs — Swagger UI over the real, tested document. Open a tab and try it out.',
      blocks: [
        {
          kind: 'text',
          id: 'api-docs-live:intro',
          body: `The demo below links straight to this app's documentation surface — no mock, no separate docs deployment: the same process serving /api/posts serves the pages describing it. Be precise about what you will find at /docs, because this app is honest about its own scope: the document covers the CORE resource surface (health, content, posts, scenario) plus two representative non-CRUD entries (/api/demo/error, showing how a failure-injection endpoint documents its response statuses; /api/graphql, showing a POST-only non-REST contract) — grouped by tag (health, content, posts, demo, graphql), every path with its parameters, request bodies, response schemas, and the reusable error envelope. The ~25 teaching route groups under /api/demo/** are deliberately NOT mirrored there: their contract is pedagogical and documented by their own topic screens and curl tours, and the document's info section says exactly that — a spec that quietly under-covers its API is lying by omission, while a spec that STATES its scope is trustworthy. Use TRY IT OUT on GET /api/posts right in the UI; toggle failure injection first (PATCH /api/demo/scenario in the same page) and try it again to watch the documented 503 envelope arrive as described. The raw JSON link (/docs/openapi.json) is the same contract as data — feed it to a generator, a linter, or jq. The point to take away: none of this is a documentation DEPLOYMENT; it is one object, one router, and one mount line beside the code it describes — close enough that drift shows up in a code review, and tested so it shows up in CI even when review misses it.`,
        },
        {
          kind: 'code',
          id: 'api-docs-live:curl',
          language: 'bash',
          caption: 'the documentation surface from a terminal — the page, then the contract as data',
          code: `# the rendered UI (Swagger UI page — HTML, assets resolve relative):
curl -s localhost:4000/docs/ | grep -o '<title>[^<]*</title>'

# /docs redirects to the trailing slash (relative assets):
curl -si localhost:4000/docs | head -3        # 301 → /docs/

# the contract as DATA — the same object Swagger UI renders:
curl -s localhost:4000/docs/openapi.json | jq '.info'
curl -s localhost:4000/docs/openapi.json | jq '.paths | keys'
# ["/api/content", "/api/content/topics/{id}", "/api/demo/app-info",
#  "/api/demo/error", "/api/demo/scenario", "/api/graphql", "/api/health",
#  "/api/posts", "/api/posts/{id}"]

# the reusable error envelope every documented error points at:
curl -s localhost:4000/docs/openapi.json | jq '.components.schemas.Error.properties.error.properties | keys'
# ["code", "fields", "message", "requestId"]`,
        },
        {
          kind: 'demo',
          id: 'api-docs-live:docs-link-demo',
          demoId: 'api:docs-link',
          title: 'Open the API docs',
          description:
            'Links to this app\'s live Swagger UI at /docs (try-it-out included) and to the raw OpenAPI document at /docs/openapi.json — the tested contract behind everything this topic showed.',
        },
      ],
    },
  ],
};
