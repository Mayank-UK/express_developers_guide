# Express Developers Guide

A runnable full-stack reference app that **is** the guide: the server (Express 5 + TypeScript) carries all 40 topics of teaching content as a typed content API, and the client (React 19 + Vite + Tailwind v4) is a presentation-only shell that renders it.

- **Content API-driven** — every topic screen (sections → text/code/demo blocks) is JSON from `GET /api/content`; the client is a generic renderer.
- **Live demos** — ~25 route groups under `/api/demo/**` back the interactive topic screens (validation arena, webhooks + HMAC, SSE/WebSockets, uploads & range requests, circuit breaker, i18n negotiation, …).
- **Interactive API docs** — Swagger UI at `/docs`, from a hand-written OpenAPI document covering the core resource surface, drift-checked by tests.
- **Scenario toggles** — `PATCH /api/demo/scenario` flips fake/live data and failure injection at runtime; the same endpoints answer from an in-memory store, sqlite, or a 503 envelope.
- **Optional services via compose** — Redis and MongoDB boot as compose services for the caching/session/realtime and Mongoose topics; the app runs fine without them.

## Run it

**VS Code devcontainer (the standard way)** — development happens entirely inside Docker: no Node install, no `node_modules`, no native-module builds on your machine.

1. Open the repo in VS Code → **Reopen in Container** (Dev Containers extension + Docker Desktop required).
2. The first open builds nothing — it pulls `node:22-bookworm` and runs `npm ci` in both packages inside the container (a few minutes; the installs live in anonymous Docker volumes and never touch your host).
3. That single action starts the full stack: the `server` and `client` containers run their dev servers (hot-reload via bind mounts; API on http://localhost:4000, app on http://localhost:5173 — both published to the host) alongside Redis and MongoDB. Open **http://localhost:5173** in your browser.

The integrated terminal is the `dev` tooling container — for tests (`cd server && npm test` · `cd client && npm test`), git, and `npm run build`, not for running the app. The TS server resolves everything against the container's `node_modules`, so diagnostics and linting work in-editor.

**Full dev stack via plain Docker** (no VS Code) — boots server + client + redis + mongo:

```bash
docker compose -f .docker/docker-compose.yml up
```

Production stack — a **persistent platform** (Caddy TLS edge, redis, mongo) plus per-release **colored app stacks** (blue/green; server + client). Local boot of the same images uses the CI override (client on `127.0.0.1:8080`, no ACME):

```bash
docker network create edg_frontend 2>/dev/null || true; docker network create edg_backend 2>/dev/null || true
for v in express_developers_guide_prod_redis_data express_developers_guide_prod_mongo_data express_developers_guide_prod_caddy_data express_developers_guide_prod_caddy_config express_developers_guide_prod_server_data; do docker volume inspect "$v" >/dev/null 2>&1 || docker volume create "$v"; done
cp server/.env.production.example server/.env.production
docker compose -f .docker/docker-compose-platform.yml -f .docker/docker-compose-prod.yml -f .docker/docker-compose.ci.yml up -d --wait
```

### Production operations

Deploys are **zero-downtime blue/green**: the platform stack (project `edg_platform` — caddy + redis + mongo, booted once and untouched by releases) stays up while every release boots an app stack (server + client) under the *inactive* color's project (`edg_blue` / `edg_green`, from `.docker/docker-compose-prod.yml` with `COLOR` + `IMAGE_TAG` exported). The new color is probed privately (`busybox wget` inside its own `app_internal` network), then goes live by rewriting `~/express_developers_guide/platform/upstream.caddy` (`reverse_proxy edg_client_<color>:80`) and running `docker exec edg_caddy caddy reload --config /etc/caddy/Caddyfile` — a graceful reload, no TLS blip. The GitHub workflow `deploy-production.yml` runs the whole state machine (probe → flip → public health gate → retire the old color → prune).

- **Secrets** — `server/.env.production` is **not in git** (only the committed `.example` template). The real file is materialized on the deploy runner from the `production` GitHub environment's `PROD_ENV_B64` secret, scp'd to the release dir, and never echoed. One-time setup: `base64 < server/.env.production | gh secret set PROD_ENV_B64 --env production` (or the UI). The job also needs `VM_HOST`, `VM_USER`, `VM_PRIVATE_KEY`, `VM_HOST_FINGERPRINT`, `GHCR_USER`, `GHCR_PULL_TOKEN`.
- **First deploy after the blue/green split** — migrates the legacy single stack: the old `express_developers_guide_prod` project is stopped once so the platform can adopt its named volumes (one ~seconds availability blip, documented in the workflow). Fresh VMs skip this — no legacy state exists.
- **Update** — push to `master` (CI green ⇒ automatic deploy of that exact commit) or `workflow_dispatch` with a `sha-<7>` tag. CI publishes single-platform images for the architecture the VM actually runs — auto-detected by the `vm-arch` SSH recon job (`uname -m`) before `build-push`, with the Dockerfiles cross-compiling on the runner's native CPU so only the server's native-deps install may emulate. Failure before the flip: the failed color is torn down, the live color never noticed. Failure after the flip: Caddy flips back to the still-running previous color (instant rollback).
- **Manual rollback** — `printf 'reverse_proxy edg_client_<color>:80\n' > ~/express_developers_guide/platform/upstream.caddy && docker exec edg_caddy caddy reload --config /etc/caddy/Caddyfile` (the old color keeps running until the next deploy retires it), or re-run `workflow_dispatch` with the previous sha — `cat ~/express_developers_guide/.deploy/last-successful-sha` names it.
- **Release retention** — the VM keeps the newest 5 release dirs (`~/express_developers_guide/releases/<sha>/`), never deleting the active or previous one. GHCR is pruned automatically by the same pipeline: the `ghcr-prune` job keeps the newest 10 `sha-<7>` image versions per package (never `master`/`latest`, and never untagged manifests — they are the per-arch/attestation children of tagged indexes and pruning them breaks pulls; delete failures only warn).
- **Data** — sqlite, redis, mongo, and caddy certificates live in external named volumes (`express_developers_guide_prod_*`), adopted across colors and releases; only an explicit `docker volume rm` discards them (`down` never does).
- **Branch protection for `master`** (the deploy trigger) — require status checks `server`, `client`, `secrets`, `e2e`; require branches to be up to date before merging; include administrators.
- **TLS** — terminated by Caddy (`expressdevelopersguide.duckdns.org`, automatic Let's Encrypt, HTTP/3) when the stack runs on a host with that DNS record and open 80/443; a purely local run cannot provision certificates — use the CI override's `127.0.0.1:8080` client publish.
- **Sizing** — measured at ~90 MiB total memory on the local machine; re-measure on the actual target VM before sizing it.

> Host-native dev (`npm install` in `server/` and `client/` with a local Node 22) is still possible, but the project's standard environment is the devcontainer — the repo intentionally carries no host `node_modules`.

## Commands

Inside the devcontainer (or, less commonly, in `server/` and `client/` with a local toolchain): `npm run dev` · `npm test` · `npm run build`.

**Browser E2E (host-side)** — a three-spec Playwright suite drives the running stack from the host, covering what no in-process test can see: the rendered page and the Vite → Express proxy hop. It runs on the host (not the devcontainer) because the tooling container has no sudo, so Chromium's system libraries can't be installed there. Prerequisites and commands: `e2e/README.md`.

## Ports

| Service | URL | Notes |
| ------- | --- | ----- |
| Client  | http://localhost:5173 | Vite dev server; `/api` proxied to the server |
| Server  | http://localhost:4000 | Express API on the **dev** stack — try `GET /api/health` or browse `/docs/`; in the prod stack the API stays internal behind the Caddy → nginx proxy chain |
| Client (prod) | https://expressdevelopersguide.duckdns.org | Caddy TLS edge → nginx serving the built client, `/api` proxied to the server of the active color; local runs use the CI override's `127.0.0.1:8080` publish |
| Redis · Mongo | 127.0.0.1:6379 · 127.0.0.1:27017 | published by the **dev** stack only (incl. the devcontainer's); the prod stack ships both services but keeps them internal to the compose network |

## Layout

```
server/   Express 5 + TS — core / domain / data / di / content / presentation
client/   React 19 + Vite + TS + Tailwind v4 — presentation shell + demo components
e2e/      Playwright browser E2E — runs on the HOST against the published dev ports
.docker/  per-service Dockerfile.dev/.prod + dev & prod compose files
deploy/   deployment curriculum manifests (k8s: deployments, services, ingress, hpa)
.github/  CI workflows
```
