import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SessionLoginDemo from './session_login_demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USERS_URL = '/api/demo/auth/users';
const LOGIN_URL = '/api/demo/auth/login';
const LOGOUT_URL = '/api/demo/auth/logout';
const ME_URL = '/api/demo/auth/me';
const SESSIONS_URL = '/api/demo/auth/sessions';

const TEACHING_PW = 'guide-demo-pw';
const MASKED = '…wxyz';

const ALICE = { username: 'alice', displayName: 'Alice Admin', roles: ['admin'] };
const BOB = { username: 'bob', displayName: 'Bob Builder', roles: ['editor'] };
const CAROL = { username: 'carol', displayName: 'Carol Reader', roles: ['viewer'] };

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

function unauthorized() {
  return jsonLike(
    { error: { code: 'unauthorized', message: 'a valid session cookie is required', requestId: 'test' } },
    401,
  );
}

/**
 * A stateful stand-in for the server: login creates the "session", logout
 * destroys it, and me/sessions answer 200 or the 401 envelope accordingly —
 * the same statefulness the real cookie + store produce.
 */
function stubStatefulServer() {
  let active: { username: string } | null = null;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === USERS_URL) {
      return jsonLike({
        users: [ALICE, BOB, CAROL].map((user) => ({ ...user, passwordHint: TEACHING_PW })),
      });
    }
    if (url === LOGIN_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        username: string;
        password: string;
      };
      if (body.password !== TEACHING_PW) {
        return jsonLike(
          { error: { code: 'unauthorized', message: 'invalid username or password', requestId: 'test' } },
          401,
        );
      }
      active = { username: body.username };
      return jsonLike({
        user: ALICE,
        session: { expiresAt: '2026-09-28T22:00:00.000Z', tokenMasked: MASKED },
      });
    }
    if (url === LOGOUT_URL && method === 'POST') {
      if (active === null) return unauthorized();
      const username = active.username;
      active = null;
      return jsonLike({ loggedOut: true, username });
    }
    if (url === ME_URL) {
      if (active === null) return unauthorized();
      return jsonLike({
        user: ALICE,
        session: {
          createdAt: '2026-09-28T21:30:00.000Z',
          expiresAt: '2026-09-28T22:00:00.000Z',
          tokenMasked: MASKED,
        },
      });
    }
    if (url === SESSIONS_URL) {
      if (active === null) return unauthorized();
      return jsonLike({
        sessions: [
          {
            username: 'alice',
            createdAt: '2026-09-28T21:30:00.000Z',
            expiresAt: '2026-09-28T22:00:00.000Z',
            tokenMasked: MASKED,
          },
        ],
      });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
  });
}

describe('SessionLoginDemo — the full login lifecycle', () => {
  it('picker loads with the prefilled teaching password, then login → me shows alice → sessions lists the masked session → logout → me is the 401 envelope', async () => {
    const fetchMock = stubStatefulServer();
    vi.stubGlobal('fetch', fetchMock);

    render(<SessionLoginDemo />);

    // 1. The picker: three identities, password prefilled, alice selected.
    expect(await screen.findByTestId('auth-user-option-alice')).toHaveTextContent('Alice Admin');
    expect(screen.getByTestId('auth-user-option-bob')).toHaveTextContent('Bob Builder');
    expect(screen.getByTestId('auth-user-option-carol')).toHaveTextContent('Carol Reader');
    expect(screen.getByTestId('auth-login-password')).toHaveValue(TEACHING_PW);

    // 2. LOGIN — the identity card, the masked session, the HttpOnly note.
    fireEvent.click(screen.getByTestId('auth-login-button'));
    expect(await screen.findByTestId('auth-login-result')).toHaveTextContent('Alice Admin');
    expect(screen.getByTestId('auth-login-session')).toHaveTextContent(MASKED);
    expect(screen.getByTestId('auth-httponly-note')).toHaveTextContent(
      "even this page's JS can't read it",
    );
    const loginCall = fetchMock.mock.calls.find(([url]) => url === LOGIN_URL);
    expect(loginCall?.[1]?.body).toBe(JSON.stringify({ username: 'alice', password: TEACHING_PW }));

    // 3. ME — the cookie's proof of identity.
    fireEvent.click(screen.getByTestId('auth-me-button'));
    expect(await screen.findByTestId('auth-me-username')).toHaveTextContent('Alice Admin');
    expect(screen.getByTestId('auth-me-username')).toHaveTextContent('@alice');
    expect(screen.getByTestId('auth-me-status')).toHaveTextContent('200');

    // 4. SESSIONS — server-side state, masked tokens only.
    fireEvent.click(screen.getByTestId('auth-sessions-button'));
    expect(await screen.findByTestId('auth-sessions-result')).toHaveTextContent('1 active session');
    expect(screen.getByTestId('auth-session-mask')).toHaveTextContent(MASKED);

    // 5. LOGOUT — then ME answers the 401 envelope (the cookie is dead).
    fireEvent.click(screen.getByTestId('auth-logout-button'));
    expect(await screen.findByTestId('auth-logout-result')).toHaveTextContent('session destroyed');

    fireEvent.click(screen.getByTestId('auth-me-button'));
    expect(await screen.findByTestId('auth-me-status')).toHaveTextContent('401');
    expect(screen.getByTestId('auth-me-result')).toHaveTextContent('unauthorized');

    // And the sessions listing is gated too.
    fireEvent.click(screen.getByTestId('auth-sessions-button'));
    expect(await screen.findByTestId('auth-sessions-result')).toHaveTextContent('no session');
  });

  it('switching users updates the password, and a wrong password renders the 401 envelope', async () => {
    const fetchMock = stubStatefulServer();
    vi.stubGlobal('fetch', fetchMock);

    render(<SessionLoginDemo />);
    await screen.findByTestId('auth-user-option-bob');

    fireEvent.click(screen.getByTestId('auth-user-option-bob'));
    fireEvent.change(screen.getByTestId('auth-login-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('auth-login-button'));

    expect(await screen.findByTestId('auth-login-rejected')).toHaveTextContent(
      'unauthorized: invalid username or password',
    );
    expect(screen.queryByTestId('auth-login-result')).toBeNull();
  });

  it('logout without a session renders the 401 envelope too', async () => {
    vi.stubGlobal('fetch', stubStatefulServer());
    render(<SessionLoginDemo />);
    await screen.findByTestId('auth-login-button');

    fireEvent.click(screen.getByTestId('auth-logout-button'));
    expect(await screen.findByTestId('auth-logout-result')).toHaveTextContent('401');
  });

  it('degrades to the reachable-server message, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<SessionLoginDemo />);

    expect(await screen.findByTestId('auth-users-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(screen.getByTestId('auth-login-button')).toBeDisabled();
  });
});
