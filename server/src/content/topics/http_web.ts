import type { Topic } from '../types.js';

/**
 * The protocol topic: everything on the wire below and around Express.
 * Concept-first and framework-agnostic (backend canon), then where Express
 * sits inside each mechanism. Code samples from this repo are marked verbatim;
 * skeletons that are illustrative rather than runnable say so in their captions.
 */
export const topicHttpWeb: Topic = {
  id: 'http-web',
  title: 'HTTP and Web Fundamentals',
  subtitle:
    'The protocol Express speaks for you: requests, responses, headers, negotiation, and the browser security model around them.',
  group: 'fundamentals',
  order: 3,
  sections: [
    {
      id: 'http-journey',
      title: 'The request journey',
      lead: 'URL to response in five hops: DNS, TCP, TLS, the HTTP message, your handler. Express only ever sees the last two.',
      blocks: [
        {
          kind: 'text',
          id: 'http-journey:concept',
          body: `Concept first: when a browser asks for a URL, five distinct systems do work before your route handler runs. DNS turns the hostname into an IP address — a lookup with caches at every level (browser, OS, resolver). TCP establishes a connection to that address: a three-way handshake (SYN, SYN-ACK, ACK) that costs one network round trip before a single byte of payload can move. For HTTPS, TLS then runs its own handshake on top of that fresh TCP connection — proving the server's identity and agreeing on encryption keys — before application data is allowed. Only then does the client write the HTTP message onto the encrypted stream, and the server's job begins: parse the bytes, run them through the framework, and write a response message back down the same connection.\n\nThe division of labor is worth internalizing: everything up to and including the TLS handshake is infrastructure — DNS providers, load balancers, proxies, the operating system. Your Express application is the last hop only. It receives already-connected, already-decrypted (or plain) HTTP messages and produces response messages. That is why so much of backend operations — timeouts, retries, connection limits, TLS certificates — is configured outside the app, and why the Deployment topic in this guide spends its time on the layers below Express.`,
        },
        {
          kind: 'code',
          id: 'http-journey:curl',
          language: 'bash',
          caption: 'The whole journey, visible in one command (illustrative output)',
          code: `# -v prints each layer as curl passes through it:
curl -v 'http://localhost:4000/api/demo/node/blocking?workMs=50'

# * Trying 127.0.0.1:4000...        <- DNS answered; TCP connect starting
# * Connected to localhost          <- TCP handshake complete
#                                   <- (HTTPS would add the TLS handshake here)
# > GET /api/demo/node/blocking?workMs=50 HTTP/1.1   <- the request line:
# > Host: localhost:4000                               method, path, version
# > User-Agent: curl/8.7.1
# > Accept: */*                     <- request headers, one per line
# >                                 <- blank line: headers over, body (empty)
# < HTTP/1.1 200 OK                 <- the response's status line
# < content-type: application/json; charset=utf-8
# < x-request-id: 3f9c2c6e-...      <- this app tags every response
# <                                 <- blank line, then the response body`,
        },
        {
          kind: 'text',
          id: 'http-journey:express',
          body: `Where exactly does Express begin? Node's http module owns the socket and incrementally parses incoming bytes; each completed HTTP message fires a 'request' event with two objects — req (the parsed request) and res (a writable response under construction). Express is a pipeline mounted on that event: middleware and routers consume req, mutate it (parsing cookies, bodies, attaching correlation ids), and eventually write to res. Your handler is one stage in that pipeline — which is why it receives request ALREADY partially processed (req.query parsed, res.locals populated by earlier middleware) and why anything you do to res after the response has been sent is silently too late.\n\nThe live demo in the next section makes the boundary concrete: it asks the server to echo the request exactly as it arrived — method, HTTP version, path, parsed query, and every header the server actually saw, including headers injected by hops along the way (the correlation id, the proxy's host rewrite) — next to the response headers coming back. What the browser thought it sent and what the server received are two different views of one message.`,
        },
      ],
    },
    {
      id: 'http-message',
      title: 'Methods, status codes, and headers',
      lead: 'A request and a response are each one start line, a header list, and an optional body. Three small vocabularies carry the whole contract.',
      blocks: [
        {
          kind: 'text',
          id: 'http-message:anatomy',
          body: `An HTTP message is deliberately simple: a start line, zero or more headers (name: value, one per line, terminated by a blank line), and an optional body. For a request the start line is "METHOD path HTTP-version"; for a response it is "HTTP-version status reason-phrase". Headers are the metadata channel — content type and length, caching instructions, authentication credentials, correlation ids — and the body is the payload. That is the entire format; everything else in this topic is vocabulary layered on those three slots.\n\nMethods are verbs with agreed semantics, and the agreement matters more than the spelling. GET means fetch — no side effects expected. POST means submit — create a resource, trigger a process. PUT means "store this at this URL, replacing what is there". DELETE means exactly that. PATCH means "apply a partial change". The same URL with different methods is a different operation: this app's posts pipeline routes GET /api/posts (list), POST /api/posts (create), and PATCH /api/posts/:id (partial update) through the same router with different handlers. The next section unpacks the two properties (safety, idempotency) that give these verbs their operational meaning.`,
        },
        {
          kind: 'text',
          id: 'http-message:statuses',
          body: `Status codes are the response's verdict, and the families are the part worth memorizing: 1xx informational (rare outside websockets/uploads), 2xx success, 3xx redirection (including the caching redirects 304), 4xx the client's mistake, 5xx the server's. Within those families a backend emits a small working set — the ones this app's error taxonomy is built around: 200 OK and 201 Created for success (the posts pipeline returns 201 when a create lands); 400 validation_failed when input does not parse; 401 Unauthorized when credentials are missing or wrong and 403 Forbidden when they are fine but insufficient (the auth topics emit these); 404 not_found for unknown routes and resources; 409 Conflict when the request fights current state (a taken username, a stale revision); 429 Too Many Requests when a rate limiter trips (the security topic); 500 for unhandled failures and 503 when a dependency is down and the endpoint is deliberately unavailable.\n\nTwo habits distinguish a senior API: statuses are decided at the edge (controllers and the error handler — never sprinkled through business logic), and 4xx vs 5xx is never abused to lie. A 500 that actually means "you sent bad input" breaks every client's retry logic, because retrying a 5xx is reasonable and retrying a 4xx is pointless.`,
        },
        {
          kind: 'code',
          id: 'http-message:not-found',
          language: 'ts',
          caption: `server/src/app.ts — verbatim: this app's 404 catch-all, one of the statuses above`,
          source: 'server/src/app.ts',
          code: `// 404 catch-all — plain middleware (no wildcard path), so it behaves the
// same across Express 4/5 wildcard-syntax differences.
app.use((req: Request, res: Response) => {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
  res.status(404).json({
    error: {
      code: 'not_found',
      message: \`Cannot \${req.method} \${req.originalUrl}\`,
      requestId,
    },
  });
});`,
        },
        {
          kind: 'text',
          id: 'http-message:headers',
          body: `Header basics, server-side: Node receives request headers lowercased on an object (req.headers['user-agent']), sends response headers exactly as you set them, and preserves insertion order. Request headers you will actually read constantly: host, content-type (what parser to run), content-length, authorization, cookie, accept, and the x- forwarding headers proxies add. Response headers you will set constantly: content-type, cache-control, location (with 3xx), set-cookie, and custom correlation headers like this app's x-request-id. Repeated headers (Set-Cookie especially) arrive and leave as arrays; everything else is a single value. On the wire under HTTP/2 header names are always lowercase — one reason code that matches header names case-insensitively survives every hop, and code that does not, does not.`,
        },
        {
          kind: 'demo',
          id: 'http-message:demo',
          demoId: 'http:headers',
          title: 'The header inspector',
          description:
            'Inspect my request — the server echoes the request line, parsed query, and every header it actually received (your custom browser headers included), next to the response headers that came back. Then negotiate: fetch the same resource with three different Accept headers and watch Content-Type (and the body itself) change with your preference.',
        },
      ],
    },
    {
      id: 'http-idempotency',
      title: 'Idempotency and safety',
      lead: 'Safe methods change nothing; idempotent methods change things the same way every time. Retries turn that distinction from theory into money.',
      blocks: [
        {
          kind: 'text',
          id: 'http-idempotency:concept',
          body: `Two precise properties. A method is safe when it triggers no side effects on the server — GET, HEAD, OPTIONS. A method is idempotent when performing it N times leaves the server in the same state as performing it once — PUT (store this value: the tenth store equals the first), DELETE (absent after the first; deleting an absent resource is conventionally still a success), GET, HEAD. POST is neither: each POST may create a new resource or trigger a new side effect, so N posts means N effects. PATCH is formally "not guaranteed idempotent" — patching by applying a delta is not, patching by setting fields is; know which yours is.\n\nThe definitions are about server state, not about the response. A PUT that returns 200 the first time and 409 or 200-with-different-etag later can still be idempotent. What matters is that re-sending the request cannot multiply the effect.`,
        },
        {
          kind: 'text',
          id: 'http-idempotency:retries',
          body: `Why this deserves a whole section: distributed systems retry. The user's phone is on a train and the connection drops after the request was delivered but before the response arrived. The load balancer retries a request that looked slow. The user double-clicks the submit button. In all three cases the client cannot distinguish "never arrived" from "arrived, response lost" — so it retries — and if the method was POST /payments, an unsafe non-idempotent POST, the customer is charged twice. The industry answer is the Idempotency-Key pattern: the client attaches a unique key to each logical operation, and the server stores the first response under that key so replays return the stored answer instead of re-executing the side effect. Stripe popularized it; payment APIs treat it as table stakes. GETs and PUTs need no such machinery — that is the operational payoff of using the right verb.`,
        },
        {
          kind: 'code',
          id: 'http-idempotency:key',
          language: 'ts',
          caption:
            'The Idempotency-Key pattern (illustrative sketch, not wired into this app), anchored on the payments store the third-party topic\'s Stripe-shaped mock really runs (third_party_demo_routes.ts)',
          source: 'server/src/presentation/routes/third_party_demo_routes.ts',
          code: `// The store the mock really keeps — a Map keyed by the intent id (the
// same shape an idempotency-key store would use, minus the replay check):
const paymentIntents = new Map<string, MockPaymentIntent>();

// The pattern, as it would wrap a POST /payments handler:
//   const key = req.header('idempotency-key');
//   if (key === undefined || key === '') { /* 400 validation envelope */ return; }
// First execution stores the answer under the key; replays get the stored
// answer — the side effect (chargeCard) runs exactly once per key:
//   const stored = await store.lookup(\`\${req.auth.accountId}:payments:\${key}\`);
//   if (stored !== null) {
//     res.status(stored.status).set('Idempotency-Replayed', 'true').json(stored.body);
//     return;
//   }
//   const outcome = await chargeCard(req.body);            // the side effect
//   await store.save(key, outcome.status, outcome.body, { ttlSeconds: 86_400 });
//   res.status(outcome.status).json(outcome.body);
// Scope the key to the caller AND the route — the same key on another
// account's request must not leak a stored response.

// And the minting side of the real store (an id per intent, capped):
paymentSeq += 1;
const id = \`pi_mock_\${String(paymentSeq).padStart(4, '0')}\`;`,
        },
      ],
    },
    {
      id: 'http-negotiation',
      title: 'Content negotiation',
      lead: 'One resource, many representations. The client states preferences in Accept; the server answers in Content-Type; Vary tells caches what the answer depended on.',
      blocks: [
        {
          kind: 'text',
          id: 'http-negotiation:concept',
          body: `Concept first: a resource (a thing with a URL) is distinct from its representations (the byte sequences that express it). /api/status is the resource; a JSON document, a plain-text dashboard, and an HTML page are three representations of it. Content negotiation is the mechanism for choosing: the client describes what it can consume — Accept for media types, Accept-Language for languages, Accept-Encoding for compression — and the server picks one and names its choice in the response's Content-Type.\n\nAccept carries preferences with quality values: "application/json;q=0.1, text/plain;q=0.9" ranks plain text above JSON (q defaults to 1 when omitted, higher wins, ties go to the earlier entry, and q=0 explicitly excludes). Servers answer with 406 Not Acceptable when nothing the client will accept can be produced — though many APIs, pragmatically, fall back to a default representation instead, and this app's negotiate demo does exactly that. Accept-Language drives the same machinery for locales and gets its own live treatment in the Internationalization topic.`,
        },
        {
          kind: 'code',
          id: 'http-negotiation:format',
          language: 'ts',
          caption:
            'server/src/presentation/routes/http_demo_routes.ts — verbatim: this app\'s real manual negotiator (what res.format automates, in the comments)',
          source: 'server/src/presentation/routes/http_demo_routes.ts',
          code: `// res.format is the Express automation of "one resource, several
// representations" — it matches the request's Accept against the keys
// (json/text/html alias the full media types) and runs the first acceptable
// branch, answering 406 when nothing matches and no default is given:
//   res.format({
//     json: () => res.json(facts),
//     text: () => res.type('text/plain').send(asPlainText(facts)),
//     html: () => res.type('text/html').send(asHtml(facts)),
//     default: () => res.status(406).json({ /* envelope */ }),
//   });

// This repo negotiates BY HAND so the machinery stays visible (verbatim) —
// parse Accept's q-values, pick, name the choice, vary:
const chosen = chooseRepresentation(parseAccept(accept)); // higher q wins, ties to earlier
res.setHeader('Content-Type', CONTENT_TYPES[chosen]);
res.setHeader('Vary', 'Accept');               // caches: the answer VARIES with Accept
res.status(200).send(body);`,
        },
        {
          kind: 'text',
          id: 'http-negotiation:vary',
          body: `Vary is the header that keeps negotiation honest under caching. A cache stores a response keyed by URL; but if /api/status returns JSON for one Accept and HTML for another, then serving the cached JSON to a client that asked for HTML is corruption. Vary: Accept tells every cache (browser, CDN, proxy) that the response varies by the request's Accept header, so entries must be keyed by URL plus that header. The rule generalizes: any request header your response depends on belongs in Vary — Accept for representation, Accept-Encoding for compression, Origin once CORS enters the picture. Forgetting it is one of the classic "works locally, poisons users behind the CDN" bugs, and the Caching topic returns to it with cache-control in hand.`,
        },
      ],
    },
    {
      id: 'http-cookies',
      title: 'Cookies, sessions, and the same-origin model',
      lead: `The browser's security model has one load-bearing concept — the origin — and cookies are the state mechanism built around it.`,
      blocks: [
        {
          kind: 'text',
          id: 'http-cookies:origin',
          body: `An origin is scheme + host + port: https://app.example.com:443. Two URLs are same-origin only when all three match; https://app.example.com and http://app.example.com are different origins, and so are https://app.example.com and https://api.example.com. The same-origin policy is the browser's fundamental rule: JavaScript on one origin cannot read responses from another. It protects users from each other — any random page you visit must not be able to read your bank's pages using your credentials. All the cross-origin machinery developers fight with (CORS, next section) exists to carve narrow, explicit exceptions into this default, and only the browser enforces it — a plain HTTP client like curl has no origin and no policy, which is why "it works in curl but not in the browser" almost always means the browser's model, not the server, is what said no.\n\nCookies are HTTP's state mechanism, bolted on via two headers: Set-Cookie (server to browser: "store this") and Cookie (browser to server: "here is everything you stored for this domain", sent on every matching request). The nuance worth knowing: cookies scope by domain (and scheme), not by port — two origins differing only in port share cookies, because cookies predate the origin concept. The attributes on Set-Cookie are where all the modern security lives.`,
        },
        {
          kind: 'code',
          id: 'http-cookies:set',
          language: 'ts',
          caption:
            'server/src/presentation/routes/reqres_demo_routes.ts — verbatim: the teaching cookie this app really bakes (the login-and-session-store sketch, in the comments)',
          source: 'server/src/presentation/routes/reqres_demo_routes.ts',
          code: `// The login shape this pattern typically serves (illustrative — the auth
// topics build it for real):
//   const session = await sessionStore.create(req.body); // opaque id, data stays server-side
//   res.cookie('guide_session', session.id, {
//     httpOnly: true,   // JS on the page cannot read it — XSS cannot steal what it cannot see
//     secure: true,     // the browser sends it over HTTPS only — never on http://
//     sameSite: 'lax',  // cross-site requests don't carry it — closes the main CSRF road
//     maxAge: 1000 * 60 * 60 * 8, // 8 hours, then the browser deletes it
//     path: '/',
//   });
//   res.json({ ok: true });

// What this app actually ships — every attribute earning its place:
res
  .cookie('teaching_cookie', 'baked', {
    httpOnly: true, // invisible to document.cookie
    sameSite: 'strict', // never attached cross-site
    maxAge: 60_000, // relative expiry → Max-Age=60
  })
  .json({
    mode: 'cookie',
    set: true,
    note: 'the real lesson is in the Set-Cookie response header — HttpOnly, SameSite=Strict, Max-Age=60',
  });`,
        },
        {
          kind: 'text',
          id: 'http-cookies:sessions',
          body: `HttpOnly hides the cookie value from JavaScript; Secure restricts it to encrypted connections; SameSite gates which cross-site requests carry it at all ('lax' allows top-level navigations, 'strict' allows none, 'none' requires Secure and exists for legitimate third-party contexts such as embedded widgets); Domain and Path control scope; Max-Age/Expires control lifetime. Read that list as a threat model in header form: XSS (HttpOnly), network interception (Secure), CSRF (SameSite).\n\nThe session pattern those attributes typically serve: the cookie carries only an opaque session id, and the actual state lives server-side in a store (memory for a single process, Redis the moment you run replicas — this guide's Redis topic). The alternative is putting the state itself in the cookie as a signed token, which is exactly where the Authentication topic picks the thread up and compares sessions and JWTs properly.`,
        },
      ],
    },
    {
      id: 'http-cors',
      title: 'CORS',
      lead: 'Cross-origin requests fail because the browser refuses to hand over the response — not because the server rejected the request. The server\'s only job is to state, in headers, what it permits.',
      blocks: [
        {
          kind: 'text',
          id: 'http-cors:model',
          body: `CORS (Cross-Origin Resource Sharing) is the browser's escape hatch from the same-origin policy: a way for a server to say "this other origin may read my responses". The mental model that prevents years of confusion: the request usually goes through and the server usually responds normally — it is the BROWSER that blocks the RESPONSE from reaching the calling page when permission is absent. The server never "blocks the cross-origin request"; it merely annotates responses with what it allows, and the browser enforces it. Three consequences follow. curl and server-to-server calls are unaffected (no browser, no policy — the "works in curl" mystery again). CORS is not an authentication mechanism — an open CORS policy does not let anonymous users do anything they could not already do with curl; it decides which ORIGINS' pages may read responses using the USER's credentials. And CORS failures are reported to the page as opaque network errors, which is why the diagnosis lives in the browser's network tab, not your server logs.`,
        },
        {
          kind: 'text',
          id: 'http-cors:preflight',
          body: `Cross-origin requests come in two kinds. "Simple" requests — GET/HEAD/POST with only the basic headers and safelisted content types — are sent directly, and the browser checks permission on the response (Access-Control-Allow-Origin). Anything more — custom headers like Authorization or X-Api-Key, methods like PATCH/PUT/DELETE, JSON content types other than the safelisted forms — triggers a preflight: the browser first sends an OPTIONS request carrying Access-Control-Request-Method and Access-Control-Request-Headers, and unless the server answers with matching Access-Control-Allow-* headers, the real request is never sent. Preflight results are cached via Access-Control-Max-Age. This app is same-origin by construction (Vite proxies /api to the Express server), so it needs no CORS headers — but every frontend-on-a-different-origin deployment does, and the correct minimal middleware is short enough to read in full.`,
        },
        {
          kind: 'code',
          id: 'http-cors:middleware',
          language: 'ts',
          caption:
            'server/src/presentation/middleware/cors_middleware.ts — verbatim (core): the real hand-rolled CORS middleware this repo ships for the security topic (this app itself is same-origin and mounts it only on the demo router)',
          source: 'server/src/presentation/middleware/cors_middleware.ts',
          code: `return (req: Request, res: Response, next: NextFunction): void => {
  const origin = req.headers.origin;

  // No Origin header = same-origin navigation or a non-browser client —
  // CORS has nothing to say; set nothing and continue.
  if (typeof origin !== 'string' || origin === '') {
    next();
    return;
  }

  // The response differs by Origin, whatever we decide below.
  res.setHeader('Vary', 'Origin');

  const verdict = evaluateCorsOrigin(options, origin);
  if (!verdict.allowed) {
    // DENIED — by NOT adding headers, not by erroring: the server ran the
    // request fine; the calling page's browser is the one that will refuse
    // to expose the response. (A preflight it refuses up front.)
    next();
    return;
  }

  // Permission lives on the RESPONSE — echo the ALLOWLISTED spelling (never
  // '*' or raw origin-reflection once credentials are on):
  res.setHeader('Access-Control-Allow-Origin', verdict.allowOrigin as string);
  if (verdict.credentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // A CORS preflight = OPTIONS + Origin + Access-Control-Request-Method.
  // Answer it here and end with 204 — no route handler ever sees preflights.
  const isPreflight =
    req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
  if (isPreflight) {
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
    res.setHeader('Access-Control-Max-Age', String(maxAgeSeconds));
    res.status(204).end();
    return;
  }

  next();
};`,
        },
      ],
    },
    {
      id: 'http-tls',
      title: 'TLS and HTTPS',
      lead: 'One handshake solves two problems — proving who you are, and agreeing on a secret — and everything after is fast symmetric encryption.',
      blocks: [
        {
          kind: 'text',
          id: 'http-tls:handshake',
          body: `HTTPS is HTTP spoken inside a TLS session. The handshake, in essence: the client and server use asymmetric cryptography to (1) authenticate — the server proves its identity with a certificate, and only the true holder of the private key can complete the exchange — and (2) key-exchange — derive a shared symmetric session key without ever transmitting it. Why the split: asymmetric crypto (RSA, elliptic curve) is expensive but needs no shared secret beforehand, so it is used once, to establish trust and exchange keys; symmetric crypto (AES) is fast, so it carries the entire session afterwards. The client also verifies the certificate — chain, hostname, validity window — and a failure there is the browser's padlock-warnings you have had to click through. Modern deployments add session resumption so repeat connections skip most of the handshake, and TLS 1.3 cut the round trips to one.\n\nA certificate is a signed statement binding a public key to a hostname, issued by a Certificate Authority; verification walks the chain from the leaf (your server's cert) through intermediates to a root CA the client already trusts. Let's Encrypt made leaf certificates free and automatable (ACME, certbot, 90-day renewals), which is why "get HTTPS" is a solved problem in this guide's deployment world.`,
        },
        {
          kind: 'text',
          id: 'http-tls:termination',
          body: `Where the handshake happens is an architecture decision: TLS termination at a reverse proxy is the common answer. Nginx, Caddy, or a load balancer presents the certificate, decrypts incoming HTTPS, and forwards plain HTTP to the app on an internal network or localhost — the app never touches keys or handshakes. Termination centralizes certificate renewal (one place to update), frees the Node process from crypto overhead, and matches how this guide's production compose file will sit in front of Express (the Deployment topic builds exactly that). The trade: the app sees the proxy's IP, not the client's, which is why proxies inject X-Forwarded-For / X-Forwarded-Proto and Express needs trust proxy configured to read them honestly.\n\nOne response header completes the picture: Strict-Transport-Security (HSTS) tells the browser "this host is HTTPS-only, for N seconds, remember that" — closing the downgrade attack where an attacker coerces an http:// first contact. Applied with max-age=31536000 and includeSubDomains once you are certain every subdomain is HTTPS, because browsers take it literally and revocation is slow.`,
        },
        {
          kind: 'code',
          id: 'http-tls:inspect',
          language: 'bash',
          caption: 'read a real certificate chain and the negotiated protocol',
          code: `# Subject, issuer, and verification of a live endpoint's certificate:
openssl s_client -connect example.com:443 -brief </dev/null

# The handshake from the client's chair:
curl -vI https://example.com 2>&1 | grep -Ei 'subject|issuer|SSL connection|TLS'

# HSTS in the wild — "never http:// here again", with a max-age in seconds:
curl -sI https://example.com | grep -i strict-transport-security`,
        },
      ],
    },
    {
      id: 'http-versions',
      title: 'HTTP versions',
      lead: '1.1 gave us keep-alive and chunking; 2 gave one connection many streams; 3 moved to UDP. Behind a proxy, most of it is invisible to your Express code.',
      blocks: [
        {
          kind: 'text',
          id: 'http-versions:one-one',
          body: `HTTP/1.1 (1997, still the workhorse) established the model every backend developer first meets: keep-alive connections — reuse one TCP connection for many requests instead of paying the handshake per request (Node's server keeps connections open by default, and graceful shutdown must remember they exist — see the Node topic's shutdown walkthrough); the Host header, which made virtual hosting and this guide's entire proxy setup possible; and chunked transfer encoding — sending a body of unknown length in pieces, which is what a streaming response uses (the Node topic's streaming demo shows exactly this: no Content-Length, transfer-encoding: chunked). Its defining limitation: one request at a time per connection. Responses arrive strictly in request order, so a slow response head-of-line blocks everything behind it, and browsers resort to six parallel connections per host as a workaround.`,
        },
        {
          kind: 'text',
          id: 'http-versions:two-three',
          body: `HTTP/2 (2015) fixes that at the framing layer: binary frames carry many parallel streams over ONE connection, so a slow response no longer blocks its siblings, and HPACK compresses the repetitive header traffic. HTTP/3 (2022) replaces the transport underneath: QUIC over UDP instead of TCP, folding the TLS handshake into connection establishment and removing TCP-level head-of-line blocking on lossy networks. The client and server negotiate the version via ALPN during the TLS handshake.\n\nWhat a Node developer actually notices: almost nothing in application code. req and res look identical; your handlers do not know or care which version served them. Node ships an http2 module if you terminate TLS yourself, but the standard production shape — Express in plain HTTP/1.1 behind a proxy that speaks 2/3 to the world — means the versions are infrastructure configuration, not code. The one place it leaks into your awareness is header case (h2 lowercases names) and the fact that HTTP/2 clients cannot use HTTP/1.1-style upgrade mechanics, which is part of why WebSockets took the path it did.`,
        },
        {
          kind: 'code',
          id: 'http-versions:curl',
          language: 'bash',
          caption: 'ask for a version explicitly and see which one you actually got',
          code: `# Force a version for the same request:
curl -sI --http1.1 https://example.com | head -1
curl -sI --http2    https://example.com | head -1

# ALPN picks the best shared version during the TLS handshake; curl reports
# what was negotiated:
curl -s -o /dev/null -w '%{http_version}\\n' https://example.com
# (HTTP/3 needs a curl built with QUIC support — curl -V shows which builds)`,
        },
      ],
    },
    {
      id: 'http-live',
      title: 'Inspect the wire from a terminal',
      lead: 'The same two experiments, no browser needed: curl the echo endpoint to see the request the server actually received, and negotiate one resource into three representations.',
      blocks: [
        {
          kind: 'text',
          id: 'http-live:intro',
          body: `The interactive header inspector lives at the end of "Methods, status codes, and headers" above; the curls below run the same two experiments against the same endpoints. The first echoes a request back as the server saw it: the request line (method, path, HTTP version), the parsed query string, and every header that actually arrived — including the correlation id this app assigned, shown the way a proxy would forward it. Alongside it come the response headers that traveled back, so you can compare the two directions of the metadata channel. The second is content negotiation for real: request the same resource with three different Accept headers and watch the server pick a different representation each time — JSON, flattened text, or a tiny HTML document — announcing the choice in Content-Type and keying caches with Vary: Accept.`,
        },
        {
          kind: 'code',
          id: 'http-live:curl',
          language: 'bash',
          caption: 'drive the demo endpoints yourself',
          code: `# See this request as the server saw it — add your own header and find it:
curl -s -D /tmp/hdr 'localhost:4000/api/demo/http/inspect?via=terminal' \\
  -H 'X-My-Header: hello-server' | head -40
grep -Ei 'x-teaching-header|cache-control|vary|x-your-accept' /tmp/hdr

# One resource, three representations — compare the Content-Type lines:
curl -sD - -o /dev/null -H 'Accept: application/json' localhost:4000/api/demo/http/negotiate
curl -sD - -o /dev/null -H 'Accept: text/plain'       localhost:4000/api/demo/http/negotiate
curl -sD - -o /dev/null -H 'Accept: text/html'        localhost:4000/api/demo/http/negotiate

# And the q-value case — plain text outranks JSON:
curl -sD - -o /dev/null -H 'Accept: application/json;q=0.1, text/plain;q=0.9' \\
  localhost:4000/api/demo/http/negotiate`,
        },
      ],
    },
  ],
};
