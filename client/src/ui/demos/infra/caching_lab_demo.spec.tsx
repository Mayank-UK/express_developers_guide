import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CachingLabDemo from './caching_lab_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ASSET_URL = '/api/demo/caching/asset';
const ASSET_IMMUTABLE_URL = '/api/demo/caching/asset?version=immutable';
const QUERY_URL = '/api/demo/caching/query';
const STATS_URL = '/api/demo/caching/stats';
const INVALIDATE_URL = '/api/demo/caching/invalidate';
const STAMPEDE_NAIVE_URL = '/api/demo/caching/stampede?singleflight=0';
const STAMPEDE_SINGLEFLIGHT_URL = '/api/demo/caching/stampede?singleflight=1';

const ETAG = '"2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"';
const REVALIDATE_POLICY = 'public, max-age=0, must-revalidate';
const IMMUTABLE_POLICY = 'public, max-age=31536000, immutable';
const ASSET_BODY = JSON.stringify({
  kind: 'posts-report',
  postCount: 3,
  totalWords: 120,
  posts: [],
});

/** A minimal text+headers Response stand-in (same contract as fetch_stub's). */
function textLike(status: number, text: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string): string | null => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

function jsonLike(body: unknown, status = 200) {
  return textLike(status, JSON.stringify(body));
}

describe('CachingLabDemo — panel 1: the etag asset and the 304 round-trip', () => {
  it('fetch → 200 with etag + policy; revalidate → 304 with zero bytes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === ASSET_URL) {
        // The conditional call carries the STORED etag — answer 304, no body.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers['If-None-Match'] !== undefined) {
          return textLike(304, '', { etag: ETAG, 'cache-control': REVALIDATE_POLICY });
        }
        return textLike(200, ASSET_BODY, { etag: ETAG, 'cache-control': REVALIDATE_POLICY });
      }
      if (url === STATS_URL) {
        return jsonLike({ store: 'memory', hits: 0, misses: 0, hitRate: 0, note: '', entries: [] });
      }
      return jsonLike({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CachingLabDemo />);

    // The revalidate button is inert until an etag is held.
    expect(screen.getByTestId('caching-asset-revalidate')).toBeDisabled();

    fireEvent.click(screen.getByTestId('caching-asset-fetch'));
    const first = await screen.findByTestId('caching-asset-result');
    expect(screen.getByTestId('caching-asset-status')).toHaveTextContent('200');
    expect(screen.getByTestId('caching-asset-etag')).toHaveTextContent(ETAG);
    expect(screen.getByTestId('caching-asset-cache-control')).toHaveTextContent('must-revalidate');
    expect(screen.getByTestId('caching-asset-bytes')).not.toHaveTextContent('0 bytes');
    expect(first).toHaveTextContent('3 posts');

    // The conditional fetch replays the held etag in If-None-Match.
    fireEvent.click(screen.getByTestId('caching-asset-revalidate'));
    const revalidated = await screen.findByTestId('caching-asset-status');
    expect(revalidated).toHaveTextContent('304');
    expect(screen.getByTestId('caching-asset-bytes')).toHaveTextContent('0 bytes');
    expect(screen.getByTestId('caching-asset-bytes')).toHaveTextContent('did not cross the wire');
    expect(screen.getByTestId('caching-asset-etag')).toHaveTextContent(ETAG); // same validator

    const conditionalCall = fetchMock.mock.calls.find(
      ([, init]) => (init?.headers as Record<string, string> | undefined)?.['If-None-Match'] !== undefined,
    );
    expect(conditionalCall?.[0]).toBe(ASSET_URL);
    expect((conditionalCall?.[1]?.headers as Record<string, string>)['If-None-Match']).toBe(ETAG);
  });

  it('the immutable toggle shows the hashed-asset policy', async () => {
    stubApiFetch([
      {
        url: ASSET_IMMUTABLE_URL,
        status: 200,
        text: ASSET_BODY,
        headers: { etag: ETAG, 'cache-control': IMMUTABLE_POLICY },
      },
      { url: STATS_URL, body: { store: 'memory', hits: 0, misses: 0, hitRate: 0, note: '', entries: [] } },
    ]);

    render(<CachingLabDemo />);
    fireEvent.click(screen.getByTestId('caching-asset-immutable-toggle'));
    fireEvent.click(screen.getByTestId('caching-asset-fetch'));

    const policy = await screen.findByTestId('caching-asset-cache-control');
    expect(policy).toHaveTextContent('max-age=31536000');
    expect(policy).toHaveTextContent('immutable');
  });
});

