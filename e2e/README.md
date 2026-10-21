# Browser E2E (host-side Playwright)

Three real-browser specs, small on purpose — each pins one wiring fact no
in-process test can see (the rendered page and the Vite → Express proxy hop):

- `home.spec.ts` — the topic map renders from the content API: all 10 groups, 40 populated topic links.
- `topic.spec.ts` — a topic page renders: sections, collapsed-by-default code blocks, mounted live-demo panels.
- `demo.spec.ts` — one interactive round-trip through the real stack: browser → Vite proxy → Express → back, asserted on server-generated content.

## Why this runs on the host

The devcontainer's tooling container runs as `node` with no sudo, so
Chromium's system libraries cannot be installed there. The suite therefore
runs on the HOST against the devcontainer's published ports (client
http://localhost:5173, server http://localhost:4000) — the same pages a host
browser opens. This is the one documented exception to "host npm doesn't
work": `@playwright/test` is pure JS with no native modules; the Chromium
binary is the only extra download.

## Run it

Prerequisites: host Node 20+, and the dev stack up (from the repo root:
`docker compose -f .docker/docker-compose.yml up -d`).

```bash
cd e2e
npm install
npx playwright install chromium
npm test
```

## `E2E_BASE_URL`

`playwright.config.ts` reads `E2E_BASE_URL` to override the default
`baseURL` (`http://localhost:5173`, the devcontainer's Vite server). CI uses
it to run this same suite against the PRODUCTION images instead — the
workflow builds both images, boots them with the CI compose override
(`.docker/docker-compose.ci.yml`, nginx published on the loopback), and runs
`E2E_BASE_URL=http://127.0.0.1:8080 npm test`. To reproduce that locally:

```bash
docker compose -f .docker/docker-compose-prod.yml \
  -f .docker/docker-compose.ci.yml up -d --wait
cd e2e && E2E_BASE_URL=http://127.0.0.1:8080 npm test
```
