import type { Topic } from '../types.js';

/**
 * The Best Practices topic — the CAPSTONE. It is deliberately a checklist,
 * not new material: every item points BACK at the topic in this guide that
 * demonstrates it (or, in a few named places, honestly doesn't). The live
 * demo is a self-audit: the running app checks itself — real headers via a
 * self-fetch, real process listeners, a real fs heuristic over its own DAO —
 * and grades the checklist live.
 */
export const topicBestPractices: Topic = {
  id: 'best-practices',
  title: 'Best Practices',
  subtitle: 'The senior backend checklist, distilled.',
  group: 'platform',
  order: 12,
  sections: [
    {
      id: 'best-project-setup',
      title: 'Project setup',
      lead:
        'Strict TypeScript, one command to run, one to test, layers from day one — because retrofitting any of them costs ten times the price.',
      blocks: [
        {
          kind: 'text',
          id: 'best-project-setup:strict-and-commands',
          body: `STRICT FROM THE START. TypeScript with \`strict\` on (this repo: strict, noUncheckedIndexedAccess — the config the environments topic quotes) catches at write-time the null/undefined bugs that otherwise surface as prod incidents; turning it on LATER means fixing a thousand errors at once, which is why teams never do. ESM (\`"type": "module"\`) with explicit \`.js\` import specifiers — the tree this guide runs on — keeps you on Node's native path instead of a bundler shim. VALIDATED CONFIG, not process.env reads scattered through the codebase: the config module parses and freezes ONCE (app_config: dotenv, defaults, NODE_ENV mapping), so a malformed env var fails at BOOT with a name, not at request 4,000 with a NaN. ONE COMMAND TO RUN, ONE TO TEST: \`npm run dev\` and \`npm test\` work from a clean checkout with no ceremony — the DX rule that quietly determines whether people actually run the thing. LAYERING FROM DAY ONE (the architecture topic): routes → use cases → repositories, dependencies pointing ONE way. The anti-pattern is "we'll add structure when it gets big" — code without a dependency rule grows until refactoring it costs more than the feature, and the day-one version costs nothing.`,
        },
        {
          kind: 'code',
          id: 'best-project-setup:config-quote',
          language: 'ts',
          caption:
            'The app\u2019s own shape — parsed, validated, frozen once (core/config/app_config.ts, abridged)',
          source: 'server/src/core/config/app_config.ts',
          code: `// Config is read ONCE, validated, and frozen — every later consumer
// imports the same immutable object; nobody re-parses env mid-request.
export function createAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isTestRun = env.NODE_ENV === 'test';
  const nodeEnv = resolveNodeEnv(env.NODE_ENV);

  // Loads \`.env.\${nodeEnv}\` from the package root (cwd when run via npm scripts).
  dotenv.config({ path: path.resolve(process.cwd(), \`.env.\${nodeEnv}\`) });

  return Object.freeze({
    port: parsePort(env.PORT, 'PORT', 4000),
    // …grpcPort, logLevel, dbPath, mongoUri, redisUrl — each parsed or defaulted…
  });
}
export const appConfig: AppConfig = createAppConfig();`,
        },
      ],
    },
    {
      id: 'best-api-discipline',
      title: 'API discipline',
      lead:
        'One error envelope, correct status codes, docs that cannot drift — the contracts that make an API predictable to strangers (including future you).',
      blocks: [
        {
          kind: 'text',
          id: 'best-api-discipline:envelopes-and-codes',
          body: `ONE ERROR SHAPE, EVERYWHERE. The exception-handling topic's taxonomy is the discipline: every failure — thrown, returned, parser-rejected — surfaces as the SAME envelope \`{ error: { code, message, requestId } }\` through one middleware, so a client writes ONE error path, and a log line joins its request by requestId. The cost of skipping this is every endpoint inventing its own failure dialect, which is what "integration takes six weeks" is made of. CORRECT STATUS CODES are API honesty: 400 (you sent garbage) vs 401 (I don't know you) vs 403 (I know you, no) — the authz topic's 401/403/404 ladder is the worked example — 404 for what doesn't exist (and, when existence is sensitive, 404-BEFORE-403 so you don't leak it), 409 for conflicts, 422/400-with-details for validation, 429 with Retry-After (the security limiter), 5xx for what is genuinely OUR fault. IDEMPOTENCY AWARENESS: know which of your endpoints are safe to replay (GET/PUT/DELETE with client ids) and which are not (bare POSTs) — the HTTP topic taught the property; the discipline is designing for it BEFORE a retrying client double-charges someone (idempotency keys on money-moving endpoints). VERSIONING: pick a boring strategy early (path version \`/api/v1\` — this app's content API carries \`version: 1\`) and never rename a public field — add, don't mutate.`,
        },
        {
          kind: 'code',
          id: 'best-api-discipline:drift-spec-quote',
          language: 'ts',
          caption:
            'Docs that can\u2019t drift — this repo pins its contracts to the real surface with specs (posts_routes.spec.ts, verbatim; the api-documentation topic\u2019s pattern)',
          source: 'server/src/presentation/routes/posts_routes.spec.ts',
          code: `// A drift spec fails the build when docs lie — here, the documented
// error envelope must match what the error middleware actually emits:
it('404s with the error envelope for unknown ids', async () => {
  const res = await request(createApp()).get('/api/posts/does-not-exist');

  expect(res.status).toBe(404);
  expect(res.body.error).toMatchObject({
    code: 'not_found',                        // the documented envelope
    message: expect.any(String),
    requestId: expect.stringMatching(UUID_RE), // the request-id middleware's real id
  });
  // …and the correlation is real: the envelope's requestId IS the header's…
  expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
});
// The lesson generalized: anything you CLAIM about the API — envelope,
// status codes, headers — gets a spec that quotes the running app,
// so the claim and the behavior move together or the build is red.`,
        },
      ],
    },
    {
      id: 'best-security',
      title: 'Security',
      lead:
        'The distilled checklist — helmet on, CORS deliberate, secrets out of code, parameterized everything, constant-time compares. Each with its topic.',
      blocks: [
        {
          kind: 'text',
          id: 'best-security:checklist',
          body: `THE CHECKLIST, WITH RECEIPTS. Helmet ON, app-wide, CSP pinned explicitly (this app: app.ts mounts it first, with the Swagger-UI audit in comments — the security topic). CORS DELIBERATE, never \`*\` reflexively: an exact-match allowlist with credentials only when the origin is concrete (the hand-rolled corsMiddleware's contract — denial adds no headers, never errors). RATE LIMITS on anything expensive or authenticate-y, keyed by client, 429 through the one error taxonomy (the security topic ships both a production library and the hand-rolled twin so the mechanism is legible). SECRETS OUT OF CODE: config from env, never committed — and this repo is honest about its own gap (the security topic notes the root .gitignore does not yet exclude .env files; placeholder-only secrets today, the discipline must land before real ones). PARAMETERIZED EVERYTHING: no string-built SQL, ever — the DAO binds \`?\`/\`@named\` parameters (the demo below audits this mechanically), and the injection catalog's other families (command/path/SSRF/XSS) each have their guard shown. CONSTANT-TIME COMPARES for anything secret-shaped: hash both sides, timingSafeEqual (the auth topic's dummy-compare login; the webhook HMAC). INPUT VALIDATION at the boundary with one library and one error shape (the validation topic's three-idiom arena). OWASP is the syllabus: the API Security Top 10 plus the classic Top 10 are the exam this checklist studies for — the security topic maps them.`,
        },
        {
          kind: 'code',
          id: 'best-security:parameterized-quote',
          language: 'ts',
          caption:
            'Verbatim — the app\u2019s only DAO, every statement bound (data/posts/post_dao.ts); the audit demo greps this mechanically',
          source: 'server/src/data/posts/post_dao.ts',
          code: `findById(id: string): PostRow | undefined {
  return this.db
    .prepare(
      'SELECT id, title, body, author, created_at, updated_at FROM posts WHERE id = ?',
    )
    .get(id) as PostRow | undefined;   // ← id is DATA bound to ?, never spliced into the text
}`,
        },
      ],
    },
    {
      id: 'best-data',
      title: 'Data',
      lead:
        'Migrations as history, transactions for invariants, indexes measured — and backups, the one thing this guide genuinely does not demo.',
      blocks: [
        {
          kind: 'text',
          id: 'best-data:migrations-tx-indexes',
          body: `MIGRATIONS ARE HISTORY, not plumbing: schema changes ride ordered, reviewed, runnable-forward files (the sql-node topic's mini runner — per-file transactions, a schema_migrations table, idempotent re-runs) so every environment's database is a replayable log of decisions, and "what changed last Tuesday" has an answer. Never edit a shipped migration; append one. TRANSACTIONS FOR INVARIANTS: any write that must land ALL-or-NOTHING gets a transaction — the transfer endpoint's crash-in-the-middle demo (rolledBack: true at HTTP 200) is the lesson staged; the rule is invariants, not vibes, and SQLite/Postgres give it to you in one BEGIN…COMMIT. INDEXES MEASURED: an index is a guess until EXPLAIN says so — the db topic's SEARCH-vs-SCAN plan explorer exists because the wrong index costs writes AND misses reads; every index earns its keep with a measured query plan. SOFT DELETES vs HARD, one line: soft delete (a deleted_at column) when you need undo/audit/history; hard delete when data minimization or simplicity wins — decide per table, on purpose. AND THE HONEST GAP, said plainly: THIS GUIDE DOES NOT DEMO BACKUPS. Nothing in this repo backs up guide.db, and no topic fakes it. The practice itself is non-negotiable — automate backups, TEST the restore (an untested backup is a hope with a cron job), keep one off-site, encrypt it — a data-loss postmortem that says "we had backups" but not "we had restores" is the classic one. It's absent here because the demo value is low and the discipline is high; this paragraph is the placeholder until it's earned.`,
        },
        {
          kind: 'code',
          id: 'best-data:migration-quote',
          language: 'sql',
          caption:
            'This repo\u2019s own migration history — ordered .sql files beside the runner\u2019s in-schema ledger (data/migrations/migration_runner.ts; the sql-node topic walks it)',
          source: 'server/src/data/migrations/migration_runner.ts',
          code: `-- data/migrations/ — ordered, descriptive, append-only file names:
--   0001_create_tags_tables.sql  0002_add_indexes.sql  …  0008_create_outbox.sql
--   a new change is a NEW file, never an edit to a shipped one.

-- the runner's ledger — which files have run, so re-running is a no-op:
const CREATE_MIGRATIONS_TABLE = \`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
\`;`,
        },
      ],
    },
    {
      id: 'best-reliability',
      title: 'Reliability',
      lead:
        'Timeouts everywhere, retries with jitter, breakers on flaky dependencies, graceful shutdown, failure injection as routine — the reliability topic, compressed.',
      blocks: [
        {
          kind: 'text',
          id: 'best-reliability:the-compression',
          body: `EVERY OUTBOUND CALL GETS A DEADLINE you chose (AbortController hands the cancellation down — the gRPC bridge's 2s deadline); a hang is worse than an error because it holds resources politely forever. RETRIES: only idempotent operations, exponential backoff WITH jitter, hard caps, one layer (the jobs queue's ±20% jitter is the shape; the retry-storm math is why "one layer"). CIRCUIT BREAKERS on dependencies that flake under load: fail fast while it's down, probe to recover (the reliability topic's watchable breaker is the whole mechanism). GRACEFUL SHUTDOWN: stop accepting, drain in-flight, close dependencies in order, THEN exit — server.ts drains gRPC → mongo → redis → hub → HTTP on SIGTERM, and the deployment topic proved it inside the container. FATAL HANDLERS: uncaughtException/unhandledRejection log-and-exit(1) — crash loudly under a supervisor rather than limp (the observability topic landed exactly this, with the rationale). FAILURE INJECTION AS ROUTINE: if you have never made a dependency fail on purpose, you don't know what it does when it fails on its own — the scenarioStore's injectFailure toggle has been exercisable since topic three, and the debugging/observability demos build on it. The compression of the compression: bound every wait, retry only what's safe, shed what's down, exit cleanly, and PRACTICE all four before they matter.`,
        },
        {
          kind: 'code',
          id: 'best-reliability:drain-quote',
          language: 'ts',
          caption:
            'Verbatim — the shutdown drain this app actually runs (src/server.ts, abridged; spec-free by design)',
          source: 'server/src/server.ts',
          code: `function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down gracefully');
  // SIGTERM arrives (docker stop, a deploy, the supervisor) → drain the side
  // doors in dependency order: grpc stop → mongo close → redis close → ws
  // hub → http close — each failure swallowed so the chain still reaches
  // server.close(), THEN exit: in-flight requests finished, sockets returned,
  // nothing severed mid-write.
  void grpcServerPromise
    .then((handle) => handle?.stop())
    .catch(() => undefined)
    .finally(() => {
      // …closeMongoConnection → closeRedis → chatHub.close, same shape…
      server.close(() => {
        logger.info('http server closed');
        process.exit(0);
      });
    });
  // Safety net: server.close() waits on keep-alive connections; don't hang forever.
  const forceExitTimer = setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
}`,
        },
      ],
    },
    {
      id: 'best-observability',
      title: 'Observability',
      lead:
        'Structured logs with request IDs, the metrics that matter, alerts on symptoms — and the fatal-exit discipline that keeps them honest.',
      blocks: [
        {
          kind: 'text',
          id: 'best-observability:logs-metrics-alerts',
          body: `STRUCTURED LOGS, REQUEST IDs CORRELATED. JSON lines (pino), one line per event, fields not prose — and every request carries a request ID that appears in its access line, its error envelope, and every log in between (the request-id middleware is FIRST in the chain for exactly this reason): an incident investigation is "give me everything with this id", not a grep archaeology dig. LEVEL DISCIPLINE: 4xx warn, 5xx error, fatal means exiting — the refinement the observability topic shipped into the error middleware; a log stream where everything is ERROR trains everyone to ignore it. METRICS THAT MATTER, the short list: request rate, error rate, p95 latency (the golden trio), queue depth and oldest-job age (the jobs stats — DEMAND you're not keeping up with), event-loop delay (Node's own vital sign — the obs metrics endpoint's real histogram), saturation numbers (memory, connections). ALERT ON SYMPTOMS, not causes: page for "error rate up" and "p95 blown", not for "CPU high" — users don't feel CPU, and cause-based paging burns nights on non-incidents. THE FATAL-EXIT DISCIPLINE: a process in an unknown state must EXIT (log fatal, flush, exit 1) and let the supervisor bring back a known state — a zombie that keeps "working" with a corrupted heap is the unobservable incident. And keep logs bounded in dev (the 200-line ring), shipped to a real sink in prod — stdout from a container IS the log pipeline's front door.`,
        },
        {
          kind: 'code',
          id: 'best-observability:levels-quote',
          language: 'ts',
          caption:
            'Verbatim — the level discipline as shipped (presentation/middleware/error_middleware.ts)',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `// Level discipline (the observability topic's refinement): 4xx is the
// CLIENT's problem — expected traffic noise, warn; 5xx is OURS — error.
if (err.statusCode >= 500) logger.error(logLine, 'request failed');
else logger.warn(logLine, 'request failed');`,
        },
      ],
    },
    {
      id: 'best-performance',
      title: 'Performance',
      lead:
        'Percentiles not averages, event-loop hygiene, compress on the wire, cache with a plan, stream big things — the performance topic as rules.',
      blocks: [
        {
          kind: 'text',
          id: 'best-performance:rules',
          body: `PERCENTILES, NOT AVERAGES: the mean of a bimodal response time describes neither mode — report p50/p95/p99 and OPTIMIZE the tail, because the tail is where users on slow phones meet your API on a bad minute (the perf topic's discipline; the capacity math in scaling consumed it). EVENT-LOOP HYGIHENE: one blocking call stalls EVERY concurrent request — Node's concurrency is the loop, so heavy work gets sliced (setImmediate chunks), moved to a worker, or never done (the node topic's blocking demo measured a 300ms hash loop as an event-loop spike; the debugging topic diagnosed one live). COMPRESS ON THE WIRE: JSON gzips ~25× when repetitive (the perf topic's live ratio was 0.014 — 49,877B → 680B) and costs single-digit ms — compress big responses, SCOPED deliberately (this app mounts compression per-route so header-asserting specs stay honest — a check the audit below grades). CACHE WITH A PLAN: every cache needs an invalidation story BEFORE it needs a hit-rate — the caching topic's cache-aside + explicit invalidate + single-flight stampede guard is the whole plan in three mechanisms; a cache without an invalidation story is a future stale-data incident. STREAM BIG THINGS: anything over a few MB — downloads, exports, feeds — streams (the range-request streamer, the ndjson telemetry endpoint); buffering the whole thing in memory converts one big request into an OOM. THE META-RULE: measure before and after every one of these — a performance change without a number is a rumor.`,
        },
        {
          kind: 'code',
          id: 'best-performance:ratio-quote',
          language: 'text',
          caption: 'The app\u2019s own measured numbers — the case for each rule (perf + caching topics, live-observed)',
          code: `compression : 49,877B → 680B on the wire (ratio 0.014) — compress big JSON
streaming  : Content-Length set (buffered) vs chunked (stream) — same bytes,
             one holds them all in memory first
percentiles: medians of stringify vs stringify+gzip from the benchmark
             endpoint — SERVER-side medians, not one lucky run
cache      : 10 concurrent misses → 1 origin call (single-flight) —
             the stampede demo, measured live`,
        },
      ],
    },
    {
      id: 'best-operations',
      title: 'Operations',
      lead:
        'One process per container, health checks, config in env, images without compilers, CI as the gate — the deployment topic, operationalized.',
      blocks: [
        {
          kind: 'text',
          id: 'best-operations:rules',
          body: `ONE PROCESS, ONE CONCERN per container (the guide's own server/client split; a container that runs three daemons hides which one died). HEALTH CHECKS the orchestrator can probe: a liveness route that answers when the process is up, readiness that says whether DEPENDENCIES answer (the observability topic's two-level strip) — and the deployment topic's compose files declare them for real. CONFIG IN ENV, twelve-factor: the same image promotes dev→staging→prod by changing ENVIRONMENT, not code (the environments topic's three .env files + compose's environment-beats-env_file are the worked case); the image must not KNOW where it runs. IMAGES WITHOUT COMPILERS: build in a stage with the toolchain, ship a runtime stage with only what runs — the deployment topic's Dockerfile lesson is exactly this (a build stage pays python3/make/g++ so npm install survives better-sqlite3, then the runtime image ships NO compilers and only the bundled binding — verified inside the container). Logging to stdout so the platform owns the sink. CI AS THE GATE: every push runs the same commands this guide's DoD uses — build, test, lint — and an ungreen main is a stop-the-line event, not a suggestion; the repo ships its real CI file (.github/workflows/ci.yml, quoted verbatim in the deployment topic) running both packages on every push to main and every pull request — the gate is the rule in force, not a promise. The whole section in one line: the DEPLOYABLE unit is the image, and everything the process needs to be knowable-from-outside (health, logs, metrics, config) is a contract you ship with it.`,
        },
        {
          kind: 'code',
          id: 'best-operations:health-quote',
          language: 'yaml',
          caption:
            'This repo\u2019s own compose healthcheck + env override (.docker/docker-compose.yml, verbatim; the deployment topic ships it for real)',
          source: '.docker/docker-compose.yml',
          code: `services:
  server:
    environment:
      # config in env: the SAME image, different environment — no rebuild
      - MONGO_URI=mongodb://mongo:27017/express_guide_dev
      # Same rule for redis: service name, not localhost (overrides
      # .env.development REDIS_URL). Optional service, same graceful off.
      - REDIS_URL=redis://redis:6379

  redis:
    image: redis:7-alpine
    healthcheck:               # the orchestrator's probe — a real command,
      test: ["CMD", "redis-cli", "ping"]   # not a promise
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s`,
        },
      ],
    },
    {
      id: 'best-git-workflow',
      title: 'Git workflow and code review',
      lead:
        'Branch, commit, review, repeat — the git mechanics under the human practices, sized for a repo whose CI already runs on every push and pull request.',
      blocks: [
        {
          kind: 'text',
          id: 'best-git-workflow:model-and-commits',
          body: `THE BRANCHING MODEL, SIZED HONESTLY: trunk-based with short-lived branches. main is always deployable; work happens on per-task branches (feature/x, fix/y — hours to days, not weeks); everything lands through a pull request. This repo already carries the contract — its CI file (quoted in the deployment topic) runs on \`push: branches: [main]\` AND on every \`pull_request\`: each candidate change gets the full test+build gate BEFORE merge, and main gets it again on land. Git-flow's long-lived develop/release branches add ceremony most teams pay for without needing; start trunk-based and add release branches only when release trains are real. CONVENTIONAL COMMITS — \`feat:\`, \`fix:\`, \`chore:\`, \`docs:\`, \`refactor:\` prefixes, imperative mood — because the subject line becomes machine-parseable: changelogs generate from the feat:s, semantic-version bumps follow the leading type (feat -> minor, fix -> patch, \`!\` or a footer marking breaking), and bisect results name the offender in one line. THE HISTORY DISCIPLINE: small commits that each keep the suite green (bisectability is a habit, not a tool you run at the end), messages that say WHY the change is right (the diff already says what), amend/rebase before merge and append-only after. THIS REPO'S HONEST GAP, stated rather than faked: it is not yet git-initialized (the declared follow-up the deployment and security topics both note) — the discipline above is the contract its CI file already encodes; the moment the repo carries history, conventional commits are the convention it lands with.`,
        },
        {
          kind: 'text',
          id: 'best-git-workflow:review-checklist',
          body: `THE REVIEW CHECKLIST, IN ATTACK ORDER. (1) CORRECTNESS first — the invariants questions (null? called twice? interrupted here?) that the human-practices section below owns. (2) FAILURE MODES — every new error path reaches the one taxonomy, nothing swallowed (the anti-checklist's silent catch). (3) THE CONTRACT — envelope, status codes, headers if a route changed, and the drift spec updated in the same PR (the api-discipline section's rule). (4) TESTS — new behavior covered, and the tests assert BEHAVIOR, not implementation (the testing topic's rule). (5) THE FACTS — README, docs, env examples that changed in this PR. Style is LAST, and ideally not human at all — formatters own it, and this repo's lint gap is declared in CI rather than faked. SIZE IS THE MULTIPLIER: at ~300 reviewed lines the checklist gets applied; at 3,000 it gets skimmed — which is why small PRs lead. THE HARDEST REVIEW is the dependency upgrade — lockfile noise, transitive blast radius, break-then-revert decisions — and it has its own runbook in the dependency-management topic's upgrade strategy; steal that instead of improvising.`,
        },
        {
          kind: 'code',
          id: 'best-git-workflow:commands',
          language: 'bash',
          caption: 'A task\u2019s life, trunk-shaped — and the archaeology the discipline buys',
          code: `# a task's life:
git switch -c feat/structured-error-envelope main
git commit -m 'feat(errors): merge failure details flat under canonical keys'
git fetch origin && git rebase origin/main            # stay current, keep history linear
git push -u origin feat/structured-error-envelope    # the PR opens against main

# the archaeology the discipline buys:
git log --oneline --decorate -15
git bisect start                                     # walk commits until the culprit names itself`,
        },
      ],
    },
    {
      id: 'best-human-practices',
      title: 'The human practices',
      lead:
        'Review for invariants, write decisions down, keep PRs small, keep the README true — the practices that make all the technical ones stick.',
      blocks: [
        {
          kind: 'text',
          id: 'best-human-practices:review-and-adrs',
          body: `CODE REVIEW FOR INVARIANTS, NOT STYLE: the highest-value review comment is "what happens if this is null / called twice / interrupted here?" — not a formatting nit (formatters own style; humans own the questions tests don't answer yet). Review the DIFF against its failure modes: error paths, boundaries, concurrency, what it does to the layering. ADRs — ARCHITECTURE DECISION RECORDS: when a choice is consequential (which DB, which auth model, hand-roll vs library), write a short dated note: context, options, decision, consequences. THIS REPO'S DECISION LOG IS ONE (the agentic_development.md decision log — compressed decisions + WHY, e.g. "TypeScript everywhere for family consistency", "sqlite as primary DB (zero-setup) with the ORM comparisons taught alongside"): the value is not the document, it is that six months later "why is it like this?" has an answer that isn't archaeology. SMALL PRs: a 100-line PR gets a real review; a 1,000-line PR gets a rubber stamp and a merge — size is review quality. THE README THAT STAYS TRUE: commands, ports, the one-paragraph architecture — updated in the same PR that changes the facts (a README that lies about how to run the project costs every new contributor a day). AND THE INCIDENT HUMAN PRACTICE: when prod is down and you don't know why, SAY "I don't know" out loud, then say what you're checking — blameless accuracy beats confident theater — and after, write the POSTMORTEM: timeline, root cause, contributing factors, action items with owners. The postmortem is the ADR's twin: one records why we built it this way, the other why it broke that way; a team that writes both gets to be smart twice about the same lesson.`,
        },
        {
          kind: 'code',
          id: 'best-human-practices:adr-shape',
          language: 'markdown',
          caption:
            'The ADR shape this repo\u2019s own decision log follows (agentic_development.md, real entries quoted)',
          code: `- Decision log (compressed decisions + why)
    - SQLite as primary DB (zero-setup, portable) with Prisma/Sequelize/Knex
      comparison screens; Redis compose service for caching/session stores;
      optional Mongo service for the Mongoose screen (user-approved outline).
    - Mongoose 9 gotchas proven: createConnection(uri) connects eagerly…

# The pattern: WHAT was decided → WHY (the options and the driver) →
# the PROVEN gotchas that justify it. Short, dated, append-only —
# an ADR nobody reads at 300 words beats one nobody reads at 3,000.`,
        },
      ],
    },
    {
      id: 'best-anti-checklist',
      title: 'The anti-checklist',
      lead:
        'The smells — any-creep, god-routers, silent catches, string-concat SQL, console.log in prod, unbounded arrays, magic numbers, TODO-as-documentation.',
      blocks: [
        {
          kind: 'text',
          id: 'best-anti-checklist:smells',
          body: `THE SMELLS, EACH WITH ITS FIX. ANY-CREEP (\`any\`, \`as\`, non-null \`!\` seeping through types): every \`any\` deletes a compile-time check you'll pay to rediscover at runtime — fix by typing the boundary (parse, don't trust: the validation topic's runtime checks) and letting inference flow inward. GOD-ROUTERS: a route file that imports the database and formats strings is three layers in a trench coat — fix by the dependency rule (routes parse and delegate; the architecture topic's tracer shows the healthy shape). SILENT CATCHES (\`catch {}\`, swallowed rejections, a failure returned as null with no log): the invisible outage — fix by the one taxonomy: every failure logged with its request ID or thrown to the middleware; NOTHING is swallowed. STRING-CONCAT SQL: one user named \`x' OR '1'='1\` away from a breach — fix is mechanical, parameterize (the injection topic's safe/unsafe pairs; this app's DAO is the clean example and the audit below greps it). CONSOLE.LOG PRODUCTION LOGGING: unstructured, unpiped, uncorrelated — fix by the one logger (pino here), leveled, with request IDs. UNBOUNDED ARRAYS (a Map that only grows, a history with no cap, a queue with no limit — memory death by a thousand appends): fix with caps + eviction policies everywhere state accumulates (this app caps sessions at 100, the log ring at 200, the job list at 50, replay rings at 50 — the cap is a DESIGN DECISION, stated in code). MAGIC NUMBERS (300, 1500, 4096 sprinkled through logic): fix by a named constant with its reason in the name (MAX_SESSIONS, REDIS_CONNECT_TIMEOUT_MS — this codebase's habit). TODO-AS-DOCUMENTATION ("// TODO: handle errors" shipped to prod): a TODO that ships is a debt with no ledger — fix by an issue with an owner, or a follow-up line in the project's task list (this repo keeps one), never a comment that pretends to be a plan. THE PATTERN UNDER ALL NINE: each smell is a DECISION AVOIDED — the fixes are just making the decision and writing it where the next reader (or the audit) can find it.`,
        },
        {
          kind: 'code',
          id: 'best-anti-checklist:caps-quote',
          language: 'ts',
          caption:
            'The unbounded-array fix as this repo practices it — caps with names and reasons (session_store.ts verbatim; the siblings named in the comment are equally real)',
          source: 'server/src/domain/auth/session_store.ts',
          code: `/** Sessions live 30 minutes from creation. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard cap — the oldest session is evicted when the store is full. */
export const MAX_SESSIONS = 100;

// …the same named-cap discipline everywhere state accumulates in this repo
// (each a real line in its own file): LOG_RING_CAPACITY = 200
// (core/logging/log_ring.ts), REPLAY_LIMIT = 10 (sse_demo_routes.ts),
// SWEEP_EVERY_CHECKS = 64 (handmade_rate_limiter.ts), EMAIL_OUTBOX_CAP = 50,
// the job list cap 50 — the cap is a DESIGN DECISION, stated in code…

// vs the smell: history.push(event) with no cap is a leak wearing a feature's clothes.`,
        },
      ],
    },
    {
      id: 'best-see-it-live',
      title: 'See it live',
      lead:
        'The self-audit: the running app checks itself against this checklist — real headers, real listeners, real source — and grades the result.',
      blocks: [
        {
          kind: 'text',
          id: 'best-see-it-live:what-you-see',
          body: `THE DEMO IS THE CAPSTONE'S PROOF: \`GET /api/demo/best/audit\` makes the app grade ITSELF. The checks are real signals, not a hardcoded report card: helmet's headers and the request-id read off a LIVE self-fetch of /api/health (the same make-noise pattern the observability topic uses — and if nothing is listening at this origin, those checks degrade to WARN with an honest note, never a lie, never a 500); the 404 envelope shape proven by a real self-fetch of a route that doesn't exist; compression verified SCOPED (the health answer stays identity because the perf router owns compression deliberately — a pass, with the reasoning in the evidence); sqlite parameterization audited by reading the DAO's own source from disk and grepping for bound placeholders (a static heuristic, labeled as one); graceful shutdown and fatal handlers verified by REAL process introspection — \`process.listenerCount('SIGTERM') > 0\` and the uncaughtException/unhandledRejection listeners the observability topic added; docs served, content versioned, rate limits configured, the log ring live — each with its evidence string. Run it against \`npm run dev\` and the whole board goes green where the app deserves it; the point is not this app's score, it's that a CHECKLIST YOU CAN EXECUTE is worth ten you can only read. Or script it:`,
        },
        {
          kind: 'code',
          id: 'best-see-it-live:curl',
          language: 'bash',
          caption: 'The self-audit over curl — the board, the evidence, the summary',
          code: `# the app grades itself (run against the live dev server for the
# self-fetch checks to go green):
curl -s localhost:4000/api/demo/best/audit | python3 -m json.tool

# just the verdict:
curl -s localhost:4000/api/demo/best/audit \\
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["summary"]); \\
    [print(c["status"].upper().ljust(4), c["id"], "—", c["evidence"]) for c in d["checks"]]'`,
        },
        {
          kind: 'demo',
          id: 'best-see-it-live:demo',
          demoId: 'best:checklist',
          title: 'The self-audit',
          description:
            'The app grades itself against this checklist LIVE: real headers via self-fetch, real process listeners (SIGTERM, fatal handlers), a real source-grep of the DAO for bound parameters — every check with pass/warn/fail status and the evidence it graded itself on.',
        },
      ],
    },
  ],
};
