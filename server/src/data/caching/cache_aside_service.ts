import { Redis } from 'ioredis';
import { type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import { logger } from '../../core/logging/logger.js';
import { getRedisClient } from '../redis/redis_client.js';
import { classifyRedisError } from '../redis/error_classification.js';
import { SEED_POSTS } from '../posts/seed_posts.js';

/**
 * The caching topic's teaching service — the cache-aside pattern with a REAL
 * store behind it, in the same Result/Failure shape as the redis playground:
 * methods never throw, and every reply says WHICH store served it.
 *
 * THE HONEST STORE RULE (the lesson this file exists to teach): the pattern is
 * ONE algorithm over TWO possible stores. When the optional redis service is
 * up (`getRedisClient()` answers a live connection) the cache is REDIS —
 * shared by every process that can reach it, surviving per-process restarts.
 * When it is not, the cache is an in-process Map with TTL tracking — same
 * code path, same counters, but per-process only. Every response reports the
 * store it actually used; the topic content explains the difference.
 *
 * The "expensive" origin query is deterministic (derived from the seed posts,
 * no clocks, no randomness) so the HTTP-caching etag built over it is stable
 * across restarts — sha of the BODY, never of memory identity.
 *
 * LAYERING: same call as data/redis/redis_playground.ts — no domain use case,
 * because the demo's only rules are pattern mechanics the routes' input
 * validation already covers.
 */

/** Every key this demo touches starts here (the same discipline as guide:demo:). */
export const CACHING_DEMO_NAMESPACE = 'guide:cache:';

/** The one cache-aside key the demo fills. */
export const REPORT_CACHE_KEY = `${CACHING_DEMO_NAMESPACE}posts-report`;

/** The artificial cost of the origin query — the thing caching skips. */
export const ORIGIN_DELAY_MS = 150;

/** How long a filled cache entry lives before the TTL backstop evicts it. */
export const REPORT_TTL_SECONDS = 60;

/** How many lookups the stampede endpoint fires at once. */
export const STAMPEDE_PARALLEL = 10;

/** How many recent lookups the per-run timeline keeps (newest kept). */
export const CACHING_TIMELINE_CAP = 20;

// --- the expensive origin query -----------------------------------------------------

export interface PostsReportPost {
  readonly id: string;
  readonly title: string;
  readonly words: number;
  readonly chars: number;
}

export interface PostsReport {
  readonly kind: 'posts-report';
  readonly postCount: number;
  readonly totalWords: number;
  readonly totalChars: number;
  readonly longestTitle: string;
  readonly authors: readonly string[];
  readonly posts: readonly PostsReportPost[];
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/**
 * The fake expensive query the whole topic caches: derives a report from the
 * seed posts. Deterministic by construction — same seeds in, same bytes out —
 * which is what makes the etag demo honest.
 *
 * The work is queued through ONE serial promise chain on purpose: it models a
 * constrained origin resource (a single database connection, the way
 * better-sqlite3 serializes). Ten simultaneous misses do not parallelize the
 * origin away — they QUEUE, each paying ORIGIN_DELAY_MS — which is exactly the
 * dogpile the stampede section makes visible.
 */
let originQueue: Promise<unknown> = Promise.resolve();
let originBuilds = 0;

export async function buildPostsReport(): Promise<PostsReport> {
  const run = async (): Promise<PostsReport> => {
    await new Promise((resolve) => setTimeout(resolve, ORIGIN_DELAY_MS));
    const posts = [...SEED_POSTS]
      .map((post) => ({
        id: post.id,
        title: post.title,
        words: countWords(`${post.title} ${post.body}`),
        chars: post.title.length + post.body.length,
      }))
      .sort((a, b) => b.words - a.words || a.id.localeCompare(b.id));
    const authors = [...new Set(SEED_POSTS.map((post) => post.author))].sort();
    return Object.freeze({
      kind: 'posts-report' as const,
      postCount: SEED_POSTS.length,
      totalWords: posts.reduce((sum, post) => sum + post.words, 0),
      totalChars: posts.reduce((sum, post) => sum + post.chars, 0),
      longestTitle:
        [...SEED_POSTS].sort((a, b) => b.title.length - a.title.length)[0]?.title ?? '',
      authors,
      posts,
    });
  };
  const next = originQueue.then(run, run); // run whether the last build won or lost
  originQueue = next.catch(() => undefined);
  originBuilds += 1;
  return next;
}

// --- the two stores -----------------------------------------------------------------

export type CacheStoreKind = 'redis' | 'memory';

interface CacheEntry {
  readonly value: string;
  readonly expiresAtMs: number;
}

/** The per-process fallback store: same contract as the redis calls below. */
const memoryStore = new Map<string, CacheEntry>();

interface ResolvedStore {
  readonly kind: CacheStoreKind;
  /** Present only in the redis world — the live commands connection. */
  readonly client?: Redis;
}

/**
 * Picks the store for THIS call: redis when the optional service is live,
 * otherwise the in-process Map. Never throws — an away service means memory.
 */
async function resolveStore(): Promise<ResolvedStore> {
  const client = await getRedisClient();
  return client === null ? { kind: 'memory' } : { kind: 'redis', client };
}

// A redis op that fails MID-LOOKUP (the service was up at resolve time, then
// went away) classifies through the shared seam every redis-backed data
// service uses — data/redis/error_classification.ts — so this demo degrades
// with the exact same 503 envelope as the redis tour and the stream lab.

interface StoreApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<boolean>;
  ttl(key: string): Promise<number | null>;
  entries(): Promise<readonly { key: string; ttlSecondsRemaining: number | null }[]>;
}

function memoryApi(): StoreApi {
  return {
    async get(key) {
      const entry = memoryStore.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAtMs <= Date.now()) {
        memoryStore.delete(key); // lazy eviction on read
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      memoryStore.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      return memoryStore.delete(key);
    },
    async ttl(key) {
      const entry = memoryStore.get(key);
      if (entry === undefined) return null;
      const remaining = Math.ceil((entry.expiresAtMs - Date.now()) / 1000);
      return remaining > 0 ? remaining : null;
    },
    async entries() {
      const live: { key: string; ttlSecondsRemaining: number | null }[] = [];
      for (const key of memoryStore.keys()) {
        const ttl = await this.ttl(key);
        if (ttl !== null) live.push({ key, ttlSecondsRemaining: ttl });
      }
      return live;
    },
  };
}

function redisApi(client: Redis): StoreApi {
  return {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, ttlSeconds) {
      await client.set(key, value, 'EX', ttlSeconds);
    },
    async del(key) {
      return (await client.del(key)) > 0;
    },
    async ttl(key) {
      const ttl = await client.ttl(key);
      return ttl >= 0 ? ttl : null;
    },
    async entries() {
      const ttl = await this.ttl(REPORT_CACHE_KEY);
      return ttl === null ? [] : [{ key: REPORT_CACHE_KEY, ttlSecondsRemaining: ttl }];
    },
  };
}

