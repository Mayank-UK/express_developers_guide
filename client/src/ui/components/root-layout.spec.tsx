import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  type RouteObject,
} from 'react-router';
import { RootLayout } from './root-layout';
import { ThemeProvider } from '../design-system/theme-provider';
import { routePaths } from '../routing/routes';

/**
 * Renders the current pathname inside the outlet so assertions can follow
 * navigation.
 */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function layoutRoutes(withProbe: boolean): RouteObject[] {
  return [
    {
      element: <RootLayout />,
      children: [
        {
          path: routePaths.home,
          element: (
            <>
              <p>home outlet</p>
              {withProbe && <LocationProbe />}
            </>
          ),
          handle: { title: 'Express Developers Guide' },
        },
        {
          path: routePaths.about,
          element: (
            <>
              <p>about outlet</p>
              {withProbe && <LocationProbe />}
            </>
          ),
          handle: { title: 'About' },
        },
      ],
    },
  ];
}

function renderLayout(initialEntry: string, withProbe = false) {
  const router = createMemoryRouter(layoutRoutes(withProbe), {
    initialEntries: [initialEntry],
  });
  return render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('RootLayout', () => {
  it('surfaces the route handle title in the header h1, with About link and theme toggle — no nav drawer', () => {
    renderLayout('/about');

    // The header h1 is the route's handle title ("About"), rendered by
    // useRouteTitle — not hardcoded app chrome.
    expect(screen.getByRole('heading', { level: 1, name: 'About' })).toBeInTheDocument();

    // Chrome: About link (desktop) + theme toggle are present; outlet renders.
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
    expect(screen.getByText('about outlet')).toBeInTheDocument();

    // The nav drawer is gone — no navigation landmark anywhere.
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('hides the back arrow on home and shows it elsewhere, where it navigates back', { timeout: 10000 }, async () => {
    renderLayout('/', true);

    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull();

    // Navigate to About via the header link, then take the back arrow home.
    fireEvent.click(screen.getByRole('link', { name: 'About' }));
    expect(await screen.findByText('about outlet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/'));
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull();
  });

  it('opens the mobile About drawer from the hamburger, closes on link/Escape, and restores focus', () => {
    renderLayout('/');

    const hamburger = screen.getByRole('button', { name: 'Open menu' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(hamburger);

    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    // Focus moved into the panel (its first focusable element).
    expect(dialog.contains(document.activeElement)).toBe(true);

    // The drawer's About link closes the dialog (and navigates to About).
    fireEvent.click(screen.getAllByRole('link', { name: 'About' })[1]!);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Reopen and close via Escape — focus returns to the hamburger.
    fireEvent.click(hamburger);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(hamburger);
  });

  it('cycles Tab within the drawer focus trap', () => {
    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Menu' });

    // The trap scopes to the PANEL (id="app-drawer"): close X, About link.
    const panel = document.getElementById('app-drawer');
    expect(panel).not.toBeNull();
    const focusables = Array.from(
      panel!.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    expect(focusables.length).toBe(2);

    // Focus starts on the panel's first focusable element (the close X).
    expect(document.activeElement).toBe(focusables[0]);

    // Tab from the last item (About) wraps around to the first.
    focusables[focusables.length - 1]!.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);

    // Shift+Tab from the first item wraps around to the last.
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);

    expect(dialog).toBeInTheDocument();
  });

  it('closes the drawer when the backdrop is clicked', async () => {
    renderLayout('/');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    // Two "Close menu" buttons exist (backdrop + panel X); the backdrop is
    // first in DOM order.
    const backdrop = screen.getAllByRole('button', { name: 'Close menu' })[0]!;
    fireEvent.click(backdrop);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
