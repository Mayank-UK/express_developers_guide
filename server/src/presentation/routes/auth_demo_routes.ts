import { Router, type Request, type Response } from 'express';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  ValidationException,
} from '../../core/error_handling/exceptions.js';
import {
  DEMO_USERS,
  findUser,
  findUserByApiKey,
  toPublicUserView,
  verifyDummyPassword,
  verifyPassword,
  type DemoScope,
  type DemoUser,
} from '../../domain/auth/demo_users.js';
import {
  createSession,
  destroySession,
  getSession,
  listSessions,
  toSessionPublicView,
  type StoredSession,
} from '../../domain/auth/session_store.js';
import {
  SESSION_COOKIE_NAME,
  readCookie,
  serializeClearingCookie,
  serializeSessionCookie,
} from '../middleware/cookie_utils.js';
import { createHandmadeRateLimiter } from '../middleware/handmade_rate_limiter.js';
import {
  JWT_DEFAULT_TTL_SECONDS,
  signJwt,
  verifyJwt,
  type JwtPayload,
} from '../../domain/auth/jwt_service.js';
import {
  CREDENTIAL_USERS,
  credentialPasswordHint,
  findCredentialUser,
  hashPassword,
  parsePasswordHash,
  verifyDummyPasswordHash,
  verifyPasswordHash,
} from '../../domain/auth/password_hasher.js';
import {
  createTokenFamily,
  getFamily,
  listFamilies,
  resetRefreshStoreForTests,
  rotateRefreshToken,
} from '../../domain/auth/refresh_store.js';

/**
 * The authentication topic's live demo endpoints — the three credential
 * families PART 1 teaches, over the shared identity fixture (demo_users.ts):
 *
 * Sessions (server-side state + an opaque HttpOnly cookie):
 * - GET  /api/demo/auth/users    → the demo identities for the login picker (password hint INCLUDED — it's the teaching password)
 * - POST /api/demo/auth/login    → {username, password} → Set-Cookie guide_session + {user, session}; wrong creds → 401 (constant-time compare)
 * - POST /api/demo/auth/logout   → destroys the session + clearing cookie; no session → 401
 * - GET  /api/demo/auth/me       → who the cookie says you are; no/invalid session → 401
 * - GET  /api/demo/auth/sessions → the ACTIVE sessions (masked tokens) — server-side state made visible; requires a session
 *
 * API keys (machine identity in a header, scopes per key):
 * - GET  /api/demo/auth/keys           → the demo keys (public teaching material)
 * - GET  /api/demo/auth/api-protected  → requires x-api-key → {user, scopes, scheme}
 * - GET  /api/demo/auth/api-admin      → additionally requires the admin:demos scope → bob's key: 403, alice's: 200
 *
 * JWTs (self-contained signed tokens — the third credential family, PART 2):
 * - POST /api/demo/auth/jwt/issue     → {username, ttlSeconds?} → {token, decoded, expiresAt}; ttl clamped to 1–3600s
 * - POST /api/demo/auth/jwt/verify    → {token} → {valid: true, payload} | {valid: false, reason} — 200 BOTH ways:
 *                                        the verifier panel's verdict is the teaching, not an error state
 * - GET  /api/demo/auth/jwt-protected → Authorization: Bearer <jwt> → {user, issuedAt, expiresAt} or 401
 *
 * Password hashing (the credential-storage lesson, over node:crypto scrypt):
 * - POST /api/demo/auth/hashing/hash    → {password} → {hash, parsed} — the encoded string + a field-by-field parse
 * - POST /api/demo/auth/hashing/verify  → {password, hash} → {matches: boolean}; malformed hash → 400 validation envelope
 * - POST /api/demo/auth/credential/login → {username, password} → session cookie + JWT + first refresh token
 *   (the hashed-password users dana/erin; wrong creds → the SAME generic 401 as the session login)
 *
 * Refresh-token rotation with reuse detection (token families):
 * - POST /api/demo/auth/refresh/rotate        → {refreshToken} → new JWT + NEW refresh token (the old one dies);
 *                                                reuse of a rotated token → family revoked + distinguishable 401
 * - GET  /api/demo/auth/refresh/status/:familyId → the family's chain: every token, which is current, revoked?
 * - GET  /api/demo/auth/refresh/families      → every family (the demo panel's overview)
 * - POST /api/demo/auth/refresh/reset         → clean slate for specs/demos
 *
 * Controllers stay thin: parse input, call the domain fixture/store, map to a
 * response or a typed exception. Failure states ride the app's one error
 * envelope (401 unauthorized / 403 forbidden / 400 validation_failed) — and
 * both POST logins share ONE per-IP rate limit (429 rate_limited through the
 * same envelope, via the security topic's handmade fixed-window limiter).
 */

