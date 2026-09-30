import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `i18n:negotiator` — the Internationalization topic's
 * live surface over the real endpoints (i18n_demo_routes.ts +
 * domain/i18n/*):
 *
 * 1. NEGOTIATOR — an Accept-Language field (or your browser's own list)
 *    fires GET /api/demo/i18n/negotiate with that exact header; the result
 *    shows the matched locale, the match-ladder verdict (exact / primary /
 *    wildcard / default), the parsed ranges in consideration order, the
 *    localized dictionary, and the frozen-instant Intl formats. A direct
 *    en|de|ja strip hits ?locale= for explicit comparison.
 * 2. FORMATS LAB — the same frozen instant and the same numbers formatted
 *    in ALL THREE locales, computed HERE IN THE BROWSER with the same Intl
 *    APIs the server uses — formatting is edge work, and the client-side
 *    rows next to the server's values prove the point (same ICU data on
 *    both sides → same strings).
 */

const NEGOTIATE_URL = '/api/demo/i18n/negotiate';
const MESSAGES_URL = '/api/demo/i18n/messages';
const LOCALES_URL = '/api/demo/i18n/locales';

const DEFAULT_HEADER = 'de-AT,ja;q=0.8,en;q=0.5';
const HEADER_PRESETS = [
  { label: 'de-AT weighted', value: 'de-AT,ja;q=0.8,en;q=0.5' },
  { label: 'exact: ja', value: 'ja' },
  { label: 'wildcard', value: 'fr-CA,*;q=0.5' },
  { label: 'named beats *', value: '*;q=1,de;q=0.5' },
] as const;

/** Must mirror the server's frozen instant (domain/i18n/locales.ts). */
const DEMO_INSTANT = new Date('2026-09-28T09:15:00Z');
const DEMO_NUMBER = 12345.678;
const DEMO_CURRENCY_AMOUNT = 1234.5;

/** The lab's locale trio — also the registry /locales serves. */
const LAB_LOCALES = ['en', 'de', 'ja'] as const;

interface LocaleEntry {
  locale: string;
  displayName: string;
  endonym: string;
  flagEmoji: string;
  dir: string;
  exampleAcceptLanguage: string;
}

interface PostCountExample {
  count: number;
  pluralCategory: string;
  text: string;
}

interface LocalePayload {
  locale: string;
  matchedVia: string;
  messages: {
    greeting: string;
    farewell: string;
    postCounts: PostCountExample[];
    uploadedAt: string;
    price: string;
  };
  sampleFormats: {
    referenceInstant: string;
    date: string;
    dateTime: string;
    number: string;
    currency: string;
    relativeTime: string;
  };
}

interface NegotiatePayload extends LocalePayload {
  negotiation: {
    acceptLanguage: string;
    parsed: Array<{ range: string; q: number }>;
    considered: Array<{ range: string; q: number }>;
  };
}

type NegotiatorState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; payload: NegotiatePayload | LocalePayload; from: 'negotiate' | 'direct' }
  | { kind: 'failed'; problem: string };

type LabLocalesState =
  | { kind: 'loading' }
  | { kind: 'ready'; locales: LocaleEntry[] }
  | { kind: 'failed'; problem: string };

type LabServerState =
  | { kind: 'loading' }
  | { kind: 'ready'; payload: LocalePayload }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';
const INPUT =
  'w-full max-w-md rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface';

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') return response.text();
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

