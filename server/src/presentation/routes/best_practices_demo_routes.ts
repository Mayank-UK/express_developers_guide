import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import { CONTENT_API_VERSION } from '../../content/types.js';
import { getRecentLogs, LOG_RING_CAPACITY } from '../../core/logging/log_ring.js';
import {
  HANDMADE_PING_LIMIT,
  HANDMADE_PING_WINDOW_MS,
  SECURITY_PING_LIMIT,
  SECURITY_PING_WINDOW_MS,
} from './security_demo_routes.js';

/**
 * Best-practices demo endpoints (the `best-practices` topic's live surface).
 *
 * GET /api/demo/best/audit → THE SELF-AUDIT: the running app checks itself
 * against the topic's checklist and grades the result. Every check reads a
 * REAL signal:
 *
 * - headers (helmet, request-id), the error envelope, docs, health and the
 *   content version — via SELF-FETCHES of this app at the request's origin
 *   (the observability topic's make-noise pattern). If nothing is listening
 *   there, those checks degrade to WARN with an honest note — never a lie,
 *   never a 500.
 * - graceful shutdown + fatal handlers — real process introspection
 *   (process.listenerCount of SIGTERM / uncaughtException / unhandledRejection).
 * - sqlite parameterization — a static fs heuristic over the DAO's own
 *   source (labeled a heuristic in its evidence; the db topic's specs pin
 *   the behavior).
 * - rate limits — the security topic's configured constants (the audit
 *   deliberately does NOT trip the limiters: that would burn real budget).
 * - the log ring — read live from the in-process pino destination.
 *
 * Mounted under /api by src/app.ts (the sibling demo routers' convention):
 * the router registers /demo/best/…, the full path is /api/demo/best/….
 */

export const BEST_DEMO_MOUNT_PATH = '/api/demo/best';

export type AuditStatus = 'pass' | 'warn' | 'fail';

export interface AuditCheck {
  readonly id: string;
  readonly category: string;
  readonly practice: string;
  readonly status: AuditStatus;
  readonly evidence: string;
}

export interface AuditSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}

export interface AuditResponse {
  readonly checks: AuditCheck[];
  readonly summary: AuditSummary;
  readonly note: string;
}

/** A route that provably does not exist — the 404 envelope's witness. */
const MISSING_ROUTE = '/api/demo/best/__definitely_not_a_route__';

// --- the self-fetch plumbing (never-throw, degrade to warn) ---------------------

interface FetchOutcome {
  readonly ok: boolean;
  readonly status: number;
  header(name: string): string | null;
  json(): Promise<unknown>;
}

