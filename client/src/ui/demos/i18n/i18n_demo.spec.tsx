import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import I18nDemo from './i18n_demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const NEGOTIATE_URL = '/api/demo/i18n/negotiate';
const LOCALES_URL = '/api/demo/i18n/locales';

function jsonLike(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string): string | null => (name.toLowerCase() === 'vary' ? 'Accept-Language' : null),
      entries: (): Array<[string, string]> => [],
    },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

/**
 * Payloads mirror the real server's (frozen instant, UTC) — including ja's
 * both-'other' plural categories, the plural teaching gem.
 */
function messagesPayload(locale: 'en' | 'de' | 'ja', matchedVia: string) {
  const byLocale = {
    en: {
      greeting: 'Welcome to the internationalization demo.',
      farewell: 'Goodbye — see you in the next topic.',
      postCounts: [
        { count: 1, pluralCategory: 'one', text: '1 post' },
        { count: 3, pluralCategory: 'other', text: '3 posts' },
      ],
      date: 'September 28, 2026',
      dateTime: 'September 28, 2026 at 9:15 AM',
      number: '12,345.678',
      currency: '€1,234.50',
    },
    de: {
      greeting: 'Willkommen zur Internationalisierungs-Demo.',
      farewell: 'Auf Wiedersehen — bis zum nächsten Thema.',
      postCounts: [
        { count: 1, pluralCategory: 'one', text: '1 Beitrag' },
        { count: 3, pluralCategory: 'other', text: '3 Beiträge' },
      ],
      date: '28. September 2026',
      dateTime: '28. September 2026 um 09:15',
      number: '12.345,678',
      currency: '1.234,50 €',
    },
    ja: {
      greeting: '国際化デモへようこそ。',
      farewell: 'さようなら — 次のトピックで会いましょう。',
      postCounts: [
        { count: 1, pluralCategory: 'other', text: '1 件の投稿' },
        { count: 3, pluralCategory: 'other', text: '3 件の投稿' },
      ],
      date: '2026年9月28日',
      dateTime: '2026年9月28日 9:15',
      number: '12,345.678',
      currency: '€1,234.50',
    },
  } as const;
  const data = byLocale[locale];
  return {
    locale,
    matchedVia,
    messages: {
      greeting: data.greeting,
      farewell: data.farewell,
      postCounts: data.postCounts,
      uploadedAt: locale === 'de' ? 'vor 3 Tagen' : locale === 'ja' ? '3日前' : '3 days ago',
      price: data.currency,
    },
    sampleFormats: {
      referenceInstant: '2026-09-28T09:15:00Z',
      date: data.date,
      dateTime: data.dateTime,
      number: data.number,
      currency: data.currency,
      relativeTime: locale === 'de' ? 'vor 3 Tagen' : locale === 'ja' ? '3日前' : '3 days ago',
    },
  };
}

/** The real ladder's outcomes for the headers the tests send. */
function negotiateOutcome(header: string): { locale: 'en' | 'de' | 'ja'; matchedVia: string } {
  if (header === 'de-AT,ja;q=0.8,en;q=0.5') return { locale: 'de', matchedVia: 'primary' };
  if (header === 'ja') return { locale: 'ja', matchedVia: 'exact' };
  if (header === 'fr-CA,*;q=0.5') return { locale: 'en', matchedVia: 'wildcard' };
  if (header === '*;q=1,de;q=0.5') return { locale: 'de', matchedVia: 'exact' };
  if (header.startsWith('en')) return { locale: 'en', matchedVia: 'primary' };
  return { locale: 'en', matchedVia: 'default' };
}

function parseRanges(header: string): Array<{ range: string; q: number }> {
  return header
    .split(',')
    .map((part) => part.split(';'))
    .map(([range, param]) => ({
      range: (range ?? '').trim().toLowerCase(),
      q: param !== undefined && param.trim().startsWith('q=') ? Number(param.split('=')[1]) : 1,
    }))
    .filter((entry) => entry.range !== '');
}

function stubI18nServer() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === NEGOTIATE_URL) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const header = headers['Accept-Language'] ?? '';
      const outcome = negotiateOutcome(header);
      return jsonLike({
        ...messagesPayload(outcome.locale, outcome.matchedVia),
        negotiation: { acceptLanguage: header, parsed: parseRanges(header), considered: parseRanges(header) },
      });
    }
    if (url.startsWith('/api/demo/i18n/messages')) {
      const locale = url.split('locale=')[1];
      if (locale === 'de') return jsonLike(messagesPayload('de', 'explicit'));
      if (locale === 'ja') return jsonLike(messagesPayload('ja', 'explicit'));
      return jsonLike(messagesPayload('en', 'explicit'));
    }
    if (url === LOCALES_URL) {
      return jsonLike({
        defaultLocale: 'en',
        demoInstant: '2026-09-28T09:15:00Z',
        locales: [
          { locale: 'en', displayName: 'English', endonym: 'English', flagEmoji: '🇬🇧', dir: 'ltr', exampleAcceptLanguage: 'en-GB,en;q=0.9,*;q=0.5' },
          { locale: 'de', displayName: 'German', endonym: 'Deutsch', flagEmoji: '🇩🇪', dir: 'ltr', exampleAcceptLanguage: 'de-DE,de-AT;q=0.9,en;q=0.5' },
          { locale: 'ja', displayName: 'Japanese', endonym: '日本語', flagEmoji: '🇯🇵', dir: 'ltr', exampleAcceptLanguage: 'ja,en-US;q=0.8,*;q=0.3' },
        ],
      });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
  });
}

