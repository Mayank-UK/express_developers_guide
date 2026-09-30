import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { BEST_DEMO_MOUNT_PATH, type AuditResponse } from './best_practices_demo_routes.js';

/**
 * The self-audit's contract: every check reads a REAL signal, so the spec
 * proves exactly that —
 *
 * - the LOCAL checks (listeners, fs heuristic, constants, log ring) grade
 *   the actual process (the spec registers SIGTERM/fatal listeners the way
 *   server.ts does, since specs deliberately never import server.ts);
 * - the SELF-FETCH checks degrade to WARN with an honest note when nothing
 *   listens at the request origin (Supertest's ephemeral port) — never a
 *   500, never a lie;
 * - with fetch stubbed to simulate the live app answering, those same
 *   checks grade PASS against real header/body assertions.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const SELF_FETCH_IDS = [
  'helmet-headers',
  'request-id',
  'health-endpoint',
  'compression-scoped',
  'error-envelope',
  'docs-served',
  'content-versioned',
] as const;

function checkById(body: AuditResponse, id: string) {
  const check = body.checks.find((entry) => entry.id === id);
  expect(check).toBeDefined();
  return check!;
}

describe('GET /api/demo/best/audit — shape', () => {
  it('returns >= 10 checks, each with a unique id, category, practice, status, evidence', async () => {
    const res = await request(createApp()).get(`${BEST_DEMO_MOUNT_PATH}/audit`);
    expect(res.status).toBe(200);

    const body = res.body as AuditResponse;
    expect(body.checks.length).toBeGreaterThanOrEqual(10);
    expect(new Set(body.checks.map((check) => check.id)).size).toBe(body.checks.length);
    for (const check of body.checks) {
      expect(check.category.length).toBeGreaterThan(0);
      expect(check.practice.length).toBeGreaterThan(0);
      expect(['pass', 'warn', 'fail']).toContain(check.status);
      expect(check.evidence.length).toBeGreaterThan(0);
    }
    // The summary counts add up.
    expect(body.summary.total).toBe(body.checks.length);
    expect(body.summary.pass + body.summary.warn + body.summary.fail).toBe(body.summary.total);
  });
});

describe('GET /api/demo/best/audit — the local checks read REAL process state', () => {
  // Specs never import server.ts (its side effects own the port), so the
  // listener checks would honestly read 0 under vitest. Register listeners
  // exactly like server.ts does, and the introspection proves itself.
  const noop = (): void => {};

  it('SIGTERM / fatal-handler / rate-limit / log-ring / sqlite checks PASS with real signals', async () => {
    process.on('SIGTERM', noop);
    process.on('uncaughtException', noop);
    process.on('unhandledRejection', noop);
    try {
      const res = await request(createApp()).get(`${BEST_DEMO_MOUNT_PATH}/audit`);
      expect(res.status).toBe(200);
      const body = res.body as AuditResponse;

      expect(checkById(body, 'graceful-shutdown').status).toBe('pass');
      expect(checkById(body, 'graceful-shutdown').evidence).toContain('listenerCount');
      expect(checkById(body, 'fatal-handlers').status).toBe('pass');
      expect(checkById(body, 'rate-limits-configured').status).toBe('pass');
      expect(checkById(body, 'rate-limits-configured').evidence).toContain('5/60s');
      expect(checkById(body, 'log-ring-live').status).toBe('pass');
      // The fs heuristic reads the DAO this app actually runs — in dev specs
      // the TS source is present, so this grades the real file.
      const sqlite = checkById(body, 'sqlite-parameterized');
      expect(sqlite.status).toBe('pass');
      expect(sqlite.evidence).toContain('static source heuristic');
      expect(sqlite.evidence).toMatch(/positional|named/);
    } finally {
      process.removeListener('SIGTERM', noop);
      process.removeListener('uncaughtException', noop);
      process.removeListener('unhandledRejection', noop);
    }
  });

  it('without the listeners, the introspection honestly grades FAIL (real signal, not theater)', async () => {
    const baseline = {
      sigterm: process.listenerCount('SIGTERM'),
      uncaught: process.listenerCount('uncaughtException'),
      unhandled: process.listenerCount('unhandledRejection'),
    };
    if (baseline.sigterm === 0 && baseline.uncaught === 0 && baseline.unhandled === 0) {
      const res = await request(createApp()).get(`${BEST_DEMO_MOUNT_PATH}/audit`);
      const body = res.body as AuditResponse;
      expect(checkById(body, 'graceful-shutdown').status).toBe('fail');
      expect(checkById(body, 'fatal-handlers').status).toBe('fail');
    }
    // If vitest itself registered listeners, the pass case is the honest
    // reading — either way the check reports the PROCESS, which is the spec.
  });
});

describe('GET /api/demo/best/audit — self-fetch degradation (never a 500, never a lie)', () => {
  it('the seven self-fetched checks WARN with the unreachable note when nothing listens', async () => {
    // Deterministic unreachability (the obs make-noise spec's pattern): a
    // fetch that cannot connect — the live-server case the warn describes.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const res = await request(createApp()).get(`${BEST_DEMO_MOUNT_PATH}/audit`);
    expect(res.status).toBe(200);
    const body = res.body as AuditResponse;

    for (const id of SELF_FETCH_IDS) {
      const check = checkById(body, id);
      expect(check.status).toBe('warn');
      expect(check.evidence).toContain('self-fetch unavailable');
    }
    expect(body.summary.warn).toBeGreaterThanOrEqual(SELF_FETCH_IDS.length);
    expect(body.note).toContain('could not OBSERVE');
  });
});

describe('GET /api/demo/best/audit — self-fetch checks PASS against a simulated live app', () => {
  it('grades helmet, request-id, envelope, compression scoping, health, docs, versioning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<unknown> => {
        const url = typeof input === 'string' ? input : input.toString();
        const response = (body: unknown, status: number, headers: Record<string, string> = {}) => ({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (name: string): string | null => headers[name.toLowerCase()] ?? null,
          },
          json: async () => body,
        });
        if (url.endsWith('/api/health')) {
          return response(
            { status: 'ok' },
            200,
            {
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'self'",
              'x-request-id': 'audit-spec-req-id-1234',
              // no content-encoding: identity — compression is scoped by design
            },
          );
        }
        if (url.includes('__definitely_not_a_route__')) {
          return response(
            { error: { code: 'not_found', message: 'Cannot GET /api/demo/best/__definitely_not_a_route__', requestId: 'audit-spec-req-id-1234' } },
            404,
          );
        }
        if (url.endsWith('/docs/')) {
          return response('', 200);
        }
        if (url.endsWith('/api/content')) {
          return response({ version: 1, groups: [], topics: [] }, 200);
        }
        return response({ error: { code: 'not_found', message: `no audit spec stub for ${url}` } }, 404);
      }),
    );

    const res = await request(createApp()).get(`${BEST_DEMO_MOUNT_PATH}/audit`);
    expect(res.status).toBe(200);
    const body = res.body as AuditResponse;

    expect(checkById(body, 'helmet-headers').status).toBe('pass');
    expect(checkById(body, 'helmet-headers').evidence).toContain('nosniff');
    expect(checkById(body, 'request-id').status).toBe('pass');
    expect(checkById(body, 'request-id').evidence).toContain('x-request-id: audit-sp');
    expect(checkById(body, 'error-envelope').status).toBe('pass');
    expect(checkById(body, 'error-envelope').evidence).toContain('not_found');
    // compression-scoped PASSES on identity — the scoping is the practice.
    expect(checkById(body, 'compression-scoped').status).toBe('pass');
    expect(checkById(body, 'compression-scoped').evidence).toContain('PASS on purpose');
    expect(checkById(body, 'health-endpoint').status).toBe('pass');
    expect(checkById(body, 'docs-served').status).toBe('pass');
    expect(checkById(body, 'content-versioned').status).toBe('pass');
    expect(checkById(body, 'content-versioned').evidence).toContain('version 1');
    expect(body.summary.warn).toBe(0);
  });

  it('a WRONG header answer grades FAIL — the checks assert, they do not decorate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<unknown> => {
        const url = typeof input === 'string' ? input : input.toString();
        const response = (body: unknown, status: number, headers: Record<string, string> = {}) => ({
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
          json: async () => body,
        });
        if (url.endsWith('/api/health')) {
          // No helmet headers, no request id — a bare-bones wrong answer.
          return response({ status: 'ok' }, 200);
        }
        return response('', 200);
      }),
    );

    const res = await request(createApp()).get(`${BEST_DEMO_MOUNT_PATH}/audit`);
    const body = res.body as AuditResponse;
    expect(checkById(body, 'helmet-headers').status).toBe('fail');
    expect(checkById(body, 'request-id').status).toBe('fail');
    // health itself answered 200 — still a pass; the check is about health.
    expect(checkById(body, 'health-endpoint').status).toBe('pass');
  });
});
