import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import JwtDemo from './jwt_demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USERS_URL = '/api/demo/auth/users';
const ISSUE_URL = '/api/demo/auth/jwt/issue';
const VERIFY_URL = '/api/demo/auth/jwt/verify';
const PROTECTED_URL = '/api/demo/auth/jwt-protected';

const ALICE = { username: 'alice', displayName: 'Alice Admin', roles: ['admin'] };
const BOB = { username: 'bob', displayName: 'Bob Builder', roles: ['editor'] };
const CAROL = { username: 'carol', displayName: 'Carol Reader', roles: ['viewer'] };

function b64u(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Builds a REAL three-segment token the demo can dissect client-side. */
function makeToken(sub: string, ttlSeconds: number, issuedAgoSeconds = 0): string {
  const iat = Math.floor(Date.now() / 1000) - issuedAgoSeconds;
  const payload = { sub, roles: ['admin'], iat, exp: iat + ttlSeconds, jti: 'fixed-jti-for-tests' };
  return `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}.${b64u('hmac-signature-bytes')}`;
}

const ALICE_TOKEN = makeToken('alice', 300);

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

interface StubOptions {
  token?: string;
  verify?: { valid: boolean; reason?: string; reasonCode?: string; payload?: unknown };
}

/**
 * The token workbench's stand-in server: users + issue + verify, and a
 * jwt-protected that accepts ONLY the exact token it issued (any tampered
 * variant earns the 401 envelope — the demo's honest behavior).
 */
function stubServer(options: StubOptions = {}) {
  const token = options.token ?? ALICE_TOKEN;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === USERS_URL) {
      return jsonLike({
        users: [ALICE, BOB, CAROL].map((user) => ({ ...user, passwordHint: 'guide-demo-pw' })),
      });
    }
    if (url === ISSUE_URL && method === 'POST') {
      // Mirror the real server: decoded carries the TOKEN's own claims (the
      // demo counts down from this exp).
      const payloadSegment = token.split('.')[1] ?? '';
      const claims = JSON.parse(
        atob(payloadSegment.replaceAll('-', '+').replaceAll('_', '/')),
      ) as { sub: string; iat: number; exp: number };
      return jsonLike({
        token,
        decoded: {
          header: { alg: 'HS256', typ: 'JWT' },
          payload: { sub: claims.sub, iat: claims.iat, exp: claims.exp },
        },
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      });
    }
    if (url === VERIFY_URL && method === 'POST') {
      return jsonLike(options.verify ?? { valid: true, payload: { sub: 'alice', roles: ['admin'] } });
    }
    if (url === PROTECTED_URL) {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization === `Bearer ${token}`) {
        return jsonLike({ user: { ...ALICE }, issuedAt: '2026-09-28T21:00:00.000Z', expiresAt: '2026-09-28T21:05:00.000Z', scheme: 'bearer' });
      }
      return jsonLike({ error: { code: 'unauthorized', message: 'signature mismatch', requestId: 't' } }, 401);
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
  });
}

