import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { TESTING_DEMO_MOUNT_PATH } from './testing_demo_routes.js';
import { MINI_SUITE_CASE_IDS } from '../../domain/testing/mini_suite.js';

/**
 * The testing demo's contract, end to end: the runner executes the app's real
 * pure modules and every curated case passes (the cases mirror real behavior
 * — a failure here means the curation drifted, not the app), each case names
 * its module of origin and carries a duration, and injectFailureFor flips
 * exactly one case to failed with its expected/actual intact (the honesty
 * proof). An unknown case id is a 400 envelope listing the valid ids.
 */

const MOUNT = TESTING_DEMO_MOUNT_PATH; // /api/demo/testing

interface CaseBody {
  id: string;
  name: string;
  module: string;
  passed: boolean;
  expected: string;
  actual: string;
  ms: number;
}

describe('GET /api/demo/testing/run — the live mini suite', () => {
  it('runs ~12 curated cases, ALL passing, with durations and module-of-origin notes', async () => {
    const res = await request(createApp()).get(`${MOUNT}/run`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(res.body.cases.length);
    expect(res.body.total).toBeGreaterThanOrEqual(11);
    expect(res.body.total).toBeLessThanOrEqual(13);
    expect(res.body.passed).toBe(res.body.total);
    expect(res.body.failed).toBe(0);
    expect(res.body.injectFailureFor).toBeNull();
    expect(res.body.durationMs).toBeGreaterThan(0);

    const cases = res.body.cases as CaseBody[];
    for (const entry of cases) {
      expect(entry.passed, entry.name).toBe(true);
      expect(entry.name.length).toBeGreaterThan(10); // behavior statements, not labels
      expect(entry.module).toMatch(/^src\/[a-z]+\/.+\.ts$/);
      expect(entry.expected.length).toBeGreaterThan(0);
      expect(entry.actual.length).toBeGreaterThan(0);
      expect(entry.ms).toBeGreaterThanOrEqual(0);
    }

    // The curated surface spans the app's pure modules: range parsing,
    // locale negotiation, JWT security properties, and backoff math.
    const modules = new Set(cases.map((entry) => entry.module));
    expect(modules).toContain('src/core/http/range_header.ts');
    expect(modules).toContain('src/domain/i18n/negotiate.ts');
    expect(modules).toContain('src/domain/auth/jwt_service.ts');
    expect(modules).toContain('src/domain/jobs/job_queue.ts');
  });

  it('is deterministic across runs: same ids, same order', async () => {
    const first = await request(createApp()).get(`${MOUNT}/run`);
    const second = await request(createApp()).get(`${MOUNT}/run`);
    expect((first.body.cases as CaseBody[]).map((entry) => entry.id)).toEqual(
      (second.body.cases as CaseBody[]).map((entry) => entry.id),
    );
    expect(first.body.cases.map((entry: CaseBody) => entry.id)).toEqual([...MINI_SUITE_CASE_IDS]);
  });

  it('?injectFailureFor=<id> flips exactly that case to failed, keeping expected/actual — the honesty proof', async () => {
    const target = 'jwt-tampered-payload';
    const res = await request(createApp()).get(`${MOUNT}/run?injectFailureFor=${target}`);

    expect(res.status).toBe(200);
    expect(res.body.injectFailureFor).toBe(target);
    expect(res.body.failed).toBe(1);
    expect(res.body.passed).toBe(res.body.total - 1);

    const flipped = (res.body.cases as CaseBody[]).find((entry) => entry.id === target);
    expect(flipped).toBeDefined();
    expect(flipped?.passed).toBe(false);
    expect(flipped?.expected).toContain('signature_mismatch');
    expect(flipped?.actual).toContain('INJECTED');
    // Every OTHER case still ran honestly.
    const others = (res.body.cases as CaseBody[]).filter((entry) => entry.id !== target);
    expect(others.every((entry) => entry.passed)).toBe(true);
  });

  it('answers the canonical 400 envelope for an unknown injectFailureFor id', async () => {
    const res = await request(createApp()).get(`${MOUNT}/run?injectFailureFor=not-a-case`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('injectFailureFor');
    expect(res.body.error.validValues).toEqual([...MINI_SUITE_CASE_IDS]);
  });
});
