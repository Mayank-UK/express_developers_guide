import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The shared identity fixture for the auth demos (and, later, the whole
 * authorization topic): three fixed demo users with roles and per-user API
 * keys. Everything here is DELIBERATELY public teaching material — fixed
 * passwords, fixed key strings — because the lesson is the MECHANISM, not the
 * secrecy. Production shape is taught alongside (hash passwords with bcrypt/
 * argon2; store only a hash + lookup prefix for API keys).
 */

/** What an API key may do — checked per endpoint, so keys outrank sessions in granularity. */
export type DemoScope = 'read:profile' | 'write:profile' | 'admin:demos';

/** The roles the authorization topic will gate on. */
export type DemoRole = 'admin' | 'editor' | 'viewer';

export interface DemoApiKey {
  /** Fixed demo key. The gsk_ prefix mirrors real vendor conventions (stripe's sk_). */
  readonly key: string;
  readonly scopes: readonly DemoScope[];
}

export interface DemoUser {
  readonly username: string;
  readonly displayName: string;
  /** The fixed teaching password — every demo user shares it. */
  readonly password: string;
  readonly roles: readonly DemoRole[];
  readonly apiKeys: readonly DemoApiKey[];
}

/**
 * The demo population. `gsk_` reads "guide secret key"; the `_demo_` segment
 * marks these as teaching fixtures that could never be mistaken for a real
 * production secret in a log or a leak.
 */
export const DEMO_USERS: readonly DemoUser[] = [
  {
    username: 'alice',
    displayName: 'Alice Admin',
    password: 'guide-demo-pw',
    roles: ['admin'],
    apiKeys: [
      {
        key: 'gsk_demo_alice_2mFnQ7xK',
        scopes: ['read:profile', 'write:profile', 'admin:demos'],
      },
    ],
  },
  {
    username: 'bob',
    displayName: 'Bob Builder',
    password: 'guide-demo-pw',
    roles: ['editor'],
    apiKeys: [
      { key: 'gsk_demo_bob_3kQw9zRt', scopes: ['read:profile', 'write:profile'] },
    ],
  },
  {
    username: 'carol',
    displayName: 'Carol Reader',
    password: 'guide-demo-pw',
    roles: ['viewer'],
    apiKeys: [{ key: 'gsk_demo_carol_8vXp4mLb', scopes: ['read:profile'] }],
  },
];

/** What the login form's user picker needs — password included, deliberately (fixed teaching value). */
export interface DemoUserPublicView {
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly DemoRole[];
  /** The fixed teaching password, shown because completing a login flow is the demo's whole point. */
  readonly passwordHint: string;
}

export function toPublicUserView(user: DemoUser): DemoUserPublicView {
  return {
    username: user.username,
    displayName: user.displayName,
    roles: user.roles,
    passwordHint: user.password,
  };
}

/** Exact-match username lookup. */
export function findUser(username: string): DemoUser | undefined {
  return DEMO_USERS.find((user) => user.username === username);
}

export interface ApiKeyMatch {
  readonly user: DemoUser;
  readonly apiKey: DemoApiKey;
}

/**
 * API-key lookup. Every key in the fixture is compared in constant time so
 * the search itself leaks nothing about WHERE (or whether) a prefix matched.
 */
export function findUserByApiKey(candidate: string): ApiKeyMatch | undefined {
  for (const user of DEMO_USERS) {
    for (const apiKey of user.apiKeys) {
      if (constantTimeEquals(candidate, apiKey.key)) {
        return { user, apiKey };
      }
    }
  }
  return undefined;
}

/**
 * Constant-time string equality: BOTH sides are hashed to a fixed length
 * first, then compared with node:crypto's timingSafeEqual. Hashing solves the
 * two traps of a naive timingSafeEqual(a, b) over raw strings:
 * (1) timingSafeEqual THROWS when the buffers differ in length — catching that
 *     leak would reintroduce the timing signal through the error path;
 * (2) comparing raw bytes leaks the LENGTH of the expected secret via how much
 *     of the candidate got compared before bailing (the classic timing attack:
 *     measure response times to recover a secret byte by byte — same lesson as
 *     the webhooks topic's HMAC compare).
 * sha256 digests are always 32 bytes, so both compare paths — match and
 * mismatch, equal lengths and not — run in indistinguishable time.
 */
export function constantTimeEquals(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

/**
 * A dummy digest compared when the USERNAME is unknown, so "no such user"
 * burns the same constant-time compare as "wrong password" — otherwise the
 * login endpoint would let an attacker enumerate valid usernames by timing.
 */
const DUMMY_PASSWORD = 'timing-attack-decoy-value';

/** Constant-time password check for a KNOWN user. */
export function verifyPassword(user: DemoUser, candidate: string): boolean {
  return constantTimeEquals(candidate, user.password);
}

/** The equal-work fallback for unknown usernames (see DUMMY_PASSWORD). */
export function verifyDummyPassword(candidate: string): boolean {
  return constantTimeEquals(candidate, DUMMY_PASSWORD);
}