export const AUTH_DEMO_MOUNT_PATH = '/api/demo/auth';

// --- login rate limiting -----------------------------------------------------------------

/** Login budget per client IP per window — generous on purpose (see below). */
export const AUTH_LOGIN_RATE_LIMIT = 30;
export const AUTH_LOGIN_RATE_WINDOW_MS = 60_000;

/**
 * ONE shared fixed window for BOTH credential families: the fixture login and
 * the hashed-credential login are the same brute-force target, so they draw on
 * the same per-IP budget — switching families mid-attack must not hand out a
 * fresh window.
 */
const loginRateLimiter = createHandmadeRateLimiter({
  windowMs: AUTH_LOGIN_RATE_WINDOW_MS,
  max: AUTH_LOGIN_RATE_LIMIT,
  name: 'POST /api/demo/auth/login + /credential/login',
});

/**
 * TEST HOOK ONLY: wipe the limiter's windows so the spec file can start every
 * case from a clean slate (the security routes expose the same reset for the
 * same reason). Deliberately NOT an HTTP endpoint — a rate limit an attacker
 * can clear over HTTP is not a rate limit; in production the window rolls on
 * its own.
 */
export function resetAuthLoginRateLimiter(): void {
  loginRateLimiter.reset();
}

// --- input parsing ---------------------------------------------------------------------

function parseLoginBody(raw: unknown): { username: string; password: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationException('login payload must be a JSON object', {
      fields: { body: 'must be a JSON object with username and password' },
    });
  }
  const record = raw as Record<string, unknown>;
  const username = record.username;
  const password = record.password;
  if (typeof username !== 'string' || username.length === 0) {
    throw new ValidationException('"username" must be a non-empty string', {
      fields: { username: 'must be a non-empty string' },
    });
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new ValidationException('"password" must be a non-empty string', {
      fields: { password: 'must be a non-empty string' },
    });
  }
  return { username, password };
}

// --- session plumbing ------------------------------------------------------------------

/** Reads the guide_session cookie and resolves it to a LIVE session (null when absent/expired). */
function readLiveSession(req: Request): StoredSession | null {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (token === undefined) return null;
  return getSession(token);
}

/**
 * The user identity a session stands for. Sessions store usernames; identity
 * lives in the fixtures — BOTH of them now (the plaintext demo_users fixture
 * and the hashed-password credential fixture), because the session machinery
 * is shared. A session naming a user who no longer exists is treated as
 * unauthenticated (deleted-user logout, the same rule production needs).
 */
function userForSession(session: StoredSession) {
  const user = findUser(session.username) ?? findCredentialUser(session.username);
  if (user === undefined) {
    throw new UnauthorizedException('the session names a user that no longer exists', {
      scheme: 'session',
    });
  }
  return user;
}

// --- controllers -----------------------------------------------------------------------

function listUsersController(_req: Request, res: Response): void {
  // Password hint included DELIBERATELY: the password is fixed teaching
  // material and the demo's whole point is completing a real login flow.
  // The credential-login fixture rides along with the same policy — its
  // passwords are equally public, while the STORE keeps only scrypt hashes.
  res.status(200).json({
    users: DEMO_USERS.map(toPublicUserView),
    credentialUsers: CREDENTIAL_USERS.map((user) => ({
      username: user.username,
      displayName: user.displayName,
      roles: user.roles,
      passwordHint: credentialPasswordHint(user.username),
    })),
  });
}

