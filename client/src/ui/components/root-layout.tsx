import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { ThemeToggle } from './theme-toggle';
import { useRouteTitle } from '../hooks/use-route-title';
import { HeaderTitleContext } from '../hooks/use-header-title';
import { routePaths } from '../routing/routes';
import { initAnalytics } from '../analytics/analytics';

/**
 * RootLayout — the single shared app shell: a header (back arrow + current
 * page title + about + theme toggle) and a scrolling content area via
 * <Outlet/>. Ported from the react guide's root-layout.
 *
 * There is NO navigation drawer (deliberate, user review): the home topic map
 * is the navigation hub — every topic is reachable from the grid there — so
 * the only chrome-level link is About.
 *
 * Header is deliberately quiet: surface background with a hairline border, so
 * the served content (not the chrome) carries the page. The current page's
 * title comes from the matched route's `handle` via useRouteTitle().
 *
 * Responsive: on desktop (md+) the About link sits inline in the header; on
 * mobile it collapses into a hamburger that opens a slide-in drawer holding
 * the same link (focus-trapped, Escape/backdrop close, focus restored).
 */
export function RootLayout() {
  const routeTitle = useRouteTitle();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  // A screen may override the header title with data it loads (see
  // use-header-title.ts); the route handle is the fallback.
  const [titleOverride, setTitleOverride] = useState<string | undefined>(undefined);
  const title = titleOverride ?? routeTitle;
  const titleContext = useMemo(() => ({ setTitle: setTitleOverride }), []);

  // Self-hosted analytics beacon (Umami — see ui/analytics/analytics.ts):
  // shell-level so it loads once per document for EVERY route. A no-op
  // unless the build baked both VITE_UMAMI_* vars in; the loader's
  // idempotence guard absorbs StrictMode's dev double-mount.
  useEffect(() => {
    initAnalytics();
  }, []);

  // Show the back arrow everywhere except home (so About, reached from the
  // header, always has a way back to where the user came from).
  const canGoBack = location.pathname !== routePaths.home;

  return (
    <div className="flex min-h-screen flex-col bg-surface-tint text-on-surface">
      <header className="sticky top-0 z-20 flex h-header items-center gap-md border-b border-outline bg-surface px-lg">
        {canGoBack && (
          <button
            type="button"
            onClick={() => {
              void navigate(-1);
            }}
            className="cursor-pointer rounded-md px-sm py-xxs hover:bg-surface-variant"
            aria-label="Go back"
          >
            ←
          </button>
        )}

        <h1 className="flex-1 truncate font-body text-body font-medium text-on-surface-variant">
          {title}
        </h1>

        {/* Desktop: About inline. */}
        <Link
          to={routePaths.about}
          className="hidden rounded-md px-sm py-xxs font-body text-body font-medium text-on-surface-variant hover:bg-surface-variant hover:text-on-surface md:inline-block"
        >
          About
        </Link>

        {/* Mobile: hamburger that opens the About drawer. */}
        <button
          ref={hamburgerRef}
          type="button"
          onClick={() => setDrawerOpen((open) => !open)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls="app-drawer"
          className="rounded-md px-sm py-xxs text-on-surface-variant hover:bg-surface-variant md:hidden"
        >
          <span aria-hidden className="block text-lg leading-none">
            ☰
          </span>
        </button>

        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col">
        <HeaderTitleContext.Provider value={titleContext}>
          <Outlet />
        </HeaderTitleContext.Provider>
      </main>

      {drawerOpen && (
        <AboutDrawer onClose={() => setDrawerOpen(false)} returnFocusRef={hamburgerRef} />
      )}
    </div>
  );
}

/** Focusable-element selector for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * AboutDrawer — the mobile-only slide-in panel. Holds the About link (the
 * single chrome-level nav entry). Closes on backdrop click, Escape, or a link
 * tap.
 *
 * Accessibility: because the dialog declares `aria-modal`, it must actually
 * behave as modal — on open we move focus into the panel, constrain Tab to it,
 * and on close we restore focus to the hamburger that opened it.
 */
function AboutDrawer({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    // Remember what was focused (the hamburger) so we can return to it.
    const previouslyFocused =
      returnFocusRef.current ?? (document.activeElement as HTMLElement | null);

    // Move focus into the dialog.
    const focusables = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
    focusables?.[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Restore focus to the trigger on close.
      previouslyFocused?.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div
      className="fixed inset-0 z-30 md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
    >
      {/* Backdrop. */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
        tabIndex={-1}
      />

      {/* Panel — slides in from the right. */}
      <div
        ref={panelRef}
        id="app-drawer"
        className="absolute right-0 top-0 flex h-full w-64 flex-col gap-sm border-l border-outline bg-surface p-md shadow-button-card"
      >
        <div className="flex items-center justify-between px-sm py-xs">
          <span className="text-overline font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
            Menu
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md px-xs py-xxs text-on-surface-variant hover:bg-surface-variant"
          >
            ✕
          </button>
        </div>

        <Link
          to={routePaths.about}
          onClick={onClose}
          className="rounded-md px-sm py-sm text-body font-medium text-on-surface hover:bg-surface-variant"
        >
          About
        </Link>
      </div>
    </div>
  );
}
