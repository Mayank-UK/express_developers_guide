import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_REFRESH_FAMILIES,
  createTokenFamily,
  getFamily,
  listFamilies,
  rawStoreSnapshotForTests,
  resetRefreshStoreForTests,
  rotateRefreshToken,
} from './refresh_store.js';

/**
 * The token-family state machine, unit-level — the endpoints in
 * auth_demo_routes.spec.ts ride these exact semantics:
 *   happy chain → each rotation moves the current pointer;
 *   reuse of ANY rotated token → the WHOLE family dies (incl. the current);
 *   unknown token → plain rejection, nobody else punished;
 *   the raw token never exists in the store, only sha256 digests.
 */
beforeEach(() => {
  resetRefreshStoreForTests();
});

describe('createTokenFamily + rotateRefreshToken — the happy chain', () => {
  it('login issues token #1; three rotations move the current pointer each time', () => {
    const first = createTokenFamily('dana');
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    const view = getFamily(first.familyId);
    expect(view?.tokens).toHaveLength(1);
    expect(view?.tokens[0]).toMatchObject({ n: 1, state: 'current', rotatedAt: null });
    expect(view?.currentTokenMasked).toBe(view?.tokens[0]?.tokenMasked);

    let current = first.token;
    for (let rotation = 1; rotation <= 3; rotation += 1) {
      const outcome = rotateRefreshToken(current);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.next.token).not.toBe(current);
      expect(outcome.next.familyId).toBe(first.familyId);

      const chain = getFamily(first.familyId)?.tokens ?? [];
      expect(chain).toHaveLength(rotation + 1);
      // The presented token is now 'rotated' (one-time use, kept as evidence).
      const previous = chain[rotation - 1];
      expect(previous).toMatchObject({ state: 'rotated' });
      expect(previous?.rotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The pointer moved: the LAST token is the new current.
      expect(chain[chain.length - 1]).toMatchObject({ n: rotation + 1, state: 'current' });

      current = outcome.next.token;
    }
  });

  it('rotated tokens are dead: every PREVIOUS token in a healthy family', () => {
    const family = createTokenFamily('erin');
    const tokens = [family.token];
    for (let index = 0; index < 2; index += 1) {
      const outcome = rotateRefreshToken(tokens[tokens.length - 1]!);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) tokens.push(outcome.next.token);
    }
    const view = getFamily(family.familyId);
    expect(view?.revoked).toBe(false);
    expect(view?.tokens.map((token) => token.state)).toEqual(['rotated', 'rotated', 'current']);
    // Still a healthy family: the current token keeps rotating.
    expect(rotateRefreshToken(tokens[2]!).ok).toBe(true);
  });
});

describe('reuse detection — the theft assumption', () => {
  it('replaying token #1 after two rotations revokes the ENTIRE family', () => {
    const family = createTokenFamily('dana');
    const tokens = [family.token];
    for (let index = 0; index < 2; index += 1) {
      const outcome = rotateRefreshToken(tokens[tokens.length - 1]!);
      if (!outcome.ok) throw new Error('setup rotation failed');
      tokens.push(outcome.next.token);
    }

    // The thief replays the OLDEST token (copied before the first rotation).
    const reuse = rotateRefreshToken(tokens[0]!);
    expect(reuse.ok).toBe(false);
    if (!reuse.ok && reuse.reason === 'reuse_detected') {
      expect(reuse.familyId).toBe(family.familyId);
      expect(reuse.reusedTokenMasked).toMatch(/^….{4}$/);
      // TRANSITIVE COMPLETENESS: every token of the family is dead — past
      // AND current. No salvageable credential remains.
      expect(reuse.family.tokens.every((token) => token.state === 'dead')).toBe(true);
    } else {
      throw new Error(`expected reuse_detected, got ${String(reuse.ok)}`);
    }

    const view = getFamily(family.familyId);
    expect(view?.revoked).toBe(true);
    expect(view?.revokedReason).toBe('reuse_detected');
    expect(view?.currentTokenMasked).toBeNull(); // nothing is current anymore
    expect(view?.tokens.every((token) => token.state === 'revoked')).toBe(true);

    // THE POINT: even the CURRENT (legitimately newest) token is now refused.
    const currentAfterRevoke = rotateRefreshToken(tokens[2]!);
    expect(currentAfterRevoke.ok).toBe(false);
    if (!currentAfterRevoke.ok) expect(currentAfterRevoke.reason).toBe('family_revoked');

    // And re-presenting the same reused token again is still family_revoked.
    const reReuse = rotateRefreshToken(tokens[0]!);
    if (!reReuse.ok) expect(reReuse.reason).toBe('family_revoked');
  });
});

describe('unknown tokens — plain rejection, no collateral', () => {
  it('a garbage token is unknown_token and does NOT revoke anyone', () => {
    const keeper = createTokenFamily('dana');
    const unknown = rotateRefreshToken('forged-token-that-never-existed');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('unknown_token');

    // The innocent family is untouched — its current token still rotates.
    expect(getFamily(keeper.familyId)?.revoked).toBe(false);
    expect(rotateRefreshToken(keeper.token).ok).toBe(true);
  });
});

describe('hashed-at-rest — the store never holds a raw token', () => {
  it('the whole store, JSON-scanned, contains no raw token material', () => {
    const issued = [createTokenFamily('dana'), createTokenFamily('erin')];
    for (const family of issued) {
      const outcome = rotateRefreshToken(family.token);
      if (!outcome.ok) throw new Error('setup rotation failed');
    }
    const snapshot = rawStoreSnapshotForTests();
    for (const family of issued) {
      expect(snapshot.some((entry) => entry.familyId === family.familyId)).toBe(true);
      expect(snapshot).toHaveLength(2);
    }
    const storeJson = JSON.stringify(snapshot);
    for (const family of issued) {
      expect(storeJson).not.toContain(family.token); // raw login token absent
    }
    // Every stored tokenHash is a 64-char lowercase hex sha256 digest.
    for (const family of snapshot) {
      for (const token of family.tokens) {
        expect(token.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });
});

describe('the store bounds and views', () => {
  it('caps at MAX_REFRESH_FAMILIES, evicting the oldest', () => {
    const first = createTokenFamily('dana');
    for (let index = 1; index < MAX_REFRESH_FAMILIES; index += 1) {
      createTokenFamily('erin');
    }
    expect(listFamilies()).toHaveLength(MAX_REFRESH_FAMILIES);
    expect(getFamily(first.familyId)).toBeDefined(); // exactly at cap: still present

    createTokenFamily('dana'); // one over → the OLDEST goes
    expect(listFamilies()).toHaveLength(MAX_REFRESH_FAMILIES);
    expect(getFamily(first.familyId)).toBeUndefined();
  });
});
