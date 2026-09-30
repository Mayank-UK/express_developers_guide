import type { HealthReport } from '../models/health';
import type { ScenarioReport } from '../models/scenario';
import type { Result } from '../../core/result';

/**
 * StatusRepository — the domain-facing contract for the operational status
 * endpoints backing the home screen's live status chips (liveness probe +
 * runtime scenario). The two calls are independent by contract: one failing
 * never blocks the other.
 */
export interface StatusRepository {
  getHealth(): Promise<Result<HealthReport>>;
  getScenario(): Promise<Result<ScenarioReport>>;
}
