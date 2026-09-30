import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { createAuthorizationCode, resetOAuthStoreForTests } from '../../domain/auth/oauth_store.js';

const MOUNT = '/api/demo/oauth';

const CLIENT_ID = 'guide_client';
const CLIENT_SECRET = 'guide_demo_secret';
const REDIRECT_URI = 'http://localhost:5173/demos/oauth/callback';
const OTHER_REDIRECT_URI = 'http://127.0.0.1:5173/demos/oauth/callback';
const BASIC_AUTH = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

beforeEach(() => {
  resetOAuthStoreForTests();
});

/** Drives acts I–II over HTTP: the consent decision returns the 302 with the code. */
async function approveForCode(
  username = 'alice',
  redirectUri = REDIRECT_URI,
  state = 'st-123',
): Promise<{ code: string; location: string }> {
  const res = await request(createApp())
    .post(`${MOUNT}/authorize/decision`)
    .type('form')
    .send({ username, decision: 'approve', client_id: CLIENT_ID, redirect_uri: redirectUri, state });
  expect(res.status).toBe(302);
  const location = res.headers.location as string;
  const url = new URL(location);
  return { code: url.searchParams.get('code') ?? '', location };
}

/** The full front-channel + back-channel happy path → a live access token. */
async function exchangeForToken(
  code: string,
  redirectUri = REDIRECT_URI,
): Promise<{ res: request.Response; token: string }> {
  const res = await request(createApp())
    .post(`${MOUNT}/token`)
    .set('Authorization', BASIC_AUTH)
    .type('form')
    .send({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  return { res, token: (res.body as { access_token?: string }).access_token ?? '' };
}

describe('GET /api/demo/oauth/authorize — the consent page (SSR-flavored)', () => {
  it('answers 200 HTML containing the client name, the user picker, and Approve/Deny', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=st-1`,
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Guide Demo App');
    expect(res.text).toContain('Approve');
    expect(res.text).toContain('Deny');
    // The user picker offers the fixture's three identities as radios.
    expect(res.text).toContain('value="alice"');
    expect(res.text).toContain('value="bob"');
    expect(res.text).toContain('value="carol"');
    // The form posts the decision back to the decision endpoint, carrying the
    // registration-bound values as hidden fields.
    expect(res.text).toContain('action="/api/demo/oauth/authorize/decision"');
    expect(res.text).toContain(`value="${REDIRECT_URI}"`);
  });

  it('rejects an unknown client with the 400 envelope', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/authorize?response_type=code&client_id=evil_client&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects an unregistered redirect_uri with the 400 envelope (open-redirector guard)', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(JSON.stringify(res.body.error)).not.toContain('evil.example.com');
  });

  it('rejects response_type values other than code (this demo is the code flow only)', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/authorize?response_type=token&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('POST /api/demo/oauth/authorize/decision — the redirect back', () => {
  it('approve → 302 to redirect_uri with code= and the state echoed', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/authorize/decision`)
      .type('form')
      .send({ username: 'bob', decision: 'approve', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: 'anti-csrf-42' });

    expect(res.status).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get('state')).toBe('anti-csrf-42');
  });

  it('deny → 302 with error=access_denied and the state echoed', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/authorize/decision`)
      .type('form')
      .send({ username: 'alice', decision: 'deny', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: 'anti-csrf-42' });

    expect(res.status).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('anti-csrf-42');
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('validates the form: unknown username, unregistered redirect_uri, bogus decision → 400', async () => {
    const cases: Record<string, string>[] = [
      { username: 'mallory', decision: 'approve', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI },
      { username: 'alice', decision: 'approve', client_id: CLIENT_ID, redirect_uri: 'https://evil.example.com/cb' },
      { username: 'alice', decision: 'maybe', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI },
    ];
    for (const form of cases) {
      const res = await request(createApp()).post(`${MOUNT}/authorize/decision`).type('form').send(form);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });
});

describe('POST /api/demo/oauth/token — the back-channel exchange', () => {
  it('happy path (Basic client auth, form body): burns the code and returns a Bearer JWT', async () => {
    const { code } = await approveForCode('alice');
    const { res, token } = await exchangeForToken(code);

    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(300);
    expect(res.body.scope).toBe('profile');
    expect(token.split('.')).toHaveLength(3); // the access token IS a JWT
    expect(res.headers['cache-control']).toContain('no-store');
    // The token speaks for the consenting user.
    const userinfo = await request(createApp())
      .get(`${MOUNT}/userinfo`)
      .set('Authorization', `Bearer ${token}`);
    expect(userinfo.status).toBe(200);
    expect(userinfo.body).toEqual({ username: 'alice', displayName: 'Alice Admin', roles: ['admin'] });
  });

  it('also accepts JSON bodies with body client credentials (the loose dev client)', async () => {
    const { code } = await approveForCode('carol');
    const res = await request(createApp())
      .post(`${MOUNT}/token`)
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
    const userinfo = await request(createApp())
      .get(`${MOUNT}/userinfo`)
      .set('Authorization', `Bearer ${res.body.access_token}`);
    expect(userinfo.body.username).toBe('carol');
  });

  it('wrong client_secret → 401 invalid_client (OAuth error shape, not the app envelope)', async () => {
    const { code } = await approveForCode('alice');
    const res = await request(createApp())
      .post(`${MOUNT}/token`)
      .set('Authorization', `Basic ${Buffer.from(`${CLIENT_ID}:wrong-secret`).toString('base64')}`)
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(typeof res.body.error_description).toBe('string');
    expect(res.body.error.code).toBeUndefined(); // spec shape: no app envelope nesting
  });

  it('missing client credentials entirely → 401 invalid_client', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/token`)
      .type('form')
      .send({ grant_type: 'authorization_code', code: 'irrelevant', redirect_uri: REDIRECT_URI });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('code replay → 400 invalid_grant (codes are SINGLE-USE)', async () => {
    const { code } = await approveForCode('bob');
    const first = await exchangeForToken(code);
    expect(first.res.status).toBe(200);

    const replay = await exchangeForToken(code);
    expect(replay.res.status).toBe(400);
    expect(replay.res.body.error).toBe('invalid_grant');
    expect(replay.res.body.error_description).toContain('single-use');
  });

  it('an expired code (injected ttl 0) → 400 invalid_grant naming the 60s life', async () => {
    const expired = createAuthorizationCode(
      { username: 'alice', clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scope: 'profile' },
      { ttlMs: 0 },
    );
    const { res } = await exchangeForToken(expired.code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error_description).toContain('expired');
  });

  it('redirect_uri mismatch → 400 invalid_grant (the code is bound to its redirect)', async () => {
    const { code } = await approveForCode('alice', REDIRECT_URI);
    const { res } = await exchangeForToken(code, OTHER_REDIRECT_URI);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error_description).toContain('redirect_uri');
  });

  it('an unknown code → 400 invalid_grant', async () => {
    const { res } = await exchangeForToken('never-issued-code');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('non-authorization_code grants → 400 unsupported_grant_type; missing grant_type → invalid_request', async () => {
    const wrongGrant = await request(createApp())
      .post(`${MOUNT}/token`)
      .set('Authorization', BASIC_AUTH)
      .type('form')
      .send({ grant_type: 'password', code: 'x', redirect_uri: REDIRECT_URI });
    expect(wrongGrant.status).toBe(400);
    expect(wrongGrant.body.error).toBe('unsupported_grant_type');

    const noGrant = await request(createApp())
      .post(`${MOUNT}/token`)
      .set('Authorization', BASIC_AUTH)
      .type('form')
      .send({ code: 'x', redirect_uri: REDIRECT_URI });
    expect(noGrant.status).toBe(400);
    expect(noGrant.body.error).toBe('invalid_request');
  });
});

