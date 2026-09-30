import type { Failure } from '../../core/error_handling/failures.js';
import { failureToException } from '../../core/error_handling/exceptions.js';
import type { Result } from '../../core/result/result.js';
import type { Post } from '../../domain/posts/post.js';
import type { Controller, HttpRequest, HttpResponse } from '../routes/make_express_callback.js';

/**
 * Posts controllers — the framework-free ring between routes and use cases.
 * Each controller receives the httpRequest DTO (never req/res), calls exactly
 * ONE use case, and maps the Result to { status, body } — or throws the typed
 * AppException for the error middleware. No business logic lives here:
 * validation belongs to the use case, envelope rendering to the middleware.
 */

/** The use-case surface the posts controllers depend on (injected, frozen in). */
export interface PostsControllerDependencies {
  readonly listPosts: () => Promise<Result<readonly Post[], Failure>>;
  readonly getPost: (id: unknown) => Promise<Result<Post, Failure>>;
  readonly createPost: (raw: unknown) => Promise<Result<Post, Failure>>;
}

export function makePostsControllers({
  listPosts,
  getPost,
  createPost,
}: PostsControllerDependencies) {
  return Object.freeze({
    /** GET /api/posts → 200 { posts } */
    async list(_httpRequest: HttpRequest): Promise<HttpResponse> {
      const result = await listPosts();
      if (!result.ok) throw failureToException(result.error);
      return { status: 200, body: { posts: result.value } };
    },

    /** GET /api/posts/:id → 200 post */
    async detail(httpRequest: HttpRequest): Promise<HttpResponse> {
      const result = await getPost(httpRequest.params.id);
      if (!result.ok) throw failureToException(result.error);
      return { status: 200, body: result.value };
    },

    /** POST /api/posts → 201 created post */
    async create(httpRequest: HttpRequest): Promise<HttpResponse> {
      const result = await createPost(httpRequest.body);
      if (!result.ok) throw failureToException(result.error);
      return { status: 201, body: result.value };
    },
  });
}

export type PostsControllers = ReturnType<typeof makePostsControllers>;
export type PostsController = Controller;
