import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  DEMO_USERS,
  constantTimeEquals,
  findUser,
  findUserByApiKey,
  verifyPassword,
} from '../../domain/auth/demo_users.js';
import {
  MAX_SESSIONS,
  __storeSizeForTests,
  createSession,
  getSession,
  listSessions,
  maskSessionToken,
  resetSessionStoreForTests,
} from '../../domain/auth/session_store.js';
import {
  JWT_ALGORITHM,
  JWT_DEMO_SECRET,
  signJwt,
  verifyJwt,
  type JwtClock,
} from '../../domain/auth/jwt_service.js';
import {
  SCRYPT_COST,
  hashPassword,
  parsePasswordHash,
  verifyPasswordHash,
} from '../../domain/auth/password_hasher.js';
import { resetRefreshStoreForTests } from '../../domain/auth/refresh_store.js';
import {
  AUTH_LOGIN_RATE_LIMIT,
  resetAuthLoginRateLimiter,
} from './auth_demo_routes.js';

const MOUNT = '/api/demo/auth';

const ALICE_KEY = 'gsk_demo_alice_2mFnQ7xK';
const BOB_KEY = 'gsk_demo_bob_3kQw9zRt';

beforeEach(() => {
  resetSessionStoreForTests();
  resetRefreshStoreForTests();
  // The login limiter is module-scoped and survives across tests (and app
  // instances) — wipe it so no case inherits a 429 from a previous one.
  resetAuthLoginRateLimiter();
});

/**
 * Robust Set-Cookie extraction: superagent reports one Set-Cookie as a string
 * and several as an array, attributes may appear in any order after the ';'
 * separators, and the value itself is URI-encoded — so parse the FIRST pair
 * before the first ';' and split on the FIRST '=' only.
 */
function sessionTokenFromResponse(res: request.Response): string {
  const raw: string | string[] | undefined = res.headers['set-cookie'];
  expect(raw).toBeDefined();
  const header = (Array.isArray(raw) ? raw[0] : raw) as string;
  expect(header).toContain('guide_session=');
  const pair = header.split(';')[0].trim();
  const equalsAt = pair.indexOf('=');
  return decodeURIComponent(pair.slice(equalsAt + 1));
}

