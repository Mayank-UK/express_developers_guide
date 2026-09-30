/**
 * The i18n topic's demo dictionary and formatting model (pure domain — no
 * HTTP, no Express). Three locales on purpose: en (the default, Latin), de
 * (Latin but with visibly different number/date conventions AND a 'one'
 * plural), ja (non-Latin script, and — the teaching gem — NO 'one' plural
 * category at all: Japanese plural rules only know 'other').
 *
 * Two disciplines live here that the topic teaches:
 * 1. Every formatted sample is computed from ONE frozen instant in UTC, so
 *    responses are deterministic and assertable (a "now"-relative demo can
 *    never be tested; a frozen one can).
 * 2. Dictionary lookup falls back to the default locale's entry and NEVER
 *    surfaces a raw key to a user — a missing key is a bug to fix, not text
 *    to render.
 */

/** The demo's frozen reference instant — every date/time sample comes from it. */
export const DEMO_INSTANT_ISO = '2026-09-28T09:15:00Z' as const;

const DEMO_INSTANT = new Date(DEMO_INSTANT_ISO);

/** The number the currency samples format (EUR — a pre-euro-format locale trio). */
const DEMO_CURRENCY_AMOUNT = 1234.5;

/** The number the plain grouping samples format. */
const DEMO_NUMBER = 12345.678;

/** The counts the plural examples resolve (one vs other is the whole lesson). */
const DEMO_PLURAL_COUNTS = [1, 3] as const;

export type SupportedLocale = 'en' | 'de' | 'ja';

/** Registry order matters: the first entry is the default/fallback locale. */
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['en', 'de', 'ja'];

export const DEFAULT_LOCALE: SupportedLocale = SUPPORTED_LOCALES[0];

/** Locale metadata the /locales endpoint serves and the client renders. */
export interface LocaleMetadata {
  locale: SupportedLocale;
  /** English name (what the guide's UI chrome shows). */
  displayName: string;
  /** The locale's own name for itself (what the locale's users expect to see). */
  endonym: string;
  /**
   * A flag is a COUNTRY and a locale is a LANGUAGE — the pairing is sloppy
   * (en-GB picked over en-US to make the point). Kept because demos benefit
   * from a glanceable glyph; the topic says the quiet part out loud.
   */
  flagEmoji: string;
  /** Text direction. All three demo locales are ltr; ar/he would be 'rtl'. */
  dir: 'ltr' | 'rtl';
  /** A realistic Accept-Language a browser for this locale might send. */
  exampleAcceptLanguage: string;
}

export const LOCALE_METADATA: Readonly<Record<SupportedLocale, LocaleMetadata>> = {
  en: {
    locale: 'en',
    displayName: 'English',
    endonym: 'English',
    flagEmoji: '🇬🇧',
    dir: 'ltr',
    exampleAcceptLanguage: 'en-GB,en;q=0.9,*;q=0.5',
  },
  de: {
    locale: 'de',
    displayName: 'German',
    endonym: 'Deutsch',
    flagEmoji: '🇩🇪',
    dir: 'ltr',
    exampleAcceptLanguage: 'de-DE,de-AT;q=0.9,en;q=0.5',
  },
  ja: {
    locale: 'ja',
    displayName: 'Japanese',
    endonym: '日本語',
    flagEmoji: '🇯🇵',
    dir: 'ltr',
    exampleAcceptLanguage: 'ja,en-US;q=0.8,*;q=0.3',
  },
};

/**
 * The demo dictionary. Keys are stable ids; values are per-locale strings.
 * Plural messages carry a form per CLDR plural category the locale uses —
 * en/de use {one, other}; ja uses ONLY {other} (its CLDR plural rules have
 * no singular/plural distinction), which is exactly why pluralization cannot
 * be hand-rolled per language and must go through Intl.PluralRules.
 */
export interface DemoDictionary {
  greeting: string;
  farewell: string;
  /** {count} is interpolated; the form is chosen by CLDR plural category. */
  postCount: Readonly<Partial<Record<'zero' | 'one' | 'two' | 'few' | 'many' | 'other', string>>>;
}

export const DEMO_DICTIONARIES: Readonly<Record<SupportedLocale, DemoDictionary>> = {
  en: {
    greeting: 'Welcome to the internationalization demo.',
    farewell: 'Goodbye — see you in the next topic.',
    postCount: { one: '{count} post', other: '{count} posts' },
  },
  de: {
    greeting: 'Willkommen zur Internationalisierungs-Demo.',
    farewell: 'Auf Wiedersehen — bis zum nächsten Thema.',
    postCount: { one: '{count} Beitrag', other: '{count} Beiträge' },
  },
  ja: {
    greeting: '国際化デモへようこそ。',
    farewell: 'さようなら — 次のトピックで会いましょう。',
    postCount: { other: '{count} 件の投稿' },
  },
};

