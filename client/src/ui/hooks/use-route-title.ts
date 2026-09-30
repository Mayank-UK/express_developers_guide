import { useMatches } from 'react-router';

interface RouteTitleHandle {
  title?: string;
}

/**
 * useRouteTitle — reads the current page's title from the deepest matched
 * route's `handle`. Lets the shared header render a per-page heading without
 * each screen having to pass it explicitly.
 */
export function useRouteTitle(): string | undefined {
  const matches = useMatches();
  const last = matches[matches.length - 1];
  return (last?.handle as RouteTitleHandle | undefined)?.title;
}
