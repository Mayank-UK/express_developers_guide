import type { Topic } from '../types.js';

/**
 * The Caching topic: the two caching WORLDS (HTTP's protocol-level cache vs
 * the app's server-side cache) and how they compose, conditional requests and
 * the 304 round-trip, the cache-aside pattern with a real two-store fallback,
 * invalidation (the hard problem), stampede protection with single-flight,
 * and CDNs with the hashed-filename strategy this guide's own client build
 * uses. Snippets marked verbatim are this app's running source.
 */
export const topicCaching: Topic = {
  id: 'caching',
  title: 'Caching',
  subtitle:
    'HTTP caching, cache-aside, invalidation, stampedes, and CDNs.',
  group: 'caching-messaging',
  order: 2,
  sections: [
    {
      id: 'caching-worlds',
      title: 'Two caching worlds',
      lead: 'Every cache you will ever deploy lives in one of two places: inside the HTTP protocol itself (browsers, proxies, CDNs) or inside your application (an in-process Map, Redis). Different machinery, different rules — and the best systems use both.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-worlds:split',
          body: `WORLD ONE — HTTP CACHING: the store is a BROWSER or a shared PROXY/CDN, the cache key is the URL (plus a few headers), and the contract is written into the protocol itself — Cache-Control says who may cache and for how long, ETag/Last-Modified say how to check freshness, and the conditional request (If-None-Match) turns "ask the server" into a 304 with an EMPTY BODY. You do not manage entries; you send HEADERS and the web's existing machinery does the rest. The payoff is measured in not-transmitting: the origin still answers every revalidation, but with headers only. WORLD TWO — SERVER-SIDE CACHING: the store is YOURS (a Map in the process, Redis between processes), the key is whatever you choose (a query name, a user id, a rendered fragment), and the contract is YOUR CODE — you check the cache, you fill it, you invalidate it. The payoff is measured in not-COMPUTING: a cache hit never runs the expensive query at all. They answer DIFFERENT questions: HTTP caching says "the browser already has these bytes — ship nothing"; server-side caching says "the database already computed this answer — don't recompute". THEY COMPOSE, and production stacks layer them deliberately: the CDN serves the static bundle immutably (HTTP world, below), the app serves an API response from Redis after one miss (server-side world), and a revalidation round-trip collapses to 304 bytes while the origin query never runs because the app hit its own cache first. THE ONE QUESTION that decides which world you are in: WHO owns the entry's lifetime? If the answer is "the protocol, via headers I sent once" — HTTP caching. If the answer is "my code, via TTLs and deletes I issue" — server-side. This topic builds both, live: the endpoints below speak both dialects over the same deterministic payload (a report derived from the seed posts, behind an artificial 150ms "expensive query").`,
        },
      ],
    },
    {
      id: 'caching-http',
      title: 'HTTP caching: Cache-Control, validators, and the 304',
      lead: 'Cache-Control is policy; ETag is identity; the conditional request is the round-trip that makes revalidation cheap. The asset endpoint below is the real handler — sha256 etag, If-None-Match, and the two Cache-Control strategies.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-http:cache-control',
          body: `CACHE-CONTROL IS THE LAW a response hands to every cache on the path, and its directives carry the whole policy: max-age=N (fresh for N seconds — serve from cache without asking), public (any shared cache may store it) vs private (only the user's own browser may — the flag that must ride any response whose body varies per user), no-store (do not cache AT ALL — the strongest directive; banking pages, personal API answers you never want replayed), no-cache (misleading name: you MAY store it, but you MUST revalidate before every reuse — semantically "always ask"), must-revalidate (once stale, it may not be served without a successful revalidation — without it, some caches serve stale under pressure), and immutable (the URL's content will NEVER change — safe even with max-age of a year; the hashed-filename strategy below). The legacy header EXPIRES carries an absolute date instead of a duration — an HTTP/1.0 relic kept for ancient caches, and a worse design for a reason worth internalizing: durations (max-age) are clock-independent between two machines, absolute dates depend on BOTH clocks being right, and clocks are exactly what caches cannot trust. Send Expires only as a fallback duplicate of max-age. The hierarchy to reach for: no-store > no-cache/max-age=0 + must-revalidate > short max-age > long max-age + immutable.`,
        },
        {
          kind: 'text',
          id: 'caching-http:validators',
          body: `A VALIDATOR is the identity card a 200 hands the client so a later request can ASK instead of re-download. Two kinds exist: ETAG — an opaque string the server invents (here: the sha256 of the response body, quoted — strong because it changes if and only if the body changes) — and LAST-MODIFIED — a date from the resource's history, cheaper to produce but only ONE-SECOND resolution and merely an assertion ("modified at"), not a fingerprint (two edits inside one second collide; two writes can restore identical content and still bump the date). When both are present, IF-NONE-MATCH WINS over If-Modified-Since — a strong etag is simply more precise, so the spec says the date is ignored. The client replays the validator in a conditional request: If-None-Match: "<etag>" (or If-Modified-Since: <date>), and the server answers either 200 with a fresh body (the validators differ — the client's copy is stale) or 304 NOT MODIFIED with the SAME validator and an EMPTY body (they match — keep your copy). The anatomy of the 304 is the payoff: full headers, zero payload. VARY is the multi-dimensional key problem: a cache keys on the URL, but one URL can answer differently per request header — Vary: Accept-Encoding tells every cache that gzip and identity bodies are DIFFERENT entries under the same URL; Vary: Authorization tells shared caches that an authenticated response must never be reused for a different caller (in practice: don't let shared caches see per-user bodies at all — private or no-store, see the what-NOT-to-cache section). This guide's http topic sets a live Vary header on its inspect endpoint; this topic's asset keeps the matrix trivially one-dimensional (same bytes for everyone) so the etag alone tells the truth.`,
        },
        {
          kind: 'code',
          id: 'caching-http:verbatim-handler',
          language: 'ts',
          source: 'server/src/presentation/routes/caching_demo_routes.ts',
          caption: 'Verbatim — the asset handler (presentation/routes/caching_demo_routes.ts): the sha256-of-body etag, the two Cache-Control policies, and the conditional round-trip',
          code: `// The two policies this endpoint can hand out:
const CACHE_CONTROL_REVALIDATE = 'public, max-age=0, must-revalidate';
const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';
//   revalidation mode (default): "trust me again every time" — the client may
//     store but MUST revalidate; each round-trip collapses to 304 bytes.
//   immutable mode (?version=immutable): "this URL never changes" — a full
//     year of max-age; the hashed-asset strategy (the CDN section).

// The etag is derived from the BODY, never from memory identity: the same
// content yields the same etag in every process, across restarts — which is
// the property that makes conditional requests useful at all.
const report = await buildPostsReport();
const body = JSON.stringify(report);
const etag = \`"\${createHash('sha256').update(body).digest('hex')}"\`;

// The comparator, verbatim — If-None-Match uses WEAK comparison per the spec:
// a W/"…" candidate matches the strong "…", a comma list matches if ANY
// candidate does, and * matches unconditionally.
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined || ifNoneMatch.trim() === '') return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .some((raw) => raw.trim().replace(/^W\\//, '') === etag);
}

// The handler itself: pick the policy, answer the conditional request.
const cacheControl = version === 'immutable' ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_REVALIDATE;
if (etagMatches(req.header('if-none-match'), etag)) {
  res.status(304).set('ETag', etag).set('Cache-Control', cacheControl).end();
  return;              // headers only — zero body bytes cross the wire
}
res.status(200).set('ETag', etag).set('Cache-Control', cacheControl).type('application/json').send(body);`,
        },
      ],
    },
    {
      id: 'caching-aside',
      title: 'Cache-aside: the pattern your app actually uses',
      lead: 'Check the cache, miss to the origin, fill with a TTL, serve. One algorithm over two possible stores — Redis when the optional service is up, an honest in-process Map when it is not — and every response says which store served it.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-aside:pattern',
          body: `THE PATTERN (also called lazy loading): on a read, (1) CHECK the cache for the key; (2) on a HIT, deserialize and serve — the origin never runs; (3) on a MISS, run the expensive query, (4) WRITE the result back WITH A TTL, (5) serve. The cache is a SIDE layer the caller manages by hand — the origin (the SQL database, the upstream API) knows nothing about it, which is exactly why the pattern is so easy to adopt and so easy to reason about: nothing changes at the source of truth, and a cold or flushed cache is not an outage, it is a slow minute while entries refill. THE TWO STORES THIS DEMO RUNS OVER: when the compose redis service is up (the lazy optional client from the Redis topic answers a live connection), the cache is REDIS — shared, so every app process pointing at the same server sees the SAME entries (one replica fills, all replicas hit); when it is not, the cache is an in-process MAP with expiry tracking — same code path, same counters, but PER-PROCESS: two replicas would each keep their own divergent cache. That difference is not a footnote, it is the reason shared stores exist for caching — and this demo REPORTS the live store kind in every response rather than pretending, so you can watch the behavior change by starting one container. TTL CHOICE is the one real decision inside the pattern, and it is a staleness budget: the entry may serve data up to TTL seconds old, so the question is "how wrong may this answer be, for how long?" — product listings tolerate minutes; availability counters seconds; anything read-after-write-critical belongs in the invalidation section or out of the cache entirely. A TTL is also the SAFETY NET that guarantees eventual freshness even when every invalidation path has a bug — which is why cache-aside entries should almost never be written without one.`,
        },
        {
          kind: 'code',
          id: 'caching-aside:verbatim-service',
          language: 'ts',
          source: 'server/src/data/caching/cache_aside_service.ts',
          caption: 'Verbatim — the store pick and the lookup core (data/caching/cache_aside_service.ts), abridged only where marked',
          code: `// THE STORE PICK — redis when the optional service is live, else a Map:
async function resolveStore(): Promise<ResolvedStore> {
  const client = await getRedisClient();   // the Redis topic's lazy client
  return client === null ? { kind: 'memory' } : { kind: 'redis', client };
}
// 'redis'  → SHARED: one cache for every process that can reach the server
// 'memory' → per-process ONLY: two replicas = two divergent caches.
// Every response carries the kind that actually served it — the demo never
// pretends to be shared when it is not.

// The memory store keeps the same contract as the redis calls, expiry and all
// (the TTL is enforced in OUR code instead of by the redis server):
async get(key) {
  const entry = memoryStore.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAtMs <= Date.now()) {
    memoryStore.delete(key); // lazy eviction on read
    return null;
  }
  return entry.value;
},
async set(key, value, ttlSeconds) {
  memoryStore.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
},

// THE FILL — the miss side: pay the 150ms origin cost, write back WITH a TTL:
async function fillFromOrigin(key: string, store: StoreApi): Promise<PostsReport> {
  const report = await buildPostsReport();
  await store.set(key, JSON.stringify(report), REPORT_TTL_SECONDS);
  return report;
}

// THE LOOKUP — check, miss to origin, fill with a TTL, serve:
const cached = await store.get(REPORT_CACHE_KEY);          // 1. check
if (cached !== null) {
  const ms = Date.now() - started;
  recordLookup('cache', ms);                               // hit: origin skipped
  return ok({
    key: REPORT_CACHE_KEY,
    source: 'cache',
    ms,
    store: storeResolution.kind,
    report: JSON.parse(cached) as PostsReport,
    // …hits, misses, hitRate(), lastSource: 'cache' — the counters…
  });
}
// 2. miss → the fill above (or the SHARED in-flight one — stampede section):
const report = await fill;
const ms = Date.now() - started;
recordLookup('origin', ms);
return ok({
  key: REPORT_CACHE_KEY,
  source: 'origin',
  ms,
  store: storeResolution.kind,
  report,
  // …hits, misses, hitRate(), lastSource: 'origin'…
});`,
        },
        {
          kind: 'text',
          id: 'caching-aside:write-through',
          body: `THE ALTERNATIVES, one honest paragraph each. WRITE-THROUGH: the cache sits IN FRONT of the store on WRITES too — every write updates the cache and the database together (usually in the data-store layer, not the app), buying always-fresh reads at the cost of write latency (the cache write rides the write path) and a coupling that makes the "lazy" simplicity of cache-aside disappear; it earns its keep when the same key is read immediately after writing (counters, config, session state). WRITE-BEHIND (write-back): writes land in the cache and return, with the durable write flushed ASYNCHRONOUSLY — fast writes, and an uncomfortable property: the cache can say "written" and then the process dies before the database ever sees it. That is a durability trade, not a performance trick, and it belongs only where the loss window is acceptable (analytics, counters) — never for the system of record. The guide's stance: start with cache-aside + TTL + explicit invalidation (below), reach for write-through when read-after-write consistency genuinely hurts, and treat write-behind as a specialist tool you must be able to defend in a design review.`,
        },
        {
          kind: 'demo',
          id: 'caching-aside:lab-demo',
          demoId: 'caching:lab',
          title: 'The caching lab',
          description:
            'ETag + If-None-Match → 304 with an empty body, the immutable vs revalidation Cache-Control policies, the cache-aside query with live hit/miss counters and the store chip (redis when the optional service is live, the in-process Map otherwise), explicit invalidation, and the stampede comparison — naive (N rebuilds) vs single-flight (one).',
        },
      ],
    },
    {
      id: 'caching-invalidation',
      title: 'Invalidation: the hard problem',
      lead: 'There are only two hard things in computer science: cache invalidation and naming things. The TTL is your backstop; explicit delete is your tool; versioned keys are your escape hatch.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-invalidation:strategies',
          body: `THE JOKE IS A REAL ENGINEERING MAP (Phil Karlton said it first; every caching incident since has proved him right). The strategies, from bluntest to sharpest. TTL AS BACKSTOP: every entry dies on a schedule, so the worst any invalidation bug can do is serve stale data UNTIL THE TTL — which is why the TTL is chosen as the maximum tolerable staleness, not as a performance knob. It is not an invalidation strategy by itself (a 60s TTL still serves a full minute of wrongness after a write), but it bounds every other strategy's failure. EXPLICIT DELETE-ON-WRITE: when the source of truth changes, DELETE the affected key(s) in the same operation (ideally the same transaction or immediately after it) — the next read misses and refills with the truth. This demo's POST /api/demo/caching/invalidate is the pattern in miniature: one delete, and the very next query visibly goes back to origin. Its honest costs: the writer must KNOW every key a piece of data feeds (the mapping is manual and rots as queries evolve), and the delete-then-refill window re-opens the miss penalty — including the stampede (next section). PUB/SUB INVALIDATION FANOUT: with multiple app replicas each holding entries (or local memory caches), one replica's delete must reach the others — so the writer PUBLISHes "invalidate <key>" on a channel and every replica's subscriber deletes locally. The Redis topic built exactly the machinery (the dedicated subscriber connection, the awaitable unsubscribe); the standing warning travels with it — pub/sub is fire-and-forget, a replica that was reconnecting MISSES the notice, so the TTL backstop stays mandatory even here. Fanout is an optimization for staleness windows, never a correctness mechanism on its own. VERSIONED KEYS: stop deleting, start RENAMING — the key for a report becomes report:v42:… and a new version of the data writes report:v43:…; readers ask for the current version number (kept somewhere small and cheap) and the old entries simply age out via TTL. Nothing is ever deleted under a reader's feet, so there is no delete/refill race at all; the cost is one extra lookup for the current version and orphaned old entries until they expire. That is the whole toolbox: schedule (TTL), action (delete), broadcast (pub/sub), and rename (versioning) — senior systems usually run TTL + delete as the default and escalate only when the mapping or the scale demands it.`,
        },
      ],
    },
    {
      id: 'caching-stampede',
      title: 'Stampedes and dogpiles',
      lead: 'A hot key expires and a thousand requests miss at once — every one of them rebuilds the same value. Single-flight makes the first miss build and the rest wait; the demo fires 10 parallel lookups both ways.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-stampede:problem',
          body: `THE FAILURE MODE: cache-aside has a race window between "miss" and "filled" — and when a hot key expires (or is invalidated) under load, EVERY in-flight request is inside that window at the same moment: all miss, all hit the origin, all rebuild the identical value, all write it back. The cache did not just fail to help; it AMPLIFIED a synchronized spike onto exactly the resource you were protecting — the classic dogpile (a thundering herd aimed at one key). This demo's fake origin models the detail that makes it hurt: it SERIALIZES (one "connection", like a single database worker), so ten simultaneous rebuilds queue — the last caller waits behind nine 150ms builds while the naive run's total time balloons to ~1.5s; the single-flight run pays one build and everyone waits ~150ms. Watch the numbers in the lab: originCalls 10 vs 1 is the entire lesson. THE FIX — SINGLE-FLIGHT (a mutex by another name): the first miss PUBLISHES its in-flight fill promise on a map; every later miss finds that promise and AWAITS it instead of starting its own build. One rebuild serves N callers; the map entry is deleted when the fill settles so the next expiry starts fresh. THE ADJACENT FIXES worth knowing: JITTERED TTLs — if ten hot keys were filled together they expire together; setting each TTL with ±10% random jitter de-synchronizes the expiries so the stampede never forms (a one-line change that prevents the synchronized-miss scenario); STALE-WHILE-REVALIDATE — serve the STALE entry immediately while ONE background refresh rebuilds (clients get instant, slightly-old answers; the origin sees exactly one rebuild; the Cache-Control extension directives stale-while-revalidate / stale-if-error let HTTP caches do the same trick at the protocol level). The mature stack is single-flight + jitter, with stale-while-revalidate added when a stale answer beats a slow one.`,
        },
        {
          kind: 'code',
          id: 'caching-stampede:verbatim-singleflight',
          language: 'ts',
          source: 'server/src/data/caching/cache_aside_service.ts',
          caption: 'Verbatim — the single-flight promise map and the miss branch that uses it (cache_aside_service.ts); the stampede endpoint toggles exactly this with ?singleflight=1',
          code: `// The single-flight map: key -> the in-flight FILL promise.
const inFlight = new Map<string, Promise<PostsReport>>();

// Inside the miss branch of the cache-aside lookup:
let fill = options.singleFlight === true ? inFlight.get(REPORT_CACHE_KEY) : undefined;
if (fill === undefined) {
  fill = fillFromOrigin(REPORT_CACHE_KEY, store);    // the FIRST miss builds…
  if (options.singleFlight === true) {
    inFlight.set(REPORT_CACHE_KEY, fill);            // …and PUBLISHES the promise
    fill.finally(() => {
      // Cleanup after settle: the map never leaks across runs.
      if (inFlight.get(REPORT_CACHE_KEY) === fill) inFlight.delete(REPORT_CACHE_KEY);
    }).catch(() => undefined);
  }
}
const report = await fill;   // the other 9 callers await the SAME in-flight
                             // build — originCalls: 10 becomes 1. Awaiters are
                             // honestly reported as 'origin': nobody hit a cache.`,
        },
      ],
    },
    {
      id: 'caching-cdn',
      title: 'CDNs and the hashed-filename strategy',
      lead: 'A CDN is HTTP caching you rent at the edge: your Cache-Control headers, their servers, worldwide. Static assets get the forever-cache treatment — content-hashed filenames that NEVER change — and this guide\'s own client build already does it.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-cdn:model',
          body: `WHAT A CDN IS: a fleet of caches you put in front of your origin, answering from whichever edge node is nearest the user. To the CDN, your responses are just HTTP with your own Cache-Control on them — everything the HTTP section taught applies unchanged, except the "shared cache" now has POPs in forty cities. THE CACHE KEY is the first thing to get right: by default it is method + URL (path AND query string), plus whatever Vary names — which makes query strings a loaded gun: /search?q=a and /search?q=b are different keys, so a URL with a per-request token can fan out into unbounded entries (many CDNs ignore the query string for static assets by default); and Vary: Cookie is the classic accidental cache-key explosion that fills a CDN with per-cookie entries nobody can hit again. TWO WAYS ENTRIES LEAVE A CDN: expiry (your max-age/TTL — the passive way) and PURGING (an API call that actively evicts, by URL, tag, or everything — the active way). Purging is how you ship "the same URL, new content" quickly, but it is per-POP propagation, eventually-consistent, and rate-limited — which is why the industry settled on a strategy that needs no purging at all: HASHED FILENAMES. The bundler names each asset after a hash of its CONTENT — this guide's client build really does this (vite emits index-B9nDFTGn.js, app_info_demo-DRj9DGsm.js, a new hash for every content change) — so the asset URL IS its content identity, and the policy writes itself: every hashed asset gets public, max-age=31536000, immutable (the exact header this topic's ?version=immutable mode demonstrates). Change the code and the filename changes; the old URL stays valid forever (serve it or 404 it, either is safe) and the new URL starts cold. The ONE exception is the entry document — index.html — which references the hashed files by name and must therefore ALWAYS revalidate (no-cache or max-age=0 must-revalidate; the demo's default mode): a forever-cached index.html would pin users to old hashes. ORIGIN SHIELD, one paragraph: with a global miss (a cold key requested in many POPs at once), every POP would independently ask your origin — a stampede at CDN scale — so CDNs offer a shield tier: POPs miss to ONE intermediate shield cache, and only the shield talks to the origin, collapsing N simultaneous global misses into a single origin request (single-flight, rented). It is the same pattern as the stampede section, one layer up.`,
        },
        {
          kind: 'code',
          id: 'caching-cdn:verbatim-policies',
          language: 'bash',
          caption: 'The two headers, driven live by the demo — and what the guide\'s own build emits',
          code: `# The hashed-asset strategy (what ?version=immutable demonstrates):
#   Cache-Control: public, max-age=31536000, immutable
# The entry-document strategy (what the default mode demonstrates):
#   Cache-Control: public, max-age=0, must-revalidate

# Try both on the real endpoint:
curl -si 'localhost:4000/api/demo/caching/asset?version=immutable' | grep -i cache-control
curl -si 'localhost:4000/api/demo/caching/asset'                  | grep -i cache-control

# The guide's own client build already lives the strategy — content-hashed
# filenames (check client/dist/assets after npm run build):
#   index-B9nDFTGn.js   app_info_demo-DRj9DGsm.js   index-CLdiBW-y.css
# New content → new hash → new URL → every cache miss is a CORRECT miss,
# and no cache ever needs purging.`,
        },
      ],
    },
    {
      id: 'caching-whatnot',
      title: 'What NOT to cache',
      lead: 'Caching the wrong thing is worse than caching nothing: a stale wrong answer ships with a 200. The exclusion list, learned the hard way by everyone.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-whatnot:list',
          body: `AUTHENTICATED RESPONSES: anything whose body depends on WHO is asking — account pages, per-user API answers, anything downstream of an Authorization header — must never enter a SHARED cache. The protocol's guard is Vary: Authorization (shared caches must key on it, which in practice means they simply do not store it), but the robust move is to say it yourself: private (browser-only) or no-store outright. The nightmare scenario a shared cache must be structurally prevented from: user A's authenticated response served to user B from an edge cache — a cross-user data leak delivered by your own performance optimization. PER-USER DATA in the app-side cache is fine ONLY when the key carries the identity: cache the report FOR user 42 under key report:user:42, never under report — the key IS the isolation boundary, and a key that forgets a dimension of the request serves one tenant another tenant's data with a perfect hit rate. FRESH-WRITE READS: after a POST/PATCH, the very next GET expects to see the write (read-after-write consistency); a TTL cache between them serves yesterday's answer to the person who JUST made the change — the demo's delete-on-write is the minimal fix, and until you have it wired, endpoints in the write path belong out of the cache. THE REST OF THE LIST, briefly: Set-Cookie-bearing responses (cache the body if you must, never the cookie — and usually no-store the whole thing), anything non-deterministic-by-contract (a nonce, a CSRF token, a one-time code), error responses (a cached 500 outlives the outage — and unlike the outage, it keeps serving), and rate-limit or security counters whose correctness IS their freshness. THE SMELL TEST that catches all of these: before caching an answer, ask "if this exact response were replayed to a DIFFERENT user, or to the SAME user one second after they changed the underlying data, what breaks?" — if the answer is anything but "nothing", you are caching the wrong thing.`,
        },
      ],
    },
    {
      id: 'caching-live',
      title: 'The caching endpoints from a terminal',
      lead: 'The lab\'s endpoints driven from a terminal (the interactive panel lives in the cache-aside section above): the etag asset with its 304 round-trip and the immutable toggle, the cache-aside query with hit/miss counters over the store this process is actually using (redis when the optional service is up — the response says which), and the stampede comparison one command each way. Works fully without Redis.',
      blocks: [
        {
          kind: 'text',
          id: 'caching-live:intro',
          body: `THE LAB now lives in the cache-aside section above; this is its terminal companion, and the curl block below drives every endpoint. HTTP CACHING from curl: fetch the asset without a validator → a 200, the body, the sha256 etag and the revalidation policy; then revalidate with the stored etag in If-None-Match → status 304 and a body of exactly zero bytes (the savings, visible); the immutable version shows the year-long policy a hashed asset earns. CACHE-ASIDE: run the query repeatedly — the source flips origin → cache, the hit/miss counters and hit rate update, and the store field says redis or memory (start the optional service with docker compose -f .docker/docker-compose.yml up -d redis and the same endpoint silently switches to the shared store; stop it and it says memory again). INVALIDATE, and the next query visibly returns to origin. STAMPEDE: run the naive mode — 10 parallel misses, 10 origin calls, every caller waiting on the serialized fake origin; then single-flight — the same 10 callers, ONE origin call. Including the -H 'If-None-Match: …' round-trip that is the whole conditional-request story in two commands.`,
        },
        {
          kind: 'code',
          id: 'caching-live:curl',
          language: 'bash',
          caption: 'The whole tour from a terminal (server: npm run dev in server/; every endpoint works with or without redis)',
          code: `# 1. HTTP caching — first fetch: 200 + etag (sha256 of the body) + policy:
curl -si 'localhost:4000/api/demo/caching/asset' \\
  | grep -Ei '^(HTTP|etag|cache-control)'          # 200, strong etag, must-revalidate

# 2. The conditional round-trip — replay the etag, receive 304 + zero bytes:
ETAG=$(curl -si 'localhost:4000/api/demo/caching/asset' | grep -i '^etag' | tr -d '\\r' | cut -d' ' -f2)
curl -s -o /dev/null -w '%{http_code} %{size_download} bytes\\n' \\
  -H "If-None-Match: $ETAG" 'localhost:4000/api/demo/caching/asset'
# → 304 0 bytes   (weak works too: -H "If-None-Match: W/$ETAG")

# 3. The hashed-asset policy — the same body, a year of max-age + immutable:
curl -si 'localhost:4000/api/demo/caching/asset?version=immutable' | grep -i cache-control

# 4. Cache-aside — miss (origin, ~150ms), then hit (cache, ~0ms), then stats:
curl -s localhost:4000/api/demo/caching/query  | jq '{source, ms, store, hits, misses}'
curl -s localhost:4000/api/demo/caching/query  | jq '{source, ms, store, hits, misses, hitRate}'
curl -s localhost:4000/api/demo/caching/stats  | jq '{store, hits, misses, hitRate, entries}'

# 5. Invalidation — delete the key, watch the next query go back to origin:
curl -s -X POST localhost:4000/api/demo/caching/invalidate | jq
curl -s localhost:4000/api/demo/caching/query | jq '{source, misses}'

# 6. The stampede — naive: 10 parallel misses = 10 origin calls (~1.5s, queued);
#    single-flight: the same 10 callers, ONE origin call (~150ms):
curl -s 'localhost:4000/api/demo/caching/stampede?singleflight=0' | jq '{mode, originCalls, totalMs}'
curl -s 'localhost:4000/api/demo/caching/stampede?singleflight=1' | jq '{mode, originCalls, totalMs}'

# 7. Optional: start the shared store and watch the STORE chip flip to redis —
#    same endpoints, same pattern, shared across replicas:
docker compose -f .docker/docker-compose.yml up -d redis
curl -s localhost:4000/api/demo/caching/query | jq '.store'   # "redis"`,
        },
      ],
    },
  ],
};