describe('GET /api/demo/auth/users — the public identity fixture', () => {
  it('serves the three demo identities WITH the password hint (deliberate teaching material)', async () => {
    const res = await request(createApp()).get(`${MOUNT}/users`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(3);
    const byName = new Map(
      (res.body.users as Record<string, unknown>[]).map((user) => [String(user.username), user]),
    );
    expect(byName.get('alice')).toMatchObject({
      displayName: 'Alice Admin',
      roles: ['admin'],
      passwordHint: 'guide-demo-pw',
    });
    expect(byName.get('bob')).toMatchObject({ displayName: 'Bob Builder', roles: ['editor'] });
    expect(byName.get('carol')).toMatchObject({ displayName: 'Carol Reader', roles: ['viewer'] });
  });
});

describe('POST /api/demo/auth/login', () => {
  it('logs in: Set-Cookie carries the guide_session token with HttpOnly, SameSite=Lax, Path=/', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/login`)
      .send({ username: 'alice', password: 'guide-demo-pw' });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      username: 'alice',
      displayName: 'Alice Admin',
      roles: ['admin'],
    });
    expect(res.body.session).toMatchObject({
      tokenMasked: expect.stringMatching(/^….{4}$/),
    });
    expect(typeof res.body.session.expiresAt).toBe('string');

    const setCookie: string | string[] = res.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');

    // The response body must NEVER carry the full token — only the mask.
    const token = sessionTokenFromResponse(res);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(res.text).not.toContain(token);
    expect(res.body.session.tokenMasked).toBe(maskSessionToken(token));
  });

  it('rejects a wrong password with the 401 envelope', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/login`)
      .send({ username: 'alice', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized', scheme: 'session' });
    expect(res.body.error.message).toBe('invalid username or password');
  });

  it('answers unknown usernames with the SAME message (no user enumeration)', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/login`)
      .send({ username: 'mallory', password: 'guide-demo-pw' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('invalid username or password');
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects malformed bodies with 400 validation envelopes', async () => {
    const bodies: { label: string; send: () => request.Test }[] = [
      { label: '{}', send: () => request(createApp()).post(`${MOUNT}/login`).send({}) },
      {
        label: 'missing password',
        send: () => request(createApp()).post(`${MOUNT}/login`).send({ username: 'alice' }),
      },
      {
        label: 'non-string username',
        send: () => request(createApp()).post(`${MOUNT}/login`).send({ username: 42, password: 'x' }),
      },
      { label: 'array', send: () => request(createApp()).post(`${MOUNT}/login`).send(['alice']) },
    ];
    for (const { label, send } of bodies) {
      const res = await send();
      expect(res.status, `body ${label}`).toBe(400);
      expect(res.body.error.code, `body ${label}`).toBe('validation_failed');
    }
  });
});

describe('GET /api/demo/auth/me — the cookie proves who you are', () => {
  it('answers 200 with the session identity when the login cookie is replayed', async () => {
    const login = await request(createApp())
      .post(`${MOUNT}/login`)
      .send({ username: 'alice', password: 'guide-demo-pw' });
    const token = sessionTokenFromResponse(login);

    const res = await request(createApp()).get(`${MOUNT}/me`).set('Cookie', `guide_session=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      username: 'alice',
      displayName: 'Alice Admin',
      roles: ['admin'],
    });
    expect(res.body.session).toMatchObject({
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      tokenMasked: maskSessionToken(token),
    });
    // Full token never echoed — masked only.
    expect(res.text).not.toContain(token);
  });

  it('answers 401 without a cookie', async () => {
    const res = await request(createApp()).get(`${MOUNT}/me`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized', scheme: 'session' });
  });

  it('answers 401 for a cookie naming an unknown token', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/me`)
      .set('Cookie', 'guide_session=forged-token-that-never-existed');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('POST /api/demo/auth/logout', () => {
  it('destroys the session, clears the cookie, and the OLD cookie stops working', async () => {
    const login = await request(createApp())
      .post(`${MOUNT}/login`)
      .send({ username: 'bob', password: 'guide-demo-pw' });
    const token = sessionTokenFromResponse(login);

    const logout = await request(createApp())
      .post(`${MOUNT}/logout`)
      .set('Cookie', `guide_session=${token}`);

    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ loggedOut: true, username: 'bob' });
    const setCookie: string | string[] = logout.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
    expect(cookie).toContain('guide_session=');
    expect(cookie).toContain('Max-Age=0');

    // The replayed old cookie is dead server-side: /me is a 401 now.
    const me = await request(createApp()).get(`${MOUNT}/me`).set('Cookie', `guide_session=${token}`);
    expect(me.status).toBe(401);
  });

  it('answers 401 when there is no session to log out', async () => {
    const res = await request(createApp()).post(`${MOUNT}/logout`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized', scheme: 'session' });
  });
});

describe('GET /api/demo/auth/sessions — server-side state, made visible', () => {
  it('requires a session and lists ACTIVE sessions with masked tokens only', async () => {
    const anonymous = await request(createApp()).get(`${MOUNT}/sessions`);
    expect(anonymous.status).toBe(401);

    const aliceLogin = await request(createApp())
      .post(`${MOUNT}/login`)
      .send({ username: 'alice', password: 'guide-demo-pw' });
    const aliceToken = sessionTokenFromResponse(aliceLogin);
    await request(createApp())
      .post(`${MOUNT}/login`)
      .send({ username: 'carol', password: 'guide-demo-pw' });

    const res = await request(createApp())
      .get(`${MOUNT}/sessions`)
      .set('Cookie', `guide_session=${aliceToken}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.map((row: { username: string }) => row.username)).toEqual([
      'alice',
      'carol',
    ]);
    for (const row of res.body.sessions as Record<string, unknown>[]) {
      expect(String(row.tokenMasked)).toMatch(/^….{4}$/);
      expect(typeof row.createdAt).toBe('string');
      expect(typeof row.expiresAt).toBe('string');
    }
    // Neither full token ever appears in the listing.
    expect(res.text).not.toContain(aliceToken);
  });
});

