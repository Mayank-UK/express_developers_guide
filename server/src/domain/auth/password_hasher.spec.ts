import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_USERS,
  SCRYPT_COST,
  credentialPasswordHint,
  findCredentialUser,
  hashPassword,
  parsePasswordHash,
  verifyDummyPasswordHash,
  verifyPasswordHash,
} from './password_hasher.js';

/**
 * The hasher's own contract, unit-level: the encoded format round-trips
 * through its own parser (a hash you cannot parse is a hash you cannot
 * upgrade), malformed strings fail TYPED (never thrown), and the compare path
 * is length-safe by construction. The endpoint behaviors live in
 * auth_demo_routes.spec.ts.
 */
describe('hashPassword + parsePasswordHash — the format round-trip', () => {
  it('encodes scrypt$N$r$p$saltB64url$hashB64url and parses its own output back', () => {
    const encoded = hashPassword('guide-hashing-pw');

    const parts = encoded.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe(String(SCRYPT_COST.N));
    expect(parts[2]).toBe(String(SCRYPT_COST.r));
    expect(parts[3]).toBe(String(SCRYPT_COST.p));

    const parsed = parsePasswordHash(encoded);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.primitive).toBe('scrypt');
      expect(parsed.value.N).toBe(SCRYPT_COST.N);
      expect(parsed.value.r).toBe(SCRYPT_COST.r);
      expect(parsed.value.p).toBe(SCRYPT_COST.p);
      expect(parsed.value.salt.length).toBe(16); // 16-byte salt, by SALT_BYTES
      expect(parsed.value.hash.length).toBe(32); // 32-byte key, by KEY_BYTES
    }
  });

  it('salts every hash: same password, different strings, both verify', () => {
    const first = hashPassword('same-password');
    const second = hashPassword('same-password');
    expect(first).not.toBe(second); // new salt per call — rainbow tables need not apply

    expect(verifyPasswordHash('same-password', first)).toEqual({ ok: true, value: true });
    expect(verifyPasswordHash('same-password', second)).toEqual({ ok: true, value: true });
  });

  it('honors params from an OLDER encoding (the lazy-upgrade contract)', () => {
    // A hash encoded years ago with cheaper params must still verify — the
    // params travel WITH the hash, which is the whole point of the format.
    const salt = Buffer.from('legacy-salt-bytes', 'utf8');
    const legacy = [
      'scrypt',
      '16384', // N = 2^14 — yesterday's cost
      '8',
      '1',
      salt.toString('base64url'),
      scryptSync('old-password', salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url'),
    ].join('$');

    expect(verifyPasswordHash('old-password', legacy)).toEqual({ ok: true, value: true });
    expect(verifyPasswordHash('new-password', legacy)).toEqual({ ok: true, value: false });
  });
});

describe('verifyPasswordHash — the compare discipline', () => {
  it('right password → true; wrong password → false (full derivation both ways)', () => {
    const encoded = hashPassword('correct horse battery staple');
    expect(verifyPasswordHash('correct horse battery staple', encoded)).toEqual({ ok: true, value: true });
    expect(verifyPasswordHash('correct horse battery staplf', encoded)).toEqual({ ok: true, value: false });
    expect(verifyPasswordHash('', encoded)).toEqual({ ok: true, value: false });
  });

  it('never throws on any input — timingSafeEqual inputs are equal-length BY CONSTRUCTION', () => {
    // The derived key is always 32 bytes and parse rejects other widths
    // BEFORE the compare, so the throwing case of timingSafeEqual (mismatched
    // buffer lengths) is unreachable. Sweep hostile strings to prove it.
    const encoded = hashPassword('pw');
    const hostile = [
      '',
      'scrypt',
      'scrypt$1$1$1$AAAA$AAAA',
      'bcrypt$12$salt$hash',
      'scrypt$32768$8$1$$$',
      'scrypt$abc$8$1' + '$' + 'AAAA' + '$' + 'AAAA',
      'scrypt$32768$8$1$' + Buffer.alloc(16).toString('base64url') + '$short',
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, // a traceparent, why not
    ];
    for (const candidate of hostile) {
      expect(() => verifyPasswordHash('pw', candidate), `hash "${candidate.slice(0, 40)}"`).not.toThrow();
      const verdict = verifyPasswordHash('pw', candidate);
      expect(verdict.ok, `hash "${candidate.slice(0, 40)}"`).toBe(false);
    }
  });
});

