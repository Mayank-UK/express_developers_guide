import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { container } from '../core/container';
import { createAppConfig } from '../core/config';

/**
 * Global test setup, run once per test file (vitest `setupFiles`).
 *
 * Centralizes what every screen spec needs so it's not copy-pasted into each
 * beforeAll: an initialized DI container. Specs stub the global `fetch`
 * (see fetch_stub.ts) which the http client reads at call time, so wiring the
 * container once here serves every suite.
 */
beforeAll(() => {
  container.initialize(createAppConfig());
});

afterEach(() => {
  cleanup();
});
