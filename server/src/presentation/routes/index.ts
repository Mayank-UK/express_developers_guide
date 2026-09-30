import { Router } from 'express';
import { healthRouter } from './health_routes.js';
import { demoRouter } from './demo_routes.js';
import { nodeDemoRouter } from './node_demo_routes.js';
import { httpDemoRouter } from './http_demo_routes.js';
import { routingDemoRouter } from './routing_demo_routes.js';
import { middlewareDemoRouter } from './middleware_demo_routes.js';
import { reqresDemoRouter } from './reqres_demo_routes.js';
import { validationDemoRouter } from './validation_demo_routes.js';
import { graphqlDemoRouter } from './graphql_demo_routes.js';
import { webhooksDemoRouter } from './webhooks_demo_routes.js';
import { grpcDemoRouter } from './grpc_demo_routes.js';
import { dbDemoRouter } from './db_demo_routes.js';
import { sqlDepthDemoRouter } from './sql_depth_demo_routes.js';
import { mongoDemoRouter } from './mongo_demo_routes.js';
import { redisDemoRouter } from './redis_demo_routes.js';
import { messagingDemoRouter } from './messaging_demo_routes.js';
import { cachingDemoRouter } from './caching_demo_routes.js';
import { authDemoRouter } from './auth_demo_routes.js';
import { authzDemoRouter } from './authz_demo_routes.js';
import { oauthDemoRouter } from './oauth_demo_routes.js';
import { securityDemoRouter } from './security_demo_routes.js';
import { securityPiiDemoRouter } from './security_pii_demo_routes.js';
import { filesDemoRouter } from './files_demo_routes.js';
import { i18nDemoRouter } from './i18n_demo_routes.js';
import { realtimeDemoRouter } from './sse_demo_routes.js';
import { jobsDemoRouter } from './jobs_demo_routes.js';
import { patternsDemoRouter } from './patterns_demo_routes.js';
import { depsDemoRouter } from './deps_demo_routes.js';
import { envDemoRouter } from './env_demo_routes.js';
import { archDemoRouter } from './arch_demo_routes.js';
import { obsDemoRouter } from './obs_demo_routes.js';
import { testingDemoRouter } from './testing_demo_routes.js';
import { deployDemoRouter } from './deploy_demo_routes.js';
import { perfDemoRouter } from './perf_demo_routes.js';
import { reliabilityDemoRouter } from './reliability_demo_routes.js';
import { scalingDemoRouter } from './scaling_demo_routes.js';
import { bestDemoRouter } from './best_practices_demo_routes.js';
import { thirdPartyDemoRouter } from './third_party_demo_routes.js';
import { contentRouter } from './content_routes.js';
import { postsRouter } from './posts_routes.js';

