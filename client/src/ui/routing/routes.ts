/** Canonical route path registry — the only place raw paths are written. */
export const routePaths = {
  home: '/',
  about: '/about',
  topic: '/topics/:topicId',
  /** The OAuth demo's registered redirect_uri — the provider lands here with ?code=…/?error=…. */
  oauthCallback: '/demos/oauth/callback',
  pageNotFound: '*',
} as const;

export type RoutePath = (typeof routePaths)[keyof typeof routePaths];

/** Builds a concrete topic URL from the canonical parametrized path. */
export function topicPath(topicId: string): string {
  return routePaths.topic.replace(':topicId', topicId);
}
