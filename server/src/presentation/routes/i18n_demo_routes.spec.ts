import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { I18N_DEMO_MOUNT_PATH } from './i18n_demo_routes.js';

const MOUNT = I18N_DEMO_MOUNT_PATH; // /api/demo/i18n

describe('GET /api/demo/i18n/locales — the supported registry', () => {
  it('serves the three demo locales with metadata and example headers', async () => {
    const res = await request(createApp()).get(`${MOUNT}/locales`);

    expect(res.status).toBe(200);
    expect(res.body.defaultLocale).toBe('en');
    expect(res.body.demoInstant).toBe('2026-09-28T09:15:00Z');
    expect(res.body.locales).toHaveLength(3);
    expect(res.body.locales.map((l: { locale: string }) => l.locale)).toEqual(['en', 'de', 'ja']);
    for (const locale of res.body.locales) {
      expect(typeof locale.displayName).toBe('string');
      expect(typeof locale.endonym).toBe('string');
      expect(locale.dir).toBe('ltr');
      expect(typeof locale.exampleAcceptLanguage).toBe('string');
      expect(locale.exampleAcceptLanguage).toMatch(/./);
    }
  });
});

describe('GET /api/demo/i18n/messages — explicit locale, deterministic formats', () => {
  it('defaults to en with matchedVia "explicit" and frozen-instant samples', async () => {
    const res = await request(createApp()).get(`${MOUNT}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('en');
    expect(res.body.matchedVia).toBe('explicit');

    // The determinism contract: fixed instant, UTC, fixed numbers.
    expect(res.body.sampleFormats.referenceInstant).toBe('2026-09-28T09:15:00Z');
    // The explicit endpoint is locale-keyed by QUERY, not by a request header
    // — it must not carry the negotiating route's Vary.
    expect(res.headers.vary).toBeUndefined();
    expect(res.body.sampleFormats.date).toBe('September 28, 2026');
    expect(res.body.sampleFormats.number).toBe('12,345.678');
    expect(res.body.sampleFormats.currency).toContain('1,234.50');
    expect(res.body.sampleFormats.currency).toContain('€');
    expect(typeof res.body.sampleFormats.relativeTime).toBe('string');
    expect(res.body.sampleFormats.relativeTime.length).toBeGreaterThan(0);

    // Plural categories ride along as data — en distinguishes one/other.
    expect(res.body.messages.postCounts).toEqual([
      { count: 1, pluralCategory: 'one', text: '1 post' },
      { count: 3, pluralCategory: 'other', text: '3 posts' },
    ]);
  });

  it('serves German strings with German number/date conventions', async () => {
    const res = await request(createApp()).get(`${MOUNT}/messages?locale=de`);

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('de');
    expect(res.body.messages.greeting).toContain('Willkommen');
    // The teaching contrast: grouping by '.', decimal ','.
    expect(res.body.sampleFormats.number).toBe('12.345,678');
    expect(res.body.sampleFormats.currency).toContain('1.234,50');
    expect(res.body.sampleFormats.currency).toContain('€');
    expect(res.body.sampleFormats.date).toContain('September');
    expect(res.body.sampleFormats.date).toContain('2026');
    expect(res.body.sampleFormats.dateTime).toContain('09:15');
    expect(res.body.messages.postCounts).toEqual([
      { count: 1, pluralCategory: 'one', text: '1 Beitrag' },
      { count: 3, pluralCategory: 'other', text: '3 Beiträge' },
    ]);
  });

  it('serves Japanese strings — and ja has ONLY the "other" plural', async () => {
    const res = await request(createApp()).get(`${MOUNT}/messages?locale=ja`);

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('ja');
    expect(res.body.messages.greeting).toContain('ようこそ');
    expect(res.body.sampleFormats.date).toContain('2026年9月28日');
    // ja date starts with the year; the eras/format differ from en/de.
    expect(res.body.sampleFormats.currency).toContain('1,234.50');
    // The plural teaching gem: counts 1 and 3 are BOTH 'other' in CLDR ja.
    expect(res.body.messages.postCounts.map((p: { pluralCategory: string }) => p.pluralCategory)).toEqual([
      'other',
      'other',
    ]);
  });

  it('rejects unknown locales with the 400 envelope carrying the supported list', async () => {
    const res = await request(createApp()).get(`${MOUNT}/messages?locale=fr`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('locale');
    expect(res.body.error.supported).toEqual(['en', 'de', 'ja']);
  });

  it('rejects repeated locale params (arrays) with 400', async () => {
    const res = await request(createApp()).get(`${MOUNT}/messages?locale=en&locale=de`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('is case-insensitive on the explicit choice', async () => {
    const res = await request(createApp()).get(`${MOUNT}/messages?locale=DE`);

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('de');
  });
});

describe('GET /api/demo/i18n/negotiate — real Accept-Language matching', () => {
  it('matches de via PRIMARY subtag for de-AT, with Vary set', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/negotiate`)
      .set('Accept-Language', 'de-AT,ja;q=0.8,en;q=0.5');

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('de');
    expect(res.body.matchedVia).toBe('primary');
    expect(res.body.negotiation.acceptLanguage).toBe('de-AT,ja;q=0.8,en;q=0.5');
    expect(res.body.negotiation.considered.map((e: { range: string }) => e.range)).toEqual([
      'de-at',
      'ja',
      'en',
    ]);
    // The caching interaction: only the negotiating route varies on the header.
    expect(res.headers.vary).toBe('Accept-Language');
    // And the payload it negotiated is the full German one:
    expect(res.body.messages.greeting).toContain('Willkommen');
    expect(res.body.sampleFormats.number).toBe('12.345,678');
  });

  it('matches exact tags case-insensitively', async () => {
    const res = await request(createApp()).get(`${MOUNT}/negotiate`).set('Accept-Language', 'JA');

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('ja');
    expect(res.body.matchedVia).toBe('exact');
    expect(res.headers.vary).toBe('Accept-Language');
  });

  it('serves the default via WILDCARD when nothing named matches', async () => {
    const res = await request(createApp()).get(`${MOUNT}/negotiate`).set('Accept-Language', 'fr-CA,*;q=0.5');

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('en');
    expect(res.body.matchedVia).toBe('wildcard');
  });

  it('defaults to en when no Accept-Language arrives', async () => {
    const res = await request(createApp()).get(`${MOUNT}/negotiate`).set('Accept-Language', '');

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('en');
    expect(res.body.matchedVia).toBe('default');
    expect(res.body.negotiation.parsed).toEqual([]);
  });

  it('never throws on garbage headers', async () => {
    const res = await request(createApp()).get(`${MOUNT}/negotiate`).set('Accept-Language', '!!!,,;;q==');

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('en');
    expect(res.body.matchedVia).toBe('default');
  });

  it('a named preference outranks a higher-q wildcard', async () => {
    const res = await request(createApp()).get(`${MOUNT}/negotiate`).set('Accept-Language', '*;q=1,de;q=0.5');

    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('de');
    expect(res.body.matchedVia).toBe('exact');
  });
});
