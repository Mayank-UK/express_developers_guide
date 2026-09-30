import { Router, type Request, type Response } from 'express';
import { listSessions } from '../../domain/auth/session_store.js';
import { getDemoJobQueue } from '../../domain/jobs/job_queue.js';
// Deliberate teaching exception (the dependency rule is presentation → domain
// ← data; same note as db_demo_routes.ts): the statelessness inventory reads
// the optional shared stores' availability flags directly — WHICH store lives
// WHERE is the lesson itself.
import { isMongoConfigured } from '../../data/mongo/mongo_client.js';
import { isRedisConfigured } from '../../data/redis/redis_client.js';
import { getTickerConnectionCount } from './sse_demo_routes.js';
import {
  HANDMADE_PING_LIMIT,
  HANDMADE_PING_WINDOW_MS,
  SECURITY_PING_LIMIT,
  SECURITY_PING_WINDOW_MS,
} from './security_demo_routes.js';

/**
 * Scaling demo endpoints (the `scaling` topic's live surface).
 *
 * GET /api/demo/scaling/state → the PROCESS-STATE INSPECTOR: this endpoint
 * inventories THIS app's own statelessness, with LIVE counts measured from
 * the running process — the session store's current size, the job queue's
 * depth, the SSE feed's open connections — each hazard tagged with its
 * breaks-scaling verdict and the fix that relocates it, beside the stores
 * that are already shared (mongo, redis) or single-writer (sqlite).
 *
 * The point is honesty over theater: every number is read from the real
 * module state the app actually serves requests with. The rate limiters'
 * window Maps are deliberately private to their own module (nothing outside
 * security_demo_routes.ts can read them), so their entry reports the
 * CONFIGURED windows and says so — a not-exposed note, never a fake count.
 *
 * Mounted under /api by src/app.ts (the sibling demo routers' convention):
 * the router registers /demo/scaling/…, the full path is /api/demo/scaling/….
 */

export const SCALING_DEMO_MOUNT_PATH = '/api/demo/scaling';

/** A piece of per-process state that horizontal scaling would strand. */
export interface StatefulItem {
  readonly name: string;
  /** LIVE count from the running process; null when the owning module keeps it private (see countNote). */
  readonly count: number | null;
  /** Why count is null (or what it means) — always present when count is null. */
  readonly countNote?: string;
  /** True = real, mounted middleware (reported for the not-exposed case). */
  readonly configured?: boolean;
  /** What the not-countable item is configured to do (reported for the not-exposed case). */
  readonly configuration?: string;
  readonly shared: false;
  readonly breaksScaling: true;
  readonly where: string;
  readonly fix: string;
}

/** State that is already shared (or single-writer by design) — safe to replicate the APP around. */
export interface SharedItem {
  readonly name: string;
  /** How it is shared: a boolean, or a string describing the mechanism. */
  readonly shared: boolean | string;
  /** Is the optional service configured in this process right now? */
  readonly configured: boolean;
  readonly note: string;
}

export interface ScalingStateResponse {
  process: {
    pid: number;
    uptimeSeconds: number;
    replicas: 1;
    note: string;
  };
  stateful: StatefulItem[];
  statelessOrShared: SharedItem[];
  verdict: string;
}

function stateController(_req: Request, res: Response): void {
  // LIVE reads — every count is measured at request time from the real
  // module state this process serves with. listSessions() sweeps expired
  // entries first, so the session count is the honest "active right now".
  const sessionCount = listSessions().length;
  const queuedJobs = getDemoJobQueue().stats().queued;
  const sseConnections = getTickerConnectionCount();

  const stateful: StatefulItem[] = [
    {
      name: 'sessions',
      count: sessionCount,
      shared: false,
      breaksScaling: true,
      where: 'domain/auth/session_store.ts — an in-memory Map',
      fix: 'redis session store (SETEX + TTL) — the redis topic\u2019s structures',
    },
    {
      name: 'rate limiter counters',
      count: null,
      countNote:
        'the limiters\u2019 window Maps are module-private in security_demo_routes.ts — size is deliberately not exposed; the configured windows below are the honest report',
      configured: true,
      configuration: `handmade ${String(HANDMADE_PING_LIMIT)} per ${String(Math.ceil(HANDMADE_PING_WINDOW_MS / 1000))}s + express-rate-limit ${String(SECURITY_PING_LIMIT)} per ${String(Math.ceil(SECURITY_PING_WINDOW_MS / 1000))}s (per-instance budgets: N replicas = N\u00d7)`,
      shared: false,
      breaksScaling: true,
      where: 'presentation/routes/security_demo_routes.ts — two mounted limiters',
      fix: 'redis-backed counters (rate-limit-redis) so the budget is GLOBAL, not per-instance \u00d7 N',
    },
    {
      name: 'job queue',
      count: queuedJobs,
      shared: false,
      breaksScaling: true,
      where: 'domain/jobs/job_queue.ts — an in-process queue (depth reported; jobs live and die with the worker)',
      fix: 'a shared broker (redis lists/streams or a real queue service) — the jobs topic\u2019s contract is the spec',
    },
    {
      name: 'SSE connections',
      count: sseConnections,
      shared: false,
      breaksScaling: true,
      where: 'presentation/routes/sse_demo_routes.ts — open sockets in THIS process\u2019s registry',
      fix: 'sticky sessions for the socket + redis pub/sub so any replica can feed the feed',
    },
  ];

  const statelessOrShared: SharedItem[] = [
    {
      name: 'posts (sqlite)',
      shared: 'filesystem volume (one file, one writer)',
      configured: true,
      note: 'single-writer ok — NOT multi-replica: two writers on one shared mount is the classic corruption setup; scale reads via copies/replicas',
    },
    {
      name: 'mongo events',
      shared: true,
      configured: isMongoConfigured(),
      note: 'externalized state — every replica reaches the same store (the optional-service client pattern)',
    },
    {
      name: 'redis cache',
      shared: true,
      configured: isRedisConfigured(),
      note: 'shared cache AND the landing spot for the hazards above; when REDIS_URL is unset the caching demo falls back to a per-process Map (hazard #5, reported honestly there)',
    },
  ];

  const hazards = stateful.length;
  res.json({
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      replicas: 1,
      note: 'this endpoint measures ITS OWN process — behind a load balancer, each replica reports a different pid (and different counts): two browser tabs on two replicas would DISAGREE',
    },
    stateful,
    statelessOrShared,
    verdict: `This process holds ${String(hazards)} scaling hazards — the fix column shows the way out`,
  });
}

export const scalingDemoRouter = Router();
scalingDemoRouter.get('/demo/scaling/state', stateController);
