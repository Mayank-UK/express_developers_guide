import { describe, expect, it } from 'vitest';
import { makePostsUseCase } from './post_usecases.js';
import { createScenarioStore } from '../../core/scenario/scenario.js';
import { makeFakePostRepository } from '../../data/posts/fake_post_repository.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import { UUID_RE } from '../../test_support/index.js';

const validInput = {
  title: 'Unit-tested title',
  body: 'A body of reasonable length.',
  author: 'vitest',
};

function buildUseCase(overrides: { dataMode?: 'fake' | 'live'; injectFailure?: boolean } = {}) {
  const store = createScenarioStore(
    Object.freeze({
      dataMode: overrides.dataMode ?? 'fake',
      injectFailure: overrides.injectFailure ?? false,
    }),
  );
  const repository = makeFakePostRepository();
  let selections = 0;
  const useCase = makePostsUseCase({
    selectRepository: () => {
      selections += 1;
      return repository;
    },
    scenarioStore: store,
  });
  return { useCase, store, repository, selections: () => selections };
}

describe('PostsUseCase.create', () => {
  it('creates through the repository with a minted id', async () => {
    const { useCase } = buildUseCase();
    const result = await useCase.create(validInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject(validInput);
      expect(result.value.id).toMatch(UUID_RE);
      expect(result.value.createdAt).toBe(result.value.updatedAt);
    }
  });

  it('fails validation before any repository call', async () => {
    const { useCase, selections } = buildUseCase();
    const result = await useCase.create({ title: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
    expect(selections()).toBe(0);
  });
});

describe('PostsUseCase.getById', () => {
  it('validates the id shape before touching the repository', async () => {
    const { useCase, selections } = buildUseCase();
    for (const id of [undefined, 42, '', '   ']) {
      const result = await useCase.getById(id);
      expect(result.ok, `id ${String(id)}`).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('validation');
    }
    expect(selections()).toBe(0);
  });

  it('maps an unknown id to a not_found failure', async () => {
    const { useCase } = buildUseCase();
    const result = await useCase.getById('no-such-post');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not_found');
      expect(result.error.details?.postId).toBe('no-such-post');
    }
  });

  it('returns a seeded post by its id', async () => {
    const { useCase } = buildUseCase();
    const seed = SEED_POSTS[0];
    const result = await useCase.getById(seed.id);

    expect(result).toEqual({ ok: true, value: seed });
  });
});

describe('PostsUseCase failure injection', () => {
  it('short-circuits every use case with an unavailable failure when ON', async () => {
    const { useCase } = buildUseCase({ injectFailure: true });

    for (const result of [
      await useCase.list(),
      await useCase.getById(SEED_POSTS[0].id),
      await useCase.create(validInput),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('unavailable');
        expect(result.error.message).toBe('Failure injection is ON — this is the demo 503');
      }
    }
  });

  it('still validates before injecting on create', async () => {
    const { useCase } = buildUseCase({ injectFailure: true });
    const result = await useCase.create({ title: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('can be flipped off at runtime through the store', async () => {
    const { useCase, store } = buildUseCase({ injectFailure: true });
    expect((await useCase.list()).ok).toBe(false);

    store.set({ injectFailure: false });
    expect((await useCase.list()).ok).toBe(true);
  });
});

describe('PostsUseCase repository selection', () => {
  it('consults the selector on every invocation (per-call fake/live wiring)', async () => {
    const { useCase, selections } = buildUseCase();

    await useCase.list();
    await useCase.list();
    await useCase.getById(SEED_POSTS[0].id);

    expect(selections()).toBe(3);
  });
});
