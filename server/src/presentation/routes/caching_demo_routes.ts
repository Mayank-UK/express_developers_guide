import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { ValidationException, failureToException } from '../../core/error_handling/exceptions.js';
// Deliberate teaching exception (the dependency rule is presentation → domain
// ← data; same note as db_demo_routes.ts): the cache-aside SERVICE is itself
// the artifact this topic teaches, so its exhibit routes import it directly.
import {
  buildPostsReport,
  getCachingStats,
  invalidateReportCache,
  queryWithCacheAside,
  runStampede,
} from '../../data/caching/cache_aside_service.js';

/**
 * The caching topic's live demo endpoints — two caching WORLDS over the same
 * deterministic "expensive" payload (a report of the seed posts, built behind
 * an artificial 150ms origin cost):
 *
 * - HTTP caching (the protocol does the caching):
 *     GET /api/demo/caching/asset              → 200 + ETag (sha256 of the body) + revalidation policy
 *     GET /api/demo/caching/asset?version=immutable → the hashed-asset policy (max-age=31536000, immutable)
 *     …with If-None-Match                      → 304, empty body, same ETag (the conditional round-trip)
 * - Server-side caching (the app does the caching, via the cache-aside service):
 *     GET  /api/demo/caching/query             → one cache-aside lookup ({ source: origin|cache, ms, hits, misses })
 *     POST /api/demo/caching/invalidate        → DELETE the key (explicit invalidation)
 *     GET  /api/demo/caching/stats             → { store: redis|memory, hits, misses, hitRate, entries }
 *     GET  /api/demo/caching/stampede?singleflight=0|1 → N parallel lookups; naive rebuilds N times,
 *                                                        single-flight rebuilds once
 *
 * Every server-side response names the STORE that served it (redis when the
 * optional service is live, the in-process Map otherwise) — the honest
 * fallback the topic teaches. These controllers stay thin: parse input, call
 * the service, map Result → HTTP.
 */

export const CACHING_DEMO_MOUNT_PATH = '/api/demo/caching';

const CACHE_CONTROL_REVALIDATE = 'public, max-age=0, must-revalidate';
const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

// --- the deterministic asset ---------------------------------------------------------

/**
 * The asset body and its ETag, computed ONCE per process from the seed-posts
 * report: sha256 of the BODY (never of memory identity), so the same content
 * yields the same etag across restarts and processes — the property that
 * makes conditional requests useful at all.
 */
let assetMemo: { body: string; etag: string } | undefined;

async function getAsset(): Promise<{ body: string; etag: string }> {
  if (assetMemo === undefined) {
    const report = await buildPostsReport();
    const body = JSON.stringify(report);
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    assetMemo = { body, etag };
  }
  return assetMemo;
}

/**
 * If-None-Match uses WEAK comparison: a `W/"…"` candidate matches the strong
 * `"…"`, quoted strings compare byte-for-byte, and `*` matches anything.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined || ifNoneMatch.trim() === '') return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .some((raw) => raw.trim().replace(/^W\//, '') === etag);
}

// --- input parsing --------------------------------------------------------------------

function readVersionQuery(query: Request['query']): '' | 'immutable' {
  const raw = query.version;
  if (raw === undefined || raw === '') return '';
  if (raw === 'immutable') return 'immutable';
  throw new ValidationException('"version" must be "immutable" (or omitted)', {
    parameter: 'version',
    received: String(raw),
  });
}

function readSingleFlightQuery(query: Request['query']): boolean {
  const raw = query.singleflight;
  if (raw === undefined || raw === '') return false;
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new ValidationException('"singleflight" must be "0" or "1" (or omitted for the naive mode)', {
    parameter: 'singleflight',
    received: String(raw),
  });
}

// --- controllers ----------------------------------------------------------------------

async function assetController(req: Request, res: Response): Promise<void> {
  const version = readVersionQuery(req.query);
  const cacheControl = version === 'immutable' ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_REVALIDATE;
  const { body, etag } = await getAsset();

  // The conditional request: if the client already holds this exact
  // representation, the answer is 304 with headers only — zero body bytes.
  if (etagMatches(req.header('if-none-match'), etag)) {
    res.status(304).set('ETag', etag).set('Cache-Control', cacheControl).end();
    return;
  }

  res.status(200).set('ETag', etag).set('Cache-Control', cacheControl).type('application/json').send(body);
}

async function queryController(_req: Request, res: Response): Promise<void> {
  const result = await queryWithCacheAside();
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

async function invalidateController(_req: Request, res: Response): Promise<void> {
  const result = await invalidateReportCache();
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

async function statsController(_req: Request, res: Response): Promise<void> {
  const result = await getCachingStats();
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

async function stampedeController(req: Request, res: Response): Promise<void> {
  const singleFlight = readSingleFlightQuery(req.query);
  const result = await runStampede(singleFlight ? 'singleflight' : 'naive');
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

export const cachingDemoRouter = Router();
cachingDemoRouter.get('/demo/caching/asset', assetController);
cachingDemoRouter.get('/demo/caching/query', queryController);
cachingDemoRouter.post('/demo/caching/invalidate', invalidateController);
cachingDemoRouter.get('/demo/caching/stats', statsController);
cachingDemoRouter.get('/demo/caching/stampede', stampedeController);