/** One fetch, one body read — { status, bodyText }. */
async function fetchOnce(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(url, init);
  return { status: response.status, bodyText: await readBodyText(response) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePostCounts(value: unknown): PostCountExample[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: PostCountExample[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) return null;
    if (typeof record.count !== 'number') return null;
    if (typeof record.pluralCategory !== 'string') return null;
    if (typeof record.text !== 'string') return null;
    out.push({ count: record.count, pluralCategory: record.pluralCategory, text: record.text });
  }
  return out;
}

/** Payload validation before use — the client never trusts the wire. */
function parseLocalePayload(value: unknown): LocalePayload | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.locale !== 'string' || typeof record.matchedVia !== 'string') return null;
  const messages = asRecord(record.messages);
  const formats = asRecord(record.sampleFormats);
  if (messages === null || formats === null) return null;
  if (
    typeof messages.greeting !== 'string' ||
    typeof messages.farewell !== 'string' ||
    typeof messages.uploadedAt !== 'string' ||
    typeof messages.price !== 'string'
  ) {
    return null;
  }
  const postCounts = parsePostCounts(messages.postCounts);
  if (postCounts === null) return null;
  if (
    typeof formats.referenceInstant !== 'string' ||
    typeof formats.date !== 'string' ||
    typeof formats.dateTime !== 'string' ||
    typeof formats.number !== 'string' ||
    typeof formats.currency !== 'string' ||
    typeof formats.relativeTime !== 'string'
  ) {
    return null;
  }
  return {
    locale: record.locale,
    matchedVia: record.matchedVia,
    messages: {
      greeting: messages.greeting,
      farewell: messages.farewell,
      postCounts,
      uploadedAt: messages.uploadedAt,
      price: messages.price,
    },
    sampleFormats: {
      referenceInstant: formats.referenceInstant,
      date: formats.date,
      dateTime: formats.dateTime,
      number: formats.number,
      currency: formats.currency,
      relativeTime: formats.relativeTime,
    },
  };
}

function parseNegotiatePayload(value: unknown): NegotiatePayload | null {
  const base = parseLocalePayload(value);
  if (base === null) return null;
  const record = asRecord(value);
  const negotiation = record !== null ? asRecord(record.negotiation) : null;
  if (negotiation === null) return null;
  const parseRanges = (raw: unknown): Array<{ range: string; q: number }> => {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const entry = asRecord(item);
      if (entry === null || typeof entry.range !== 'string' || typeof entry.q !== 'number') {
        return [];
      }
      return [{ range: entry.range, q: entry.q }];
    });
  };
  if (typeof negotiation.acceptLanguage !== 'string') return null;
  return {
    ...base,
    negotiation: {
      acceptLanguage: negotiation.acceptLanguage,
      parsed: parseRanges(negotiation.parsed),
      considered: parseRanges(negotiation.considered),
    },
  };
}

function parseLocalesPayload(value: unknown): LocaleEntry[] | null {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record.locales)) return null;
  const out: LocaleEntry[] = [];
  for (const item of record.locales) {
    const entry = asRecord(item);
    if (entry === null || typeof entry.locale !== 'string') return null;
    out.push({
      locale: entry.locale,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : entry.locale,
      endonym: typeof entry.endonym === 'string' ? entry.endonym : '',
      flagEmoji: typeof entry.flagEmoji === 'string' ? entry.flagEmoji : '',
      dir: entry.dir === 'rtl' ? 'rtl' : 'ltr',
      exampleAcceptLanguage:
        typeof entry.exampleAcceptLanguage === 'string' ? entry.exampleAcceptLanguage : '',
    });
  }
  return out.length > 0 ? out : null;
}

/** The browser's real preference list, wrapped as a header value. */
function browserAcceptLanguage(): string {
  const nav = navigator as Navigator & { languages?: readonly string[] };
  if (nav.languages !== undefined && nav.languages.length > 0) return nav.languages.join(',');
  return nav.language;
}

/** Client-side Intl over the same frozen instant — the lab's own rendering. */
function clientFormats(locale: string): { date: string; number: string; currency: string } {
  return {
    date: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(DEMO_INSTANT),
    number: new Intl.NumberFormat(locale).format(DEMO_NUMBER),
    currency: new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
      DEMO_CURRENCY_AMOUNT,
    ),
  };
}

