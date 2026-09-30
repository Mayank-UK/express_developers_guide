import { createHash, randomBytes } from 'node:crypto';
import { maskSessionToken } from './session_store.js';

/**
 * An opaque REFRESH-TOKEN store with rotation + reuse detection — the
 * token-family pattern, hand-rolled because the rotation state machine is the
 * lesson (production: a TTL'd Redis/DB table with the same columns).
 *
 * TWO storage decisions worth naming:
 *
 * 1. TOKENS ARE OPAQUE (32 random bytes), not JWTs. A refresh token proves
 *    nothing on its own — it is a pure lookup key into server state, so it
 *    carries no claims worth forging and can be revoked by deleting state.
 *    That is the exact opposite of the access JWT, which is self-contained
 *    and lives minutes. The pair IS the lesson.
 *
 * 2. THE STORE HOLDS ONLY sha256(token) — never the raw token. A database
 *    dump must not yield reusable credentials. Lookup is hash-then-Map.get:
 *    the Map compares fixed-length DIGESTS (not secrets), which is also why
 *    the comparison needs no timing-safe gymnastics — hashing the candidate
 *    first makes every compared string 64 hex chars, and the digest reveals
 *    nothing about the preimage (same trick as demo_users.ts, one step
 *    earlier in the pipeline).
 *
 * TOKEN FAMILIES: every login mints a family id. The family's first refresh
 * token is its CURRENT one; each rotation marks the old token 'rotated' (one
 * time use — dead, but KEPT as evidence) and moves the current pointer.
 * Presenting a token that is 'rotated' (i.e. not the current one but known to
 * the family) can only mean the token leaked: the legitimate client holds the
 * newest token, so an OLD one replaying is a thief who copied it earlier. The
 * response is to revoke the ENTIRE family — current token included — because
 * the attacker demonstrably has family material and the honest client can
 * just log in again. That is reuse detection.
 */

/** Hard cap on families — the oldest is evicted when full (session-store parity). */
export const MAX_REFRESH_FAMILIES = 50;

/** Lifecycle of one token within its family. */
export type RefreshTokenState = 'current' | 'rotated' | 'dead';

/** What the store keeps per token — note: tokenHash, never the raw token. */
export interface StoredRefreshToken {
  /** sha256 hex of the raw 32-byte token (64 chars, fixed length). */
  readonly tokenHash: string;
  /**
   * `…last4` of the RAW token, captured at mint — the same disclosure the
   * session store makes. The UI needs it to line a listing row up with the
   * token the client actually holds (masking the HASH would not match).
   */
  readonly tokenMasked: string;
  readonly createdAt: string;
  /** When rotation replaced this token; null while it is the current one. */
  rotatedAt: string | null;
  /** Set to 'dead' for EVERY token the instant the family is revoked. */
  state: RefreshTokenState;
}

export type RefreshRevocationReason = 'reuse_detected';

export interface StoredTokenFamily {
  readonly familyId: string;
  readonly username: string;
  readonly createdAt: string;
  revokedAt: string | null;
  revokedReason: RefreshRevocationReason | null;
  /** Append-only: every token the family ever issued, oldest first. */
  readonly tokens: StoredRefreshToken[];
}

/** A raw refresh token plus the family it opened — handed out ONCE, to the client. */
export interface IssuedRefreshToken {
  readonly familyId: string;
  /** The raw urlsafe token. The store keeps only its hash; this value exists once, here. */
  readonly token: string;
}

/** Everything rotate() can conclude about a presented token. */
export type RefreshRotationOutcome =
  | { readonly ok: true; readonly family: StoredTokenFamily; readonly next: IssuedRefreshToken }
  | { readonly ok: false; readonly reason: 'unknown_token' }
  | { readonly ok: false; readonly reason: 'family_revoked'; readonly familyId: string }
  | {
      readonly ok: false;
      readonly reason: 'reuse_detected';
      readonly familyId: string;
      readonly reusedTokenMasked: string;
      readonly family: StoredTokenFamily;
    };

// --- the store ------------------------------------------------------------------------

const families = new Map<string, StoredTokenFamily>();
/** tokenHash → familyId: the O(1) lookup the raw-token presentation path rides. */
const familyIdByTokenHash = new Map<string, string>();
let nextFamilySeq = 0;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function nowIso(): string {
  return new Date().toISOString();
}

function evictIfNeeded(): void {
  while (families.size >= MAX_REFRESH_FAMILIES) {
    const oldest = families.keys().next().value;
    if (oldest === undefined) break;
    const family = families.get(oldest);
    for (const token of family?.tokens ?? []) familyIdByTokenHash.delete(token.tokenHash);
    families.delete(oldest);
  }
}

/**
 * Opens a new token family at login: minted family id + first refresh token
 * (which becomes the family's current token).
 */
export function createTokenFamily(username: string): IssuedRefreshToken {
  evictIfNeeded();
  nextFamilySeq += 1;
  const familyId = `fam_${String(nextFamilySeq)}`;
  const raw = mintToken();
  const createdAt = nowIso();
  const family: StoredTokenFamily = {
    familyId,
    username,
    createdAt,
    revokedAt: null,
    revokedReason: null,
    tokens: [
      { tokenHash: hashToken(raw), tokenMasked: maskSessionToken(raw), createdAt, rotatedAt: null, state: 'current' },
    ],
  };
  families.set(familyId, family);
  familyIdByTokenHash.set(family.tokens[0]!.tokenHash, familyId);
  return { familyId, token: raw };
}