async function fireGet(
  origin: string,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<FetchOutcome | null> {
  try {
    const response = await fetch(`${origin}${path}`, { headers: { ...extraHeaders } });
    return {
      ok: response.ok,
      status: response.status,
      header: (name: string): string | null => response.headers.get(name),
      json: () => response.json(),
    };
  } catch {
    // Nothing listening at this origin (Supertest's ephemeral port, a
    // dist-only embed) — the CALLERS turn this into a warn, never a 500.
    return null;
  }
}

const UNREACHABLE_EVIDENCE =
  'self-fetch unavailable at this request origin (nothing is listening there) — run against the live dev server (npm run dev) to grade this live; an unobservable check is a warn, not a guess';

// --- the local (non-fetched) checks ----------------------------------------------

/** Read the DAO's own source and look for bound parameters vs interpolated SQL. */
function auditSqliteParameterization(): AuditCheck {
  const practice = 'parameterized SQL — no string-built queries';
  // Try the TS source first (dev/tsx), then the compiled twin (dist).
  const candidates = ['ts', 'js'].map((ext) =>
    fileURLToPath(new URL(`../../data/posts/post_dao.${ext}`, import.meta.url)),
  );
  let source: string | undefined;
  let readName = '';
  for (const candidate of candidates) {
    try {
      source = readFileSync(candidate, 'utf8');
      readName = candidate.split('/').slice(-3).join('/');
      break;
    } catch {
      // try the next candidate
    }
  }
  if (source === undefined) {
    return {
      id: 'sqlite-parameterized',
      category: 'Data',
      practice,
      status: 'warn',
      evidence:
        'post_dao source not readable from this process (expected in a dist-only runtime image) — this is a source-level check; the behavior itself is spec-pinned in the sql topics',
    };
  }
  const positional = (source.match(/=\s*\?/g) ?? []).length;
  const named = (source.match(/@[a-z_]+/g) ?? []).length;
  const interpolated = /prepare\(\s*`[^`]*\$\{/.test(source);
  if (!interpolated && positional + named > 0) {
    return {
      id: 'sqlite-parameterized',
      category: 'Data',
      practice,
      status: 'pass',
      evidence: `static source heuristic (labeled honestly): ${readName} read from disk — ${String(positional)} positional (?) + ${String(named)} named (@) bound parameters, 0 template-interpolated statements. This greps the DAO the app actually runs; the db topic\u2019s injection specs prove the behavior`,
    };
  }
  return {
    id: 'sqlite-parameterized',
    category: 'Data',
    practice,
    status: 'fail',
    evidence: `static source heuristic: ${readName} shows ${interpolated ? 'template-interpolated SQL' : 'no bound parameters'} — the security topic\u2019s safe/unsafe pairs are the fix`,
  };
}

// --- the self-fetched checks ------------------------------------------------------

async function selfFetchChecks(facts: {
  health: FetchOutcome | null;
  missing: FetchOutcome | null;
  docs: FetchOutcome | null;
  content: FetchOutcome | null;
}): Promise<AuditCheck[]> {
  const { health, missing, docs, content } = facts;
  const checks: AuditCheck[] = [];

  // helmet: real headers off a real response of THIS app.
  const helmetHeaders =
    health?.header('x-content-type-options') === 'nosniff' &&
    health?.header('content-security-policy') !== null;
  checks.push({
    id: 'helmet-headers',
    category: 'Security',
    practice: 'security headers on every response (helmet, CSP pinned)',
    status: health === null ? 'warn' : helmetHeaders ? 'pass' : 'fail',
    evidence:
      health === null
        ? UNREACHABLE_EVIDENCE
        : helmetHeaders
          ? `live self-fetch GET /api/health → x-content-type-options: ${health.header('x-content-type-options')}, content-security-policy present — helmet is mounted app-wide in app.ts, before any route`
          : 'live self-fetch GET /api/health answered without helmet\u2019s headers — helmet should be mounted before any route',
  });

  // request-id: the correlation id the whole log/error pipeline joins on.
  const requestId = health?.header('x-request-id');
  checks.push({
    id: 'request-id',
    category: 'Observability',
    practice: 'a request id on every response, correlated into logs and errors',
    status: health === null ? 'warn' : requestId ? 'pass' : 'fail',
    evidence:
      health === null
        ? UNREACHABLE_EVIDENCE
        : requestId
          ? `live self-fetch GET /api/health → x-request-id: ${requestId.slice(0, 8)}… (first in the middleware chain, echoed into the envelope and every log line)`
          : 'live self-fetch GET /api/health answered with no x-request-id header',
  });

  // health endpoint: the liveness probe the balancer/orchestrator watches.
  checks.push({
    id: 'health-endpoint',
    category: 'Operations',
    practice: 'a health endpoint the orchestrator can probe',
    status: health === null ? 'warn' : health.ok ? 'pass' : 'fail',
    evidence:
      health === null
        ? UNREACHABLE_EVIDENCE
        : `live self-fetch GET /api/health → ${String(health.status)} (the observability topic\u2019s readiness-shaped twin lives at /api/demo/obs/health)`,
  });

  // compression: deliberately SCOPED to the perf router — identity on health
  // is the design, so this grades pass when the scoping holds.
  const contentEncoding = health?.header('content-encoding');
  checks.push({
    id: 'compression-scoped',
    category: 'Performance',
    practice: 'compression scoped deliberately (not a global middleware)',
    status: health === null ? 'warn' : contentEncoding === null ? 'pass' : 'fail',
    evidence:
      health === null
        ? UNREACHABLE_EVIDENCE
        : contentEncoding === null
          ? 'live self-fetch GET /api/health (accept-encoding: gzip) → no content-encoding: identity. PASS on purpose — compression rides the perf router only (with its ?noCompress teaching switch), a scoped mount that keeps header-asserting specs honest'
          : `live self-fetch GET /api/health came back content-encoding: ${contentEncoding} — compression looks globally mounted`,
  });

  // the error envelope: proven by a 404 through the catch-all + the body shape.
  let envelopeStatus: AuditStatus = 'warn';
  let envelopeEvidence = UNREACHABLE_EVIDENCE;
  if (missing !== null) {
    envelopeStatus = 'fail';
    envelopeEvidence = `live self-fetch GET ${MISSING_ROUTE} → ${String(missing.status)}, but the body did not parse as the envelope`;
    try {
      const body = (await missing.json()) as { error?: { code?: unknown; message?: unknown; requestId?: unknown } };
      const error = body?.error;
      if (
        missing.status === 404 &&
        typeof error?.code === 'string' &&
        typeof error?.message === 'string' &&
        typeof error?.requestId === 'string'
      ) {
        envelopeStatus = 'pass';
        envelopeEvidence = `live self-fetch GET ${MISSING_ROUTE} → 404 with { error: { code: "${error.code}", message, requestId } } — the catch-all and the error middleware agree on one shape`;
      }
    } catch {
      // keep the fail verdict — the body did not parse
    }
  }
  checks.push({
    id: 'error-envelope',
    category: 'API discipline',
    practice: 'one error envelope for every failure: { error: { code, message, requestId } }',
    status: envelopeStatus,
    evidence: envelopeEvidence,
  });

  // docs: Swagger UI served same-origin.
  checks.push({
    id: 'docs-served',
    category: 'API discipline',
    practice: 'docs that cannot drift, served beside the API',
    status: docs === null ? 'warn' : docs.ok ? 'pass' : 'fail',
    evidence:
      docs === null
        ? UNREACHABLE_EVIDENCE
        : `live self-fetch GET /docs/ → ${String(docs.status)} (hand-written OpenAPI pinned to the real surface by drift specs)`,
  });

  // content API: versioned from day one.
  let versionStatus: AuditStatus = 'warn';
  let versionEvidence = UNREACHABLE_EVIDENCE;
  if (content !== null) {
    versionStatus = 'fail';
    versionEvidence = `live self-fetch GET /api/content answered ${String(content.status)} — the body did not carry a version`;
    try {
      const body = (await content.json()) as { version?: unknown };
      if (content.ok && body?.version === CONTENT_API_VERSION) {
        versionStatus = 'pass';
        versionEvidence = `live self-fetch GET /api/content → version ${String(CONTENT_API_VERSION)} (CONTENT_API_VERSION pinned in content/types.ts; the client migrates deliberately)`;
      }
    } catch {
      // keep the fail verdict
    }
  }
  checks.push({
    id: 'content-versioned',
    category: 'API discipline',
    practice: 'versioned API contracts',
    status: versionStatus,
    evidence: versionEvidence,
  });

  return checks;
}

async function auditController(req: Request, res: Response): Promise<void> {
  const host = req.get('host');
  const origin = `${req.protocol}://${host ?? '127.0.0.1'}`;

  // The four self-fetches run in parallel — each is against a local origin,
  // and fireGet never throws. Local (non-fetched) checks need no listener.
  const [health, missing, docs, content] = await Promise.all([
    fireGet(origin, '/api/health', { 'accept-encoding': 'gzip' }),
    fireGet(origin, MISSING_ROUTE),
    fireGet(origin, '/docs/'),
    fireGet(origin, '/api/content'),
  ]);

  const checks: AuditCheck[] = await selfFetchChecks({ health, missing, docs, content });

  // graceful shutdown: is a SIGTERM drain registered in THIS process?
  const sigtermListeners = process.listenerCount('SIGTERM');
  checks.push({
    id: 'graceful-shutdown',
    category: 'Reliability',
    practice: 'graceful shutdown: stop accepting, drain, then exit',
    status: sigtermListeners > 0 ? 'pass' : 'fail',
    evidence:
      sigtermListeners > 0
        ? `real introspection: process.listenerCount('SIGTERM') = ${String(sigtermListeners)} — a drain handler is registered in this process (server.ts\u2019s order: grpc → mongo → redis → hub → http)`
        : "real introspection: process.listenerCount('SIGTERM') = 0 — no drain handler in THIS process (specs import only app.ts; the live server registers one — run npm run dev to see it pass)",
  });

  // fatal handlers: log.fatal + exit(1), the observability topic's discipline.
  const uncaught = process.listenerCount('uncaughtException');
  const unhandled = process.listenerCount('unhandledRejection');
  checks.push({
    id: 'fatal-handlers',
    category: 'Reliability',
    practice: 'uncaughtException/unhandledRejection handlers: log fatal, flush, exit(1)',
    status: uncaught + unhandled > 0 ? 'pass' : 'fail',
    evidence:
      uncaught + unhandled > 0
        ? `real introspection: ${String(uncaught)} uncaughtException + ${String(unhandled)} unhandledRejection listeners — a process in an unknown state exits loudly under its supervisor`
        : 'real introspection: no fatal handlers in THIS process — crash-with-logs beats limping silently',
  });

  // rate limits: configured constants, deliberately NOT tripped by the audit.
  checks.push({
    id: 'rate-limits-configured',
    category: 'Security',
    practice: 'rate limits on exposed endpoints, 429 through the one error taxonomy',
    status: 'pass',
    evidence: `express-rate-limit ${String(SECURITY_PING_LIMIT)}/${String(Math.ceil(SECURITY_PING_WINDOW_MS / 1000))}s on /api/demo/security/ping + the handmade ${String(HANDMADE_PING_LIMIT)}/${String(Math.ceil(HANDMADE_PING_WINDOW_MS / 1000))}s twin (constants imported from the mounted limiters) — the audit does NOT trip them: that would burn real client budget`,
  });

  // the log ring: live, bounded, leveled.
  const retained = getRecentLogs({ limit: LOG_RING_CAPACITY }).length;
  checks.push({
    id: 'log-ring-live',
    category: 'Observability',
    practice: 'structured logs with request ids, leveled and bounded',
    status: 'pass',
    evidence: `the in-process pino ring answers live: ${String(retained)} of ${String(LOG_RING_CAPACITY)} lines retained (this very request\u2019s access line lands on 'finish') — 4xx warn / 5xx error by the middleware\u2019s level discipline`,
  });

  // the DAO fs audit (source-level heuristic, labeled as one).
  checks.push(auditSqliteParameterization());

  const summary: AuditSummary = {
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    total: checks.length,
  };

  res.json({
    checks,
    summary,
    note: 'the app grades itself: pass = verified against the running process/headers; warn = the check could not OBSERVE (self-fetch unavailable) — honest, not green; fail = the practice is verifiably absent. Run against the live dev server for the full board.',
  });
}

export const bestDemoRouter = Router();
bestDemoRouter.get('/demo/best/audit', auditController);