describe('I18nDemo — the negotiator and the formats lab', () => {
  it('negotiates the weighted header: de via primary, German messages, frozen formats', async () => {
    vi.stubGlobal('fetch', stubI18nServer());
    render(<I18nDemo />);

    await screen.findByTestId('i18n-lab-table');
    fireEvent.click(screen.getByTestId('i18n-negotiate-button'));

    const result = await screen.findByTestId('i18n-result');
    expect(screen.getByTestId('i18n-matched-locale')).toHaveTextContent('de');
    expect(screen.getByTestId('i18n-matched-via')).toHaveTextContent('primary');
    // The consideration trace: q-sorted, wildcard would be last.
    expect(screen.getByTestId('i18n-trace')).toHaveTextContent('de-at');
    expect(screen.getByTestId('i18n-trace')).toHaveTextContent('q=0.8');
    // German copy and German conventions:
    expect(screen.getByTestId('i18n-greeting')).toHaveTextContent('Willkommen');
    expect(screen.getByTestId('i18n-format-number')).toHaveTextContent('12.345,678');
    expect(screen.getByTestId('i18n-format-date')).toHaveTextContent('September');
    expect(result).toHaveTextContent('Vary: Accept-Language');
  });

  it('the direct strip switches locales explicitly (ja: exact match, both plurals other)', async () => {
    vi.stubGlobal('fetch', stubI18nServer());
    render(<I18nDemo />);

    await screen.findByTestId('i18n-lab-table');
    fireEvent.click(screen.getByTestId('i18n-direct-ja'));

    await screen.findByTestId('i18n-result');
    expect(screen.getByTestId('i18n-matched-locale')).toHaveTextContent('ja');
    expect(screen.getByTestId('i18n-matched-via')).toHaveTextContent('explicit');
    expect(screen.getByTestId('i18n-greeting')).toHaveTextContent('ようこそ');
    // The plural teaching gem: count 1 AND 3 are 'other' in CLDR ja.
    expect(screen.getByTestId('i18n-post-counts')).toHaveTextContent('CLDR plural: other');
    expect(screen.queryByText('CLDR plural: one')).toBeNull();
  });

  it("the browser button sends the navigator's own preference list as the header", async () => {
    const fetchMock = stubI18nServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<I18nDemo />);

    await screen.findByTestId('i18n-lab-table');
    fireEvent.click(screen.getByTestId('i18n-browser-button'));

    const nav = navigator as Navigator & { languages?: readonly string[] };
    const expected = (nav.languages ?? [nav.language]).join(',');
    expect(fetchMock).toHaveBeenCalledWith(NEGOTIATE_URL, {
      headers: { 'Accept-Language': expected },
    });
    await screen.findByTestId('i18n-result');
    expect(screen.getByTestId('i18n-negotiator-input')).toHaveValue(expected);
  });

  it('the formats lab renders all three locales client-side beside the server row', async () => {
    vi.stubGlobal('fetch', stubI18nServer());
    render(<I18nDemo />);

    const table = await screen.findByTestId('i18n-lab-table');
    const rows = screen.getAllByTestId('i18n-lab-row');
    expect(rows).toHaveLength(3);
    // Client-computed (jsdom runs Node ICU): the three conventions side by side.
    expect(table).toHaveTextContent('September 28, 2026');
    expect(table).toHaveTextContent('12.345,678');
    expect(table).toHaveTextContent('2026年9月28日');
    expect(table).toHaveTextContent('Deutsch');

    // Selecting de fetches the server's de payload into the last column:
    fireEvent.click(screen.getByTestId('i18n-lab-de'));
    await waitFor(() => {
      expect(screen.getAllByTestId('i18n-lab-server-cell')[1]).toHaveTextContent(
        '28. September 2026',
      );
    });
    expect(screen.getAllByTestId('i18n-lab-server-cell')[1]).toHaveTextContent('1.234,50');
  });

  it('degrades to reachable-server messages per panel, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<I18nDemo />);

    expect(await screen.findByTestId('i18n-lab-failed')).toHaveTextContent(
      'could not reach the server',
    );

    fireEvent.click(screen.getByTestId('i18n-negotiate-button'));
    expect(await screen.findByTestId('i18n-negotiator-failed')).toHaveTextContent(
      'could not reach the server',
    );
  });
});