describe('session expiry (ttl injection through the real route)', () => {
  it('an expired session is lazily DELETED and answered as 401', async () => {
    // ttlMs: 0 is the test-only injection (CreateSessionOptions) — production
    // callers always take the 30-minute default.
    const expired = createSession('alice', { ttlMs: 0 });
    const before = __storeSizeForTests();

    const res = await request(createApp())
      .get(`${MOUNT}/me`)
      .set('Cookie', `guide_session=${expired.token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    // Lazy expiry must DELETE, not merely filter: the store shrank by one.
    expect(__storeSizeForTests()).toBe(before - 1);
    expect(getSession(expired.token)).toBeNull();
  });

  it('expired sessions also vanish from the active listing', async () => {
    const alive = createSession('alice');
    createSession('bob', { ttlMs: 0 });

    const rows = listSessions();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('alice');
    expect(rows[0]?.tokenMasked).toBe(maskSessionToken(alive.token));
  });
});

describe('GET /api/demo/auth/keys — the public key fixture', () => {
  it('lists every key with its username and scopes', async () => {
    const res = await request(createApp()).get(`${MOUNT}/keys`);

    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([
      {
        key: 'gsk_demo_alice_2mFnQ7xK',
        username: 'alice',
        scopes: ['read:profile', 'write:profile', 'admin:demos'],
      },
      { key: 'gsk_demo_bob_3kQw9zRt', username: 'bob', scopes: ['read:profile', 'write:profile'] },
      { key: 'gsk_demo_carol_8vXp4mLb', username: 'carol', scopes: ['read:profile'] },
    ]);
  });
});

describe('GET /api/demo/auth/api-protected — x-api-key required', () => {
  it('answers 200 with the key identity and scopes for alice', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/api-protected`)
      .set('x-api-key', ALICE_KEY);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      username: 'alice',
      displayName: 'Alice Admin',
      roles: ['admin'],
    });
    expect(res.body.scopes).toEqual(['read:profile', 'write:profile', 'admin:demos']);
    expect(res.body.scheme).toBe('api-key');
  });

  it('works for every key in the fixture (carol: the read-only key)', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/api-protected`)
      .set('x-api-key', 'gsk_demo_carol_8vXp4mLb');

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('carol');
    expect(res.body.scopes).toEqual(['read:profile']);
  });

  it('answers 401 without the header and for unknown keys', async () => {
    const missing = await request(createApp()).get(`${MOUNT}/api-protected`);
    expect(missing.status).toBe(401);
    expect(missing.body.error).toMatchObject({ code: 'unauthorized', scheme: 'api-key' });

    const unknown = await request(createApp())
      .get(`${MOUNT}/api-protected`)
      .set('x-api-key', 'gsk_demo_forged_00000000');
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('unauthorized');
  });
});

describe('GET /api/demo/auth/api-admin — scope checking you can watch fail', () => {
  it("alice's key carries admin:demos → 200", async () => {
    const res = await request(createApp()).get(`${MOUNT}/api-admin`).set('x-api-key', ALICE_KEY);

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('alice');
    expect(typeof res.body.note).toBe('string');
  });

  it("bob's key lacks the scope → 403 forbidden envelope naming it", async () => {
    const res = await request(createApp()).get(`${MOUNT}/api-admin`).set('x-api-key', BOB_KEY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'forbidden',
      requiredScope: 'admin:demos',
      keyScopes: ['read:profile', 'write:profile'],
    });
  });

  it('still demands the key first: no header → 401, not 403', async () => {
    const res = await request(createApp()).get(`${MOUNT}/api-admin`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('the identity fixture and its constant-time compares (unit)', () => {
  it('constantTimeEquals: equal strings, and BOTH mismatch paths (same and different length)', () => {
    expect(constantTimeEquals('guide-demo-pw', 'guide-demo-pw')).toBe(true);
    expect(constantTimeEquals('guide-demo-pw', 'guide-demo-pX')).toBe(false); // same length
    expect(constantTimeEquals('guide-demo-pw', 'short')).toBe(false); // different length — no throw
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('verifyPassword and the key lookup resolve the fixture', () => {
    const alice = findUser('alice');
    expect(alice).toBeDefined();
    expect(verifyPassword(alice!, 'guide-demo-pw')).toBe(true);
    expect(verifyPassword(alice!, 'nope')).toBe(false);

    expect(findUserByApiKey(ALICE_KEY)?.user.username).toBe('alice');
    expect(findUserByApiKey('gsk_demo_forged_00000000')).toBeUndefined();
    expect(DEMO_USERS).toHaveLength(3);
  });

  it('masked tokens show exactly the last four characters', () => {
    expect(maskSessionToken('abcdefghijklmnopqrstuvwxyz')).toBe('…wxyz');
    expect(maskSessionToken('abcd')).toBe('…abcd');
  });

  it('the store caps at MAX_SESSIONS by evicting the oldest', () => {
    const first = createSession('alice');
    for (let index = 1; index < MAX_SESSIONS; index += 1) {
      createSession(index % 2 === 0 ? 'bob' : 'carol');
    }
    expect(__storeSizeForTests()).toBe(MAX_SESSIONS);
    expect(getSession(first.token)?.username).toBe('alice'); // exactly at cap: still alive

    createSession('alice'); // one over the cap → the OLDEST (first) is evicted
    expect(__storeSizeForTests()).toBe(MAX_SESSIONS);
    expect(getSession(first.token)).toBeNull();
  });
});

// --- JWT family (PART 2) ---------------------------------------------------------------

describe('jwt_service (unit) — the hand-rolled HS256 token', () => {
  it('sign/verify roundtrip: three base64url segments, HS256 header, claims intact', () => {
    const signed = signJwt('alice', ['admin'], 300);

    expect(signed.token.split('.')).toHaveLength(3);
    expect(signed.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(signed.payload).toMatchObject({ sub: 'alice', roles: ['admin'] });
    expect(signed.payload.exp - signed.payload.iat).toBe(300);
    expect(signed.payload.jti).toMatch(/^[0-9a-f]{32}$/);

    const verified = verifyJwt(signed.token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.value.payload.sub).toBe('alice');
      expect(verified.value.payload.roles).toEqual(['admin']);
    }
  });

  it('a tampered payload (signature untouched) → signature_mismatch', () => {
    const signed = signJwt('alice', ['admin'], 300);
    const [header, payload, signature] = signed.token.split('.');
    // Rewrite the payload as STILL-VALID JSON with forged claims — the honest
    // attack: edit the claims, keep the signature. (Flipping a raw base64url
    // character would corrupt the JSON and get rejected as 'malformed' before
    // the signature check ever runs — a different, less interesting failure.)
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims.sub = 'admin';
    const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const verified = verifyJwt(`${header}.${forged}.${signature}`);

    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.error.reason).toBe('signature_mismatch');
      expect(verified.error).toMatchObject({ kind: 'unauthorized', message: 'signature mismatch' });
    }
  });

  it('a tampered signature → signature_mismatch', () => {
    const signed = signJwt('bob', ['editor'], 300);
    const [header, payload] = signed.token.split('.');
    const forgedSignature = Buffer.from('forged-signature-bytes').toString('base64url');
    const verified = verifyJwt(`${header}.${payload}.${forgedSignature}`);

    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.reason).toBe('signature_mismatch');
  });

  it('an expired token (clock advanced onto exp) → token_expired', () => {
    // Time is a dependency: the injected clock (the same seam the job queue
    // and the circuit breaker expose) advances EXACTLY ONTO exp — the boundary
    // the (>=, not >) rule refuses — deterministically, no real sleep racing
    // a 1s TTL under load.
    let nowSeconds = 1_700_000_000;
    const clock: JwtClock = { now: () => nowSeconds };
    const signed = signJwt('carol', ['viewer'], 1, clock);

    nowSeconds += 1; // iat + ttl: the token is dead AT its exp second

    const verified = verifyJwt(signed.token, clock);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.error.reason).toBe('token_expired');
      expect(verified.error).toMatchObject({ kind: 'unauthorized', message: 'token expired' });
    }
  });

  it('a header claiming another algorithm is REJECTED (alg-confusion guard)', () => {
    const signed = signJwt('alice', ['admin'], 300);
    const [, payload, signature] = signed.token.split('.');
    // Re-sign nothing: swap ONLY the header to claim alg:none / RS256. The
    // signature was computed over the ORIGINAL header, so this would also
    // fail the signature check — but the ALG PIN rejects it first, which is
    // the defense that matters when an attacker strips or edits the header.
    for (const claimedAlg of ['none', 'RS256', 'HS512']) {
      const header = Buffer.from(JSON.stringify({ alg: claimedAlg, typ: 'JWT' })).toString('base64url');
      const verified = verifyJwt(`${header}.${payload}.${signature}`);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.error.reason).toBe('unsupported_algorithm');
    }
  });

  it('malformed structures → the validation failure, never a throw', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', '..']) {
      const verified = verifyJwt(bad);
      expect(verified.ok, `token "${bad}"`).toBe(false);
      if (!verified.ok) expect(verified.error.reason).toBe('malformed');
    }
    // Undecodable segments: valid base64url shape, garbage inside.
    const garbage = `${Buffer.from('!!not json!!').toString('base64url')}.${Buffer.from('{').toString('base64url')}.${'AAAA'}`;
    const verified = verifyJwt(garbage);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.reason).toBe('malformed');
  });

  it('the secret is deliberately public teaching material', () => {
    expect(JWT_DEMO_SECRET).toBe('jwt_demo_secret_teaching_only');
    expect(JWT_ALGORITHM).toBe('HS256');
  });
});

describe('POST /api/demo/auth/jwt/issue + /verify — the token workbench', () => {
  it('issues a decodable token: {token, decoded{header,payload}, expiresAt}', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/jwt/issue`)
      .send({ username: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.decoded.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(res.body.decoded.payload).toMatchObject({ sub: 'alice', roles: ['admin'] });
    expect(typeof res.body.decoded.payload.jti).toBe('string');
    expect(res.body.decoded.payload.exp - res.body.decoded.payload.iat).toBe(300);
    expect(typeof res.body.expiresAt).toBe('string');
    // The token IS the payload + header + signature — cross-check the segments.
    const [headerSegment, payloadSegment] = String(res.body.token).split('.');
    expect(Buffer.from(headerSegment, 'base64url').toString('utf8')).toBe(JSON.stringify(res.body.decoded.header));
    expect(JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'))).toEqual(res.body.decoded.payload);
  });

  it('clamps ttlSeconds into 1–3600 and issues the 1-second expiry demo', async () => {
    const short = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'bob', ttlSeconds: 2 });
    expect(short.body.decoded.payload.exp - short.body.decoded.payload.iat).toBe(2);

    const tooBig = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'bob', ttlSeconds: 99999 });
    expect(tooBig.body.decoded.payload.exp - tooBig.body.decoded.payload.iat).toBe(3600);

    const tooSmall = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'bob', ttlSeconds: -5 });
    expect(tooSmall.body.decoded.payload.exp - tooSmall.body.decoded.payload.iat).toBe(1);
  });

  it('unknown usernames and malformed bodies → 400 validation envelopes', async () => {
    const unknown = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'mallory' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('validation_failed');

    const badTtl = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'alice', ttlSeconds: 'soon' });
    expect(badTtl.status).toBe(400);

    const empty = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({});
    expect(empty.status).toBe(400);
  });

  it('verify answers 200 BOTH ways: valid → payload; tampered → reason', async () => {
    const issued = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'carol' });
    const token = String(issued.body.token);

    const valid = await request(createApp()).post(`${MOUNT}/jwt/verify`).send({ token });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ valid: true });
    expect(valid.body.payload.sub).toBe('carol');

    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims.roles = ['admin', 'editor']; // forged claims, unchanged signature
    const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const invalid = await request(createApp()).post(`${MOUNT}/jwt/verify`).send({ token: `${header}.${forged}.${signature}` });
    expect(invalid.status).toBe(200); // the verdict is data, not an error
    expect(invalid.body).toMatchObject({ valid: false, reasonCode: 'signature_mismatch' });
    expect(invalid.body.reason).toBe('signature mismatch');

    const malformed = await request(createApp()).post(`${MOUNT}/jwt/verify`).send({ token: 'garbage' });
    expect(malformed.status).toBe(200);
    expect(malformed.body.valid).toBe(false);

    const noToken = await request(createApp()).post(`${MOUNT}/jwt/verify`).send({});
    expect(noToken.status).toBe(400);
  });
});