describe('CachingLabDemo — panel 2: cache-aside miss → hit → invalidate → miss', () => {
  function stubSequence(): ReturnType<typeof vi.fn> {
    let queryCalls = 0;
    let invalidated = false;
    let hits = 0;
    let misses = 0;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === QUERY_URL) {
        queryCalls += 1;
        // call 1: miss (origin); call 2: hit (cache); call 3: post-invalidate miss.
        const hit = queryCalls === 2;
        if (hit) hits += 1;
        else misses += 1;
        return jsonLike({
          source: hit ? 'cache' : 'origin',
          ms: hit ? 1 : 152,
          store: 'memory',
          hits,
          misses,
          hitRate: hits + misses === 0 ? 0 : hits / (hits + misses),
          report: { postCount: 3 },
        });
      }
      if (url === INVALIDATE_URL && init?.method === 'POST') {
        invalidated = true;
        return jsonLike({ key: 'guide:cache:posts-report', invalidated: true, store: 'memory' });
      }
      if (url === STATS_URL) {
        return jsonLike({
          store: 'memory',
          hits,
          misses,
          hitRate: hits + misses === 0 ? 0 : hits / (hits + misses),
          note: 'per-process ONLY',
          entries: invalidated ? [] : [{ key: 'guide:cache:posts-report', ttlSecondsRemaining: 57 }],
        });
      }
      return jsonLike({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
    });
  }

  it('the source badge and counters walk the full lifecycle', async () => {
    const fetchMock = stubSequence();
    vi.stubGlobal('fetch', fetchMock);

    render(<CachingLabDemo />);

    // Mount: stats load — the store chip names the honest fallback store.
    expect(await screen.findByTestId('caching-store-chip')).toHaveTextContent('store: memory');
    expect(screen.getByTestId('caching-stats-hitrate')).toHaveTextContent('hit rate 0%');

    // 1st query — MISS: origin, ~150ms, misses 1.
    fireEvent.click(screen.getByTestId('caching-query-run'));
    expect(await screen.findByTestId('caching-query-source')).toHaveTextContent('origin');
    expect(screen.getByTestId('caching-query-ms')).toHaveTextContent('152ms');
    expect(screen.getByTestId('caching-stats-hits')).toHaveTextContent('hits 0');
    expect(screen.getByTestId('caching-stats-misses')).toHaveTextContent('misses 1');

    // 2nd query — HIT: cache, ~instant, hit rate 50%.
    fireEvent.click(screen.getByTestId('caching-query-run'));
    expect(await screen.findByTestId('caching-query-source')).toHaveTextContent('cache');
    expect(screen.getByTestId('caching-stats-hits')).toHaveTextContent('hits 1');
    expect(screen.getByTestId('caching-stats-hitrate')).toHaveTextContent('hit rate 50%');

    // Invalidate — POST, then the note says the next query rebuilds.
    fireEvent.click(screen.getByTestId('caching-query-invalidate'));
    expect(await screen.findByTestId('caching-invalidate-result')).toHaveTextContent('key deleted');
    const postCall = fetchMock.mock.calls.find(([url, init]) => url === INVALIDATE_URL && init?.method === 'POST');
    expect(postCall).toBeDefined();

    // 3rd query — MISS again: the delete visibly returned the key to origin.
    fireEvent.click(screen.getByTestId('caching-query-run'));
    expect(await screen.findByTestId('caching-query-source')).toHaveTextContent('origin');
    expect(screen.getByTestId('caching-stats-misses')).toHaveTextContent('misses 2');
  });

  it('the store chip flips to redis when the server says so', async () => {
    stubApiFetch([
      { url: STATS_URL, body: { store: 'redis', hits: 4, misses: 1, hitRate: 0.8, note: 'SHARED', entries: [] } },
    ]);

    render(<CachingLabDemo />);
    expect(await screen.findByTestId('caching-store-chip')).toHaveTextContent('store: redis');
    expect(screen.getByTestId('caching-stats-hitrate')).toHaveTextContent('hit rate 80%');
  });
});

