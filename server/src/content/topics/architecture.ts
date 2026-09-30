import type { Topic } from '../types.js';

/**
 * The Architecture topic — the guide's tour of ITS OWN layered structure. The
 * app is the exhibit: every code block below is quoted verbatim from this
 * repository (paths in the captions), and the live demo at the end traces a
 * real request through the actual layers with per-layer timings, plus the
 * server's own folder map walked live from disk.
 */
export const topicArchitecture: Topic = {
  id: 'architecture',
  title: 'Architecture',
  subtitle:
    'Layered structure, the dependency rule, and how a request flows through this repository.',
  group: 'platform',
  order: 3,
  sections: [
    {
      id: 'arch-why',
      title: 'Why architecture at all',
      lead:
        'Folder structure is frozen decision-making. Layers are not ceremony for its own sake — they are the cheapest place to put a decision so you never have to make it again.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-why:cost-curve',
          body: `WHAT A FOLDER STRUCTURE ACTUALLY IS: compression of decisions. When you decide "validation lives in the use case, never in the route", you make that decision ONCE and then never again — every future feature lands where the structure says it lands, and every reader finds it there without asking. Without structure you do not avoid the decisions; you re-make them per file, per Pull Request, per onboarding, and the re-makings drift. That drift is the COST CURVE every architecture conversation is really about: at the left edge (a script, a weekend tool) the decisions are cheap and few — any structure is overhead; as the code grows, the cost of NOT having decided rises faster than the cost of having decided, and the curves cross somewhere around "a second contributor" or "the third feature that touches the same table". PAST THE CROSSOVER, layering pays three concrete rents. TEAMS: when the HTTP layer and the persistence layer are separate modules, two people can work in them the same day without merge pain, because the seams are explicit. TESTS: when business rules live outside the framework, you can exercise them without booting the framework — the quote below is this repo's own use-case spec constructing the domain pipeline by hand, and there is not an Express import in it. CHANGE ISOLATION: when sqlite needs to become postgres, the change is bounded by a port interface instead of splattered across every route that ever ran a query (this repo proves the smaller version of that constantly — the fake and sqlite repositories swap per request, and nothing above them knows). AND THE HONEST CONTRA CASE, said out loud because architecture evangelists won't: a SCRIPT DOES NOT NEED LAYERS. A 200-line webhook-forwarder with a main() and two functions is CORRECT at that size; wrapping it in domain/use-cases/ports is cargo-culting someone else's crossover point. Structure is a bet that the code will grow — if it won't, don't pay. This guide has layers because a teaching codebase must make its seams VISIBLE (you are reading one), and because real API servers almost always cross the curve. The rest of this screen is the map of how THIS repository pays the rent.`,
        },
        {
          kind: 'code',
          id: 'arch-why:verbatim-spec',
          language: 'ts',
          caption: 'Verbatim — the domain, tested with zero HTTP (domain/posts/post_usecases.spec.ts, the spec-fixture builder)',
          source: 'server/src/domain/posts/post_usecases.spec.ts',
          code: `import { makePostsUseCase } from './post_usecases.js';
import { createScenarioStore } from '../../core/scenario/scenario.js';
import { makeFakePostRepository } from '../../data/posts/fake_post_repository.js';

function buildUseCase(overrides: { dataMode?: 'fake' | 'live'; injectFailure?: boolean } = {}) {
  const store = createScenarioStore(
    Object.freeze({
      dataMode: overrides.dataMode ?? 'fake',
      injectFailure: overrides.injectFailure ?? false,
    }),
  );
  const repository = makeFakePostRepository();
  let selections = 0;
  const useCase = makePostsUseCase({
    selectRepository: () => {
      selections += 1;
      return repository;
    },
    scenarioStore: store,
  });
  return { useCase, store, repository, selections: () => selections };
}`,
        },
      ],
    },
    {
      id: 'arch-layer-map',
      title: 'The layer map',
      lead:
        'Six directories under server/src, each with exactly one kind of job. This is the real tree — the demo at the bottom walks it live from the running server.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-layer-map:folders',
          body: `THE SIX DIRECTORIES, and the arrows between them. PRESENTATION/ is everything HTTP: routes as pure declarations (one makeExpressCallback(controller) line per verb), the framework-free controllers ring those lines delegate to, middleware (request-id first, error handler last), and the gRPC bridge — it TRANSLATES between transport and use cases and owns nothing the business cares about. DOMAIN/ is the business rules: use cases (validation, orchestration, failure policy), entities, and the PORTS — interfaces the domain owns and the outside world implements. DATA/ is persistence as implementations: the fake and sqlite post repositories, the optional mongo and redis services, the file store, the chat hub — each one implementing a port the domain defined, each translating its storage's dialect (rows, documents, replies) into domain shapes. CORE/ is deliberately NOT a layer but a toolbox every layer may use: the frozen AppConfig, the Result type, the ONE error taxonomy (failures + exceptions + guards), pino logging, the scenario store — cross-cutting primitives with no business opinion. DI/ holds exactly one file, the COMPOSITION ROOT (next sections) — the single place concrete implementations meet each other. CONTENT/ is this guide's own payload: the topic tree served as typed JSON — the app eating its own cooking, and a live demonstration that "the content is data, the rendering is presentation". THE ARROWS, previewing the next section: presentation → domain ← data. Domain imports from core only; data imports from domain (to implement ports) and core; presentation imports from domain and core and (for wiring) nothing in data — the container does that. Two files sit at the root by design: app.ts builds the Express pipeline without a socket (so Supertest can drive it), and server.ts owns the listening socket and the graceful-shutdown order — the bootstrap separated from the machinery it boots.`,
        },
        {
          kind: 'code',
          id: 'arch-layer-map:tree',
          language: 'bash',
          caption: 'The REAL tree (server/src, condensed — content/topics/ summarized at 38 files; the live demo returns the uncondensed walk)',
          code: `server/src/
├── app.ts                    # createApp(): the middleware chain + mounts (no socket)
├── server.ts                 # owns the listening socket + graceful shutdown
├── core/                     # CROSS-CUTTING PRIMITIVES (every layer may import)
│   ├── config/app_config.ts  #   frozen, validated AppConfig
│   ├── error_handling/       #   failures.ts + exceptions.ts + guards.ts — the ONE taxonomy
│   ├── logging/logger.ts     #   pino; dev-pretty vs prod-JSON
│   ├── result/result.ts      #   Result<T,E> — the domain's return contract
│   └── scenario/scenario.ts  #   runtime fake/live + failure-injection store
├── domain/                   # BUSINESS RULES (imports nothing from presentation/data)
│   ├── posts/                #   post_repository.ts (the PORT) + post_usecases.ts
│   ├── auth/  authz/         #   credentials, sessions, JWT; RBAC + identity resolution
│   ├── jobs/  i18n/          #   the hand-rolled job queue; locale negotiation
│   └── content/  demo/       #   the guide's content service; demo status service
├── data/                     # PERSISTENCE IMPLEMENTATIONS of the domain's ports
│   ├── posts/                #   fake_post_repository.ts | sqlite_post_repository.ts
│   │                         #   (+ post_dao.ts, sqlite_client.ts, seed_posts.ts)
│   ├── mongo/  redis/        #   optional services — lazy, gracefully off when unconfigured
│   └── caching/  files/  realtime/  migrations/
├── presentation/             # HTTP CONCERNS
│   ├── middleware/           #   request-id (first), error handler (last), cors, cookies…
│   ├── controllers/          #   the framework-free ring — httpRequest in, {status, body} out
│   ├── routes/               #   36 mounted routers — thin declarations + demo surfaces
│   └── grpc/                 #   the gRPC bridge (posts.proto + grpc_server.ts)
├── di/
│   └── container.ts          # THE COMPOSITION ROOT — the only place concretes meet
└── content/                  # THE GUIDE'S OWN PAYLOAD
    ├── registry.ts           #   validates ids at module load; serves the 38-topic tree
    ├── types.ts              #   topic → sections → blocks, typed
    └── topics/               #   38 topic files, one per nav slug (this screen included)`,
        },
      ],
    },
    {
      id: 'arch-dependency-rule',
      title: 'The dependency rule',
      lead:
        'One rule: source-code dependencies point INWARD. Presentation knows the domain; the domain knows neither of them. The ports live in the domain — the data layer drives to them.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-dependency-rule:inward',
          body: `THE RULE, stated once and then enforced everywhere: source-code dependencies point INWARD, toward the domain. Concretely in this repo: presentation/ imports domain/ (a route calls a use case); data/ imports domain/ (a repository implements a port); domain/ imports ONLY core/ (Result, failures) and itself. What never happens: a use case importing a router, a repository, or anything that knows HTTP exists; a controller importing better-sqlite3 or the DAO. THE CONSEQUENCE THAT MAKES IT WORTH IT: the domain is EXHAUSTIVELY testable without a socket, a database, or Express (the spec in section 1); the wire contract SURVIVES an implementation swap because both repositories satisfy the same port; and the same use case could serve gRPC, a queue consumer, or a CLI — indeed the GraphQL resolvers and the gRPC bridge in this very app reuse postsUseCase, and neither knows whether fake or sqlite answered. THE PORT PLACEMENT IS THE LOAD-BEARING DETAIL (the quote below is the real file): PostRepositoryPort — with its Result-returning methods and its CreatePostInput DTO — lives IN domain/posts/post_repository.ts. The domain does not adapt to the database; the database adapts to the domain. The fake repository (an in-memory array) and the sqlite repository (a DAO over better-sqlite3) both sit in data/posts/ as make* factories (makeFakePostRepository, makeSqlitePostRepository) returning FROZEN objects that satisfy PostRepositoryPort — the domain file could not care less that they exist. That is dependency INVERSION made physical: the interface owns the abstraction, so the volatile side (persistence choice) depends on the stable side (business rules), never the reverse.`,
        },
        {
          kind: 'code',
          id: 'arch-dependency-rule:verbatim-port',
          language: 'ts',
          caption: 'Verbatim — the whole port file (domain/posts/post_repository.ts), owned by the domain',
          source: 'server/src/domain/posts/post_repository.ts',
          code: `import type { Failure } from '../../core/error_handling/failures.js';
import type { Result } from '../../core/result/result.js';
import type { Post, PostDraft } from './post.js';

/**
 * What a create request must carry — the entity's draft under the port's
 * name, so the persistence contract can never drift from the entity's shape
 * (validatePostDraft has already proven it by the time it arrives here).
 */
export type CreatePostInput = PostDraft;

/**
 * The repository PORT, owned by the domain. Use cases depend on this interface
 * only; the data layer implements it (fake in-memory, sqlite) and the DI
 * container decides which implementation answers each call.
 */
export interface PostRepositoryPort {
  list(): Promise<Result<readonly Post[], Failure>>;
  findById(id: string): Promise<Result<Post, Failure>>;
  create(input: CreatePostInput): Promise<Result<Post, Failure>>;
}`,
        },
        {
          kind: 'code',
          id: 'arch-dependency-rule:verbatim-implementer-fake',
          language: 'ts',
          caption:
            'Verbatim — implementation #1 (data/posts/fake_post_repository.ts), a make* factory returning a FROZEN object; the store lives in the closure',
          source: 'server/src/data/posts/fake_post_repository.ts',
          code: `/**
 * Fake-mode PostRepositoryPort: a plain in-memory array seeded with the SAME
 * seed posts the sqlite client installs, so both modes teach identical data.
 * Async is simulated with an awaited microtask — the port is a Promise API no
 * matter how trivial the backing store, and callers can't cheat with sync
 * assumptions. A make* factory returning a FROZEN object; the store lives in
 * the closure.
 */
export function makeFakePostRepository(): PostRepositoryPort {
  const posts: Post[] = SEED_POSTS.map((post) => ({ ...post }));

  return Object.freeze({`,
        },
        {
          kind: 'code',
          id: 'arch-dependency-rule:verbatim-implementer-sqlite',
          language: 'ts',
          caption:
            'Verbatim — implementation #2, same shape (data/posts/sqlite_post_repository.ts): the DI container is the only caller and passes the DAO in',
          source: 'server/src/data/posts/sqlite_post_repository.ts',
          code: `/**
 * Live-mode PostRepositoryPort: sqlite via the DAO. A make* factory returning a
 * FROZEN object — the DI container is the only caller and passes the DAO in.
 */
export interface SqlitePostRepositoryDependencies {
  // …the LAZY dao SOURCE thunk — the database opens on first use…
  readonly dao: () => PostDao;
}

export function makeSqlitePostRepository({
  dao,
}: SqlitePostRepositoryDependencies): PostRepositoryPort {`,
        },
        {
          kind: 'text',
          id: 'arch-dependency-rule:near-miss',
          body: `THE RULE FIGHTS BACK — a real near-violation from this repo's own history, kept as a lesson. Building the authorization topic, the domain's identity resolver needed to read the SESSION COOKIE by name. The cookie's name constant lives in presentation/middleware/cookie_utils.ts (cookies are an HTTP concern — correct home). The resolver is domain. The tempting line was one import away: \`import { SESSION_COOKIE_NAME } from '../../presentation/middleware/cookie_utils.js'\` — tiny, harmless-looking, and a source dependency from domain to presentation, i.e. the rule broken in exactly the way that rots: not a big coupled subsystem, but a thousand "just this one constant" imports until the arrow points both ways. THE FIX CHOSEN HERE: the resolver scans the raw Cookie header LOCALLY (a plain string parse — no Express types, no cookie library) and declares its OWN mirrored constant, with a spec PINNING the two ends together so a rename in either file fails the suite instead of drifting silently. The quote below is the real comment in identity_resolver.ts. THE GENERAL LESSON it encodes: a dependency rule is not a document, it is an ENFORCEMENT PROBLEM — it will be tested by real convenience, weekly. Enforcement options that scale past this app's size: lint boundaries (dependency-cruiser / nx module boundaries fail CI on an illegal import), architecture tests (a spec that walks the import graph — this repo's mirrored-constant spec is the one-file version), and code review with the rule written down where reviewers actually look. When a rule and a real convenience collide, you either make the legal path as convenient (mirror + pin), or the illegal path wins by attrition.`,
        },
        {
          kind: 'code',
          id: 'arch-dependency-rule:verbatim-mirror',
          language: 'ts',
          caption: 'Verbatim — the mirrored constant, pinned by spec (domain/authz/identity_resolver.ts; cookieValue body abridged)',
          source: 'server/src/domain/authz/identity_resolver.ts',
          code: `/**
 * The session cookie's name, mirrored from presentation/middleware/cookie_utils.ts
 * (its presentation-side owner — this module is DOMAIN and must not import
 * from the presentation layer; the dependency arrow only points one way).
 * The two constants are pinned together by the spec that asserts both ends
 * agree, so a rename cannot drift silently.
 */
const SESSION_COOKIE_NAME = 'guide_session';

/** Extracts one cookie's value from a raw Cookie header (no attributes, no throws). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  // …plain string parsing — deliberately framework-free so this file keeps
  // zero imports from express…`,
        },
      ],
    },
    {
      id: 'arch-thin-controllers',
      title: 'Thin controllers',
      lead:
        'A controller does three things: parse input, call a use case, map the Result to a response. The whole posts controller fits on your screen — that is the point.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-thin-controllers:contract',
          body: `THE CONTRACT, in one line per step: PARSE/VALIDATE the transport input (route params, query, body — hand them to the use case RAW, because "is this a real post? is the title too long?" is business validation and lives in the domain), CALL exactly one use case, MAP the Result to HTTP (ok → status + JSON; failure → one typed exception via failureToException, and the error middleware owns everything after that). And because the controllers are FRAMEWORK-FREE — an httpRequest DTO in, a { status, body } out, never an Express import — one small adapter, makeExpressCallback, is the only code on this slice that touches req or res: it builds the DTO, awaits the controller, writes the response, and lets thrown exceptions ride next(err) into the error middleware. The files below are the ENTIRE posts edge, verbatim — the route declarations plus the controllers ring they mount (three controllers, each three lines of body) — and NOT ONE business decision among them: no length checks, no SQL fragments, no status-code arithmetic beyond "201 on create". Everything a controller does that is MORE than this is a smell with a name — fat controller, business logic in routes, "just this once" — and each one is a rule the next section's composition root cannot see. WHY THIN IS WORTH DEFENDING: because the controller is the ONLY layer that knows HTTP exists, keeping it trivial makes the domain portable (the GraphQL resolvers reuse postsUseCase and map the SAME failures to GraphQL error codes instead of HTTP statuses — same pipeline, different edge), and it makes the HTTP surface auditable (the OpenAPI drift-check specs can quote the routes because there is nothing else there). THE HONEST EXCEPTIONS in this very repo, named rather than hidden: a handful of DEMO routers bend the pattern deliberately — the routing topic's catalog endpoint serves a static ROUTING_DEMO_CATALOG of route patterns (its subject IS routing, so the route file is the exhibit), and the redis playground's routes read domain-adjacent shapes from a data-layer service (its subject IS the data tool) — the log records these as deliberate teaching deviations, not the pattern to copy. The jobs topic goes the other way on purpose: its report handler uses a STATIC teaching fixture rather than reaching into the container, because wiring the container into domain code would invert the layering — the honest trade stated where it is made.`,
        },
        {
          kind: 'code',
          id: 'arch-thin-controllers:verbatim-routes',
          language: 'ts',
          caption:
            'Verbatim — the thin route declarations (presentation/routes/posts_routes.ts): each verb is one makeExpressCallback(controller) line',
          source: 'server/src/presentation/routes/posts_routes.ts',
          code: `import { Router } from 'express';
import { getContainer } from '../../di/container.js';
import { makeExpressCallback } from './make_express_callback.js';
import { makePostsControllers } from '../controllers/posts_controllers.js';

/**
 * Posts API — the canonical vertical slice (route → controller → use case →
 * repository):
 * - GET  /api/posts       → { posts }
 * - GET  /api/posts/:id   → post
 * - POST /api/posts       → 201 + created post
 *
 * The routes are now pure declarations: each verb is one
 * makeExpressCallback(controller) line. The controllers (framework-free, in
 * presentation/controllers) are composed HERE from the container's use case —
 * the dependency thunks re-read getContainer() per call, exactly like the
 * inline controllers they replace, so resetContainer() and runtime scenario
 * switches keep answering on the very next request. Routes and controllers
 * only ever see the use case — never the data layer.
 */
const postsControllers = makePostsControllers({
  listPosts: () => getContainer().postsUseCase.list(),
  getPost: (id) => getContainer().postsUseCase.getById(id),
  createPost: (raw) => getContainer().postsUseCase.create(raw),
});

export const postsRouter = Router();
postsRouter
  .route('/posts')
  .get(makeExpressCallback(postsControllers.list))
  .post(makeExpressCallback(postsControllers.create));
postsRouter.route('/posts/:id').get(makeExpressCallback(postsControllers.detail));`,
        },
        {
          kind: 'code',
          id: 'arch-thin-controllers:verbatim-controllers',
          language: 'ts',
          caption:
            'Verbatim — the controllers ring those lines mount (presentation/controllers/posts_controllers.ts), the whole file',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `import type { Failure } from '../../core/error_handling/failures.js';
import { failureToException } from '../../core/error_handling/exceptions.js';
import type { Result } from '../../core/result/result.js';
import type { Post } from '../../domain/posts/post.js';
import type { Controller, HttpRequest, HttpResponse } from '../routes/make_express_callback.js';

/**
 * Posts controllers — the framework-free ring between routes and use cases.
 * Each controller receives the httpRequest DTO (never req/res), calls exactly
 * ONE use case, and maps the Result to { status, body } — or throws the typed
 * AppException for the error middleware. No business logic lives here:
 * validation belongs to the use case, envelope rendering to the middleware.
 */

/** The use-case surface the posts controllers depend on (injected, frozen in). */
export interface PostsControllerDependencies {
  readonly listPosts: () => Promise<Result<readonly Post[], Failure>>;
  readonly getPost: (id: unknown) => Promise<Result<Post, Failure>>;
  readonly createPost: (raw: unknown) => Promise<Result<Post, Failure>>;
}

export function makePostsControllers({
  listPosts,
  getPost,
  createPost,
}: PostsControllerDependencies) {
  return Object.freeze({
    /** GET /api/posts → 200 { posts } */
    async list(_httpRequest: HttpRequest): Promise<HttpResponse> {
      const result = await listPosts();
      if (!result.ok) throw failureToException(result.error);
      return { status: 200, body: { posts: result.value } };
    },

    /** GET /api/posts/:id → 200 post */
    async detail(httpRequest: HttpRequest): Promise<HttpResponse> {
      const result = await getPost(httpRequest.params.id);
      if (!result.ok) throw failureToException(result.error);
      return { status: 200, body: result.value };
    },

    /** POST /api/posts → 201 created post */
    async create(httpRequest: HttpRequest): Promise<HttpResponse> {
      const result = await createPost(httpRequest.body);
      if (!result.ok) throw failureToException(result.error);
      return { status: 201, body: result.value };
    },
  });
}

export type PostsControllers = ReturnType<typeof makePostsControllers>;
export type PostsController = Controller;`,
        },
      ],
    },
    {
      id: 'arch-composition-root',
      title: 'The composition root',
      lead:
        'One file where the concretes meet. The container constructs everything, decides fake vs live per call, and is the only module that knows both repositories exist.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-composition-root:one-place',
          body: `WHAT "COMPOSITION ROOT" MEANS: every object graph needs a place where abstract names become concretes — where \`PostRepositoryPort\` becomes the sqlite repository. Put that place EVERYWHERE and you have wiring smeared across the codebase (every route constructing its own dependencies, config read from random modules, testability by monkey-patching); put it in exactly ONE module and you can read the whole system's shape in one screen. That module is di/container.ts, quoted whole below — note what it does NOT contain: no business logic, no HTTP, no SQL. Just construction and wiring: classes where a class is the honest shape (the services), make* factories where a frozen object is (the posts slice), and VENDOR adapters where a third party is involved — this is the only module in the app that imports nodemailer: the email domain receives its transporter through a port it owns, and the content service likewise receives the registry's lookup functions, so domain code constructs no infrastructure of its own. THE CLEVEREST FIVE LINES are the selector: the posts use case does not receive a repository, it receives a SELECTOR — \`() => PostRepositoryPort\` — and the closure reads the LIVE scenarioStore on every call. That is how this app flips fake ↔ live and injects failures from a PATCH endpoint with NO restart and NO container rebuild: the wiring decision is re-evaluated per use-case invocation, so the very next request answers in the new mode (the demo at the bottom reports which mode answered). The container also exposes the store itself rather than a snapshot, and a resetContainer() for rebuilds in tests. WHY MANUAL BEATS A FRAMEWORK at this size, honestly: the whole container is ~30 lines of plain constructors and factory calls — it type-checks, it stacks, it debugs with a breakpoint, and reading it teaches you the system. A decorator-based DI framework (tsyringe, InversifyJS) or a NestJS module system earns its keep when the graph grows past what one screen holds: dozens of services with LIFECYCLE (singletons vs transient vs request-scoped), conditional wiring by environment, and interception (the moment you want a logging decorator around every service method, hand-rolled wiring gets tedious). The tell that it is time: your composition root starts needing its own tests. Until then, every line of DI framework is a dependency to learn, upgrade, and explain — for machinery the language already gives you (\`new\`, or a plain make* function call).`,
        },
        {
          kind: 'code',
          id: 'arch-composition-root:verbatim-container',
          language: 'ts',
          caption: 'Verbatim — the entire composition root (di/container.ts)',
          source: 'server/src/di/container.ts',
          code: `import nodemailer from 'nodemailer';
import { scenarioStore, type ScenarioStore } from '../core/scenario/scenario.js';
import { DemoService } from '../domain/demo/demo_service.js';
import { ContentService } from '../domain/content/content_service.js';
import { makePostsUseCase, type PostsUseCase } from '../domain/posts/post_usecases.js';
import type { PostRepositoryPort } from '../domain/posts/post_repository.js';
import { makeFakePostRepository } from '../data/posts/fake_post_repository.js';
import { makeSqlitePostRepository } from '../data/posts/sqlite_post_repository.js';
import { PostDao } from '../data/posts/post_dao.js';
import { getSqlite } from '../data/posts/sqlite_client.js';
import { EmailService } from '../domain/email/email_service.js';
import { getTopicById, getTopicSummaries } from '../content/registry.js';

/**
 * Composition root: the single place where dependencies are constructed and
 * wired — the ONE caller of every make* factory. The fake/live data switch
 * reads the scenario store HERE — no other module decides wiring. The store is
 * exposed directly (not a snapshot of its state) so reads are always current.
 */
export interface Container {
  readonly scenarioStore: ScenarioStore;
  readonly demoService: DemoService;
  readonly contentService: ContentService;
  readonly postsUseCase: PostsUseCase;
  /**
   * The third-party topic's email boundary. The domain owns only the
   * transporter PORT — this file is the ONLY module that imports nodemailer:
   * "which transport" is wiring, not domain logic, so the vendor appears in
   * exactly one place. The jsonTransport instance constructed below is the
   * whole of the app's email infrastructure; swap it for
   * createTransport({ host, port, auth }) and no consumer changes.
   */
  readonly emailService: EmailService;
}

function buildContainer(): Container {
  // Both Post repositories exist up front; which one answers a call is decided
  // per use-case invocation from the CURRENT scenario state, so toggling
  // dataMode at runtime needs no container rebuild. The sqlite repository gets
  // a LAZY dao source — the database still opens only on the first live query,
  // so building it here costs nothing.
  const fakePostRepository = makeFakePostRepository();
  const sqlitePostRepository = makeSqlitePostRepository({ dao: () => new PostDao(getSqlite()) });
  const selectPostRepository = (): PostRepositoryPort =>
    scenarioStore.get().dataMode === 'live' ? sqlitePostRepository : fakePostRepository;

  // The only nodemailer construction in the app: jsonTransport runs the full
  // message pipeline and returns JSON instead of opening a socket. The domain
  // service receives it through its transporter port, vendor-blind.
  const emailTransporter = nodemailer.createTransport({ jsonTransport: true });

  return {
    scenarioStore,
    demoService: new DemoService(scenarioStore),
    // The content domain names its topic-lookup port; the registry functions
    // are supplied HERE — the domain file never imports the registry module.
    contentService: new ContentService({ topics: { getTopicById, getTopicSummaries } }),
    postsUseCase: makePostsUseCase({ selectRepository: selectPostRepository, scenarioStore }),
    emailService: new EmailService({ transporter: emailTransporter }),
  };
}

let current: Container | undefined;

/** Memoized singleton container. */
export function getContainer(): Container {
  current ??= buildContainer();
  return current;
}

/** Drops the memoized container so the next getContainer() rebuilds the wiring. */
export function resetContainer(): void {
  current = undefined;
}`,
        },
      ],
    },
    {
      id: 'arch-errors',
      title: 'Errors across the layers',
      lead:
        'Result inside, exceptions at the edge, one envelope out. Each layer fails in its native idiom, and exactly one bridge translates between them.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-errors:three-worlds',
          body: `THE THREE IDIOMS, layer by layer. INSIDE THE DOMAIN AND DATA LAYERS, nothing throws for expected failures — use cases and repositories return \`Result<T, Failure>\`, the discriminated union you met in the TypeScript topic: an ok-carrying value or a typed failure (validation, not_found, conflict, unavailable, internal…), with the failure kind deciding everything downstream. WHY: Results are values — they flow through maps, they are exhaustively checked by the compiler, and a use case CANNOT accidentally forget one the way a caller forgets to catch. AT THE EDGE — and only there — the controller converts a failure into a typed exception via failureToException and THROWS, because Express's error pipeline is exception-shaped. The bridge (quoted below) is a pure lookup: every FailureKind maps to one exception class, and each exception carries its failure; statusCode and code are derived from the ONE table in failures.ts, which is why status codes are decided in exactly two places in this app (controllers pick 200/201; the taxonomy picks everything else). OUT THE DOOR, the error middleware — registered last, after the 404 catch-all — catches whatever was thrown (typed AppExceptions, plain Errors from third-party code, body-parser rejects), logs one structured line with the REQUEST ID, and shapes every one of them into the same JSON envelope: { code, message, requestId, …details }. The exception-handling topic dissects that pipeline end to end (the envelope, the correlation triangle, the two-worlds Result-vs-throw demo); the architectural point is the SHAPE of the translation: expected failures never exist as exceptions below the controller, and the controller never invents a status code — one idiom per layer, one bridge, one envelope. THE TRACER DEMO at the bottom lets you WATCH the middle of this: flip failure injection on and re-run it — the use-case bar still measures honestly, the repository bar reports "short-circuited", and the failure rides out in the trace payload the way it would ride out in the envelope on the real endpoint.`,
        },
        {
          kind: 'code',
          id: 'arch-errors:verbatim-bridge',
          language: 'ts',
          caption: 'Verbatim — AppException with its derived getters, the kind table, and the one-way converter (core/error_handling/exceptions.ts; the eight exception subclasses above it are one constructor line each)',
          source: 'server/src/core/error_handling/exceptions.ts',
          code: `export class AppException extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    this.name = new.target.name;
  }

  get statusCode(): number {
    return FAILURE_HTTP_STATUS[this.failure.kind];
  }

  get code(): string {
    return FAILURE_ERROR_CODE[this.failure.kind];
  }
}

const EXCEPTION_BY_KIND: Readonly<
  Record<
    FailureKind,
    new (message: string, details?: Record<string, unknown>, cause?: unknown) => AppException
  >
> = {
  validation: ValidationException,
  unauthorized: UnauthorizedException,
  forbidden: ForbiddenException,
  not_found: NotFoundException,
  conflict: ConflictException,
  rate_limited: RateLimitException,
  unavailable: UnavailableException,
  internal: InternalException,
};

/** Converts any Failure into the matching exception, for throwing at the HTTP edge. */
export function failureToException(source: Failure): AppException {
  return new EXCEPTION_BY_KIND[source.kind](source.message, source.details, source.cause);
}`,
        },
      ],
    },
    {
      id: 'arch-client-mirror',
      title: "The client's mirror of the rule",
      lead:
        "The React client obeys the same law pointed the other way: views never import DTOs. The data layer's remote sources are the browser-side edge, and most screens are pure presentation of server-driven content.",
      blocks: [
        {
          kind: 'text',
          id: 'arch-client-mirror:rule',
          body: `THE SAME RULE, CLIENT-SIDE: the dependency arrow points away from the UI framework. Concretely, in this repo's client (clean-architecture layers, mirroring the react guide): A VIEW NEVER IMPORTS A DTO. Screen components (client/src/ui/views/) resolve use cases from the container and render domain models; they never shape wire payloads — the remote data sources and DTOs under client/src/data/remote/ are the ONLY modules that know a URL or a response body exists (http-client.ts owns fetch itself), exactly as the server's controllers are the only modules that know HTTP exists. The quote below is the DTO module's own header — the seam stated in its first comment: the content API's wire format was designed to match the domain models 1:1, and the top-level DTO interfaces are the only place wire and domain may diverge (the client mirrors the server's shapes by hand rather than importing them — the two packages share no module boundary). Note the discipline that keeps the mirror honest: every payload is VALIDATED at the boundary — the DTO parse functions run each field through requiredString / requiredArray / requiredNumber and throw typed exceptions on shape violation — and the repository implementation wraps every call so an expected failure (network down, error envelope, malformed payload) arrives as a Result wrapping a typed Failure: the data-layer methods never throw. The Result-at-the-edge idea, transposed: expected failures are VALUES in the client too. THE STRONGEST FORM of client-as-pure-presentation is the screen you are reading. TopicView (client/src/ui/views/topic/) is a GENERIC renderer: it takes any topic id, fetches topic → sections → blocks from the content API, and maps each block kind to a presenter — TextBlock, CodeBlock, or a DemoHost that resolves a demo id against a lazy registry. THIS SCREEN shipped zero client view code: the Architecture topic was written as server-side content (the file you are quoted from throughout), and the client renders it because rendering is all it does. The one place the client genuinely programs is the demos — interactive components with their own state that fetch their endpoints DIRECTLY (a deliberate, documented deviation: they are teaching widgets over the API, not consumers of the domain pipeline) — and even they degrade to an error strip, never a crash, when a payload is malformed. THE PAYOFF mirrors the server's: content changes deploy without rebuilding the client; a view is testable with a stubbed repository; and the "who owns what" question has the same one-line answer on both sides of the wire.`,
        },
        {
          kind: 'code',
          id: 'arch-client-mirror:verbatim-api',
          language: 'ts',
          caption:
            "Verbatim — the seam's stated contract and its boundary validation (client/src/data/remote/dtos/content-dto.ts)",
          source: 'client/src/data/remote/dtos/content-dto.ts',
          code: `/**
 * ContentDTOs — the wire/transport shapes of the content API, responsible for
 * (de)serialization and mapping to the domain models. Mirrors the react
 * guide's \`PostDTO\` (the Flutter \`PostDTO\`), trimmed to this client's needs.
 *
 * The content API's wire format was designed to match the domain models 1:1 —
 * nested shapes (groups, summaries, sections, blocks) validate directly into
 * the domain types, and only the top-level DTO interfaces exist as the seam
 * where wire and domain may diverge.
 */

export interface ContentIndexDto {
  version: number;
  groups: TopicGroup[];
  topics: TopicSummary[];
}

/**
 * Deserialize + validate the GET /api/content payload. Throws on any shape
 * violation (see validate.ts) so bad server data surfaces as a typed
 * InvalidResponseException instead of propagating NaN orders or
 * "[object Object]" titles into the UI.
 */
export function contentIndexDtoFromJson(body: unknown): ContentIndexDto {
  if (!isRecord(body)) throw new Error('content index must be an object');
  return {
    version: requiredNumber(body, 'version'),
    groups: requiredArray(body, 'groups').map(topicGroupFromJson),
    topics: requiredArray(body, 'topics').map(topicSummaryFromJson),
  };
}`,
        },
      ],
    },
    {
      id: 'arch-tracer-intro',
      title: 'Request-flow tracer',
      lead:
        'A request\'s real journey, timed at every hop. The demo below runs THIS request through the actual layers — no simulation, honest bars.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-tracer-intro:how',
          body: `WHAT THE DEMO DOES when you press run: the endpoint GET /api/demo/arch/trace handles ITS OWN request as the specimen. The request-id middleware — mounted first in app.ts — stamps TWO things on res.locals: the UUID (this trace\'s requestId, which is why it always matches the x-request-id response header) and, since this topic shipped, a performance.now() START STAMP (a three-line, fully backwards-compatible addition to request_id_middleware.ts that makes every request self-timing). The route then measures the pre-route span (middleware stamp → route entry: request-id + helmet + JSON parse), the controller\'s translation work, and — the core of the exhibit — calls the REAL container\'s postsUseCase.list() between timing marks: the same call GET /api/posts makes, in the mode the scenario store currently says. HONESTY ABOUT THE BARS, because a lying tracer is worse than none: the USE-CASE bar includes the repository call (that is what a use case IS — for a list: injection check, repository selection, persistence through the port); the selector bar beneath it re-times the exact scenarioStore read the container\'s closure performs, in isolation; and the repository bar is DERIVED — the use-case total minus the measured selector read — attribution, labeled as such, not a second measurement. The serialization bar measures the real JSON.stringify work res.json does for the posts payload. Every bar\'s note in the UI says what it actually measured. Flip the scenario to live (or inject a failure) and re-run: the mode chip changes, the sqlite path (or the short-circuit) appears in the notes, and the requestId is fresh — a new request, a new trace. The second panel is the FOLDER MAP, live: GET /api/demo/arch/folders walks the RUNNING server\'s own src/ tree at request time (three levels deep, the six top-level purposes kept by hand beside it) — the map from section 2, provably not a stale diagram.`,
        },
      ],
    },
    {
      id: 'arch-live',
      title: 'See it live (the tracer + the folder map)',
      lead:
        'Trace a request through the real layers, then explore the very source tree that served it — both from the running server.',
      blocks: [
        {
          kind: 'text',
          id: 'arch-live:intro',
          body: `THE CONSOLE BELOW has two panels. THE TRACER: press "trace a request" and the vertical timeline lights up — six layer cards in order, each with a bar scaled against the slowest hop, the mode + requestId chips, and the total line. Run it in fake mode, PATCH the scenario to live, run it again: the same six bars, a different repository note, sub-millisecond versus real sqlite query cost. Turn failure injection ON and the domain\'s gate becomes visible — the use-case bar measures the short-circuit and the repository bar honestly says it never ran. THE FOLDER MAP: the six directories with their purposes, each expandable one level — rendered from a live filesystem walk of the server\'s own src, so what you see is what is running. THE ARCHITECTURAL MORAL of both panels: nothing here is a mock-up of layered architecture — it is the architecture, measured and walked at runtime. If the bars ever stop matching the story (a repository bar dominating every trace, a controller bar mysteriously wide), that is not the demo being wrong — that is the layers telling you where the time actually went, which is the tracer\'s real job in production systems (per-span tracing, request-scoped timing) in miniature.`,
        },
        {
          kind: 'demo',
          id: 'arch-live:tracer-demo',
          demoId: 'arch:tracer',
          title: 'The request-flow tracer + live folder map',
          description:
            'TRACER: a real request run through the actual layers — request-id middleware, thin controller, the container\'s real postsUseCase.list() — with per-layer timings (the repository bars honestly attributed as sub-spans of the use-case call), mode + requestId chips, and the total. FOLDER MAP: the running server\'s own src/ tree walked live, three levels deep, with the hand-kept purpose legend. Flip the scenario and re-trace to watch the mode change.',
        },
        {
          kind: 'code',
          id: 'arch-live:curl',
          language: 'bash',
          caption: 'The same exhibits from a terminal',
          code: `# Trace a request through the real pipeline (six layers, honest notes):
curl -s localhost:4000/api/demo/arch/trace | jq '{mode, requestId, postCount, totalMs}'
curl -s localhost:4000/api/demo/arch/trace | jq '.trace[] | {layer, ms}'

# The requestId in the trace IS this request's — verify against the header:
curl -si localhost:4000/api/demo/arch/trace | grep -i x-request-id

# Switch the repository under the trace (no restart — per-call selector):
curl -s -X PATCH localhost:4000/api/demo/scenario \\
  -H 'content-type: application/json' -d '{"dataMode":"live"}' | jq
curl -s localhost:4000/api/demo/arch/trace | jq '{mode, totalMs}'

# And the domain's gate — inject a failure, watch the repository bar
# report "short-circuited" and the failure ride the trace payload:
curl -s -X PATCH localhost:4000/api/demo/scenario \\
  -H 'content-type: application/json' -d '{"injectFailure":true}' | jq
curl -s localhost:4000/api/demo/arch/trace | jq '{postCount, failure}'

# The folder map — the running server's own tree, walked live:
curl -s localhost:4000/api/demo/arch/folders | jq '.purposes'
curl -s localhost:4000/api/demo/arch/folders \\
  | jq '.tree[] | select(.name=="presentation") | .children[].name'`,
        },
      ],
    },
  ],
};
