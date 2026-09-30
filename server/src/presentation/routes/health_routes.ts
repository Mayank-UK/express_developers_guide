import { Router, type Request, type Response } from 'express';

/**
 * Pure liveness check: no scenario dependence, no container — if this responds,
 * the process is up. Thin controller: it only shapes the response and echoes
 * the request id stamped by the request-id middleware.
 */
function healthController(_req: Request, res: Response): void {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    requestId,
  });
}

export const healthRouter = Router();
healthRouter.get('/health', healthController);
