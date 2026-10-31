# AI defined section:

## Current state
- Path /Users/mak/Development/personal/express/express_developers_guide · monorepo client/ + server/ + e2e/ (host-run Playwright) + deploy/k8s/ + .github/workflows/ + .docker/ +
  .devcontainer/ · ports server 4000, client 5173 (Vite proxies /api → 4000). Concept: a runnable full-stack reference app that IS the guide — server (Express 5 + TS) carries 100% of
  the teaching; client (React 19 + Vite + TS + Tailwind v4) is a presentation-only shell rendering server-served topic content, never teaches React (react_developers_guide does).
- Server layers: src/{app,server}.ts + core/ (config, error_handling, logging incl. trace_context, result, scenario) + content/ (typed topic registry → sections → blocks, 40 topics) +
  domain/<area>/ (entities, ports, use cases; patterns/ = event store + saga; teaching/ = snippet-quote exhibits) + data/<area>/ (repo impls, DAOs, sqlite/redis/mongo/files/messaging/
  sql_depth) + di/container.ts + presentation/ (middleware, ~45 route files, grpc). Merlino-conformant: controllers layer + make_express_callback + make* frozen factories; 11 exhibit
  routers import data/ directly by documented teaching exemption (each marked).
- Client: react-guide clean architecture — core/ + domain/ + data/ + ui/ (container-resolved; no failure-injection store; demos fetch directly; server content registry = single
  topic-id source). snake_case view folders; kebab-case core/domain/data + shared ui; `const Foo = {...} as const` (enums forbidden — erasableSyntaxOnly). Theme DARK default, key
  'edg-theme'. Guide-family consistency: reuse the react guide's design tokens + screen anatomy; when unsure, look at an existing screen here. Data engineering OUT OF SCOPE.
- Verification (DoD): devcontainer `docker exec express_developers_guide_dev bash -lc 'cd /workspaces/express_developers_guide/server && npm test && npm run build'` (same client/);
  snippet spec 14/14 @ RATCHET 0; host e2e/ `npm test` (stack up) = the ONE host-npm exception (devcontainer has no sudo/Chromium libs); host node_modules of server/client stay
  EMPTY by design; `docker compose -f .docker/docker-compose*.yml config` on Docker changes; EVERY new demo endpoint needs a Supertest case. Baseline: server 855 passed | 22 skipped
  (68 files), client 372 (69 files), e2e 3 specs, coverage CI-gated (86/77/87/87). Ambient-load flakes at high loadavg — re-run before judging red (files_workbench range spec usual).
  40 topics / 58 demo ids wired INLINE beside their teaching sections; every topic ends with a terminal-companion section; count guards assert 40.
- SNIPPETS QUOTE REAL CODE — the code is the source of truth: every code block in a must-source language carries source: '<repo-relative path>' + passes content/snippet_sources.spec.ts
  strict ordered-subsequence (teaching comments + `// …` elisions allowed; RATCHET 0, never raise). New teaching = write the real implementation first, then quote it; compilable
  exhibits in domain/teaching/ ONLY when no real counterpart exists; bash/command/output blocks (63 captioned curl tours) exempt BY DESIGN; never relabel a language to dodge the check.
- Invariants: presentation → domain ← data (client ui → domain ← data); controllers/routes never import data; DTOs never leak past repo impls · thin controllers (parse/validate → use
  case → map Result→HTTP) · ONE typed error taxonomy end-to-end (exceptions → middleware → failures → envelope; async errors guarded, nothing swallowed, every failure logged with
  request ID) · DI at the composition root, fake/live switchable · backend canon concept-first (tree reused for the future flask/fastapi/springboot guides).
- Devcontainer = the ONLY dev path (dev + server + client + redis + mongo). Gotchas: NODE_ENV stays UNSET in the dev service · fresh anon volumes root-owned → chown+setpriv bootstrap ·
  shared package.json scripts run in EVERY container · oauth router's urlencoded parser parses bodies for LATER-mounted routers too (patterns specs use JSON arrays) · scrypt THROWS on
  N=2^15,r=8 defaults → password_hasher passes maxmem 64MB · ioredis XPENDING per-consumer counts arrive as STRINGS (Number() them) · tsx watch can freeze after concurrent content
  edits → docker restart express_developers_guide_server_dev.
