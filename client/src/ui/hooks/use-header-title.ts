import { createContext, useContext, useEffect } from 'react';

/**
 * Header title override — the mechanism that lets a SCREEN fine-tune the
 * header's page title with data only it knows after loading (e.g. TopicView's
 * served topic title, which a static route handle can never know).
 *
 * The route handle stays the source of truth: while a screen is loading, on
 * error, or on screens that never call the hook, the header keeps the
 * matched route's `handle.title`. The override is released automatically when
 * the calling screen unmounts or its title changes.
 *
 * Context + hook live in their own file (theme.ts precedent) so the provider
 * file (root-layout.tsx) keeps exporting only a component for Fast Refresh.
 */

interface HeaderTitleContextValue {
  setTitle: (title: string | undefined) => void;
}

export const HeaderTitleContext = createContext<HeaderTitleContextValue | null>(null);

/**
 * Sets the header's page title for as long as the calling screen is mounted.
 * Pass `undefined` to fall back to the current route handle's title.
 */
export function useHeaderTitle(title: string | undefined): void {
  const ctx = useContext(HeaderTitleContext);

  useEffect(() => {
    ctx?.setTitle(title);
    // Release the override on unmount (or title change) so the header falls
    // back to the route handle instead of showing a stale title.
    return () => ctx?.setTitle(undefined);
  }, [ctx, title]);
}
