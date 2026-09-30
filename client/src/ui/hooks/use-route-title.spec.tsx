import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { useRouteTitle } from './use-route-title';

function TitleProbe() {
  return <p data-testid="route-title">{useRouteTitle() ?? '(no title)'}</p>;
}

function renderRoutes(routes: RouteObject[], initialEntry: string) {
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  return render(<RouterProvider router={router} />);
}

describe('useRouteTitle', () => {
  it('reads the title from the deepest matched route handle', () => {
    renderRoutes(
      [
        {
          element: <TitleProbe />,
          children: [
            { path: '/about', element: <p>about</p>, handle: { title: 'About' } },
          ],
        },
      ],
      '/about',
    );

    expect(screen.getByTestId('route-title')).toHaveTextContent('About');
  });

  it('degrades to undefined when no handle title is set', () => {
    renderRoutes([{ path: '/bare', element: <TitleProbe /> }], '/bare');

    expect(screen.getByTestId('route-title')).toHaveTextContent('(no title)');
  });
});