function loginController(req: Request, res: Response): void {
  const { username, password } = parseLoginBody(req.body);

  // Timing-equalized verification: an unknown username burns the SAME
  // constant-time compare as a wrong password (see demo_users.ts), so the
  // endpoint cannot be used to enumerate valid usernames by response time.
  const user = findUser(username);
  const passwordOk =
    user !== undefined ? verifyPassword(user, password) : verifyDummyPassword(password);
  if (user === undefined || !passwordOk) {
    // ONE message for both failures — never reveal which half was wrong.
    throw new UnauthorizedException('invalid username or password', { scheme: 'session' });
  }

  const session = createSession(user.username);

  // Hand-rolled Set-Cookie (not res.cookie): the raw header is the lesson —
  // HttpOnly + SameSite=Lax + Path=/, serialized by cookie_utils.ts.
  res.setHeader('Set-Cookie', serializeSessionCookie(SESSION_COOKIE_NAME, session.token));
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    session: {
      expiresAt: new Date(session.expiresAt).toISOString(),
      tokenMasked: toSessionPublicView(session).tokenMasked,
    },
  });
}

function logoutController(req: Request, res: Response): void {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  const session = token === undefined ? null : getSession(token);
  if (token === undefined || session === null) {
    throw new UnauthorizedException('logout requires a valid session cookie', {
      scheme: 'session',
    });
  }

  destroySession(token);
  // Clearing cookie mirrors the setter's attributes (Path et al.) — a
  // mismatch would create a DIFFERENT cookie and leave the original alive.
  res.setHeader('Set-Cookie', serializeClearingCookie(SESSION_COOKIE_NAME));
  res.status(200).json({ loggedOut: true, username: session.username });
}

function meController(req: Request, res: Response): void {
  const session = readLiveSession(req);
  if (session === null) {
    throw new UnauthorizedException('a valid session cookie is required', {
      scheme: 'session',
    });
  }
  const user = userForSession(session);
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    session: toSessionPublicView(session),
  });
}

function listSessionsController(req: Request, res: Response): void {
  // The sessions list itself requires a session — the api-key family has its
  // own endpoints; mixing schemes here would blur the lesson.
  if (readLiveSession(req) === null) {
    throw new UnauthorizedException('a valid session cookie is required', {
      scheme: 'session',
    });
  }
  res.status(200).json({ sessions: listSessions() });
}

function listKeysController(_req: Request, res: Response): void {
  // Deliberately public: fixed demo keys are teaching material, exactly like
  // the password hint. Production hashes keys at rest (content covers how).
  const keys = DEMO_USERS.flatMap((user) =>
    user.apiKeys.map((apiKey) => ({ key: apiKey.key, username: user.username, scopes: apiKey.scopes })),
  );
  res.status(200).json({ keys });
}

/** Resolves the x-api-key header → { user, scopes } or throws the 401. */
function requireApiKey(req: Request): { user: DemoUser; scopes: readonly DemoScope[] } {
  const candidate = req.header('x-api-key');
  if (candidate === undefined || candidate === '') {
    throw new UnauthorizedException('the x-api-key header is required', { scheme: 'api-key' });
  }
  const match = findUserByApiKey(candidate); // constant-time per key
  if (match === undefined) {
    throw new UnauthorizedException('unknown API key', { scheme: 'api-key' });
  }
  return { user: match.user, scopes: match.apiKey.scopes };
}

function apiProtectedController(req: Request, res: Response): void {
  const { user, scopes } = requireApiKey(req);
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    scopes,
    scheme: 'api-key',
  });
}

function apiAdminController(req: Request, res: Response): void {
  const { user, scopes } = requireApiKey(req);
  if (!scopes.includes('admin:demos')) {
    // Authenticated but not permitted — 403, and the envelope says which
    // scope was missing so the failure is watchable, not mysterious.
    throw new ForbiddenException('this endpoint requires the admin:demos scope', {
      requiredScope: 'admin:demos',
      keyScopes: scopes,
      scheme: 'api-key',
    });
  }
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    note: 'the admin:demos scope on this key is what let you in — try bob\'s key and watch the 403',
  });
}

