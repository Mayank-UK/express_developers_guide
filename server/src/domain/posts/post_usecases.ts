import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, type Result } from '../../core/result/result.js';
import type { ScenarioStore } from '../../core/scenario/scenario.js';
import { validatePostDraft, type Post } from './post.js';
import type { PostRepositoryPort } from './post_repository.js';

/**
 * Post use cases: orchestration, failure injection and repository selection.
 * Validation is NOT here — the entity owns it (validatePostDraft in post.ts):
 * the use case proves the payload through the entity's gate, then persists
 * via the port. The repository arrives as a SELECTOR (called per use-case
 * invocation) so the fake/live switch is evaluated on every request without
 * rebuilding anything.
 *
 * A make* factory (not a class): the composition root calls it once and gets a
 * FROZEN object — the method surface below is the contract, and nothing can be
 * swapped or subclassed after wiring.
 */
export interface PostsUseCase {
  list(): Promise<Result<readonly Post[], Failure>>;
  getById(id: unknown): Promise<Result<Post, Failure>>;
  create(raw: unknown): Promise<Result<Post, Failure>>;
}

export interface PostsUseCaseDependencies {
  /**
   * Called per use-case invocation — the closure the DI container passes reads
   * the LIVE scenario store, so toggling fake/live needs no rebuild.
   */
  readonly selectRepository: () => PostRepositoryPort;
  readonly scenarioStore: ScenarioStore;
}

export function makePostsUseCase({
  selectRepository,
  scenarioStore,
}: PostsUseCaseDependencies): PostsUseCase {
  const injectedFailure = (): Failure | undefined =>
    scenarioStore.get().injectFailure
      ? failure('unavailable', 'Failure injection is ON — this is the demo 503')
      : undefined;

  return Object.freeze({
    async list(): Promise<Result<readonly Post[], Failure>> {
      const injected = injectedFailure();
      if (injected) return fail(injected);
      return selectRepository().list();
    },

    async getById(id: unknown): Promise<Result<Post, Failure>> {
      if (typeof id !== 'string' || id.trim().length === 0) {
        return fail(
          failure('validation', 'post id must be a non-empty string', { parameter: 'id' }),
        );
      }
      const injected = injectedFailure();
      if (injected) return fail(injected);
      // Absence becomes a typed not_found failure at the repository boundary.
      return selectRepository().findById(id);
    },

    async create(raw: unknown): Promise<Result<Post, Failure>> {
      const validated = validatePostDraft(raw);
      if (!validated.ok) return fail(validated.error);
      const injected = injectedFailure();
      if (injected) return fail(injected);
      return selectRepository().create(validated.value);
    },
  });
}
