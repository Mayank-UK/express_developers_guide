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

Production stack — a **persistent platform** (redis + mongo) plus per-release **colored app stacks** (blue/green; server + client). The TLS edge is ONE shared Caddy container owned by the infra repo (`oracle-arm-vm`), which publishes 80/443 for the whole VM and proxies to whichever color the flip file names. Local boot of the same images uses the CI override (client on `127.0.0.1:8080`, no caddy runs locally):

```bash
docker network create edg_frontend 2>/dev/null || true; docker network create edg_backend 2>/dev/null || true
for v in express_developers_guide_prod_redis_data express_developers_guide_prod_mongo_data express_developers_guide_prod_caddy_data express_developers_guide_prod_caddy_config express_developers_guide_prod_server_data; do docker volume inspect "$v" >/dev/null 2>&1 || docker volume create "$v"; done
cp server/.env.production.example server/.env.production
docker compose -f .docker/docker-compose-platform.yml -f .docker/docker-compose-prod.yml -f .docker/docker-compose.ci.yml up -d --wait
```

### Production operations

Deploys are **zero-downtime blue/green**: the platform stack (project `edg_platform` — redis + mongo, booted once and untouched by releases) stays up while every release boots an app stack (server + client) under the *inactive* color's project (`edg_blue` / `edg_green`, from `.docker/docker-compose-prod.yml` with `COLOR` + `IMAGE_TAG` exported). The TLS edge is ONE shared Caddy container owned by the infra repo, serving multiple apps on the VM; it reaches this app's `edg_client_<color>` containers over the shared `edg_frontend` network. The new color is probed privately (`busybox wget` inside its own `app_internal` network), then goes live by rewriting `~/express_developers_guide/platform/upstream.caddy` (`reverse_proxy edg_client_<color>:80` — bind-mounted read-only by the shared caddy) and running `docker exec caddy caddy reload --config /etc/caddy/Caddyfile` — a graceful reload, no TLS blip. The GitHub workflow `deploy-production.yml` runs the whole state machine (probe → flip → public health gate → retire the old color → prune).

- **Secrets** — `server/.env.production` is **not in git** (only the committed `.example` template). The real file is materialized on the deploy runner from the `production` GitHub environment's `PROD_ENV_B64` secret, scp'd to the release dir, and never echoed. One-time setup: `base64 < server/.env.production | gh secret set PROD_ENV_B64 --env production` (or the UI). The job also needs `VM_HOST`, `VM_USER`, `VM_PRIVATE_KEY`, `VM_HOST_FINGERPRINT`, `GHCR_USER`, `GHCR_PULL_TOKEN`.
- **First deploy after the blue/green split** — migrates the legacy single stack: the old `express_developers_guide_prod` project is stopped once so the platform can adopt its named volumes (one ~seconds availability blip, documented in the workflow). Fresh VMs skip this — no legacy state exists.
- **Update** — push to `master` (CI green ⇒ automatic deploy of that exact commit) or `workflow_dispatch` with a `sha-<7>` tag. CI publishes single-platform images for the architecture the VM actually runs — auto-detected by the `vm-arch` SSH recon job (`uname -m`) before `build-push`, with both Dockerfiles running every stage on the runner's native CPU (the server's prod-deps install asserts the target arch's bundled better-sqlite3 prebuild is present, fail-loud) — zero emulation on any runner or VM arch, publish in minutes. Failure before the flip: the failed color is torn down, the live color never noticed. Failure after the flip: Caddy flips back to the still-running previous color (instant rollback).
- **Manual rollback** — `printf 'reverse_proxy edg_client_<color>:80\n' > ~/express_developers_guide/platform/upstream.caddy && docker exec caddy caddy reload --config /etc/caddy/Caddyfile` (the old color keeps running until the next deploy retires it), or re-run `workflow_dispatch` with the previous sha — `cat ~/express_developers_guide/.deploy/last-successful-sha` names it.
- **Release retention** — the VM keeps the newest 5 release dirs (`~/express_developers_guide/releases/<sha>/`), never deleting the active or previous one. GHCR is pruned automatically by the same pipeline: the `ghcr-prune` job keeps the newest 10 `sha-<7>` image versions per package (never `master`/`latest`, and never untagged manifests — they are the per-arch/attestation children of tagged indexes and pruning them breaks pulls; delete failures only warn).
- **Data** — sqlite, redis, and mongo data live in external named volumes (`express_developers_guide_prod_*`), adopted across colors and releases; TLS certificates live in the infra repo's caddy volumes (the legacy `express_developers_guide_prod_caddy_*` volumes are retired-but-preserved — nothing auto-deletes them); only an explicit `docker volume rm` discards any of them (`down` never does).
- **Branch protection for `master`** (the deploy trigger) — require status checks `server`, `client`, `secrets`, `e2e`; require branches to be up to date before merging; include administrators.
- **TLS** — terminated by the infra repo's ONE shared Caddy (`expressdevelopersguide.duckdns.org`, automatic Let's Encrypt, HTTP/3 — one edge container serving every app on the VM; certificates live in the infra caddy's volumes) when the stack runs on a host with that DNS record and open 80/443; a purely local run has no caddy at all — use the CI override's `127.0.0.1:8080` client publish.
- **One-time migration to the shared Caddy** — the platform stack no longer ships its own caddy; the infra repo's shared `caddy` container (one edge for every app on the VM, the only 80/443 publisher) owns the TLS edge. Two paths:
    - **New server (primary)** — deploy to the fresh Oracle ARM VM the infra repo provisioned: (1) in the infra repo, `make provision` on the new VM — installs Docker, boots the central `caddy`, creates the edg networks/volumes/deploy dirs, and seeds the flip file (there is NO `edg_caddy` on a fresh VM); (2) repoint the GitHub `production` secrets: `VM_HOST` → `80.225.249.252`, `VM_HOST_FINGERPRINT` → the fingerprint from `ssh-keyscan -t ed25519 80.225.249.252 | ssh-keygen -lf -`, `VM_PRIVATE_KEY` → the new instance's private key (`VM_USER`, `PROD_ENV_B64`, `GHCR_*` unchanged); (3) deploy as usual — the `vm-arch` recon auto-detects aarch64 and publishes `linux/arm64` at full native speed: both images' builds run every stage on the runner's CPU, no emulation, publish time stays a few minutes. Caveat: previous amd64-only images cannot run on ARM — the first arm64 release has no image-level rollback until a second arm64 release exists; (4) verify `curl -fsS https://expressdevelopersguide.duckdns.org/api/health`. The old x86 server needs no changes — retire it when ready; data does not move (a manual volume transfer covers it if ever needed).
    - **Same server (alternative)** — migrate in place: (1) on the VM `docker rm -f edg_caddy` (brief outage, seconds); (2) in the infra repo `make provision` — boots the shared caddy; the certificate re-issues once; (3) deploy as usual (the workflow already points its reload at the shared container); (4) verify `curl -fsS https://expressdevelopersguide.duckdns.org/api/health`.
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
