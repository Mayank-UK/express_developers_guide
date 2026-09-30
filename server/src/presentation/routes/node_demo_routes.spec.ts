import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * application/x-ndjson has no superagent parser, so the raw body arrives as a
 * Buffer on res.body — collect it defensively either way and normalize \r.
 */
function bodyText(res: request.Response): string {
  const raw = res.text !== undefined ? res.text : String(res.body);
  return raw.replace(/\r/g, '');
}

function lineCount(text: string): number {
  return text.split('\n').filter((line) => line !== '').length;
}

describe('GET /api/demo/node/blocking', () => {
  it('reports a loop stall of roughly the whole synchronous workload', async () => {
    const res = await request(createApp()).get('/api/demo/node/blocking?workMs=120');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: 'blocking',
      workMs: 120,
      eventLoopDelayMs: expect.any(Number),
    });
    // The probe cannot fire before the busy loop finishes, so the stall is at
    // least the workload (120ms minus a sliver of clock precision). Only a
    // lower bound is asserted — machine contention can push it higher.
    expect(res.body.eventLoopDelayMs).toBeGreaterThanOrEqual(100);
    expect(res.body.eventLoopDelayMs).toBeLessThan(5000);
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });

  it('defaults to 50ms and clamps out-of-range values into 1–2000', async () => {
    const defaults = await request(createApp()).get('/api/demo/node/blocking');
    expect(defaults.status).toBe(200);
    expect(defaults.body.workMs).toBe(50);

    for (const raw of ['0', '-99']) {
      const res = await request(createApp()).get(`/api/demo/node/blocking?workMs=${raw}`);
      expect(res.status, `workMs=${raw}`).toBe(200);
      expect(res.body.mode).toBe('blocking');
      expect(res.body.workMs, `workMs=${raw} clamps to the minimum`).toBe(1);
    }
  });

  it('rejects garbage query values with a 400 envelope', async () => {
    // Empty/absent means "use the default" — only malformed input is a 400.
    for (const raw of ['abc', '12.5', '1e3', '5px']) {
      const res = await request(createApp()).get(`/api/demo/node/blocking?workMs=${raw}`);
      expect(res.status, `workMs=${raw}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('workMs');
      expect(res.body.error.requestId).toMatch(UUID_RE);
    }

    // Repeated parameter → express parses an array, which is also malformed.
    const repeated = await request(createApp()).get(
      '/api/demo/node/blocking?workMs=10&workMs=20',
    );
    expect(repeated.status).toBe(400);
    expect(repeated.body.error.parameter).toBe('workMs');
  });
});

describe('GET /api/demo/node/deferred', () => {
  it('does the same total work with a near-flat loop stall', async () => {
    // Sequential, so the two workloads never interfere with each other's
    // measurements: blocking first, then the deferred comparison run.
    const blocking = await request(createApp()).get('/api/demo/node/blocking?workMs=200');
    const deferred = await request(createApp()).get('/api/demo/node/deferred?workMs=200');

    expect(deferred.status).toBe(200);
    expect(deferred.body).toEqual({
      mode: 'deferred',
      workMs: 200,
      eventLoopDelayMs: expect.any(Number),
    });

    // Expected stall is one ~10ms slice; generous upper margin for machine
    // noise, plus the relative guarantee against the blocking run.
    expect(deferred.body.eventLoopDelayMs).toBeLessThanOrEqual(100);
    expect(deferred.body.eventLoopDelayMs).toBeLessThan(blocking.body.eventLoopDelayMs);
    expect(blocking.body.eventLoopDelayMs).toBeGreaterThanOrEqual(150);
    expect(deferred.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });

  it('treats an empty value as missing and clamps the upper bound to 2000', async () => {
    const empty = await request(createApp()).get('/api/demo/node/deferred?workMs=');
    expect(empty.status).toBe(200);
    expect(empty.body.mode).toBe('deferred');
    expect(empty.body.workMs).toBe(50);

    const huge = await request(createApp()).get('/api/demo/node/deferred?workMs=99999');
    expect(huge.status).toBe(200);
    expect(huge.body.workMs).toBe(2000);
  }, 10_000);
});

describe('GET /api/demo/node/stream', () => {
  it('buffered mode sends the whole body with Content-Length', async () => {
    const res = await request(createApp()).get('/api/demo/node/stream?mode=buffered&chunks=5');

    expect(res.status).toBe(200);
    expect(res.headers['x-stream-mode']).toBe('buffered');
    expect(Number(res.headers['x-elapsed-ms'])).toBeGreaterThanOrEqual(0);

    const text = bodyText(res);
    // Content-Length must exactly describe the body superagent received.
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(text));
    expect(text.endsWith('\n')).toBe(true);
    expect(lineCount(text)).toBe(5);

    const lines = text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);
    // Deterministic telemetry: same input → same values in both modes.
    expect(lines[0]).toEqual({
      seq: 1,
      sensor: 'cpu-package',
      valueC: 47,
      unit: 'celsius',
      status: 'ok',
      host: 'guide-node-1',
    });
  });

  it('stream mode carries identical bytes, chunked, with no Content-Length', async () => {
    const buffered = await request(createApp()).get(
      '/api/demo/node/stream?mode=buffered&chunks=5',
    );
    const streamed = await request(createApp()).get('/api/demo/node/stream?mode=stream&chunks=5');

    expect(buffered.status).toBe(200);
    expect(streamed.status).toBe(200);
    // The full body is awaited by supertest before these assertions run.
    expect(bodyText(streamed)).toBe(bodyText(buffered));

    expect(streamed.headers['x-stream-mode']).toBe('stream');
    expect(Number(streamed.headers['x-elapsed-ms'])).toBeGreaterThanOrEqual(0);
    expect(streamed.headers['content-length']).toBeUndefined();
    expect(streamed.headers['transfer-encoding']).toBe('chunked');
    expect(lineCount(bodyText(streamed))).toBe(5);
  });

  it('defaults to 100 chunks and clamps the range to 1–1000', async () => {
    const defaults = await request(createApp()).get('/api/demo/node/stream');
    expect(defaults.status).toBe(200);
    expect(lineCount(bodyText(defaults))).toBe(100);

    const zero = await request(createApp()).get('/api/demo/node/stream?chunks=0');
    expect(zero.status).toBe(200);
    expect(lineCount(bodyText(zero))).toBe(1);

    const huge = await request(createApp()).get(
      '/api/demo/node/stream?mode=buffered&chunks=9999',
    );
    expect(huge.status).toBe(200);
    expect(lineCount(bodyText(huge))).toBe(1000);
  });

  it('rejects unknown modes and garbage chunk counts with 400 envelopes', async () => {
    const mode = await request(createApp()).get('/api/demo/node/stream?mode=bogus');
    expect(mode.status).toBe(400);
    expect(mode.body.error.code).toBe('validation_failed');
    expect(mode.body.error.parameter).toBe('mode');
    expect(mode.body.error.validValues).toEqual(['buffered', 'stream']);
    expect(mode.body.error.requestId).toMatch(UUID_RE);

    for (const raw of ['abc', '1.5']) {
      const res = await request(createApp()).get(`/api/demo/node/stream?chunks=${raw}`);
      expect(res.status, `chunks=${raw}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('chunks');
    }
  });
});
