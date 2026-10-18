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

Production stack (nginx-served client + prod server images — the full demo set: redis and mongo wired, datastores internal-only, nothing published but :8080):

```bash
docker compose -f .docker/docker-compose-prod.yml up --build
```

### Production operations

Build with versioned image tags so every release is a named artifact you can roll back to (compose builds the `image:` names; `docker tag` freezes a version):

```bash
docker compose -f .docker/docker-compose-prod.yml build
docker tag express_guide_server_prod express_guide_server_prod:v1.0.0
docker tag express_guide_client_prod express_guide_client_prod:v1.0.0
```

- **Update** — build and tag the new version, `docker compose -f .docker/docker-compose-prod.yml up -d`, then verify `curl http://localhost:8080/api/health` reports `status: "ok"` (the API itself is not published; :8080 is the front door).
- **Rollback** — retag the previous version onto the compose `image:` names (or point the file at the old tag) and `up -d` again — that is the whole reason versioned tags exist.
- **Bad release** — same rollback; the sqlite database, redis state, and mongo data live in the named volumes `server_data`, `redis_data`, and `mongo_data`, so they survive container recreation (only `down -v` discards them).
- **TLS** — this stack terminates plain HTTP only: put a TLS reverse proxy (or your hosting platform's edge) in front of :8080 before any public exposure.
- **Sizing** — measured at ~90 MiB total memory on the local machine; re-measure on the actual target VM before sizing it.

> Host-native dev (`npm install` in `server/` and `client/` with a local Node 22) is still possible, but the project's standard environment is the devcontainer — the repo intentionally carries no host `node_modules`.

## Commands

Inside the devcontainer (or, less commonly, in `server/` and `client/` with a local toolchain): `npm run dev` · `npm test` · `npm run build`.

**Browser E2E (host-side)** — a three-spec Playwright suite drives the running stack from the host, covering what no in-process test can see: the rendered page and the Vite → Express proxy hop. It runs on the host (not the devcontainer) because the tooling container has no sudo, so Chromium's system libraries can't be installed there. Prerequisites and commands: `e2e/README.md`.

## Ports

| Service | URL | Notes |
| ------- | --- | ----- |
| Client  | http://localhost:5173 | Vite dev server; `/api` proxied to the server |
| Server  | http://localhost:4000 | Express API on the **dev** stack — try `GET /api/health` or browse `/docs/`; in the prod stack the API stays internal behind nginx's `/api` proxy on :8080 |
| Client (prod) | http://localhost:8080 | nginx serving the built client, `/api` proxied to the server service |
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