// --- JWT family (PART 2) ----------------------------------------------------------------

/** The ttl bounds for the issue endpoint: 1s (the expiry demo) … 1h. */
const JWT_MIN_TTL_SECONDS = 1;
const JWT_MAX_TTL_SECONDS = 3600;

function parseIssueBody(raw: unknown): { username: string; ttlSeconds: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationException('the JWT issue payload must be a JSON object', {
      fields: { body: 'must be a JSON object with username and optional ttlSeconds' },
    });
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.username !== 'string' || record.username.length === 0) {
    throw new ValidationException('"username" must be a non-empty string', {
      fields: { username: 'must be a non-empty string' },
    });
  }
  let ttlSeconds = JWT_DEFAULT_TTL_SECONDS;
  if (record.ttlSeconds !== undefined) {
    if (typeof record.ttlSeconds !== 'number' || !Number.isFinite(record.ttlSeconds)) {
      throw new ValidationException('"ttlSeconds" must be a number when provided', {
        fields: { ttlSeconds: `a number of seconds, clamped to ${JWT_MIN_TTL_SECONDS}–${JWT_MAX_TTL_SECONDS}` },
      });
    }
    // Clamp, don't reject: the demo lets you dial 1–3600 freely.
    ttlSeconds = Math.min(JWT_MAX_TTL_SECONDS, Math.max(JWT_MIN_TTL_SECONDS, Math.floor(record.ttlSeconds)));
  }
  return { username: record.username, ttlSeconds };
}

function jwtIssueController(req: Request, res: Response): void {
  const { username, ttlSeconds } = parseIssueBody(req.body);
  const user = findUser(username);
  if (user === undefined) {
    throw new ValidationException('unknown username — pick one of the demo users', {
      fields: { username: 'one of alice, bob, carol' },
    });
  }

  const signed = signJwt(user.username, user.roles, ttlSeconds);
  // The token is returned IN FULL, deliberately: a JWT is not a secret — it is
  // signed, not encrypted, and the demo's whole point is reading its parts.
  res.status(200).json({
    token: signed.token,
    decoded: { header: signed.header, payload: signed.payload },
    expiresAt: signed.expiresAt,
  });
}

function jwtVerifyController(req: Request, res: Response): void {
  if (typeof req.body?.token !== 'string' || req.body.token.length === 0) {
    throw new ValidationException('"token" must be a non-empty string', {
      fields: { token: 'the JWT to verify, all three segments' },
    });
  }
  const verified = verifyJwt(req.body.token);
  // 200 BOTH ways: the verdict (and its reason) is the lesson, not an error.
  res.status(200).json(
    verified.ok
      ? { valid: true, payload: verified.value.payload }
      : { valid: false, reason: verified.error.message, reasonCode: verified.error.reason },
  );
}

/** Bearer-JWT authentication for the protected endpoint → the claims, or the 401. */
function requireBearerClaims(req: Request): JwtPayload {
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
  return verified.value.payload;
}

function jwtProtectedController(req: Request, res: Response): void {
  const claims = requireBearerClaims(req);
  // Both fixtures again: a JWT minted by the credential login (dana/erin)
  // resolves the same way one from the demo picker does.
  const user = findUser(claims.sub) ?? findCredentialUser(claims.sub);
  if (user === undefined) {
    throw new UnauthorizedException('the token names a user that no longer exists', {
      scheme: 'bearer',
    });
  }
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    scheme: 'bearer',
  });
}

