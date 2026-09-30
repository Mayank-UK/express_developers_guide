import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import { ok, type Result } from '../../core/result/result.js';

/**
 * A hand-rolled scrypt password hasher — deliberately NOT bcrypt/argon2
 * (those are native modules; the topic's catalog mentions them), because the
 * ENCODED HASH FORMAT and the verify discipline are the lesson, and node:crypto
 * ships scrypt in the standard library. The encoded string is a PHC-style
 * cousin, chosen to be readable while teaching the same fields every real
 * format carries:
 *
 *   scrypt$32768$8$1$c2FsdHNhbHQ$aGFzaA  =  <primitive>$N$r$p$<saltB64>$<hashB64>
 *
 * The leading `scrypt` token is the FORMAT VERSION as much as the primitive
 * name: the verifier dispatches on it, so a future upgrade (argon2id, or
 * scrypt with new cost parameters as the default) ships a NEW prefix and
 * upgrades hashes lazily at next successful login — the migration lesson.
 * Until then, an unknown prefix is a typed validation failure, never a crash.
 */

/**
 * COST PARAMETERS — chosen deliberately, not inherited from a default:
 *
 * - N = 2^15 (32768): the CPU/memory cost. Each doubling DOUBLES the work an
 *   attacker must burn per password guess; 2^15 needs 128·N·r = 32 MiB of
 *   memory and ~50–250ms per hash (machine-dependent — measured ~250ms in this
 *   devcontainer), which sits in OWASP's recommended interactive-login band.
 *   Too cheap (2^10 ≈ instant) and offline cracking becomes trivial; too
 *   expensive and login latency hurts. Cost is a dial you own.
 * - r = 8, p = 1: the memory block size and parallelism. r scales memory with
 *   N; p>1 only helps when cores are idle — for a server login, p=1 keeps the
 *   memory cost (the part GPUs hate) maximal for the same wall time.
 * - keylen 32 bytes (256 bits): matches the digest width timingSafeEqual
 *   compares — equal length BY CONSTRUCTION, never an accident.
 *
 * GOTCHA this code encodes on purpose: node's scrypt defaults maxmem to 32 MiB
 * and OpenSSL's check is 128·r·(N + 2p), so N=2^15,r=8 THROWS "memory limit
 * exceeded" with the default — the explicit maxmem below is required, not
 * decorative. Raise N further and you must raise maxmem with it.
 */
export const SCRYPT_COST = { N: 2 ** 15, r: 8, p: 1 } as const;
/** 64 MiB — headroom above 128·r·(N+2p) for the params above (see header). */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** Random salt bytes per hash — 128 bits, so rainbow tables never amortize. */
const SALT_BYTES = 16;
/** Derived key length — 32 bytes, fixed, so timingSafeEqual inputs always match. */
const KEY_BYTES = 32;

/** Everything verify needs, parsed out of the encoded string. */
export interface ParsedPasswordHash {
  /** The primitive/format token — today always 'scrypt' (the upgrade hook). */
  readonly primitive: string;
  /** CPU/memory cost. */
  readonly N: number;
  /** Memory block size. */
  readonly r: number;
  /** Parallelization. */
  readonly p: number;
  /** Salt bytes. */
  readonly salt: Buffer;
  /** Expected derived key bytes. */
  readonly hash: Buffer;
}

/**
 * Bounds applied when PARSING a hash string (which is attacker-controlled the
 * moment hashes leave this module — e.g. the verify playground): params inside
 * these bounds are honored so old hashes stay verifiable after a cost upgrade;
 * params beyond them are rejected before scrypt ever runs, because a crafted
 * `N=2^30` string would otherwise be a self-DoS button.
 */
const PARSE_LIMITS = {
  minN: 2,
  maxN: 2 ** 20,
  maxR: 32,
  maxP: 8,
  maxSaltBytes: 64,
} as const;

export type PasswordHashFailureReason = 'malformed' | 'unsupported_primitive' | 'bad_parameters';

