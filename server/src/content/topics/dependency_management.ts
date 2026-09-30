import type { Topic } from '../types.js';

/**
 * The Dependency Management topic — the guide's tour of ITS OWN manifest.
 * Every number and every version below was read from this package's real
 * package.json / package-lock.json; the demo at the end reads them live at
 * runtime, so nothing here can drift far from the truth without the endpoint
 * noticing first.
 */
export const topicDependencyManagement: Topic = {
  id: 'dependency-management',
  title: 'Dependency Management',
  subtitle:
    'npm, semver, lockfiles, and the DI container this server is wired through.',
  group: 'platform',
  order: 2,
  sections: [
    {
      id: 'deps-surface',
      title: 'Dependencies are product surface',
      lead:
        'Twenty lines in a manifest become hundreds of installed packages you ship, answer CVEs for, and upgrade forever. This app\'s own manifest is the working example.',
      blocks: [
        {
          kind: 'text',
          id: 'deps-surface:audit-habit',
          body: `THE ARGUMENT, stated once and then demonstrated for the rest of the topic: a dependency is not a line in package.json — it is CODE YOU SHIP (it executes inside your process, with your privileges, on every request that touches it), plus ITS TRANSITIVE GRAPH (each of its own dependencies, recursively — npm resolves the whole tree, and you review none of it by default), plus its CVE SURFACE (when a advisory drops for something three levels down, YOUR build is the one that has to update), plus its UPGRADE BURDEN (every major of every dep, for as long as you maintain the app). The direct count is what you CHOSE; the transitive count is what you BOUGHT. In this very package: 20 direct dependencies (the verbatim manifest is below) — and the lockfile that pins them counts roughly 356 resolved package entries the day this was written. Twenty decisions, three hundred and fifty-six packages in the artifact. That ratio is NORMAL, which is exactly why the audit habit exists. THE AUDIT HABIT, cheap enough to be weekly: \`npm outdated\` (what drifted), \`npm audit\` (what is known-broken, mapped to your tree), and a glance at \`npm ls <name>\` when you want to know WHY something is there (the inverse question — "who pulled this in?" — is what the lockfile answers structurally). None of these need a security team; they need ten minutes and a calendar entry. THE SPLIT THIS MANIFEST MAKES: dependencies are what RUNS in production (express, pino, better-sqlite3, the validators, sharp…) and devDependencies are what BUILDS and TESTS the thing (typescript, tsx, vitest, supertest, pino-pretty, the @types). The distinction is not cosmetic — the production Dockerfile in section 5 installs with \`npm ci --omit=dev\`, so a dependency in the wrong list ships code to prod that never needed to be there, and a devDep listed as a dependency ships dead weight (or build tooling) to every runtime container. THE HONEST WAR STORY from this repo's own decision log, quoted verbatim: "lockfiles generated with npm@12 (npm 10 arborist crash on fresh resolution; npm ci under npm 10 verified green)". Read that again as a semver story, because it is one: the same npm major-line ecosystem, two point releases, and a fresh resolution that CRASHED under npm 10's dependency solver while npm 12 generated the identical lockfile happily — and, the part that saved the day, npm 10 could still CONSUME that lockfile perfectly via \`npm ci\`. The lockfile (next sections) is the contract; the tool that writes it is replaceable. When your toolchain betrays you, pinning the OUTPUT and verifying the INSTALL is a real escape hatch, not a workaround you should be embarrassed by.`,
        },
        {
          kind: 'code',
          id: 'deps-surface:verbatim-manifest',
          language: 'json',
          caption: 'Verbatim — this server\'s entire package.json (server/package.json)',
          source: 'server/package.json',
          code: `{
  "name": "express_developers_guide_server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "test": "vitest run",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@grpc/grpc-js": "^1.14.5",
    "@grpc/proto-loader": "^0.8.1",
    "better-sqlite3": "^13.0.3",
    "compression": "^1.8.2",
    "dotenv": "^17.2.3",
    "express": "^5.1.0",
    "express-rate-limit": "^8.7.0",
    "express-validator": "^7.3.2",
    "graphql": "^17.0.2",
    "helmet": "^8.3.0",
    "ioredis": "^6.0.0",
    "joi": "^18.2.9",
    "mongoose": "^9.10.2",
    "multer": "^2.4.0",
    "nodemailer": "^10.0.12",
    "pino": "^10.2.0",
    "sharp": "^0.35.5",
    "swagger-ui-express": "^5.0.1",
    "ws": "^8.22.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/compression": "^1.8.1",
    "@types/express": "^5.0.3",
    "@types/multer": "^2.2.0",
    "@types/node": "^24.13.2",
    "@types/nodemailer": "^8.0.2",
    "@types/supertest": "^6.0.3",
    "@types/swagger-ui-express": "^4.1.8",
    "@types/ws": "^8.18.1",
    "pino-pretty": "^13.1.3",
    "supertest": "^7.1.4",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3",
    "vitest": "4.1.10"
  }
}`,
        },
      ],
    },
    {
      id: 'deps-semver',
      title: 'Semver for real',
      lead:
        'MAJOR.MINOR.PATCH, what the range syntaxes actually admit, and the one promise a caret is not making — your lockfile is.',
      blocks: [
        {
          kind: 'text',
          id: 'deps-semver:ranges',
          body: `THE VERSION is three numbers with one contract: MAJOR breaks API, MINOR adds behavior backwards-compatibly, PATCH fixes bugs. THE RANGES are how package.json asks for that contract: EXACT \`4.1.10\` — only that version, not 4.1.11 (this repo pins vitest exactly: the test runner is infrastructure, and infrastructure should move deliberately); TILDE \`~1.2.3\` — patches only (>=1.2.3 <1.3.0); CARET \`^1.2.3\` — patches AND minors (>=1.2.3 <2.0.0), the default everyone accepts; STAR \`*\` or \`latest\` — anything, which is not a range so much as a resignation letter; OR \`^1.0.0 || ^2.0.0\` — a union, common when a library supports two majors. WHAT npm ACTUALLY RESOLVES is the part that surprises people, and this app's own manifest is the proof: \`"express": "^5.1.0"\` is in the file, and \`5.2.1\` is what is INSTALLED — because a fresh resolve picks the newest version the range admits, not the one you typed. The string in package.json is your FLOOR plus a ceiling; the version you run is whichever satisfying version the resolver chose that day. THE PROMISE A CARET IS NOT MAKING: \`^5.1.0\` does not promise you 5.1.x forever. Two different machines running \`npm install\` a week apart can legitimately land on 5.1.0 and 5.2.1 — same manifest, different installs, "works on my machine" reborn at the package level. The thing that promises you a version is the LOCKFILE (next section) — which is why the rule "commit the lockfile" is not stylistic. WHAT SEMVER CANNOT EXPRESS: minors are supposed to be safe, but "backwards-compatible" is judged by the PACKAGE AUTHOR against THEIR definition of the API — your undocumented reliance on an internal timing quirk can break on a patch release, legally. And deprecations ride inside "compatible" minors: express 5 arrived as a major precisely because enough of those judgments accumulated. THE 0.X CAVEAT, live in this manifest: \`"@grpc/proto-loader": "^0.8.1"\` resolves to 0.8.1 and will never admit 0.9.0 — because below 1.0.0, semver says NOTHING is stable, so caret and tilde both collapse to patches-only (\`^0.8.1\` means >=0.8.1 <0.9.0). A package at 0.x is telling you its MAJORS are its MINORS; plan upgrades accordingly. PEER DEPENDENCIES, one paragraph: a peerDep is a dependency the package EXPECTS YOU to provide — the plugin pattern (an express middleware declares express as a peer, not a dep, so there is exactly one express in the process, and its plugin type-checks against YOUR version). npm 7+ auto-installs peers, which mostly fixed the old "please install these manually" misery, but the underlying hazard moved rather than died: node_modules is FLAT (npm hoists everything to the top level when versions permit), so a package you never declared can still be require-able from your code — the PHANTOM DEPENDENCY. It works, until a transitive bump un-hoists it and your import explodes in CI for no reason you wrote. The cure is discipline (import only what you declare) or a strict tool (pnpm, or npm's --install-strategy), but the first move is just knowing the flat directory lies about what's yours.`,
        },
        {
          kind: 'code',
          id: 'deps-semver:real-resolutions',
          language: 'text',
          caption: 'The manifest\'s own ranges vs what the lockfile actually pinned — served live by the manifest demo in the next section',
          code: `package.json (wanted)        lockfile (resolved)     what happened
───────────────────────────  ──────────────────────  ─────────────────────────────────
express        ^5.1.0    →   5.2.1                  a fresh resolve admitted a newer
                                                   minor than the one typed (the
                                                   caret's real meaning)
dotenv         ^17.2.3   →   17.4.2                 same story, two minors ahead
pino           ^10.2.0   →   10.3.1                 same story
better-sqlite3 ^13.0.3   →   13.0.3                 newest satisfying version was
                                                   the one typed — resolve-day luck
@grpc/proto-   ^0.8.1    →   0.8.1                  0.x: caret collapses to patches
loader                                          (>=0.8.1 <0.9.0), 0.9 needs a edit
vitest         4.1.10    →   4.1.10                 EXACT pin: the test runner is
                                                   infrastructure, moved deliberately`,
        },
      ],
    },
    {
      id: 'deps-lockfile',
      title: 'The lockfile',
      lead:
        'package-lock.json is the difference between "a recipe" and "an order": it pins the entire resolved tree so every machine installs byte-identical node_modules.',
      blocks: [
        {
          kind: 'text',
          id: 'deps-lockfile:guarantee',
          body: `WHAT IT GUARANTEES: a lockfile records, for every package in the resolved tree, the EXACT version, the resolved URL (often with an integrity hash — sha512 — so the tarball itself is verified, not just the version), and the dependency EDGES that got it there. Install from a lockfile on any machine, in any year, and you get the same bytes the original resolver chose. WHAT IT COSTS: nothing, really — which is why "commit the lockfile" is universal advice for APPLICATIONS. (Libraries are the opposite: a published lib's lockfile describes its dev environment and is usually gitignored, because consumers resolve THEIR own tree around the lib's range constraints. Applications deploy; libraries are ingredients.) NPM CI VERSUS NPM INSTALL — the distinction that matters operationally: \`npm ci\` DELETES node_modules, installs EXACTLY the lockfile, and HARD-FAILS if package.json and the lockfile disagree (out of sync — the error is the feature); it is the CI/Docker/deploy command, and it is what BOTH of this app's Dockerfiles run. \`npm install\` is the development command: it reconciles the world — installs what's missing, updates the lockfile when you add/remove/change a range, and may pull newer satisfying versions for new packages it has to resolve anyway. The failure mode it owns is LOCKFILE DRIFT: you edit package.json by hand (or a merge mangles it), and now the manifest and the lock disagree — \`npm install\` will silently heal it by rewriting the lock, \`npm ci\` will refuse, and CI refusing is the safe order of events. A POCKET PROCEDURE for reading a lockfile entry: find \`"node_modules/<name>"\` in the \`packages\` map (lockfileVersion 3's layout — one entry per physical path in the tree, which is how the SAME package at two versions coexists: \`node_modules/foo\` and \`node_modules/bar/node_modules/foo\`); read \`version\` (the pin), \`resolved\` (where the tarball came from), \`integrity\` (the hash proving you got what was ordered), \`dependencies\` (its own declared ranges — resolved elsewhere in the map), and \`dev\` (true when only devDependencies pulled it in — which is how \`npm ci --omit=dev\` knows what to skip). THE npm@12 STORY lands here because the lockfile is where it happened: this repo's locks are generated by npm 12 (npm 10's arborist crashed resolving this tree fresh — decision log), and npm 10 still installs them perfectly, because the lockfile is a DATA CONTRACT between npm versions, not an internal cache. That is also the strongest argument for committing it: the contract is what let the tool that WROTE the file be different from the tool that CONSUMES it, mid-project, with zero re-resolution risk.`,
        },
        {
          kind: 'code',
          id: 'deps-lockfile:verbatim-entry',
          language: 'json',
          caption:
            'Verbatim — one real entry from this server\'s package-lock.json (abridged to the fields that teach)',
          source: 'server/package-lock.json',
          code: `"node_modules/express": {
  "version": "5.2.1",
  "resolved": "https://registry.npmjs.org/express/-/express-5.2.1.tgz",
  "integrity": "sha512-hIS4idWWai69NezIdRt2xFVofaF4j+6INOpJlVOLDO8zXGpUVEVzIYk12UUi2JzjEzWL3IOAxcTubgz9Po0yXw==",
  "license": "MIT",
  "dependencies": {
    "accepts": "^2.0.0",
    "body-parser": "^2.2.1",
    "content-disposition": "^1.0.0",
    // …twenty-nine runtime ranges in total — the transitive graph this entry admits…
    "vary": "^1.1.2"
  },
  "engines": {
    "node": ">= 18"
  }
}

// The lockfile header the demo endpoint reports live:
//   "lockfileVersion": 3   — v3 = the "packages" map keyed by physical path
//                           (v1/v2 kept a legacy "dependencies" tree too;
//                            npm 7+ writes 2 or 3, npm 9+ writes 3 only)`,
        },
        {
          kind: 'demo',
          id: 'deps-lockfile:manifest-demo',
          demoId: 'deps:manifest',
          title: 'The manifest inspector: this server\'s real dependency tree, wanted vs resolved',
          description:
            'Real files read at runtime — every runtime dependency with its package.json range beside the lockfile pin, the devDependency count, and the lockfile stats (lockfileVersion, the resolved-entry package count, the npm@12 generator note from the decision log). The transitive gap between the direct count and the lockfile count is the topic\'s argument rendered as a number.',
        },
      ],
    },
    {
      id: 'deps-upgrades',
      title: 'Upgrades without fear',
      lead:
        'A rhythm, not an event: minors ride in often and get reviewed lightly; majors get the canary-commit treatment; automation opens the pull request but never merges it.',
      blocks: [
        {
          kind: 'text',
          id: 'deps-upgrades:strategy',
          body: `THE STRATEGY SPLITS ON THE MAJOR DOT, because the semver contract does. MINORS AND PATCHES are promised compatible, so the practice is FREQUENT AND BORING: run them weekly-ish in a batch, \`npm install\` (updates the lock), then run the app's actual verification — for this repo that is \`npm test\` + \`npm run build\` in server AND client, a definition-of-done you can paste. Frequent matters more than thorough: 30 tiny upgrades over 30 weeks is an hour each; the same 30 accumulated for a year is a forensic project, because when something breaks you have 30 suspects. MAJORS are promised BREAKING, so they get the careful path: read the RELEASE NOTES / CHANGELOG first — the maintainers wrote down what broke, which is faster than diffing behavior yourself; this repo lived the example twice recently (express 4→5 changed wildcard route syntax and made rejected async handlers reach the error middleware — the routing topic documents the array-shaped \`*splat\` surprises; ioredis 6 changed its default-export shape under NodeNext). Then the CANARY-COMMIT PATTERN: upgrade ONE major (not a batch), commit it alone with a message that names it ("express 4→5"), run the verifier, and ship or revert THAT. The point of the isolation is blast-radius accounting — when Thursday's regression appears on Monday, \`git log\` names the suspect in one line instead of "the big upgrade commit". TOOLS THAT RUN THE SAME PLAYBOOK FOR YOU: \`npm outdated\` shows wanted-vs-latest per package (your drift map); \`npm audit\` maps known advisories onto YOUR tree and proposes the bump that fixes each (many fix with a patch-level change); Renovate and Dependabot are the automation tier — they watch the manifest, open a pull request per update (or one grouped PR for the boring patch batch), and run your CI on it. What they deliberately do NOT do is MERGE: the automation proves the build is green, and a human decides what ships. Green CI on a major bump is necessary and deeply insufficient — the breaking change that matters is the one no test asserts on. THE LEFT-PAD LESSON (section 6 makes the checklist formal) in upgrade clothing: the ecosystem's most famous outage was a dependency REMOVAL, not a bad version — an 11-line package a quarter of the web transitively required was unpublished by its author, and builds everywhere stopped resolving. npm's response made unpublishing published versions effectively impossible and proxies/registries exist now, but the structural lesson survived: your lockfile's integrity hashes and committed state are also a CACHE against the registry changing its mind.`,
        },
        {
          kind: 'code',
          id: 'deps-upgrades:commands',
          language: 'bash',
          caption: 'The audit rhythm this repo actually uses (server/ or client/)',
          code: `# What drifted since the last lock:
npm outdated

# What's known-broken in YOUR resolved tree (with the fix bump per advisory):
npm audit

# The boring lane — batch minors/patches, then prove it:
npm install                        # or: npm update (in-range bumps only)
npm test && npm run build          # the definition of done, both packages

# The careful lane — ONE major, alone, in its own commit:
npm install express@5              # (example: the 4→5 this repo already did)
npm test && npm run build
git commit -m "express 4→5 — one major per commit"

# The reconciler — refuses when manifest and lock disagree (CI's job):
npm ci`,
        },
      ],
    },
    {
      id: 'deps-docker',
      title: 'Docker and node_modules',
      lead:
        'The app\'s own Dockerfiles are the lesson: manifests copied first, npm ci in its own layer, source copied after — and never, ever a node_modules COPY\'d from a mac.',
      blocks: [
        {
          kind: 'text',
          id: 'deps-docker:layers',
          body: `WHAT THE REAL FILES DO (both quoted verbatim below — this is description, not aspiration): the DEV Dockerfile copies \`server/package*.json\` FIRST, runs \`npm ci\`, and only THEN copies the rest of server/ — because DOCKER LAYERS CACHE IN ORDER: while package.json and package-lock.json are unchanged, the \`npm ci\` layer is a cache hit and a source edit costs you one fast COPY instead of a full dependency reinstall; change the manifest and Docker correctly invalidates from that layer down and reinstalls. The glob matters too — \`package*.json\` catches package.json AND package-lock.json, so a lockfile change also busts the cache, which is exactly when a reinstall is needed. The PROD Dockerfile runs the same copy-manifests-first shape across THREE STAGES: a build stage does full \`npm ci\` (devDeps included — tsc lives there) and compiles; a prod-deps stage does \`npm ci --omit=dev\` (production deps only, no typescript/tsx/vitest in the shipped image); and a runtime stage copies the BUILT dist/ and the prod node_modules over, carrying no compilers at all — the multi-stage pattern's whole point is that the compiler never leaves the factory. WHY node_modules MUST NEVER BE COPY'D FROM A MAC: (1) BINARIES — this manifest is full of native modules (better-sqlite3, sharp) compiled for YOUR chip and YOUR macOS; the container is linux/arm64 or linux/amd64, and a copied node_modules segfaults or refuses to load with ERR_INCOMPATIBLE_PLATFORM — the fix is always "let the container npm ci its own"; (2) SIZE AND HYGIENE — a mac node_modules is a hoisted tangle possibly missing platform-specific optional deps for the target; (3) it also defeats the layer cache, since a source COPY would sweep node_modules in with it. THE COMPOSE TRICK the dev stack uses to have it both ways (live source mount, image-built modules): the volume list mounts \`./../server:/app\` for live editing AND declares \`/app/node_modules\` as an ANONYMOUS VOLUME — Docker's rule is that more-specific volume paths shadow the broader mount, so the directory the npm ci layer built survives underneath the source bind-mount. You edit source; the container keeps its own linux-native modules. THE .dockerignore is the other half of the contract: this repo's ignores \`**/node_modules\` (never SHIP the host's tree into build context — size and the binary problem again), \`**/dist\` (the image builds its own), \`**/.env*\` (environment config enters via env_file/environment at RUN time, not baked at BUILD time — the environments topic's whole subject), and \`**/*.md\` + \`.git\` + \`.DS_Store\` (context noise). The pattern to internalize, because it is the same in every language's Docker world: COPY THE MANIFEST ALONE → INSTALL → COPY THE SOURCE. Dependency layers and code layers have different change frequencies; ordering the Dockerfile by that frequency is the entire optimization.`,
        },
        {
          kind: 'code',
          id: 'deps-docker:verbatim-dockerfile-dev',
          language: 'dockerfile',
          caption:
            'Verbatim — the whole dev file (.docker/server/Dockerfile.dev): manifests first, npm ci in its own layer, source after — plus the native-build toolchain better-sqlite3\'s install needs',
          source: '.docker/server/Dockerfile.dev',
          code: `FROM node:22-alpine
WORKDIR /app
# better-sqlite3's install runs node-gyp via npm's binding.gyp default —
# python3/make/g++ or npm ci fails ("gyp ERR! find Python"). The dev image
# keeps the toolchain: dev is where you rebuild natives constantly. See
# Dockerfile.prod for the full story and the no-compilers runtime stage.
RUN apk add --no-cache python3 make g++
# Copy manifests first to leverage Docker layer caching.
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
EXPOSE 4000
# \`npm run dev\` = tsx watch src/server.ts; the app binds 0.0.0.0 so the port map works.
CMD ["npm", "run", "dev"]`,
        },
        {
          kind: 'code',
          id: 'deps-docker:verbatim-dockerfile-prod',
          language: 'dockerfile',
          caption:
            'Verbatim — the whole prod file (.docker/server/Dockerfile.prod): three stages — build (full npm ci for tsc), prod-deps (npm ci --omit=dev), runtime (node + artifacts, NO compilers). Abridged below it: the .dockerignore and the compose shadow-mount trick',
          source: '.docker/server/Dockerfile.prod',
          code: `# ---- build stage: compile TypeScript (dev deps never leave this stage) ----
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---- prod-deps stage: install PRODUCTION deps (with their native build) ----
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---- runtime stage: node + built artifacts, NO compilers in the image ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]

# ---- .dockerignore (the whole file) — what never enters the build context ----
#   **/node_modules
#   **/dist
#   **/.env*
#   **/*.md
#   .git
#   **/.DS_Store

# ---- the compose shadow-mount trick (.docker/docker-compose.yml, server svc) ----
#   volumes:
#     # Live source; the anonymous volume keeps the image-built node_modules.
#     - ./../server:/app
#     - /app/node_modules`,
        },
      ],
    },
    {
      id: 'deps-choosing',
      title: 'Choosing dependencies',
      lead:
        'Before the install: the checklist. After left-pad, "is it on npm" is not due diligence.',
      blocks: [
        {
          kind: 'text',
          id: 'deps-choosing:checklist',
          body: `THE CHECKLIST, in descending order of how often it saves you: MAINTAINED — commits and releases in the last year, issues getting responses, a release AFTER the last big advisory (not just a promise); TESTED — a real CI badge, meaningful coverage of its own behavior (a validation library whose own fixtures are thin is a prophecy); LICENSE — permissive (MIT/ISC/Apache/BSD) needs no thought; copyleft (GPL family) in a SERVER dep is usually fine (the server binary isn't distributed) but is a legal-review flag the moment code ships to a client — and "no license" means NOBODY may use it, however many stars it has; SIZE and TRANSITIVE COUNT — \`npm info <name>\` shows the dependency list before you install; one utility package pulling forty transitive deps is the audit surface from section 1 compounding; DOCUMENTED CHANGELOG — the thing you will read during every major upgrade, whose absence you will pay for repeatedly; RELEASE DISCIPLINE — does it follow semver, or do breaking changes ride minors (check the history for complaints)? BUILD-VERSUS-BUY, the honest frame: the alternative to a dependency is not zero code, it is code YOU maintain — this repo makes the call in both directions ON PURPOSE. It HAND-ROLLS the things whose teaching value or shape is the point and whose scope is bounded: the session store, the HS256 JWT service, the OAuth code store, the SSE feed, the websocket hub, the job queue, the rate-limiter twin — each is a few hundred lines, no deps, and the security/testing topics own their lessons. It INSTALLS the things where the surface area is unbounded and the ecosystem's battle-testing is the product: express (an HTTP framework is thousands of edge cases), helmet (the header matrix changes as browsers do), sharp and better-sqlite3 (native code you could not write and should not bind by hand), zod/joi/express-validator (whole grammar engines). The rule of thumb that falls out: hand-roll what fits in your head and your test suite; install what only survives contact with millions of users. THE LEFT-PAD LESSON as the closing cautionary tale, because it is the checklist compressed into one event: March 2016, a developer unpublished eleven packages over a naming dispute; one of them — left-pad, 11 lines that pad strings — was a transitive dependency of Babel, React, and thousands more; npm installs worldwide began failing within minutes; npm eventually restored the package under an forced policy change (unpublishing a version others depend on is now effectively impossible after 24 hours). The industry's takeaways all appear somewhere above: know your transitive tree (npm ls), lock and commit it (the lockfile's integrity hashes pin WHAT you install even when the registry wobbles), prefer maintained packages with institutional backing for load-bearing spots, and remember that the registry is infrastructure you depend on — mirror or cache it (Verdaccio, Artifactory, the CI cache) if an afternoon of failed installs costs you more than a mirror.`,
        },
        {
          kind: 'code',
          id: 'deps-choosing:handrolled-vs-installed',
          language: 'text',
          caption: 'This repo\'s own build-vs-buy ledger — both columns are deliberate',
          code: `HAND-ROLLED (bounded scope, teaching value, zero deps)   INSTALLED (unbounded surface, battle-tested)
─────────────────────────────────────────────────────  ─────────────────────────────────────────────
session store + cookie utils                           express        — HTTP's thousands of edge cases
HS256 jwt_service (alg pinned, constant-time)          helmet         — the header matrix, browser-tracked
oauth_store (single-use codes, burn-on-consume)        better-sqlite3 — native bindings, correct by craft
SSE feed (headers once, Last-Event-ID replay)          sharp          — libvips; never bind C++ by hand
websocket chat hub (ping/pong, history ring)           zod / joi /    — whole grammar engines; the
fixed-window rate limiter (the limiter twin)           express-validator   validation topic diffs them live
job queue (backoff ± jitter, dead-letter)
CORS factory + SSRF guard (URL-parser canonicalization)

Why the split: hand-roll what fits in your head AND your test suite;
install what only survives contact with millions of users.`,
        },
      ],
    },
    {
      id: 'deps-live',
      title: 'The manifest inspector from a terminal',
      lead:
        'The app reads its own package.json and package-lock.json at runtime and serves them as data — wanted ranges beside resolved pins, and the transitive count that is the whole argument.',
      blocks: [
        {
          kind: 'text',
          id: 'deps-live:intro',
          body: `THE ENDPOINT is GET /api/demo/deps/manifest — the server opening its own jacket. It reads THIS package's package.json and package-lock.json from disk at runtime (resolved relative to the module, so the same code works under tsx in src/ and from the compiled dist/ tree), and reports: the manifest's name/version; EVERY runtime dependency with its WANTED range (the string in package.json) and its RESOLVED version (the pin in the lockfile) side by side — find express and see \`^5.1.0\` admitting 5.2.1, the caret's real meaning as a live fact rather than a table; the devDependency count; and the LOCKFILE block — lockfileVersion, the package-count heuristic, and the generator note pointing at the decision log's npm@12 story. THE PACKAGE COUNT is counted by an honestly-stated heuristic: the endpoint counts \`"resolved":\` fields in the lockfile text, because every materialized package entry in a v3 lockfile carries one (the root entry and link entries do not — which is exactly what makes it a heuristic rather than a ledger). The NUMBER is the lesson regardless of ±1: twenty direct dependencies, hundreds of installed packages. That gap is the transitive graph you ship, answer advisories for, and upgrade forever — section 1's argument, now a number you can watch grow the next time someone adds "just one package". THE CONSOLE — the inspector panel in the lockfile section above — renders the manifest as a table (name, wanted, resolved) with the lockfile stats beside it and the npm@12 story as a callout; the curl block below runs the identical inspection from a terminal. Try it after an \`npm install\` of something new and watch the count move.`,
        },
        {
          kind: 'code',
          id: 'deps-live:curl',
          language: 'bash',
          caption: 'The same inspection from a terminal',
          code: `# The whole manifest as data — name, every dep (wanted vs resolved), lockfile stats:
curl -s localhost:4000/api/demo/deps/manifest | jq '.name, .devDependencyCount, .lockfile'

# The semver lesson in one row: wanted is a range, resolved is the pin:
curl -s localhost:4000/api/demo/deps/manifest \\
  | jq '.dependencies[] | select(.name == "express")'
#   { "name": "express", "wanted": "^5.1.0", "resolved": "5.2.1" }

# The transitive gap — direct choices vs what actually got installed:
curl -s localhost:4000/api/demo/deps/manifest \\
  | jq '{direct: (.dependencies | length), lockfilePackages: .lockfile.packageCount}'

# And the audit habit, run by hand where the demo can't reach:
npm outdated && npm audit`,
        },
      ],
    },
  ],
};