- Data/service rules: mongo failed-connect catch DESTROYS the half-open connection (destroy(true) — never-reopen) · FileStore: frozen records, defensive copies on every read,
  overwriteOriginal returns the derived size · `guide:demo:` namespace owned INSIDE redis_playground (routes pass bare keys) · saga rides 'email' jobs on a DEDICATED JobQueue,
  compensate only on the final dead-letter verdict · event-store empty stream = -1; overdraft = 409 + withdrawal-rejected event; optimistic conflict = 409 without event · login
  rate-limited 30/60s (resetAuthLoginRateLimiter seam) · migration dir = SHARED state (specs track it, 8 files) · messaging specs default 503-degradation/pure-sqlite; live proofs via
  REDIS_TEST_URI=redis://redis:6379 (FLUSH-unsafe shared guide:demo: namespace) · auth: node:crypto scrypt version-prefixed; refresh tokens opaque, SHA-256-at-rest, family rotation +
  reuse-detect revoke · OTel prose-only (real part = hand-rolled W3C traceparent + span ring) · PII erasure = crypto-shred keeping rows/FKs + erasure log.
- PROD (LIVE, blue/green on the oracle-arm VM): hostname expressdevelopersguide.mayankcodeworks.com (`<project>.mayankcodeworks.com` scheme; migrated from duckdns 2026-10-23, old
  URLs 301). Platform stack docker-compose-platform.yml (edg_platform: redis + mongo only, external nets/vols, legacy volumes adopted) + per-release compose-prod under -p
  edg_blue|edg_green (project-scoped app_internal net = color DNS isolation; container_name edg_server/client_${COLOR:-blue}) · TLS edge = ONE central caddy owned by the INFRA repo
  (Ansible; flip file /home/ubuntu/express_developers_guide/platform/upstream.caddy + `docker exec caddy caddy reload` AFTER the write) · server/.env.production materialized on the
  runner from the PROD_ENV_B64 production-environment secret (machine-generated, round-trip-verify, chmod 600) · datastores unpublished in prod (loopback hatches commented);
  healthchecks busybox wget via 127.0.0.1 (busybox resolves localhost→::1); server_data/mongo_data volumes persist.
