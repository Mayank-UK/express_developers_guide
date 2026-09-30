import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';
import {
  DEFAULT_LOCALE,
  DEMO_INSTANT_ISO,
  LOCALE_METADATA,
  SUPPORTED_LOCALES,
  asSupportedLocale,
  buildLocalePayload,
  type SupportedLocale,
} from '../../domain/i18n/locales.js';
import { negotiateLocale, parseAcceptLanguage } from '../../domain/i18n/negotiate.js';

/**
 * i18n demo endpoints (the `internationalization` topic's live surface).
 * All formatting logic lives in domain/i18n (pure, unit-tested); these
 * controllers stay thin: read the input, call the domain, shape the answer.
 *
 * - GET /api/demo/i18n/locales — the supported-locale registry: metadata,
 *   text direction, and a realistic example Accept-Language per locale.
 * - GET /api/demo/i18n/messages?locale= — EXPLICIT locale choice (exact
 *   match only: 'de-AT' is a 400 here, it is /negotiate's job to fall back).
 *   Unknown values answer the canonical 400 envelope carrying the supported
 *   list. Default (absent param): en.
 * - GET /api/demo/i18n/negotiate — real Accept-Language negotiation over
 *   the request's own header (exact → primary subtag → wildcard → default),
 *   with Vary: Accept-Language because the response depends on a request
 *   header a shared cache must not cross-match.
 *
 * DETERMINISM CONTRACT: every date/number sample is formatted from ONE
 * frozen instant (2026-09-28T09:15:00Z) with timeZone pinned to UTC, so
 * responses are byte-stable and assertable. The single serve-time value is
 * uploadedAt/relativeTime — the age of the frozen instant right now.
 */

export const I18N_DEMO_MOUNT_PATH = '/api/demo/i18n';

function localesController(_req: Request, res: Response): void {
  res.json({
    defaultLocale: DEFAULT_LOCALE,
    demoInstant: DEMO_INSTANT_ISO,
    note: 'every formatted sample is computed from this frozen instant in UTC, so output is deterministic',
    locales: SUPPORTED_LOCALES.map((locale) => LOCALE_METADATA[locale]),
  });
}

/**
 * Boundary parsing for ?locale=: absent/empty → default; a single supported
 * tag (case-insensitive exact) → itself; anything else → a validation
 * failure carrying the supported list. Repeated params (?locale=en&locale=de)
 * arrive as an array and are rejected — the routing topic's simple-query
 * behavior.
 */
function parseExplicitLocale(rawQuery: Request['query']): SupportedLocale {
  const raw = rawQuery.locale;
  if (raw === undefined || raw === '') return DEFAULT_LOCALE;
  if (typeof raw !== 'string') {
    throw new ValidationException('"locale" query parameter must be a single value', {
      parameter: 'locale',
      received: raw,
    });
  }
  const normalized = raw.trim().toLowerCase();
  const match = SUPPORTED_LOCALES.find((locale) => locale === normalized);
  if (match === undefined) {
    throw new ValidationException(
      `"locale" must be one of the supported locales (got "${normalized}")`,
      {
        parameter: 'locale',
        supported: [...SUPPORTED_LOCALES],
        defaultLocale: DEFAULT_LOCALE,
        hint: 'this endpoint is an EXACT choice; send regional tags like de-AT to /negotiate, which falls back by primary subtag',
      },
    );
  }
  return match;
}

function messagesController(req: Request, res: Response): void {
  const locale = parseExplicitLocale(req.query);
  res.json(buildLocalePayload(locale, 'explicit'));
}

function negotiateController(req: Request, res: Response): void {
  const rawHeader = req.headers['accept-language'];
  // Node gives string | string[] for repeatable headers; join defensively.
  const header = Array.isArray(rawHeader) ? rawHeader.join(',') : (rawHeader ?? '');

  const negotiation = negotiateLocale(header, SUPPORTED_LOCALES, DEFAULT_LOCALE);

  // The response depends on a request header — a shared cache serving one
  // client's negotiated payload to another would be a language leak, the
  // caching topic's Vary rule applied to Accept-Language.
  res.setHeader('Vary', 'Accept-Language');

  res.json({
    ...buildLocalePayload(asSupportedLocale(negotiation.locale), negotiation.matchedVia),
    negotiation: {
      acceptLanguage: header,
      parsed: parseAcceptLanguage(header),
      considered: negotiation.considered,
    },
  });
}

export const i18nDemoRouter = Router();
i18nDemoRouter.get('/demo/i18n/locales', localesController);
i18nDemoRouter.get('/demo/i18n/messages', messagesController);
i18nDemoRouter.get('/demo/i18n/negotiate', negotiateController);
