import { randomBytes } from 'node:crypto';

/**
 * A hand-rolled, in-memory session store — deliberately NOT express-session,
 * because the session mechanism itself is the lesson. Express-session gets its
 * catalog mention in the topic content.
 *
 * The trade this store makes on purpose: in-memory state is PER-PROCESS, so a
 * second app replica would not see these sessions (the production path is a
 * shared store — Redis with TTLs, exactly what the Redis topic builds). Every
 * response that echoes a session echoes a MASKED token; the real 32-byte
 * urlsafe token crosses the wire exactly once, inside the Set-Cookie header.
 */

/** Sessions live 30 minutes from creation. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard cap — the oldest session is evicted when the store is full. */
export const MAX_SESSIONS = 100;

export interface StoredSession {
  /** The opaque bearer token — 32 random bytes, urlsafe base64. Kept ONLY in the store + the cookie. */
  readonly token: string;
  /** The authenticated username — identity itself lives in demo_users, not here. */
  readonly username: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}
/** What any response may echo about a session — no full token, ever. */
export interface SessionPublicView {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly tokenMasked: string;
}

/** listSessions() rows — server-side state made visible, safely. */
export interface SessionListEntry extends SessionPublicView {
  readonly username: string;
}

/** `…` + the last 4 characters — enough to recognize YOUR session, not enough to replay it. */
export function maskSessionToken(token: string): string {
  return `…${token.slice(-4)}`;
}

export function toSessionPublicView(session: StoredSession): SessionPublicView {
  return {
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    tokenMasked: maskSessionToken(session.token),
  };
}

/**
 * Injection point for the expiry tests (and only them): production callers
 * omit `ttlMs` and get the 30-minute default; a test may pass 0 to create a
 * session that is expired the instant it exists — no fake clocks needed.
 */
export interface CreateSessionOptions {
  readonly ttlMs?: number;
}

const sessions = new Map<string, StoredSession>();

/**
 * Creates a session for a logged-in username. Expired entries are swept first
 * (auto-cleanup — Map insertion order makes the sweep a single pass), then the
 * store enforces its cap by evicting the OLDEST surviving session.
 */
export function createSession(
  username: string,
  options: CreateSessionOptions = {},
): StoredSession {
  sweepExpiredSessions();

  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }

  const createdAt = Date.now();
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const session: StoredSession = {
    token: randomBytes(32).toString('base64url'),
    username,
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
  sessions.set(session.token, session);
  return session;
}

/**
 * Looks a session up by bearer token with LAZY EXPIRY: an expired session is
 * deleted the moment it is touched, then reported as absent. No timer runs —
 * the store stays correct with nothing more than this check (plus the sweep
 * on create), which is exactly how a Redis-backed store behaves with TTLs.
 */
export function getSession(token: string): StoredSession | null {
  const session = sessions.get(token);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

/** Destroys a session (logout). Returns whether there was one to destroy. */
export function destroySession(token: string): boolean {
  return sessions.delete(token);
}

/** Active sessions as safe rows: masked tokens, who, when. Expired entries are swept first. */
export function listSessions(): SessionListEntry[] {
  sweepExpiredSessions();
  return [...sessions.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((session) => ({
      username: session.username,
      ...toSessionPublicView(session),
    }));
}

/** Deletes every entry whose expiry has passed — lazy cleanup at creation/list time. */
function sweepExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

/** Test-only: the raw entry count, proving lazy expiry actually DELETES (not just filters). */
export function __storeSizeForTests(): number {
  return sessions.size;
}

/** Test-only: a clean slate between cases. */
export function resetSessionStoreForTests(): void {
  sessions.clear();
}