// --- counters, timeline, reset ------------------------------------------------------

export interface TimelineEntry {
  readonly at: string;
  readonly source: 'origin' | 'cache';
  readonly ms: number;
}

let hits = 0;
let misses = 0;
let lastSource: 'origin' | 'cache' | null = null;
const timeline: TimelineEntry[] = [];

function recordLookup(source: 'origin' | 'cache', ms: number): void {
  if (source === 'cache') hits += 1;
  else misses += 1;
  lastSource = source;
  timeline.push({ at: new Date().toISOString(), source, ms });
  if (timeline.length > CACHING_TIMELINE_CAP) timeline.splice(0, timeline.length - CACHING_TIMELINE_CAP);
}

/**
 * The spec reset: zeroes counters, clears the timeline and the in-flight map,
 * empties the memory store, and (best effort) deletes the redis key — so runs
 * never inherit each other's state. Exported for specs; no route calls it.
 */
export async function resetCachingDemo(): Promise<void> {
  hits = 0;
  misses = 0;
  lastSource = null;
  originBuilds = 0;
  timeline.length = 0;
  inFlight.clear();
  memoryStore.clear();
  const store = await resolveStore();
  if (store.kind === 'redis' && store.client !== undefined) {
    await store.client.del(REPORT_CACHE_KEY).catch(() => undefined);
  }
}

