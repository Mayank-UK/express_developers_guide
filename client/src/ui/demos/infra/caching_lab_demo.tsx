import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `caching:lab` — the Caching topic's lab over the real
 * endpoints (caching_demo_routes.ts), in three panels:
 *
 * 1. HTTP CACHING — the deterministic asset with its sha256 etag: a plain
 *    fetch (200), a conditional fetch with If-None-Match (304 + zero bytes),
 *    and the immutable-mode toggle (max-age=31536000, immutable).
 * 2. CACHE-ASIDE — the query button driving miss → hit → invalidate → miss,
 *    with live hit/miss counters, a hit-rate bar, and the STORE chip that
 *    reports redis (shared) or memory (per-process) truthfully.
 * 3. STAMPEDE — naive (N parallel misses rebuild N times) vs single-flight
 *    (one rebuild, everyone awaits it), origin-calls as the big number.
 *
 * Works with or without the optional redis service — the store chip says
 * which world you are in.
 */

const ASSET_URL = '/api/demo/caching/asset';
const ASSET_IMMUTABLE_URL = '/api/demo/caching/asset?version=immutable';
const QUERY_URL = '/api/demo/caching/query';
const STATS_URL = '/api/demo/caching/stats';
const INVALIDATE_URL = '/api/demo/caching/invalidate';
const STAMPEDE_NAIVE_URL = '/api/demo/caching/stampede?singleflight=0';
const STAMPEDE_SINGLEFLIGHT_URL = '/api/demo/caching/stampede?singleflight=1';

interface QueryResult {
  source: 'origin' | 'cache';
  ms: number;
  store: string;
  hits: number;
  misses: number;
  hitRate: number;
  report: { postCount: number | null } | null;
}

interface StatsResult {
  store: string;
  hits: number;
  misses: number;
  hitRate: number;
  note: string;
  entries: { key: string; ttlSecondsRemaining: number | null }[];
}

interface StampedeResult {
  mode: string;
  parallel: number;
  originCalls: number;
  totalMs: number;
  perCall: { ms: number; source: string }[];
}

type AssetState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      conditional: boolean;
      status: number;
      etag: string | null;
      cacheControl: string | null;
      bytes: number;
      postCount: number | null;
    }
  | { kind: 'failed'; problem: string };

type QueryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: QueryResult }
  | { kind: 'failed'; problem: string };

type StatsState =
  | { kind: 'loading' }
  | { kind: 'ready'; stats: StatsResult }
  | { kind: 'failed'; problem: string };

type InvalidationState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; invalidated: boolean }
  | { kind: 'failed'; problem: string };

type StampedeState =
  | { kind: 'idle' }
  | { kind: 'loading'; mode: 'naive' | 'singleflight' }
  | { kind: 'ready'; result: StampedeResult }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') return response.text();
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

/** Parses an error envelope from an ALREADY-READ body text (bodies read once). */
function errorEnvelopeFromText(text: string): string {
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const error = (parsed.value as Record<string, unknown>).error;
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return `${record.code}: ${record.message}`;
    }
  }
  return text;
}

/**
 * Fetches a URL and returns { status, headers, bodyText } in ONE body read —
 * real Response bodies can only be consumed once, so every path shares this.
 */
async function fetchOnce(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; etag: string | null; cacheControl: string | null; bodyText: string }> {
  const response = await fetch(url, init);
  const bodyText = await readBodyText(response);
  // Defensive header access: every real Response carries headers, but a
  // degraded transport (or a stub) may not — missing means null, never a crash.
  const headers = (response as { headers?: { get?: (name: string) => string | null } }).headers;
  const read = (name: string): string | null =>
    typeof headers?.get === 'function' ? headers.get(name) : null;
  return {
    status: response.status,
    etag: read('etag'),
    cacheControl: read('cache-control'),
    bodyText,
  };
}

function parseQuery(value: unknown): QueryResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.source !== 'string' || typeof record.ms !== 'number') return null;
  const report =
    typeof record.report === 'object' && record.report !== null
      ? (record.report as { postCount?: unknown })
      : null;
  return {
    source: record.source === 'cache' ? 'cache' : 'origin',
    ms: record.ms,
    store: typeof record.store === 'string' ? record.store : '?',
    hits: typeof record.hits === 'number' ? record.hits : 0,
    misses: typeof record.misses === 'number' ? record.misses : 0,
    hitRate: typeof record.hitRate === 'number' ? record.hitRate : 0,
    report: report === null ? null : { postCount: typeof report.postCount === 'number' ? report.postCount : null },
  };
}

