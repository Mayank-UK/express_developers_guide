import type { Logger } from '../../core/config/logger';
import { safeRepositoryCall } from '../../core/error-handling/guards';
import type { Result } from '../../core/result';
import type { ContentIndex } from '../../domain/models/content-index';
import type { Topic } from '../../domain/models/topic';
import type { ContentRepository } from '../../domain/repositories/content-repository';
import type { ContentRemoteDataSource } from '../remote/content-remote-data-source';
import { toContentIndex, toTopic } from '../remote/dtos/content-dto';

/**
 * ContentRepositoryImpl — fetches content DTOs from the remote source and maps
 * them to domain models. Mirrors the react guide's `PostRepositoryImpl`,
 * trimmed to a remote-only source (this client has no local cache).
 *
 * Every expected failure (network down, error envelope, malformed payload)
 * arrives as a typed AppException from the data source and is mapped to a
 * Failure wrapped in a `Result` — the method never throws.
 */
export class ContentRepositoryImpl implements ContentRepository {
  private readonly remote: ContentRemoteDataSource;
  private readonly logger: Logger;

  constructor(remote: ContentRemoteDataSource, logger: Logger) {
    this.remote = remote;
    this.logger = logger;
  }

  getContentIndex(): Promise<Result<ContentIndex>> {
    return safeRepositoryCall<ContentIndex>({
      logger: this.logger,
      call: async () => toContentIndex(await this.remote.getContentIndex()),
    });
  }

  getTopic(id: string): Promise<Result<Topic>> {
    return safeRepositoryCall<Topic>({
      logger: this.logger,
      call: async () => toTopic(await this.remote.getTopic(id)),
    });
  }
}