// --- cache-aside with single-flight --------------------------------------------------

export interface CacheAsideQuery {
  readonly key: string;
  readonly source: 'origin' | 'cache';
  readonly ms: number;
  readonly store: CacheStoreKind;
  readonly report: PostsReport;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly lastSource: 'origin' | 'cache';
}

/** The single-flight map: key -> the in-flight FILL promise. */
const inFlight = new Map<string, Promise<PostsReport>>();

async function fillFromOrigin(key: string, store: StoreApi): Promise<PostsReport> {
  const report = await buildPostsReport();
  await store.set(key, JSON.stringify(report), REPORT_TTL_SECONDS);
  return report;
}

/**
 * ONE cache-aside lookup: check the cache → hit: serve; miss: build from the
 * origin, store with a TTL, serve. With singleFlight, concurrent misses on the
 * same key SHARE one fill promise instead of each rebuilding (the stampede
 * fix). Awaiters are served by the origin fill too — nobody hit a cache — so
 * their source is honestly 'origin'.
 */
export async function queryWithCacheAside(options: { singleFlight?: boolean } = {}): Promise<Result<CacheAsideQuery, Failure>> {
  const started = Date.now();
  const storeResolution = await resolveStore();
  const store = storeResolution.kind === 'redis' && storeResolution.client !== undefined
    ? redisApi(storeResolution.client)
    : memoryApi();

  try {
    const cached = await store.get(REPORT_CACHE_KEY);
    if (cached !== null) {
      const ms = Date.now() - started;
      recordLookup('cache', ms);
      return ok({
        key: REPORT_CACHE_KEY,
        source: 'cache',
        ms,
        store: storeResolution.kind,
        report: JSON.parse(cached) as PostsReport,
        hits,
        misses,
        hitRate: hitRate(),
        lastSource: 'cache',
      });
    }

    // Miss: fill — alone, or sharing the in-flight promise when singleFlight.
    let fill = options.singleFlight === true ? inFlight.get(REPORT_CACHE_KEY) : undefined;
    if (fill === undefined) {
      fill = fillFromOrigin(REPORT_CACHE_KEY, store);
      if (options.singleFlight === true) {
        inFlight.set(REPORT_CACHE_KEY, fill);
        fill.finally(() => {
          // Cleanup after settle: the map never leaks across runs.
          if (inFlight.get(REPORT_CACHE_KEY) === fill) inFlight.delete(REPORT_CACHE_KEY);
        }).catch(() => undefined);
      }
    }
    const report = await fill;
    const ms = Date.now() - started;
    recordLookup('origin', ms);
    return ok({
      key: REPORT_CACHE_KEY,
      source: 'origin',
      ms,
      store: storeResolution.kind,
      report,
      hits,
      misses,
      hitRate: hitRate(),
      lastSource: 'origin',
    });
  } catch (cause) {
    // A redis op failed mid-lookup (the service was up at resolve time).
    const resolution = classifyRedisError('running a cache-aside lookup', cause);
    if (resolution.kind === 'unavailable') {
      logger.warn('redis went away mid-lookup — the caching demo answers unavailable');
    }
    return fail(resolution);
  }
}

function hitRate(): number {
  const lookups = hits + misses;
  return lookups === 0 ? 0 : hits / lookups;
}

// --- invalidation --------------------------------------------------------------------

export interface InvalidateResult {
  readonly key: string;
  readonly invalidated: boolean;
  readonly store: CacheStoreKind;
}