function parseStats(value: unknown): StatsResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.store !== 'string') return null;
  const entries = Array.isArray(record.entries)
    ? record.entries.filter(
        (raw): raw is { key: string; ttlSecondsRemaining: number | null } =>
          typeof raw === 'object' && raw !== null && typeof (raw as { key?: unknown }).key === 'string',
      )
    : [];
  return {
    store: record.store,
    hits: typeof record.hits === 'number' ? record.hits : 0,
    misses: typeof record.misses === 'number' ? record.misses : 0,
    hitRate: typeof record.hitRate === 'number' ? record.hitRate : 0,
    note: typeof record.note === 'string' ? record.note : '',
    entries,
  };
}

function parseStampede(value: unknown): StampedeResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.originCalls !== 'number' || typeof record.totalMs !== 'number') return null;
  const perCall = Array.isArray(record.perCall)
    ? record.perCall.filter(
        (raw): raw is { ms: number; source: string } =>
          typeof raw === 'object' && raw !== null && typeof (raw as { ms?: unknown }).ms === 'number',
      )
    : [];
  return {
    mode: typeof record.mode === 'string' ? record.mode : '?',
    parallel: typeof record.parallel === 'number' ? record.parallel : 0,
    originCalls: record.originCalls,
    totalMs: record.totalMs,
    perCall,
  };
}

/** The stampede panel renders BOTH runs side by side so the numbers compare. */
function StampedeRunCard({
  testId,
  label,
  state,
}: {
  testId: string;
  label: string;
  state: StampedeState;
}): ReactNode {
  return (
    <div data-testid={testId} className="flex flex-1 flex-col gap-xs rounded-md border border-outline p-sm">
      <p className="font-mono text-caption font-semibold text-on-surface">{label}</p>
      {state.kind === 'ready' && (
        <>
          <p className="font-mono text-heading-sm font-bold text-on-surface" data-testid={`${testId}-origincalls`}>
            {String(state.result.originCalls)}
          </p>
          <p className="text-caption text-on-surface-variant" data-testid={`${testId}-totalms`}>
            origin calls · {String(state.result.totalMs)}ms total
          </p>
          <div className="flex flex-wrap gap-xxs" data-testid={`${testId}-calls`}>
            {state.result.perCall.map((call, index) => (
              <span key={String(index)} className={CHIP}>
                {String(call.ms)}ms
              </span>
            ))}
          </div>
        </>
      )}
      {state.kind === 'idle' && (
        <p className="text-caption text-on-surface-variant">not run yet</p>
      )}
      {state.kind === 'loading' && (
        <p className="text-caption text-on-surface-variant" data-testid={`${testId}-loading`}>
          firing the parallel lookups ({state.mode})…
        </p>
      )}
      {state.kind === 'failed' && (
        <pre className={PRE}>{state.problem}</pre>
      )}
    </div>
  );
}

