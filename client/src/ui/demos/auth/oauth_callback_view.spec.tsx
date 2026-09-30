import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import OauthCallbackView from './oauth_callback_view';

afterEach(() => {
  vi.unstubAllGlobals();
});

const EXCHANGE_URL = '/api/demo/oauth/demo-exchange';
const USERINFO_URL = '/api/demo/oauth/userinfo';

const ACCESS_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSIsInJhdGkiOiJyb2xlcyI6WyJhZG1pbiJdfQ.sig-part-is-long-enough-to-mask';

function jsonLike(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (): string | null => null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

function renderAt(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <OauthCallbackView />
    </MemoryRouter>,
  );
}

describe('OauthCallbackView — the approved flow (?code=…)', () => {
  it('renders the completed acts: redirect received → exchange (token masked, note shown) → userinfo identity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === EXCHANGE_URL && method === 'POST') {
        return jsonLike({
          access_token: ACCESS_TOKEN,
          token_type: 'Bearer',
          expires_in: 300,
          scope: 'profile',
          note: 'performed in-process by the guide server playing your backend — in a real app YOUR backend makes this exchange',
        });
      }
      if (url === USERINFO_URL) {
        return jsonLike({ username: 'alice', displayName: 'Alice Admin', roles: ['admin'] });
      }
      return jsonLike({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/demos/oauth/callback?code=CODE-abc123&state=anti-csrf-42');

    // Step 1 — the redirect, with code and state.
    const redirect = await screen.findByTestId('oauth-step-redirect');
    expect(redirect).toHaveTextContent('CODE-abc123');
    expect(redirect).toHaveTextContent('anti-csrf-42');

    // Step 2 — the exchange: token MASKED (never the full string), the note honest.
    const done = await screen.findByTestId('oauth-exchange-done');
    expect(done).toHaveTextContent('Bearer');
    expect(done).toHaveTextContent('expires_in 300s');
    expect(done.textContent ?? '').toContain('…'); // masked middle
    expect(done.textContent ?? '').not.toContain(ACCESS_TOKEN); // full token never on screen
    expect(screen.getByTestId('oauth-exchange-note')).toHaveTextContent('YOUR backend');

    // Step 3 — the identity the Bearer call returned.
    const identity = await screen.findByTestId('oauth-userinfo-identity');
    expect(identity).toHaveTextContent('Alice Admin');
    expect(identity).toHaveTextContent('@alice');
    expect(identity).toHaveTextContent('admin');

    // The exchange carried the code + the EXACT registered redirect_uri…
    const exchangeCall = fetchMock.mock.calls.find(([url]) => url === EXCHANGE_URL);
    expect(JSON.parse(String(exchangeCall?.[1]?.body ?? '{}'))).toEqual({
      code: 'CODE-abc123',
      redirect_uri: `${window.location.origin}/demos/oauth/callback`,
    });
    // …and the userinfo call carried the Bearer token.
    const userinfoCall = fetchMock.mock.calls.find(([url]) => url === USERINFO_URL);
    expect((userinfoCall?.[1]?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
  });

  it('renders the provider\'s refusal honestly when the code cannot be exchanged (replay/expiry)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === EXCHANGE_URL && (init?.method ?? 'GET') === 'POST') {
          return jsonLike(
            { error: 'invalid_grant', error_description: 'authorization code already used — codes are single-use by design' },
            400,
          );
        }
        return jsonLike({ error: 'not_found', message: 'no stub' }, 404);
      }),
    );

    renderAt('/demos/oauth/callback?code=USED-CODE&state=xyz');

    const failed = await screen.findByTestId('oauth-exchange-failed');
    expect(failed).toHaveTextContent('400');
    expect(failed).toHaveTextContent('invalid_grant');
    expect(failed).toHaveTextContent('single-use');
    // Act IV never runs — no identity step content.
    expect(screen.getByTestId('oauth-step-userinfo').textContent).not.toContain('@');
  });
});

describe('OauthCallbackView — the denied flow (?error=…)', () => {
  it('renders the access_denied state with the echoed state', () => {
    renderAt('/demos/oauth/callback?error=access_denied&state=anti-csrf-42');

    const denied = screen.getByTestId('oauth-callback-denied');
    expect(denied).toHaveTextContent('access_denied');
    expect(denied).toHaveTextContent('anti-csrf-42');
    expect(denied).toHaveTextContent('no');
  });
});

describe('OauthCallbackView — no flow in progress', () => {
  it('explains itself and links to the topic', () => {
    renderAt('/demos/oauth/callback');
    expect(screen.getByTestId('oauth-callback-empty')).toHaveTextContent('OAuth callback');
    expect(screen.getByTestId('oauth-callback-empty')).toHaveTextContent('Authentication topic');
  });
});