export const authDemoRouter = Router();
authDemoRouter.get('/demo/auth/users', listUsersController);
// WHY THE LOGINS ARE LIMITED: every login POST is a password guess, so a login
// endpoint is the API's dictionary-attack surface — and the constant-time
// compares + single generic 401 in the controllers stop INFORMATION leaks,
// not VOLUME. The security topic's checklist says it plainly: rate-limit
// anything expensive or authenticate-y, keyed by client, 429 through the one
// error taxonomy. The limiter runs BEFORE the controllers on purpose (even a
// malformed body burns the budget — rejecting early is the cheap path).
// WHY THE LIMIT IS GENEROUS (30/min per IP): this is a public teaching app
// whose demos repeat real logins by design — the goal is slowing enumeration
// and brute force to a crawl, not locking out a classroom. Production tunes
// this far tighter and adds account lockout / step-up auth on top.
authDemoRouter.post('/demo/auth/login', loginRateLimiter, loginController);
authDemoRouter.post('/demo/auth/logout', logoutController);
authDemoRouter.get('/demo/auth/me', meController);
authDemoRouter.get('/demo/auth/sessions', listSessionsController);
authDemoRouter.get('/demo/auth/keys', listKeysController);
authDemoRouter.get('/demo/auth/api-protected', apiProtectedController);
authDemoRouter.get('/demo/auth/api-admin', apiAdminController);
authDemoRouter.post('/demo/auth/jwt/issue', jwtIssueController);
authDemoRouter.post('/demo/auth/jwt/verify', jwtVerifyController);
authDemoRouter.get('/demo/auth/jwt-protected', jwtProtectedController);
authDemoRouter.post('/demo/auth/hashing/hash', hashingHashController);
authDemoRouter.post('/demo/auth/hashing/verify', hashingVerifyController);
// Same SHARED window as the session login — one budget per IP, not per family.
authDemoRouter.post('/demo/auth/credential/login', loginRateLimiter, credentialLoginController);
authDemoRouter.post('/demo/auth/refresh/rotate', refreshRotateController);
authDemoRouter.get('/demo/auth/refresh/status/:familyId', refreshStatusController);
authDemoRouter.get('/demo/auth/refresh/families', refreshFamiliesController);
// Unauthenticated wipe of the refresh-token family store — a deliberate DEMO
// affordance so any visitor can restore the fixture; a production endpoint
// that mutates auth state demands credentials. Never copy this into prod.
authDemoRouter.post('/demo/auth/refresh/reset', refreshResetController);

// --- password hashing playground (PART 3) ----------------------------------------------

/** Parses a non-empty string body field or throws the canonical 400. */
function requireStringField(raw: unknown, field: string): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationException(`payload must be a JSON object`, {
      fields: { body: 'must be a JSON object' },
    });
  }
  const value = (raw as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationException(`"${field}" must be a non-empty string`, {
      fields: { [field]: 'must be a non-empty string' },
    });
  }
  return value;
}

function hashingHashController(req: Request, res: Response): void {
  const password = requireStringField(req.body, 'password');
  const hash = hashPassword(password);
  // The parse rides along so the panel can show the parts — and prove the
  // format round-trips (a hash you cannot parse back is a hash you cannot
  // upgrade later).
  const parsed = parsePasswordHash(hash);
  if (!parsed.ok) {
    // Unreachable by construction (we just encoded it) — but the parse is the
    // contract, and the contract is checked where it holds.
    throw new ValidationException('the freshly encoded hash failed to parse', {
      reason: parsed.error.reason,
    });
  }
  res.status(200).json({
    hash,
    parsed: {
      primitive: parsed.value.primitive,
      N: parsed.value.N,
      r: parsed.value.r,
      p: parsed.value.p,
      saltB64: parsed.value.salt.toString('base64url'),
      hashB64: parsed.value.hash.toString('base64url'),
    },
    note: 'hash the same password twice — new salt, different string; only the params and format stay fixed',
  });
}

function hashingVerifyController(req: Request, res: Response): void {
  const password = requireStringField(req.body, 'password');
  const hash = requireStringField(req.body, 'hash');
  const verdict = verifyPasswordHash(password, hash);
  if (!verdict.ok) {
    // Malformed/mis-used hash strings are a typed validation failure — the
    // mis-use guard. The failure's own details ride the envelope.
    throw new ValidationException(verdict.error.message, {
      reason: verdict.error.reason,
      ...(verdict.error.details ?? {}),
    });
  }
  res.status(200).json({ matches: verdict.value });
}

// --- credential login over hashed passwords + refresh family creation -------------------

