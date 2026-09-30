import { describe, expect, it } from 'vitest';
import { makeFakePostRepository } from './fake_post_repository.js';
import { SEED_POSTS } from './seed_posts.js';
import type { Post } from '../../domain/posts/post.js';
import { UUID_RE } from '../../test_support/index.js';

function byListOrder(a: Post, b: Post): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

describe('FakePostRepository', () => {
  it('lists the 3 seed posts newest-first', async () => {
    const repository = makeFakePostRepository();
    const result = await repository.list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(result.value.map((post) => post.id)).toEqual(
        [...SEED_POSTS].sort(byListOrder).map((post) => post.id),
      );
    }
  });

  it('returns copies — mutating a listed post cannot corrupt the store', async () => {
    const repository = makeFakePostRepository();
    const first = await repository.list();
    if (!first.ok) throw new Error('expected list to succeed');
    (first.value[0] as { title: string }).title = 'tampered';

    const again = await repository.list();
    if (!again.ok) throw new Error('expected list to succeed');
    expect(again.value.map((post) => post.title)).not.toContain('tampered');
  });

  it('creates posts with fresh UUID ids that are immediately findable', async () => {
    const repository = makeFakePostRepository();
    const created = await repository.create({
      title: 'Fake repo post',
      body: 'Persisted only in memory.',
      author: 'vitest',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.id).toMatch(UUID_RE);
    expect(created.value.createdAt).toBe(created.value.updatedAt);

    const found = await repository.findById(created.value.id);
    expect(found).toEqual({ ok: true, value: created.value });

    const listed = await repository.list();
    if (!listed.ok) throw new Error('expected list to succeed');
    // Newest first: the just-created post leads the list.
    expect(listed.value[0].id).toBe(created.value.id);
    expect(listed.value).toHaveLength(4);
  });

  it('fails with not_found for unknown ids', async () => {
    const repository = makeFakePostRepository();
    const result = await repository.findById('nope');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not_found');
      expect(result.error.details?.postId).toBe('nope');
    }
  });
});
