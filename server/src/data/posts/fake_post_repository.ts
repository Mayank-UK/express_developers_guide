import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import type { Post } from '../../domain/posts/post.js';
import type { CreatePostInput, PostRepositoryPort } from '../../domain/posts/post_repository.js';
import { SEED_POSTS } from './seed_posts.js';

/**
 * Newest first. Deliberately plain code-unit comparison — NOT localeCompare —
 * so ordering matches the sqlite DAO's `ORDER BY created_at DESC, id DESC`
 * (BINARY collation) byte for byte.
 */
function byNewestFirst(left: Post, right: Post): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? 1 : -1;
}

/**
 * Fake-mode PostRepositoryPort: a plain in-memory array seeded with the SAME
 * seed posts the sqlite client installs, so both modes teach identical data.
 * Async is simulated with an awaited microtask — the port is a Promise API no
 * matter how trivial the backing store, and callers can't cheat with sync
 * assumptions. A make* factory returning a FROZEN object; the store lives in
 * the closure.
 */
export function makeFakePostRepository(): PostRepositoryPort {
  const posts: Post[] = SEED_POSTS.map((post) => ({ ...post }));

  return Object.freeze({
    async list(): Promise<Result<readonly Post[], Failure>> {
      await Promise.resolve();
      return ok([...posts].sort(byNewestFirst).map((post) => ({ ...post })));
    },

    async findById(id: string): Promise<Result<Post, Failure>> {
      await Promise.resolve();
      const found = posts.find((post) => post.id === id);
      if (found === undefined) {
        return fail(failure('not_found', `no post with id "${id}"`, { postId: id }));
      }
      return ok({ ...found });
    },

    async create(input: CreatePostInput): Promise<Result<Post, Failure>> {
      await Promise.resolve();
      const now = new Date().toISOString();
      const post: Post = {
        id: crypto.randomUUID(),
        title: input.title,
        body: input.body,
        author: input.author,
        createdAt: now,
        updatedAt: now,
      };
      posts.push(post);
      return ok({ ...post });
    },
  });
}