function credentialLoginController(req: Request, res: Response): void {
  const { username, password } = parseLoginBody(req.body);

  // The SAME equal-work discipline as the session login, now over scrypt: an
  // unknown username burns a full dummy verify so response time cannot
  // enumerate users — and ONE generic 401 message for both failures, because
  // a login error that says "wrong password" confirms the username exists.
  const user = findCredentialUser(username);
  const verdict = user !== undefined ? verifyPasswordHash(password, user.passwordHash) : undefined;
  const passwordOk =
    verdict === undefined ? verifyDummyPasswordHash(password) : verdict.ok && verdict.value;
  if (user === undefined || !passwordOk) {
    throw new UnauthorizedException('invalid username or password', { scheme: 'credential' });
  }

  // Same machinery the session login uses — the ONLY difference is where the
  // password was verified against (a scrypt hash instead of the fixture).
  const session = createSession(user.username);
  res.setHeader('Set-Cookie', serializeSessionCookie(SESSION_COOKIE_NAME, session.token));
  const signed = signJwt(user.username, user.roles);
  const refresh = createTokenFamily(user.username);

  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    session: {
      expiresAt: new Date(session.expiresAt).toISOString(),
      tokenMasked: toSessionPublicView(session).tokenMasked,
    },
    jwt: { token: signed.token, expiresAt: signed.expiresAt },
    // The raw refresh token crosses the wire exactly once — the store keeps
    // only its sha256, so a response is the only place it can ever appear.
    refresh: {
      familyId: refresh.familyId,
      refreshToken: refresh.token,
      note: 'store this; rotating it mints a new one and kills this one',
    },
  });
}

// --- refresh-token rotation --------------------------------------------------------------

function refreshRotateController(req: Request, res: Response): void {
  const presented = requireStringField(req.body, 'refreshToken');
  const outcome = rotateRefreshToken(presented);

  if (!outcome.ok && outcome.reason === 'unknown_token') {
    throw new UnauthorizedException('unknown refresh token', { scheme: 'refresh', reason: 'unknown_token' });
  }
  if (!outcome.ok && outcome.reason === 'family_revoked') {
    throw new UnauthorizedException('this token family was revoked after reuse was detected — log in again', {
      scheme: 'refresh',
      reason: 'family_revoked',
      familyId: outcome.familyId,
    });
  }
  if (!outcome.ok) {
    // outcome.reason === 'reuse_detected' — the theft signal, distinguishable
    // from the plain 401s above so a client (and the demo panel) can tell
    // "expired/garbage" apart from "somebody replayed an old token".
    throw new UnauthorizedException(
      'refresh token REUSE detected: a previously rotated token was presented — the entire token family is now revoked (theft assumed)',
      {
        scheme: 'refresh',
        reason: 'reuse_detected',
        familyId: outcome.familyId,
        reusedTokenMasked: outcome.reusedTokenMasked,
        revokedTokens: outcome.family.tokens.length,
      },
    );
  }

  const { family, next } = outcome;
  const user = findCredentialUser(family.username) ?? findUser(family.username);
  if (user === undefined) {
    throw new UnauthorizedException('the token family names a user that no longer exists', {
      scheme: 'refresh',
    });
  }
  const signed = signJwt(user.username, user.roles);
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    jwt: { token: signed.token, expiresAt: signed.expiresAt },
    refresh: {
      familyId: next.familyId,
      refreshToken: next.token,
      rotatedFromMasked: family.tokens[family.tokens.length - 2]
        ? family.tokens[family.tokens.length - 2]!.tokenMasked
        : undefined,
      rotationCount: family.tokens.length - 1,
    },
  });
}

function refreshStatusController(req: Request, res: Response): void {
  const familyId = String(req.params.familyId);
  const family = getFamily(familyId);
  if (family === undefined) {
    throw new NotFoundException(`no refresh-token family "${familyId}"`, { familyId });
  }
  res.status(200).json({ family });
}

function refreshFamiliesController(_req: Request, res: Response): void {
  res.status(200).json({ families: listFamilies() });
}

function refreshResetController(_req: Request, res: Response): void {
  resetRefreshStoreForTests();
  res.status(200).json({ reset: true });
}