describe('GET /api/demo/auth/jwt-protected — Bearer required', () => {
  it('answers 200 with identity + issuedAt/expiresAt for a fresh token', async () => {
    const issued = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'alice' });
    const token = String(issued.body.token);

    const res = await request(createApp())
      .get(`${MOUNT}/jwt-protected`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ username: 'alice', displayName: 'Alice Admin', roles: ['admin'] });
    expect(typeof res.body.issuedAt).toBe('string');
    expect(typeof res.body.expiresAt).toBe('string');
    expect(res.body.scheme).toBe('bearer');
  });

  it('answers the 401 envelope: no header, wrong scheme, garbage token, tampered token', async () => {
    const noHeader = await request(createApp()).get(`${MOUNT}/jwt-protected`);
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.error).toMatchObject({ code: 'unauthorized', scheme: 'bearer' });

    const wrongScheme = await request(createApp())
      .get(`${MOUNT}/jwt-protected`)
      .set('Authorization', 'Basic Zm9vOmJhcg==');
    expect(wrongScheme.status).toBe(401);

    const garbage = await request(createApp())
      .get(`${MOUNT}/jwt-protected`)
      .set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.message).toContain('malformed');

    const issued = await request(createApp()).post(`${MOUNT}/jwt/issue`).send({ username: 'alice' });
    const [header, payload, signature] = String(issued.body.token).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims.sub = 'admin';
    const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const tampered = await request(createApp())
      .get(`${MOUNT}/jwt-protected`)
      .set('Authorization', `Bearer ${header}.${forged}.${signature}`);
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.message).toBe('signature mismatch');
  });
});

