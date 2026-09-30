import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ApiKeyDemo from './api_key_demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEYS_URL = '/api/demo/auth/keys';
const PROTECTED_URL = '/api/demo/auth/api-protected';
const ADMIN_URL = '/api/demo/auth/api-admin';

const ALICE_KEY = 'gsk_demo_alice_2mFnQ7xK';
const BOB_KEY = 'gsk_demo_bob_3kQw9zRt';
const CAROL_KEY = 'gsk_demo_carol_8vXp4mLb';

const KEYS = [
  { key: ALICE_KEY, username: 'alice', scopes: ['read:profile', 'write:profile', 'admin:demos'] },
  { key: BOB_KEY, username: 'bob', scopes: ['read:profile', 'write:profile'] },
  { key: CAROL_KEY, username: 'carol', scopes: ['read:profile'] },
];

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

/** Dispatches on URL + the x-api-key header the demo sends, like the real guard. */
function stubKeyServer() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = ((init?.headers ?? {}) as Record<string, string>)['x-api-key'] ?? '';
    const match = KEYS.find((entry) => entry.key === key);

    if (url === KEYS_URL) return jsonLike({ keys: KEYS });
    if (match === undefined) {
      return jsonLike(
        { error: { code: 'unauthorized', message: 'the x-api-key header is required', requestId: 'test' } },
        401,
      );
    }
    if (url === PROTECTED_URL) {
      return jsonLike({
        user: { username: match.username, displayName: match.username, roles: [] },
        scopes: match.scopes,
        scheme: 'api-key',
      });
    }
    if (url === ADMIN_URL) {
      if (!match.scopes.includes('admin:demos')) {
        return jsonLike(
          {
            error: {
              code: 'forbidden',
              message: 'this endpoint requires the admin:demos scope',
              requiredScope: 'admin:demos',
              keyScopes: match.scopes,
              requestId: 'test',
            },
          },
          403,
        );
      }
      return jsonLike({
        user: { username: match.username, displayName: match.username, roles: [] },
        note: 'the admin:demos scope on this key is what let you in',
      });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
  });
}

describe('ApiKeyDemo — key selection and the scope-checked endpoints', () => {
  it('renders the three selectable cards with scopes, alice selected by default', async () => {
    vi.stubGlobal('fetch', stubKeyServer());
    render(<ApiKeyDemo />);

    expect(await screen.findByTestId('auth-key-card-alice')).toHaveTextContent(ALICE_KEY);
    expect(screen.getByTestId('auth-key-card-bob')).toHaveTextContent(BOB_KEY);
    expect(screen.getByTestId('auth-key-card-carol')).toHaveTextContent(CAROL_KEY);
    expect(screen.getByTestId('auth-key-card-alice')).toHaveTextContent('admin:demos');

    // The per-key curl snippet follows the selection.
    expect(screen.getByTestId('auth-curl-snippet')).toHaveTextContent(ALICE_KEY);
  });

  it("alice's key passes api-admin with a 200", async () => {
    const fetchMock = stubKeyServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<ApiKeyDemo />);
    await screen.findByTestId('auth-call-admin');

    fireEvent.click(screen.getByTestId('auth-call-admin'));
    expect(await screen.findByTestId('auth-api-status')).toHaveTextContent('200 api-admin');
    expect(screen.getByTestId('auth-api-body')).toHaveTextContent('admin:demos scope on this key');
    expect(screen.queryByTestId('auth-api-code')).toBeNull();

    const adminCall = fetchMock.mock.calls.find(([url]) => url === ADMIN_URL);
    expect(((adminCall?.[1]?.headers ?? {}) as Record<string, string>)['x-api-key']).toBe(ALICE_KEY);
  });

  it("bob's VALID key earns the 403 forbidden envelope naming the missing scope", async () => {
    vi.stubGlobal('fetch', stubKeyServer());
    render(<ApiKeyDemo />);
    await screen.findByTestId('auth-key-card-bob');

    fireEvent.click(screen.getByTestId('auth-key-card-bob'));
    expect(screen.getByTestId('auth-curl-snippet')).toHaveTextContent(BOB_KEY);

    fireEvent.click(screen.getByTestId('auth-call-admin'));
    expect(await screen.findByTestId('auth-api-status')).toHaveTextContent('403 api-admin');
    expect(screen.getByTestId('auth-api-code')).toHaveTextContent('forbidden');
    expect(screen.getByTestId('auth-api-scope-note')).toHaveTextContent('the scope check is what failed');
    expect(screen.getByTestId('auth-api-body')).toHaveTextContent('admin:demos');
  });

  it('any valid key passes api-protected — including carol\'s read-only key', async () => {
    vi.stubGlobal('fetch', stubKeyServer());
    render(<ApiKeyDemo />);
    await screen.findByTestId('auth-key-card-carol');

    fireEvent.click(screen.getByTestId('auth-key-card-carol'));
    fireEvent.click(screen.getByTestId('auth-call-protected'));
    expect(await screen.findByTestId('auth-api-status')).toHaveTextContent('200 api-protected');
    expect(screen.getByTestId('auth-api-body')).toHaveTextContent('read:profile');
    expect(screen.getByTestId('auth-api-body')).toHaveTextContent('api-key');
  });

  it('degrades to the reachable-server message, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<ApiKeyDemo />);

    expect(await screen.findByTestId('auth-keys-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(screen.getByTestId('auth-call-admin')).toBeDisabled();
  });
});
