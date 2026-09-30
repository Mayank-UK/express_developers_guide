import { describe, expect, it } from 'vitest';
import { negotiateLocale, parseAcceptLanguage } from './negotiate.js';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from './locales.js';

const SUPPORTED = [...SUPPORTED_LOCALES]; // ['en', 'de', 'ja']

describe('parseAcceptLanguage — the grammar, including the ugly parts', () => {
  it('parses a single unweighted range as q=1', () => {
    expect(parseAcceptLanguage('de')).toEqual([{ range: 'de', q: 1 }]);
  });

  it('parses weighted ranges, lowercases tags, preserves written order', () => {
    expect(parseAcceptLanguage('de-AT,ja;q=0.8,en;q=0.5')).toEqual([
      { range: 'de-at', q: 1 },
      { range: 'ja', q: 0.8 },
      { range: 'en', q: 0.5 },
    ]);
  });

  it('parses the wildcard and clamps q into [0, 1]', () => {
    expect(parseAcceptLanguage('*;q=0.3')).toEqual([{ range: '*', q: 0.3 }]);
    expect(parseAcceptLanguage('de;q=4')).toEqual([{ range: 'de', q: 1 }]); // clamped down
    expect(parseAcceptLanguage('de;q=-2')).toEqual([{ range: 'de', q: 0 }]); // clamped up
  });

  it('ignores malformed segments and malformed q values — never throws', () => {
    // '!!' and the empty piece fail the range pattern; 'q=abc' is NaN → q 1;
    // 'q=' is an empty value → malformed → q 1; 'charset' is not q at all.
    expect(parseAcceptLanguage('!!,de;q=abc,ja;charset=utf8')).toEqual([
      { range: 'de', q: 1 },
      { range: 'ja', q: 1 },
    ]);
    expect(parseAcceptLanguage('de;q=')).toEqual([{ range: 'de', q: 1 }]);
    expect(parseAcceptLanguage('%%%')).toEqual([]);
    expect(parseAcceptLanguage('   ')).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });

  it('keeps duplicate ranges as written (first occurrence wins ties)', () => {
    expect(parseAcceptLanguage('de,de;q=0.9')).toEqual([
      { range: 'de', q: 1 },
      { range: 'de', q: 0.9 },
    ]);
  });
});

describe('negotiateLocale — the match ladder', () => {
  it('exact: a supported tag matches itself, case-insensitively', () => {
    const result = negotiateLocale('JA', SUPPORTED, DEFAULT_LOCALE);
    expect(result.locale).toBe('ja');
    expect(result.matchedVia).toBe('exact');
  });

  it('primary: de-AT falls to supported de (the classic regional-tag case)', () => {
    const result = negotiateLocale('de-AT,ja;q=0.8,en;q=0.5', SUPPORTED, DEFAULT_LOCALE);
    expect(result.locale).toBe('de');
    expect(result.matchedVia).toBe('primary');
    // The consideration order is the teaching payload: q-sorted, written first.
    expect(result.considered.map((entry) => entry.range)).toEqual(['de-at', 'ja', 'en']);
  });

  it('higher q wins regardless of written order', () => {
    const result = negotiateLocale('en;q=0.3,de;q=0.9', SUPPORTED, DEFAULT_LOCALE);
    expect(result.locale).toBe('de');
    expect(result.matchedVia).toBe('exact');
  });

  it('wildcard: matches the default locale — but only after every named range', () => {
    // Named preference outranks a higher-q wildcard (the classic bug):
    const shadowed = negotiateLocale('*;q=1,de;q=0.5', SUPPORTED, DEFAULT_LOCALE);
    expect(shadowed.locale).toBe('de');
    expect(shadowed.matchedVia).toBe('exact');
    expect(shadowed.considered.map((entry) => entry.range)).toEqual(['de', '*']);

    // Nothing named matches → the wildcard serves the default:
    const wildcard = negotiateLocale('fr-CA,*;q=0.5', SUPPORTED, DEFAULT_LOCALE);
    expect(wildcard.locale).toBe('en');
    expect(wildcard.matchedVia).toBe('wildcard');
  });

  it('q=0 excludes a tag even when it would otherwise match', () => {
    const result = negotiateLocale('de;q=0,en', SUPPORTED, DEFAULT_LOCALE);
    expect(result.locale).toBe('en');
    expect(result.matchedVia).toBe('exact');
    expect(result.considered.map((entry) => entry.range)).toEqual(['en']);
  });

  it('falls to the default locale on absent, empty, or all-unsupported headers', () => {
    for (const header of ['', '   ', 'fr,zh-Hant']) {
      const result = negotiateLocale(header, SUPPORTED, DEFAULT_LOCALE);
      expect(result.locale, `header "${header}"`).toBe('en');
      expect(result.matchedVia, `header "${header}"`).toBe('default');
    }
  });

  it('survives garbage headers without throwing', () => {
    expect(() => negotiateLocale('!!!,,;;', SUPPORTED, DEFAULT_LOCALE)).not.toThrow();
    expect(negotiateLocale('!!!,,;;', SUPPORTED, DEFAULT_LOCALE).matchedVia).toBe('default');
  });
});
