import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';
import {
  DEMO_CALL_TIMEOUT_MS,
  FLAKY_LATENCIES_MS,
  FLAKY_MODES,
  getReliabilityDemoWorld,
  resetReliabilityDemoWorld,
  type FlakyMode,
} from '../../domain/reliability/flaky_service.js';
import type { CircuitTransition } from '../../domain/reliability/circuit_breaker.js';

/**
 * The reliability topic's live demo endpoints — the WATCHABLE CIRCUIT BREAKER:
 * a real CircuitBreaker (domain/reliability/circuit_breaker.ts) wrapping a
 * flaky dependency simulator you can steer, so the whole state machine is a
 * two-minute interactive story: trip it with failures, watch calls bounce off
 * the OPEN circuit in ~0ms, let the cooldown lapse, heal it with probes.
 *
 * - GET  /api/demo/reliability/status → breaker stats + flaky mode + the
 *                                        transition ring (the timeline) + the
 *                                        server-computed cooldown remaining
 * - POST /api/demo/reliability/mode    → { mode: 'healthy'|'failing'|'slow' }
 *                                        (the breaker KEEPS its state — you can
 *                                        open it, then heal it)
 * - POST /api/demo/reliability/call    → one call through the breaker:
 *                                        { outcome, ms, breakerState, … } —
 *                                        'rejected-fast' shows ms ≈ 0, the point
 * - POST /api/demo/reliability/reset   → a fresh breaker + healthy mode
 *
 * Error policy (deliberate, the gRPC-bridge pattern): a failed or rejected
 * call is a successful OBSERVATION and answers HTTP 200 with the outcome —
 * rendering the breaker doing its job as a 5xx would lie twice. Only a
 * malformed instruction (unknown mode) is a 400 envelope.
 *
 * Mounted under /api by src/app.ts (the sibling demo routers' convention):
 * the router registers /demo/reliability/…, the full path is /api/demo/reliability/….
 */

export const RELIABILITY_DEMO_MOUNT_PATH = '/api/demo/reliability';

function worldStatus() {
  const { breaker, flaky } = getReliabilityDemoWorld();
  const stats = breaker.stats();
  return {
    breaker: stats,
    cooldownRemainingMs: breaker.cooldownRemainingMs(),
    flaky: {
      mode: flaky.currentMode,
      modes: [...FLAKY_MODES],
      latenciesMs: FLAKY_LATENCIES_MS,
      timeoutMs: DEMO_CALL_TIMEOUT_MS,
    },
    // Newest first — the timeline renders top-down as it happens.
    history: [...breaker.history()].reverse().slice(0, 20) satisfies CircuitTransition[],
  };
}

function statusController(_req: Request, res: Response): void {
  res.json({
    ...worldStatus(),
    note: 'the breaker state machine is real: 3 consecutive failures open it, a 4s cooldown half-opens it, 2 successful probes close it. A slow dependency (800ms) breaches the 300ms deadline and counts as a failure.',
  });
}

function readModeBody(body: unknown): FlakyMode {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationException('the mode endpoint needs a JSON object body', {
      parameter: 'mode',
    });
  }
  const { mode } = body as Record<string, unknown>;
  if (typeof mode !== 'string' || !(FLAKY_MODES as readonly string[]).includes(mode)) {
    throw new ValidationException(
      `"mode" must be one of ${FLAKY_MODES.map((entry) => `"${entry}"`).join(', ')}`,
      { parameter: 'mode', received: mode, supported: [...FLAKY_MODES] },
    );
  }
  return mode as FlakyMode;
}

function modeController(req: Request, res: Response): void {
  const mode = readModeBody(req.body);
  const { flaky } = getReliabilityDemoWorld();
  flaky.setMode(mode);
  res.json({
    ...worldStatus(),
    note: 'the flaky dependency switched, but the breaker KEPT its state — open it with failures, switch to healthy, and heal it through half-open probes.',
  });
}

async function callController(_req: Request, res: Response): Promise<void> {
  const { breaker, flaky } = getReliabilityDemoWorld();
  const startedAt = performance.now();
  const result = await breaker.execute((signal) => flaky.call(signal));
  const ms = Math.round((performance.now() - startedAt) * 10) / 10;

  // Narrow once, up front — the outcome classification and the response both
  // read the same failure value.
  const callFailure = result.ok ? null : result.error;
  const outcome = result.ok
    ? 'success'
    : callFailure?.details?.rejectedFast === true
      ? 'rejected-fast'
      : 'failure';

  res.json({
    outcome,
    ms,
    breakerState: breaker.stats().state,
    cooldownRemainingMs: breaker.cooldownRemainingMs(),
    ...(result.ok
      ? { value: result.value }
      : { failure: callFailure }),
    note:
      outcome === 'rejected-fast'
        ? 'rejected in ~0ms — the dependency was never touched; this is the load being shed that lets it recover'
        : outcome === 'failure' && callFailure?.details?.timedOut === true
          ? 'the 300ms deadline expired before the 800ms dependency answered — timeouts trip breakers too'
          : undefined,
  });
}

function resetController(_req: Request, res: Response): void {
  resetReliabilityDemoWorld();
  res.json({
    ...worldStatus(),
    note: 'fresh breaker (CLOSED) and a healthy dependency.',
  });
}

export const reliabilityDemoRouter = Router();
reliabilityDemoRouter.get('/demo/reliability/status', statusController);
reliabilityDemoRouter.post('/demo/reliability/mode', modeController);
reliabilityDemoRouter.post('/demo/reliability/call', callController);
// Unauthenticated reset of shared demo state (breaker + counters) — a
// deliberate DEMO affordance; production resets demand credentials. Never
// copy this into prod.
reliabilityDemoRouter.post('/demo/reliability/reset', resetController);
