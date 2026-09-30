import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RefreshRotationDemo from './refresh_rotation_demo';
import { stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom talks to a stateful stand-in for the refresh endpoints that mirrors
 * refresh_store.ts's state machine: current rotates, an already-rotated token
 * revokes the WHOLE family with a distinguishable 401, and the status endpoint
 * serves the public view. The server spec pins the LIVE contract; here we
 * prove the walkthrough renders it — issued pair, rotation evidence, and the
 * revoked-family state after a replay.
 */

const USERS_URL = '/api/demo/auth/users';
const LOGIN_URL = '/api/demo/auth/credential/login';
const ROTATE_URL = '/api/demo/auth/refresh/rotate';

const CREDENTIAL_USERS = [
  { username: 'dana', displayName: 'Dana Hashed', roles: ['admin'], passwordHint: 'guide-hashing-pw' },
  { username: 'erin', displayName: 'Erin Hashed', roles: ['viewer'], passwordHint: 'another-teaching-pw' },
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

interface StubToken {
  raw: string;
  masked: string;
  state: 'current' | 'rotated' | 'revoked';
}

interface StubFamily {
  familyId: string;
  username: string;
  revoked: boolean;
  tokens: StubToken[];
}

/** The rotation state machine, simplified but faithful to the real store. */
function stubRefreshServer() {
  const families: StubFamily[] = [];
  let familySeq = 0;
  let tokenSeq = 0;

  const view = (family: StubFamily) => ({
    familyId: family.familyId,
    username: family.username,
    createdAt: '2026-09-29T09:00:00.000Z',
    revoked: family.revoked,
    revokedAt: family.revoked ? '2026-09-29T09:05:00.000Z' : null,
    revokedReason: family.revoked ? 'reuse_detected' : null,
    tokens: family.tokens.map((token, index) => ({
      n: index + 1,
      tokenMasked: token.masked,
      createdAt: '2026-09-29T09:00:00.000Z',
      rotatedAt: token.state === 'rotated' ? '2026-09-29T09:01:00.000Z' : null,
      state: family.revoked ? 'revoked' : token.state,
    })),
    currentTokenMasked: family.revoked
      ? null
      : (family.tokens.find((token) => token.state === 'current')?.masked ?? null),
  });

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === USERS_URL) {
      return jsonLike({
        users: [],
        credentialUsers: CREDENTIAL_USERS.map((user) => ({
          username: user.username,
          displayName: user.displayName,
          roles: user.roles,
          passwordHint: user.passwordHint,
        })),
      });
    }
    if (url === LOGIN_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { username?: string; password?: string };
      const user = CREDENTIAL_USERS.find((candidate) => candidate.username === body.username);
      if (user === undefined || body.password !== user.passwordHint) {
        return jsonLike(
          { error: { code: 'unauthorized', message: 'invalid username or password', scheme: 'credential', requestId: 't' } },
          401,
        );
      }
      familySeq += 1;
      tokenSeq += 1;
      const raw = `rt-${user.username}-${String(tokenSeq)}`;
      const family: StubFamily = {
        familyId: `fam_${String(familySeq)}`,
        username: user.username,
        revoked: false,
        tokens: [{ raw, masked: `…${user.username.slice(-2)}-${String(tokenSeq)}`, state: 'current' }],
      };
      families.push(family);
      return jsonLike({
        user: { username: user.username, displayName: user.displayName, roles: user.roles },
        session: { expiresAt: '2026-09-29T10:00:00.000Z', tokenMasked: '…wxyz' },
        jwt: { token: `jwt-${family.familyId}-access`, expiresAt: '2026-09-29T09:15:00.000Z' },
        refresh: { familyId: family.familyId, refreshToken: raw, note: 'store this' },
      });
    }
    if (url === ROTATE_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { refreshToken?: string };
      const family = families.find((candidate) =>
        candidate.tokens.some((token) => token.raw === body.refreshToken),
      );
      if (family === undefined) {
        return jsonLike(
          { error: { code: 'unauthorized', message: 'unknown refresh token', scheme: 'refresh', reason: 'unknown_token', requestId: 't' } },
          401,
        );
      }
      if (family.revoked) {
        return jsonLike(
          {
            error: {
              code: 'unauthorized',
              message: 'this token family was revoked after reuse was detected — log in again',
              scheme: 'refresh',
              reason: 'family_revoked',
              familyId: family.familyId,
              requestId: 't',
            },
          },
          401,
        );
      }
      const presented = family.tokens.find((token) => token.raw === body.refreshToken)!;
      if (presented.state === 'rotated') {
        // REUSE: the whole family dies, every token included.
        family.revoked = true;
        for (const token of family.tokens) token.state = 'revoked';
        return jsonLike(
          {
            error: {
              code: 'unauthorized',
              message:
                'refresh token REUSE detected: a previously rotated token was presented — the entire token family is now revoked (theft assumed)',
              scheme: 'refresh',
              reason: 'reuse_detected',
              familyId: family.familyId,
              reusedTokenMasked: presented.masked,
              revokedTokens: family.tokens.length,
              requestId: 't',
            },
          },
          401,
        );
      }
      // presented is current → rotate.
      tokenSeq += 1;
      presented.state = 'rotated';
      const nextRaw = `rt-${family.username}-${String(tokenSeq)}`;
      family.tokens.push({
        raw: nextRaw,
        masked: `…${family.username.slice(-2)}-${String(tokenSeq)}`,
        state: 'current',
      });
      return jsonLike({
        user: { username: family.username, displayName: 'Dana Hashed', roles: ['admin'] },
        jwt: { token: `jwt-${family.familyId}-access-${String(tokenSeq)}`, expiresAt: '2026-09-29T09:30:00.000Z' },
        refresh: {
          familyId: family.familyId,
          refreshToken: nextRaw,
          rotatedFromMasked: presented.masked,
          rotationCount: family.tokens.length - 1,
        },
      });
    }
    const statusMatch = /^\/api\/demo\/auth\/refresh\/status\/(.+)$/.exec(url);
    if (statusMatch !== null && method === 'GET') {
      const family = families.find((candidate) => candidate.familyId === statusMatch[1]);
      if (family === undefined) {
        return jsonLike(
          { error: { code: 'not_found', message: `no refresh-token family "${statusMatch[1]!}"`, requestId: 't' } },
          404,
        );
      }
      return jsonLike({ family: view(family) });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loginAsDana(): Promise<void> {
  fireEvent.click(screen.getByTestId('refresh-login-button'));
  await screen.findByTestId('refresh-issued');
}

describe('RefreshRotationDemo — rotate, save, replay, revoke', () => {
  it('login mints the first pair: the raw refresh token is shown once and the family panel lists one current token', async () => {
    const fetchMock = stubRefreshServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<RefreshRotationDemo />);

    expect(await screen.findByTestId('refresh-user-dana')).toHaveTextContent('Dana Hashed');
    await loginAsDana();

    const issued = screen.getByTestId('refresh-issued');
    expect(issued).toHaveTextContent('family fam_1');
    expect(screen.getByTestId('refresh-refresh-token').textContent).toBe('rt-dana-1');
    expect(screen.getByTestId('refresh-access-jwt').textContent).toContain('jwt-fam_1-access');
    expect(issued).toHaveTextContent('issued at login');

    const rows = await screen.findAllByTestId('refresh-family-row');
    expect(rows.length).toBe(1);
    expect(screen.getByTestId('refresh-token-state')).toHaveTextContent('current');
    expect(screen.getByTestId('refresh-family-active')).toHaveTextContent('active');
    expect(screen.getByTestId('refresh-current-token')).toHaveTextContent('…na-1');

    const loginCall = fetchMock.mock.calls.find(([url]) => url === LOGIN_URL);
    expect(loginCall?.[1]?.body).toBe(
      JSON.stringify({ username: 'dana', password: 'guide-hashing-pw' }),
    );
  });

  it('rotating issues the next pair, marks the old token rotated in the chain, and SAVES it for replay', async () => {
    vi.stubGlobal('fetch', stubRefreshServer());
    render(<RefreshRotationDemo />);

    await screen.findByTestId('refresh-user-dana');
    await loginAsDana();

    expect(screen.queryByTestId('refresh-saved-tokens')).toBeNull();
    fireEvent.click(screen.getByTestId('refresh-rotate-button'));

    expect(await screen.findByTestId('refresh-rotated-note')).toHaveTextContent('rotated');
    expect(screen.getByTestId('refresh-refresh-token').textContent).toBe('rt-dana-2');
    expect(screen.getByTestId('refresh-issued')).toHaveTextContent('rotation #1');

    // The saved list now holds the dead token, with a replay button.
    expect(screen.getByTestId('refresh-saved-row')).toHaveTextContent('…na-1');
    expect(screen.getByTestId('refresh-replay-button')).toBeDefined();

    // The chain: token 1 rotated, token 2 current.
    const states = (await screen.findAllByTestId('refresh-token-state')).map((chip) => chip.textContent);
    expect(states).toEqual(['rotated', 'current']);
  });

  it('replaying the saved old token: REUSE DETECTED, the family is revoked, every token dead', async () => {
    vi.stubGlobal('fetch', stubRefreshServer());
    render(<RefreshRotationDemo />);

    await screen.findByTestId('refresh-user-dana');
    await loginAsDana();
    fireEvent.click(screen.getByTestId('refresh-rotate-button'));
    await screen.findByTestId('refresh-rotated-note');

    // The thief replays the saved (already-rotated) token.
    fireEvent.click(screen.getByTestId('refresh-replay-button'));

    const replay = await screen.findByTestId('refresh-replay-result');
    expect(replay).toHaveTextContent('REUSE DETECTED — FAMILY REVOKED');
    expect(replay).toHaveTextContent('fam_1');
    expect(replay).toHaveTextContent(/reuse detected/i);
    expect(replay).toHaveTextContent('previously rotated token was presented');

    // The family panel shows the revoked state: badge, no accepted token,
    // every row's state chip reads revoked.
    expect(await screen.findByTestId('refresh-family-revoked')).toHaveTextContent('REVOKED');
    expect(screen.getByTestId('refresh-family-revoked')).toHaveTextContent('reuse_detected');
    expect(screen.getByTestId('refresh-current-token')).toHaveTextContent('nothing — every token is dead');
    const states = screen.getAllByTestId('refresh-token-state').map((chip) => chip.textContent);
    expect(states.every((state) => state === 'revoked')).toBe(true);

    // The current pair is gone — the legitimate holder must log in again.
    expect(screen.queryByTestId('refresh-issued')).toBeNull();
    expect(screen.getByTestId('refresh-rotate-button')).toBeDisabled();
  });

  it('a wrong password renders the ONE generic 401 — no hint about which half was wrong', async () => {
    vi.stubGlobal('fetch', stubRefreshServer());
    render(<RefreshRotationDemo />);

    await screen.findByTestId('refresh-user-dana');
    fireEvent.click(screen.getByTestId('refresh-user-erin'));
    fireEvent.change(screen.getByTestId('refresh-login-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('refresh-login-button'));

    expect(await screen.findByTestId('refresh-login-rejected')).toHaveTextContent(
      'unauthorized: invalid username or password',
    );
    expect(screen.queryByTestId('refresh-issued')).toBeNull();
  });

  it('degrades to the reachable-server message, never a crash', async () => {
    stubNetworkFailure();
    render(<RefreshRotationDemo />);

    expect(await screen.findByTestId('refresh-users-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(screen.getByTestId('refresh-login-button')).toBeDisabled();
  });
});