/**
 * The single API router, mounted at /api by src/app.ts.
 * Health is a pure liveness check; demo routes prove the error envelope and
 * toggle the runtime scenario; node demo routes power the node-js topic's
 * event-loop and streaming experiments; http demo routes power the http-web
 * topic's request-inspection and content-negotiation experiments; routing
 * demo routes power the routing topic's route explorer (and serve the catalog
 * the explorer renders); middleware demo routes power the middleware topic's
 * pipeline visualizer; reqres demo routes power the request-response topic's
 * request inspector and response-methods playground; validation demo routes
 * power the validation topic's three-validator arena; graphql demo routes
 * serve the graphql topic's real POST /api/graphql endpoint (schema + handler
 * over the same posts use case REST uses); webhooks demo routes power the
 * webhooks topic's flight simulator (receiver + sender roles, HMAC-signed);
 * grpc demo routes are the HTTP bridge that lets a browser drive the grpc
 * topic's real guide.v1.PostsService (status + invoke relays); db demo routes
 * power the sql topics' in-memory sqlite experiments (schema explorer, query
 * plans, the real migration runner, injection + transaction proofs); sql
 * depth demo routes power the advanced-SQL topics' exhibits on a migrated
 * in-memory handle (recursive CTE / window / rollup queries with their SQL,
 * the index-vs-expression EXPLAIN pair, FTS5 bm25 search vs LIKE, the
 * check-then-act booking race vs the atomic guarded UPDATE, UUIDv7-vs-v4 key
 * batches, and the transactional audit trail); mongo
 * demo routes power the mongodb topic's optional-service console (event CRUD
 * over the lazy mongoose connection, TTL index status, graceful 503s); redis
 * demo routes power the redis topic's playground (structure tour, TTL
 * countdown, and pub/sub over a real second connection — same graceful 503
 * contract); messaging demo routes power the messaging topics' exhibits (the
 * Redis stream lab — XADD produce with MAXLEN trimming, consumer-group
 * consume with ack/pending/XAUTOCLAIM reclaim/DLQ — and the transactional
 * outbox, its enqueue half pure sqlite, its relay proving at-least-once via
 * crashAfterPublish over the same optional redis); caching
 * demo routes power the caching topic's lab (the etag +
 * conditional-request asset, the cache-aside query with hits/misses/store
 * reporting, explicit invalidation, and the stampede comparison — redis when
 * the optional service is live, an honest in-process Map otherwise); auth
 * demo routes power the authentication topic's login flow and API-key demos
 * (hand-rolled sessions with an HttpOnly cookie, the live session list, and
 * scope-checked x-api-key endpoints) and the JWT issue/verify/protected
 * endpoints; oauth demo routes are the authentication topic's local
 * authorization server (SSR consent page, single-use authorization codes, the
 * spec-shaped token endpoint, and a Bearer-JWT userinfo resource); authz demo
 * routes power the authorization topic's permission matrix (RBAC middleware
 * and ownership guards over owned documents, with identity resolvable from
 * any of the three credential families); security demo routes power the
 * security topic's lab (the headers echo under real helmet, the
 * express-rate-limited /ping and its handmade fixed-window twin, the
 * allowlist CORS check + preflight probe, the injection catalog, and the
 * ssrf-guard verdict endpoint); security PII demo routes (a sibling file on
 * the same mount) power the security topic's GDPR lab — the right-of-access
 * export, crypto-shred anonymization that KEEPS the row and its order links,
 * and the erasure log; files demo routes power the files-media
 * topic's workbench (the multer upload with its full validation stack,
 * downloads, the hand-rolled range streamer, the backpressure-honest
 * pipeline, and the live path-containment guard); i18n demo routes power
 * the internationalization topic's negotiator (the supported-locale
 * registry, explicit per-locale message payloads with deterministic
 * frozen-instant Intl samples, and real Accept-Language negotiation with
 * Vary: Accept-Language); realtime demo routes power the realtime topic's
 * push surfaces (the Server-Sent Events ticker feed with Last-Event-ID
 * replay, its observable status counters, and the WebSocket chat hub's HTTP
 * sidecar — the hub itself upgrades outside Express, wired by server.ts);
 * jobs demo routes power the background-jobs topic's job console (the
 * hand-rolled in-process queue in domain/jobs: enqueue with failure
 * injection, the retry/backoff/dead-letter lifecycle, dead-job replay, the
 * scheduler toggle, and the stats strip); patterns demo routes power the
 * advanced-architecture topics' exhibits (the event store — optimistic
 * concurrency, fold-based replay, snapshots, overdraft rejected at append,
 * projections rebuilt on demand — and the order saga running its forward
 * steps and reverse compensations on the jobs queue's real retry/DLQ
 * semantics); deps demo routes power the
 * dependency-management topic's manifest inspector (the server's own
 * package.json + package-lock.json read at runtime — wanted ranges, resolved
 * pins, and the transitive-package count the lockfile heuristic reports); env
 * demo routes power the environments topic's config inspector (the frozen
 * AppConfig + process facts + a masked environment view whose secret-shaped
 * names and credential-bearing URLs never render values); arch demo routes
 * power the architecture topic's request-flow tracer (a real GET
 * /api/posts-equivalent pipeline timed per layer, honestly attributing the
 * repository sub-spans) and its live folder map (the server's own src/ tree
 * walked at runtime, with the hand-kept purpose legend); obs demo routes
 * power the observability topic's log viewer (the in-memory pino ring with
 * level filtering), its hand-rolled metrics strip (uptime, memory, a real
 * event-loop delay histogram, request counters), and its readiness-shaped
 * health probe over the optional-service states — plus the make-noise burst
 * that fills the ring on demand; testing demo routes power the testing
 * topic's in-app runner (a curated twelve-case suite executed against this
 * app's own pure modules on every request, with an inject-a-failure knob
 * proving the harness reports failures honestly); deploy demo routes power
 * the deployment topic's stack explorer (the live process facts of the
 * server you are talking to, plus the services declared by this repo's two
 * compose files, parsed off disk with a tolerant heuristic); perf demo routes
 * power the performance topic's benchmark pair (a deterministic compressible
 * telemetry payload served through route-scoped compression — negotiated
 * encoding vs ?noCompress identity — and the server-side median timings of
 * serialization with and without gzip); reliability demo routes power the
 * reliability topic's watchable circuit breaker (a real breaker around a
 * flaky dependency you can steer: fail it open, watch calls bounce off the
 * open circuit in ~0ms, let the cooldown lapse, and heal it with half-open
 * probes); scaling demo routes power the scaling topic's process-state
 * inspector (this app's OWN statelessness inventory with live counts —
 * sessions, limiter windows, queue depth, SSE connections — each hazard
 * with its fix, beside the already-shared stores); best demo routes power
 * the best-practices topic's self-audit (the running app checks itself
 * against the checklist: real headers via self-fetch, real process
 * listeners, a real source-grep of the DAO — and grades the result); third
 * party demo routes power the third-party services topic's hub — the REAL
 * nodemailer jsonTransport email adapter (messages captured, never sent), a
 * Stripe-shaped payments MOCK (PaymentIntent lifecycle with test-card
 * outcomes, every response labeled mock), and a REAL HMAC presign ceremony
 * whose uploads land in the files topic's store;
 * content routes
 * serve the
 * topic tree the client renders; posts routes are the canonical layered
 * pipeline demo.
 */