export interface PasswordHashFailure extends Failure {
  readonly reason: PasswordHashFailureReason;
}

function hashFail(
  reason: PasswordHashFailureReason,
  message: string,
  details?: Record<string, unknown>,
): Result<never, PasswordHashFailure> {
  return {
    ok: false,
    error: { ...failure('validation', message, details), reason },
  };
}

/** Derives the scrypt key for a candidate password over the given salt + params. */
function derive(candidate: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(candidate, salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

/**
 * Hashes a password: fresh 16-byte random salt, deliberate cost params,
 * encoded as `scrypt$N$r$p$saltB64url$hashB64url`. Two calls with the SAME
 * password produce DIFFERENT strings (new salt) — the demo panel's point.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(password, salt, SCRYPT_COST.N, SCRYPT_COST.r, SCRYPT_COST.p);
  return encodeHash('scrypt', SCRYPT_COST.N, SCRYPT_COST.r, SCRYPT_COST.p, salt, hash);
}

function encodeHash(
  primitive: string,
  N: number,
  r: number,
  p: number,
  salt: Buffer,
  hash: Buffer,
): string {
  return [
    primitive,
    String(N),
    String(r),
    String(p),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/**
 * Parses an encoded hash back into its parts — the round-trip half of the
 * format lesson (a hash you cannot parse is a hash you cannot upgrade). Every
 * field is validated: unknown primitive → 'unsupported_primitive' (the future
 * argon2id/scrypt2 migration would land here), wrong shape → 'malformed',
 * out-of-bounds params or wrong key length → 'bad_parameters'. Never throws.
 */
export function parsePasswordHash(encoded: string): Result<ParsedPasswordHash, PasswordHashFailure> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.some((part) => part === '')) {
    return hashFail(
      'malformed',
      'malformed hash: expected "scrypt$N$r$p$saltB64url$hashB64url" (six non-empty $-separated fields)',
      { received: encoded.slice(0, 80) },
    );
  }
  const [primitive, nText, rText, pText, saltText, hashText] = parts;

  if (primitive !== 'scrypt') {
    return hashFail(
      'unsupported_primitive',
      `unknown hash primitive "${primitive}" — this verifier reads scrypt only (the version prefix is the upgrade hook)`,
      { primitive },
    );
  }

  if (!/^\d+$/.test(nText) || !/^\d+$/.test(rText) || !/^\d+$/.test(pText)) {
    return hashFail('bad_parameters', 'malformed hash: N, r and p must be decimal integers', {
      received: `N=${nText} r=${rText} p=${pText}`,
    });
  }
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (N < PARSE_LIMITS.minN || N > PARSE_LIMITS.maxN || r < 1 || r > PARSE_LIMITS.maxR || p < 1 || p > PARSE_LIMITS.maxP) {
    return hashFail(
      'bad_parameters',
      `refusing hash parameters N=${nText} r=${rText} p=${pText} — outside the honored bounds (N ≤ ${String(PARSE_LIMITS.maxN)}, r ≤ ${String(PARSE_LIMITS.maxR)}, p ≤ ${String(PARSE_LIMITS.maxP)}); a crafted hash string is attacker input, and running it would be a self-DoS`,
      { N, r, p },
    );
  }
  // scrypt requires N to be a power of two; anything else fails deep inside
  // OpenSSL with a cryptic error — reject it here with a readable one.
  if ((N & (N - 1)) !== 0) {
    return hashFail('bad_parameters', `scrypt N must be a power of two (got ${nText})`, { N });
  }

  const salt = Buffer.from(saltText, 'base64url');
  const hash = Buffer.from(hashText, 'base64url');
  // base64url decoding is LENIENT (junk decodes to junk) — the lengths are the
  // honest structural check: bounded salt, and exactly our key width.
  if (salt.length === 0 || salt.length > PARSE_LIMITS.maxSaltBytes) {
    return hashFail('malformed', `malformed hash: salt must be 1–${String(PARSE_LIMITS.maxSaltBytes)} bytes`, {
      saltBytes: salt.length,
    });
  }
  if (hash.length !== KEY_BYTES) {
    return hashFail(
      'malformed',
      `malformed hash: expected a ${String(KEY_BYTES)}-byte derived key (got ${String(hash.length)})`,
      { hashBytes: hash.length },
    );
  }

  return ok({ primitive, N, r, p, salt, hash });
}

