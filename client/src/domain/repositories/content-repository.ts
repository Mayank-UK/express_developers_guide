import type { ContentIndex } from '../models/content-index';
import type { Topic } from '../models/topic';
import type { Result } from '../../core/result';

/**
 * ContentRepository — the domain-facing contract for reading the guide's
 * teaching content. The UI / use cases depend on this interface, never on the
 * implementation. Mirrors the react guide's `PostRepository`.
 */
export interface ContentRepository {
  getContentIndex(): Promise<Result<ContentIndex>>;
  getTopic(id: string): Promise<Result<Topic>>;
}
