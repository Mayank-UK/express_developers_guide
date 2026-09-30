import type { Topic } from '../types.js';

/**
 * The Deployment topic — taught by THIS repo's own .docker/ files, which are
 * curriculum as much as infrastructure (the decision log says so). Every
 * Dockerfile line, compose service, and nginx directive quoted here is
 * verbatim from the repo; the prod stack was built, booted, health-proven,
 * and torn down to back the claims. The CI workflow and the k8s supervisor
 * manifests are the repo's real files too. The TLS server block lives as a
 * labeled teaching exhibit (real certificates never live in a repo), and the
 * trust-proxy one-liner as a pinned exhibit — the only quoted code in the
 * topic that is not an already-running part of the stack.
 */
export const topicDeployment: Topic = {
  id: 'deployment',
  title: 'Deployment',
  subtitle:
    'Docker built from this repo, reverse proxies, TLS, zero-downtime restarts, and CI/CD.',
  group: 'platform',
  order: 8,
  sections: [
    {
      id: 'deploy-unit',
      title: 'Shipping an app vs running it locally',
      lead:
        'The deployment unit is the IMAGE, not the repo — and configuration moves from files to environment variables at the moment of shipping.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-unit:the-image',
          body: `WHAT ACTUALLY GETS DEPLOYED. \`npm run dev\` on your machine runs SOURCE: tsx transpiles TypeScript on the fly, Vite serves the client from memory, and everything depends on your checkout existing at that path with those node_modules. None of that exists on a server. The deployment unit is an IMAGE — a frozen filesystem plus a command — and everything the app needs at runtime must be inside it or INJECTED at run time. The two halves of this repo make the canonical pair: the SERVER ships as compiled JavaScript (tsc → dist/, then \`node dist/server.js\` — the same two scripts you see in its package.json below), and the CLIENT ships as STATIC FILES (vite build emits hashed assets a web server serves without knowing React exists — the production client Dockerfile is literally nginx + a directory). CONFIG IS ENVIRONMENT, NOT FILES: the environments topic built the app for this — dotenv loads \`.env.{nodeEnv}\` in development, but never overrides variables already in the environment, so a deployed process configured through ENV VARS (compose env_file, systemd Environment=, Kubernetes envFrom) drives the exact same validated AppConfig. That is why the prod image below never COPYies an .env file, and why the root .dockerignore EXCLUDES \`.env*\` from the build context: secrets and environment-specific values must not bake into a layer (the parity section returns to this). THE BUILD HAPPENS ONCE, IN THE IMAGE BUILD: TypeScript is a dev-time dependency — the prod-deps stage installs with \`--omit=dev\`, so tsc (and every @types package) exists only in the build stage and never reaches production. That one line is the entire argument for multi-stage builds: the compiler's footprint is build-time scaffolding, and shipping it means shipping attack surface and megabytes no request will ever touch.`,
        },
        {
          kind: 'code',
          id: 'deploy-unit:scripts',
          language: 'json',
          caption:
            'Verbatim — the scripts that define the server\u2019s build and run (server/package.json)',
          source: 'server/package.json',
          code: `{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "test": "vitest run",
    "start": "node dist/server.js"
  }
}`,
        },
        {
          kind: 'text',
          id: 'deploy-unit:why-images',
          body: `WHY IMAGES AT ALL — the three properties a bare \`node dist/server.js\` on a VM lacks. (1) REPRODUCIBILITY: the image pins the exact OS, the exact Node version, the exact compiled dependency tree — "works on the server" stops being a different claim from "works on my laptop" because they are the SAME filesystem. This repo builds on node:22-alpine; the local dev machine runs whatever Node it runs; the CI in the last section pins node-version 22 and runs the same suite again on GitHub's runners. (2) ISOLATION: the process sees the container's filesystem and network, not the host's — the prod compose file gives the server TWO networks (frontend to talk to nginx, backend to talk to redis) and redis in prod has NO published port, so the only way to reach it is from inside the backend network. A bare process on a host has no such boundary. (3) THE UNIT SUPERVISORS UNDERSTAND: every process manager in this topic — Docker's restart policy, systemd, PM2, and the Kubernetes scheduler the last section gestures at — supervises UNITS it can start, health-check, and replace. An image plus a command is such a unit; "a checkout of my repo with the right Node" is not. The price is that everything the image-build needs must be DECLARED — which is where the next section's hard-won lesson about native modules comes from.`,
        },
      ],
    },
    {
      id: 'deploy-docker',
      title: 'Docker, taught by this repo',
      lead:
        'The real multi-stage server Dockerfile, the nginx client image, the .dockerignore — and the better-sqlite3 native-module saga this repo actually hit.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-docker:server-dockerfile',
          body: `THE SERVER IMAGE, STAGE BY STAGE — this is the repo's real .docker/server/Dockerfile.prod, quoted whole below. The BUILD stage carries the toolchain and dev dependencies, compiles TypeScript, and dies there. The PROD-DEPS stage is the one most tutorials skip: it exists purely to run \`npm ci --omit=dev\` WITH build tooling present, producing a production node_modules whose install (with its node-gyp step) succeeds — while no compilers reach the runtime image. The RUNTIME stage is plain node:22-alpine plus two COPY --from lines — node_modules from prod-deps, dist from build — so the shipped image contains NO python, NO make, NO g++. Why the toolchain is needed AT ALL is the lesson this repo earned the hard way (next block); why it must NOT ship in the final image is defense-in-depth: compilers in a production image are attack surface for anyone who achieves code execution. Note also what the runtime stage does NOT have: no .env files (context-excluded), no src/ (the TypeScript never ships — source maps and error trackers are the debugging topic's answer to that), no data/ volume (sqlite lands in the container filesystem; the compose section is honest about that trade).`,
        },
        {
          kind: 'code',
          id: 'deploy-docker:server-dockerfile-quote',
          language: 'dockerfile',
          caption: 'Verbatim — .docker/server/Dockerfile.prod (three stages; toolchain never ships)',
          source: '.docker/server/Dockerfile.prod',
          code: `# ---- build stage: compile TypeScript (dev deps never leave this stage) ----
FROM node:22-alpine AS build
# better-sqlite3 is a NATIVE module, and npm's legacy binding.gyp default
# runs \`node-gyp rebuild\` at install (the package ships no install script —
# the default still fires). Without python3/make/g++ that step FAILS and
# takes npm ci with it ("gyp ERR! find Python" on a bare node:22-alpine,
# verified). The runtime binary is the bundled musl prebuild either way, but
# the install itself must succeed — so the toolchain lives in the BUILD
# stages only.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---- prod-deps stage: install PRODUCTION deps (with their native build) ----
FROM node:22-alpine AS prod-deps
# Same toolchain, same reason: \`npm ci --omit=dev\` still runs the gyp default.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---- runtime stage: node + built artifacts, NO compilers in the image ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# node_modules comes from the prod-deps stage — installed against this same
# base image. The better-sqlite3 binding that actually loads at runtime is
# the package's bundled prebuilds/linuxmusl-arm64.node (verified: the shipped
# image has no build/Release binding, and the module still answers /api/posts).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]`,
        },
        {
          kind: 'text',
          id: 'deploy-docker:native-saga',
          body: `THE NATIVE-MODULE SAGA — what actually happened when this repo first built the prod image, because it WILL happen to you. better-sqlite3 is a NATIVE addon: part C++, shipped as a .node binary that must match the OS LIBC and CPU of the process loading it — and the package handles this by BUNDLING the whole prebuilt matrix in its tarball (linux, linuxmusl, darwin, win32 — arm64 and x64 each) and loading the right one at RUNTIME through a per-platform loader. The trap is that none of that exempts you from the INSTALL: npm has a legacy DEFAULT — a package with a binding.gyp and no install script gets \`node-gyp rebuild\` run on install anyway — and that step needs python3, make, and a C++ compiler. On a dev laptop it quietly finds the local toolchain; inside node:22-alpine (no python3, no make, no g++) \`npm ci\` dies with a wall of \`gyp ERR! find Python\` and takes the whole docker build with it. The twist, verified live in a scratch container: the binding that actually RUNS is the bundled prebuild in every configuration — the shipped prod image contains NO compiled build/Release binding at all, and the module still answers /api/posts; even \`npm ci --ignore-scripts\` produces a working install here, because the prebuild loads regardless. So why pay for the toolchain instead of --ignore-scripts? Because --ignore-scripts silences EVERY package's install scripts to fix one — a blunt rule that breaks any dependency genuinely needing its own — and "the toolchain in the build stages, never in the runtime image" is the rule that generalizes. THE GENERAL RULES: (1) a native dep means your image build inherits a toolchain requirement in EVERY stage that installs it; (2) alpine uses musl, not glibc — prebuilds built for glibc linux will not load, check for linuxmusl variants (better-sqlite3 and sharp both ship them); (3) sharp, the other native-ish dep here, is the GOOD citizen pattern — per-platform binaries as npm optional dependencies (@img/sharp-linuxmusl-arm64 and friends) selected by npm itself, no scripts, no toolchain; (4) install and RUNTIME are separate questions — a dependency can run fine off bundled prebuilds while its install still hard-fails without a compiler, and the only way to know which you are holding is to build the image and watch.`,
        },
        {
          kind: 'code',
          id: 'deploy-docker:client-quote',
          language: 'dockerfile',
          caption:
            'Verbatim — .docker/client/Dockerfile.prod: the static-half pattern (build in node, ship in nginx)',
          source: '.docker/client/Dockerfile.prod',
          code: `# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- runtime stage: static bundle behind nginx, /api proxied to the server ----
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY .docker/client/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`,
        },
        {
          kind: 'text',
          id: 'deploy-docker:context-and-ignore',
          body: `THE BUILD CONTEXT is the directory sent to the daemon (here the REPO ROOT — \`context: ./../\` in both compose files, with \`dockerfile:\` pointing into .docker/), and the .dockerignore below carves it: node_modules never crosses the network boundary into the build (the mac's darwin binaries would be useless AND poison linux layers), dist is rebuilt inside rather than copied stale, and \`.env*\` files are excluded so no environment's values — including whatever real secrets they one day hold — can bake into an image layer, where they would live forever in the registry. The layer-caching choreography in the server Dockerfile is deliberate: package.json + package-lock.json are COPIED FIRST and npm ci runs BEFORE any source lands, so the multi-minute dependency install (and the native compile) only re-runs when the manifests change; source-only edits reuse the cached layers and reach \`npm run build\` in seconds. That ordering is not cosmetic — it is the difference between a two-second feedback loop and a three-minute one on every commit, and the CI section's pull-request pipeline leans on the exact same structure.`,
        },
        {
          kind: 'code',
          id: 'deploy-docker:ignore-quote',
          language: 'dockerfile',
          caption: 'Verbatim — the root .dockerignore (the build context is the repo root)',
          source: '.dockerignore',
          code: `**/node_modules
**/dist
**/.env*
**/*.md
.git
**/.DS_Store`,
        },
      ],
    },
    {
      id: 'deploy-compose',
      title: 'Compose as the smallest orchestration',
      lead:
        'One file declares the whole stack — networks, volumes, restart policies. Side by side: the dev compose you develop against and the prod compose this topic boots.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-compose:what-compose-declares',
          body: `A COMPOSE FILE IS A DECLARATION, not a script: "these services, these images, these networks, these volumes, these policies" — and \`docker compose up\` reconciles reality to it. That makes it the smallest real ORCHESTRATOR: far below Kubernetes, but it already owns the three concerns every orchestrator has — TOPOLOGY (the frontend/backend network split: nginx and the server sit on frontend; server, redis, and mongo sit on backend; the proxy can reach the app but NOT the databases directly), LIFECYCLE (restart policies, depends_on ordering), and STATE (named volumes that outlive containers — redis_data survives \`down\`). Service names ARE DNS: the nginx conf says \`proxy_pass http://server:4000\` and compose's embedded DNS resolves \`server\` to the container's address on the frontend network — no IPs anywhere. THE DEV/PROD PAIR in this repo teaches by contrast, quoted side by side below: dev bind-mounts LIVE SOURCE over the image (edit on the host, the container sees it) and shields the image-built node_modules behind an anonymous volume (otherwise the mount would shadow the compiled natives with the host's darwin ones — the native-module lesson again, from the other direction); prod mounts NOTHING — the image is the artifact, the source of truth — and reads its environment from .env.production through env_file. Both files give every service \`restart: unless-stopped\`, which is the process-manager section's Docker entry. TWO HONEST FACTS about the prod file: its redis publishes NO ports (dev publishes 6379/27017 so a HOST-run server can use them; prod keeps the databases private to the backend network), and the PROD file has NO healthchecks — dev's redis and mongo carry them (redis-cli / mongosh pings). \`depends_on\` without a \`condition: service_healthy\` waits for container START, not readiness; it is exactly enough here because the server treats every optional service as "down until proven up", but the zero-downtime section shows what a real readiness gate looks like.`,
        },
        {
          kind: 'code',
          id: 'deploy-compose:side-by-side-dev',
          language: 'yaml',
          caption:
            'Verbatim — the SAME service in both files. DEV (.docker/docker-compose.yml): the developer\'s live filesystem, env overrides',
          source: '.docker/docker-compose.yml',
          code: `  server:
    build:
      context: ./../
      dockerfile: ./.docker/server/Dockerfile.dev
    image: express_guide_server_dev
    restart: unless-stopped
    ports:
      - 4000:4000
    volumes:
      # Live source; the anonymous volume keeps the image-built node_modules.
      - ./../server:/app
      - /app/node_modules
    env_file:
      - ./../server/.env.development
    environment:
      # Inside compose the mongo service is reachable by service name, not
      # localhost — this overrides the .env.development MONGO_URI.
      - MONGO_URI=mongodb://mongo:27017/express_guide_dev
      - REDIS_URL=redis://redis:6379
    networks:
      - frontend
      - backend`,
        },
        {
          kind: 'code',
          id: 'deploy-compose:side-by-side-prod',
          language: 'yaml',
          caption:
            'PROD (.docker/docker-compose-prod.yml): the image is the artifact, env_file only',
          source: '.docker/docker-compose-prod.yml',
          code: `  server:
    build:
      context: ./../
      dockerfile: ./.docker/server/Dockerfile.prod
    image: express_guide_server_prod
    restart: unless-stopped
    ports:
      - 4000:4000
    env_file:
      - ./../server/.env.production
    networks:
      - frontend
      - backend`,
        },
        {
          kind: 'text',
          id: 'deploy-compose:when-you-outgrow',
          body: `WHEN YOU OUTGROW COMPOSE — one honest paragraph. Compose runs one host's containers and restarts them when they die; it does not schedule across machines, does not replace an unhealthy node with a healthy one elsewhere, does not roll a new version one replica at a time while probing readiness, and its \`scale\` cannot spread replicas over hosts. The moment you need any of that — multiple machines, rolling deploys, autoscaling, service discovery beyond one DNS domain — you need an orchestrator: Docker's own Swarm mode (compose-like syntax, multi-host, increasingly niche) or Kubernetes (the industry default: pods of containers, Deployments that roll replicas with readiness gates, Services/Ingress doing what the nginx front door does here). This guide teaches compose FIRST because every concept transfers: the image becomes a pod spec, the compose network becomes a Kubernetes Service, the restart policy becomes a Deployment's reconciliation loop, and the healthcheck becomes liveness/readiness probes — and then the Kubernetes section ahead walks those exact translations over the real manifests this repo ships (deploy/k8s/). Learn the small one first and the big one is vocabulary, not a new religion.`,
        },
        {
          kind: 'demo',
          id: 'deploy-compose:demo',
          demoId: 'deploy:stack',
          title: 'The stack explorer',
          description:
            'Live process facts from the server answering you, the browser origin you reached it through, and the services declared by this repo\u2019s two compose files — parsed off disk, put side by side.',
        },
      ],
    },
    {
      id: 'deploy-proxy',
      title: 'Reverse proxy and TLS',
      lead:
        'nginx as the front door: terminate TLS, serve the static client, proxy /api to Express — the shipped conf is real, the TLS block is the sketch that upgrades it.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-proxy:why-a-proxy',
          body: `WHY A PROCESS IN FRONT OF NODE. The nginx container in the prod compose is not decoration — it is the architecture's front door, doing four jobs Express should not: (1) STATIC FILES at CDN speed — the client IS a directory of hashed assets; nginx serves them with sendfile and correct cache headers, no Node event-loop involved. (2) TLS TERMINATION — certificates, renewal choreography, and the whole HTTP/2 handshake live at the edge, in a server built for exactly that; Node gets plain HTTP on a private network. Doing TLS in Node is possible (https module) but means cert files in the app image, reload logic on renewal, and a process restart to pick up new certs — the proxy isolates all of it. (3) ONE ORIGIN — the browser talks to :8080 and only :8080; / serves the SPA, /api/ is proxied to the server container by service name, and the WebSocket upgrade rides the same origin because the conf forwards the Upgrade headers. Same-origin is what makes cookies, the auth topic's session flow, and the CSP the security topic pinned all work unchanged behind the proxy. (4) A SHIELD — connection buffering, slowloris-style client slowness, and (with a few more lines) per-IP rate limiting land on nginx, not on the single-threaded loop your requests live on. THE SHIPPED CONF is quoted whole below — it is the real file the client image COPYs; note what it does NOT set: no X-Forwarded-For, no X-Forwarded-Proto (only Host). That omission is the next lesson.`,
        },
        {
          kind: 'code',
          id: 'deploy-proxy:shipped-conf',
          language: 'nginx',
          caption: 'Verbatim — .docker/client/default.conf: static root, /api proxy, SPA fallback',
          source: '.docker/client/default.conf',
          code: `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    root   /usr/share/nginx/html;
    index  index.html;

    # Proxy API calls to the Express server (compose service name).
    location /api/ {
        proxy_pass http://server:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # SPA history fallback: unknown paths serve the app, which renders the 404 view.
    location / {
        try_files $uri $uri/ /index.html;
    }
}`,
        },
        {
          kind: 'text',
          id: 'deploy-proxy:x-forwarded',
          body: `THE HEADERS THAT KEEP THE APP HONEST. Behind a proxy, every request's REMOTE ADDRESS as Node sees it is the PROXY's — without help, Express logs nginx's IP for everyone, the security topic's rate limiter counts the whole world as ONE client (5 requests total, then everyone 429s — a self-DoS wearing a security feature's clothes), and req.protocol reports http even when the visitor is on https. The fix is a contract in two halves. The PROXY half: forward what the app needs — X-Forwarded-For (the client IP, appended at each hop), X-Forwarded-Proto (what TLS actually was), X-Real-IP (the one-hop simplification). The APP half: \`app.set('trust proxy', 1)\` — "exactly ONE proxy sits in front of me; believe its X-Forwarded-* headers". Without trust proxy, Express IGNORES those headers (the safe default — believing spoofable headers from an untrusted source is how attackers mint IPs); with it, req.ip, req.protocol, and req.secure become the VISITOR's truth. THIS APP deliberately does not set it (it must be equally correct with no proxy, as in dev) — the sketch below shows the one-line change plus the proxy lines that earn it, and this topic's live demo shows the gap: the stack endpoint reads x-forwarded-proto and truthfully reports null through the shipped conf, because the shipped conf never sets it. Trust exactly the number of proxies you have (1 here; a chain like CDN→nginx needs 2, or 'loopback' when only localhost proxies) — overshooting lets clients forge the header.`,
        },
        {
          kind: 'code',
          id: 'deploy-proxy:trust-proxy-sketch',
          language: 'ts',
          caption:
            "Sketch — the two halves of the contract (proxy forwards, app trusts): the nginx half is comment-only (not in the shipped conf yet); the Express half is pinned as a teaching exhibit (server/src/domain/teaching/exhibit_c_deployment_trust_proxy.ts) because src/app.ts deliberately omits it",
          source: 'server/src/domain/teaching/exhibit_c_deployment_trust_proxy.ts',
          code: `// nginx side — add to the /api/ location:
//   proxy_set_header X-Real-IP $remote_addr;
//   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
//   proxy_set_header X-Forwarded-Proto $scheme;

// Express side — the one-line change, behind any middleware that reads req.ip:
// Behind exactly ONE proxy (the nginx container), its X-Forwarded-* headers
// are the visitor's truth; without a proxy the setting must be absent, or
// any client could forge req.ip with a header.
app.set('trust proxy', 1);`,
        },
        {
          kind: 'text',
          id: 'deploy-proxy:tls',
          body: `TLS, END TO END. The certificate flow (Let's Encrypt as the concrete example): point DNS at the host, run certbot once (\`certbot certonly --standalone -d guide.example.test\`, or the \`--nginx\` plugin that edits the conf for you), and renewals become a cron/systemd timer (\`certbot renew\` is idempotent; certificates last 90 days on purpose). The server block below is the shipped conf UPGRADED: 443 with the cert pair, the http→https redirect so plain visits are one hop from safety, and the X-Forwarded-* lines from the last block now with \`$scheme\` (so the app sees https, not a hard-coded value). TWO CONNECTIONS to the topic chain: HSTS — helmet already sends Strict-Transport-Security (the security topic pinned it in dev, where browsers correctly ignore it over plain http); behind real TLS it becomes LOAD-BEARING, and the sketch adds nginx's own always-on copy for non-HTML responses Express never touches. And upgrade-insecure-requests in the CSP — inert in dev, now actively forcing https for every subresource. THE INTERIOR of the stack stays plain http: nginx→server traffic rides the private compose network; encrypting interior hops is a real pattern (mTLS between services) but belongs to the multi-service security conversation, not the front door.`,
        },
        {
          kind: 'code',
          id: 'deploy-proxy:tls-sketch',
          language: 'nginx',
          caption:
            'Sketch — the shipped conf with TLS: the redirect, the cert pair, HSTS, and the forwarding lines (pinned as a teaching exhibit at server/src/domain/teaching/exhibit_c_deployment_tls_conf.ts — real certificates never live in a repo)',
          source: 'server/src/domain/teaching/exhibit_c_deployment_tls_conf.ts',
          code: `server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name guide.example.test;

    ssl_certificate     /etc/letsencrypt/live/guide.example.test/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/guide.example.test/privkey.pem;

    # helmet already sends HSTS on API responses; nginx adds it to everything
    # else this server block touches (static files included).
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    root  /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://server:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}

# plain http exists only to redirect (and to answer ACME challenges):
server {
    listen 80;
    listen [::]:80;
    server_name guide.example.test;
    return 301 https://$host$request_uri;
}`,
        },
      ],
    },
    {
      id: 'deploy-process',
      title: 'Process managers and zero-downtime',
      lead:
        'Something must restart the process when it dies — and something must let requests drain before it dies on purpose. The supervisor catalog, and this app\u2019s own SIGTERM drain.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-process:the-supervisor',
          body: `THE SUPERVISOR'S CONTRACT. The exception-handling and observability topics built this app to a specific contract: on an unrecoverable error, log FATAL and exit(1) — DELIBERATELY dying so state cannot rot — because SOMETHING OWNS THE RESTART. That something is the process manager, and its job list is short: start on boot, restart on crash (with backoff so a crash-looping process does not become a hot loop), forward signals so shutdown can be graceful, and restart one process at a time during deploys. THE CATALOG, in deployment order. (1) DOCKER RESTART POLICY — what this repo uses: \`restart: unless-stopped\` sits on every service in BOTH compose files (quoted in the compose section); the daemon restarts crashed containers forever, but not ones you stopped on purpose. (2) SYSTEMD — no Docker required; a ten-line unit file is the whole supervisor on any Linux host (Restart=always to the fatal-exit pattern, KillSignal=SIGTERM wired to the app's drain, TimeoutStopSec set above the app's own 10s force-exit net). (3) PM2 — the Node-native option, with a trick the others need extra work for: CLUSTER MODE forks N replicas of the app across cores (pm2 reload then restarts them one at a time — zero-downtime out of the box). One honest caveat for THIS app specifically: its demos carry in-process state (session store, chat hub, job queue, metrics) — replicas would EACH have their own, and this app's architecture is deliberately single-replica; externalizing that state (sessions to redis, queues to a worker) is what makes replicas honest, and is the scaling topic's opening problem. (4) KUBERNETES — the supervisor of supervisors, and the one this repo ships REAL manifests for (deploy/k8s/): a Deployment owns N pod replicas, restarts unhealthy ones, and rolls new versions gated on readiness probes — every idea above, at fleet scale. The quotes below are that real manifest: the supervisor contract (probes, limits) and the replica manager (the HPA), which is where systemd's and PM2's knobs live in this repo's actual artifacts.`,
        },
        {
          kind: 'code',
          id: 'deploy-process:supervisor-manifest',
          language: 'yaml',
          caption:
            'Verbatim — the supervisor manifest this repo actually ships (deploy/k8s/server-deployment.yaml, abridged): replicas, both probes, resource limits. A systemd unit expresses the same contract as Restart=always + KillSignal=SIGTERM + TimeoutStopSec above the app\'s 10s force-exit net; a PM2 file as instances + exec_mode cluster + kill_timeout',
          source: 'deploy/k8s/server-deployment.yaml',
          code: `spec:
  replicas: 2
  # …selector + pod template elided…
          # Liveness: GET /api/health — pure "process is up" check
          # (health_routes.ts; no dependencies, always 200 while alive).
          livenessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 10
            periodSeconds: 15
          # Readiness: GET /api/demo/obs/health — the observability topic's
          # readiness-shaped check strip (dependency states in the body).
          readinessProbe:
            httpGet:
              path: /api/demo/obs/health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi`,
        },
        {
          kind: 'code',
          id: 'deploy-process:replica-manager',
          language: 'yaml',
          caption:
            'Verbatim — PM2\'s cluster-mode knobs, translated into the repo\'s real replica manager (deploy/k8s/hpa.yaml): instances → replicas, one-worker-at-a-time reload → the Deployment\'s rolling update, max_memory_restart → the resource limits above',
          source: 'deploy/k8s/hpa.yaml',
          code: `spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: server
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70`,
        },
        {
          kind: 'text',
          id: 'deploy-process:graceful-shutdown',
          body: `ZERO-DOWNTIME STARTS AT SHUTDOWN. The primitive is not clever infrastructure — it is the ability to STOP TAKING NEW CONNECTIONS while FINISHING IN-FLIGHT WORK, then exit. That is exactly what server.ts does on SIGTERM (quoted below, abridged to its spine): drain gRPC first, then the optional mongo and BOTH redis connections, close the chat hub (open websockets would otherwise hold server.close() hostage), and only then server.close() — with a 10-second force-exit net so a stuck connection cannot wedge the shutdown forever (the net is what TimeoutStopSec/kill_timeout above must out-wait). Every supervisor in the catalog sends SIGTERM first precisely because of code like this; SIGKILL is what arrives when the timeout expires anyway. THE DEPLOY CHOREOGRAPHY this enables: with ≥2 replicas behind the proxy, a rolling restart removes one replica from rotation, sends it SIGTERM, WAITS for its drain (in-flight requests land, responses flush), starts the replacement, waits for its READINESS gate — and here the health topic chain pays off: GET /api/health is the liveness signal, the observability topic's /api/demo/obs/health is the readiness-shaped one (sqlite probed for real, optional services reported honestly) — and only then moves to the next replica. One replica draining at a time means the capacity dip is 1/N, never N. Compose itself does a mini version of this on \`up -d\` after a rebuild: recreate the changed container (stop → SIGTERM → drain → remove → start new). It is coarse — the whole service blinks, no readiness gate — which is the honest line between compose and the orchestrators: same SIGNALS, finer control.`,
        },
        {
          kind: 'code',
          id: 'deploy-process:shutdown-quote',
          language: 'ts',
          caption:
            'Verbatim (abridged to the spine) — the SIGTERM drain this app actually runs (src/server.ts)',
          source: 'server/src/server.ts',
          code: `function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down gracefully');
  // …drain in order: gRPC listener → mongo → BOTH redis connections →
  // chat hub (open websockets would hold server.close() open)…
  void grpcServerPromise
    .then((handle) => handle?.stop())
    .catch(() => undefined)
    .finally(() => {
      // …the mongo/redis/hub drains nest here, each in its own finally…
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
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));`,
        },
      ],
    },
    {
      id: 'deploy-cicd',
      title: 'CI/CD',
      lead:
        'The pipeline this repo RUNS: both packages, tests AND build, on every push and pull request. The workflow file below is real — the image/push stage is the declared growth path.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-cicd:pipeline',
          body: `THE PIPELINE, STAGE BY STAGE — what the real .github/workflows/ci.yml runs on every push to main and every pull request. (0) SETUP — checkout, Node 22, and the npm cache keyed on each package's lockfile (the cache is what keeps \`npm ci\` under a minute instead of under five). (1) LINT — HONEST GAP: neither package has a linter installed (no eslint, no config; the workflow's own header says "nothing faked below"), so the lint stage does not exist yet and this topic will not pretend otherwise; the first line of the pipeline's future is \`npx eslint .\` after the dependency lands. (2) TEST — \`npm run test:coverage\` on the server and plain \`npm test\` on the client: the server's Vitest/Supertest suite runs under V8 coverage with ENFORCED THRESHOLDS from vitest.config.ts (a measured floor for lines/branches/functions/statements — slip under the percentages and the build goes red, so coverage gaps become visible instead of invisible), the client's jsdom suite runs plain, with zero service containers — the workflow's header states the trick this repo earns for free: vitest runs with NODE_ENV unset, which forces the test mapping to sqlite ':memory:', and the live mongo/redis worlds are skipIf-gated, so the default CI world is hermetic by construction. (3) BUILD — both \`npm run build\`s, because a pipeline that never runs the build ships the first broken build to Docker (the server's tsc and the client's tsc -b + vite build are both compile gates). (4) IMAGE + PUSH ON TAG — the GROWTH PATH, not yet shipped: build the images from the SAME Dockerfile.prod files the compose stack uses (one artifact definition, everywhere), run the build on every PR to prove it CAN build, but PUSH only on \`v*\` tags with the semver and latest — \`needs: [server, client]\` so no image whose tests failed can ever exist (an image in a registry is a DEPLOYABLE UNIT, and a deployable unit that skipped tests is a loaded gun). THE SEMVER DISCIPLINE for tags: vX.Y.Z where X breaks API, Y adds, Z fixes — and tags are IMMUTABLE (never move a pushed tag; deploy rolls FORWARD by tagging the fix).`,
        },
        {
          kind: 'code',
          id: 'deploy-cicd:workflow-quote',
          language: 'yaml',
          caption:
            'Verbatim — the real .github/workflows/ci.yml this repo runs on every push and pull request (both packages, tests AND build — the devcontainer\'s definition of done, on GitHub\'s runners)',
          source: '.github/workflows/ci.yml',
          code: `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  server:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: server
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: server/package-lock.json
      - run: npm ci
      - run: npm run test:coverage
      - run: npm run build

  client:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: client/package-lock.json
      - run: npm ci
      - run: npm test
      - run: npm run build`,
        },
        {
          kind: 'text',
          id: 'deploy-cicd:deploy-hook',
          body: `FROM PUSHED IMAGE TO RUNNING STACK — the D in CI/CD, honestly sized for a compose deployment. The deploy hook is whatever tells the host "pull and recreate": the smallest honest version is SSH into the host and run \`docker compose -f .docker/docker-compose-prod.yml pull && docker compose -f .docker/docker-compose-prod.yml up -d\` — pull swaps the image tag, up recreates ONLY the changed containers, and the SIGTERM drain from the last section carries in-flight requests across the blink. (The image: line in the prod compose names the built image locally; a registry deployment replaces build: with image: ghcr.io/…/server:vX.Y.Z — same file, different source of truth, and the tag pin in the file becomes the deploy's audit trail.) THE GROWTH PATH, one line each: pull-based agents (watchtower) trade control for zero SSH; purpose-built CD (a GitHub Actions deploy job with environment approvals) adds gates; and Kubernetes flips the model — the cluster PULLS toward declared state and you only change the tag in a manifest. WHAT CI MUST NEVER SEE: secret VALUES. The shipped workflow uses NO credentials at all (checkout and run steps only); every future secret (a registry token, a deploy key) enters as \${{ secrets.NAME }}, stored in the repo's encrypted settings, surfacing only as an environment variable at the exact step that needs it. The next section closes the loop on where those values live at RUNTIME.`,
        },
      ],
    },
    {
      id: 'deploy-parity',
      title: 'Environment parity and secrets at deploy time',
      lead:
        'Same image, different environment — the 12-factor discipline the environments topic built, applied to the moment of shipping.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-parity:layers',
          body: `ONE IMAGE, N ENVIRONMENTS — the payoff of config-via-env: staging and production run the SAME artifacts, differing only in what the orchestrator injects. This repo's precedence chain, top wins: (1) compose \`environment:\` — the dev compose uses exactly this to REDIRECT service URLs (\`MONGO_URI=mongodb://mongo:27017/…\`) because inside the compose network the databases live at service names, not 127.0.0.1 as .env.development claims; (2) compose \`env_file:\` — the per-environment file (\`env_file: ./../server/.env.production\` in prod); (3) the IMAGE's ENV (\`ENV NODE_ENV=production\` — the one value that is genuinely the image's business); (4) dotenv — last resort, and ONLY in development, because a file inside the image would make environments distinguishable by their ARTIFACT, which is the whole anti-pattern (and the reason .dockerignore excludes \`.env*\`: an env file baked into a layer ships its values to every registry the image touches). The layers are also a debugging map: when prod behaves differently, walk the chain — environment: beats env_file:, the real environment beats dotenv, and a value you THOUGHT was set may be being overridden two layers up. SECRETS AT DEPLOY TIME follow the same shape with one more rule: the compose env_file on the HOST holds real values (git-ignored, chmod 600), CI holds its copies as GitHub secrets materialized into env vars only in the steps that need them, and the OBSERVABILITY rule from the environments topic still governs — the app's config inspector masks secret-shaped names to "set (hidden)", and no log line ever prints a value. ONE KNOWN GAP, stated rather than fixed: the repo's root .gitignore does not yet list \`.env*\` (noted in the security topic when the placeholder-only secrets were documented) — placeholder values today, but the gitignore hardening is deliberately OUT of this topic's scope and stays a declared follow-up until the repo is git-initialized with real credentials in play.`,
        },
        {
          kind: 'code',
          id: 'deploy-parity:env-override-quote',
          language: 'yaml',
          caption:
            'Verbatim — the override layer in the dev compose (.docker/docker-compose.yml): environment: beats env_file:',
          source: '.docker/docker-compose.yml',
          code: `    environment:
      - MONGO_URI=mongodb://mongo:27017/express_guide_dev
      - REDIS_URL=redis://redis:6379`,
        },
        {
          kind: 'code',
          id: 'deploy-parity:env-file-quote',
          language: 'yaml',
          caption:
            'Verbatim — the file the prod compose env_file injects (server/.env.production), all of it',
          source: 'server/.env.production',
          code: `PORT=4000
NODE_ENV=production
LOG_LEVEL=info
SQLITE_PATH=data/guide.db

# MONGO_URI is deliberately unset here — the MongoDB demo stays off until a
# mongo service exists for this environment.`,
        },
        {
          kind: 'text',
          id: 'deploy-parity:parity-and-data',
          body: `PARITY, DEFINED AND TESTED. "Works in staging" is only a claim if staging differs from production in exactly the ways you can LIST: same image (the tag pins it), same compose topology (frontend/backend networks, same restart policies), different VALUES (staging's LOG_LEVEL can be debug; prod's is info — the environments topic's own files show that pair). The parity threat is always the UNLISTED difference — a version skew, a missing env var, a volume that exists in one and not the other — and the cure is that the environment IS data: diff two env files, inspect a running container's actual env (\`docker exec <container> env\`, or \`docker inspect\`), and the gap becomes visible instead of folkloric. ONE HONEST EPHEMERALITY in this repo's prod stack, because teaching files must not lie by omission: SQLITE_PATH resolves to data/guide.db INSIDE the container filesystem, and the prod compose mounts NO volume for it — \`docker compose down\` (and container recreation on every deploy) DESTROYS the database. That is the correct demonstration posture (the guide's data is seed data; the demo repos reseed), and it is also a deliberate lesson: STATEFULness must be DECLARED. The day this database matters, the fix is one declared volume — the redis_data volume in the same file is the working pattern sitting right there: a named volume that outlives recreation, exactly the lifecycle sqlite would need to adopt.`,
        },
      ],
    },
    {
      id: 'deploy-kubernetes',
      title: 'Kubernetes without fear',
      lead:
        'The object tour over this repo\u2019s real manifests: pods, deployments, services, ingress, config and secrets, probes, autoscaling, limits — every concept tied to YAML this repo actually ships in deploy/k8s/.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-kubernetes:objects',
          body: `THE OBJECTS, EACH IN ONE LINE, EACH REAL BELOW. A POD is the smallest schedulable unit — one or more containers sharing an IP and a lifecycle; you almost never create one directly. A DEPLOYMENT is a desired-state controller over pods: "2 replicas of this pod template, kept true forever" — it replaces dead pods and rolls new versions gated on readiness (the rolling choreography from the process section, mechanized). A SERVICE is a stable name in front of a changing pod set — pods die and are reborn with new IPs; the Service load-balances across whichever pods match its selector (compose's service-name DNS promoted to a first-class object — this repo ships server-service.yaml and client-service.yaml, and the ingress routes by service NAME). AN INGRESS is the cluster's front door — the reverse-proxy section's nginx job, cluster-shaped: one host, path routing to services, TLS at the edge (quoted whole below). A CONFIGMAP is environment-as-object — the parity section's env_file, cluster-shaped — and a SECRET is its sensitive sibling (base64, access-controlled, never committed with real values; the repo ships configmap.yaml and a placeholder secret-example.yaml). PROBES and AUTOSCALING are already quoted in the process-managers section (liveness /api/health, readiness /api/demo/obs/health, the HPA's 2-to-6 replicas at 70% CPU). RESOURCE REQUESTS AND LIMITS are per-container fences: requests shape SCHEDULING (a node that fits is chosen), limits enforce CEILINGS (CPU throttled, memory OOM-killed) — the process manifest requests 100m/128Mi and limits at 500m/512Mi, and the HPA's percentage math is computed against the REQUEST. The Deployment below is the same file that section quoted, read for its OBJECT structure this time:`,
        },
        {
          kind: 'code',
          id: 'deploy-kubernetes:deployment-quote',
          language: 'yaml',
          caption:
            'Verbatim — the object identity, the non-root pod, config injection, and the ephemeral volume (deploy/k8s/server-deployment.yaml; probes and resources quoted in the process-managers section)',
          source: 'deploy/k8s/server-deployment.yaml',
          code: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: server
  namespace: express-guide
  labels:
    app.kubernetes.io/name: server
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: server
  # …the pod template repeats those labels (the selector's contract), then:
    spec:
      securityContext:
        # node:22-alpine's \`node\` user is uid 1000. The Dockerfile sets no USER
        # (image default is root), so the pod enforces non-root here.
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        # sqlite_client.ts mkdirs the db's parent dir at boot — the emptyDir
        # below must be group-writable for that.
        fsGroup: 1000
      containers:
        - name: server
          image: express_guide_server_prod:latest
          ports:
            - name: http
              containerPort: 4000
          envFrom:
            - configMapRef:
                name: express-guide-config
        # …livenessProbe + readinessProbe + resources: the process section's quote…
          volumeMounts:
            - name: data
              mountPath: /app/data
          securityContext:
            allowPrivilegeEscalation: false
      volumes:
        # SQLite is embedded → container-local by nature. emptyDir makes it
        # writable for the non-root user; it is EPHEMERAL (lost on restart,
        # per-pod — the scaling topic's statelessness lesson). Durability
        # would need a PVC or a client-server database.
        - name: data
          emptyDir: {}`,
        },
        {
          kind: 'text',
          id: 'deploy-kubernetes:ingress-and-config',
          body: `THE INGRESS, quoted whole below, is the reverse-proxy section translated: one host (guide.example.test), three path rules — /api AND /docs to the server Service on 4000 (the docs split mirrors app.ts mounting Swagger UI on the root app, beside /api), everything else to the client Service on 80 (nginx serving the static build) — and a commented-out TLS block that names exactly where certificates enter: a SECRET (real certs and keys never live in git; uncomment when one exists). pathType: Prefix is path-prefix matching; ingressClassName: nginx says WHICH controller implements the rules — the Ingress resource is just DATA, and a controller must exist to act on it, the same way compose YAML is inert without the docker daemon. CONFIG AND SECRETS close the loop the parity section opened: the pod template's envFrom loads the express-guide-config ConfigMap into environment variables — the same config-via-env contract as compose's env_file, so the same image stays environment-agnostic; the Secret variant (secretRef, or the TLS secret below) is the same mechanism for values the parity rules govern: injected at run time, never baked into the image, never committed. HELM, in one honest paragraph, is the templating layer these manifests grow into: raw YAML repeats per service and per environment (this repo already has server/client deployment-plus-service pairs differing only by name, image, and port), and a chart parameterizes that repetition — templates with value slots, a values file per environment, and releases you can diff, upgrade, and roll back (the next section's verb). Kustomize is the composes-instead-of-templates alternative. Until the repetition hurts, plain YAML plus kubectl is not a compromise — it is the honest size.`,
        },
        {
          kind: 'code',
          id: 'deploy-kubernetes:ingress-quote',
          language: 'yaml',
          caption:
            'Verbatim — one entry point, two backends (deploy/k8s/ingress.yaml, whole): the nginx-proxy job in Kubernetes form',
          source: 'deploy/k8s/ingress.yaml',
          code: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: express-guide
  namespace: express-guide
  labels:
    app.kubernetes.io/part-of: express-guide
spec:
  ingressClassName: nginx
  rules:
    - host: guide.example.test
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: server
                port:
                  number: 4000
          - path: /docs
            pathType: Prefix
            backend:
              service:
                name: server
                port:
                  number: 4000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: client
                port:
                  number: 80
  # TLS: uncomment once a certificate exists. The placeholder secret name
  # stands in for a cert-manager-issued or ops-provided TLS secret — real
  # certificates and keys are never committed to git.
  # tls:
  #   - hosts:
  #       - guide.example.test
  #     secretName: express-guide-tls`,
        },
        {
          kind: 'code',
          id: 'deploy-kubernetes:kubectl',
          language: 'bash',
          caption: 'The whole stack, declaratively — and the inspection verbs that make it legible',
          code: `# apply the declared state (namespace first — the files live in deploy/k8s/):
kubectl apply -f deploy/k8s/

# watch desired state become actual state:
kubectl -n express-guide get pods,svc,ingress,hpa
kubectl -n express-guide describe pod -l app.kubernetes.io/name=server

# the probes' view and the control plane's story:
kubectl -n express-guide logs deploy/server --tail=50
kubectl -n express-guide get events --sort-by=.lastTimestamp | tail -10`,
        },
      ],
    },
    {
      id: 'deploy-rollouts',
      title: 'Safe rollouts and rollbacks',
      lead:
        'Zero-downtime was the drain; this is that discipline at deploy time — rolling, blue-green, canary, and rollback as a first-class verb.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-rollouts:strategies',
          body: `THE THREE SHAPES. ROLLING — what a Kubernetes Deployment does by default, and exactly the choreography the process section described: surge a NEW pod, wait for its READINESS gate, then retire an old one; the capacity dip is 1/N, and maxSurge/maxUnavailable are the knobs that tune how much new-at-once versus how little capacity-at-once. BLUE-GREEN — run the ENTIRE new stack beside the old one, switch the router (the ingress, the proxy) in one move, keep the old stack warm for instant switchback: the safest and the most expensive (double the resources for the overlap), and the switch must still respect the drain — flip routing, let old in-flight requests finish, THEN retire, which is the SIGTERM story one more time. CANARY — route a small slice of real traffic (1-5%) to the new version and gate the rest on METRICS: error rate, p95 — the observability topic's RED numbers are literally the gate inputs, and the promotion/abort decision becomes data, not courage. ROLLBACK AS A FIRST-CLASS VERB: a Deployment keeps the ReplicaSets of recent revisions, so "point desired state at the last good one" is one command (below) and takes seconds — and you REHEARSE it before you need it, because a rollback you have never practiced is a hope, the untested-backup lesson wearing a deploy hat. THE FINE PRINT the CI section already stated, worth its echo here: image tags are IMMUTABLE — roll the deployment BACK when the new version is broken, but roll FORWARD (a new tag with the fix) once time and data have moved on; and the third lever is FLAGS — the scenario store's failure-injection toggle is the app-internal cousin: disable a path without redeploying at all.`,
        },
        {
          kind: 'code',
          id: 'deploy-rollouts:kubectl',
          language: 'bash',
          caption: 'The rollout verbs — status gated on readiness, history, and the rollback you rehearse',
          code: `# watch a rolling update gate on readiness, pod by pod:
kubectl -n express-guide set image deployment/server server=express_guide_server_prod:v1.2.3
kubectl -n express-guide rollout status deployment/server

# the history you can walk back to:
kubectl -n express-guide rollout history deployment/server
kubectl -n express-guide rollout undo deployment/server              # last revision
kubectl -n express-guide rollout undo deployment/server --to-revision=2`,
        },
      ],
    },
    {
      id: 'deploy-iac',
      title: 'Infrastructure as code',
      lead:
        'The compose files and manifests in this topic are already infrastructure-as-code; Terraform and Pulumi extend the same idea to everything BEHIND the cluster — concepts only, honestly.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-iac:concepts',
          body: `THE IDEA YOU ALREADY USE. Everything this topic shipped is DECLARED, REVIEWED, APPLIED text: compose files, Kubernetes manifests — "desired state in a file, a tool reconciles reality to it". Infrastructure-as-code tools generalize that to the cloud resources UNDER and AROUND the cluster: the VPC and subnets, the managed database, the load balancer, IAM roles, the cluster itself. Terraform's model is declarative config in HCL; Pulumi's is the same model authored in real languages (TypeScript, so this repo's own toolset). The workflow both ride: PLAN — a diff of desired versus current, BEFORE anything changes, which is the code review of infrastructure — then APPLY to converge reality onto the code.`,
        },
        {
          kind: 'text',
          id: 'deploy-iac:state-reproducibility-drift',
          body: `STATE is the load-bearing concept and the honest danger: the tool keeps a state file (or remote backend) recording WHICH real-world objects it owns — it is how plan diffs and deletes work, which makes it effectively a database of your infrastructure: guard it (remote, LOCKED backends, because concurrent applies corrupt it), back it up, never hand-edit it — and treat its storage like the secrets topic treats secrets, because state files can capture secret values. REPRODUCIBILITY is the payoff the parity section promised by hand ("staging differs from production in exactly the ways you can LIST"): with IaC, staging IS the same code with different variable values, and a rebuilt environment is one apply away instead of a runbook nobody has executed since the last person who wrote it left. DRIFT is the enemy: changes made by console clicks that the code never saw — drift detection re-plans and shows reality's deviations, and the discipline is console-for-emergencies, code-for-permanence (the same "clicks don't count" rule the database topics apply to hand-edited prod data). WHERE THIS REPO LIVES, stated rather than faked: app-layer IaC — compose plus the deploy/k8s manifests — is real and shipped in these files; the Terraform layer that would provision the cluster and its cloud dependencies is the declared growth path, and this topic will not fabricate a config file it does not have.`,
        },
      ],
    },
    {
      id: 'deploy-linux',
      title: 'Linux survival for backend devs',
      lead:
        'Backend deployment means Linux. The survival kit — processes and signals, systemd and journalctl, permissions, ssh — exercised against the devcontainer you are already running.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-linux:processes',
          body: `YOU ARE ALREADY RUNNING ONE. Every docker exec command in this guide's definition of done is a shell in a Linux container — the same OS family as the node:22-alpine images and the servers this topic ships to. PROCESSES: ps walks the process table, top shows it live; kill sends the signals the graceful-shutdown section is BUILT on — SIGTERM is the drain trigger, and kill -9 is SIGKILL, the force-exit net as a command: no handler runs, no drain happens. /proc is where the observability topic's rss and uptime numbers physically live. THE SIGNAL VOCABULARY IS THE OPERATOR'S API: SIGTERM "finish and exit" (docker stop, kubectl delete), SIGINT what Ctrl-C sends, SIGHUP the reload idiom daemons honor.`,
        },
        {
          kind: 'code',
          id: 'deploy-linux:process-commands',
          language: 'bash',
          caption: 'Processes and the signal vocabulary the shutdown drain depends on',
          code: `# what is running, by whom, eating how much:
ps aux | grep -E 'node|nginx' | grep -v grep
top                     # load average first; sort by CPU (P) and memory (M)

# the two signals every section of this topic keeps naming:
kill -TERM <pid>        # graceful: the app drains in-flight work, then exits
kill -9 <pid>           # SIGKILL: uncatchable — what arrives when the timeout expires`,
        },
        {
          kind: 'text',
          id: 'deploy-linux:systemd',
          body: `SYSTEMD is the supervisor catalog's no-Docker entry: a unit file under /etc/systemd/system declares a service — ExecStart, Restart=always, KillSignal=SIGTERM, TimeoutStopSec above the app's force-exit net — the same contract as compose's restart: unless-stopped, in the host's native tongue. JOURNALCTL reads what systemd collects from the unit's stdout — which is EXACTLY the retention section's 12-factor story: the app writes JSON lines to stdout, and the platform's journal owns rotation, retention, and querying (then ships them to the collector of your choice).`,
        },
        {
          kind: 'code',
          id: 'deploy-linux:systemd-commands',
          language: 'bash',
          caption: 'The supervisor and its log reader, as commands',
          code: `systemctl status express-guide          # running? since when? last log lines
systemctl restart express-guide          # stop (SIGTERM, drain) then start
journalctl -u express-guide -f           # live tail — the collector's front row
journalctl -u express-guide --since '1 hour ago' -p err`,
        },
        {
          kind: 'text',
          id: 'deploy-linux:permissions-ssh-curl',
          body: `PERMISSIONS: rwx per user/group/other. chmod 600 is the parity section's own instruction for .env.production — owner reads and writes, nobody else; a secrets file is not group reading material. chown changes ownership — the devcontainer's fresh anonymous volumes arrive ROOT-owned and are chowned to the node user at bootstrap, the same uid-1000 story the pod's runAsUser enforces one section up. The executable bit (chmod +x) is the classic "why won't my script run" — ls -l shows it missing. SSH: key-based login (your public key in the server's ~/.ssh/authorized_keys, the private key never leaving your machine), then everything above works over the wire. AND CURL, this whole guide's client: -i to see headers, -X to pick the method, -H to add one (a traceparent, an Accept-Encoding), -s to script it — the reverse-proxy section's proof tool and the debugging topic's weapon.`,
        },
        {
          kind: 'code',
          id: 'deploy-linux:permission-commands',
          language: 'bash',
          caption: 'Permissions, ownership, and the operator\u2019s doorway',
          code: `# the parity section's secrets rule, as commands:
ls -l server/.env.production
chmod 600 server/.env.production

# ownership — the devcontainer's volume bootstrap, by hand:
chown -R node:node /app/data

# ssh in, then everything above works remotely:
ssh deploy@guide.example.test
scp .docker/docker-compose-prod.yml deploy@guide.example.test:~/`,
        },
      ],
    },
    {
      id: 'deploy-see-it-live',
      title: 'The stack explorer from a terminal',
      lead:
        'The live process facts of the server answering you, beside the services your repo declares (the interactive explorer lives in the Compose section above) — then boot the real prod stack yourself, all from a terminal.',
      blocks: [
        {
          kind: 'text',
          id: 'deploy-see-it-live:what-you-see',
          body: `THE STACK EXPLORER (in the Compose section above) is the "you are running inside the deployed thing" moment. GET /api/demo/deploy/stack answers with the LIVE process facts — the pid, the Node version, the environment, the uptime, the RSS — of the very server rendering this page, plus the browser origin you reached it through (Vite's dev proxy on :5173, the prod nginx on :8080, or a direct :4000 hit — each tells a different deployment story), and the services DECLARED by this repo's two compose files, parsed live off disk with a tolerant two-space-indent heuristic. The panel puts DECLARED beside LIVE: the declared stack is what the orchestrator was told; the live facts are what actually runs — deployment is the discipline of keeping those two columns identical. Watch the forwardedProto line in particular: through the shipped prod proxy it reads null, because the shipped nginx conf does not set X-Forwarded-Proto — the reverse-proxy section's gap, visible as data. Or drive it from a terminal — including the full prod boot this topic was proven with:`,
        },
        {
          kind: 'code',
          id: 'deploy-see-it-live:curl',
          language: 'bash',
          caption: 'The stack manifest over curl, and the full prod boot this topic was proven with',
          code: `# the declared stack vs the live process, as data:
curl -s localhost:4000/api/demo/deploy/stack | head -40

# the full prod stack — from nothing to healthy:
docker compose -f .docker/docker-compose-prod.yml build
docker compose -f .docker/docker-compose-prod.yml up -d
docker compose -f .docker/docker-compose-prod.yml ps

curl -s localhost:8080/api/health          # liveness, THROUGH the nginx proxy
curl -s localhost:8080/api/posts | head -5 # sqlite + the whole stack, end to end
curl -s -o /dev/null -w '%{http_code}\\n' localhost:8080/   # the client shell itself

docker compose -f .docker/docker-compose-prod.yml logs server | grep listening

# and, when you are done — volumes persist on purpose (named volumes outlive down):
docker compose -f .docker/docker-compose-prod.yml down`,
        },
      ],
    },
  ],
};
