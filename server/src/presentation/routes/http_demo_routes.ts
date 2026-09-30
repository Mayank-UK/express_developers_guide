import { Router, type Request, type Response } from 'express';

/**
 * HTTP-mechanics demo endpoints (the `http-web` topic's live experiments):
 * - GET /api/demo/http/inspect — echoes the incoming request's view of itself:
 *   request line (method, HTTP version, path), the parsed query, and every
 *   header the server actually received — Node lowercases names; the map is
 *   sorted for a stable read, and the correlation id this app assigned is
 *   included the way a reverse proxy would forward it (as a request header).
 *   The response carries deliberately interesting headers to compare against:
 *   X-Teaching-Header, Cache-Control: no-store, Vary: Accept, and
 *   X-Your-Accept echoing the request's Accept header.
 * - GET /api/demo/http/negotiate — content negotiation FOR REAL: honors
 *   Accept among application/json, text/plain, and text/html (q-values
 *   parsed simply — higher q wins, ties to the earlier entry, q=0 excludes,
 *   the catch-all and subtype wildcards fall through to the first supported
 *   match, unknown or absent Accept defaults to JSON), serializes the SAME fact
 *   object three ways (JSON object / flattened key: value lines / a tiny
 *   <dl> document), and names the chosen representation in Content-Type
 *   with Vary: Accept for caches.
 */

/** Full Content-Type values, kept exact so the demo (and spec) can prove them. */
const CONTENT_TYPES = {
  'application/json': 'application/json; charset=utf-8',
  'text/plain': 'text/plain; charset=utf-8',
  'text/html': 'text/html; charset=utf-8',
} as const;

type SupportedType = keyof typeof CONTENT_TYPES;

/**
 * Preference order for wildcard fallback: the catch-all media range and
 * subtype wildcards like "text/*" both land on the first supported entry in
 * this list, which is why JSON is the default.
 */
const SUPPORTED_ORDER: readonly SupportedType[] = [
  'application/json',
  'text/plain',
  'text/html',
];

const TEACHING_HEADER_VALUE = 'set-by-the-server';

function inspectController(req: Request, res: Response): void {
  const requestId =
    typeof res.locals.requestId === 'string' && res.locals.requestId !== ''
      ? res.locals.requestId
      : 'n/a';

  // Node already lowercases request header names; sort them so the demo (and
  // its spec) always sees a stable, alphabetical read of what arrived.
  const headers: Record<string, string | string[]> = {};
  for (const name of Object.keys(req.headers).sort()) {
    const value = req.headers[name];
    headers[name] = value === undefined ? '' : value;
  }
  // The correlation id lives on the RESPONSE so far (request-id middleware);
  // a proxy forwarding this request onward would hand it back as a request
  // header — record it the way the next hop would see it.
  headers['x-request-id'] = requestId;

  const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';

  res.setHeader('X-Teaching-Header', TEACHING_HEADER_VALUE);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Accept');
  res.setHeader('X-Your-Accept', accept === '' ? '(none sent)' : accept);

  res.status(200).json({
    method: req.method,
    httpVersion: req.httpVersion,
    // The path as the CLIENT wrote it in the request line — req.path would be
    // mount-relative ('/demo/http/inspect') once /api is stripped by app.use.
    path: req.originalUrl.split('?')[0],
    query: { ...req.query } as Record<string, unknown>,
    headers,
    requestId,
  });
}

interface AcceptEntry {
  /** Lowercased media range exactly as written, e.g. "text/plain" or the catch-all. */
  type: string;
  /** Quality value clamped to [0, 1]; absent or malformed params mean 1. */
  q: number;
}

