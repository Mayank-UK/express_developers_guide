import type { Topic } from '../types.js';

/**
 * The Internationalization topic: the web is locale-diverse by default, and
 * "supporting other languages" splits into two almost-independent problems —
 * NEGOTIATING which language to serve (Accept-Language) and FORMATTING data
 * for a locale (Intl). Everything shown here runs for real in this app:
 * domain/i18n/negotiate.ts parses and matches, domain/i18n/locales.ts holds
 * the dictionaries and formats every sample from one frozen UTC instant,
 * and the live negotiator drives all of it.
 */
export const topicInternationalization: Topic = {
  id: 'internationalization',
  title: 'Internationalization',
  subtitle: 'Accept-Language negotiation, dictionaries, and formatting with Intl.',
  group: 'internationalization',
  order: 1,
  sections: [
    {
      id: 'i18n-global',
      title: 'Global by default',
      lead:
        'Most of your users were not your users until you checked. Language, region, and format are three different axes, and most of what people call "i18n" is really deciding which axis a given feature lives on.',
      blocks: [
        {
          kind: 'text',
          id: 'i18n-global:axes',
          body: `THE WEB IS LOCALE-DIVERSE BY DEFAULT: publish an API and the first requests arrive from browsers configured for languages you have never typed. Before writing any i18n code, separate the three axes people habitually smear together. LANGUAGE is which human tongue content is written in — English, German, Japanese (BCP 47 tags: en, de, ja; regional spellings de-AT, en-GB). REGION is where the user is — it biases language choice (de-AT suggests German as spoken in Austria) but also chooses currency and units, which are NOT language. FORMAT is how numbers, dates, and times are shaped for a locale — 1,234.50 vs 1.234,50; September 28, 2026 vs 28. September 2026 vs 2026年9月28日 — and format follows the LOCALE, not the region. The separation matters because they fail independently: you can negotiate German perfectly and still print American dates into German sentences (the classic "am 09/28/26 um 14:00" embarrassment), and you can format flawlessly while serving the wrong language. WHERE I18N LIVES IN AN API — the decision most backend teams get wrong by over-building: the CLIENT formats, the SERVER negotiates and canonicalizes. A JSON API should store and return CANONICAL DATA — timestamps as ISO 8601 UTC, numbers as machine units, ids as strings — and let each client format for its own user: the same response then renders correctly for a browser in Berlin, a phone in Osaka, and a cron job in Virginia without the server knowing or caring who is asking. The server owes localized TEXT only when it owns localized CONTENT — error messages meant for humans, editorial strings, marketing copy, this guide's demo dictionary — and that is exactly when Accept-Language negotiation earns its keep. The failure mode to avoid is the server trying to format "for the user": it does not know the user's timezone (the header that would tell it lies half the time), it cannot know the UI's rendering context, and every format decision it makes is one the client has to undo. This topic's split mirrors that rule: negotiation (server work) first, formatting with Intl (edge work, shown server-side only to prove the machinery) second.`,
        },
      ],
    },
    {
      id: 'i18n-accept-language',
      title: 'Accept-Language negotiation',
      lead:
        'The header, the grammar, and the match ladder — then the real parser and negotiator this app runs, and the caching interaction most teams forget.',
      blocks: [
        {
          kind: 'text',
          id: 'i18n-accept-language:grammar-and-ladder',
          body: `THE HEADER: every mainstream browser sends Accept-Language on every request, built from the user's language preference list — de-AT,ja;q=0.8,en;q=0.5,*;q=0.3. THE GRAMMAR (RFC 9110 weights over RFC 4647 ranges): a comma-separated list of LANGUAGE-RANGES, each optionally carrying a Q-WEIGHT ;q=0…1 — a decimal preference strength where absent means 1. A range is a BCP 47 tag fragment ('de', 'de-AT', 'zh-Hant') or the WILDCARD '*' meaning "anything". Two details the grammar hides: weights are not percentages and not sorted — 'en;q=0.9,de' means German (q=1, merely written second) beats English (0.9), so you must SORT BY Q, never by position; and Q=0 is a positive statement — "explicitly not acceptable" — not a typo'd low preference. THE MATCH LADDER this app implements (and the demo below drives): consider ranges ordered by q descending, and for each, try EXACT match against a supported locale (de-AT over supported de-AT), then PRIMARY SUBTAG fallback (de-AT → supported de — a regional tag is served by its language), and only after every NAMED range has had its turn, the WILDCARD, which serves the default locale. Nothing matched at all (absent header, only-unsupported languages) → the DEFAULT locale, and that default is a product decision that must exist: you always serve SOME language. One deliberate deviation from naive q-ordering, because it is the classic bug: the wildcard is ranked LAST regardless of its weight — '*;q=1,de;q=0.5' must answer de, because "any language, weight 1" must never outrank a NAMED preference; browsers themselves always send '*' at the bottom of their lists. THE CACHING INTERACTION — where negotiation meets the caching topic: a negotiated response differs BY REQUEST HEADER, so any cache in front of it MUST see Vary: Accept-Language, or a shared cache will happily serve the German-speaking requester's copy to the Japanese one. Vary is not decoration: it tells caches which request headers are part of the cache key. The negotiate endpoint below sets exactly that header — and its spec asserts it. (The same reasoning, one header over, is why the CORS middleware varies on Origin and the content-negotiation demo varies on Accept.)`,
        },
        {
          kind: 'code',
          id: 'i18n-accept-language:verbatim-parser',
          language: 'ts',
          source: 'server/src/domain/i18n/negotiate.ts',
          caption: 'Verbatim — the parser (domain/i18n/negotiate.ts); malformed input never throws',
          code: `export interface LanguageRange {
  range: string; // lowercased exactly as written: 'de-at', 'ja', '*'
  q: number;    // clamped to [0, 1]; absent or malformed params mean 1
}

const LANGUAGE_RANGE_PATTERN = /^(?:\\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)$/;

export function parseAcceptLanguage(header: string): LanguageRange[] {
  if (header.trim() === '') return [];
  const entries: LanguageRange[] = [];
  for (const part of header.split(',')) {
    const segments = part.split(';');
    const range = segments[0].trim().toLowerCase();
    if (!LANGUAGE_RANGE_PATTERN.test(range)) continue; // malformed → ignored
    let q = 1;
    for (const param of segments.slice(1)) {
      const equals = param.indexOf('=');
      if (equals === -1) continue;
      if (param.slice(0, equals).trim().toLowerCase() !== 'q') continue;
      const raw = param.slice(equals + 1).trim();
      if (raw === '') continue;      // 'q=' → malformed → stays 1
      const parsed = Number(raw);    // 'abc' → NaN → stays 1
      if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
    }
    entries.push({ range, q });
  }
  return entries;
}`,
        },
        {
          kind: 'code',
          id: 'i18n-accept-language:verbatim-negotiator',
          language: 'ts',
          source: 'server/src/domain/i18n/negotiate.ts',
          caption: 'Verbatim — the match ladder (domain/i18n/negotiate.ts)',
          code: `export function negotiateLocale(
  header: string,
  supported: readonly string[],
  defaultLocale: string,
): LocaleNegotiation {
  const lower = supported.map((tag) => tag.toLowerCase());
  const def = defaultLocale.toLowerCase();

  const parsed = parseAcceptLanguage(header)
    .filter((entry) => entry.q > 0) // q=0: explicitly not acceptable
    .sort((a, b) => b.q - a.q); // Array#sort is stable: ties keep order
  const named = parsed.filter((entry) => entry.range !== '*');
  const wildcard = parsed.find((entry) => entry.range === '*');
  // The wildcard is appended LAST on purpose — a named preference at any
  // weight must never be shadowed by "anything" at a higher one.
  const considered = wildcard !== undefined ? [...named, wildcard] : named;

  for (const entry of considered) {
    if (entry.range === '*') {
      return { locale: def, matchedVia: 'wildcard', considered };
    }
    const exactIndex = lower.indexOf(entry.range);
    if (exactIndex !== -1) {
      return { locale: supported[exactIndex] ?? defaultLocale, matchedVia: 'exact', considered };
    }
    const primary = entry.range.split('-')[0] ?? '';   // 'de-at' → 'de'
    const primaryIndex = lower.indexOf(primary);
    if (primaryIndex !== -1) {
      return { locale: supported[primaryIndex] ?? defaultLocale, matchedVia: 'primary', considered };
    }
  }
  return { locale: def, matchedVia: 'default', considered };
}`,
        },
        {
          kind: 'demo',
          id: 'i18n-accept-language:negotiator-demo',
          demoId: 'i18n:negotiator',
          title: 'The i18n negotiator: Accept-Language in, matched locale + localized payload out',
          description:
            'Drive the real Accept-Language negotiator: type a header (or send your browser\u2019s own), see the matched locale, the match-ladder verdict (exact / primary / wildcard / default), the parsed ranges in order, the localized dictionary with CLDR plural categories, and frozen-instant Intl formats — then compare locales directly and see the same instant and numbers formatted in all three locales, computed client-side.',
        },
      ],
    },
    {
      id: 'i18n-content',
      title: 'Serving localized content',
      lead:
        'When the server does own words: bundled dictionaries, lookup discipline, interpolation, and the plural problem that eats naive implementations.',
      blocks: [
        {
          kind: 'text',
          id: 'i18n-content:dictionaries',
          body: `THE SHAPE: a DICTIONARY PER LOCALE — a map from stable message keys to that locale's strings — bundled as code (this demo), as JSON files, or loaded from a translation service; the mechanism is identical. Three disciplines make the difference between a maintainable catalog and a screen full of broken copy. (1) A KEY PER MESSAGE, never prose in components: the component says t('greeting'), the dictionary says what greeting means in each locale — which is what lets translators work without touching code and lets keys be audited ('which locales are missing the new string?' is a script, not an archaeology dig). (2) FALL BACK TO THE DEFAULT LOCALE, NEVER TO THE KEY: a German response missing one key serves the English string (user sees an English sentence — a bug filed quietly) rather than the literal text "greeting" (user sees the inside of your code — trust damage). (3) A MISSING KEY IS A BUG, NEVER USER-FACING VISIBLE TEXT: fallback is the containment; CI checks that every key exists in every locale are the cure. INTERPOLATION: real messages contain values — '3 posts', 'uploaded 2 hours ago' — and the safe pattern is placeholder substitution on the dictionary side, exactly what this demo's interpolate() does ({count} replaced, unknown placeholders left visible on purpose so they surface in review), never template literals built in the component (which silently re-couples copy to code). THE PLURAL PROBLEM — the one that eats naive implementations: 'you have 1 post / 2 posts' is not the world's plural rule, it is ENGLISH's. CLDR (the Unicode Common Locale Data Repository — the industry's locale-rule database, and the data underneath every Intl call) defines SIX plural categories: zero, one, two, few, many, other — and each language picks its own. English uses one/other. German uses one/other (but with different boundaries). Arabic uses all six. JAPANESE USES ONLY 'other' — Japanese grammar does not distinguish singular from plural the way European languages do, so '1 post' and '3 posts' are the same FORM. That is why a dictionary's plural messages are maps from category to form, and why the category is chosen by Intl.PluralRules (CLDR's rules, already in your runtime), never by if (count === 1). This demo's /messages response carries both counts WITH their computed categories — for ja, both are 'other', visible in the live demo: the single most convincing i18n fact you can show a backend engineer in one table row.`,
        },
        {
          kind: 'code',
          id: 'i18n-content:verbatim-dictionary',
          language: 'ts',
          source: 'server/src/domain/i18n/locales.ts',
          caption: 'Verbatim — the demo dictionaries + plural resolution (domain/i18n/locales.ts)',
          code: `export const DEMO_DICTIONARIES: Readonly<Record<SupportedLocale, DemoDictionary>> = {
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
    postCount: { other: '{count} 件の投稿' }, // ja knows ONLY 'other' (CLDR)
  },
};

// Resolution: the CATEGORY comes from CLDR via Intl.PluralRules — never
// from count === 1 — and a missing form falls back 'other' → default
// dictionary: a bug to fix, never a raw key in a user's face.
const rules = new Intl.PluralRules(locale);
const category = rules.select(count);
const template =
  dict.postCount[category] ??
  dict.postCount.other ??
  DEMO_DICTIONARIES[DEFAULT_LOCALE].postCount.other ??
  '{count}';
return { count, pluralCategory: category, text: interpolate(template, { count }) };
//   '{count} Beiträge' + { count: 3 } → '3 Beiträge'`,
        },
      ],
    },
    {
      id: 'i18n-intl',
      title: 'Formatting with Intl',
      lead:
        'The runtime already carries the CLDR data. DateTimeFormat with an explicit time zone, NumberFormat for grouping and currency, RelativeTimeFormat for "2 hours ago" — all shown from one frozen instant.',
      blocks: [
        {
          kind: 'text',
          id: 'i18n-intl:builtin',
          body: `THE LIBRARY YOU ALREADY HAVE: Node ships the full ICU (International Components for Unicode) — the same CLDR-backed engine browsers carry — so Intl.* is builtin with zero dependencies, in the server and the client alike. THE FOUR CALLS THAT COVER ALMOST EVERYTHING. Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }) — dates; and the rule in the options is not optional: ALWAYS PASS timeZone EXPLICITLY. Omit it and the formatter uses the runtime's local zone — on your laptop that is your zone, on the server whatever the container believes, and the "same" code formats the same instant differently in two places; every sample in this demo pins UTC both for correctness and so responses are assertable. Intl.NumberFormat(locale) — grouping and decimal separators (12,345.678 vs 12.345,678 — the en/de contrast that makes the point fastest); with { style: 'currency', currency: 'EUR' } it places the symbol and picks the decimals per locale (€1,234.50 vs 1.234,50 € — note where the space went, or rather that German uses a non-breaking one). Intl.RelativeTimeFormat(locale, { numeric: 'auto' }) — "2 hours ago" / "vor 2 Stunden" / "2時間前", the phrase every product reinvents badly; give it a signed value and a unit and CLDR owns the grammar. Intl.PluralRules(locale) — the plural-category oracle from the previous section. NEVER HAND-ROLL DATE MATH ACROSS LOCALES: the list of things you will get wrong is long and dignified — month names, era markers (ja dates carry the era 年号), non-Gregorian calendars (ja can render in a different calendar entirely depending on options), week starts, 12/24-hour clocks, digit shaping — and all of it is already correct in ICU, maintained by people whose job it is. THE STORAGE RULE that makes Intl pleasant: STORE ISO 8601 UTC, CONVERT AT THE EDGE. The database and the API speak one canonical dialect — new Date().toISOString(), 2026-09-28T09:15:00Z — and the instant becomes local prose in exactly one place, as close to the user's eyes as possible. This demo proves the discipline in miniature: every sample it serves is formatted from ONE frozen instant (2026-09-28T09:15:00Z) with timeZone: 'UTC', which is why the specs can assert exact strings like 'September 28, 2026' and '12.345,678' — deterministic because canonical at rest, converted only at render.`,
        },
        {
          kind: 'code',
          id: 'i18n-intl:verbatim-formats',
          language: 'ts',
          source: 'server/src/domain/i18n/locales.ts',
          caption: 'Verbatim — the frozen-instant sample builder (domain/i18n/locales.ts)',
          code: `// ONE frozen instant, shared by every sample — the demo's determinism
// contract: fixed input, pinned UTC, so output is assertable in specs.
export const DEMO_INSTANT_ISO = '2026-09-28T09:15:00Z' as const;
const DEMO_INSTANT = new Date(DEMO_INSTANT_ISO);

// Relative-time: give it a signed value and a unit; numeric: 'auto' lets ICU
// say "now" at 0 (inside formatRelativeTime — a ladder picks the unit):
const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
if (abs < 60) return rtf.format(deltaSeconds, 'second');
if (abs < 3_600) return rtf.format(Math.round(deltaSeconds / 60), 'minute');
if (abs < 86_400) return rtf.format(Math.round(deltaSeconds / 3_600), 'hour');
//   en → '2 hours ago'   de → 'vor 2 Stunden'   ja → '2時間前'

// The frozen-instant samples (inside buildLocalePayload) — timeZone pinned
// to UTC on PURPOSE: "always pass timeZone explicitly" is the topic's rule:
const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(DEMO_INSTANT);
//   en → 'September 28, 2026'   de → '28. September 2026'   ja → '2026年9月28日'
const dateTime = new Intl.DateTimeFormat(locale, {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'UTC',
}).format(DEMO_INSTANT);
//   en → 'September 28, 2026 at 9:15 AM'   de → '28. September 2026 um 09:15'
const number = new Intl.NumberFormat(locale).format(DEMO_NUMBER);
//   en → '12,345.678'   de → '12.345,678'   ja → '12,345.678'
const currency = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
  DEMO_CURRENCY_AMOUNT,
);
//   en → '€1,234.50'   de → '1.234,50 €' (nbsp)   ja → '€1,234.50'`,
        },
      ],
    },
    {
      id: 'i18n-timezones',
      title: 'Time zones vs locales',
      lead:
        'The confusion that produces wrong timestamps in every product once: the locale decides HOW a moment is written; the time zone decides WHICH moment is meant. Independent axes, and DST is out to get you either way.',
      blocks: [
        {
          kind: 'text',
          id: 'i18n-timezones:axes',
          body: `TWO ORTHOGONAL DIALS, always separate in your head and usually in your code: the LOCALE decides the FORMAT of a moment (September 28 vs 28. September vs 2026年9月28日, 12h vs 24h, the label spelling) and the TIME ZONE decides the VALUE-AT-A-PLACE (which 9:15 AM, whose 9:15 AM). A German locale in Tokyo time prints German words around Tokyo o'clock; an English locale in Berlin time prints English words around Berlin o'clock — both are perfectly valid combinations, which is exactly why one cannot be derived from the other and any code that tries (de → Europe/Berlin, the classic) is already wrong for Germans in Zurich, Austrians anywhere, and the entire German diaspora. THE SERVER'S HALF of the deal is minimal and strict: STORE AND SPEAK UTC (ISO 8601, the Z suffix), NAME time zones when a human chose one (persist 'Europe/Berlin', never '+02:00' — see the DST trap), and NEVER guess a user's zone from their language. THE CLIENT'S HALF: it knows the user's actual zone (Intl.DateTimeFormat().resolvedOptions().timeZone in the browser — a name like 'Asia/Tokyo', not an offset), so the edge converts canonical UTC to the user's wall clock at render. THE DST TRAPS, because they are ambushes even in "UTC everywhere" systems: (1) OFFSETS ARE NOT ZONES — 'Europe/Berlin' is +01:00 in winter and +02:00 in summer, so a stored offset is wrong half the year and a stored ZONE lets arithmetic find the right offset for each instant; (2) DST TRANSITIONS HAVE GAPS AND OVERLAPS — spring-forward deletes an hour (02:30 does not exist that night; a daily 02:30 cron either skips or fires early depending on your scheduler), fall-back repeats one (01:15 happens twice; a timestamp without zone can say which); (3) DAY LENGTH IS NOT 24 HOURS — "same time tomorrow" across a transition is 23 or 25 hours of real elapsed time, and date arithmetic in fixed 86400-second steps drifts across every boundary; (4) MIDNIGHT IS NOT UNIVERSAL — 'the start of the day' is zone-dependent, so date-bucketed reports (per-day post counts) must declare WHICH zone buckets the day, or Berlin and Tokyo slice the same events into different days. None of these are exotic: each one ships in a real product roughly once per team, and the fix is always the same two habits — canonical UTC on the wire, named zones wherever a human's calendar matters.`,
        },
      ],
    },
    {
      id: 'i18n-workflow',
      title: 'Translation workflow',
      lead:
        'Keys in code, translations in files, the catalog ecosystem, pseudo-locales, and the one paragraph of RTL you need before your first Arabic user.',
      blocks: [
        {
          kind: 'text',
          id: 'i18n-workflow:keys-and-files',
          body: `THE WORKFLOW that scales past one bilingual founder: KEYS LIVE IN CODE, TRANSLATIONS LIVE IN FILES. Developers reference t('post_count') and ship; translators work the files (or a translation-management UI over them) without a code review; a CI step diffs key sets across locales and fails when one is missing an entry — the automated version of "a missing key is a bug". The FILES are usually namespaced JSON per locale (en.json, de.json, ja.json) or per-namespace chunks (errors.json, posts.json) when the catalog grows past a few hundred keys; this demo bundles TypeScript dictionaries because three locales of five strings do not earn a loading mechanism, and the moment they do, the same keys move to JSON and nothing else changes. THE CATALOG ECOSYSTEM — what to reach for at real scale, none of it installed here because the mechanism is the lesson: i18next (the de-facto standard: interpolation, plurals via Intl.PluralRules under the hood, namespaces, lazy loading, React bindings), FormatJS/react-intl (ICU MessageFormat syntax — the format professional translators already speak), and linguijs as the compile-time-leaning alternative. All of them encode the same three disciplines this topic taught by hand: stable keys, default-locale fallback, CLDR-driven plurals. PSEUDO-LOCALIZATION — the cheapest i18n test nobody runs: mechanically transform your source strings (accented characters, bracket-wrapped padding: 'Wêlçômê tô thê démô [……]') and render the whole app in the fake locale before translation exists. It catches the two bugs that otherwise wait for your first real German user: HARDCODED strings that bypass the catalog (they stay in plain English — instantly visible) and LAYOUT that breaks at 130% text length (German compounds run long; the padding finds your fixed-width components). RTL IN ONE PARAGRAPH: locales have a text DIRECTION — English/German/Japanese are LTR; Arabic, Hebrew, Farsi, and Urdu are RTL — and it is why this demo's locale metadata carries dir: 'ltr' next to every locale (and why the field exists at all: the day ar or he joins the catalog, the UI flips mirrored layouts via the dir attribute and CSS logical properties, and every demo panel that ignored direction becomes visibly wrong). The backend's entire RTL job is to serve the field with the locale metadata so the client can set dir= correctly; rendering RTL is the client's discipline. One honest note: flags are countries and languages are not — this demo's 🇩🇪 next to 'de' is the sloppiness the metadata comments call out, kept because demos benefit from a glanceable glyph and dropped the moment it misleads.`,
        },
      ],
    },
    {
      id: 'i18n-live',
      title: 'The negotiator from a terminal',
      lead:
        'Two panels over the real code: an Accept-Language field that drives the actual negotiator (matched-locale badge, match-ladder verdict, localized messages, frozen-instant formats), and a formats lab that renders the same instant and number in all three locales — computing in YOUR browser, teaching that formatting is edge work.',
      blocks: [
        {
          kind: 'text',
          id: 'i18n-live:intro',
          body: `THE LAB'S TWO PANELS (the interactive lab now lives beside the Accept-Language negotiation section above). NEGOTIATOR: an Accept-Language field (prefilled 'de-AT,ja;q=0.8,en;q=0.5') fires GET /api/demo/i18n/negotiate with that exact header — the same parse-and-match ladder the topic walked — and renders the verdict: the matched locale, the matchedVia badge (exact / primary / wildcard / default), the parsed ranges in consideration order (q-sorted, wildcard last), the localized messages (greeting, farewell, the one-vs-three plural examples with their CLDR categories, the relative uploadedAt, the localized price), and the frozen-instant format table for the result locale. The "use my browser's languages" button fills the field from navigator.languages — what your browser actually sends on every request — and a direct en|de|ja strip hits ?locale= for explicit comparison: notice 'de-AT' negotiates to de but is a 400 as an explicit choice, the two endpoints' jobs in one click. FORMATS LAB: pick a locale and the same frozen instant (2026-09-28T09:15:00Z) and the same numbers render side by side in all three locales — computed in YOUR browser with the same Intl APIs, next to the server's values for the chosen locale. They agree (same ICU data both sides — the quiet lesson: the canonical instant plus Intl at the edge is reproducible everywhere), and the panel says when they would not: divergent ICU versions or an unpinned time zone. The curl block below drives the same surface from a terminal.`,
        },
        {
          kind: 'code',
          id: 'i18n-live:curl',
          language: 'bash',
          caption: 'The negotiator from a terminal — the ladder, the wildcard, the 400, the Vary',
          code: `# 1. The ladder in action: de-AT falls to de via PRIMARY subtag (note Vary):
curl -sD /tmp/h 'localhost:4000/api/demo/i18n/negotiate' \\
  -H 'Accept-Language: de-AT,ja;q=0.8,en;q=0.5' | jq '{locale, matchedVia, greeting: .messages.greeting}'
grep -i '^vary' /tmp/h    # → vary: Accept-Language

# 2. The classic ordering bug that ISN'T: a named tag beats a higher-q wildcard:
curl -s 'localhost:4000/api/demo/i18n/negotiate' -H 'Accept-Language: *;q=1,de;q=0.5' | jq '{locale, matchedVia}'

# 3. Nothing matches → wildcard serves the default; q=0 excludes a tag outright:
curl -s 'localhost:4000/api/demo/i18n/negotiate' -H 'Accept-Language: fr-CA,*;q=0.5' | jq '{locale, matchedVia}'
curl -s 'localhost:4000/api/demo/i18n/negotiate' -H 'Accept-Language: de;q=0,en'      | jq '{locale, matchedVia}'

# 4. Explicit choice: exact only — regional tags are /negotiate's job:
curl -s 'localhost:4000/api/demo/i18n/messages?locale=ja' | jq '{locale, matchedVia, sampleFormats: {date: .sampleFormats.date, number: .sampleFormats.number, currency: .sampleFormats.currency}, postCounts: .messages.postCounts}'
curl -s 'localhost:4000/api/demo/i18n/messages?locale=fr'  | jq '.error | {code, supported}'   # 400 + the list

# 5. The determinism contract: fixed instant, UTC, fixed numbers:
curl -s 'localhost:4000/api/demo/i18n/messages?locale=de' | jq '.sampleFormats' \\
  # date: "28. September 2026" · number: "12.345,678" · currency: "1.234,50 €"

# 6. The registry: locales, directions, example headers:
curl -s localhost:4000/api/demo/i18n/locales | jq`,
        },
      ],
    },
  ],
};
