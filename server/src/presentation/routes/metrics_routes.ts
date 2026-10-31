import { Router, type Request, type Response } from 'express';
import { metricsRegistry } from '../../core/metrics/prometheus_metrics.js';

/**
 * Prometheus scrape surface — GET /metrics, served from the prom-client
 * registry core/metrics/prometheus_metrics.ts owns: the default process/
 * runtime metrics (event-loop delay, heap, GC, CPU) plus the
 * http_request_duration_seconds histogram the prometheus middleware feeds.
 *
 * Like the docs router (see docs_routes.ts) and unlike every API router,
 * this mounts on the ROOT app in src/app.ts, not under /api: /metrics is an
 * infrastructure-scrape convention (Prometheus defaults to it), and the VM
 * monitoring rollout scrapes the server directly — /metrics beside /api and
 * /docs is the same conventional split /docs already established.
 *
 * Thin controller (the health route's shape): it only sets the scrape
 * content type and streams the registry's text exposition. The body is NOT
 * JSON, so it must not go through res.json() — and the request logger still
 * access-logs the scrape like any other request.
 */
export const METRICS_PATH = '/metrics';

async function metricsController(_req: Request, res: Response): Promise<void> {
  // registry.metrics() renders the Prometheus text format (0.0.4) and
  // registry.contentType is its authoritative header — keeping the two
  // paired is exactly why the type comes from the registry, not a literal.
  res.set('Content-Type', metricsRegistry.contentType);
  res.status(200).send(await metricsRegistry.metrics());
}

export const metricsRouter = Router();
metricsRouter.get(METRICS_PATH, metricsController);
