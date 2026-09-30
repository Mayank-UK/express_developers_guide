import { createHmac, randomBytes } from 'node:crypto';
import { failure, type Failure, type FailureKind } from '../../core/error_handling/failures.js';
import { ok, type Result } from '../../core/result/result.js';
import { constantTimeEquals } from './demo_users.js';

/**
 * A hand-rolled HS256 JWT implementation — deliberately NOT jsonwebtoken,
 * because the token format itself is the lesson (jsonwebtoken gets its catalog
 * mention in the topic content). Everything a JWT is fits in ~40 lines:
 *
 *   token = base64url(header) + '.' + base64url(payload) + '.' + base64url(sig)
 *   sig   = HMAC-SHA256(secret, headerSegment + '.' + payloadSegment)
 *
 * Two security decisions worth naming:
 * (1) NO ALGORITHM NEGOTIATION — verifyJwt accepts HS256 and nothing else,
 *     regardless of what the token's header claims (the alg=none / alg-confusion
 *     attack family: a forged token whose header says "none" or "RS256" must be
 *     rejected, not honored — see the topic content for the history).
 * (2) CONSTANT-TIME signature compare — same sha256-then-timingSafeEqual trick
 *     as the password compare, so a mismatched signature leaks nothing about
 *     HOW close it was.
 */

/**
 * The demo signing key — FIXED and EXPORTED so the content can say "the secret
 * is on this page" honestly: a symmetric secret that ships in a public repo
 * signs nothing of value. Production reads a long random secret from the
 * environment (an env-validated config, like every other secret), and HS256
 * keys want ≥32 bytes of entropy.
 */
export const JWT_DEMO_SECRET = 'jwt_demo_secret_teaching_only';

/** The one algorithm this service signs with and accepts. Not negotiable. */
export const JWT_ALGORITHM = 'HS256';

/** Default time-to-live — 5 minutes, the "short window" the content preaches. */
export const JWT_DEFAULT_TTL_SECONDS = 300;

/**
 * Time is a dependency, so the clock is injectable — the same seam the job
 * queue and the circuit breaker expose as their `now` option. A hardwired
 * Date.now() would leave expiry testable only by REALLY sleeping past a
 * token's exp (slow, and the first thing to flake when the runner is loaded);
 * with the clock injected, a spec advances it deterministically. Unit note:
 * JWT numeric dates are epoch SECONDS, so the clock speaks seconds.
 */
export interface JwtClock {
  /** Current time as epoch SECONDS — the JWT numeric-date convention. */
  readonly now: () => number;
}

/** The real clock — the default every production call site uses. */
export const realJwtClock: JwtClock = { now: () => Math.floor(Date.now() / 1000) };

/** The registered claims this service issues. Numeric dates are SECONDS. */
export interface JwtPayload {
  /** subject — WHO the token speaks for (the username). */
  readonly sub: string;
  /** The subject's roles at issue time — the authorization topic gates on these. */
  readonly roles: readonly string[];
  /** issued-at, epoch seconds. */
  readonly iat: number;
  /** expiry, epoch seconds — at/after which the token MUST be refused. */
  readonly exp: number;
  /** jwt-id — a random unique id per token (the hook a denylist would key on). */
  readonly jti: string;
}

/** What signJwt returns: the token plus its decoded halves for the demo UI. */
export interface SignedJwt {
  readonly token: string;
  readonly header: Readonly<Record<string, string>>;
  readonly payload: JwtPayload;
  readonly expiresAt: string;
}

/** Everything that can go wrong verifying a token, as one tagged union. */
export type JwtVerificationFailureReason =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'signature_mismatch'
  | 'token_expired';

/** verifyJwt's failure shape: the app Failure plus a machine-readable reason tag. */
export interface JwtVerificationFailure extends Failure {
  readonly reason: JwtVerificationFailureReason;
}