describe('CachingLabDemo — panel 3: the stampede comparison', () => {
  it('renders 10 origin calls (naive) vs 1 (single-flight) side by side', async () => {
    stubApiFetch([
      { url: STATS_URL, body: { store: 'memory', hits: 0, misses: 0, hitRate: 0, note: '', entries: [] } },
      {
        url: STAMPEDE_NAIVE_URL,
        body: {
          mode: 'naive',
          parallel: 10,
          originCalls: 10,
          totalMs: 1543,
          perCall: Array.from({ length: 10 }, (_, index) => ({ ms: 150 + index * 140, source: 'origin' })),
        },
      },
      {
        url: STAMPEDE_SINGLEFLIGHT_URL,
        body: {
          mode: 'singleflight',
          parallel: 10,
          originCalls: 1,
          totalMs: 158,
          perCall: Array.from({ length: 10 }, () => ({ ms: 155, source: 'origin' })),
        },
      },
    ]);

    render(<CachingLabDemo />);
    await screen.findByTestId('caching-stats');

    fireEvent.click(screen.getByTestId('caching-stampede-naive'));
    expect(await screen.findByTestId('caching-stampede-naive-result-origincalls')).toHaveTextContent('10');
    expect(screen.getByTestId('caching-stampede-naive-result-totalms')).toHaveTextContent('1543ms');

    // Before the second run, the single-flight card has no number yet.
    expect(screen.getByTestId('caching-stampede-singleflight-result')).toHaveTextContent('not run yet');

    fireEvent.click(screen.getByTestId('caching-stampede-singleflight'));
    expect(await screen.findByTestId('caching-stampede-singleflight-result-origincalls')).toHaveTextContent('1');

    // Both visible together + the comparison line.
    expect(screen.getByTestId('caching-stampede-naive-result-origincalls')).toHaveTextContent('10');
    expect(screen.getByTestId('caching-stampede-comparison')).toHaveTextContent('10 origin calls (naive) vs 1');

    // The per-call strip: ten chips each side.
    expect(screen.getAllByTestId('caching-stampede-naive-result-calls').length).toBe(1); // the container
    expect(screen.getByTestId('caching-stampede-naive-result-calls').children).toHaveLength(10);
    expect(screen.getByTestId('caching-stampede-singleflight-result-calls').children).toHaveLength(10);
  });
});

describe('CachingLabDemo — failure states', () => {
  it('every panel degrades to a reachable-server message, never a crash', async () => {
    stubNetworkFailure();
    render(<CachingLabDemo />);

    expect(await screen.findByTestId('caching-stats-failed')).toHaveTextContent('could not reach the server');

    fireEvent.click(screen.getByTestId('caching-asset-fetch'));
    expect(await screen.findByTestId('caching-asset-failed')).toHaveTextContent('could not reach the server');

    fireEvent.click(screen.getByTestId('caching-query-run'));
    expect(await screen.findByTestId('caching-query-failed')).toHaveTextContent('could not reach the server');

    fireEvent.click(screen.getByTestId('caching-query-invalidate'));
    expect(await screen.findByTestId('caching-invalidate-failed')).toHaveTextContent('could not reach the server');

    fireEvent.click(screen.getByTestId('caching-stampede-naive'));
    expect(await screen.findByTestId('caching-stampede-naive-result')).toHaveTextContent('could not reach the server');
  });
});