/**
 * The heart of the exhibit: exchange a refresh token for the NEXT one.
 *
 *   presented hash unknown            → unknown_token       (plain 401)
 *   family revoked (any token of it)  → family_revoked      (plain 401)
 *   presented == family's CURRENT     → ROTATE: old marked 'rotated', new
 *                                       current minted, family pointer moves
 *   presented is an OLD (rotated) one → reuse_detected: the ENTIRE family is
 *                                       revoked — every token dead, including
 *                                       the current one (the theft assumption)
 */
export function rotateRefreshToken(rawPresented: string): RefreshRotationOutcome {
  const presentedHash = hashToken(rawPresented);
  const familyId = familyIdByTokenHash.get(presentedHash);
  if (familyId === undefined) {
    return { ok: false, reason: 'unknown_token' };
  }
  const family = families.get(familyId);
  if (family === undefined) {
    // Index/store drift is not representable, but a store that could drift
    // must still answer safely: unknown IS unknown.
    return { ok: false, reason: 'unknown_token' };
  }

  if (family.revokedAt !== null) {
    return { ok: false, reason: 'family_revoked', familyId };
  }

  const presented = family.tokens.find((token) => token.tokenHash === presentedHash);
  if (presented === undefined) {
    return { ok: false, reason: 'unknown_token' };
  }

  if (presented.state === 'rotated') {
    // REUSE DETECTED. A rotated token is single-use evidence: the real client
    // moved on, so whoever is presenting it copied it before rotation. Revoke
    // the whole family — transitive completeness is the point: EVERY token
    // (past and current) dies together, so the thief's stolen copy AND any
    // token they might already have refreshed into are both worthless.
    const revokedAt = nowIso();
    family.revokedAt = revokedAt;
    family.revokedReason = 'reuse_detected';
    for (const token of family.tokens) {
      token.state = 'dead';
    }
    return {
      ok: false,
      reason: 'reuse_detected',
      familyId,
      reusedTokenMasked: maskSessionToken(rawPresented),
      family,
    };
  }

  // presented.state === 'current' → rotate.
  const rotatedAt = nowIso();
  presented.state = 'rotated';
  presented.rotatedAt = rotatedAt;
  const raw = mintToken();
  family.tokens.push({
    tokenHash: hashToken(raw),
    tokenMasked: maskSessionToken(raw),
    createdAt: rotatedAt,
    rotatedAt: null,
    state: 'current',
  });
  familyIdByTokenHash.set(family.tokens[family.tokens.length - 1]!.tokenHash, familyId);
  return { ok: true, family, next: { familyId, token: raw } };
}

// --- read side (public views — masked tokens only, session-store parity) --------------

export interface RefreshTokenPublicView {
  /** 1-based position in the family's chain (1 = issued at login). */
  readonly n: number;
  readonly tokenMasked: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly state: RefreshTokenState | 'revoked';
}

export interface TokenFamilyPublicView {
  readonly familyId: string;
  readonly username: string;
  readonly createdAt: string;
  readonly revoked: boolean;
  readonly revokedAt: string | null;
  readonly revokedReason: RefreshRevocationReason | null;
  readonly tokens: RefreshTokenPublicView[];
  /** Which token the family currently accepts (null once revoked). */
  readonly currentTokenMasked: string | null;
}

export function toTokenFamilyView(family: StoredTokenFamily): TokenFamilyPublicView {
  const current = family.tokens.find((token) => token.state === 'current');
  return {
    familyId: family.familyId,
    username: family.username,
    createdAt: family.createdAt,
    revoked: family.revokedAt !== null,
    revokedAt: family.revokedAt,
    revokedReason: family.revokedReason,
    tokens: family.tokens.map((token, index) => ({
      n: index + 1,
      tokenMasked: token.tokenMasked,
      createdAt: token.createdAt,
      rotatedAt: token.rotatedAt,
      // Once the family is revoked every token is dead; 'revoked' says WHY.
      state: family.revokedAt !== null ? 'revoked' : token.state,
    })),
    currentTokenMasked: current === undefined ? null : current.tokenMasked,
  };
}

/** One family by id — the status endpoint's read. */
export function getFamily(familyId: string): TokenFamilyPublicView | undefined {
  const family = families.get(familyId);
  return family === undefined ? undefined : toTokenFamilyView(family);
}

/** Every family, oldest first — the demo panel's overview. */
export function listFamilies(): TokenFamilyPublicView[] {
  return [...families.values()].map(toTokenFamilyView);
}

/** Test/demo reset. */
export function resetRefreshStoreForTests(): void {
  families.clear();
  familyIdByTokenHash.clear();
}

/**
 * Test-only: the raw store as JSON-able records, so specs can PROVE the
 * hashed-at-rest property by scanning every stored byte for the raw tokens.
 */
export function rawStoreSnapshotForTests(): readonly StoredTokenFamily[] {
  return [...families.values()];
}