export default function I18nDemo(): ReactNode {
  // Panel 1 — the negotiator
  const [headerInput, setHeaderInput] = useState(DEFAULT_HEADER);
  const [negotiatorState, setNegotiatorState] = useState<NegotiatorState>({ kind: 'idle' });

  // Panel 2 — the formats lab
  const [labLocales, setLabLocales] = useState<LabLocalesState>({ kind: 'loading' });
  const [labLocale, setLabLocale] = useState<string>('en');
  const [labServer, setLabServer] = useState<LabServerState>({ kind: 'loading' });

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // The lab's locale registry loads with the demo.
  useEffect(() => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(LOCALES_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setLabLocales({ kind: 'failed', problem: `${String(status)} — ${bodyText}` });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const locales = parsed.ok ? parseLocalesPayload(parsed.value) : null;
        if (locales === null) {
          setLabLocales({ kind: 'failed', problem: 'unexpected locales payload' });
          return;
        }
        setLabLocales({ kind: 'ready', locales });
      } catch {
        if (aliveRef.current) setLabLocales({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  }, []);

  // Selecting a lab locale fetches the SERVER's formats for it.
  useEffect(() => {
    setLabServer({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(`${MESSAGES_URL}?locale=${labLocale}`);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setLabServer({ kind: 'failed', problem: `${String(status)} — ${bodyText}` });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseLocalePayload(parsed.value) : null;
        if (payload === null) {
          setLabServer({ kind: 'failed', problem: 'unexpected messages payload' });
          return;
        }
        setLabServer({ kind: 'ready', payload });
      } catch {
        if (aliveRef.current) setLabServer({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  }, [labLocale]);

  const runNegotiation = (headerValue: string): void => {
    setNegotiatorState({ kind: 'loading' });
    void (async () => {
      try {
        // Accept-Language is NOT a forbidden header — the browser sends our
        // value as-is on this same-origin call, and the server negotiates it.
        const { status, bodyText } = await fetchOnce(NEGOTIATE_URL, {
          headers: { 'Accept-Language': headerValue },
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setNegotiatorState({ kind: 'failed', problem: `${String(status)} — ${bodyText}` });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseNegotiatePayload(parsed.value) : null;
        if (payload === null) {
          setNegotiatorState({ kind: 'failed', problem: 'unexpected negotiate payload' });
          return;
        }
        setNegotiatorState({ kind: 'ready', payload, from: 'negotiate' });
      } catch {
        if (aliveRef.current) setNegotiatorState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const runDirect = (locale: string): void => {
    setNegotiatorState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(`${MESSAGES_URL}?locale=${locale}`);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setNegotiatorState({ kind: 'failed', problem: `${String(status)} — ${bodyText}` });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseLocalePayload(parsed.value) : null;
        if (payload === null) {
          setNegotiatorState({ kind: 'failed', problem: 'unexpected messages payload' });
          return;
        }
        setNegotiatorState({ kind: 'ready', payload, from: 'direct' });
      } catch {
        if (aliveRef.current) setNegotiatorState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const useBrowserHeader = (): void => {
    const headerValue = browserAcceptLanguage();
    setHeaderInput(headerValue);
    runNegotiation(headerValue);
  };

  const ready = negotiatorState.kind === 'ready' ? negotiatorState : null;
  // `in`-narrowing: only negotiate responses carry the trace.
  const negotiation =
    ready !== null && ready.from === 'negotiate' && 'negotiation' in ready.payload
      ? ready.payload.negotiation
      : undefined;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="i18n-summary" className="text-body-sm text-on-surface">
        Two panels over the real negotiator: send any Accept-Language (or your browser&apos;s own)
        and watch the match ladder pick a locale, then see the same frozen instant and numbers
        formatted in every locale — computed right here in your browser.
      </p>

      {/* 1 — negotiator */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          1 · The Accept-Language negotiator
        </h3>

        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex flex-1 items-center gap-xxs text-caption text-on-surface-variant">
            Accept-Language
            <input
              type="text"
              data-testid="i18n-negotiator-input"
              value={headerInput}
              onChange={(event) => setHeaderInput(event.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="i18n-negotiate-button"
            onClick={() => runNegotiation(headerInput)}
            disabled={negotiatorState.kind === 'loading' || headerInput.trim() === ''}
            className={BUTTON_PRIMARY}
          >
            {negotiatorState.kind === 'loading' ? 'negotiating…' : 'negotiate'}
          </button>
          <button
            type="button"
            data-testid="i18n-browser-button"
            onClick={useBrowserHeader}
            disabled={negotiatorState.kind === 'loading'}
            className={BUTTON}
          >
            use my browser&apos;s languages
          </button>
        </div>

        <div className="flex flex-wrap gap-xxs">
          {HEADER_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              data-testid={`i18n-preset-${preset.label.replace(/[^a-z-]/g, '')}`}
              onClick={() => {
                setHeaderInput(preset.value);
                runNegotiation(preset.value);
              }}
              className={CHIP}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-caption text-on-surface-variant">explicit choice:</span>
          {['en', 'de', 'ja'].map((locale) => (
            <button
              key={locale}
              type="button"
              data-testid={`i18n-direct-${locale}`}
              onClick={() => runDirect(locale)}
              disabled={negotiatorState.kind === 'loading'}
              className={CHIP}
            >
              ?locale={locale}
            </button>
          ))}
          <span className="text-caption text-on-surface-variant">
            exact only — send de-AT here and it is a 400; the negotiator&apos;s job is fallback
          </span>
        </div>

        {negotiatorState.kind === 'idle' && (
          <p data-testid="i18n-negotiator-idle" className="text-caption text-on-surface-variant">
            prefilled with a weighted regional header — press negotiate and watch de-AT fall to de
            via the primary-subtag rule.
          </p>
        )}
        {negotiatorState.kind === 'loading' && (
          <p data-testid="i18n-negotiator-loading" className="text-caption text-on-surface-variant">
            negotiating…
          </p>
        )}
        {negotiatorState.kind === 'failed' && (
          <pre data-testid="i18n-negotiator-failed" className={PRE}>
            {negotiatorState.problem}
          </pre>
        )}

        {ready !== null && (
          <div data-testid="i18n-result" className="flex flex-col gap-sm">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span data-testid="i18n-matched-locale" className={CHIP_OK}>
                {ready.payload.locale}
              </span>
              <span data-testid="i18n-matched-via" className={CHIP}>
                matched via: {ready.payload.matchedVia}
              </span>
              {ready.from === 'negotiate' && negotiation !== undefined && (
                <span className="text-on-surface-variant">
                  Vary: Accept-Language — a cache must not cross-match these responses
                </span>
              )}
            </p>

            {negotiation !== undefined && (
              <div data-testid="i18n-trace" className="flex flex-col gap-xxs">
                <p className="text-caption text-on-surface-variant">
                  considered in order (q-sorted, wildcard last):
                </p>
                <div className="flex flex-wrap gap-xxs">
                  {negotiation.considered.map((entry) => (
                    <span key={`${entry.range}-${String(entry.q)}`} className={CHIP}>
                      {entry.range} · q={String(entry.q)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div
              data-testid="i18n-messages"
              className="flex flex-col gap-xs rounded-md border border-outline p-sm"
            >
              <p data-testid="i18n-greeting" className="text-body-sm text-on-surface">
                {ready.payload.messages.greeting}
              </p>
              <p data-testid="i18n-farewell" className="text-body-sm text-on-surface-variant">
                {ready.payload.messages.farewell}
              </p>
              <div data-testid="i18n-post-counts" className="flex flex-col gap-xxs">
                {ready.payload.messages.postCounts.map((example) => (
                  <p key={String(example.count)} className="flex items-center gap-xs font-mono text-caption">
                    <span className={CHIP}>{example.text}</span>
                    <span className="text-on-surface-variant">
                      CLDR plural: {example.pluralCategory}
                    </span>
                  </p>
                ))}
              </div>
              <p data-testid="i18n-uploaded-at" className="font-mono text-caption text-on-surface-variant">
                uploaded {ready.payload.messages.uploadedAt}
              </p>
              <p data-testid="i18n-price" className="font-mono text-caption text-on-surface-variant">
                {ready.payload.messages.price}
              </p>
            </div>

            <div data-testid="i18n-formats" className="overflow-x-auto">
              <p className="mb-xs text-caption text-on-surface-variant">
                server-rendered samples from the frozen instant{' '}
                {ready.payload.sampleFormats.referenceInstant} (UTC — deterministic on purpose):
              </p>
              <table className="w-full border-collapse font-mono text-caption">
                <thead>
                  <tr className="text-left text-on-surface-variant">
                    <th className="border-b border-outline px-xs py-xxs">sample</th>
                    <th className="border-b border-outline px-xs py-xxs">{ready.payload.locale}</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['date', ready.payload.sampleFormats.date],
                      ['date + time', ready.payload.sampleFormats.dateTime],
                      ['number', ready.payload.sampleFormats.number],
                      ['currency', ready.payload.sampleFormats.currency],
                      ['relative time', ready.payload.sampleFormats.relativeTime],
                    ] as const
                  ).map(([label, value]) => (
                    <tr key={label}>
                      <td className="border-b border-outline px-xs py-xxs text-on-surface-variant">{label}</td>
                      <td data-testid={`i18n-format-${label.replace(/[^a-z]/g, '')}`} className="border-b border-outline px-xs py-xxs text-on-surface">
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* 2 — formats lab */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          2 · Formats lab — the edge does the formatting
        </h3>

        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-caption text-on-surface-variant">server payload for:</span>
          {LAB_LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              data-testid={`i18n-lab-${locale}`}
              onClick={() => setLabLocale(locale)}
              className={labLocale === locale ? CHIP_OK : CHIP}
            >
              {locale}
            </button>
          ))}
        </div>

        {labLocales.kind === 'loading' && (
          <p data-testid="i18n-lab-loading" className="text-caption text-on-surface-variant">
            fetching the locale registry…
          </p>
        )}
        {labLocales.kind === 'failed' && (
          <pre data-testid="i18n-lab-failed" className={PRE}>
            {labLocales.problem}
          </pre>
        )}

        {labLocales.kind === 'ready' && (
          <div data-testid="i18n-lab-table" className="overflow-x-auto">
            <p className="mb-xs text-caption text-on-surface-variant">
              the same instant ({DEMO_INSTANT.toISOString()}) and the same numbers, formatted in
              YOUR browser — the server&apos;s value for the chosen locale sits alongside it:
            </p>
            <table className="w-full border-collapse font-mono text-caption">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="border-b border-outline px-xs py-xxs">locale</th>
                  <th className="border-b border-outline px-xs py-xxs">date (client)</th>
                  <th className="border-b border-outline px-xs py-xxs">number (client)</th>
                  <th className="border-b border-outline px-xs py-xxs">currency (client)</th>
                  <th className="border-b border-outline px-xs py-xxs">server says</th>
                </tr>
              </thead>
              <tbody>
                {labLocales.locales.map((entry) => {
                  const mine = clientFormats(entry.locale);
                  const serverRow =
                    labServer.kind === 'ready' && labServer.payload.locale === entry.locale
                      ? `${labServer.payload.sampleFormats.date} · ${labServer.payload.sampleFormats.number} · ${labServer.payload.sampleFormats.currency}`
                      : '—';
                  return (
                    <tr key={entry.locale} data-testid="i18n-lab-row">
                      <td className="border-b border-outline px-xs py-xxs text-on-surface">
                        {entry.flagEmoji} {entry.locale}
                        {entry.endonym !== '' ? ` (${entry.endonym})` : ''}
                      </td>
                      <td data-testid="i18n-lab-client-date" className="border-b border-outline px-xs py-xxs text-on-surface">
                        {mine.date}
                      </td>
                      <td data-testid="i18n-lab-client-number" className="border-b border-outline px-xs py-xxs text-on-surface">
                        {mine.number}
                      </td>
                      <td data-testid="i18n-lab-client-currency" className="border-b border-outline px-xs py-xxs text-on-surface">
                        {mine.currency}
                      </td>
                      <td data-testid="i18n-lab-server-cell" className="border-b border-outline px-xs py-xxs text-on-surface-variant">
                        {serverRow}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-xs text-caption text-on-surface-variant">
              client and server agree because both run the same ICU data over the same canonical
              instant — divergent strings would mean a stale ICU build or an unpinned time zone.
              Relative time is the one value that must be computed at render (it is &quot;now
              &quot;-relative), which is why it lives in the negotiator panel, served.
            </p>
          </div>
        )}

        {labServer.kind === 'failed' && (
          <pre data-testid="i18n-lab-server-failed" className={PRE}>
            {labServer.problem}
          </pre>
        )}
      </section>
    </div>
  );
}
