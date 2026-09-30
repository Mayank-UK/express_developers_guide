import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PasswordHashingDemo from './password_hashing_demo';
import { stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom talks to a stateful stand-in for the hashing endpoints: hash() encodes
 * AND remembers, verify() re-derives by lookup (the real route re-runs scrypt
 * with the parsed salt + params), and the credential login checks dana/erin's
 * teaching passwords. The server spec pins the LIVE contract (parsed parts,
 * constant-time compare, the generic 401); here we prove the playground
 * renders it — including the true/false round trip and the malformed-hash 400.
 */

const USERS_URL = '/api/demo/auth/users';
const HASH_URL = '/api/demo/auth/hashing/hash';
const VERIFY_URL = '/api/demo/auth/hashing/verify';
const CREDENTIAL_LOGIN_URL = '/api/demo/auth/credential/login';

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

const unauthorized = () =>
  jsonLike(
    { error: { code: 'unauthorized', message: 'invalid username or password', requestId: 'test' } },
    401,
  );

/** A toy encoder whose output the verify side can judge: scrypt-shaped + recorded. */
function stubHashingServer() {
  const hashesByPassword = new Map<string, string>();
  let saltSeq = 0;
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
    if (url === HASH_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { password?: string };
      if (typeof body.password !== 'string' || body.password === '') {
        return jsonLike(
          { error: { code: 'validation_failed', message: '"password" must be a non-empty string', requestId: 't' } },
          400,
        );
      }
      saltSeq += 1;
      // New salt every call — the same password hashes to a different string.
      const salt = `c2FsdC0${String(saltSeq).padStart(2, '0')}`;
      const hash = `scrypt$N=16384$r=8$p=1$${salt}$ZGVyaXZlZC1rZXk=${String(saltSeq)}`;
      hashesByPassword.set(body.password, hash);
      return jsonLike({
        hash,
        parsed: { primitive: 'scrypt', N: 16384, r: 8, p: 1, saltB64: salt, hashB64: 'ZGVyaXZlZC1rZXk=' },
        note: 'hash the same password twice — new salt, different string',
      });
    }
    if (url === VERIFY_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { password?: string; hash?: string };
      if (typeof body.password !== 'string' || typeof body.hash !== 'string' || !body.hash.includes('$')) {
        return jsonLike(
          { error: { code: 'validation_failed', message: 'the encoded hash is malformed', reason: 'malformed', requestId: 't' } },
          400,
        );
      }
      const recorded = hashesByPassword.get(body.password);
      return jsonLike({ matches: recorded === body.hash });
    }
    if (url === CREDENTIAL_LOGIN_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { username?: string; password?: string };
      const user = CREDENTIAL_USERS.find((candidate) => candidate.username === body.username);
      if (user === undefined || body.password !== user.passwordHint) return unauthorized();
      return jsonLike({
        user: { username: user.username, displayName: user.displayName, roles: user.roles },
        session: { expiresAt: '2026-09-29T10:00:00.000Z', tokenMasked: '…wxyz' },
        jwt: { token: 'aa.bb.cc', expiresAt: '2026-09-29T10:15:00.000Z' },
        refresh: { familyId: 'fam_1', refreshToken: 'rt-raw-once', note: 'store this' },
      });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PasswordHashingDemo — hash, verify, credential login', () => {
  it('hashing renders the encoded string plus the parsed parts (primitive / N / r / p / salt)', async () => {
    vi.stubGlobal('fetch', stubHashingServer());
    render(<PasswordHashingDemo />);

    fireEvent.change(screen.getByTestId('hashing-password-input'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByTestId('hashing-hash-button'));

    const result = await screen.findByTestId('hashing-hash-result');
    expect(screen.getByTestId('hashing-hash-string').textContent).toMatch(/^\$?scrypt\$N=16384/);
    expect(screen.getByTestId('hashing-hash-string').textContent).toContain('$r=8$p=1$');
    const rows = screen.getAllByTestId('hashing-parsed-row');
    expect(rows.length).toBe(5);
    expect(result).toHaveTextContent('scrypt');
    expect(result).toHaveTextContent('N (CPU/memory cost)');
    expect(result).toHaveTextContent('16384');
    expect(result).toHaveTextContent('salt (base64url)');
  });

  it('the round trip: the produced hash auto-fills the verify field — wrong candidate false, right candidate true', async () => {
    const fetchMock = stubHashingServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<PasswordHashingDemo />);

    fireEvent.change(screen.getByTestId('hashing-password-input'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByTestId('hashing-hash-button'));
    await screen.findByTestId('hashing-hash-result');

    // The fresh hash landed in the verify panel without a paste.
    const verifyInput = screen.getByTestId('hashing-verify-hash-input') as HTMLInputElement;
    expect(verifyInput.value).toMatch(/^scrypt\$/);

    // Wrong candidate → DOES NOT MATCH.
    fireEvent.change(screen.getByTestId('hashing-verify-password'), { target: { value: 'guess' } });
    fireEvent.click(screen.getByTestId('hashing-verify-button'));
    expect(await screen.findByTestId('hashing-verify-verdict')).toHaveTextContent('DOES NOT MATCH');

    // Right candidate → MATCHES (same password, same encoded string).
    fireEvent.change(screen.getByTestId('hashing-verify-password'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByTestId('hashing-verify-button'));
    expect(await screen.findByTestId('hashing-verify-verdict')).toHaveTextContent('MATCHES');
    expect(screen.getByTestId('hashing-verify-verdict')).toHaveTextContent('identical derivation');

    // The LAST verify call carried the right candidate against the produced hash.
    const verifyCalls = fetchMock.mock.calls.filter(([url]) => url === VERIFY_URL);
    expect(verifyCalls[verifyCalls.length - 1]?.[1]?.body).toBe(
      JSON.stringify({ password: 's3cret', hash: verifyInput.value }),
    );
  });

  it('a malformed hash string renders the 400 envelope — the mis-use guard, not a crash', async () => {
    vi.stubGlobal('fetch', stubHashingServer());
    render(<PasswordHashingDemo />);

    fireEvent.change(screen.getByTestId('hashing-verify-hash-input'), { target: { value: 'not-a-hash' } });
    fireEvent.change(screen.getByTestId('hashing-verify-password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('hashing-verify-button'));

    expect(await screen.findByTestId('hashing-verify-failed')).toHaveTextContent(
      'validation_failed',
    );
    expect(screen.queryByTestId('hashing-verify-verdict')).toBeNull();
  });

  it('credential login: dana succeeds with the JWT/refresh facts; wrong password renders the ONE generic 401', async () => {
    const fetchMock = stubHashingServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<PasswordHashingDemo />);

    expect(await screen.findByTestId('hashing-cred-user-dana')).toHaveTextContent('Dana Hashed');
    expect(screen.getByTestId('hashing-cred-user-erin')).toHaveTextContent('Erin Hashed');
    expect(screen.getByTestId('hashing-cred-password')).toHaveValue('guide-hashing-pw');

    fireEvent.click(screen.getByTestId('hashing-cred-login-button'));
    const result = await screen.findByTestId('hashing-cred-result');
    expect(result).toHaveTextContent('Dana Hashed');
    expect(result).toHaveTextContent('fam_1');
    expect(result).toHaveTextContent('2026-09-29T10:15:00.000Z');

    // Wrong password → the envelope, with no hint about WHICH half was wrong.
    fireEvent.change(screen.getByTestId('hashing-cred-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('hashing-cred-login-button'));
    expect(await screen.findByTestId('hashing-cred-rejected')).toHaveTextContent(
      'unauthorized: invalid username or password',
    );
    const loginCalls = fetchMock.mock.calls.filter(([url]) => url === CREDENTIAL_LOGIN_URL);
    expect(loginCalls.length).toBe(2);
  });

  it('degrades to the reachable-server message, never a crash', async () => {
    stubNetworkFailure();
    render(<PasswordHashingDemo />);

    expect(await screen.findByTestId('hashing-users-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(screen.getByTestId('hashing-cred-login-button')).toBeDisabled();
  });
});
