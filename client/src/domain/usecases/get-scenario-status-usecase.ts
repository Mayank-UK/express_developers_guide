import type { ScenarioReport } from '../models/scenario';
import type { Result } from '../../core/result';
import type { StatusRepository } from '../repositories/status-repository';

/**
 * GetScenarioStatusUseCase — the server's runtime fake/live + failure-injection
 * state behind the home screen's "data" and "failure injection" status chips.
 * A thin orchestration seam over the repository (react-guide use-case style).
 */
export class GetScenarioStatusUseCase {
  private readonly repository: StatusRepository;

  constructor(repository: StatusRepository) {
    this.repository = repository;
  }

  execute(): Promise<Result<ScenarioReport>> {
    return this.repository.getScenario();
  }
}