- CI/CD (in force): every `uses:` SHA-pinned · e2e = image-smoke gate BEFORE push (builds :ci images; boots platform + prod + compose.ci override, project *_ci; caddy inactive-profile;
  Playwright E2E_BASE_URL) · build-push needs [e2e, vm-arch] — vm-arch SSH recon echoes VM_ARCH_MARKER= (drone-ssh glues its banner to stdout — sed-extract, fail-loud; drone-ssh
  verifies the host's ECDSA key, not ed25519) → platforms linux/<detected> ONLY; cross-compile: both Dockerfile.prod build stages FROM --platform=$BUILDPLATFORM, server prod-deps also
  $BUILDPLATFORM + POSIX case-assertion (better-sqlite3 v13 bundles every musl prebuild, no install script; npm 10.9.9 toolchain kept) · ghcr-prune = sha-only keep-10, never
  master/latest — UNTAGGED purge UNSAFE BY CONSTRUCTION (deletes per-arch children of kept parents → pull 404 → prod outage; untagged accumulation accepted) · deploy-production.yml =
  blue/green ssh state machine (idempotent nets/vols, one-time legacy migration, per-color busybox probe, flip + caddy reload, public gate, retire other color, keep-newest-5, instant
  rollback) · dependabot.yml DELETED (manual by choice) · gitleaks + provenance/sbom + coverage artifacts 14d · client nginx: gzip + /assets/ immutable 1y + index.html no-cache.
- Umami analytics LIVE (9e7144c): client/src/ui/analytics/ beacon (call-time env read VITE_UMAMI_SRC/ID — both non-empty or total no-op; idempotent init in root-layout mount); events
  topic-open + copy-code (demo-run skipped by design — union member reserved); website_id 5f063d52-1fdb-4fd4-a502-46662344681e; values in repo-level GitHub VARIABLES — NEVER
  environment-scoped (portfolio W54 lesson); Dockerfile.prod ARG/ENV before build + ci.yml build-args (vars||secrets||''). GOTCHA: beacon is runtime-injected + dist obfuscated — only
  a runtime DOM query (script[data-website-id] + window.umami) against a served build proves it; static HTML/asset greps are false negatives.

## Active tasks
- Prometheus exporter ✅ 2026-10-31 (commit 69a95b2, PUSHED — CI/CD deploying): GET /metrics at ROOT (repo's /docs root-mount precedent for non-API tooling; NOT /api/metrics). core/metrics/prometheus_metrics.ts = prom-client ^15.1.3 Registry + collectDefaultMetrics + http_request_duration_seconds histogram; prometheus_middleware.ts uses request-logger's finish/close settle discipline (first-of-two guard). CARDINALITY RULE (repo-reusable): label by ROUTE PATTERN (req.baseUrl + req.route.path at settle), single `unmatched` bucket — never raw path (404 catch-all would mint a series per URL). Tests: 859 passed (76 files) + build + coverage gate green (88.8/79.7/90/89.9 vs 86/77/87/87). VM: infra scrapes via metrics-shim, path /metrics (see infra repo — monitoring_scraped_apps).
- ⏳ Confirm the Dependabot-config deletion reached origin/master (was staged-NOT-pushed 2026-10-21; until pushed Dependabot may open more PRs — PR #1 node-26-alpine reported, not merged;
  developer to disable "Dependabot security updates" in GH Settings, keep alerts on).
- ⏳ User action (README runbook): branch protection on master — required checks server/client/secrets/e2e, branches up to date, include admins.
- ✅ (2026-10-25) Beacon data-distinct-id: stable per-browser visitor id for Umami IP-churn dedupe — localStorage 'mcw_vid' (crypto.randomUUID + fallback; ALL storage access guarded,
  beacon still fires id-less on storage failure; attribute set BEFORE append → tracker auto-identifies at execution; no manual umami.identify, VITE_UMAMI_* gating untouched).
  Verify: devcontainer client build + dist bundle grep (mcw_vid + data-distinct-id in client/dist), client vitest 378/378; runtime identify check pending post-deploy.

# Developer defined section

- Project requirements
    - I want to implement an express project that will have react as frontend and express in backend. React will follow the code architecture similar to Development/personal/react/react_developers_guide, separating ui, domain, data layer, error handling, state management, etc while express will follow the architecture as taught here "https://merlino.agency/blog/clean-architecture-in-express-js-applications"
    - Prepare your internal instruction set from the above for every detail you require and add it in this file in "AI defined section", make sure you follow same structure of arranging information as "Developer defined section" and not randomly putting text as you wish, so you don't have to read the reference project again and again, if you ever feel confused on any step feel free to go and read the above project to clear even your smallest confusion like how files are named, structured, etc
    - I will add my requirements to this file marked as "⏳" and you will keep finishing them and marking them "✅" on completion

- Generic instructions:
    - You have to build UI using the design system implemented in the application
    - You have to follow the proper architecture that is followed in the application, for example, having use cases, repositories, repositoriesImpl, remote, DTOs, local, DAOs, exception handling, and so on
    - You have to check if existing components can be reused instead of creating new ones. If a component is to be used in a single file, then better to make it a function inside that view. If a component is to be used in multiple files, then create it inside the global ui/components
    - If feeling confused about how to do things, you are free to check how it's done in other parts of this app; the goal is to maintain consistency throughout the app
    - You have to follow few principles to write quality code:
        - Core programming principles:
            - DRY, KISS, YAGNI, SOLID, Separation of concerns, Single source of truth
        - Object oriented design if required
            - Encapsulation, Abstraction, Inheritance, Polymorphism, Composition over inheritance, Command query separation, Law of Demeter, Dependency Injection, Inversion of control, High cohesion, Low coupling
        - Software design
            - Modularity, Maintainability, Readibility, Extensibility, Defensive programming (input is hostile), Immutability, Pure functions, Referential Transparency, Composition, Lazy evaluation
        - Code quality
            - Self documenting (descriptive naming), Consistent formatting, Error handling
        - Concurrency
            - Thread safety, Synchronization, Immutability
        - Security
            - Least priviledge, Input validation, Secret management
        - Testing
            - Unit tests, Integration tests, Test behaviour not implementation
        - Refactoring
            - Incremental refactoring, remove duplication
        - Engeneering principles
            - Unix philosophy (composable tools beat monoliths)
        - Performance
            - Right algorithms, Right datastructures, Caching, Batching
    - Keep "agentic_development.md" for this project as lean as possible without compromising it's primary purpose to high quality consistent development, optimize token efficiency and seemless development across sessions. Remove the information inside the "AI defined section" that is no longer relevant and will not be usefull in future to save tokens

- Changes requested based on review:
    - I see that you have added all the demos and examples at the bottom of each page, while this can be true for some, but I them to be alongside their topics, if that topic is the first topic in page then the demo should be alongside it and not waited to be put at end, for example look at authentication module, you have put all the demos at the end line by line, if you had put them alongside their topic then they would have made more sense and easier to handle ✅ (2026-09-30: all 58 demos now inline beside their teaching sections; final sections retitled as terminal companions)
    - I still see that some code snippets contain no valid code, but curl commands, not sure if I am mistaking or there's a fault ✅ (2026-09-30: investigated — no fault; all curl blocks are deliberately bash-labeled, captioned terminal tours, exempt from snippet sourcing by design)


- Development tasks:
    - Primary tasks are all done, they are not removed from here for future reference to other projects
