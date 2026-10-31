import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * The prom-client registry this app's GET /metrics serves (presentation/
 * routes/metrics_routes.ts) — the production-metrics counterpart to the
 * observability topic's hand-rolled counters in core/logging/
 * request_metrics.ts. That exhibit teaches what a metrics library does for
 * you; this module is the real thing, exposed for infrastructure scrapes
 * (the VM monitoring rollout), not for the topic UI.
 *
 * Module-level singletons, exactly like the hand-rolled twin: ONE registry
 * and ONE default-metrics collection per process, created at module load and
 * never per request — so the numbers describe the process's whole life, the
 * same cumulative-since-boot framing request_metrics.ts keeps.
 */
export const metricsRegistry = new Registry();

// Default metrics (prefix defaults: process_* for the Node process, nodejs_*
// for the runtime): event-loop delay + utilization, heap + GC activity, CPU,
// open handles/requests. The guide's observability topic revisits exactly
// these dimensions by hand; here prom-client collects them every 10s (its
// default) in the background.
collectDefaultMetrics({ register: metricsRegistry });

/**
 * The one custom series: HTTP request duration. The prometheus middleware
 * (presentation/middleware/prometheus_middleware.ts) is the ONLY writer —
 * one observation per settled request, mirroring the request logger's
 * started/settled discipline.
 *
 * Buckets span 5ms → 10s: this app's routes are demo-scale (sub-100ms almost
 * always; the SSE stream and the deliberate slow exhibits live above it), so
 * the classic web buckets give useful p50/p95/p99 walls without metric spam.
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds, by method, route pattern, and status code.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/** Everything the middleware knows at settle time — and nothing else. */
export interface HttpDurationLabels {
  readonly method: string;
  /** The route PATTERN (e.g. /api/health), or 'unmatched' — never a raw path. */
  readonly route: string;
  readonly status: number;
}

/**
 * Record one settled request. The duration guard keeps a reordered chain
 * (or a synthetic call with a bogus stamp) from poisoning the buckets —
 * same defensive posture as requestSettled()'s durationMs check.
 */
export function observeHttpDuration(labels: HttpDurationLabels, durationSeconds: number): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;
  httpRequestDuration.observe(labels, durationSeconds);
}

/** Specs reset the series so assertions see only the requests they fired. */
export function resetHttpDurationForTests(): void {
  httpRequestDuration.reset();
}
