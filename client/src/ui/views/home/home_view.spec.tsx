import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { HomeView } from './home_view';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const healthOk = { status: 'ok', uptime: 7, requestId: '00000000-0000-0000-0000-000000000000' };
const scenarioFake = { dataMode: 'fake', injectFailure: false };

/** Groups deliberately out of wire order to prove the client sorts by `order`. */
const contentIndex = {
  version: 1,
  groups: [
    { id: 'apis', title: 'APIs', order: 2 },
    { id: 'fundamentals', title: 'Fundamentals', order: 1 },
  ],
  topics: [
    { id: 'api-design', title: 'REST API Design', group: 'apis', order: 1, sectionCount: 0 },
    {
      id: 'routing',
      title: 'Routing',
      group: 'fundamentals',
      order: 5,
      sectionCount: 0,
    },
    {
      id: 'express-fundamentals',
      title: 'Express Fundamentals',
      group: 'fundamentals',
      order: 4,
      sectionCount: 4,
    },
  ],
};

function renderHome() {
  return render(
    <MemoryRouter>
      <HomeView />
    </MemoryRouter>,
  );
}

describe('HomeView', () => {
  it('renders the hero with live status chips and the run-instructions section', { timeout: 10000 }, async () => {
    stubApiFetch([
      { url: '/api/health', body: healthOk },
      { url: '/api/demo/scenario', body: scenarioFake },
      { url: '/api/content', body: contentIndex },
    ]);

    renderHome();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Express Developers Guide' }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId('status-chip-health')).toHaveTextContent(/^api: ok/),
    );
    await waitFor(() =>
      expect(screen.getByTestId('status-chip-data-mode')).toHaveTextContent('data: fake'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('status-chip-inject-failure')).toHaveTextContent(
        'failure injection: off',
      ),
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Run this guide' })).toBeInTheDocument();

    // Command blocks start collapsed (react-guide behavior); expanding reveals
    // the code and the captions.
    const toggles = screen.getAllByRole('button', { name: 'sh' });
    expect(toggles).toHaveLength(3);
    for (const toggle of toggles) {
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(toggle);
    }
    expect(
      screen.getByText('API on :4000 — tsx watch, reloads on every save'),
    ).toBeInTheDocument();
    expect(screen.getByText('Client on :5173 — Vite proxies /api to the server')).toBeInTheDocument();
    expect(screen.getByText('Full stack — server + client via Docker')).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'CODE' &&
          element.textContent === 'docker compose -f .docker/docker-compose.yml up',
      ),
    ).toBeInTheDocument();
  });

  it('renders the topic map: groups in order, populated topics link, empty topics come soon', async () => {
    stubApiFetch([
      { url: '/api/health', body: healthOk },
      { url: '/api/demo/scenario', body: scenarioFake },
      { url: '/api/content', body: contentIndex },
    ]);

    renderHome();

    const populated = await screen.findByTestId('topic-card-express-fundamentals');
    expect(populated).toHaveAttribute('href', '/topics/express-fundamentals');
    expect(populated).toHaveTextContent('4 sections');
    expect(populated).toHaveTextContent('Express Fundamentals');

    const empty = screen.getByTestId('topic-card-routing');
    expect(empty.querySelector('a')).toBeNull();
    expect(empty).toHaveAttribute('aria-disabled', 'true');
    expect(empty).toHaveTextContent('soon');

    // Group display order follows `order`, not wire order.
    const fundamentals = screen.getByText('Fundamentals');
    const apis = screen.getByText('APIs');
    expect(
      fundamentals.compareDocumentPosition(apis) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows the error panel when the content index call fails', async () => {
    stubApiFetch([
      { url: '/api/health', body: healthOk },
      { url: '/api/demo/scenario', body: scenarioFake },
      {
        url: '/api/content',
        status: 500,
        body: { error: { code: 'internal_error', message: 'boom', requestId: 'req-1' } },
      },
    ]);

    renderHome();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the topic map');
    expect(alert).toHaveTextContent('boom');
    expect(alert).toHaveTextContent('internal_error · status 500');
  });

  it('degrades each status chip independently when the scenario endpoint fails', async () => {
    stubApiFetch([
      { url: '/api/health', body: healthOk },
      {
        url: '/api/demo/scenario',
        status: 500,
        body: { error: { code: 'internal_error', message: 'scenario exploded', requestId: 'req-2' } },
      },
      { url: '/api/content', body: contentIndex },
    ]);

    renderHome();

    await waitFor(() =>
      expect(screen.getByTestId('status-chip-data-mode')).toHaveTextContent('data: unavailable'),
    );
    // The inject-failure chip only exists when the scenario actually loaded.
    expect(screen.queryByTestId('status-chip-inject-failure')).not.toBeInTheDocument();
    // Health is independent and still fine.
    await waitFor(() =>
      expect(screen.getByTestId('status-chip-health')).toHaveTextContent(/^api: ok/),
    );
  });

  it('renders the network-failure state across all panels (status 0)', async () => {
    stubNetworkFailure();

    renderHome();

    await waitFor(() =>
      expect(screen.getByTestId('status-chip-health')).toHaveTextContent('api: down'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('status-chip-data-mode')).toHaveTextContent('data: unavailable'),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(alert).toHaveTextContent('network_error · status 0');
  });
});
