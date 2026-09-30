import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

/**
 * Middleware demo endpoints (the `middleware` topic's pipeline visualizer).
 * Each route runs through a real middleware stack where every layer appends a
 * trace entry to res.locals.pipeline — stamped relative to the first
 * middleware's clock — so the client can show exactly WHICH layers ran, in
 * WHICH order, and WHERE the chain stopped:
 *
 * - GET /api/demo/middleware/pipeline — the happy path: logger → auth →
 *   validator → handler, all four stamped, 200 with the trace in the body.
 * - GET /api/demo/middleware/short-circuit — the auth layer answers 401
 *   itself and never calls next(): the handler never runs, and the truncated
 *   trace travels in the x-pipeline response header.
 * - GET /api/demo/middleware/error-path — the handler throws (async, so
 *   Express 5 forwards the rejection); a ROUTER-level error-handling
 *   middleware appends 'error-handler' to the trace and rethrows to the
 *   app's global error handler, which renders the canonical 500 envelope.
 *
 * Every response carries the trace twice where possible: in the body (happy
 * path) and always in the x-pipeline header (compact JSON, ASCII-only) — the
 * client reads whichever it can, because error envelopes own the body.
 */

/** Where the whole demo answers — the topic's curl examples use this prefix. */
export const MIDDLEWARE_DEMO_MOUNT_PATH = '/api/demo/middleware';

/** One recorded pipeline step; elapsedMs is relative to the first middleware. */
export interface PipelineStage {
  stage: number;
  label: string;
  elapsedMs: number;
}

/** The res.locals fields this demo's stack owns (Express types locals as any). */
interface PipelineLocals {
  pipeline?: PipelineStage[];
  pipelineStartedAt?: number;
}

function locals(res: Response): PipelineLocals {
  return res.locals as PipelineLocals;
}

/** One decimal is plenty — the numbers are illustrative, not scientific. */
function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Stamps one trace entry; the first layer to run also starts the clock. */
function pushStage(res: Response, stage: number, label: string): PipelineStage {
  const state = locals(res);
  if (state.pipelineStartedAt === undefined || state.pipeline === undefined) {
    state.pipelineStartedAt = performance.now();
    state.pipeline = [];
  }
  const entry: PipelineStage = {
    stage,
    label,
    elapsedMs: roundMs(performance.now() - state.pipelineStartedAt),
  };
  state.pipeline.push(entry);
  return entry;
}

/**
 * The configurable-middleware pattern from the topic's custom-patterns
 * section, in miniature: a factory closes over the label and stage number,
 * and returns the actual middleware. Registration order IS the stage order.
 */
export function traceMiddleware(label: string, stage: number): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    pushStage(res, stage, label);
    next(); // pass control on — the pipeline keeps flowing
  };
}

/**
 * The trace as a response header. Compact JSON (JSON.stringify adds no
 * whitespace), and every label is ASCII, so no header-encoding hazards.
 * Must be set before the response starts — headers lock once sent.
 */
function setPipelineHeader(res: Response): void {
  res.setHeader('x-pipeline', JSON.stringify(locals(res).pipeline ?? []));
}

/** Set the header, then send — the one exit point for non-error responses. */
function sendWithPipeline(res: Response, status: number, body: unknown): void {
  setPipelineHeader(res);
  res.status(status).json(body);
}

// --- controllers --------------------------------------------------------------

function pipelineController(_req: Request, res: Response): void {
  // The handler terminates the pipeline, so it stamps itself like a layer —
  // the trace proves the request reached the bottom of the stack.
  pushStage(res, 4, 'handler');
  sendWithPipeline(res, 200, {
    pipeline: locals(res).pipeline,
    stages: locals(res).pipeline?.length ?? 0,
    note: 'three middleware layers plus the handler — each stamped relative to the first middleware\u2019s clock',
  });
}

/**
 * The short-circuit: records itself (stage 2), records the rejection as a
 * terminal 'short-circuit' entry, and RESPONDS instead of calling next().
 * Everything registered after it never runs — the whole point of the demo.
 */
function shortCircuitAuthMiddleware(_req: Request, res: Response): void {
  pushStage(res, 2, 'auth');
  pushStage(res, 3, 'short-circuit');
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
  setPipelineHeader(res);
  // The canonical envelope shape, built by hand: short-circuiting middleware
  // owns the response, so it owes callers the same contract the global error
  // handler would produce — no next() call, no handler, no error pipeline.
  res.status(401).json({
    error: {
      code: 'unauthorized',
      message: 'the auth middleware answered 401 itself — next() was never called',
      requestId,
    },
  });
}

/** Unreachable on purpose: proves the short-circuit stopped the chain. */
function neverRunsController(_req: Request, res: Response): void {
  pushStage(res, 4, 'handler');
  sendWithPipeline(res, 200, { impossible: 'the short-circuit should have answered already' });
}

/**
 * Async + throw: Express 5 forwards the rejected promise down the stack
 * looking for a 4-arg error middleware (Express 4 needed a wrapper for this).
 */
async function explodingHandler(_req: Request, res: Response): Promise<void> {
  pushStage(res, 4, 'handler');
  throw new Error('demo handler exploded on purpose');
}

/**
 * Router-level error-handling middleware: appends 'error-handler' to the
 * trace, publishes the header, and rethrows via next(err) so the app's
 * GLOBAL error handler still renders the one canonical envelope. Annotate,
 * never swallow — the response shape stays exactly what every other error
 * in the app produces.
 */
function demoPipelineErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  pushStage(res, 5, 'error-handler');
  setPipelineHeader(res);
  next(err);
}

export const middlewareDemoRouter = Router();

// Route-level middleware: the stack is part of the ROUTE registration, the
// narrowest of the three mounting scopes (see the levels section).
middlewareDemoRouter.get(
  '/demo/middleware/pipeline',
  traceMiddleware('logger', 1),
  traceMiddleware('auth', 2),
  traceMiddleware('validator', 3),
  pipelineController,
);
middlewareDemoRouter.get(
  '/demo/middleware/short-circuit',
  traceMiddleware('logger', 1),
  shortCircuitAuthMiddleware, // stage 2 — answers 401 itself; 3-4 below are dead
  traceMiddleware('validator', 3),
  neverRunsController,
);
middlewareDemoRouter.get(
  '/demo/middleware/error-path',
  traceMiddleware('logger', 1),
  traceMiddleware('auth', 2),
  traceMiddleware('validator', 3),
  explodingHandler,
);

// Error-handling middleware is recognized by its 4-arg signature and must be
// registered AFTER the routes it guards.
middlewareDemoRouter.use(demoPipelineErrorHandler);