describe('GET /api/demo/oauth/userinfo — the Bearer-protected resource', () => {
  it('answers 401 without a token, with a garbage token, and with a non-Bearer scheme', async () => {
    const noHeader = await request(createApp()).get(`${MOUNT}/userinfo`);
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.error).toMatchObject({ code: 'unauthorized', scheme: 'bearer' });

    const garbage = await request(createApp())
      .get(`${MOUNT}/userinfo`)
      .set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe('unauthorized');

    const wrongScheme = await request(createApp())
      .get(`${MOUNT}/userinfo`)
      .set('Authorization', 'Basic Zm9vOmJhcg==');
    expect(wrongScheme.status).toBe(401);
  });
});

describe('POST /api/demo/oauth/demo-exchange — the browser demo\'s backend stand-in', () => {
  it('completes the flow in-process: token response + the "your backend does this" note', async () => {
    const { code } = await approveForCode('bob');

    const res = await request(createApp())
      .post(`${MOUNT}/demo-exchange`)
      .send({ code, redirect_uri: REDIRECT_URI });

    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.scope).toBe('profile');
    expect(typeof res.body.access_token).toBe('string');
    expect(res.body.note).toContain('YOUR backend');

    // And the token works against userinfo like any other.
    const userinfo = await request(createApp())
      .get(`${MOUNT}/userinfo`)
      .set('Authorization', `Bearer ${res.body.access_token}`);
    expect(userinfo.body.username).toBe('bob');
  });

  it('burns its code too — a replay through /token afterwards fails', async () => {
    const { code } = await approveForCode('alice');

    const exchange = await request(createApp())
      .post(`${MOUNT}/demo-exchange`)
      .send({ code, redirect_uri: REDIRECT_URI });
    expect(exchange.status).toBe(200);

    const replay = await exchangeForToken(code);
    expect(replay.res.status).toBe(400);
    expect(replay.res.body.error).toBe('invalid_grant');
  });

  it('missing fields → the 400 app envelope (this endpoint is OURS, not the spec\'s)', async () => {
    const res = await request(createApp()).post(`${MOUNT}/demo-exchange`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});
