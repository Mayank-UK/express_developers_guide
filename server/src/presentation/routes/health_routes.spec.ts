import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { UUID_RE } from '../../test_support/index.js';

describe('GET /api/health', () => {
  it('returns 200 with status ok, uptime, and a request id echo', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.requestId).toMatch(UUID_RE);
    expect(res.headers['x-request-id'] ?? '').toBe(res.body.requestId);
  });

  it('returns the canonical error envelope for unknown api routes', async () => {
    const res = await request(createApp()).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'not_found',
      message: expect.any(String),
      requestId: expect.stringMatching(UUID_RE),
    });
    // The request-id middleware runs before the catch-all, so the envelope
    // carries the real correlation id, echoed on the header too.
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});
