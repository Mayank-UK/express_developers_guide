/**
 * Accept-Language parsing and locale negotiation (pure domain — unit-tested
 * in negotiate.spec.ts, consumed by the i18n demo routes).
 *
 * GRAMMAR (RFC 9110 / RFC 4647, the practical subset): a comma-separated
 * list of language-ranges, each optionally followed by `;q=<0..1>` weights —
 *   de-AT,ja;q=0.8,en;q=0.5,*;q=0.3
 * A range is a BCP 47 tag fragment ('de', 'de-AT', 'zh-Hant') or the
 * wildcard '*'. Higher q = stronger preference; q=0 means "explicitly not
 * acceptable"; absent or malformed q means 1.
 *
 * Duplication note: http_demo_routes.ts carries a sibling q-value parser
 * for the Accept (media-type) header. The shared slice is ~8 lines; keeping
 * them apart was chosen deliberately — an `Accept` parser speaks media
 * ranges and wildcards like text/*, this one speaks language tags, and
 * coupling the HTTP-mechanics topic's file to the i18n domain module (or
 * inventing a shared micro-module for both) would trade a trivial
 * duplication for a cross-topic coupling. The delta that matters: this
 * parser treats an EMPTY q value ('q=') as malformed (q stays 1), where the
 * Accept parser's Number('') quirk reads it as 0.
 */

/** One parsed language-range with its quality weight. */
export interface LanguageRange {
  /** Lowercased exactly as written: 'de-at', 'ja', '*'. */
  range: string;
  /** Clamped to [0, 1]; absent or malformed params mean 1. */
  q: number;
}

/** A BCP 47 language-range (2-8 alpha segments) or the bare wildcard. */
const LANGUAGE_RANGE_PATTERN = /^(?:\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)$/;

/**
 * Parses an Accept-Language header into ordered entries. NEVER throws:
 * malformed segments (garbage tokens, empty pieces between commas) are
 * skipped, malformed q values leave q at 1, and an absent/empty header
 * yields []. Order of well-formed entries is preserved as written.
 */
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
      if (raw === '') continue; // 'q=' → malformed → stays 1
      const parsed = Number(raw); // 'abc' → NaN → stays 1
      if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
    }
    entries.push({ range, q });
  }
  return entries;
}

export type NegotiationVia = 'exact' | 'primary' | 'wildcard' | 'default';

export interface LocaleNegotiation {
  /** The winning tag from `supported`, or `defaultLocale` when nothing matched. */
  locale: string;
  /** How it matched — the teaching payload. */
  matchedVia: NegotiationVia;
  /**
   * The ranges the negotiator considered, IN ORDER: concrete ranges sorted
   * by q (stable — ties keep client order, q=0 excluded), wildcard LAST.
   */
  considered: readonly LanguageRange[];
}

/**
 * Picks the best supported locale for an Accept-Language header.
 *
 * Match ladder per range, highest q first: EXACT (case-insensitive tag
 * match, 'de-AT' over supported 'de-AT') → PRIMARY subtag ('de-AT' falls to
 * supported 'de') → and only after every NAMED range has had its turn, the
 * WILDCARD (serving the default locale) → else default. The wildcard is
 * deliberately ranked last regardless of its q: '*;q=1,de;q=0.5' must
 * answer 'de', because "anything" must never outrank a named preference —
 * the classic ordering bug this file exists to not have.
 */
export function negotiateLocale(
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
  const considered = wildcard !== undefined ? [...named, wildcard] : named;

  for (const entry of considered) {
    if (entry.range === '*') {
      return { locale: def, matchedVia: 'wildcard', considered };
    }
    const exactIndex = lower.indexOf(entry.range);
    if (exactIndex !== -1) {
      return { locale: supported[exactIndex] ?? defaultLocale, matchedVia: 'exact', considered };
    }
    const primary = entry.range.split('-')[0] ?? '';
    const primaryIndex = lower.indexOf(primary);
    if (primaryIndex !== -1) {
      return { locale: supported[primaryIndex] ?? defaultLocale, matchedVia: 'primary', considered };
    }
  }
  return { locale: def, matchedVia: 'default', considered };
}
