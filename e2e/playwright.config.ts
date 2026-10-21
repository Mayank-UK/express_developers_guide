import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E for the guide — run from the HOST, not the devcontainer: the
 * tooling container runs as `node` with no sudo, so Chromium's system
 * libraries cannot be installed there. The suite drives the devcontainer's
 * published ports instead — client http://localhost:5173, /api proxied to
 * the server on :4000 — exactly the pages a host browser opens.
 *
 * No `webServer` block on purpose: the stack already runs under Docker. If
 * it is down, start it from the repo root:
 *   docker compose -f .docker/docker-compose.yml up -d
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Deterministic by design: a red e2e test is a wiring signal, and
  // re-rolling it throws the information away. Zero retries, one worker —
  // the specs share a single dev stack.
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'line',
  use: {
    // CI points this at the booted prod-image stack (nginx on 127.0.0.1:8080);
    // locally the default stays the devcontainer's Vite server.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
