import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from 'react-router';
import { TopicView } from './topic_view';
import { RootLayout } from '../../components/root-layout';
import { ThemeProvider } from '../../design-system/theme-provider';
import { routePaths } from '../../routing/routes';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTopic(topicId: string) {
  return render(
    <MemoryRouter initialEntries={[`/topics/${topicId}`]}>
      <Routes>
        <Route path={routePaths.topic} element={<TopicView />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** One section carrying every block kind, exercising the whole renderer. */
const richTopic = {
  version: 1,
  id: 'demo-topic',
  title: 'Demo Topic',
  subtitle: 'A topic assembled for tests',
  group: 'fundamentals',
  order: 1,
  sections: [
    {
      id: 'demo-topic:section',
      title: 'The section',
      lead: 'The lead paragraph.',
      blocks: [
        { kind: 'text', id: 'b-text', body: 'The body of the text block.' },
        {
          kind: 'code',
          id: 'b-code',
          language: 'ts',
          caption: 'the caption',
          code: 'const answer = 42;',
        },
        {
          kind: 'demo',
          id: 'b-demo',
          demoId: 'express:app-info',
          title: 'Inspecting the running app',
          description: 'Ask the server about itself.',
        },
      ],
    },
  ],
};

const appInfo = {
  app: 'express_developers_guide',
  nodeVersion: 'v24.0.0',
  expressVersion: '5.2.1',
  env: 'development',
  uptimeSeconds: 12,
  pid: 1234,
  scenario: { dataMode: 'fake', injectFailure: false },
};

describe('TopicView', () => {
  it('renders loading, then the topic: text, verbatim code, and the registered demo', { timeout: 10000 }, async () => {
    stubApiFetch([
      { url: '/api/content/topics/demo-topic', body: richTopic },
      { url: '/api/demo/app-info', body: appInfo },
    ]);

    renderTopic('demo-topic');

    expect(screen.getByTestId('topic-loading')).toBeInTheDocument();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Demo Topic' }),
    ).toBeInTheDocument();
    expect(screen.getByText('A topic assembled for tests')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'The section' }),
    ).toBeInTheDocument();
    expect(screen.getByText('The lead paragraph.')).toBeInTheDocument();

    // Text block renders its body.
    expect(screen.getByText('The body of the text block.')).toBeInTheDocument();

    // Code block starts collapsed (label visible, source hidden), then expands
    // to render the code verbatim with its language chip and caption.
    const codeToggle = screen.getByRole('button', { name: 'ts' });
    expect(codeToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(codeToggle);
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'CODE' && element.textContent === 'const answer = 42;',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('ts')).toBeInTheDocument();
    expect(screen.getByText('the caption')).toBeInTheDocument();

    // Demo block resolves through the registry and the lazy demo fetches its endpoint.
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Inspecting the running app' }),
    ).toBeInTheDocument();
    const fields = await screen.findByTestId('app-info-fields');
    expect(fields).toHaveTextContent('v24.0.0');
    expect(fields).toHaveTextContent('5.2.1');
    expect(fields).toHaveTextContent('12s');
    expect(fields).toHaveTextContent('fake');
    expect(screen.getByRole('button', { name: 'refresh' })).toBeInTheDocument();
  });

  it('renders a coming-soon panel for a demoId missing from the registry', async () => {
    const unknownDemoTopic = {
      ...richTopic,
      id: 'mystery-topic',
      sections: [
        {
          ...richTopic.sections[0]!,
          blocks: [
            {
              kind: 'demo',
              id: 'b-unknown',
              demoId: 'nope:not-built-yet',
              title: 'A demo that does not exist',
            },
          ],
        },
      ],
    };

    const fetchMock = stubApiFetchAndReturnMock([
      { url: '/api/content/topics/mystery-topic', body: unknownDemoTopic },
    ]);

    renderTopic('mystery-topic');

    expect(await screen.findByTestId('demo-coming-soon')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'A demo that does not exist' }),
    ).toBeInTheDocument();
    // No app-info request was attempted for an unknown demo.
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      '/api/demo/app-info',
    );
  });

  it('shows the friendly error panel on a 404 topic', async () => {
    stubApiFetch([
      {
        url: '/api/content/topics/missing',
        status: 404,
        body: { error: { code: 'not_found', message: 'no topic with id "missing"', requestId: 'req-9' } },
      },
    ]);

    renderTopic('missing');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load this topic');
    expect(alert).toHaveTextContent('no topic with id "missing"');
    expect(alert).toHaveTextContent('not_found · status 404');
  });

  it('shows the error panel when the network is down (status 0)', async () => {
    stubNetworkFailure();

    renderTopic('anything');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(alert).toHaveTextContent('network_error · status 0');
  });
});

function stubApiFetchAndReturnMock(routes: Parameters<typeof stubApiFetch>[0]) {
  stubApiFetch(routes);
  return vi.mocked(fetch);
}

/* ---- header title: the shell + TopicView together (data router required) ---- */

function shellRoutes(): RouteObject[] {
  return [
    {
      element: <RootLayout />,
      children: [
        { path: routePaths.topic, element: <TopicView />, handle: { title: 'Topic' } },
        { path: '/plain', element: <p>plain outlet</p>, handle: { title: 'Plain' } },
      ],
    },
  ];
}

function renderTopicWithShell(topicId: string) {
  const router = createMemoryRouter(shellRoutes(), { initialEntries: [`/topics/${topicId}`] });
  return render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}

describe('TopicView header title', () => {
  it('follows the loaded topic; the route handle covers loading', async () => {
    stubApiFetch([
      { url: '/api/content/topics/demo-topic', body: richTopic },
      { url: '/api/demo/app-info', body: appInfo },
    ]);

    renderTopicWithShell('demo-topic');

    // While loading: the generic handle title is the header's h1.
    expect(screen.getByRole('heading', { level: 1, name: 'Topic' })).toBeInTheDocument();

    // Once loaded: the served topic title takes over the header (plus the
    // article's own hero h1 — two level-1 headings match now).
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 1, name: 'Demo Topic' })).toHaveLength(2),
    );
  });

  it('releases the override on navigation — the next route handle wins again', async () => {
    stubApiFetch([
      { url: '/api/content/topics/demo-topic', body: richTopic },
      { url: '/api/demo/app-info', body: appInfo },
    ]);

    const router = createMemoryRouter(shellRoutes(), {
      initialEntries: ['/topics/demo-topic'],
    });
    render(
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 1, name: 'Demo Topic' })).toHaveLength(2),
    );

    // Navigate inside act so the router transition + the override-release
    // state update flush before the assertions read the DOM.
    await act(async () => {
      await router.navigate('/plain');
    });
    expect(screen.getByText('plain outlet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Plain' })).toBeInTheDocument();
  });

  it('keeps the handle title when the topic fails to load', async () => {
    stubApiFetch([
      {
        url: '/api/content/topics/missing',
        status: 404,
        body: { error: { code: 'not_found', message: 'no topic', requestId: 'req-h' } },
      },
    ]);

    renderTopicWithShell('missing');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Topic' })).toBeInTheDocument();
  });
});
