import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  readCookie,
  serializeClearingCookie,
  serializeSessionCookie,
} from './cookie_utils.js';

// Pure helpers, so these are plain function-level cases. The auth demo routes
// exercise them end-to-end through real Set-Cookie headers; what needs pinning
// HERE is the parse/serialize edge algebra: hostile and malformed Cookie
// headers never throw, and clearing mirrors setting.

describe('parseCookieHeader (unit)', () => {
  it('parses a single pair', () => {
    expect(parseCookieHeader('guide_session=abc123')).toEqual({ guide_session: 'abc123' });
  });

  it('parses multiple pairs separated by "; "', () => {
    expect(parseCookieHeader('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('undefined and empty headers parse to an empty record', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('tolerates messy whitespace and stray empty segments', () => {
    expect(parseCookieHeader(' a = 1 ;;  b=2  ; ')).toEqual({ a: '1', b: '2' });
  });

  it('malformed fragments are SKIPPED, never thrown on', () => {
    // attribute-only fragment, lone name, and leading '=' (empty name) all drop;
    // the well-formed pair beside them survives.
    expect(parseCookieHeader('HttpOnly; token; =valueless; session=ok')).toEqual({ session: 'ok' });
  });

  it('a value containing "=" keeps everything after the FIRST "="', () => {
    expect(parseCookieHeader('b64=YWJj=ZGVm==')).toEqual({ b64: 'YWJj=ZGVm==' });
  });

  it('percent-encoded values are decoded', () => {
    expect(parseCookieHeader('token=%2Fapi%2Fdemo%26x')).toEqual({ token: '/api/demo&x' });
  });

  it('a malformed escape falls back to the RAW value instead of throwing', () => {
    expect(parseCookieHeader('token=100%')).toEqual({ token: '100%' });
    expect(parseCookieHeader('tok=%E0%A4%A')).toEqual({ tok: '%E0%A4%A' }); // truncated UTF-8
  });

  it('an explicitly empty value round-trips as an empty string (not undefined)', () => {
    expect(parseCookieHeader('cleared=')).toEqual({ cleared: '' });
  });

  it('later pairs with the same name win (last write wins, like browsers)', () => {
    expect(parseCookieHeader('sid=old; sid=new')).toEqual({ sid: 'new' });
  });
});

describe('serializeSessionCookie (unit)', () => {
  it('emits the exact teaching attribute set: Path=/, HttpOnly, SameSite=Lax', () => {
    expect(serializeSessionCookie('guide_session', 'abc123')).toBe(
      'guide_session=abc123; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('percent-encodes the value so delimiters cannot smuggle attributes', () => {
    const header = serializeSessionCookie('s', 'a b/c&d');
    expect(header.startsWith('s=a%20b%2Fc%26d;')).toBe(true);
    expect(header).not.toContain('=a b/c&d;'); // raw value never leaks into the header
  });

  it('round-trips: what serialize writes, parseCookieHeader reads back', () => {
    for (const value of ['simple', 'with space', 'slash/and&amp', 'ünïcode', '100%']) {
      expect(parseCookieHeader(serializeSessionCookie(SESSION_COOKIE_NAME, value))[SESSION_COOKIE_NAME]).toBe(value);
    }
  });
});

describe('serializeClearingCookie (unit)', () => {
  it('clears with an empty value and Max-Age=0', () => {
    expect(serializeClearingCookie('guide_session')).toBe(
      'guide_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });

  it('MIRRORS the setter\'s attributes — a mismatched cookie is a different cookie', () => {
    const set = serializeSessionCookie('guide_session', 'x');
    const clear = serializeClearingCookie('guide_session');
    // Everything the setter attributes, the clearer repeats (plus Max-Age=0),
    // so the browser deletes the SAME cookie it set.
    expect(clear.startsWith(set.replace('guide_session=x', 'guide_session='))).toBe(true);
    expect(clear).toContain('Max-Age=0');
  });

  it('the cleared cookie parses back as an explicitly empty value', () => {
    expect(parseCookieHeader(serializeClearingCookie('guide_session')).guide_session).toBe('');
  });
});

describe('readCookie (unit)', () => {
  it('returns the named cookie from a Cookie header', () => {
    expect(readCookie('a=1; guide_session=tok; b=2', 'guide_session')).toBe('tok');
  });

  it('returns undefined when the cookie (or header) is absent', () => {
    expect(readCookie('a=1', 'guide_session')).toBeUndefined();
    expect(readCookie(undefined, 'guide_session')).toBeUndefined();
  });
});