export default function CachingLabDemo(): ReactNode {
  const [immutableMode, setImmutableMode] = useState(false);
  const [assetState, setAssetState] = useState<AssetState>({ kind: 'idle' });
  const [heldEtag, setHeldEtag] = useState<string | null>(null);
  const [statsState, setStatsState] = useState<StatsState>({ kind: 'loading' });
  const [queryState, setQueryState] = useState<QueryState>({ kind: 'idle' });
  const [invalidationState, setInvalidationState] = useState<InvalidationState>({ kind: 'idle' });
  const [naiveState, setNaiveState] = useState<StampedeState>({ kind: 'idle' });
  const [singleFlightState, setSingleFlightState] = useState<StampedeState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // --- panel 1: HTTP caching --------------------------------------------------

  const fetchAsset = (conditional: boolean): void => {
    const url = immutableMode ? ASSET_IMMUTABLE_URL : ASSET_URL;
    setAssetState({ kind: 'loading' });
    void (async () => {
      try {
        // The conditional fetch replays the STORED etag — exactly what a
        // browser cache does internally on every revalidation.
        const { status, etag, cacheControl, bodyText } = await fetchOnce(
          url,
          conditional && heldEtag !== null ? { headers: { 'If-None-Match': heldEtag } } : undefined,
        );
        if (!aliveRef.current) return;

        if (status >= 400) {
          setAssetState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const postCount =
          parsed.ok &&
          typeof parsed.value === 'object' &&
          parsed.value !== null &&
          typeof (parsed.value as { postCount?: unknown }).postCount === 'number'
            ? ((parsed.value as { postCount: number }).postCount)
            : null;
        if (etag !== null && !conditional) setHeldEtag(etag);
        setAssetState({
          kind: 'ready',
          conditional,
          status,
          etag,
          cacheControl,
          bytes: bodyText.length,
          postCount,
        });
      } catch {
        if (aliveRef.current) {
          setAssetState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  // --- panel 2: cache-aside ---------------------------------------------------

  const loadStats = (): void => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(STATS_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setStatsState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const shaped = parsed.ok ? parseStats(parsed.value) : null;
        if (shaped === null) {
          setStatsState({ kind: 'failed', problem: 'unexpected stats payload' });
          return;
        }
        setStatsState({ kind: 'ready', stats: shaped });
      } catch {
        if (aliveRef.current) {
          setStatsState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  useEffect(() => {
    loadStats();
  }, []);

  const runQuery = (): void => {
    setQueryState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(QUERY_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setQueryState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const shaped = parsed.ok ? parseQuery(parsed.value) : null;
        if (shaped === null) {
          setQueryState({ kind: 'failed', problem: 'unexpected query payload' });
          return;
        }
        // The query response carries the same counters stats serves — keep
        // the panel numbers in lockstep without a second request.
        setQueryState({ kind: 'ready', result: shaped });
        setStatsState({
          kind: 'ready',
          stats: {
            store: shaped.store,
            hits: shaped.hits,
            misses: shaped.misses,
            hitRate: shaped.hitRate,
            note: '',
            entries: [],
          },
        });
      } catch {
        if (aliveRef.current) {
          setQueryState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const invalidate = (): void => {
    setInvalidationState({ kind: 'sending' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(INVALIDATE_URL, { method: 'POST' });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setInvalidationState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const invalidated =
          parsed.ok &&
          typeof parsed.value === 'object' &&
          parsed.value !== null &&
          (parsed.value as { invalidated?: unknown }).invalidated === true;
        setInvalidationState({ kind: 'done', invalidated });
        loadStats();
      } catch {
        if (aliveRef.current) {
          setInvalidationState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  // --- panel 3: stampede --------------------------------------------------------

  const runStampede = (mode: 'naive' | 'singleflight'): void => {
    const setter = mode === 'naive' ? setNaiveState : setSingleFlightState;
    setter({ kind: 'loading', mode });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(
          mode === 'naive' ? STAMPEDE_NAIVE_URL : STAMPEDE_SINGLEFLIGHT_URL,
        );
        if (!aliveRef.current) return;
        if (status >= 400) {
          setter({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const shaped = parsed.ok ? parseStampede(parsed.value) : null;
        if (shaped === null) {
          setter({ kind: 'failed', problem: 'unexpected stampede payload' });
          return;
        }
        setter({ kind: 'ready', result: shaped });
      } catch {
        if (aliveRef.current) {
          setter({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const ready = statsState.kind === 'ready' ? statsState.stats : null;
  const query = queryState.kind === 'ready' ? queryState.result : null;
  const storeIsRedis = (ready?.store ?? query?.store) === 'redis';
  const hitRatePercent = Math.round((query?.hitRate ?? ready?.hitRate ?? 0) * 100);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="caching-summary" className="text-body-sm text-on-surface">
        Both caching worlds over one deterministic payload: the etag asset with its conditional
        304 round-trip, the cache-aside query with live hit/miss counters over the store this
        process is actually using, and the stampede comparison — naive vs single-flight.
      </p>

      {/* 1 — HTTP caching */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">HTTP caching — etag + conditional requests</h3>
        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="caching-asset-fetch"
            onClick={() => fetchAsset(false)}
            disabled={assetState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            {assetState.kind === 'loading' ? 'fetching…' : 'fetch the asset'}
          </button>
          <button
            type="button"
            data-testid="caching-asset-revalidate"
            onClick={() => fetchAsset(true)}
            disabled={assetState.kind === 'loading' || heldEtag === null}
            className={BUTTON}
          >
            revalidate (If-None-Match)
          </button>
          <label className="flex items-center gap-xxs text-caption text-on-surface-variant">
            <input
              type="checkbox"
              data-testid="caching-asset-immutable-toggle"
              checked={immutableMode}
              onChange={(event) => setImmutableMode(event.target.checked)}
            />
            immutable mode (?version=immutable)
          </label>
        </div>

        {assetState.kind === 'failed' && (
          <pre data-testid="caching-asset-failed" className={PRE}>
            {assetState.problem}
          </pre>
        )}

        {assetState.kind === 'ready' && (
          <div data-testid="caching-asset-result" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span
                data-testid="caching-asset-status"
                className={assetState.status === 304 ? CHIP_OK : CHIP}
              >
                {String(assetState.status)} {assetState.status === 304 ? 'Not Modified' : 'OK'}
              </span>
              <span data-testid="caching-asset-bytes" className={assetState.status === 304 ? CHIP_OK : CHIP}>
                {String(assetState.bytes)} bytes{assetState.status === 304 ? ' — the body did not cross the wire' : ''}
              </span>
            </p>
            <p className="font-mono text-caption break-all" data-testid="caching-asset-etag">
              ETag: {assetState.etag ?? '(none)'}
            </p>
            <p className="font-mono text-caption break-all" data-testid="caching-asset-cache-control">
              Cache-Control: {assetState.cacheControl ?? '(none)'}
            </p>
            {assetState.postCount !== null && (
              <p className="text-caption text-on-surface-variant">
                a posts report ({String(assetState.postCount)} posts) — deterministic, so the same
                sha256 etag every fetch, restart, and process.
              </p>
            )}
          </div>
        )}
      </section>

      {/* 2 — cache-aside */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">Cache-aside — one key, live counters</h3>
          <span
            data-testid="caching-store-chip"
            className={storeIsRedis ? CHIP_OK : CHIP}
            title={ready?.note ?? ''}
          >
            store: {ready?.store ?? query?.store ?? '…'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="caching-query-run"
            onClick={runQuery}
            disabled={queryState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            {queryState.kind === 'loading' ? 'querying…' : 'run the query'}
          </button>
          <button
            type="button"
            data-testid="caching-query-invalidate"
            onClick={invalidate}
            disabled={invalidationState.kind === 'sending'}
            className={BUTTON}
          >
            {invalidationState.kind === 'sending' ? 'deleting…' : 'invalidate'}
          </button>
          <span className="text-caption text-on-surface-variant">
            miss → origin (~150ms), hit → cache (~0ms); after invalidate, the next query is a miss again
          </span>
        </div>

        {statsState.kind === 'failed' && (
          <pre data-testid="caching-stats-failed" className={PRE}>
            {statsState.problem}
          </pre>
        )}
        {queryState.kind === 'failed' && (
          <pre data-testid="caching-query-failed" className={PRE}>
            {queryState.problem}
          </pre>
        )}
        {invalidationState.kind === 'failed' && (
          <pre data-testid="caching-invalidate-failed" className={PRE}>
            {invalidationState.problem}
          </pre>
        )}

        {query !== null && (
          <p className="flex flex-wrap items-center gap-xs font-mono text-caption" data-testid="caching-query-result">
            <span data-testid="caching-query-source" className={query.source === 'cache' ? CHIP_OK : CHIP_ERROR}>
              {query.source}
            </span>
            <span data-testid="caching-query-ms" className={CHIP}>
              {String(query.ms)}ms
            </span>
          </p>
        )}

        {ready !== null && (
          <div data-testid="caching-stats" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span data-testid="caching-stats-hits" className={CHIP}>hits {String(ready.hits)}</span>
              <span data-testid="caching-stats-misses" className={CHIP}>misses {String(ready.misses)}</span>
              <span data-testid="caching-stats-hitrate" className={CHIP}>hit rate {String(hitRatePercent)}%</span>
            </p>
            <div className="h-3 w-full overflow-hidden rounded-md border border-outline bg-surface-variant">
              <div
                data-testid="caching-stats-hitrate-bar"
                className="h-full bg-primary transition-[width] duration-300"
                style={{ width: `${String(hitRatePercent)}%` }}
              />
            </div>
          </div>
        )}

        {invalidationState.kind === 'done' && (
          <p data-testid="caching-invalidate-result" className="font-mono text-caption text-on-surface">
            key deleted — the next query rebuilds from origin
          </p>
        )}
      </section>

      {/* 3 — stampede */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">Stampede — 10 parallel lookups, both ways</h3>
          <button
            type="button"
            data-testid="caching-stampede-naive"
            onClick={() => runStampede('naive')}
            disabled={naiveState.kind === 'loading'}
            className={BUTTON}
          >
            {naiveState.kind === 'loading' ? 'dogpiling…' : 'naive (dogpile)'}
          </button>
          <button
            type="button"
            data-testid="caching-stampede-singleflight"
            onClick={() => runStampede('singleflight')}
            disabled={singleFlightState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            {singleFlightState.kind === 'loading' ? 'deduplicating…' : 'single-flight'}
          </button>
        </div>

        <div className="flex flex-col gap-sm sm:flex-row">
          <StampedeRunCard testId="caching-stampede-naive-result" label="naive — every miss rebuilds" state={naiveState} />
          <StampedeRunCard testId="caching-stampede-singleflight-result" label="single-flight — one rebuild, nine awaiters" state={singleFlightState} />
        </div>

        {naiveState.kind === 'ready' && singleFlightState.kind === 'ready' && (
          <p data-testid="caching-stampede-comparison" className="text-caption text-on-surface-variant">
            {String(naiveState.result.originCalls)} origin calls (naive) vs{' '}
            {String(singleFlightState.result.originCalls)} (single-flight) — the same ten callers,
            the same key, one line of deduplication apart.
          </p>
        )}
      </section>
    </div>
  );
}