/** Explicit invalidation: DELETE the key (and drop any in-flight fill). */
export async function invalidateReportCache(): Promise<Result<InvalidateResult, Failure>> {
  const storeResolution = await resolveStore();
  const store = storeResolution.kind === 'redis' && storeResolution.client !== undefined
    ? redisApi(storeResolution.client)
    : memoryApi();
  inFlight.delete(REPORT_CACHE_KEY);
  try {
    return ok({
      key: REPORT_CACHE_KEY,
      invalidated: await store.del(REPORT_CACHE_KEY),
      store: storeResolution.kind,
    });
  } catch (cause) {
    return fail(classifyRedisError('invalidating the report cache', cause));
  }
}

// --- stats ---------------------------------------------------------------------------

export interface CachingStats {
  readonly store: CacheStoreKind;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly lastSource: 'origin' | 'cache' | null;
  readonly originBuilds: number;
  readonly entries: readonly { key: string; ttlSecondsRemaining: number | null }[];
  readonly timeline: readonly TimelineEntry[];
  readonly note: string;
}

const STORE_NOTES: Readonly<Record<CacheStoreKind, string>> = {
  redis:
    'redis is live — this cache is SHARED: every process pointing at the same server sees the same entries.',
  memory:
    'redis is not configured/reachable — this cache is an in-process Map: per-process ONLY, so two app replicas would each keep their own. Same pattern, different blast radius.',
};

/** The counters + the store actually in use + what the entries' TTLs say. */
export async function getCachingStats(): Promise<Result<CachingStats, Failure>> {
  const storeResolution = await resolveStore();
  const store = storeResolution.kind === 'redis' && storeResolution.client !== undefined
    ? redisApi(storeResolution.client)
    : memoryApi();
  try {
    return ok({
      store: storeResolution.kind,
      hits,
      misses,
      hitRate: hitRate(),
      lastSource,
      originBuilds,
      entries: await store.entries(),
      timeline: [...timeline].reverse(),
      note: STORE_NOTES[storeResolution.kind],
    });
  } catch (cause) {
    return fail(classifyRedisError('reading cache stats', cause));
  }
}

// --- stampede ------------------------------------------------------------------------

export interface StampedeCall {
  readonly ms: number;
  readonly source: 'origin' | 'cache';
}

export interface StampedeRun {
  readonly mode: 'naive' | 'singleflight';
  readonly parallel: number;
  /** How many times the ORIGIN was queried during this run — the number that matters. */
  readonly originCalls: number;
  readonly totalMs: number;
  readonly perCall: readonly StampedeCall[];
  readonly store: CacheStoreKind;
}

/**
 * Fires the same cache-aside lookup `parallel` times AT ONCE against an empty
 * key (invalidated first, so every run starts cold):
 *
 * - naive: every caller misses and rebuilds — originCalls === parallel, and
 *   because the fake origin serializes (one "connection"), the last caller
 *   waits behind all the others.
 * - singleflight: the first miss registers its fill promise; the rest AWAIT it
 *   — originCalls === 1, everyone waits ~one origin trip.
 */
export async function runStampede(
  mode: 'naive' | 'singleflight',
  parallel: number = STAMPEDE_PARALLEL,
): Promise<Result<StampedeRun, Failure>> {
  const started = Date.now();
  await invalidateReportCache(); // cold start: the demo must be repeatable
  const before = originBuilds;

  const lookups = await Promise.all(
    Array.from({ length: parallel }, () =>
      queryWithCacheAside({ singleFlight: mode === 'singleflight' }),
    ),
  );
  const failed = lookups.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) return failed;

  const perCall: StampedeCall[] = lookups.map((result) => {
    if (!result.ok) throw new Error('unreachable: filtered above');
    return { ms: result.value.ms, source: result.value.source };
  });
  const store = lookups[0]?.ok === true ? lookups[0].value.store : 'memory';

  return ok({
    mode,
    parallel,
    originCalls: originBuilds - before,
    totalMs: Date.now() - started,
    perCall,
    store,
  });
}
