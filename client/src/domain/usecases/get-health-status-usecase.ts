import type { HealthReport } from '../models/health';
import type { Result } from '../../core/result';
import type { StatusRepository } from '../repositories/status-repository';

/**
 * GetHealthStatusUseCase — the liveness probe behind the home screen's
 * "api" status chip. A thin orchestration seam over the repository
 * (react-guide use-case style).
 */
export class GetHealthStatusUseCase {
  private readonly repository: StatusRepository;

  constructor(repository: StatusRepository) {
    this.repository = repository;
  }

  execute(): Promise<Result<HealthReport>> {
    return this.repository.getHealth();
  }
}
