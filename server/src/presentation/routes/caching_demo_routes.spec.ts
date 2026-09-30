import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Redis } from 'ioredis';
import { createApp } from '../../app.js';
import { CACHING_DEMO_MOUNT_PATH, etagMatches } from './caching_demo_routes.js';
import { getRedisClient } from '../../data/redis/redis_client.js';
import {
  REPORT_CACHE_KEY,
  REPORT_TTL_SECONDS,
  STAMPEDE_PARALLEL,
  buildPostsReport,
  resetCachingDemo,
} from '../../data/caching/cache_aside_service.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * The caching demo endpoints over HTTP, in two store worlds:
 *
 * - DEFAULT SUITE (no REDIS_TEST_URI): the in-process MEMORY store — which is
 *   the honest fallback the topic teaches. Specs prove the etag/conditional
 *   asset round-trip (200 → If-None-Match → 304), the cache-aside lifecycle
 *   (miss → hit → invalidate → miss), the hitRate arithmetic, input
 *   validation, and BOTH stampede modes (naive rebuilds 10×, single-flight
 *   once).
 * - REDIS_TEST_URI SET: a live compose redis — the SAME flow against the real
 *   shared store, plus direct proof (a second ioredis client) that entries
 *   land in and leave the guide:cache: namespace.
 */

const MOUNT = CACHING_DEMO_MOUNT_PATH; // /api/demo/caching
const ETAG_RE = /^"[0-9a-f]{64}"$/;
const REVALIDATE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

// --- pure units: the If-None-Match comparator (always on) -----------------------------

describe('caching etag comparator pure units (always on, no store involved)', () => {
  const etag = '"aa11"';

  it('matches the exact etag, weak variants, comma lists, and *', () => {
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(`W/${etag}`, etag)).toBe(true); // weak comparison
    expect(etagMatches(`"other", ${etag}`, etag)).toBe(true); // list
    expect(etagMatches('*', etag)).toBe(true);
  });

  it('does not match absent, empty, or different etags', () => {
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches('', etag)).toBe(false);
    expect(etagMatches('"bb22"', etag)).toBe(false);
    expect(etagMatches('W/"bb22"', etag)).toBe(false);
    expect(etagMatches('"other", "third"', etag)).toBe(false);
  });
});

// --- the HTTP-caching asset (store-independent: pure HTTP semantics) ------------------

