/**
 * Hand-rolled request counters + a recent-duration ring — the observability
 * topic's "metrics without a framework" artifact. The request-logger
 * middleware is the ONLY writer (one started/settled pair per request);
 * GET /api/demo/obs/metrics is the only reader. prom-client would own this
 * job in a production app (the topic's catalog mention); the counters here
 * are small enough to be their own teaching exhibit.
 */

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export interface RequestMetricsSnapshot {
  /** Every request that settled (completed OR aborted), any status. */
  total: number;
  byStatusClass: Record<StatusClass, number>;
  /** Requests currently between start and settle — the concurrency gauge. */
  inFlight: number;
  /** Latency of the last 100 settled requests → p50/p95 (nearest-rank). */
  durations: { count: number; p50Ms: number | null; p95Ms: number | null };
}

const DURATIONS_CAPACITY = 100;

let total = 0;
let inFlight = 0;
const byStatusClass: Record<StatusClass, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
const recentDurations: number[] = [];

/** The request-logger middleware calls this before handing off to next(). */
export function requestStarted(): void {
  inFlight += 1;
}

/**
 * The same middleware calls this exactly once per request, from its 'finish'
 * (or aborting 'close') handler — the ONLY decrement path, so inFlight can
 * never leak on error responses or aborted connections.
 */
export function requestSettled(status: number, durationMs: number): void {
  inFlight = Math.max(0, inFlight - 1);
  total += 1;

  const statusClass = `${String(Math.floor(status / 100))}xx` as StatusClass;
  // This app never emits 1xx; anything weird simply does not bucket.
  if (statusClass in byStatusClass) byStatusClass[statusClass] += 1;

  if (Number.isFinite(durationMs) && durationMs >= 0) {
    recentDurations.push(durationMs);
    if (recentDurations.length > DURATIONS_CAPACITY) recentDurations.shift();
  }
}

/** Nearest-rank percentile over a sorted sample; null when nothing settled yet. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank - 1, sorted.length - 1)] ?? null;
}

export function snapshotRequestMetrics(): RequestMetricsSnapshot {
  // Copy + sort: the snapshot must not mutate the live ring mid-request.
  const sorted = [...recentDurations].sort((a, b) => a - b);
  return {
    total,
    byStatusClass: { ...byStatusClass },
    inFlight,
    durations: {
      count: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
    },
  };
}

/** Specs reset the counters so assertions see only the requests they fired. */
export function resetRequestMetricsForTests(): void {
  total = 0;
  inFlight = 0;
  byStatusClass['2xx'] = 0;
  byStatusClass['3xx'] = 0;
  byStatusClass['4xx'] = 0;
  byStatusClass['5xx'] = 0;
  recentDurations.length = 0;
}
