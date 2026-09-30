import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import OauthFlowDemo from './oauth_flow_demo';

/**
 * The flow launcher is deliberately fetchless — its whole job is producing the
 * correct authorize URL for a TOP-LEVEL navigation (the docs-link demo's
 * cross-origin approach: on the Vite dev server, port 5173, the API origin is
 * http://localhost:4000; otherwise same-origin). Under jsdom the location is
 * http://localhost:3000/, so the same-origin branch is what these assertions
 * exercise.
 */
describe('OauthFlowDemo — the flow launcher', () => {
  it('renders the four acts and a START link carrying the exact authorize parameters', () => {
    render(<OauthFlowDemo />);

    // The four acts, numbered and on screen.
    for (const act of ['oauth-act-1', 'oauth-act-2', 'oauth-act-3', 'oauth-act-4']) {
      expect(screen.getByTestId(act)).toBeDefined();
    }
    expect(screen.getByTestId('oauth-act-1')).toHaveTextContent('redirect to the provider');
    expect(screen.getByTestId('oauth-act-3')).toHaveTextContent('back-channel');

    // The start link: a real navigation href with every OAuth parameter.
    const href = screen.getByTestId('oauth-start').getAttribute('href') ?? '';
    const url = new URL(href);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${window.location.origin}/api/demo/oauth/authorize`,
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('guide_client');
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${window.location.origin}/demos/oauth/callback`,
    );
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/); // CSRF defense

    // The registration card names the redirect and keeps the secret server-side.
    expect(screen.getByTestId('oauth-redirect-chip')).toHaveTextContent('/demos/oauth/callback');
    expect(screen.getByText(/server-side only/i)).toBeDefined();
  });

  it('shows the authorize URL verbatim in the details block', () => {
    render(<OauthFlowDemo />);
    expect(screen.getByTestId('oauth-authorize-url').textContent ?? '').toContain(
      '/api/demo/oauth/authorize?response_type=code&client_id=guide_client',
    );
  });
});
