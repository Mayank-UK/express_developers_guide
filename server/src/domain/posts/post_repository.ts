import type { Failure } from '../../core/error_handling/failures.js';
import type { Result } from '../../core/result/result.js';
import type { Post, PostDraft } from './post.js';

/**
 * What a create request must carry — the entity's draft under the port's
 * name, so the persistence contract can never drift from the entity's shape
 * (validatePostDraft has already proven it by the time it arrives here).
 */
export type CreatePostInput = PostDraft;

/**
 * The repository PORT, owned by the domain. Use cases depend on this interface
 * only; the data layer implements it (fake in-memory, sqlite) and the DI
 * container decides which implementation answers each call.
 */
export interface PostRepositoryPort {
  list(): Promise<Result<readonly Post[], Failure>>;
  findById(id: string): Promise<Result<Post, Failure>>;
  create(input: CreatePostInput): Promise<Result<Post, Failure>>;
}