/**
 * Verifies a candidate against an encoded hash:
 * parse → re-derive with the SAME salt + params → timingSafeEqual.
 *
 * The timing-safe compare is safe WITHOUT a length pre-check by
 * construction: the derived key is always KEY_BYTES, and parse already
 * rejected any stored hash whose bytes are not exactly KEY_BYTES — so the two
 * buffers handed to timingSafeEqual are the same length on every path
 * (node's timingSafeEqual THROWS on mismatched lengths; a raw compare over
 * untrusted input would turn that into a crash-oracle).
 */
export function verifyPasswordHash(
  candidate: string,
  encoded: string,
): Result<boolean, PasswordHashFailure> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed.ok) return parsed;
  const derived = derive(candidate, parsed.value.salt, parsed.value.N, parsed.value.r, parsed.value.p);
  return ok(timingSafeEqual(derived, parsed.value.hash));
}

// --- the credential-login fixture (the hashing demo's user base) ----------------------

/** What the login fixture stores — note what is ABSENT: any plaintext password. */
export interface CredentialUser {
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly ('admin' | 'editor' | 'viewer')[];
  /** The ENCODED scrypt hash — the only password material this process holds. */
  readonly passwordHash: string;
}

/**
 * The teaching passwords for the hashed-credential users. Public on purpose —
 * same policy as demo_users.ts's passwordHint: completing a real login is the
 * demo's whole point, and the lesson is that even with the password VISIBLE,
 * the STORE only ever held the hash.
 */
const CREDENTIAL_PASSWORDS: Readonly<Record<string, string>> = {
  dana: 'guide-hashing-pw',
  erin: 'another-teaching-pw',
};

/**
 * Two demo users whose credentials are stored the production way — seeded at
 * module init by running the hasher itself (in the style of demo_users.ts, but
 * with hashes instead of plaintext). Module init burns three scrypt
 * derivations (dana, erin, and the timing dummy below ≈ 0.75s in this
 * devcontainer) ONCE per process; logins then pay one derivation each — that
 * cost IS the feature.
 */
export const CREDENTIAL_USERS: readonly CredentialUser[] = [
  {
    username: 'dana',
    displayName: 'Dana Hashed',
    roles: ['admin'],
    passwordHash: hashPassword(CREDENTIAL_PASSWORDS['dana']!),
  },
  {
    username: 'erin',
    displayName: 'Erin Hashed',
    roles: ['viewer'],
    passwordHash: hashPassword(CREDENTIAL_PASSWORDS['erin']!),
  },
];

/** Exact-match username lookup over the hashed-credential fixture. */
export function findCredentialUser(username: string): CredentialUser | undefined {
  return CREDENTIAL_USERS.find((user) => user.username === username);
}

/**
 * The plaintext password each fixture user logs in with (public teaching
 * material, like demo_users.ts's passwordHint — the client's login picker
 * needs it to complete the flow).
 */
export function credentialPasswordHint(username: string): string | undefined {
  return CREDENTIAL_PASSWORDS[username];
}

/**
 * A precomputed hash of a throwaway value. When the USERNAME is unknown, the
 * login path still burns one full scrypt verify against this dummy so the
 * endpoint's timing cannot reveal whether the username existed — the same
 * equal-work trick demo_users.ts plays, now with a deliberately SLOW verify,
 * where the timing gap would otherwise be hundreds of milliseconds wide.
 */
const DUMMY_HASH: string = hashPassword('timing-decoy-not-a-real-password');

export function verifyDummyPasswordHash(candidate: string): boolean {
  const verdict = verifyPasswordHash(candidate, DUMMY_HASH);
  return verdict.ok ? verdict.value : false;
}