// --- password hashing playground (PART 3) ----------------------------------------------

describe('POST /api/demo/auth/hashing/hash — the encoded string, parsed', () => {
  it('answers 200 with the encoded hash and a field-by-field parse of its own parts', async () => {
    const res = await request(createApp()).post(`${MOUNT}/hashing/hash`).send({ password: 'hunter2' });

    expect(res.status).toBe(200);
    expect(String(res.body.hash)).toMatch(new RegExp(`^scrypt\\$${String(SCRYPT_COST.N)}\\$${String(SCRYPT_COST.r)}\\$${String(SCRYPT_COST.p)}\\$[A-Za-z0-9_-]+\\$[A-Za-z0-9_-]{43}$`));
    expect(res.body.parsed).toMatchObject({ primitive: 'scrypt', N: SCRYPT_COST.N, r: SCRYPT_COST.r, p: SCRYPT_COST.p });
    expect(Buffer.from(String(res.body.parsed.saltB64), 'base64url')).toHaveLength(16);
    expect(Buffer.from(String(res.body.parsed.hashB64), 'base64url')).toHaveLength(32);

    // The parse in the response IS the store's parse — the format round-trips.
    const parsed = parsePasswordHash(String(res.body.hash));
    expect(parsed.ok).toBe(true);
  });

  it('salts every call: two hashes of the same password differ, both verify true', async () => {
    const app = createApp();
    const first = await request(app).post(`${MOUNT}/hashing/hash`).send({ password: 'same' });
    const second = await request(app).post(`${MOUNT}/hashing/hash`).send({ password: 'same' });

    expect(first.body.hash).not.toBe(second.body.hash);
    expect(verifyPasswordHash('same', String(first.body.hash))).toEqual({ ok: true, value: true });
    expect(verifyPasswordHash('same', String(second.body.hash))).toEqual({ ok: true, value: true });
  });

  it('rejects malformed bodies with the 400 validation envelope', async () => {
    const empty = await request(createApp()).post(`${MOUNT}/hashing/hash`).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('validation_failed');

    const nonString = await request(createApp()).post(`${MOUNT}/hashing/hash`).send({ password: 123 });
    expect(nonString.status).toBe(400);
  });
});