/** Structural problems are validation; forgeries and expiries are unauthorized. */
const FAILURE_KIND_BY_REASON: Readonly<Record<JwtVerificationFailureReason, FailureKind>> = {
  malformed: 'validation',
  unsupported_algorithm: 'unauthorized',
  signature_mismatch: 'unauthorized',
  token_expired: 'unauthorized',
};

/** One failure constructor so the reason tag and the Failure can never drift apart. */
function jwtFail(
  reason: JwtVerificationFailureReason,
  message: string,
): Result<never, JwtVerificationFailure> {
  return {
    ok: false,
    error: { ...failure(FAILURE_KIND_BY_REASON[reason], message), reason },
  };
}

/** The HMAC over `<header>.<payload>`, base64url — the only secret-derived bytes. */
function hmacSignature(headerSegment: string, payloadSegment: string): string {
  return createHmac('sha256', JWT_DEMO_SECRET)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest('base64url');
}

/**
 * Signs a token for `sub` with the fixture's roles. iat/exp are numeric epoch
 * SECONDS (the JWT registered-claim convention — not Node's milliseconds), and
 * jti is 16 random bytes so every token has a distinct identity.
 */
export function signJwt(
  sub: string,
  roles: readonly string[],
  ttlSeconds: number = JWT_DEFAULT_TTL_SECONDS,
  clock: JwtClock = realJwtClock,
): SignedJwt {
  const iat = clock.now();
  const payload: JwtPayload = {
    sub,
    roles: [...roles],
    iat,
    exp: iat + ttlSeconds,
    jti: randomBytes(16).toString('hex'),
  };
  const header = { alg: JWT_ALGORITHM, typ: 'JWT' };
  const headerSegment = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    token: `${headerSegment}.${payloadSegment}.${hmacSignature(headerSegment, payloadSegment)}`,
    header,
    payload,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

/**
 * Verifies structure, algorithm pin, signature (constant time), and expiry —
 * in that order — and returns the payload as a VALUE (the domain never throws).
 *
 * - wrong shape / undecodable JSON     → 'malformed' (validation failure)
 * - header claiming anything but HS256 → 'unsupported_algorithm' (unauthorized —
 *   the alg-confusion guard)
 * - signature mismatch                 → 'signature_mismatch' (unauthorized)
 * - exp <= now                         → 'token_expired' (unauthorized)
 */
export function verifyJwt(
  token: string,
  clock: JwtClock = realJwtClock,
): Result<{ payload: JwtPayload }, JwtVerificationFailure> {
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment === '')) {
    return jwtFail('malformed', 'malformed token: expected three non-empty base64url segments');
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return jwtFail('malformed', 'malformed token: segments are not decodable JSON');
  }

  // THE ALG PIN: the header is attacker-controlled input. A real forgery
  // starts by editing it ("alg":"none", or an asymmetric alg hoping the
  // verifier treats the public key as the HMAC key) — so the check is against
  // OUR algorithm constant, never against the token's own claim.
  if (header.alg !== JWT_ALGORITHM) {
    return jwtFail(
      'unsupported_algorithm',
      `rejected algorithm "${String(header.alg)}" — this issuer signs HS256 only, and the header is attacker input`,
    );
  }

  // Constant-time compare (sha256 → timingSafeEqual, as in demo_users.ts).
  const expected = hmacSignature(headerSegment, payloadSegment);
  if (!constantTimeEquals(signatureSegment, expected)) {
    return jwtFail('signature_mismatch', 'signature mismatch');
  }

  // Claims validation: exp is epoch SECONDS; "on or after" means refused —
  // at exactly exp the token is already dead (>=, not >).
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return jwtFail('malformed', 'malformed token: exp must be a numeric date');
  }
  if (clock.now() >= exp) {
    return jwtFail('token_expired', 'token expired');
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    return jwtFail('malformed', 'malformed token: sub must be a non-empty string');
  }
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role): role is string => typeof role === 'string')
    : [];

  return ok({
    payload: {
      sub: payload.sub,
      roles,
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
      exp,
      jti: typeof payload.jti === 'string' ? payload.jti : '',
    },
  });
}