export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(demoRouter);
apiRouter.use(nodeDemoRouter);
apiRouter.use(httpDemoRouter);
apiRouter.use(routingDemoRouter);
apiRouter.use(middlewareDemoRouter);
apiRouter.use(reqresDemoRouter);
apiRouter.use(validationDemoRouter);
apiRouter.use(graphqlDemoRouter);
apiRouter.use(webhooksDemoRouter);
apiRouter.use(grpcDemoRouter);
apiRouter.use(dbDemoRouter);
apiRouter.use(sqlDepthDemoRouter);
apiRouter.use(mongoDemoRouter);
apiRouter.use(redisDemoRouter);
apiRouter.use(messagingDemoRouter);
apiRouter.use(cachingDemoRouter);
apiRouter.use(authDemoRouter);
apiRouter.use(authzDemoRouter);
apiRouter.use(oauthDemoRouter);
apiRouter.use(securityDemoRouter);
apiRouter.use(securityPiiDemoRouter);
apiRouter.use(filesDemoRouter);
apiRouter.use(i18nDemoRouter);
apiRouter.use(realtimeDemoRouter);
apiRouter.use(jobsDemoRouter);
apiRouter.use(patternsDemoRouter);
apiRouter.use(depsDemoRouter);
apiRouter.use(envDemoRouter);
apiRouter.use(archDemoRouter);
apiRouter.use(obsDemoRouter);
apiRouter.use(testingDemoRouter);
apiRouter.use(deployDemoRouter);
apiRouter.use(perfDemoRouter);
apiRouter.use(reliabilityDemoRouter);
apiRouter.use(scalingDemoRouter);
apiRouter.use(bestDemoRouter);
apiRouter.use(thirdPartyDemoRouter);
apiRouter.use(contentRouter);
apiRouter.use(postsRouter);