describe('POST /api/demo/auth/hashing/verify — the mis-use guard', () => {
  it('answers {matches: true} for the right password and {matches: false} for a wrong one', async () => {
    const hash = hashPassword('guide-demo-pw');
    const app = createApp();

    const right = await request(app).post(`${MOUNT}/hashing/verify`).send({ password: 'guide-demo-pw', hash });
    expect(right.status).toBe(200);
    expect(right.body).toEqual({ matches: true });

    const wrong = await request(app).post(`${MOUNT}/hashing/verify`).send({ password: 'nope', hash });
    expect(wrong.status).toBe(200); // the verdict is data, not an error
    expect(wrong.body).toEqual({ matches: false });
  });

  it('rejects malformed hash strings with a typed 400 naming the reason', async () => {
    const malformed = await request(createApp())
      .post(`${MOUNT}/hashing/verify`)
      .send({ password: 'x', hash: 'not-a-hash' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatchObject({ code: 'validation_failed', reason: 'malformed' });

    const wrongPrimitive = await request(createApp())
      .post(`${MOUNT}/hashing/verify`)
      .send({
        password: 'x',
        hash: ['bcrypt', '12', '8', '1', Buffer.alloc(16).toString('base64url'), Buffer.alloc(32).toString('base64url')].join('$'),
      });
    expect(wrongPrimitive.body.error.reason).toBe('unsupported_primitive');

    const hostile = await request(createApp())
      .post(`${MOUNT}/hashing/verify`)
      .send({
        password: 'x',
        hash: ['scrypt', '999999999', '8', '1', Buffer.alloc(16).toString('base64url'), Buffer.alloc(32).toString('base64url')].join('$'),
      });
    expect(hostile.status).toBe(400);
    expect(hostile.body.error.reason).toBe('bad_parameters'); // the self-DoS guard

    const missing = await request(createApp()).post(`${MOUNT}/hashing/verify`).send({ password: 'x' });
    expect(missing.status).toBe(400);
  });
});

// --- credential login over hashed passwords ----------------------------------------------

describe('POST /api/demo/auth/credential/login — scrypt verify + the SAME session/JWT machinery', () => {
  it('logs dana in: session cookie + JWT + first refresh token, all in one response', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/credential/login`)
      .send({ username: 'dana', password: 'guide-hashing-pw' });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ username: 'dana', displayName: 'Dana Hashed', roles: ['admin'] });

    // Session machinery identical to the fixture login: HttpOnly cookie.
    const setCookie: string | string[] = res.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
    expect(cookie).toContain('guide_session=');
    expect(cookie).toContain('HttpOnly');
    expect(res.body.session.tokenMasked).toMatch(/^….{4}$/);

    // JWT machinery: the returned token verifies through the same service.
    const jwt = verifyJwt(String(res.body.jwt.token));
    expect(jwt.ok).toBe(true);
    if (jwt.ok) expect(jwt.value.payload.sub).toBe('dana');
    expect(res.body.jwt.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Refresh machinery: family id + the raw token, exactly once.
    expect(res.body.refresh.familyId).toMatch(/^fam_\d+$/);
    expect(String(res.body.refresh.refreshToken)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('the session cookie actually works against /me (the machinery is shared, not mimicked)', async () => {
    const login = await request(createApp())
      .post(`${MOUNT}/credential/login`)
      .send({ username: 'erin', password: 'another-teaching-pw' });
    const raw: string | string[] = login.headers['set-cookie'];
    const header = (Array.isArray(raw) ? raw[0] : raw) as string;
    const pair = header.split(';')[0]!.trim();

    const me = await request(createApp()).get(`${MOUNT}/me`).set('Cookie', pair);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('erin');
  });

  it('wrong password and unknown username answer the IDENTICAL 401 (no user enumeration)', async () => {
    const app = createApp();
    const wrongPassword = await request(app)
      .post(`${MOUNT}/credential/login`)
      .send({ username: 'dana', password: 'another-teaching-pw' }); // erin's password, salted separately
    const unknownUser = await request(app)
      .post(`${MOUNT}/credential/login`)
      .send({ username: 'mallory', password: 'guide-hashing-pw' });

    for (const res of [wrongPassword, unknownUser]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toEqual(expect.objectContaining({ code: 'unauthorized', scheme: 'credential' }));
    }
    // Byte-identical error shape — nothing distinguishes which half failed.
    expect(wrongPassword.body.error.message).toBe('invalid username or password');
    expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
    expect(Object.keys(wrongPassword.body.error).sort()).toEqual(Object.keys(unknownUser.body.error).sort());
  });

  it('rejects malformed bodies with the 400 validation envelope', async () => {
    const empty = await request(createApp()).post(`${MOUNT}/credential/login`).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('validation_failed');
  });

  it('GET /users now also lists the credential fixture with password hints (additive)', async () => {
    const res = await request(createApp()).get(`${MOUNT}/users`);
    expect(res.status).toBe(200);
    expect(res.body.credentialUsers).toEqual([
      { username: 'dana', displayName: 'Dana Hashed', roles: ['admin'], passwordHint: 'guide-hashing-pw' },
      { username: 'erin', displayName: 'Erin Hashed', roles: ['viewer'], passwordHint: 'another-teaching-pw' },
    ]);
  });
});

// --- the shared per-IP login rate limit ----------------------------------------------------

describe('the login rate limit (30 per 60s per IP, SHARED by both logins)', () => {
  it('answers 200 up to the limit, then the N+1th gets the canonical 429 envelope', async () => {
    const app = createApp();
    for (let i = 0; i < AUTH_LOGIN_RATE_LIMIT; i += 1) {
      const res = await request(app)
        .post(`${MOUNT}/login`)
        .send({ username: 'alice', password: 'guide-demo-pw' });
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe(String(AUTH_LOGIN_RATE_LIMIT));
      expect(res.headers['x-ratelimit-remaining']).toBe(String(AUTH_LOGIN_RATE_LIMIT - 1 - i));
    }

    const blocked = await request(app)
      .post(`${MOUNT}/login`)
      .send({ username: 'alice', password: 'guide-demo-pw' });
    expect(blocked.status).toBe(429);
    // The canonical envelope — the limiter throws RateLimitException, the one
    // taxonomy maps it, and the failure's details merge in flat:
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(typeof blocked.body.error.message).toBe('string');
    expect(blocked.body.error.requestId).toMatch(/.+/);
    expect(blocked.body.error.requestId).toBe(blocked.headers['x-request-id']);
    expect(blocked.body.error.limiter).toContain('login');
    expect(blocked.body.error.limit).toBe(AUTH_LOGIN_RATE_LIMIT);
    expect(blocked.body.error.windowSeconds).toBe(60);
    expect(blocked.body.error.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(blocked.body.error.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');

    // The credential login draws on the SAME window — an attacker cannot
    // dodge the budget by switching credential families:
    const blockedCredential = await request(app)
      .post(`${MOUNT}/credential/login`)
      .send({ username: 'dana', password: 'guide-hashing-pw' });
    expect(blockedCredential.status).toBe(429);
    expect(blockedCredential.body.error.code).toBe('rate_limited');

    // And the limiter is DEDICATED to the logins — the rest of the router
    // never heard about it:
    expect((await request(app).get(`${MOUNT}/users`)).status).toBe(200);
  });

  it('recovers through the TEST-SCOPED reset seam (the limiter keeps real-clock windows)', async () => {
    // The limiter has no injectable timers (real Date.now windows), so
    // recovery-without-waiting-60s is proven through its reset hook — the
    // same seam the security spec uses, deliberately not an HTTP endpoint.
    const app = createApp();
    for (let i = 0; i < AUTH_LOGIN_RATE_LIMIT; i += 1) {
      await request(app).post(`${MOUNT}/login`).send({ username: 'carol', password: 'guide-demo-pw' });
    }
    const exhausted = await request(app)
      .post(`${MOUNT}/login`)
      .send({ username: 'carol', password: 'guide-demo-pw' });
    expect(exhausted.status).toBe(429);

    resetAuthLoginRateLimiter();

    // A fresh window serves BOTH logins again, from a full budget.
    const recovered = await request(app)
      .post(`${MOUNT}/credential/login`)
      .send({ username: 'erin', password: 'another-teaching-pw' });
    expect(recovered.status).toBe(200);
    expect(recovered.body.user.username).toBe('erin');
    expect(recovered.headers['x-ratelimit-remaining']).toBe(String(AUTH_LOGIN_RATE_LIMIT - 1));
  });
});

// --- refresh-token rotation with reuse detection ------------------------------------------

/** Logs in over the credential flow and returns {familyId, token} of the FIRST refresh token. */
async function credentialLoginRefresh(username: string, password: string): Promise<{ familyId: string; token: string }> {
  const login = await request(createApp()).post(`${MOUNT}/credential/login`).send({ username, password });
  expect(login.status).toBe(200);
  return { familyId: String(login.body.refresh.familyId), token: String(login.body.refresh.refreshToken) };
}

describe('POST /api/demo/auth/refresh/rotate — the happy chain', () => {
  it('rotates three times: each new token works, each OLD token is now reuse-bait', async () => {
    const start = await credentialLoginRefresh('dana', 'guide-hashing-pw');
    let current = start.token;

    for (let rotation = 1; rotation <= 3; rotation += 1) {
      const res = await request(createApp()).post(`${MOUNT}/refresh/rotate`).send({ refreshToken: current });
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('dana');
      expect(res.body.refresh.familyId).toBe(start.familyId);
      expect(res.body.refresh.rotationCount).toBe(rotation);

      // The fresh access token is a REAL JWT through the same verifier.
      const jwt = verifyJwt(String(res.body.jwt.token));
      expect(jwt.ok).toBe(true);
      if (jwt.ok) expect(jwt.value.payload.sub).toBe('dana');

      current = String(res.body.refresh.refreshToken);
    }

    // The status endpoint shows the chain: three rotations + the login token.
    const status = await request(createApp()).get(`${MOUNT}/refresh/status/${start.familyId}`);
    expect(status.status).toBe(200);
    expect(status.body.family.tokens.map((token: { state: string }) => token.state)).toEqual([
      'rotated',
      'rotated',
      'rotated',
      'current',
    ]);
    expect(status.body.family.revoked).toBe(false);
    expect(status.body.family.currentTokenMasked).toMatch(/^….{4}$/);
  });
});

describe('refresh REUSE detection — the theft assumption', () => {
  it('replaying the FIRST token after two rotations revokes the family with a distinguishable 401', async () => {
    const start = await credentialLoginRefresh('dana', 'guide-hashing-pw');
    const firstToken = start.token;
    let current = firstToken;
    for (let index = 0; index < 2; index += 1) {
      const res = await request(createApp()).post(`${MOUNT}/refresh/rotate`).send({ refreshToken: current });
      expect(res.status).toBe(200);
      current = String(res.body.refresh.refreshToken);
    }

    // The thief replays token #1.
    const reuse = await request(createApp()).post(`${MOUNT}/refresh/rotate`).send({ refreshToken: firstToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toMatchObject({
      code: 'unauthorized',
      scheme: 'refresh',
      reason: 'reuse_detected',
      familyId: start.familyId,
    });
    expect(reuse.body.error.message).toContain('family');

    // THE POINT: the legitimate holder's CURRENT token is dead too.
    const currentAfterRevoke = await request(createApp())
      .post(`${MOUNT}/refresh/rotate`)
      .send({ refreshToken: current });
    expect(currentAfterRevoke.status).toBe(401);
    expect(currentAfterRevoke.body.error).toMatchObject({ reason: 'family_revoked', familyId: start.familyId });

    // The family view confirms the revoke.
    const status = await request(createApp()).get(`${MOUNT}/refresh/status/${start.familyId}`);
    expect(status.body.family).toMatchObject({ revoked: true, revokedReason: 'reuse_detected', currentTokenMasked: null });
    expect(status.body.family.tokens.every((token: { state: string }) => token.state === 'revoked')).toBe(true);
  });

  it('an unknown token gets a PLAIN 401 and does not revoke anyone', async () => {
    const innocent = await credentialLoginRefresh('erin', 'another-teaching-pw');

    const unknown = await request(createApp())
      .post(`${MOUNT}/refresh/rotate`)
      .send({ refreshToken: 'forged-refresh-token-that-never-existed' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toMatchObject({ code: 'unauthorized', reason: 'unknown_token' });
    expect(unknown.body.error.familyId).toBeUndefined(); // no family implicated

    // The innocent family still rotates — no collateral damage.
    const stillFine = await request(createApp()).post(`${MOUNT}/refresh/rotate`).send({ refreshToken: innocent.token });
    expect(stillFine.status).toBe(200);
  });

  it('missing/malformed bodies → 400; unknown family status → 404; reset works', async () => {
    const missing = await request(createApp()).post(`${MOUNT}/refresh/rotate`).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('validation_failed');

    const notFound = await request(createApp()).get(`${MOUNT}/refresh/status/fam_999`);
    expect(notFound.status).toBe(404);
    expect(notFound.body.error).toMatchObject({ code: 'not_found', familyId: 'fam_999' });

    // One real family in the store (so the list has something to show)…
    await credentialLoginRefresh('erin', 'another-teaching-pw');
    const families = await request(createApp()).get(`${MOUNT}/refresh/families`);
    expect(families.status).toBe(200);
    expect(Array.isArray(families.body.families)).toBe(true);
    expect(families.body.families).toHaveLength(1);
    expect(families.body.families[0]).toMatchObject({ username: 'erin', revoked: false });

    const reset = await request(createApp()).post(`${MOUNT}/refresh/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ reset: true });
    expect((await request(createApp()).get(`${MOUNT}/refresh/families`)).body.families).toHaveLength(0);
  });
});
