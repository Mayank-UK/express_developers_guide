import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Only source specs — tsc also compiles specs into dist/, which must not run twice.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'src/**/*',
        // Specs are the measurers, not the measured.
        '!src/**/*.spec.ts',
        // Pure typed topic content — data exercised via the registry specs, not logic.
        '!src/content/topics/**',
        // Compilable teaching exhibits — deliberately untested artifacts.
        '!src/domain/teaching/**',
      ],
      // Ratchet at measured baseline (2026-09-30: 88.76/79.7/89.94/89.83) minus
      // a 2-point churn margin — enforced in CI via `npm run test:coverage`.
      thresholds: {
        statements: 86,
        branches: 77,
        functions: 87,
        lines: 87,
      },
    },
  },
});