describe('parsePasswordHash — typed failures for malformed strings', () => {
  it('wrong shape → malformed', () => {
    for (const bad of ['', 'plain', 'scrypt$32768$8$1', 'a$b$c$d$e$f$g', 'scrypt$32768$8$1$$', 'no-dollars-here']) {
      const parsed = parsePasswordHash(bad);
      expect(parsed.ok, `"${bad}"`).toBe(false);
      if (!parsed.ok) expect(parsed.error.reason).toBe('malformed');
      if (!parsed.ok) expect(parsed.error.kind).toBe('validation');
    }
  });

  it('unknown primitive → unsupported_primitive (the upgrade hook)', () => {
    // Six $-separated fields (our shape) but a future primitive token: the
    // version-prefix dispatch fires BEFORE any field semantics are trusted.
    const parsed = parsePasswordHash(`argon2id$19$65536$3${'$'}${'A'.repeat(22)}${'$'}${'B'.repeat(43)}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.reason).toBe('unsupported_primitive');
      expect(parsed.error.message).toContain('argon2id');
    }
    // A PHC-style argon2id string with MORE fields is malformed first —
    // shape is checked before the primitive is even read.
    const phcShaped = parsePasswordHash(`argon2id$v=19$m=65536$t=3$p=4${'$'}${'A'.repeat(22)}${'$'}${'B'.repeat(43)}`);
    expect(phcShaped.ok).toBe(false);
    if (!phcShaped.ok) expect(phcShaped.error.reason).toBe('malformed');
  });

  it('out-of-bounds or non-numeric params → bad_parameters (the self-DoS guard)', () => {
    const salt = Buffer.alloc(16).toString('base64url');
    const hash = Buffer.alloc(32).toString('base64url');
    const cases: string[] = [
      `scrypt$999999999$8$1$${salt}$${hash}`, // N beyond the honored bound
      `scrypt$30000$8$1$${salt}$${hash}`, // N not a power of two
      `scrypt$1024$0$1$${salt}$${hash}`, // r < 1
      `scrypt$1024$8$99$${salt}$${hash}`, // p beyond the honored bound
      `scrypt$tiny$8$1$${salt}$${hash}`, // non-numeric
      `scrypt$0x4000$8$1$${salt}$${hash}`, // hex spelling is not decimal
    ];
    for (const encoded of cases) {
      const parsed = parsePasswordHash(encoded);
      expect(parsed.ok, encoded).toBe(false);
      if (!parsed.ok) expect(parsed.error.reason).toBe('bad_parameters');
    }
  });

  it('wrong key width or empty salt → malformed (the length contract)', () => {
    const salt = Buffer.alloc(16).toString('base64url');
    const wrongKey = parsePasswordHash(`scrypt$32768$8$1$${salt}$${Buffer.alloc(31).toString('base64url')}`);
    expect(wrongKey.ok).toBe(false);
    if (!wrongKey.ok) expect(wrongKey.error.reason).toBe('malformed');

    const noSalt = parsePasswordHash(`scrypt$32768$8$1$$${Buffer.alloc(32).toString('base64url')}`);
    expect(noSalt.ok).toBe(false);
  });
});

describe('the credential fixture — hashed at rest', () => {
  it('seeds dana and erin with scrypt hashes, no plaintext in the store', () => {
    expect(CREDENTIAL_USERS.map((user) => user.username)).toEqual(['dana', 'erin']);
    const storeJson = JSON.stringify(CREDENTIAL_USERS);
    for (const password of ['guide-hashing-pw', 'another-teaching-pw']) {
      expect(storeJson).not.toContain(password);
    }
    for (const user of CREDENTIAL_USERS) {
      const parsed = parsePasswordHash(user.passwordHash);
      expect(parsed.ok, user.username).toBe(true);
      if (parsed.ok) expect(parsed.value.N).toBe(SCRYPT_COST.N);
    }
  });

  it('verifies both users against their hints, and rejects impostors', () => {
    const dana = findCredentialUser('dana');
    const erin = findCredentialUser('erin');
    expect(dana).toBeDefined();
    expect(erin).toBeDefined();

    const danaVerdict = verifyPasswordHash('guide-hashing-pw', dana!.passwordHash);
    expect(danaVerdict.ok && danaVerdict.value).toBe(true);
    // Each user's password is salted separately — erin's does NOT open dana's.
    const crossVerdict = verifyPasswordHash('another-teaching-pw', dana!.passwordHash);
    expect(crossVerdict.ok && crossVerdict.value).toBe(false);

    expect(findCredentialUser('mallory')).toBeUndefined();
    expect(credentialPasswordHint('dana')).toBe('guide-hashing-pw');
  });

  it('the dummy-hash path burns a full verify for unknown usernames', () => {
    expect(verifyDummyPasswordHash('anything')).toBe(false);
    expect(verifyDummyPasswordHash('guide-hashing-pw')).toBe(false); // even the REAL password must not open the dummy
  });
});