describe('caching asset — HTTP caching with ETag + conditional requests', () => {
  it('first GET: 200, a sha256 etag, and the revalidation policy', async () => {
    const res = await request(createApp()).get(`${MOUNT}/asset`);

    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(ETAG_RE);
    expect(res.headers['cache-control']).toBe(REVALIDATE);
    expect(res.body).toMatchObject({ kind: 'posts-report', postCount: 3 });
  });

  it('the etag is the sha256 of the BODY — stable across processes, not memory identity', async () => {
    const res = await request(createApp()).get(`${MOUNT}/asset`);
    // buildPostsReport is deterministic (seed-derived, no clocks): hashing its
    // output must reproduce the served etag byte for byte.
    const expected = `"${createHash('sha256').update(JSON.stringify(await buildPostsReport())).digest('hex')}"`;
    expect(res.headers.etag).toBe(expected);

    // A second app instance serves the SAME etag — the whole point of a
    // content-derived validator (a memory-address etag could never do this).
    const again = await request(createApp()).get(`${MOUNT}/asset`);
    expect(again.headers.etag).toBe(res.headers.etag);
  });

  it('If-None-Match with the held etag → 304 with an EMPTY body and the same headers', async () => {
    const first = await request(createApp()).get(`${MOUNT}/asset`);
    const etag = first.headers.etag as string;

    const revalidated = await request(createApp())
      .get(`${MOUNT}/asset`)
      .set('If-None-Match', etag);

    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe(''); // the savings IS the empty body
    expect(revalidated.headers.etag).toBe(etag);
    expect(revalidated.headers['cache-control']).toBe(REVALIDATE);
  });

  it('a WEAK If-None-Match (W/…) also revalidates — weak comparison, per the spec', async () => {
    const first = await request(createApp()).get(`${MOUNT}/asset`);
    const res = await request(createApp())
      .get(`${MOUNT}/asset`)
      .set('If-None-Match', `W/${String(first.headers.etag)}`);

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
  });

  it('a NON-matching etag → the full 200 again (the client\'s copy is stale)', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/asset`)
      .set('If-None-Match', '"0000000000000000000000000000000000000000000000000000000000000000"');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ postCount: 3 });
  });

  it('?version=immutable switches to the hashed-asset policy; bad versions 400', async () => {
    const immutable = await request(createApp()).get(`${MOUNT}/asset?version=immutable`);
    expect(immutable.status).toBe(200);
    expect(immutable.headers['cache-control']).toBe(IMMUTABLE);
    expect(immutable.headers.etag).toMatch(ETAG_RE);

    const bad = await request(createApp()).get(`${MOUNT}/asset?version=forever`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.parameter).toBe('version');
    expect(bad.body.error.requestId).toMatch(UUID_RE);
  });
});

// --- cache-aside, memory store world (the default suite) ------------------------------

describe.skipIf(process.env.REDIS_TEST_URI !== undefined)(
  'caching cache-aside — the MEMORY store world (default suite)',
  () => {
    beforeEach(async () => {
      // Counters are per-process state: every scenario starts from zero.
      await resetCachingDemo();
    });

    it('the store is reported TRUTHFULLY: getRedisClient is null, stats say memory', async () => {
      expect(await getRedisClient()).toBeNull(); // the optional service is off

      const stats = await request(createApp()).get(`${MOUNT}/stats`);
      expect(stats.status).toBe(200);
      expect(stats.body.store).toBe('memory');
      expect(stats.body.note).toContain('per-process');
    });

    it('first query misses (origin, ~150ms), second hits (cache, ~instant)', async () => {
      const first = await request(createApp()).get(`${MOUNT}/query`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ source: 'origin', store: 'memory', misses: 1, hits: 0 });
      expect(first.body.key).toBe(REPORT_CACHE_KEY);
      expect(first.body.report).toMatchObject({ kind: 'posts-report', postCount: 3 });
      expect(first.body.ms).toBeGreaterThanOrEqual(100); // it paid the origin cost

      const second = await request(createApp()).get(`${MOUNT}/query`);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ source: 'cache', store: 'memory', misses: 1, hits: 1 });
      expect(second.body.hitRate).toBeCloseTo(0.5, 10);
      expect(second.body.ms).toBeLessThan(first.body.ms); // and skipped it
      // Same payload either way — the cache is invisible to the caller.
      expect(second.body.report).toEqual(first.body.report);
    });

    it('stats: hitRate arithmetic and the entry with a live TTL under the cap', async () => {
      await request(createApp()).get(`${MOUNT}/query`); // miss
      await request(createApp()).get(`${MOUNT}/query`); // hit

      const stats = await request(createApp()).get(`${MOUNT}/stats`);
      expect(stats.status).toBe(200);
      expect(stats.body).toMatchObject({ store: 'memory', hits: 1, misses: 1, lastSource: 'cache', originBuilds: 1 });
      expect(stats.body.hitRate).toBeCloseTo(0.5, 10);
      expect(stats.body.entries).toEqual([
        { key: REPORT_CACHE_KEY, ttlSecondsRemaining: expect.any(Number) },
      ]);
      const ttl = stats.body.entries[0].ttlSecondsRemaining as number;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(REPORT_TTL_SECONDS);
    });

    it('invalidate deletes the key; the next query visibly goes back to origin', async () => {
      await request(createApp()).get(`${MOUNT}/query`);
      await request(createApp()).get(`${MOUNT}/query`);
      expect((await request(createApp()).get(`${MOUNT}/query`)).body.source).toBe('cache');

      const invalidated = await request(createApp()).post(`${MOUNT}/invalidate`);
      expect(invalidated.status).toBe(200);
      expect(invalidated.body).toEqual({ key: REPORT_CACHE_KEY, invalidated: true, store: 'memory' });

      const next = await request(createApp()).get(`${MOUNT}/query`);
      expect(next.body.source).toBe('origin');
      expect(next.body.originCalls === undefined).toBe(true); // no stray fields
      expect((await request(createApp()).get(`${MOUNT}/stats`)).body.entries.length).toBe(1);
    });

    it('stampede NAIVE: every one of the 10 parallel misses rebuilds', async () => {
      const res = await request(createApp()).get(`${MOUNT}/stampede?singleflight=0`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mode: 'naive', parallel: STAMPEDE_PARALLEL, store: 'memory' });
      expect(res.body.originCalls).toBe(STAMPEDE_PARALLEL); // the dogpile
      expect(res.body.perCall).toHaveLength(STAMPEDE_PARALLEL);
      expect(res.body.perCall.every((call: { source: string }) => call.source === 'origin')).toBe(true);
    }, 10_000);

    it('stampede SINGLE-FLIGHT: one rebuild, nine awaiters', async () => {
      const res = await request(createApp()).get(`${MOUNT}/stampede?singleflight=1`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mode: 'singleflight', parallel: STAMPEDE_PARALLEL, store: 'memory' });
      expect(res.body.originCalls).toBe(1); // the fix
      expect(res.body.perCall).toHaveLength(STAMPEDE_PARALLEL);
    }, 10_000);

    it('stampede timing (relative, generous): naive queues 10 builds, single-flight pays one', async () => {
      const singleFlight = await request(createApp()).get(`${MOUNT}/stampede?singleflight=1`);
      const naive = await request(createApp()).get(`${MOUNT}/stampede`);
      expect(naive.body.totalMs).toBeGreaterThan(singleFlight.body.totalMs);
      // The serialized fake origin makes naive ≥ 10 origin trips ≈ 1.5s.
      expect(naive.body.totalMs).toBeGreaterThanOrEqual(STAMPEDE_PARALLEL * 100);
    }, 20_000);
  },
);

// --- cache-aside, redis live world (REDIS_TEST_URI set) --------------------------------

describe.skipIf(!process.env.REDIS_TEST_URI)(
  'caching cache-aside against a LIVE redis (REDIS_TEST_URI set)',
  () => {
    // A SECOND ioredis client, outside the app entirely — the namespace proof.
    // Constructed only when the env var exists (describe callbacks still run at
    // collection time when skipped, and a client must never dial from nowhere).
    const direct = process.env.REDIS_TEST_URI !== undefined
      ? new Redis(process.env.REDIS_TEST_URI, {
          lazyConnect: true,
          connectTimeout: 1500,
          maxRetriesPerRequest: 1,
        })
      : null;

    beforeEach(async () => {
      await resetCachingDemo();
      if (direct !== null) await direct.connect().catch(() => undefined); // idempotent
    });

    afterAll(async () => {
      // Leave the demo namespace clean for the next experimenter.
      await resetCachingDemo();
      // disconnect() is synchronous in ioredis and returns void.
      direct?.disconnect();
    });

    /** Narrowing helper: this suite only runs with REDIS_TEST_URI set. */
    function liveClient(): Redis {
      if (direct === null) throw new Error('REDIS_TEST_URI must be set for the live caching specs');
      return direct;
    }

    it('the store is reported TRUTHFULLY: a live client, stats say redis', async () => {
      expect(await getRedisClient()).not.toBeNull();

      const stats = await request(createApp()).get(`${MOUNT}/stats`);
      expect(stats.status).toBe(200);
      expect(stats.body.store).toBe('redis');
      expect(stats.body.note).toContain('SHARED');
    });

    it('miss → the key lands in guide:cache: with a TTL; hit; invalidate removes it', async () => {
      const first = await request(createApp()).get(`${MOUNT}/query`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ source: 'origin', store: 'redis' });

      // Direct, independent proof: the entry exists under the namespace with a live TTL.
      expect(await liveClient().exists(REPORT_CACHE_KEY)).toBe(1);
      const ttl = await liveClient().ttl(REPORT_CACHE_KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(REPORT_TTL_SECONDS);

      const second = await request(createApp()).get(`${MOUNT}/query`);
      expect(second.body).toMatchObject({ source: 'cache', store: 'redis', hits: 1, misses: 1 });
      expect(second.body.hitRate).toBeCloseTo(0.5, 10);
      expect(second.body.report).toEqual(first.body.report);

      const invalidated = await request(createApp()).post(`${MOUNT}/invalidate`);
      expect(invalidated.body).toEqual({ key: REPORT_CACHE_KEY, invalidated: true, store: 'redis' });
      expect(await liveClient().exists(REPORT_CACHE_KEY)).toBe(0);

      const next = await request(createApp()).get(`${MOUNT}/query`);
      expect(next.body.source).toBe('origin');
    });

    it('stampede against the SHARED store: single-flight rebuilds once, naive rebuilds all', async () => {
      const singleFlight = await request(createApp()).get(`${MOUNT}/stampede?singleflight=1`);
      expect(singleFlight.status).toBe(200);
      expect(singleFlight.body.store).toBe('redis');
      expect(singleFlight.body.originCalls).toBe(1);

      const naive = await request(createApp()).get(`${MOUNT}/stampede?singleflight=0`);
      expect(naive.body.store).toBe('redis');
      expect(naive.body.originCalls).toBe(STAMPEDE_PARALLEL);
      expect(naive.body.totalMs).toBeGreaterThan(singleFlight.body.totalMs);
    }, 20_000);
  },
);

// --- input validation (always on) ------------------------------------------------------

describe('caching demo input validation (always on)', () => {
  it('stampede rejects a bad singleflight value with the canonical 400 envelope', async () => {
    for (const value of ['yes', '2', 'true']) {
      const res = await request(createApp()).get(`${MOUNT}/stampede?singleflight=${value}`);
      expect(res.status, `singleflight=${value}`).toBe(400);
      expect(res.body.error.code, `singleflight=${value}`).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('singleflight');
      expect(res.body.error.requestId).toMatch(UUID_RE);
    }
  });

  it('the omitted singleflight defaults to the naive mode (still a valid run)', async () => {
    await resetCachingDemo();
    const res = await request(createApp()).get(`${MOUNT}/stampede`);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('naive');
  }, 10_000);
});
