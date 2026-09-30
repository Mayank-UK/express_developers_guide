import express, { Router, type Request, type Response } from 'express';
import { UnauthorizedException, ValidationException } from '../../core/error_handling/exceptions.js';
import { constantTimeEquals, findUser } from '../../domain/auth/demo_users.js';
import { signJwt, verifyJwt, JWT_DEFAULT_TTL_SECONDS } from '../../domain/auth/jwt_service.js';
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
} from '../../domain/auth/oauth_store.js';

/**
 * The authentication topic's OAuth 2.0 demo — a COMPLETE local authorization
 * server for the authorization-code flow, on the shared identity fixture:
 *
 * - GET  /api/demo/oauth/authorize          → validates the request, then a
 *   SERVER-RENDERED HTML consent page (the user picker + Approve/Deny). This
 *   is the guide's SSR-flavored route: the decision log keeps SSR in the
 *   curriculum via dedicated Express-rendered routes like this one, not as the
 *   guide shell — a hand-rolled HTML string, minimal inline styles, no assets.
 * - POST /api/demo/oauth/authorize/decision → the consent form's target:
 *   deny → 302 redirect_uri?error=access_denied&state=…; approve → 302
 *   redirect_uri?code=…&state=… (single-use, 60s, bound to user+client+redirect).
 * - POST /api/demo/oauth/token              → the client's BACK-CHANNEL call:
 *   burns the code and returns a JWT access token. Errors here use OAuth's own
 *   {error, error_description} shape, NOT the app envelope — see below.
 * - GET  /api/demo/oauth/userinfo           → Bearer-JWT-protected resource.
 * - POST /api/demo/oauth/demo-exchange      → the browser demo's stand-in for
 *   the confidential client's backend exchange, run in-process with the secret
 *   server-side (in a real app YOUR backend does this exchange).
 *
 * WHY THE TOKEN ENDPOINT DOESN'T USE THE ERROR ENVELOPE: /token is a
 * spec-defined OAuth endpoint that SPEC-FOLLOWING clients call — they parse
 * {error: 'invalid_grant'} per RFC 6749 §5.2 and act on those codes (retry,
 * re-authenticate, give up). Wrapping those errors in a house envelope would
 * break every standards-compliant client library. The rule: OUR app endpoints
 * speak the app envelope; endpoints we implement ON BEHALF OF A SPEC speak the
 * spec's error shape. The authorize/decision endpoints sit between — their
 * audience is a browser form, so validation failures use the app envelope
 * while flow outcomes (deny) ride the redirect.
 */

export const OAUTH_DEMO_MOUNT_PATH = '/api/demo/oauth';

/**
 * The fixed client registration. A real authorization server stores clients in
 * a table with hashed secrets and per-client redirect allowlists; the shape is
 * identical, the storage is teaching-simple.
 */
export const OAUTH_CLIENT = {
  client_id: 'guide_client',
  client_secret: 'guide_demo_secret',
  client_name: 'Guide Demo App',
} as const;

/**
 * The redirect_uri allowlist — exact-match only. This list is the
 * authorization server's open-redirector defense: an unvalidated redirect_uri
 * turns "authorize then redirect" into "send the code to attacker.com", so the
 * value is checked against the registration BEFORE anything is redirected.
 * Both vite-dev origins (:5173) and the server origin (:4000) are registered.
 */
const OAUTH_REDIRECT_URI_ALLOWLIST: readonly string[] = [
  'http://localhost:5173/demos/oauth/callback',
  'http://127.0.0.1:5173/demos/oauth/callback',
  'http://localhost:4000/demos/oauth/callback',
  'http://127.0.0.1:4000/demos/oauth/callback',
];

/** The one scope this server grants. */
const OAUTH_DEMO_SCOPE = 'profile';

// --- shared validation ----------------------------------------------------------------

function isValidRedirectUri(candidate: string): boolean {
  return OAUTH_REDIRECT_URI_ALLOWLIST.includes(candidate);
}