/**
 * Hard-invariant backstop: negotiation and validation only ever produce
 * members of SUPPORTED_LOCALES, so this never actually substitutes — but a
 * future refactor that breaks that invariant gets the default dictionary,
 * not a crash or a raw key in a response.
 */
export function asSupportedLocale(value: string): SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? (value as SupportedLocale)
    : DEFAULT_LOCALE;
}

/**
 * Tiny {placeholder} interpolation. Unknown placeholders are left in place
 * (visible in review, greppable in logs) rather than silently dropped — the
 * same "missing is a bug, show it" discipline as dictionary fallbacks.
 */
export function interpolate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

/**
 * Relative-time formatting against a "now" (injectable so unit tests are
 * deterministic; routes pass the real serve time). Ladder picks the largest
 * unit that keeps the value >= 1; numeric: 'auto' lets ICU say "now" at 0.
 */
export function formatRelativeTime(locale: string, instant: Date, now: number): string {
  const deltaSeconds = Math.round((instant.getTime() - now) / 1000);
  const abs = Math.abs(deltaSeconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(deltaSeconds, 'second');
  if (abs < 3_600) return rtf.format(Math.round(deltaSeconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(deltaSeconds / 3_600), 'hour');
  if (abs < 86_400 * 45) return rtf.format(Math.round(deltaSeconds / 86_400), 'day');
  return rtf.format(Math.round(deltaSeconds / (86_400 * 30)), 'month');
}

/** The resolved message set a locale response serves. */
export interface DemoMessagesPayload {
  greeting: string;
  farewell: string;
  /** count-aware plural examples — the plural CATEGORY rides along as data. */
  postCounts: ReadonlyArray<{ count: number; pluralCategory: string; text: string }>;
  /** Relative age of the frozen instant, computed at serve time. */
  uploadedAt: string;
  /** Currency sample (message-shaped because it reads as copy in the UI). */
  price: string;
}

/** Intl-formatted samples, all from the frozen instant in UTC. */
export interface DemoSampleFormats {
  referenceInstant: string;
  date: string;
  dateTime: string;
  number: string;
  currency: string;
  relativeTime: string;
}

/** How the locale was chosen — the negotiation story, carried to the client. */
export type LocaleMatchVia = 'explicit' | 'exact' | 'primary' | 'wildcard' | 'default';

export interface LocalePayload {
  locale: SupportedLocale;
  matchedVia: LocaleMatchVia;
  messages: DemoMessagesPayload;
  sampleFormats: DemoSampleFormats;
}

/**
 * Builds one locale's full demo payload. Pure except for the injectable
 * `now` (defaults to real time — the one serve-time-relative value is
 * uploadedAt/relativeTime; everything else is frozen-instant deterministic).
 */
export function buildLocalePayload(
  locale: SupportedLocale,
  matchedVia: LocaleMatchVia,
  now: number = Date.now(),
): LocalePayload {
  const dict = DEMO_DICTIONARIES[locale] ?? DEMO_DICTIONARIES[DEFAULT_LOCALE];
  const rules = new Intl.PluralRules(locale);

  const postCounts = DEMO_PLURAL_COUNTS.map((count) => {
    const category = rules.select(count);
    // Missing form → 'other' → default dictionary's 'other' → a literal last
    // resort the type system can see: a missing plural form is a bug to fix,
    // never a raw key or a crash in a user-facing response.
    const template =
      dict.postCount[category] ??
      dict.postCount.other ??
      DEMO_DICTIONARIES[DEFAULT_LOCALE].postCount.other ??
      '{count}';
    return { count, pluralCategory: category, text: interpolate(template, { count }) };
  });

  // timeZone pinned to UTC on PURPOSE: the frozen instant means nothing
  // without it, and "always pass timeZone explicitly" is the topic's rule.
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(DEMO_INSTANT);
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(DEMO_INSTANT);
  const number = new Intl.NumberFormat(locale).format(DEMO_NUMBER);
  const currency = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
    DEMO_CURRENCY_AMOUNT,
  );
  const relativeTime = formatRelativeTime(locale, DEMO_INSTANT, now);

  return {
    locale,
    matchedVia,
    messages: {
      greeting: dict.greeting,
      farewell: dict.farewell,
      postCounts,
      uploadedAt: relativeTime,
      price: currency,
    },
    sampleFormats: {
      referenceInstant: DEMO_INSTANT_ISO,
      date,
      dateTime,
      number,
      currency,
      relativeTime,
    },
  };
}
