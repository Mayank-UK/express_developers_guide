import { Router } from 'express';
import { getContainer } from '../../di/container.js';
import { makeExpressCallback } from './make_express_callback.js';
import { makePostsControllers } from '../controllers/posts_controllers.js';

/**
 * Posts API — the canonical vertical slice (route → controller → use case →
 * repository):
 * - GET  /api/posts       → { posts }
 * - GET  /api/posts/:id   → post
 * - POST /api/posts       → 201 + created post
 *
 * The routes are now pure declarations: each verb is one
 * makeExpressCallback(controller) line. The controllers (framework-free, in
 * presentation/controllers) are composed HERE from the container's use case —
 * the dependency thunks re-read getContainer() per call, exactly like the
 * inline controllers they replace, so resetContainer() and runtime scenario
 * switches keep answering on the very next request. Routes and controllers
 * only ever see the use case — never the data layer.
 */
const postsControllers = makePostsControllers({
  listPosts: () => getContainer().postsUseCase.list(),
  getPost: (id) => getContainer().postsUseCase.getById(id),
  createPost: (raw) => getContainer().postsUseCase.create(raw),
});

export const postsRouter = Router();
postsRouter
  .route('/posts')
  .get(makeExpressCallback(postsControllers.list))
  .post(makeExpressCallback(postsControllers.create));
postsRouter.route('/posts/:id').get(makeExpressCallback(postsControllers.detail));
