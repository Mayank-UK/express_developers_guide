import { createBrowserRouter } from 'react-router';
import { routePaths } from './routes';
import { RootLayout } from '../components/root-layout';
import { HomeView } from '../views/home/home_view';
import { AboutView } from '../views/about/about_view';
import { TopicView } from '../views/topic/topic_view';
import { PageNotFoundView } from '../views/placeholder/page_not_found_view';
// The OAuth callback is a standalone route (the provider redirects HERE with
// ?code=… — it must render outside the topic screens, and it is the flow's
// registered redirect_uri).
import OauthCallbackView from '../demos/auth/oauth_callback_view';

/**
 * Every route sets a `handle.title` that the shared header surfaces via
 * useRouteTitle() — the page's name lives with its route, not in the view.
 * Topic titles are served content (the screen renders its own h1), so the
 * topic route carries the generic chrome title.
 */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      {
        path: routePaths.home,
        element: <HomeView />,
        handle: { title: 'Express Developers Guide' },
      },
      {
        path: routePaths.about,
        element: <AboutView />,
        handle: { title: 'About' },
      },
      {
        path: routePaths.topic,
        element: <TopicView />,
        // Generic chrome title: TopicView overrides it with the served topic
        // title once loaded (use-header-title), so this covers loading and
        // failed topics only.
        handle: { title: 'Topic' },
      },
      {
        path: routePaths.oauthCallback,
        element: <OauthCallbackView />,
        handle: { title: 'OAuth callback' },
      },
      {
        path: routePaths.pageNotFound,
        element: <PageNotFoundView />,
        handle: { title: 'Page not found' },
      },
    ],
  },
]);
