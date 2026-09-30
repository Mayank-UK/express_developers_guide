import { fail, ok, type Result } from '../../core/result/result.js';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import type { ScenarioState, ScenarioStore } from '../../core/scenario/scenario.js';

/**
 * The first domain service: proves the Result pipeline end-to-end. Returns ok
 * normally; when failure injection is ON it returns an 'unavailable' failure
 * instead of throwing — domain code signals failures as values, and the
 * presentation edge converts them to HTTP.
 */
export interface DemoStatus {
  readonly app: string;
  readonly scenario: ScenarioState;
  readonly timestamp: string;
}

export class DemoService {
  private readonly scenarioStore: ScenarioStore;

  constructor(scenarioStore: ScenarioStore) {
    this.scenarioStore = scenarioStore;
  }

  async status(): Promise<Result<DemoStatus, Failure>> {
    const scenario = this.scenarioStore.get();
    if (scenario.injectFailure) {
      return fail(failure('unavailable', 'failure injection is ON'));
    }
    return ok({
      app: 'express_developers_guide',
      scenario,
      timestamp: new Date().toISOString(),
    });
  }
}
