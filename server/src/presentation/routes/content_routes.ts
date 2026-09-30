import { Router } from 'express';
import { getContainer } from '../../di/container.js';
import { makeExpressCallback } from './make_express_callback.js';
import { makeContentControllers } from '../controllers/content_controllers.js';

/**
 * Content API — the typed, versioned topic tree the React client renders:
 * - GET /api/content               → { version, groups, topics (summaries) }
 * - GET /api/content/topics/:id    → { version, ...topic }
 *
 * Pure route declarations over the framework-free content controllers, which
 * are composed HERE from the container's service. The dependency thunks
 * re-read getContainer() per call (same resolution the inline controllers
 * had), so resetContainer() keeps working with no rebuild.
 */
const contentControllers = makeContentControllers({
  listTopics: () => getContainer().contentService.listTopics(),
  getTopic: (id) => getContainer().contentService.getTopic(id),
});

export const contentRouter = Router();
contentRouter.route('/content').get(makeExpressCallback(contentControllers.list));
contentRouter
  .route('/content/topics/:id')
  .get(makeExpressCallback(contentControllers.detail));
