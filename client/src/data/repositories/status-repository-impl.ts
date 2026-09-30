import type { Logger } from '../../core/config/logger';
import { safeRepositoryCall } from '../../core/error-handling/guards';
import type { Result } from '../../core/result';
import type { HealthReport } from '../../domain/models/health';
import type { ScenarioReport } from '../../domain/models/scenario';
import type { StatusRepository } from '../../domain/repositories/status-repository';
import type { StatusRemoteDataSource } from '../remote/status-remote-data-source';
import { toHealthReport, toScenarioReport } from '../remote/dtos/status-dto';

/**
 * StatusRepositoryImpl — fetches the status DTOs from the remote source and
 * maps them to domain models. React-guide repository-impl style; expected
 * failures arrive as typed Failures wrapped in a `Result`, never thrown.
 */
export class StatusRepositoryImpl implements StatusRepository {
  private readonly remote: StatusRemoteDataSource;
  private readonly logger: Logger;

  constructor(remote: StatusRemoteDataSource, logger: Logger) {
    this.remote = remote;
    this.logger = logger;
  }

  getHealth(): Promise<Result<HealthReport>> {
    return safeRepositoryCall<HealthReport>({
      logger: this.logger,
      call: async () => toHealthReport(await this.remote.getHealth()),
    });
  }

  getScenario(): Promise<Result<ScenarioReport>> {
    return safeRepositoryCall<ScenarioReport>({
      logger: this.logger,
      call: async () => toScenarioReport(await this.remote.getScenario()),
    });
  }
}
