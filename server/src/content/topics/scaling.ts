import type { Topic } from '../types.js';

/**
 * The Scaling topic — the LAST infrastructure story: what actually happens
 * when "run more copies of the server" stops being a sentence and becomes an
 * architecture. The spine is STATELESSNESS: this app opens its own books and
 * inventories every piece of per-process state it carries (the demo measures
 * them LIVE from the running process), then walks the standard exits — load
 * balancing, replicas, data at scale, CDNs, shedding — each tied to artifacts
 * this repo already built in earlier topics.
 */
export const topicScaling: Topic = {
  id: 'scaling',
  title: 'Scaling',
  subtitle: 'Load balancing, stateless design, replicas, and CDNs.',
  group: 'platform',
  order: 11,
  sections: [
    {
      id: 'scaling-what-it-means',
      title: 'What scaling actually means',
      lead:
        'More copies or bigger copies — and before either, the honesty check: one box handles more than you think.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-what-it-means:two-directions',
          body: `TWO DIRECTIONS, ONE QUESTION. "Scale" answers exactly one question: when demand exceeds what one server does today, what do you add? VERTICAL scaling (scale UP) adds a BIGGER BOX — more cores, more RAM, a faster disk. It is the zero-code-change option: nothing about your app needs to know it happened, which is why it is almost always the FIRST move and often the right one for a long time. Its limits are economic and physical: big machines cost disproportionately more per unit of power, and eventually you reach the biggest machine money buys — a ceiling, not a slope. HORIZONTAL scaling (scale OUT) adds MORE COPIES of the app behind a load balancer: ten $40 boxes instead of one $400 box, no single machine whose death is the outage, and a cost curve that keeps going. The catch is the price the whole rest of this topic pays: MORE COPIES OF THE APP IS ONLY POSSIBLE WHEN THE COPIES ARE INTERCHANGEABLE — and interchangeable copies means the PROCESS itself can hold nothing that matters. That single constraint (statelessness) is why sessions move to Redis, rate-limit counters move to Redis, jobs move to a broker: not because those stores are "better", but because they let the app processes become cattle instead of pets. THE SCALE CUBE (AKF's mental model, sketched below) names the third and fourth answers too: X-axis is clone the app (horizontal), Z-axis is partition the DATA by customer/region (each replica serves a slice), Y-axis is split by FUNCTION (the architecture topic's layers become separate deployables — microservices, when the split is deliberate). Most systems climb X first, Z when data outgrows one database, Y only when team structure demands it.`,
        },
        {
          kind: 'code',
          id: 'scaling-what-it-means:scale-cube',
          language: 'text',
          caption: 'The scale cube — a sketch (the three axes are independent; real systems combine them)',
          code: `                        Y — split by FUNCTION
                        (posts service / auth service / search service —
                         separate deployables, own their data)
                              │
        ──────────────────────┼──────────────────────
       /                     │                     \\
  Z — partition         X — CLONE THE APP      (origin: the
  by CUSTOMER/REGION    load balancer → N      monolith you
  (shard 1: users a–m,  identical stateless     shipped first)
   shard 2: users n–z)  copies of one app)

  X first (cheapest, needs statelessness) → Z when ONE database
  is the bottleneck → Y when TEAMS are the bottleneck.`,
        },
        {
          kind: 'text',
          id: 'scaling-what-it-means:when-not-to',
          body: `WHEN NOT TO SCALE — the honesty section, because it is the one every junior engineer skips. Node on one modest box serves THOUSANDS of requests per second of typical JSON API work: this guide's whole stack (Express 5, sqlite reads, a Redis hop) occupies single-digit milliseconds per request, and the performance topic measured the actual cost of the work — not the folklore. Before you architect for ten replicas: MEASURE where the time goes (the observability topic's metrics + the debugging topic's event-loop diagnosis tell you), PROFILE the hot path (the performance topic's discipline), and check the two cheap wins first — an index (the SQL topics: one EXPLAIN can turn a scan into a seek, a 100× improvement no replica can match) and a cache (the caching topic: the same answer computed a thousand times is a bug, not a workload). Scaling MULTIPLIES what you have: three copies of a slow app are three slow apps with a load balancer in front. And it multiplies COMPLEXITY too — everything in this topic (shared sessions, coordinated rate limits, replicated data, cache invalidation at the edge) is NEW failure surface you built yourself. The senior move is knowing the number that justifies it (the capacity-planning section closes on exactly that: peak RPS and p95 budget) and not spending the complexity before the number says so.`,
        },
      ],
    },
    {
      id: 'scaling-statelessness',
      title: 'Statelessness is the prerequisite',
      lead:
        'Any state a process holds privately is state a second copy cannot see — and this app carries five kinds. The demo below counts them live.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-statelessness:the-rule',
          body: `THE RULE IN ONE SENTENCE: horizontal scaling works exactly up to the first byte of per-process state, and no further. A "stateless" app process is one whose answer depends ONLY on the request plus state in SHARED stores — any client, any replica, same result. The moment a process holds something the next request depends on (a session, a counter, a queue entry, an open socket), replicas DIVERGE: your browser tab talks to replica A which knows you're logged in, the next request lands on replica B which has never heard of you — logged out at random, a bug users describe as "flickering" and engineers describe as a long afternoon. THIS APP'S OWN INVENTORY — the honest list, because the guide ships every one of these as a deliberate lesson: (1) the SESSION STORE — in-memory by design, and its own header says the trade out loud (quoted below); (2) the RATE-LIMIT COUNTERS — the security topic's two limiters keep per-IP windows in process memory, so N replicas = N × the configured budget; (3) the JOB QUEUE — in-process by design (the jobs topic's lesson), so jobs live and die with the worker that holds them; (4) the SSE CONNECTIONS REGISTRY — each feed connection is a socket in ONE process's Map, so a second replica simply cannot write to it; (5) the CACHING topic's cache-aside FALLBACK — when Redis is off it uses an in-process Map+TTL, honest for one copy, nonsense for several. AND THE COUNTER-EXAMPLES THE APP ALSO SHIPS: mongo and redis are exactly what EXTERNALIZED state looks like — the data lives in a shared store every replica reaches the same way, and the optional-service clients (quoted in the reliability topic) are the pattern for reaching them: configured-and-reachable or degraded, never crash-the-process.`,
        },
        {
          kind: 'code',
          id: 'scaling-statelessness:session-quote',
          language: 'ts',
          caption:
            'Verbatim — the session store naming its own scaling trade (domain/auth/session_store.ts)',
          source: 'server/src/domain/auth/session_store.ts',
          code: `/**
 * A hand-rolled, in-memory session store — deliberately NOT express-session,
 * because the session mechanism itself is the lesson. Express-session gets its
 * catalog mention in the topic content.
 *
 * The trade this store makes on purpose: in-memory state is PER-PROCESS, so a
 * second app replica would not see these sessions (the production path is a
 * shared store — Redis with TTLs, exactly what the Redis topic builds). Every
 * response that echoes a session echoes a MASKED token; the real 32-byte
 * urlsafe token crosses the wire exactly once, inside the Set-Cookie header.
 */`,
        },
        {
          kind: 'text',
          id: 'scaling-statelessness:migration',
          body: `THE MIGRATION PATTERN — move the state, keep the shape. Statelessness is not a rewrite; it is a RELOCATION, one hazard at a time, and each relocation in this app has a landing spot an earlier topic already built: sessions → the Redis topic's structures with TTLs (SETEX a 32-byte token, read it back on every request — the session store's lazy-expiry logic becomes the TTL you get for free, and its 100-cap eviction becomes a maxmemory policy); rate-limit counters → the same store (INCR + EXPIRE is the fixed-window limiter the security topic hand-rolled, one round trip, shared by every replica — production libraries ship exactly this as rate-limit-redis); the job queue → a broker (Redis lists/streams or a real queue service; the jobs topic's contract — attempts, backoff, dead-letter — is the SPEC, only the storage moves); SSE fan-out → Redis pub/sub (each replica subscribes, each feeds its own sockets — the pattern the reliability topic's bulkheads would keep one slow replica from poisoning). The discipline that makes relocations safe: EXTRACT THE INTERFACE FIRST (the session store's createSession/getSession surface already hides where sessions live — callers don't change when the Map becomes Redis), then swap the implementation behind it, then delete the old path. And the one thing NOT to relocate: caches of shared data are the EASIEST relocation (the caching topic's store-kind reporting shows the swap already working) because a cache miss is always recoverable — move the LOSABLE state first, the load-bearing state last.`,
        },
        {
          kind: 'code',
          id: 'scaling-statelessness:redis-pointer',
          language: 'ts',
          caption:
            'The relocation, BEFORE half verbatim — same call sites when the store swaps (domain/auth/session_store.ts today; the AFTER lines, commented, are the caching topic\u2019s real redis calls)',
          source: 'server/src/domain/auth/session_store.ts',
          code: `const sessions = new Map<string, StoredSession>();

// …createSession mints the token, enforces the cap, sessions.set(token, session)…

/**
 * Looks a session up by bearer token with LAZY EXPIRY: an expired session is
 * deleted the moment it is touched, then reported as absent. No timer runs —
 * the store stays correct with nothing more than this check (plus the sweep
 * on create), which is exactly how a Redis-backed store behaves with TTLs.
 */
export function getSession(token: string): StoredSession | null {
  const session = sessions.get(token);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// AFTER (shared — every replica reads the same Redis), the caching topic's
// REAL store calls in cache_aside_service.ts, same idea:
//   await client.set(key, value, 'EX', ttlSeconds);
//   const cached = await client.get(key);
// The call sites did not change — getSession still exists, still returns
// a session or null. The Map became a shared store WITH TTLs, which also
// deleted the sweep/expiry code: Redis does the lazy expiry for free.`,
        },
      ],
    },
    {
      id: 'scaling-load-balancing',
      title: 'Load balancing',
      lead:
        'The front door that turns one box into a fleet: layers, algorithms, health checks — and the proxy contract this app currently documents as a gap.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-load-balancing:l4-l7',
          body: `TWO LAYERS. An L4 (transport) load balancer sees TCP/UDP — IP addresses and ports — and routes connections without reading them: fast, cheap, protocol-agnostic, and blind (it cannot route by path, cannot see a 500, cannot do anything smart about the bytes). An L7 (application) load balancer — a reverse proxy like nginx, HAProxy, or a cloud HTTPS load balancer — terminates the connection, PARSES HTTP, and routes by what it finds: /api to the app cluster, /docs too, this path to that service, and (the production killer feature) HEALTH-CHECK-BASED ROUTING: it polls each backend and stops sending traffic to one that fails — the moment a replica wedges, the fleet routes around it, which is half the reason replicas buy availability. THE ALGORITHMS are a short menu with real tradeoffs: ROUND-ROBIN (request 1 → A, 2 → B, 3 → C…) — fair, stateless, fine when requests cost alike; LEAST-CONNECTIONS — send each request to the backend with the fewest open requests, the right default when costs VARY (one slow endpoint would otherwise hog its fair-share replica under round-robin); IP-HASH — hash the client IP to a consistent backend. IP-hash is the one to be suspicious of, because it exists to WORK AROUND statefulness: "this client's requests always hit the replica that holds its session" is STICKY SESSIONS, and sticky sessions quietly re-import every scaling problem statelessness solved — load skews with IP populations (one office NAT = one backend), a dead replica takes its sessions with it, and autoscaling changes the hash space mid-flight. The senior reading of the algorithm menu: pick round-robin or least-connections, and if you catch yourself needing IP-hash, the previous section (move the state to a shared store) is the actual fix.`,
        },
        {
          kind: 'code',
          id: 'scaling-load-balancing:nginx-sketch',
          language: 'nginx',
          caption:
            'The forwarding contract, pinned from the deployment topic\u2019s TLS conf exhibit (server/src/domain/teaching/exhibit_c_deployment_tls_conf.ts); the upstream block is the multi-replica extension, in comments — this repo runs ONE server, and the shipped default.conf does not yet set the X-Forwarded-* lines',
          source: 'server/src/domain/teaching/exhibit_c_deployment_tls_conf.ts',
          code: `# The multi-replica extension (comments because this repo runs ONE server —
# with a fleet, proxy_pass names an upstream instead of one service):
#   upstream guide_app {
#       least_conn;                      # or round_robin (the default)
#       server 127.0.0.1:4000 max_fails=3 fail_timeout=10s;
#       # replicas join as more lines — the proxy needs no restart to know them
#   }

server {
    listen 443 ssl;
    # …TLS termination exactly as the deployment topic's conf does it…

    location /api/ {
        proxy_pass http://server:4000;
        proxy_http_version 1.1;
        # THE PROXY CONTRACT — see the next block: without these headers
        # the app behind the balancer sees the PROXY's facts, not the client's.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`,
        },
        {
          kind: 'text',
          id: 'scaling-load-balancing:proxy-contract',
          body: `THE PROXY CONTRACT — the X-Forwarded-* headers and the trust that reads them. Behind a proxy, every request the app sees arrives FROM THE PROXY: req.ip is the proxy's address (so IP-keyed rate limiting throttles the proxy, not abusers — the security topic's limiter keyed per-instance has exactly this trap waiting), req.protocol is http (TLS terminated upstream), req.hostname may be the upstream name. The fix is a contract: the proxy FORWARDS the truth in X-Forwarded-For (client IPs, appended per hop), X-Forwarded-Proto (the scheme the client actually used), X-Forwarded-Host; the app OPTS IN with Express's \`app.set('trust proxy', …)\` — after which req.ip and req.protocol read those headers (picking the right hop count matters: trust the LAST hop you own, never an arbitrary count, or clients can spoof their IP through you). This app documents its own gap AS DATA: the deployment topic's stack explorer reports x-forwarded-proto as null through the shipped nginx because the conf does not yet set it (the route's comment is quoted in that topic) — a deliberate, visible live lesson that the CONTRACT has two ends and this repo currently implements one. HEALTH CHECKS AND THE BALANCER close the loop with the observability topic: the readiness-shaped probe (liveness = the process answers; readiness = its dependencies answer) is exactly what a balancer should poll — a replica that is alive but NOT ready must be taken out of rotation, or it will accept traffic and fail it. The observability topic's health strip is the endpoint shape; the upstream block above is the consumer.`,
        },
      ],
    },
    {
      id: 'scaling-replicas',
      title: 'Replicas and orchestration',
      lead:
        'docker compose --scale server=3 against THIS repo: what survives, what breaks, and why the break list is exactly the state inventory.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-replicas:scale-this-app',
          body: `THE HONEST EXPERIMENT: this repo's own compose files declare one \`server\` service, and docker compose can fan it out with \`docker compose -f .docker/docker-compose.yml up --scale server=3\` — three identical containers, one client proxy in front… except the client (Vite dev proxy / the prod nginx) is configured for ONE upstream, so out of the box the extra replicas just sit there. THAT IS THE FIRST LESSION: scaling is a WHOLE-PATH property — app copies without a balancer pointed at them are spare parts. Suppose you point a balancer at all three (the upstream sketch above): what WORKS is everything stateless — every /api/posts read hits sqlite via each container's own volume view, /api/content serves identical topic JSON from all three, the demos that only compute answer from any copy. What BREAKS is precisely the section-2 inventory, now with witnesses: log in on replica A, land on replica B for /me → 401 (sessions are per-process Maps); the SSE ticker connects to whichever replica the balancer chose and its status endpoint reports only THAT process's connections; the job queue runs three independent queues, so the scheduler (if enabled on all three) fires every job THREE TIMES — a duplicate-email bug you built with a flag; and the rate limiters now guard each replica separately, so the real abuse budget is 3 × the configured one. AND THE QUIET ONE THE INVENTORY PREDICTS: sqlite on a SHARED volume across containers is not the escape it looks like — better-sqlite3's single-writer model plus two processes' write caches on one file is the classic corruption setup; sqlite scales reads via copies, never multi-WRITER via a shared mount. The one-database-replica answer for this app is the sql topics' story: one writer (or a primary), replicas for reads.`,
        },
        {
          kind: 'code',
          id: 'scaling-replicas:compose-scale',
          language: 'bash',
          caption:
            'The experiment against this repo (verbatim command; the break list above is the predicted output)',
          code: `# from the repo root — three stateless-ish copies of the server:
docker compose -f .docker/docker-compose.yml up --scale server=3

# watch the state inventory diverge (each answers for ITSELF):
curl -s localhost:4000/api/demo/scaling/state | python3 -m json.tool
# "replicas": 1 — the honest report: this endpoint measures ITS process.
# Log in, then hit /api/demo/auth/me with the cookie through a balancer
# round-robining the replicas: 200, 401, 200, 401… — statelessness,
# demonstrated as a flicker.`,
        },
        {
          kind: 'text',
          id: 'scaling-replicas:k8s-and-12factor',
          body: `ORCHESTRATION, ONE PARAGRAPH OF SHAPES: past one host, the orchestration question ("which replicas exist, are they healthy, should there be more?") gets a system that owns it — Kubernetes is the vocabulary to know even when you never run it: a DEPLOYMENT says "N replicas of this container image, roll new versions gradually"; a SERVICE is the in-cluster load balancer + stable name fronting them; an HPA (HorizontalPodAutoscaler) watches CPU/RPS/custom metrics and moves N up and down. The entire preceding section still applies underneath — an HPA scaling a stateful app just manufactures divergence faster — and the platform contracts the environments topic taught (config in env, one process per container, logs to stdout) are precisely the contracts orchestrators assume; the 12-factor claim this app already practices is the on-ramp. THE MANAGER ALTERNATIVE at smaller scale: PM2's cluster mode (the deployment topic sketched it) forks N app processes sharing one port — the same statelessness bill, paid on one machine.`,
        },
      ],
    },
    {
      id: 'scaling-data',
      title: 'Data at scale',
      lead:
        'The app tier scales with copies; the database cannot. Read replicas, partition keys, CQRS, and caches as read-scaling.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-data:replicas-and-shards',
          body: `THE ASYMMETRY: stateless app replicas are cheap because requests are independent; DATA has invariants (one row, one truth) and one writer's ordering, so scaling data is a different discipline. READ REPLICAS are the first move: a PRIMARY accepts writes and streams its change log to SECONDARIES, each serving reads — most real workloads are read-heavy (this guide's /api/posts is), so 2–3 replicas absorb the read load while the primary keeps its budget for writes. The honest cost is REPLICATION LAG: a read-your-own-writes request that hits a replica the write hasn't reached answers STALE data, so the routing rule is deliberate — writes and write-then-read flows go to the primary; scalable-but-stale-tolerant reads (lists, feeds, analytics) go to replicas. SHARDING (the scale cube's Z-axis) partitions the DATA SET itself: shard 1 holds users a–m, shard 2 n–z, each shard a smaller database, together more than any one could hold. The entire difficulty is the PARTITION KEY — the sql-schema topic's design discipline is the prerequisite: pick the key every hot query already filters by (user_id, tenant_id, region), because a query without the key asks EVERY shard (a scatter-gather that spends the win), and a key that Hot-Skews (one tenant bigger than the rest) recreates the original bottleneck inside one shard. And resharding — moving live data because you outgrew the first key choice — is among the hardest operations in backend engineering: choose keys like they're permanent. THE MIDDLE PATH this app's stack models well: sqlite reads are so fast (embedded, no network hop) that "one database" is a much later ceiling than the internet folklore says — measure before you shard, exactly as the capacity section closes.`,
        },
        {
          kind: 'code',
          id: 'scaling-data:cqrs-sketch',
          language: 'text',
          caption: 'CQRS in one picture — a sketch (the read side may lag the write side; that is the trade)',
          code: `WRITE side (commands)                     READ side (queries)
 posts use case ──▶ sqlite (posts,          list_posts ◀── read replicas
 the ONE writer     the source of truth)    / projections  / cache-aside entries
      │                                     / denormalized views
      └── on change: invalidate/update ────▶
          (the caching topic's invalidation is the small version)

Same data, different SHAPES: the write side protects invariants
(transactions — the sql-node topic); the read side is free to be
whatever reads fastest (copies, projections, caches). CQRS proper
adds separate models/events between the two — same lesson at
larger size: reads scale by ADDING COPIES, writes stay concentrated.`,
        },
        {
          kind: 'text',
          id: 'scaling-data:caches-as-read-scaling',
          body: `CACHES ARE READ SCALING — the cheapest replica of all. Before a database read-replica, the caching topic's cache-aside already does the same job in front of it: compute (or fetch) once, serve the next thousand from memory, and the single-flight guard is what makes it scale-SAFE — under a hot key, N concurrent misses share ONE origin call instead of dogpiling it (the stampede demo measured 10 origin calls collapsing to 1), which is exactly the property a fleet of read replicas ALSO needs in front of its refill logic. THE INVALIDATION DISCIPLINE transfers unchanged: a cache in front of a primary plus replicas must be invalidated on write (the caching topic's explicit-invalidate endpoint) or every replica happily serves the stale answer forever — and at multi-replica scale the cache itself becomes a shared store (Redis), where it started in this app. THE FULL READ LADDER, cheapest first: an index (SQL topics) → cache-aside with single-flight (caching topic) → read replicas with primary/secondary routing → CQRS projections → shard. Each rung multiplies the last; skipping to the dramatic rung before measuring is the anti-pattern the whole topic keeps naming.`,
        },
      ],
    },
    {
      id: 'scaling-cdn',
      title: 'CDNs and the edge',
      lead:
        'The same content, served from a city nearer the user — for free, if the caching headers you already ship say it may.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-cdn:static-assets',
          body: `A CDN IS A READ REPLICA FOR BYTES: PoPs (points of presence) in many cities hold copies of your content and answer users from the nearest one — your origin sees only the misses. STATIC ASSETS are the part that works AUTOMATICALLY, and this repo already ships the exact contract: Vite emits CONTENT-HASHED filenames (\`assets/index-B1xK9f.js\` — the hash IS the version), and the caching topic's immutable-asset demo showed the pairing that makes it perfect — \`Cache-Control: max-age=31536000, immutable\` — because a browser/CDN can cache the file FOREVER: the name changes when the content does, so "forever" never goes stale. Every request the CDN absorbs is one your app processes, your load balancer, and your database never see — for a content-heavy product that is the majority of all traffic, offloaded by two response headers. API RESPONSES AT THE EDGE are the hard part, and the difficulty is exactly VARIANCE: the same URL can answer differently per user (Authorization, cookies), per negotiation (Accept-Language — the i18n topic sets Vary: Accept-Language for precisely this), per time (a live feed) — and a CDN that caches the wrong variance serves Alice's data to Bob. The edge rules that make APIs safe: cache only what is SHARED, mark personal responses private/no-store, and set Vary for every request header the answer depends on (the http topic's Vary discussion); per-user content at the edge needs the cache key extended (cookies/API keys into the key) — powerful, and now you own invalidation per user, which is why most APIs start with only their PUBLIC, versioned, shared responses at the edge.`,
        },
        {
          kind: 'code',
          id: 'scaling-cdn:headers-quote',
          language: 'ts',
          caption:
            'The contract this app already serves (caching_demo_routes.ts sets exactly this on the immutable asset)',
          source: 'server/src/presentation/routes/caching_demo_routes.ts',
          code: `const CACHE_CONTROL_REVALIDATE = 'public, max-age=0, must-revalidate';
const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

// …the deterministic asset: ETag = sha256 of the BODY, stable across restarts…
let assetMemo: { body: string; etag: string } | undefined;

// content-hashed name + immutable caching = cache-forever by design:
//   GET /api/demo/caching/asset?version=immutable
//   → Cache-Control: public, max-age=31536000, immutable
//   → ETag: <sha256 of the body>   (weak If-None-Match → 304)
//
// The vite build does the same for the client shell:
//   dist/assets/index-<hash>.js — a new hash per build, so
//   "cache forever" and "users get updates" are both true.`,
        },
        {
          kind: 'text',
          id: 'scaling-cdn:shielding',
          body: `ORIGIN SHIELDING is the CDN's own cache-aside for its fleet: without a shield, ONE cache miss fans out to your origin once PER POP (a London miss, a Tokyo miss, a São Paulo miss — three origin hits for one object); with a shield, misses from all PoPs funnel through one inner CDN tier, so the origin sees at most one fetch per object per shield lifetime. You have seen this pattern twice already in this app: it is the caching topic's SINGLE-FLIGHT (N concurrent misses, one origin call) implemented at planetary scale, and the jobs queue's concurrency-1 worker (one thing at a time, on purpose) for refill traffic. THE EDGE OF YOUR EDGE: before any CDN, this stack already runs one layer of edge infrastructure — the deployment topic's nginx terminating TLS at the perimeter is functionally a mini-PoP (the nearest hop to the client, offloading crypto from the app), and adding a CDN in front composes: browser → CDN PoP (static bytes, maybe) → nginx (TLS, routing) → replicas. Each layer either answers (cache hit) or narrows (shield/route) — and the x-forwarded-* contract from the load-balancing section now has THREE hops whose headers must be preserved end to end, which is exactly why that contract is standardized and why "trust the last hop you own" is the discipline.`,
        },
      ],
    },
    {
      id: 'scaling-backpressure',
      title: 'Backpressure and shedding at scale',
      lead:
        'A fleet under overload must refuse work at the boundary — queues with limits, 429s that coordinate, drains that wait.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-backpressure:refuse-visibly',
          body: `OVERLOAD IS THE SCALE TOPIC'S WEATHER: load balancers multiply capacity AND multiply the blast radius of the day traffic doubles. The reliability topic built the per-dependency tools (timeouts, breakers, degradation); at FLEET scale the same refusal discipline faces INWARD at your own queues and limits. QUEUE DEPTH LIMITS: the jobs topic built the shape in-process — cap 50, dead-letter after max attempts, requeue as a deliberate act — and the reasoning transfers to any broker: an unbounded queue doesn't absorb load, it POSTPONES the crash while eating memory (the backlog that finally fails, fails all at once, hours late — the worst possible failure timing). The queue's stats endpoint exposes the two alert-worthy numbers (depth, oldest-queued age) precisely because a queue without visible depth is a buffer you can't reason about. 429 AS GLOBAL COORDINATION: the security topic's rate limiter protects ONE process against ONE client — but its counters are per-instance (the section-2 inventory), so N replicas = N × the budget, and under a real attack each replica independently decides "fine". Scaling the LIMITER is scaling the state: Redis-backed counters make the budget GLOBAL (one INCR, shared by every replica), turning 429s from per-process guesses into a fleet-wide admission decision — with Retry-After and RateLimit-* headers (the security limiter already sends them) so well-behaved clients back off and the fleet recovers together. THE TRANSPORT VERSION is backpressure — the files topic's drain-aware writer (write → false → await 'drain') is a producer REFUSING to outrun its consumer at the byte level, and it is why the jobs worker runs concurrency-1 by design: refuse work you cannot do well, at the boundary, visibly.`,
        },
        {
          kind: 'code',
          id: 'scaling-backpressure:drain-quote',
          language: 'ts',
          caption:
            'Verbatim — the drain pattern the files topic runs (writeLinesWithBackpressure in files_demo_routes.ts, abridged to the lesson)',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          code: `export async function writeLinesWithBackpressure(
  sink: BackpressureSink,
  lines: readonly string[],
): Promise<{ drainEvents: number; pausedMs: number }> {
  let drainEvents = 0;
  let pausedMs = 0;
  for (const line of lines) {
    if (sink.write(line)) continue; // buffer has room — keep producing
    drainEvents += 1;
    const pausedAt = performance.now();
    await new Promise<void>((resolve) => {
      // …first one wins: 'drain' OR 'close' — an aborted client can't hang us…
    });
    pausedMs += performance.now() - pausedAt;
  }
  return { drainEvents, pausedMs: Math.round(pausedMs * 10) / 10 };
}
// The fleet-scale twins: a bounded job queue (depth cap 50), a global
// rate limiter (429 + Retry-After), a breaker's fast rejection. Same
// word each time: REFUSE at the boundary, don't fail in the middle.`,
        },
      ],
    },
    {
      id: 'scaling-capacity',
      title: 'Capacity planning',
      lead:
        'Two numbers — peak RPS and the p95 budget — and the discipline of measuring before buying.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-capacity:two-numbers',
          body: `CAPACITY PLANNING IS ARITHMETIC OVER TWO MEASURED NUMBERS, and both are already instruments in this app. NUMBER ONE — PEAK RPS: requests per second at your WORST realistic moment (the morning spike, the marketing email landing, the crawl), which you get from the observability topic's request counters — not from averages (the mean of a spiky day lies; plan for the spike, and multiply by a headroom factor of ~2 for the day the spike is twice as bad). NUMBER TWO — THE LATENCY BUDGET: the p95 (or p99) response time you promise, from the performance topic's percentile discipline — medians hide the tail, and the tail IS the user experience of your slowest 5%, which at scale is THOUSANDS of real people. THE DIVISION: one replica delivers roughly (its measured throughput at the p95 target) requests/second — you measure THAT with a load test at the p95 constraint (a replica that does 1000 rps at p95=3s is NOT a 1000-rps replica if your budget is 300ms), and replica count = peak × headroom ÷ per-replica-throughput. Then the cross-check the reliability topic taught: each replica's outbound dependencies (database, redis, the third-party API) multiply too — N replicas can DDoS their own database via N × connection pools, which is why pool sizing and bulkheads are part of capacity, not an afterthought. THE DISCIPLINE THAT MAKES IT ALL HONEST: MEASURE BEFORE BUYING (the when-not-to-scale section) and KEEP MEASURING AFTER (the same metrics that sized the fleet tell you when it's full) — the HPA in the orchestration section is just this loop, automated; the numbers still have to be yours.`,
        },
        {
          kind: 'code',
          id: 'scaling-capacity:the-arithmetic',
          language: 'text',
          caption: 'The whole section as arithmetic — every input measured, none guessed',
          code: `peak_rps          = observed peak × headroom (×2 is a floor, not a rule)
p95_budget_ms     = the promise you make users (e.g. 300ms)
per_replica_rps   = load-test ONE replica HELD AT the p95 budget
                      (throughput at p95=3s is not throughput at p95=300ms)

replicas          = ceil(peak_rps / per_replica_rps)  (+ 1 for survives-one-death)
per-replica deps  = db pool / redis connections / third-party rate limits
                      × replicas ≤ what the DEPENDENCY allows
                      (N app replicas can starve their own database)

inputs live in:   /api/demo/obs/metrics  (request counters, event-loop delay)
                  /api/demo/perf/…       (the percentile discipline)
                  /api/demo/jobs/…/stats (queue depth — the demand signal)`,
        },
      ],
    },
    {
      id: 'scaling-see-it-live',
      title: 'See it live',
      lead:
        'The process-state inspector: this app grades its own statelessness live — every hazard counted from the running process, every fix named.',
      blocks: [
        {
          kind: 'text',
          id: 'scaling-see-it-live:what-you-see',
          body: `THE DEMO makes section two measurable: \`GET /api/demo/scaling/state\` inspects THIS PROCESS and returns its state inventory with LIVE counts — the session store's current size, the job queue's depth, the SSE feed's open connections, the rate limiters' configured windows (their counter Maps are deliberately private, so the demo reports what they're configured to do — an honest not-exposed note, not a fake number), each with its shared? / breaks-scaling? verdict and the FIX that relocates it. The two lists are the whole topic in one response: STATEFUL (breaks horizontal scaling until relocated) and SHARED/STATELESS (already fine — including sqlite, with the single-writer caveat). The PID and replicas:1 fields are the punchline — open two browser tabs against two replicas and each tab's session count, queue depth, and connection count would DISAGREE, because each endpoint measures only the process that answered it. Log in through the auth demo first and watch the session counter tick up; open the realtime ticker in another tab and watch connections go 0 → 1; enqueue a job and watch depth spike and drain. Or script it:`,
        },
        {
          kind: 'code',
          id: 'scaling-see-it-live:curl',
          language: 'bash',
          caption: 'The state inventory over curl — log in, connect, enqueue, and watch the counts move',
          code: `# the inventory, as this process sees itself:
curl -s localhost:4000/api/demo/scaling/state | python3 -m json.tool

# make the state REAL — a login creates a session (stateful count +1):
curl -s -c /tmp/guide.jar -X POST localhost:4000/api/demo/auth/login \\
  -H 'content-type: application/json' \\
  -d '{"username":"alice","password":"guide-demo-pw"}' > /dev/null
curl -s localhost:4000/api/demo/scaling/state \\
  | python3 -c 'import sys,json; h=json.load(sys.stdin)["stateful"][0]; print(h["name"], "→", h["count"])'

# a queued job moves the depth (it drains in ~100ms — catch it or check stats):
curl -s -X POST localhost:4000/api/demo/jobs/enqueue \\
  -H 'content-type: application/json' \\
  -d '{"type":"report","payload":{"source":"scaling demo"}}' > /dev/null
curl -s localhost:4000/api/demo/jobs/stats | python3 -m json.tool`,
        },
        {
          kind: 'demo',
          id: 'scaling-see-it-live:demo',
          demoId: 'scaling:stateless',
          title: 'The process-state inspector',
          description:
            'This app inventories its own statelessness LIVE: every piece of per-process state (sessions, limiter windows, job queue, SSE connections) counted from the running process with its breaks-scaling verdict and the fix that relocates it — beside the already-shared stores. Refresh and watch the counts move as you log in, connect, and enqueue.',
        },
      ],
    },
  ],
};
