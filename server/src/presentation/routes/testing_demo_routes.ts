import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';
import {
  MINI_SUITE_CASE_IDS,
  runMiniSuite,
} from '../../domain/testing/mini_suite.js';

/**
 * The testing topic's live demo endpoint — a REAL test runner inside the
 * running server. GET /api/demo/testing/run executes domain/testing/
 * mini_suite.ts's curated twelve-case suite against this app's own pure
 * modules on every request (failures would appear instantly — a canary),
 * and ?injectFailureFor=<caseId> deliberately flips one case to failed to
 * prove the harness reports failures honestly.
 */
export const TESTING_DEMO_MOUNT_PATH = '/api/demo/testing';

async function runController(req: Request, res: Response): Promise<void> {
  const raw = req.query.injectFailureFor;
  if (raw !== undefined && raw !== '') {
    if (typeof raw !== 'string' || !MINI_SUITE_CASE_IDS.includes(raw)) {
      throw new ValidationException(
        '"injectFailureFor" must name a case in the mini suite (or be omitted to run everything honestly)',
        {
          parameter: 'injectFailureFor',
          received: String(raw),
          validValues: [...MINI_SUITE_CASE_IDS],
        },
      );
    }
    res.json(await runMiniSuite({ injectFailureFor: raw }));
    return;
  }
  res.json(await runMiniSuite());
}

export const testingDemoRouter = Router();
testingDemoRouter.get('/demo/testing/run', runController);