describe('JwtDemo — issue, dissect, verify, tamper, expire', () => {
  it('ISSUE renders the token SPLIT into three segments with header + payload decoded', async () => {
    vi.stubGlobal('fetch', stubServer());
    render(<JwtDemo />);

    await screen.findByTestId('jwt-user-option-alice');
    fireEvent.click(screen.getByTestId('jwt-issue-button'));

    const dissection = await screen.findByTestId('jwt-token-dissection');
    expect(dissection).toBeDefined();
    // Three segments, color-coded, on screen.
    const header = screen.getByTestId('jwt-segment-header');
    const payload = screen.getByTestId('jwt-segment-payload');
    const signature = screen.getByTestId('jwt-segment-signature');
    expect(header.textContent).toBe(ALICE_TOKEN.split('.')[0]);
    expect(payload.textContent).toBe(ALICE_TOKEN.split('.')[1]);
    expect(signature.textContent).toBe(ALICE_TOKEN.split('.')[2]);
    // And the page DECODES them — no secret needed (signed ≠ encrypted).
    expect(screen.getByTestId('jwt-decoded-header').textContent).toContain('HS256');
    const decodedPayload = screen.getByTestId('jwt-decoded-payload').textContent ?? '';
    expect(decodedPayload).toContain('"sub"');
    expect(decodedPayload).toContain('alice');
    expect(screen.getByTestId('jwt-readonly-note')).toHaveTextContent('not a cipher');
  });

  it('VERIFY shows the valid verdict, and the Bearer call answers 200 with the identity', async () => {
    const fetchMock = stubServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<JwtDemo />);

    await screen.findByTestId('jwt-user-option-alice');
    fireEvent.click(screen.getByTestId('jwt-issue-button'));
    await screen.findByTestId('jwt-token-dissection');

    fireEvent.click(screen.getByTestId('jwt-verify-button'));
    expect(await screen.findByTestId('jwt-verify-verdict')).toHaveTextContent('VALID');

    fireEvent.click(screen.getByTestId('jwt-bearer-button'));
    expect(await screen.findByTestId('jwt-bearer-result')).toHaveTextContent('200');
    expect(screen.getByTestId('jwt-bearer-result')).toHaveTextContent('Alice Admin');
  });

  it('TAMPER rewrites the claims (sub → admin) and VERIFY answers invalid + reason; the Bearer call is refused', async () => {
    const fetchMock = stubServer({
      verify: { valid: false, reason: 'signature mismatch', reasonCode: 'signature_mismatch' },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<JwtDemo />);

    await screen.findByTestId('jwt-user-option-alice');
    fireEvent.click(screen.getByTestId('jwt-issue-button'));
    await screen.findByTestId('jwt-token-dissection');

    fireEvent.click(screen.getByTestId('jwt-tamper-toggle'));
    expect(screen.getByTestId('jwt-tampered-note')).toHaveTextContent('admin');

    fireEvent.click(screen.getByTestId('jwt-verify-button'));
    expect(await screen.findByTestId('jwt-verify-verdict')).toHaveTextContent('INVALID');
    expect(screen.getByTestId('jwt-verify-verdict')).toHaveTextContent('signature_mismatch');
    expect(screen.getByTestId('jwt-verify-reason')).toHaveTextContent('signature mismatch');

    // The verify call really carried the FORGED claims — and never touched the
    // signature segment (the mismatch is the lesson).
    const verifyCall = fetchMock.mock.calls.find(([url]) => url === VERIFY_URL);
    const sentToken = (JSON.parse(String(verifyCall?.[1]?.body ?? '{}')) as { token: string }).token;
    expect(sentToken.endsWith(ALICE_TOKEN.split('.')[2] ?? '')).toBe(true); // signature intact
    expect(sentToken).not.toBe(ALICE_TOKEN); // payload rewritten
    const sentClaims = JSON.parse(atob(sentToken.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/'))) as { sub: string };
    expect(sentClaims.sub).toBe('admin');

    // And the protected endpoint refuses the forged token with the 401 envelope.
    fireEvent.click(screen.getByTestId('jwt-bearer-button'));
    expect(await screen.findByTestId('jwt-bearer-result')).toHaveTextContent('401');
  });

  it('the 2-second token: the countdown reaches expired, and VERIFY answers "token expired"', async () => {
    const expiredToken = makeToken('bob', 2, 10); // ttl 2, issued 10s ago — already dead
    vi.stubGlobal('fetch', stubServer({
      token: expiredToken,
      verify: { valid: false, reason: 'token expired', reasonCode: 'token_expired' },
    }));
    render(<JwtDemo />);

    await screen.findByTestId('jwt-user-option-alice');
    fireEvent.click(screen.getByTestId('jwt-issue-short-button'));
    await screen.findByTestId('jwt-token-dissection');

    expect(await screen.findByTestId('jwt-countdown')).toHaveTextContent('expired');
    expect(screen.getByTestId('jwt-countdown')).toHaveTextContent('VERIFY');

    fireEvent.click(screen.getByTestId('jwt-verify-button'));
    expect(await screen.findByTestId('jwt-verify-verdict')).toHaveTextContent('INVALID');
    expect(screen.getByTestId('jwt-verify-reason')).toHaveTextContent('token expired');
  });

  it('degrades to the reachable-server message, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<JwtDemo />);

    expect(await screen.findByTestId('jwt-users-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(screen.getByTestId('jwt-issue-button')).toBeDisabled();
  });
});
