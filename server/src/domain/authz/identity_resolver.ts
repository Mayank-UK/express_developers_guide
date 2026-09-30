import { findUser, findUserByApiKey } from '../auth/demo_users.js';
import { getSession } from '../auth/session_store.js';
import { verifyJwt } from '../auth/jwt_service.js';

/**
 * The unified identity resolver — the hinge between the authentication topic
 * (PART 1 built three credential families) and this one (authorization only
 * cares about WHO the caller resolved to). One function turns any of the
 * three credentials into the same shape every guard downstream consumes:
 *
 *   { username, roles, scheme } | null
 *
 * PRECEDENCE, deliberately fixed and documented: session cookie first (the
 * browser's native credential — if a valid cookie is present it speaks for
 * the tab), then the x-api-key header (machine callers), then the Bearer JWT
 * (token callers). Only the FIRST matching scheme is consulted, so a request
 * cannot blend identities from two credentials — one caller, one identity.
 * Real systems often NARROW this to one scheme per endpoint (the choosing
 * section of the authentication topic explains why); the resolver accepting
 * all three is what lets this demo drive the SAME authorization matrix from
 * a browser session, a terminal key, and a token.
 *
 * Note on roles: they come from the USER RECORD (the live fixture), not from
 * the credential — a session stores only a username, and a JWT's roles claim
 * is a snapshot from issue time. Resolving through the live record means a
 * role change takes effect on the next request for sessions and keys; a JWT
 * keeps speaking its issue-time claims until it expires (the staleness trade
 * the authentication topic taught, visible here as a real design decision).
 *
 * THE DOMAIN SPEAKS ITS OWN LANGUAGE: this module takes no Express type. The
 * resolver reads exactly three header slots, so THAT is the whole contract —
 * declared below as IdentitySource, a structural type this layer owns. An
 * Express Request satisfies it structurally (routes keep passing req
 * unchanged), but the dependency arrow stays one-way: zero imports from the
 * framework in this file, and the "adapter" at the edge is the type system.
 */

/** What every authz guard consumes — scheme rides along for honest 401s. */
export interface ResolvedIdentity {
  readonly username: string;
  readonly roles: readonly string[];
  /** Which credential family proved the identity: 'session' | 'api-key' | 'bearer'. */
  readonly scheme: 'session' | 'api-key' | 'bearer';
}

/**
 * The session cookie's name, mirrored from presentation/middleware/cookie_utils.ts
 * (its presentation-side owner — this module is DOMAIN and must not import
 * from the presentation layer; the dependency arrow only points one way).
 * The two constants are pinned together by the spec that asserts both ends
 * agree, so a rename cannot drift silently.
 */
const SESSION_COOKIE_NAME = 'guide_session';

/** Extracts one cookie's value from a raw Cookie header (no attributes, no throws). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined;
  for (const rawPair of header.split(';')) {
    const pair = rawPair.trim();
    const equalsAt = pair.indexOf('=');
    if (equalsAt <= 0) continue;
    if (pair.slice(0, equalsAt).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(equalsAt + 1).trim());
    } catch {
      return pair.slice(equalsAt + 1).trim();
    }
  }
  return undefined;
}

/**
 * What the resolver needs from an incoming request — the DOMAIN's structural
 * type, not the framework's Request. The function below reads exactly three
 * header slots and nothing else, so that is the entire contract: an Express
 * req satisfies it as-is (structural typing is the adapter), which keeps this
 * file free of framework imports while routes keep passing their req.
 */
export interface IdentitySource {
  readonly headers: {
    readonly cookie?: string;
    readonly authorization?: string;
    readonly 'x-api-key'?: string | readonly string[];
  };
}

/**
 * Resolves the caller's identity from whichever credential family the request
 * carries. Returns null when NO credential resolves — the caller decides
 * whether that is a 401 (a protected route) or an anonymous path.
 */
export function resolveRequestIdentity(req: IdentitySource): ResolvedIdentity | null {
  // 1 — session cookie: opaque token → store lookup → the fixture's user.
  const cookieToken = cookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
  if (cookieToken !== undefined) {
    const session = getSession(cookieToken);
    if (session !== null) {
      const user = findUser(session.username);
      if (user !== undefined) {
        return { username: user.username, roles: user.roles, scheme: 'session' };
      }
    }
  }

  // 2 — API key: the header resolves to a user directly (constant-time match).
  // (Node lowercases header names; req.header() is the same lookup with sugar.)
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey !== '') {
    const match = findUserByApiKey(apiKey);
    if (match !== undefined) {
      return { username: match.user.username, roles: match.user.roles, scheme: 'api-key' };
    }
  }

  // 3 — Bearer JWT: verify signature/expiry, then resolve the subject LIVE.
  const authorization = req.headers.authorization;
  if (authorization !== undefined && authorization.startsWith('Bearer ')) {
    const verified = verifyJwt(authorization.slice('Bearer '.length));
    if (verified.ok) {
      const user = findUser(verified.value.payload.sub);
      if (user !== undefined) {
        return { username: user.username, roles: user.roles, scheme: 'bearer' };
      }
    }
  }

  return null;
}
