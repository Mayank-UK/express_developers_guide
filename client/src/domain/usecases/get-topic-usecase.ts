import type { Topic } from '../models/topic';
import type { Result } from '../../core/result';
import type { ContentRepository } from '../repositories/content-repository';

/**
 * GetTopicUseCase — loads one topic by id for the generic topic screen.
 * A thin orchestration seam over the repository (react-guide use-case style).
 */
export class GetTopicUseCase {
  private readonly repository: ContentRepository;

  constructor(repository: ContentRepository) {
    this.repository = repository;
  }

  execute(id: string): Promise<Result<Topic>> {
    return this.repository.getTopic(id);
  }
}
