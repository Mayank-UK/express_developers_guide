import Database from 'better-sqlite3';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import type { Post } from '../../domain/posts/post.js';
import type { CreatePostInput, PostRepositoryPort } from '../../domain/posts/post_repository.js';
import { PostDao, type PostRow } from './post_dao.js';

function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function postToRow(post: Post): PostRow {
  return {
    id: post.id,
    title: post.title,
    body: post.body,
    author: post.author,
    created_at: post.createdAt,
    updated_at: post.updatedAt,
  };
}

/**
 * better-sqlite3 errors are translated here and never leak upward: constraint
 * violations become typed conflicts, everything else an internal failure with
 * the original error attached as cause.
 */
function toRepositoryFailure(operation: string, cause: unknown): Failure {
  if (cause instanceof Database.SqliteError && cause.code.startsWith('SQLITE_CONSTRAINT')) {
    return failure('conflict', `${operation} violated a database constraint`, { operation }, cause);
  }
  return failure('internal', `${operation} failed in sqlite`, { operation }, cause);
}

/**
 * Live-mode PostRepositoryPort: sqlite via the DAO. A make* factory returning a
 * FROZEN object — the DI container is the only caller and passes the DAO in.
 */
export interface SqlitePostRepositoryDependencies {
  /**
   * Lazy DAO SOURCE, not a DAO instance: the factory is cheap to call while the
   * container builds eagerly, but the sqlite client (and the database it
   * opens) must materialize on FIRST USE — the closure below memoizes whatever
   * this thunk returns, so the database never opens until the first live query.
   */
  readonly dao: () => PostDao;
}

export function makeSqlitePostRepository({
  dao,
}: SqlitePostRepositoryDependencies): PostRepositoryPort {
  let daoInstance: PostDao | undefined;
  const activeDao = (): PostDao => (daoInstance ??= dao());

  return Object.freeze({
    async list(): Promise<Result<readonly Post[], Failure>> {
      try {
        return ok(activeDao().list().map(rowToPost));
      } catch (cause) {
        return fail(toRepositoryFailure('listing posts', cause));
      }
    },

    async findById(id: string): Promise<Result<Post, Failure>> {
      try {
        const row = activeDao().findById(id);
        if (row === undefined) {
          return fail(failure('not_found', `no post with id "${id}"`, { postId: id }));
        }
        return ok(rowToPost(row));
      } catch (cause) {
        return fail(toRepositoryFailure('fetching a post', cause));
      }
    },

    async create(input: CreatePostInput): Promise<Result<Post, Failure>> {
      const now = new Date().toISOString();
      const post: Post = {
        id: crypto.randomUUID(),
        title: input.title,
        body: input.body,
        author: input.author,
        createdAt: now,
        updatedAt: now,
      };
      try {
        activeDao().insert(postToRow(post));
        return ok(post);
      } catch (cause) {
        return fail(toRepositoryFailure('creating a post', cause));
      }
    },
  });
}
