import type { Topic } from '../types.js';

/**
 * The Environments and Configuration topic — the guide's tour of ITS OWN
 * config pipeline. The three .env files, the resolution-order comment, and the
 * validated frozen AppConfig quoted below are the real files; the config
 * inspector demo introspects the live config with secrets masked.
 */
export const topicEnvironments: Topic = {
  id: 'environments',
  title: 'Environments and Configuration',
  subtitle:
    'Twelve-factor config, validated .env files, and dev/staging/prod parity.',
  group: 'platform',
  order: 7,
  sections: [
    {
      id: 'env-codebases',
      title: 'One codebase, many environments',
      lead:
        'The same artifact runs in dev, staging, and production — only its configuration differs. The moment code has an `if (environment)` branch, you have three programs.',
      blocks: [
        {
          kind: 'text',
          id: 'env-codebases:three-programs',
          body: `THE STANDARD SHAPE is three-ish worlds: DEVELOPMENT (your machine — everything local, verbose logs, hot reload, a debugger attached), STAGING/pre-production (as production-shaped as the budget allows — the rehearsal theater where migrations, config, and release candidates run against data nobody cries about), PRODUCTION (the real thing — real users, real secrets, least verbosity, maximum supervision). There are usually more (local test runs, CI, load-test environments, per-customer tenancies), but they are all the same IDEA: one CODEBASE promoted through contexts that differ ONLY in configuration and infrastructure. WHAT DIFFERS, exhaustively, when it is done right: configuration (ports, log levels, service addresses, feature switches — everything in the next section) and infrastructure (process counts, database sizing, whether the optional services exist at all). WHAT NEVER DIFFERS: the code. The commit that runs in staging is byte-identical to the one that runs in production — because the alternative, an environment-shaped branch or an \`if (staging)\` in a code path, means the thing you TESTED is not the thing you SHIPPED. THE "WORKS ON STAGING" ANTI-PATTERN is this principle failing in miniature: code that behaves differently per environment is three programs wearing one README, and any assurance about one of them is marketing. The discipline that prevents it is the twelve-factor rule the next section states: environment = VARIABLES, not version. THIS REPO'S THREE FILES, walked honestly (all three are quoted verbatim below): .env.development is the LOUDEST world — LOG_LEVEL=debug, a file-backed SQLITE_PATH, and the two optional services pointed at localhost (the compose stack publishes their ports so a host-run server can reach them at 127.0.0.1); .env.staging is nearly EMPTY on purpose — NODE_ENV, PORT, LOG_LEVEL=info and nothing else, which means every unset variable exercises a DEFAULT (sqlite falls back to data/guide.db; MONGO_URI and REDIS_URL unset means both optional features boot OFF — the config layer treats '' as a valid "no thanks"); .env.production looks like staging plus SQLITE_PATH, and carries the most interesting line in the repo's config story: MONGO_URI is deliberately UNSET, with an inline comment saying the mongo demo stays off until a mongo service exists for this environment — the optional-service pattern letting production honestly not run a topic's toy. Notice what is the SAME in all three: the code's expectations. The files are pure variable assignments, three lines of intent each.`,
        },
        {
          kind: 'code',
          id: 'env-codebases:verbatim-env-files',
          language: 'bash',
          caption: 'Verbatim — all three real files (server/.env.development, .env.staging, .env.production)',
          code: `# ---- server/.env.development — the loud world ----
PORT=4000
NODE_ENV=development
LOG_LEVEL=debug
SQLITE_PATH=data/guide.db

# The MongoDB topic demo (optional service). Empty/unset = feature off.
MONGO_URI=mongodb://127.0.0.1:27017/express_guide_dev

# The Redis topic demo (optional service). Empty/unset = feature off.
REDIS_URL=redis://127.0.0.1:6379

# ---- server/.env.staging — the quiet rehearsal (the WHOLE file) ----
PORT=4000
NODE_ENV=staging
LOG_LEVEL=info

# ---- server/.env.production — the real thing ----
PORT=4000
NODE_ENV=production
LOG_LEVEL=info
SQLITE_PATH=data/guide.db

# MONGO_URI is deliberately unset here — the MongoDB demo stays off until a
# mongo service exists for this environment (set it to mongodb://host:27017/db).`,
        },
      ],
    },
    {
      id: 'env-twelve-factor',
      title: 'Twelve-factor config',
      lead:
        'Config lives in the environment; .env files are a development convenience that must never graduate to a config strategy. Real env always wins.',
      blocks: [
        {
          kind: 'text',
          id: 'env-twelve-factor:rule',
          body: `THE RULE (twelve-factor, factor III, paraphrased tightly): store config in the ENVIRONMENT — everything that varies between deployments (resource handles, credentials, per-deploy toggles) enters the process as environment variables, and the CODE is identical everywhere. The test that matters: could this repo's build artifact be promoted from staging to production by changing ONLY the environment it runs in, with zero code or file edits? For this app the answer is yes — the compiled dist/ is environment-agnostic, and .env.production-style values arrive via the platform (Docker's env_file and environment, a systemd unit's Environment=, a Kubernetes Secret mounted as env) rather than being compiled, committed, or baked into the image. THE .ENV FILE is the acknowledged compromise the ecosystem settled on: \`KEY=value\` lines, loaded at boot by dotenv, giving dev the ergonomics of a file you can edit with git-ignored secrets. The compromise is honest ONLY at development scale, and this repo keeps it honest by stating the loading semantics in one place — the resolution-order comment at the top of app_config.ts (quoted below): NODE_ENV from the real environment decides WHICH \`.env.{nodeEnv}\` file to load; dotenv loads that file AND NEVER OVERRIDES variables already present in the environment, so EXPLICIT ENV ALWAYS WINS OVER THE FILE. That last clause is the entire deployment story: compose (next sections) sets MONGO_URI in its \`environment:\` block while ALSO passing \`.env.development\` as env_file — and the file's value loses, on purpose, because the file is the DEFAULT and the platform is the OVERRIDE. SECRETS NEVER COMMITTED is the rule with teeth: a .env file is one \`git add -f\` away from being permanent (git remembers; "deleting" it later does not unfork the clones). THIS REPO'S HONEST GAP, stated rather than hidden because the security topic found it first: the ROOT .gitignore lists node_modules, dist, logs, server/data and .DS_Store — but NOT \`.env*\`. Today that is survivable because every value in the three files is a placeholder (localhost URLs, a port, a log level — nothing a thief wants), and the repo is not yet git-initialized; the fix is named and waiting: add \`.env*\` (plus a committed \`.env.example\` with keys and no values, so newcomers know the shape) the day real credentials appear. The .dockerignore ALREADY does this right — \`**/.env*\` never enters a build context — which makes the git gap exactly what it looks like: an oversight in one file, not a philosophy. THE PATTERN THAT SCALES PAST FILES, previewed (section 6 goes deep): the production equivalent of env_file is a SECRET STORE — the platform injects variables at deploy time from a vault, and no secret ever touches disk in a repo.`,
        },
        {
          kind: 'code',
          id: 'env-twelve-factor:verbatim-resolution-order',
          language: 'ts',
          caption: 'Verbatim — the resolution-order comment and the load call (core/config/app_config.ts)',
          source: 'server/src/core/config/app_config.ts',
          code: `/**
 * Validated, immutable application configuration.
 *
 * Resolution order:
 *  1. NODE_ENV from the real environment (shell / Docker env_file) decides which
 *     \`.env.{nodeEnv}\` file to load. Defaults to "development".
 *  2. dotenv loads that file — it never overrides variables already present in
 *     the environment, so explicit env always wins over the file.
 *  3. PORT / GRPC_PORT / LOG_LEVEL / SQLITE_PATH / MONGO_URI / REDIS_URL are
 *     read from the merged environment and validated.
 */

// …and the load itself, at the heart of createAppConfig():
  // Loads \`.env.{nodeEnv}\` from the package root (cwd when run via npm scripts).
  dotenv.config({ path: path.resolve(process.cwd(), \`.env.\${nodeEnv}\`) });`,
        },
      ],
    },
    {
      id: 'env-validated',
      title: 'Validated config at boot',
      lead:
        'Parse, validate, and freeze configuration at startup — a bad PORT should be a boot error with the offending value in the message, not a NaN at 3am.',
      blocks: [
        {
          kind: 'text',
          id: 'env-validated:fail-fast',
          body: `WHY BOOT-TIME VALIDATION BEATS RUNTIME SURPRISES: environment variables arrive as STRINGS or not at all — \`process.env.PORT\` is \`'4000'\` (a string), \`undefined\` (unset), or \`'four thousand'\` (someone's typo, indistinguishable from a string until you compute with it). The naive app does \`Number(process.env.PORT)\` lazily where the port is used and meets \`NaN\` deep in a listen() call — or worse, meets it only when the load balancer first probes the health check. The validated app turns every variable through a parser AT BOOT: parsePort checks integer-ness and the 0–65535 range; parseLogLevel checks membership in the six valid levels, applies the environment DEFAULT first (debug in development, info elsewhere — the rule the logger actually obeys); resolveNodeEnv maps the raw value into exactly three valid environments, treats vitest's 'test' as development, and THROWS naming the valid values when handed garbage. THE FAILURE MODE IS THE FEATURE: an invalid PORT kills the process at startup with \`Invalid PORT "four thousand". Expected an integer between 0 and 65535.\` — a one-line log a deploy pipeline can read, at a moment when no traffic is being served and a supervisor can restart-loop visibly, versus a NaN that surfaces at peak as "address not available". Fail-fast config is the cheapest reliability engineering that exists. THE FROZEN OBJECT is the second half of the pattern: createAppConfig returns \`Object.freeze({...})\` — the AppConfig every module reads is IMMUTABLE (an accidental mutation throws in strict mode rather than silently re-configuring the process halfway through a request), and it is built EXACTLY ONCE at module load (\`export const appConfig = createAppConfig()\`), so the whole process agrees on one snapshot instead of re-reading process.env per call and potentially seeing different values if something mutates the environment mid-flight. Note also the TEST OVERRIDES baked into the same constructor — the raw-NODE_ENV check happens BEFORE the test→development mapping so a vitest run forces sqlite to ':memory:' and reads MONGO_TEST_URI / REDIS_TEST_URI instead of the file's values: the config layer is where "never let a test touch a real database" is enforced, once, for every spec in the repo. THE DEFAULTS ARE DECISIONS: port 4000, grpc 50051, \`data/guide.db\`, and the empty-string optional services — each one chosen so that the smallest possible environment file still boots a working app with the optional features honestly off.`,
        },
        {
          kind: 'code',
          id: 'env-validated:verbatim-parsers',
          language: 'ts',
          caption: 'Verbatim — the parsers and the frozen object (core/config/app_config.ts; createAppConfig abridged — comments trimmed)',
          source: 'server/src/core/config/app_config.ts',
          code: `function resolveNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined || raw === '') return 'development';
  // vitest runs with NODE_ENV=test; the app treats it like development.
  if (raw === 'test') return 'development';
  if ((VALID_NODE_ENVS as readonly string[]).includes(raw)) return raw as NodeEnv;
  throw new Error(
    \`Invalid NODE_ENV "\${raw}". Expected one of: \${VALID_NODE_ENVS.join(', ')}.\`,
  );
}

function parsePort(raw: string | undefined, name: string, fallback: number): number {
  const port = Number(raw === undefined || raw === '' ? String(fallback) : raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(\`Invalid \${name} "\${raw ?? ''}". Expected an integer between 0 and 65535.\`);
  }
  return port;
}

function parseLogLevel(raw: string | undefined, nodeEnv: NodeEnv): LogLevel {
  const value = raw ?? (nodeEnv === 'development' ? 'debug' : 'info');
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      \`Invalid LOG_LEVEL "\${value}". Expected one of: \${VALID_LOG_LEVELS.join(', ')}.\`,
    );
  }
  return value as LogLevel;
}

// …and the one frozen snapshot every module reads:
export function createAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isTestRun = env.NODE_ENV === 'test';
  const nodeEnv = resolveNodeEnv(env.NODE_ENV);
  dotenv.config({ path: path.resolve(process.cwd(), \`.env.\${nodeEnv}\`) });

  return Object.freeze({
    port: parsePort(env.PORT, 'PORT', 4000),
    grpcPort: parsePort(env.GRPC_PORT, 'GRPC_PORT', 50051),
    nodeEnv,
    logLevel: parseLogLevel(env.LOG_LEVEL, nodeEnv),
    dbPath: isTestRun ? ':memory:' : parseDbPath(env.SQLITE_PATH),
    mongoUri: isTestRun ? parseOptionalServiceUrl(env.MONGO_TEST_URI) : parseOptionalServiceUrl(env.MONGO_URI),
    redisUrl: isTestRun ? parseOptionalServiceUrl(env.REDIS_TEST_URI) : parseOptionalServiceUrl(env.REDIS_URL),
  });
}`,
        },
        {
          kind: 'demo',
          id: 'env-validated:inspector-demo',
          demoId: 'env:inspector',
          title: 'The config inspector: this server\'s real config, masked environment and all',
          description:
            'Real introspection — the frozen AppConfig (nodeEnv, ports, logLevel, dbPath), process facts (node version, pid, cwd), the derived env-file name and whether it exists, and the masked environment view: config values shown, service URIs and secret-shaped names always hidden. Plus the static what-differs-per-environment strip from the repo\'s three real .env files.',
        },
      ],
    },
    {
      id: 'env-nodeenv',
      title: 'NODE_ENV for real',
      lead:
        'NODE_ENV is a BEHAVIOR SWITCH libraries read — not an environment, not a config file, and not where your secrets live.',
      blocks: [
        {
          kind: 'text',
          id: 'env-nodeenv:behavior-switch',
          body: `WHAT IT ACTUALLY CHANGES is other people's code, mostly: libraries read NODE_ENV and reconfigure themselves — npm's installer consults it (\`NODE_ENV=production\` with \`--omit=dev\` semantics keeps devDependencies out of production images; this repo's prod Dockerfile does both, literally: \`ENV NODE_ENV=production\` then \`RUN npm ci --omit=dev\`); express itself has historically keyed error-page verbosity and view caching on it; React famously ships development warnings that the production value strips. Each library's contract differs, which is the honest summary: NODE_ENV is a CONVENTION the ecosystem adopted, and the behaviors it toggles are decided by whoever wrote the library, not by Node. WHAT IT DOES NOT DO: it is not an ENVIRONMENT (staging cannot be expressed in it — try \`NODE_ENV=staging\` and most libraries simply see "not development, not production" and guess); it is not CONFIG STORAGE (it cannot hold a port or a secret); and despite the name collision it is not WHERE your environment lives — that is process.env as a whole. THE TEST→DEVELOPMENT MAPPING this repo performs (visible in resolveNodeEnv) exists because VITEST SETS NODE_ENV=test: the test runner wants library-land to know "no dev-server niceties", but this app's config semantics only understand three values — so 'test' maps to 'development' BEFORE anything else reads it, and the test-specific overrides (sqlite ':memory:', MONGO_TEST_URI) are keyed off the RAW value captured earlier, so they apply even though nodeEnv reports development. One variable, two audiences, resolved in five lines at the top of the config file — the alternative (every module guessing what 'test' means) is how the same run ends up with two opinions. THE PRACTICAL RULES THAT FALL OUT: set NODE_ENV explicitly in every deployment target (defaulting to development is a footgun in prod — you pay dev-mode overhead and keep dev-only behaviors); never branch YOUR OWN feature code on it (that is a feature flag or a real config value — section 7); and treat its three useful values as exactly that — development, production, and (by library convention) test.`,
        },
        {
          kind: 'code',
          id: 'env-nodeenv:verbatim-docker-prod',
          language: 'dockerfile',
          caption:
            'Verbatim — NODE_ENV earning its keep in the real prod image (.docker/server/Dockerfile.prod): the prod-deps stage installs with --omit=dev, the runtime stage sets the behavior switch',
          source: '.docker/server/Dockerfile.prod',
          code: `# ---- prod-deps stage: install PRODUCTION deps (with their native build) ----
FROM node:22-alpine AS prod-deps
# Same toolchain, same reason: \`npm ci --omit=dev\` still runs the gyp default.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev            # ← the install-time consequence:
                                 #    devDependencies never reach the runtime image

# ---- runtime stage: node + built artifacts, NO compilers in the image ----
FROM node:22-alpine
ENV NODE_ENV=production          # ← the behavior switch, set by the platform
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]`,
        },
        {
          kind: 'code',
          id: 'env-nodeenv:verbatim-test-mapping',
          language: 'ts',
          caption:
            "Verbatim — and the lines that reconcile vitest's 'test' with the app's three environments (core/config/app_config.ts)",
          source: 'server/src/core/config/app_config.ts',
          code: `function resolveNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined || raw === '') return 'development';
  // vitest runs with NODE_ENV=test; the app treats it like development.
  if (raw === 'test') return 'development';
  // …valid environments pass through; anything else throws naming them…`,
        },
      ],
    },
    {
      id: 'env-app-specific',
      title: 'Environment-specific behavior in this app',
      lead:
        'No if-statements in features — the differences are all CONFIG reads. Here is the complete, real table, plus the compose override that proves environment beats env_file.',
      blocks: [
        {
          kind: 'text',
          id: 'env-app-specific:table',
          body: `THE COMPLETE LIST of behaviors that differ per environment in this codebase — short by design, and every row is a CONFIG READ, not a code branch: LOG LEVEL — the parser's default is 'debug' in development and 'info' everywhere else (overridable per environment file — staging and production both pin LOG_LEVEL=info explicitly); PRETTY LOGS — the logger routes through the pino-pretty transport ONLY when nodeEnv === 'development'; staging and production emit the same facts as JSON for machines (the exception-handling topic showed the two dialects side by side); SQLITE PATH — .env.development pins data/guide.db, staging's unset variable exercises the same default, and a vitest run (raw NODE_ENV=test, captured before the mapping) forces ':memory:' so no spec ever touches a real database file; OPTIONAL SERVICES — MONGO_URI and REDIS_URL are ''-means-off variables: development points both at localhost (ports the compose stack publishes for host-run dev), staging's file leaves both unset so both features boot off, production deliberately leaves mongo off with a comment saying why; PORTS — 4000 everywhere in this repo (the client's Vite proxy and both Dockerfiles agree), grpc 50051 by default, GRPC_PORT overridable; NODE_ENV ITSELF — development/staging/production from each file, test under vitest mapped to development. THE COMPOSE STORY IS THE LIVING PROOF of the resolution order: the server service declares BOTH \`env_file: [.env.development]\` AND an \`environment:\` block setting MONGO_URI=mongodb://mongo:27017/express_guide_dev and REDIS_URL=redis://redis:6379 — and compose's documented precedence is ENVIRONMENT BEATS ENV_FILE (same rule as dotenv's real-env-wins, enforced one layer up by the platform): inside the container network the services are reachable by SERVICE NAME, not localhost, so the file's 127.0.0.1 values are exactly what must lose. Two rules, one shape — the file carries defaults, the platform overrides, the process cannot tell who set what and does not care. THE DEMO above introspects this table LIVE: which file was loaded, what the frozen config actually says, and a masked view of the environment with every secret-shaped value hidden.`,
        },
        {
          kind: 'code',
          id: 'env-app-specific:verbatim-compose',
          language: 'yaml',
          caption:
            "Verbatim — env_file vs environment (.docker/docker-compose.yml, server service): the file carries the defaults, the platform overrides",
          source: '.docker/docker-compose.yml',
          code: `    env_file:
      - ./../server/.env.development      # the DEFAULTS (localhost addresses)
    environment:
      # Inside compose the mongo service is reachable by service name, not
      # localhost — this overrides the .env.development MONGO_URI. Optional
      # service: the server boots fine without it (the demo reports off).
      - MONGO_URI=mongodb://mongo:27017/express_guide_dev
      # Same rule for redis: service name, not localhost (overrides
      # .env.development REDIS_URL). Optional service, same graceful off.
      - REDIS_URL=redis://redis:6379
    # …precedence: \`environment:\` beats \`env_file:\` — the same
    # "explicit env wins over the file" rule dotenv applies, one layer up.`,
        },
        {
          kind: 'code',
          id: 'env-app-specific:verbatim-logger',
          language: 'ts',
          caption:
            'Verbatim — the one genuinely dev-only behavior (core/logging/logger.ts): pino-pretty for humans only in development; staging and production emit the same facts as JSON',
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
      id: 'env-secrets',
      title: 'Secrets management beyond .env',
      lead:
        'A .env file is a secret taped under the keyboard. Works at home; fails an audit. What production actually uses, in escalating order of seriousness.',
      blocks: [
        {
          kind: 'text',
          id: 'env-secrets:tiers',
          body: `THE PROBLEM WITH FILES, precisely: a .env on disk is readable by everything running as you (or as the service user), lands in backups and container layers if you copy carelessly, diffs beautifully into logs and chat the first time someone pastes a bootstrap command, and has no memory of who read it. The tiers that fix it, in the order teams usually climb them: SECRETS MANAGERS / VAULTS (one paragraph) — HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault: a service that stores encrypted secrets, serves them over an API at RUNTIME to authenticated callers, and centralizes the rest of the hard problems — access audit (who fetched what, when), automatic ROTATION (database credentials that change hourly are only possible when nobody has them pinned in a file), and encryption at rest with keys you do not hold. The twelve-factor shape survives the upgrade: the app still reads process.env; a deploy-time hook (or an init container, or the platform's native integration) fetches from the vault and injects the variables — the CODE does not know a vault exists, which is the point. LEAST-PRIVILEGE SERVICE ACCOUNTS (one paragraph) — a secret that cannot be scoped cannot be protected: the database account your API uses should own its schema and nothing else (no superuser, no cross-database grants), the deploy pipeline's cloud credentials should be able to update one service and read one secret scope, and the "we rotate the master key" story should not require re-issuing every credential in the company. The blast radius of a leaked credential is decided the day you grant it, not the day it leaks. ROTATION AS A HABIT — secrets have a shelf life because people change roles, laptops die, and backups escape; a credential you have rotated once costs minutes to rotate again, one you never have is a migration. Vault-style tools make rotation cheap (issue a new version, update the pointer); files make it expensive (edit N machines), which is why file-based secrets never rotate and everyone knows it. ON THE LOCAL MACHINE, the ergonomics tiers below .env: direnv (.envrc per directory, auto-loaded into your shell — the same convenience with slightly better hygiene since it can source from elsewhere) and the 1Password CLI / Bitwarden CLI pattern (\`op run -- npm run dev\` injects secrets from your password manager's process memory into the env — the secret never exists in a file on disk at all, and access dies with your unlocked session). THE MASKING DISCIPLINE this topic's demo performs is the last mile that applies at EVERY tier: log and render CONFIGURATION (ports, paths, levels), never CREDENTIALS — mask anything secret-shaped at the source, because no redaction layer downstream can un-leak a value that already reached a log shipper.`,
        },
        {
          kind: 'code',
          id: 'env-secrets:masking-rules',
          language: 'ts',
          caption: 'Verbatim — the masking rule this app\'s env inspector runs before anything renders (presentation/routes/env_demo_routes.ts)',
          source: 'server/src/presentation/routes/env_demo_routes.ts',
          code: `/** A variable whose NAME confesses ("token", "secret", "password"…) is always hidden. */
const SECRET_NAME_PATTERN = /secret|token|passkey|password|passwd|credential/i;

export function maskEnvValue(name: string, raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'unset';
  if (SECRET_NAME_PATTERN.test(name)) return 'set (hidden)';
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') return 'set (hidden)';
  } catch {
    // Not a URL — a plain value; the rules above already decided.
  }
  return raw;
}`,
        },
      ],
    },
    {
      id: 'env-flags',
      title: 'Feature flags vs environment config',
      lead:
        'Config answers "how does the SAME code run here?" Flags answer "which code runs?" Conflating them is how staging stops being a rehearsal of production.',
      blocks: [
        {
          kind: 'text',
          id: 'env-flags:divide',
          body: `THE DIVIDE, stated operationally: an ENVIRONMENT CONFIG value changes how IDENTICAL code behaves in a deployment (log level, database address, whether an optional service is wired) — it changes at DEPLOY time, ideally never mid-flight, and its whole job is making one artifact fit many homes. A FEATURE FLAG changes WHICH code executes (new checkout flow vs old, dark-launched API v2, the kill-switch on a flaky integration) — it changes at RUNTIME, per-release or per-request, and its whole job is decoupling DEPLOY from RELEASE. The confusion is expensive in both directions: put a flag's value in .env and you have made release a redeploy (the flag cannot move without restarting the process — enjoy your 2am rollout), and made environments lie (staging with "v2 on" in its file no longer rehearses production's "v2 off"); put environment config in a flag system and every deploy now depends on the flag vendor being up. FLAG SYSTEMS GROW INTO what files cannot be: per-user targeting (internal staff first, then 1%, then everyone), percentage rollouts with consistent bucketing, kill switches that revert in seconds, and audit trails of who flipped what. The heavyweight tier (LaunchDarkly, Unleash, Flagsmith, OpenFeature as the vendor-neutral API layer) earns its cost when you have enough features-in-flight to need the targeting; below that, the pattern is a thin table (name → enabled/percentage/cohort) served from a store your process re-reads on a short interval. THIS APP'S RUNTIME COUSIN is the scenarioStore you have been clicking since the first demo: PATCH /api/demo/scenario flips dataMode (fake vs live repositories) and injectFailure WITHOUT a restart — structurally a flag (runtime, reversible, process-wide), purpose-built for teaching, and pointedly NOT read from any .env at request time: it can be SEEDED from an environment variable at boot (SCENARIO_INJECT_FAILURE, so a compose service can start pre-broken for the failure-injection lesson) but its live state is runtime-owned. That split is the whole teaching in miniature: the environment decided the STARTING state; the flag owns everything after.`,
        },
        {
          kind: 'code',
          id: 'env-flags:scenario-cousin',
          language: 'bash',
          caption: 'The scenario toggles — runtime flags, seedable from the environment but never re-read from it',
          code: `# A runtime flag flip — no restart, immediately visible to every request:
curl -s -X PATCH localhost:4000/api/demo/scenario \\
  -H 'content-type: application/json' -d '{"dataMode":"live"}' | jq
curl -s -X PATCH localhost:4000/api/demo/scenario \\
  -H 'content-type: application/json' -d '{"injectFailure":true}' | jq

# …versus the environment SEED that only decides where the flag STARTS
# (core/scenario reads SCENARIO_INJECT_FAILURE once at boot — after that,
# the store owns the state and the file/environment is never consulted again).

# And the contrast that completes the picture — environment CONFIG cannot
# move without a restart, which is exactly why it is the right home for
# ports, paths, and service addresses, and the wrong home for releases:
#   LOG_LEVEL=info npm run dev        ← new behavior, new process
#   PATCH /api/demo/scenario          ← new behavior, same process`,
        },
      ],
    },
    {
      id: 'env-live',
      title: 'The config inspector from a terminal',
      lead:
        'The app introspects its own frozen AppConfig and serves it with every secret masked — the resolution order, the loaded file, and the environment as the process actually sees it, inspected from a terminal (the interactive inspector lives in the Validated config at boot section above).',
      blocks: [
        {
          kind: 'text',
          id: 'env-live:intro',
          body: `THE ENDPOINT is GET /api/demo/env/inspect — the config pipeline with its jacket open, safely. It reports the FROZEN CONFIG the whole process shares (nodeEnv, ports, logLevel, dbPath — shown because a filesystem path is configuration, not a credential), the PROCESS FACTS (node version, pid, working directory — the things you reach for when a health check asks "what is actually running"), the DERIVED ENV FILE: \`.env.\${nodeEnv}\` computed exactly the way app_config computes its dotenv path (under vitest, nodeEnv reports 'development' and the derivation honestly says .env.development — the file that was actually loaded), plus whether that file EXISTS on disk, because dotenv never errors on a missing file and a staging box that did not ship one should be visible as such. THE MASKED ENVIRONMENT VIEW is the demo's contract: NODE_ENV, PORT, GRPC_PORT, LOG_LEVEL and SQLITE_PATH render their real values (they are configuration, and the lesson needs to see them); MONGO_URI and REDIS_URL render ONLY 'set (hidden)' or 'unset' — connection strings can carry credentials, so their values never leave the process through this endpoint; and anything else in the environment whose NAME confesses (token, secret, password, passkey, credential) is counted into hiddenSecretNames with the value never rendered. Two masking rules run in order — the NAME rule (a confessing name is always hidden) and the VALUE rule (a URL with embedded credentials is hidden even under an innocent name) — both quoted verbatim in section 6. THE CONSOLE (in the Validated config at boot section above) adds the static strip the endpoint cannot know: what DIFFERS per environment in this repo's three real files (the section 5 table as prose — dev's debug logs and localhost services, staging's near-empty file exercising defaults with features off, production's deliberately-absent mongo). Run the endpoint under different NODE_ENVs (\`NODE_ENV=staging npm run dev\`) and watch the config row change while the code, manifestly, does not.`,
        },
        {
          kind: 'code',
          id: 'env-live:curl',
          language: 'bash',
          caption: 'The same inspection from a terminal — including under a different environment',
          code: `# The config as the process actually holds it (masked view included):
curl -s localhost:4000/api/demo/env/inspect | jq

# The parts that teach: which file dotenv loaded, and what is hidden:
curl -s localhost:4000/api/demo/env/inspect \\
  | jq '{nodeEnv, envFileLoaded, envFileExists, mongoConfigured, redisConfigured}'
curl -s localhost:4000/api/demo/env/inspect \\
  | jq '{maskedEnv, hiddenSecretNames}'

# The one-artifact argument, run it yourself — same code, different environment:
NODE_ENV=staging  npm run dev   # then re-run the curl: logLevel=info,
                                # mongoConfigured=false (staging's file is minimal)
NODE_ENV=production npm run dev # and again: same shape, mongo still off —
                                # deliberately, per .env.production's comment

# And the boot-time validation failing the way it should (one line, at startup):
NODE_ENV=production LOG_LEVEL=verbose npm run dev
#   Error: Invalid LOG_LEVEL "verbose". Expected one of: fatal, error, warn, info, debug, trace.`,
        },
      ],
    },
  ],
};
