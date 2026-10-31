import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { resetHttpDurationForTests } from '../../core/metrics/prometheus_metrics.js';
import { UUID_RE } from '../../test_support/index.js';

// One registry per vitest worker (module state), so reset BEFORE each case:
// assertions must see only the requests the case itself fired.
beforeEach(() => {
  resetHttpDurationForTests();
});

describe('GET /metrics', () => {
  it('returns 200 with the prometheus text format and default metrics', async () => {
    const res = await request(createApp()).get('/metrics');

    expect(res.status).toBe(200);
    // The exposition content type comes from the registry itself — assert
    // the family, not the exact version string, so a prom-client format
    // bump is not a spec churn.
    expect(res.headers['content-type'] ?? '').toMatch(/^text\/plain/);
    expect(res.text).toContain('nodejs_version_info');
    expect(res.text).toContain('process_cpu_seconds_total');
  });

  it('labels matched requests with their route pattern, not the raw path', async () => {
    const app = createApp();
    // Same query a demo page would send — the label must stay the PATTERN.
    await request(app).get('/api/health?probe=1');
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('route="/api/health"');
    expect(res.text).toContain('status="200"');
    // No raw path or query ever leaked into a label.
    expect(res.text).not.toContain('probe=1');
  });

  it('buckets unmatched requests as a single bounded label', async () => {
    const app = createApp();
    const miss = await request(app).get('/api/definitely-not-a-route');
    expect(miss.status).toBe(404);

    const res = await request(app).get('/metrics');
    expect(res.text).toContain('route="unmatched"');
    expect(res.text).not.toContain('route="/api/definitely-not-a-route"');
  });

  it('is a plain scrape, not an envelope: no error shape even on repeat hits', async () => {
    const app = createApp();
    const first = await request(app).get('/metrics');
    const second = await request(app).get('/metrics');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({});
    // The scrape itself rides the normal middleware chain — request id echoed.
    expect(second.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });
});
