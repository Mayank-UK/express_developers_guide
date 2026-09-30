import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { PERF_DEMO_MOUNT_PATH, buildTelemetryPayload } from './perf_demo_routes.js';

/**
 * The benchmark pair over the REAL app: deterministic payloads in their
 * documented byte ranges, the compression contract (negotiated encoding
 * present/absent, chunked vs Content-Length), the SCOPING proof (an unrelated
 * route stays identity even when the client accepts gzip), and the honest
 * server-side benchmark numbers. superagent negotiates gzip by default and
 * transparently decompresses — so the specs assert HEADERS and the benchmark's
 * byte counts, not the raw wire bytes of the body.
 */

const app = createApp();

/** Expected serialized-size windows for the three teaching payloads. */
const SIZE_RANGES: Readonly<Record<string, [number, number]>> = {
  small: [1_500, 3_000],
  medium: [45_000, 60_000],
  large: [470_000, 550_000],
};

interface BenchmarkBody {
  size: string;
  runs: number;
  bytesRaw: number;
  bytesCompressed: number;
  ratio: number;
  msRaw: number;
  msCompressed: number;
  note: string;
}

describe('GET /api/demo/perf/payload — the deterministic teaching payload', () => {
  it.each(Object.entries(SIZE_RANGES))(
    'size %s serves a payload in its documented byte range',
    async (size, [min, max]) => {
      const res = await request(app)
        .get(`${PERF_DEMO_MOUNT_PATH}/payload`)
        .query({ size, noCompress: '1' }) // identity → exact Content-Length to read
        .expect(200);
      const length = Number(res.headers['content-length']);
      expect(length).toBeGreaterThanOrEqual(min);
      expect(length).toBeLessThanOrEqual(max);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['x-payload-raw-bytes']).toBe(String(length));
    },
  );

  it('is byte-identical across calls (same size → same sha256, twice)', async () => {
    const fetchOnce = async (): Promise<string> => {
      const res = await request(app)
        .get(`${PERF_DEMO_MOUNT_PATH}/payload`)
        .query({ size: 'medium', noCompress: '1' })
        .expect(200);
      return createHash('sha256').update(res.text).digest('hex');
    };
    expect(await fetchOnce()).toBe(await fetchOnce());
  });

  it('rejects an unknown size with the canonical 400 envelope', async () => {
    const res = await request(app)
      .get(`${PERF_DEMO_MOUNT_PATH}/payload`)
      .query({ size: 'humongous' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('GET /api/demo/perf/payload — the compression contract', () => {
  it('negotiates gzip when the client accepts it (chunked, no Content-Length)', async () => {
    const res = await request(app)
      .get(`${PERF_DEMO_MOUNT_PATH}/payload`)
      .query({ size: 'medium' })
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['transfer-encoding']).toBe('chunked');
    // superagent decompressed transparently — the body still parses as JSON.
    const body = res.body as { kind?: string; readings?: unknown[] };
    expect(body.kind).toBe('telemetry-batch');
    expect(body.readings).toHaveLength(24);
  });

  it('?noCompress=1 forces identity: no Content-Encoding, exact Content-Length', async () => {
    const res = await request(app)
      .get(`${PERF_DEMO_MOUNT_PATH}/payload`)
      .query({ size: 'medium', noCompress: '1' })
      .set('Accept-Encoding', 'gzip') // accepted but declined — the teaching switch
      .expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-length']).toBe(String(res.text.length));
  });

  it('reports the memoized gzip size of the exact bytes it serves', async () => {
    const res = await request(app)
      .get(`${PERF_DEMO_MOUNT_PATH}/payload`)
      .query({ size: 'medium' })
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    const gzipBytes = Number(res.headers['x-payload-gzip-bytes']);
    const rawBytes = Number(res.headers['x-payload-raw-bytes']);
    expect(gzipBytes).toBeGreaterThan(0);
    expect(gzipBytes).toBeLessThan(rawBytes / 5); // repetitive text: big wins
  });

  it('compression is SCOPED to the perf router: /api/health stays identity', async () => {
    const res = await request(app).get('/api/health').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /api/demo/perf/benchmark — the honest server-side numbers', () => {
  it('reports the documented shape with compressed bytes well under raw', async () => {
    const res = await request(app)
      .get(`${PERF_DEMO_MOUNT_PATH}/benchmark`)
      .query({ size: 'medium', runs: '5' })
      .expect(200);
    const body = res.body as BenchmarkBody;

    expect(body.size).toBe('medium');
    expect(body.runs).toBe(5);
    const [min, max] = SIZE_RANGES.medium!;
    expect(body.bytesRaw).toBeGreaterThanOrEqual(min);
    expect(body.bytesRaw).toBeLessThanOrEqual(max);
    expect(body.bytesCompressed).toBeGreaterThan(0);
    expect(body.bytesCompressed).toBeLessThan(body.bytesRaw);
    expect(body.ratio).toBeGreaterThan(0);
    expect(body.ratio).toBeLessThan(0.2); // repetitive text: 5×+ wins on the wire
    expect(body.msRaw).toBeGreaterThanOrEqual(0);
    expect(body.msCompressed).toBeGreaterThanOrEqual(0);
    expect(typeof body.note).toBe('string');
    expect(body.note).toContain('medians');
  });

  it('byte counts are deterministic across calls (same size, different runs)', async () => {
    const fetchOnce = async (): Promise<Pick<BenchmarkBody, 'bytesRaw' | 'bytesCompressed'>> => {
      const res = await request(app)
        .get(`${PERF_DEMO_MOUNT_PATH}/benchmark`)
        .query({ size: 'small', runs: '3' })
        .expect(200);
      const body = res.body as BenchmarkBody;
      return { bytesRaw: body.bytesRaw, bytesCompressed: body.bytesCompressed };
    };
    expect(await fetchOnce()).toEqual(await fetchOnce());
  });

  it('clamps runs into range and rejects garbage', async () => {
    const clamped = await request(app)
      .get(`${PERF_DEMO_MOUNT_PATH}/benchmark`)
      .query({ size: 'small', runs: '999' })
      .expect(200);
    expect((clamped.body as BenchmarkBody).runs).toBe(50);

    const garbage = await request(app)
      .get(`${PERF_DEMO_MOUNT_PATH}/benchmark`)
      .query({ size: 'small', runs: 'fast' });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('validation_failed');
  });
});

describe('buildTelemetryPayload — the generator itself', () => {
  it('is deterministic (two builds deep-equal) and compressible by construction', async () => {
    const first = buildTelemetryPayload('small');
    const second = buildTelemetryPayload('small');
    expect(first).toEqual(second);
    expect(first.readings[0]?.note).toContain('telemetry compresses well');
    expect(new Set(first.readings.map((reading) => reading.note)).size).toBe(1);
  });
});