/** Query/body reader that never trusts the shape: one string field or undefined. */
function stringField(source: unknown, name: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Escapes the five characters that matter inside HTML text/attributes. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Appends ?code=…&state=… (or ?error=…&state=…) to an allowed redirect_uri. */
function redirectWithParams(
  redirectUri: string,
  params: Readonly<Record<string, string>>,
): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${redirectUri}?${query}`;
}

// --- act II: the consent page (SSR-flavored) ------------------------------------------

/**
 * Renders the consent page as one HTML string. No template engine, no client
 * bundle — this is what "the authorization server shows you a screen" is: a
 * form that POSTs the user's decision back. Every dynamic value is escaped
 * (the fixture values are fixed, but escaping is the habit that survives).
 */
function renderConsentPage(clientId: string, redirectUri: string, state: string | undefined): string {
  const rows = ['alice', 'bob', 'carol']
    .map((username) => {
      const user = findUser(username)!; // fixture lookup — the picker only offers these
      const id = `user-${user.username}`;
      const checked = username === 'alice' ? ' checked' : '';
      return `<tr>
          <td><input type="radio" id="${id}" name="username" value="${escapeHtml(user.username)}"${checked}></td>
          <td><label for="${id}"><strong>${escapeHtml(user.displayName)}</strong> (@${escapeHtml(user.username)})</label></td>
          <td>${user.roles.map((role) => `<code>${escapeHtml(role)}</code>`).join(' ')}</td>
        </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(OAUTH_CLIENT.client_name)} — express_developers_guide</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #0f172a; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; }
  code { background: #f1f5f9; border-radius: 4px; padding: 0 0.25rem; }
  table { border-collapse: collapse; margin: 1rem 0; width: 100%; }
  td { border-bottom: 1px solid #e2e8f0; padding: 0.5rem 0.5rem 0.5rem 0; text-align: left; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
  button { font: inherit; border-radius: 6px; border: 1px solid #e2e8f0; padding: 0.5rem 1.25rem; cursor: pointer; }
  .approve { background: #4f46e5; border-color: #4f46e5; color: #fff; font-weight: 600; }
  .deny { background: #fff; color: #0f172a; }
  .meta { font-size: 0.85rem; color: #64748b; word-break: break-all; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize ${escapeHtml(OAUTH_CLIENT.client_name)}?</h1>
  <p>The application <strong>${escapeHtml(OAUTH_CLIENT.client_name)}</strong>
     (<code>${escapeHtml(clientId)}</code>) is asking to act on your behalf.</p>
  <p>Requested access: <code>${OAUTH_DEMO_SCOPE}</code> — your profile (username, display
     name, roles). This is the <em>scope</em> you are consenting to.</p>
  <form method="post" action="/api/demo/oauth/authorize/decision">
    <p>Continue as:</p>
    <table>${rows}</table>
    <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
    <div class="actions">
      <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
  <p class="meta">After the decision you are redirected to
     <code>${escapeHtml(redirectUri)}</code> — the redirect_uri registered for this client.</p>
</div>
</body>
</html>`;
}

function authorizeController(req: Request, res: Response): void {
  const responseType = stringField(req.query, 'response_type');
  const clientId = stringField(req.query, 'client_id');
  const redirectUri = stringField(req.query, 'redirect_uri');
  const state = stringField(req.query, 'state');

  if (clientId !== OAUTH_CLIENT.client_id) {
    throw new ValidationException('unknown client_id — this demo server has one registered client', {
      parameter: 'client_id',
      expected: OAUTH_CLIENT.client_id,
    });
  }
  // The open-redirector guard: validate BEFORE redirecting anything.
  if (redirectUri === undefined || !isValidRedirectUri(redirectUri)) {
    throw new ValidationException(
      'redirect_uri is not registered for this client (exact-match allowlist)',
      { parameter: 'redirect_uri', allowed: [...OAUTH_REDIRECT_URI_ALLOWLIST] },
    );
  }
  if (responseType !== 'code') {
    throw new ValidationException(
      'response_type must be "code" — this demo implements the authorization-code flow only',
      { parameter: 'response_type', expected: 'code' },
    );
  }

  // Content-Type set explicitly: the teaching point is that THIS route returns
  // HTML, not JSON — a server-rendered page from the same Express app.
  res.status(200).type('html').send(renderConsentPage(clientId, redirectUri, state));
}

function authorizeDecisionController(req: Request, res: Response): void {
  const username = stringField(req.body, 'username');
  const decision = stringField(req.body, 'decision');
  const clientId = stringField(req.body, 'client_id');
  const redirectUri = stringField(req.body, 'redirect_uri');
  const state = stringField(req.body, 'state');

  if (clientId !== OAUTH_CLIENT.client_id) {
    throw new ValidationException('unknown client_id', { parameter: 'client_id' });
  }
  if (redirectUri === undefined || !isValidRedirectUri(redirectUri)) {
    throw new ValidationException(
      'redirect_uri is not registered for this client (exact-match allowlist)',
      { parameter: 'redirect_uri', allowed: [...OAUTH_REDIRECT_URI_ALLOWLIST] },
    );
  }
  if (decision !== 'approve' && decision !== 'deny') {
    throw new ValidationException('decision must be "approve" or "deny"', {
      parameter: 'decision',
    });
  }

  if (decision === 'deny') {
    // The RFC's shape: the error rides the redirect, so the CLIENT app sees
    // the denial — this is how "cancel" on real consent screens works.
    res.redirect(302, redirectWithParams(redirectUri, {
      error: 'access_denied',
      ...(state !== undefined && state !== '' && { state }),
    }));
    return;
  }

  const user = username !== undefined ? findUser(username) : undefined;
  if (user === undefined) {
    throw new ValidationException('pick one of the demo users', { parameter: 'username' });
  }

  const code = createAuthorizationCode({
    username: user.username,
    clientId,
    redirectUri,
    scope: OAUTH_DEMO_SCOPE,
  });
  res.redirect(302, redirectWithParams(redirectUri, {
    code: code.code,
    ...(state !== undefined && state !== '' && { state }),
  }));
}

// --- act III: the token endpoint (back channel) ----------------------------------------

/** OAuth's own error shape (RFC 6749 §5.2) — see the file header for WHY. */
function oauthError(res: Response, status: number, error: string, description: string): void {
  // Cache-Control: no-store is the token-endpoint requirement (§5.1) — tokens
  // must never sit in a shared cache.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(status).json({ error, error_description: description });
}

/** Basic-auth credentials from the Authorization header, if present and well-formed. */
function basicCredentials(
  header: string | undefined,
): { clientId: string; clientSecret: string } | null {
  if (header === undefined || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorAt = decoded.indexOf(':');
    if (separatorAt < 0) return null;
    return { clientId: decoded.slice(0, separatorAt), clientSecret: decoded.slice(separatorAt + 1) };
  } catch {
    return null;
  }
}

/** The exchange itself — shared by /token (client-authenticated) and demo-exchange. */
function exchangeCode(code: string, redirectUri: string):
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string; description: string } {
  const consumed = consumeAuthorizationCode(code);
  if (!consumed.ok) {
    const descriptions = {
      unknown: 'unknown authorization code',
      used: 'authorization code already used — codes are single-use by design',
      expired: 'authorization code expired (they live 60 seconds)',
    } as const;
    return { ok: false, status: 400, error: 'invalid_grant', description: descriptions[consumed.reason] };
  }
  const stored = consumed.code;

  // The binding checks: the code is only cashable by the client it was issued
  // to, over the redirect it bounced through.
  if (stored.clientId !== OAUTH_CLIENT.client_id) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'the code was issued to a different client' };
  }
  if (stored.redirectUri !== redirectUri) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'redirect_uri does not match the authorization request' };
  }

  const user = findUser(stored.username);
  if (user === undefined) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'the code names a user that no longer exists' };
  }

  const signed = signJwt(user.username, user.roles, JWT_DEFAULT_TTL_SECONDS);
  return {
    ok: true,
    body: {
      access_token: signed.token,
      token_type: 'Bearer',
      expires_in: JWT_DEFAULT_TTL_SECONDS,
      scope: stored.scope,
    },
  };
}

function tokenController(req: Request, res: Response): void {
  // Client authentication: HTTP Basic (the RFC's preferred method) OR body
  // credentials (form or JSON — both arrive parsed on req.body). The secret
  // compare is constant-time, same as every other secret in this topic.
  const basic = basicCredentials(req.headers.authorization);
  const clientId = basic?.clientId ?? stringField(req.body, 'client_id');
  const clientSecret = basic?.clientSecret ?? stringField(req.body, 'client_secret');

  const clientKnown =
    clientId === OAUTH_CLIENT.client_id &&
    clientSecret !== undefined &&
    constantTimeEquals(clientSecret, OAUTH_CLIENT.client_secret);
  if (!clientKnown) {
    // 401 + invalid_client is the RFC's contract for failed client auth.
    oauthError(res, 401, 'invalid_client', 'client authentication failed (unknown client or wrong client_secret)');
    return;
  }

  const grantType = stringField(req.body, 'grant_type');
  if (grantType === undefined) {
    oauthError(res, 400, 'invalid_request', 'grant_type is required');
    return;
  }
  if (grantType !== 'authorization_code') {
    oauthError(res, 400, 'unsupported_grant_type', 'this demo implements authorization_code only');
    return;
  }

  const code = stringField(req.body, 'code');
  const redirectUri = stringField(req.body, 'redirect_uri');
  if (code === undefined || redirectUri === undefined) {
    oauthError(res, 400, 'invalid_request', 'code and redirect_uri are required');
    return;
  }

  const outcome = exchangeCode(code, redirectUri);
  if (!outcome.ok) {
    oauthError(res, outcome.status, outcome.error, outcome.description);
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(200).json(outcome.body);
}

// --- act IV: the protected resource ----------------------------------------------------

/** Bearer extraction + JWT verification → the claims, or the 401 envelope (an app endpoint). */
function requireBearerJwt(req: Request): { username: string; displayName: string; roles: string[] } {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) {
    throw new UnauthorizedException('the Authorization: Bearer <token> header is required', {
      scheme: 'bearer',
    });
  }
  const verified = verifyJwt(header.slice('Bearer '.length));
  if (!verified.ok) {
    throw new UnauthorizedException(verified.error.message, {
      scheme: 'bearer',
      reason: verified.error.reason,
    });
  }
  const user = findUser(verified.value.payload.sub);
  if (user === undefined) {
    throw new UnauthorizedException('the token names a user that no longer exists', {
      scheme: 'bearer',
    });
  }
  return { username: user.username, displayName: user.displayName, roles: [...user.roles] };
}

function userinfoController(req: Request, res: Response): void {
  const identity = requireBearerJwt(req);
  res.status(200).json({
    username: identity.username,
    displayName: identity.displayName,
    roles: identity.roles,
  });
}

/**
 * The demo's stand-in for the confidential client's BACKEND exchange: performs
 * the token call in-process, with the client_secret applied server-side, so
 * the browser demo completes the flow honestly without ever shipping the
 * secret to the browser. In a real app, YOUR backend is this code — the
 * browser only ever sees the access token it gets back.
 */
function demoExchangeController(req: Request, res: Response): void {
  const code = stringField(req.body, 'code');
  const redirectUri = stringField(req.body, 'redirect_uri');
  if (code === undefined || redirectUri === undefined) {
    throw new ValidationException('code and redirect_uri are required', {
      fields: { code: 'string', redirect_uri: 'the registered callback URL' },
    });
  }

  const outcome = exchangeCode(code, redirectUri);
  if (!outcome.ok) {
    // Same OAuth error shape as /token: this IS the token exchange, just run
    // in-process — a spec-following client would surface exactly this body.
    oauthError(res, outcome.status, outcome.error, outcome.description);
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ...outcome.body,
    note: 'performed in-process by the guide server playing your backend — in a real app YOUR backend makes this exchange (POST /api/demo/oauth/token with the client_secret) so the secret never reaches the browser',
  });
}

export const oauthDemoRouter = Router();
// The consent form POSTs form-encoded, and spec-style token requests are
// form-encoded too (RFC 6749 §4.1.3) — the root app only parses JSON, so this
// router owns its urlencoded parser (scoped to /api/demo/oauth/* only).
oauthDemoRouter.use(express.urlencoded({ extended: false }));
oauthDemoRouter.get('/demo/oauth/authorize', authorizeController);
oauthDemoRouter.post('/demo/oauth/authorize/decision', authorizeDecisionController);
oauthDemoRouter.post('/demo/oauth/token', tokenController);
oauthDemoRouter.get('/demo/oauth/userinfo', userinfoController);
oauthDemoRouter.post('/demo/oauth/demo-exchange', demoExchangeController);
