import { randomBytes } from 'node:crypto';

/**
 * The OAuth demo's authorization-code store — the authorization server's
 * short-lived memory between "user consented" and "client exchanged the code".
 *
 * Two rules the store itself enforces, because they are the lesson:
 * (1) SINGLE USE — a code is BURNED on first exchange and moved to a
 *     used-code registry; replaying it answers 'used'. The authorization code
 *     is a one-time handshake proof, not a credential — if it were reusable,
 *     anyone who saw the redirect URL (browser history, referrer logs) could
 *     mint tokens with it.
 * (2) SHORT LIFE — 60 seconds, and bound to username + client_id +
 *     redirect_uri at creation, so a code stolen from one client/redirect
 *     cannot be cashed by another.
 */

/** Authorization codes live 60 seconds — plenty for the redirect + exchange. */
export const OAUTH_CODE_TTL_MS = 60 * 1000;

/** What gets stored per issued code. */
export interface StoredAuthorizationCode {
  readonly code: string;
  /** The consenting user — becomes the token's `sub`. */
  readonly username: string;
  /** The client the code was issued TO (checked again at exchange). */
  readonly clientId: string;
  /** The exact redirect_uri the code bounced through (checked at exchange). */
  readonly redirectUri: string;
  /** What was consented to. The demo grants 'profile' wholesale. */
  readonly scope: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Injection point for the expiry tests (and only them) — same pattern as the
 * session store: a test passes ttlMs: 0 for a code that is born expired.
 */
export interface CreateAuthorizationCodeOptions {
  readonly ttlMs?: number;
}

/** Why a consume attempt refused the code — distinct error_descriptions in HTTP. */
export type ConsumeFailureReason = 'unknown' | 'used' | 'expired';

export type ConsumeAuthorizationCodeResult =
  | { ok: true; code: StoredAuthorizationCode }
  | { ok: false; reason: ConsumeFailureReason };

/** Active (unexchanged) codes by value. */
const activeCodes = new Map<string, StoredAuthorizationCode>();
/** The used-code registry: burned values, so a replay is TOLD it was a replay. */
const usedCodes = new Set<string>();

/**
 * Issues a single-use code bound to username + client + redirect_uri.
 * 16 random bytes, urlsafe — unguessable, opaque, exactly like a session token.
 */
export function createAuthorizationCode(
  input: Omit<StoredAuthorizationCode, 'code' | 'createdAt' | 'expiresAt'>,
  options: CreateAuthorizationCodeOptions = {},
): StoredAuthorizationCode {
  const createdAt = Date.now();
  const stored: StoredAuthorizationCode = {
    ...input,
    code: randomBytes(16).toString('base64url'),
    createdAt,
    expiresAt: createdAt + (options.ttlMs ?? OAUTH_CODE_TTL_MS),
  };
  activeCodes.set(stored.code, stored);
  return stored;
}

/**
 * The exchange: validates, then BURNS. Returns the stored code on success —
 * after deleting it from the active map and recording it in the used registry,
 * so a second consume of the same value answers 'used'. An expired code is
 * deleted (lazy expiry, like the session store) and answers 'expired'.
 */
export function consumeAuthorizationCode(code: string): ConsumeAuthorizationCodeResult {
  if (usedCodes.has(code)) {
    return { ok: false, reason: 'used' };
  }
  const stored = activeCodes.get(code);
  if (stored === undefined) {
    return { ok: false, reason: 'unknown' };
  }
  if (stored.expiresAt <= Date.now()) {
    activeCodes.delete(code);
    usedCodes.add(code); // a dead code can never come back either
    return { ok: false, reason: 'expired' };
  }
  activeCodes.delete(code);
  usedCodes.add(code);
  return { ok: true, code: stored };
}

/** Test-only: the active (unexchanged) count, for the single-use specs. */
export function __activeCodeCountForTests(): number {
  return activeCodes.size;
}

/** Test-only: a clean slate between cases. */
export function resetOAuthStoreForTests(): void {
  activeCodes.clear();
  usedCodes.clear();
}
