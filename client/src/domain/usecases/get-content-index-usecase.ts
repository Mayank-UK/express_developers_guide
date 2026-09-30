import type { ContentIndex } from '../models/content-index';
import type { Result } from '../../core/result';
import type { ContentRepository } from '../repositories/content-repository';

/**
 * GetContentIndexUseCase — a thin orchestration layer over the repository.
 * Mirrors the react guide's `GetPostsUseCase`.
 *
 * The value is the *seam*: use cases are where cross-cutting policy (logging,
 * caching policy, combining multiple repositories, business rules) lives,
 * keeping repositories focused on a single source. Here it's a one-liner, but
 * the boundary matters.
 */
export class GetContentIndexUseCase {
  private readonly repository: ContentRepository;

  constructor(repository: ContentRepository) {
    this.repository = repository;
  }

  execute(): Promise<Result<ContentIndex>> {
    return this.repository.getContentIndex();
  }
}