/** Split an Accept header into entries with parsed q-values, order preserved. */
function parseAccept(header: string): AcceptEntry[] {
  if (header.trim() === '') return [];
  const entries: AcceptEntry[] = [];
  for (const part of header.split(',')) {
    const segments = part.split(';');
    const type = segments[0].trim().toLowerCase();
    if (type === '') continue; // stray commas / whitespace-only parts
    let q = 1;
    for (const param of segments.slice(1)) {
      const equals = param.indexOf('=');
      if (equals === -1) continue;
      if (param.slice(0, equals).trim().toLowerCase() !== 'q') continue;
      const parsed = Number(param.slice(equals + 1));
      if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
    }
    entries.push({ type, q });
  }
  return entries;
}

/** Highest q wins; Array#sort is stable, so ties keep the earlier entry. */
function chooseRepresentation(entries: readonly AcceptEntry[]): SupportedType {
  const ranked = [...entries].sort((a, b) => b.q - a.q);
  for (const entry of ranked) {
    if (entry.q === 0) continue; // q=0: explicitly not acceptable
    if ((SUPPORTED_ORDER as readonly string[]).includes(entry.type)) {
      return entry.type as SupportedType;
    }
    if (entry.type === '*/*') return SUPPORTED_ORDER[0];
    if (entry.type.endsWith('/*')) {
      const prefix = entry.type.slice(0, -1); // 'text/*' -> 'text/'
      const match = SUPPORTED_ORDER.find((supported) => supported.startsWith(prefix));
      if (match !== undefined) return match;
    }
  }
  return 'application/json'; // unknown or absent Accept: JSON is the fallback
}

interface NegotiationFacts {
  resource: string;
  lesson: string;
  acceptHeader: string;
  chosenRepresentation: string;
  available: Array<{ contentType: string; shape: string }>;
}

function negotiationFacts(accept: string, chosen: SupportedType): NegotiationFacts {
  return {
    resource: '/api/demo/http/negotiate',
    lesson:
      'One resource, several representations — the client states a preference in Accept, the server picks one and names it in Content-Type.',
    acceptHeader: accept === '' ? '(none sent)' : accept,
    chosenRepresentation: CONTENT_TYPES[chosen],
    available: [
      { contentType: CONTENT_TYPES['application/json'], shape: 'structured object' },
      { contentType: CONTENT_TYPES['text/plain'], shape: 'flattened key: value lines' },
      { contentType: CONTENT_TYPES['text/html'], shape: 'a tiny <dl> document' },
    ],
  };
}

function asPlainText(facts: NegotiationFacts): string {
  return (
    [
      `resource: ${facts.resource}`,
      `lesson: ${facts.lesson}`,
      `accept: ${facts.acceptHeader}`,
      `chosen representation: ${facts.chosenRepresentation}`,
      '',
      'available representations:',
      ...facts.available.map((r) => `  - ${r.contentType} (${r.shape})`),
    ].join('\n') + '\n'
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function asHtml(facts: NegotiationFacts): string {
  const available = facts.available
    .map((r) => `      <dt>${escapeHtml(r.contentType)}</dt><dd>${escapeHtml(r.shape)}</dd>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Content negotiation demo</title>
  </head>
  <body>
    <h1>${escapeHtml(facts.resource)}</h1>
    <p>${escapeHtml(facts.lesson)}</p>
    <dl>
      <dt>accept</dt><dd>${escapeHtml(facts.acceptHeader)}</dd>
      <dt>chosen representation</dt><dd>${escapeHtml(facts.chosenRepresentation)}</dd>
${available}
    </dl>
  </body>
</html>
`;
}

function negotiateController(req: Request, res: Response): void {
  const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';
  const chosen = chooseRepresentation(parseAccept(accept));
  const facts = negotiationFacts(accept, chosen);

  const body =
    chosen === 'application/json'
      ? JSON.stringify(facts, null, 2)
      : chosen === 'text/plain'
        ? asPlainText(facts)
        : asHtml(facts);

  res.setHeader('Content-Type', CONTENT_TYPES[chosen]);
  res.setHeader('Vary', 'Accept');
  res.status(200).send(body);
}

export const httpDemoRouter = Router();
httpDemoRouter.get('/demo/http/inspect', inspectController);
httpDemoRouter.get('/demo/http/negotiate', negotiateController);
