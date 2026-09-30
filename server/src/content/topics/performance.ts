import type { Topic } from '../types.js';

/**
 * The Performance topic — the guide's rule over measurement: every technique
 * here (compression, clustering, pooling) is presented as the SECOND half of a
 * sentence that starts with a number. The live demo is a real before/after
 * benchmark pair, and the code quotes are this repo's own instrumentation
 * (request_metrics' percentiles, the event-loop stall probe, the serialized
 * cache origin) plus explicitly-labeled sketches where the repo deliberately
 * does NOT use a technique (the cluster module, a pg pool) — saying why is
 * part of the lesson.
 */
export const topicPerformance: Topic = {
  id: 'performance',
  title: 'Performance',
  subtitle:
    'Profiling, event-loop hygiene, clustering, compression, and connection pooling.',
  group: 'platform',
  order: 9,
  sections: [
    {
      id: 'perf-measure',
      title: 'Measuring before optimizing',
      lead:
        'The prime directive: no change without a number first. Latency vs throughput, percentiles not averages, and benchmarks that survive contact with a skeptic.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-measure:prime-directive',
          body: `THE PRIME DIRECTIVE: measure first, change second, measure again. Every optimization is a hypothesis ("this path is slow because X") until a number confirms it — and the number that confirms it is almost never the one a hunch predicts. The cost of skipping the measurement is not just wasted work; it is NEGATIVE work: compression on a CPU-bound server makes it slower, a connection pool sized by vibes can exhaust a database, clustering an I/O-bound app adds coordination overhead that shows up as tail latency. THE TWO AXES that get conflated: LATENCY is how long ONE request takes (what a user feels); THROUGHPUT is how many requests fit in a second (what a capacity plan feels). They trade off — batching raises throughput by holding requests until the batch is full, which is pure added latency — so the first question of any perf conversation is "which one are we improving, and for whom?". PERCENTILES, NOT AVERAGES: an average of 40ms describes a system where every request takes 40ms AND one where 99 take 5ms and one takes 3.5 SECONDS — the average is identical, the experiences are not. Users live in the tail: p95 is "the worst experience your twentieth-slowest user in a hundred gets", p99 your power user with the most data. This app's observability topic already computes exactly this pair over a ring of the last 100 request durations — the quote below is the real function. A CATALOG for going further: \`autocannon\` (Node-native HTTP load generator, what you'd point at this very server), \`k6\` (scriptable scenarios with thresholds — "fail CI if p95 > 200ms"), and \`clinic.js\` (doctor + flame graphs for the event-loop and GC stories later in this topic).`,
        },
        {
          kind: 'code',
          id: 'perf-measure:percentiles-quote',
          language: 'ts',
          caption:
            'Verbatim — nearest-rank percentiles over the last 100 request durations (core/logging/request_metrics.ts)',
          source: 'server/src/core/logging/request_metrics.ts',
          code: `/** Nearest-rank percentile over a sorted sample; null when nothing settled yet. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank - 1, sorted.length - 1)] ?? null;
}

export function snapshotRequestMetrics(): RequestMetricsSnapshot {
  // Copy + sort: the snapshot must not mutate the live ring mid-request.
  const sorted = [...recentDurations].sort((a, b) => a - b);
  return {
    total,
    byStatusClass: { ...byStatusClass },
    inFlight,
    durations: {
      count: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
    },
  };
}`,
        },
        {
          kind: 'text',
          id: 'perf-measure:benchmarking-honestly',
          body: `BENCHMARKING HONESTLY — the rules this topic's own demo endpoint obeys, because it measures itself with them. (1) WARM UP before you measure: the first run pays JIT compilation, cache population, and connection setup — numbers from cold code are folklore. (2) RUN N TIMES AND TAKE A MEDIAN, never a single sample: single runs measure your machine's background noise as much as your code (this repo learned that lesson twice — its own UI specs have flaked under heavy ambient load; a benchmark must not). (3) MEASURE WHAT YOU CHANGED, HOLD EVERYTHING ELSE: same payload bytes, same process, same run — which is why the demo's telemetry payload is DETERMINISTIC (same size always produces byte-identical JSON, proven by hashing it twice in the spec). (4) REPORT THE VARIANCE, not just the central number — a median of 3ms ± 0.1 and a median of 3ms ± 40 are different systems. (5) SAY WHAT YOU DID NOT MEASURE: the demo's benchmark is in-process (serialization + gzip, no network, no browser negotiation) and its note says so — an honest benchmark's caption is half the value.`,
        },
      ],
    },
    {
      id: 'perf-event-loop',
      title: 'Event-loop hygiene',
      lead:
        'Node is fast because it never waits — which means anything that blocks the single thread blocks EVERYONE. The golden rule, its usual suspects, and the smoke detector.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-event-loop:golden-rule',
          body: `THE GOLDEN RULE (the Node.js topic demonstrated it live; this is the performance lens): every millisecond your JavaScript holds the single thread is a millisecond NO request is served, no timer fires, no callback runs. The topic's \`/api/demo/node/blocking\` endpoint measures exactly this with a stall probe — a \`setImmediate\` callback scheduled before the work starts; the gap until it fires is time the loop was dead to the world (quoted below). The performance discipline is the checklist of usual suspects: (1) SYNC CPU WORK in a request path — hashing, parsing giant inputs, image transforms (the sharp pipeline in the files topic runs on libuv threads precisely for this reason; worker_threads exist for the rest). (2) \`JSON.parse\` / \`JSON.stringify\` OF HUGE PAYLOADS — they are synchronous, O(n), and a 50MB body can freeze the loop for hundreds of ms; the fix is not parsing it in the first place (stream it — see (4)) or moving it off-thread. (3) SYNC FS CALLS — \`readFileSync\` etc.; the sqlite story below is the nuanced exception, not a license. (4) BUFFERING WHAT SHOULD STREAM — building a 500MB string in memory to send it once; the files topic's backpressure writer is the pattern. (5) REGEX BACKTRACKING — a catastrophic pattern (\`(a+)+b\` is the classic) on attacker-controlled input can burn CPU for hours; the defense is bounded patterns, length caps before matching, and the \`re2\` library when you must run untrusted patterns. THE SMOKE DETECTOR: the observability topic's \`/api/demo/obs/metrics\` exposes a REAL \`monitorEventLoopDelay\` histogram — event-loop delay is the one metric that says "your latency is CPU-shaped, not I/O-shaped", which is usually the fork in the road for everything else in this topic.`,
        },
        {
          kind: 'code',
          id: 'perf-event-loop:probe-quote',
          language: 'ts',
          caption:
            'Verbatim — the stall probe: the schedule-to-fire gap IS the event-loop delay (presentation/routes/node_demo_routes.ts)',
          source: 'server/src/presentation/routes/node_demo_routes.ts',
          code: `async function blockingController(req: Request, res: Response): Promise<void> {
  // …
  // The probe: scheduled NOW, but it cannot fire until this handler's
  // synchronous work finishes — the schedule-to-fire gap IS the loop stall.
  const scheduledAt = performance.now();
  let firedAt = 0;
  setImmediate(() => {
    firedAt = performance.now();
  });
  busyHashFor(workMs, createHash('sha256'));
  // One more loop turn so the probe (queued first) has fired before we answer.
  await new Promise<void>((resolve) => setImmediate(resolve));

  res.json({
    mode: 'blocking',
    workMs,
    eventLoopDelayMs: roundMs(firedAt - scheduledAt),
  });
}`,
        },
        {
          kind: 'text',
          id: 'perf-event-loop:sqlite-nuance',
          body: `THE NUANCE THAT SURPRISES EVERYONE: better-sqlite3 is SYNCHRONOUS by design — every \`.prepare().run()\` blocks the event loop until sqlite answers — and this app uses it as its PRIMARY database anyway, on purpose. Why that is not the sin it sounds like: sqlite in-process calls are MICROSECONDS-to-low-milliseconds (no network, no serialization protocol, no context switch — the database IS a function call into a C library), so the blocking window is smaller than the event-loop cost of dispatching an async database driver's callbacks. The rule it carves: sync is fine when the bound work is SHORT AND PREDICTABLE; it is a disaster when it is long or unbounded (network fs, big files, external processes). Know which one you are holding — and when sqlite grows slow (a giant scan, a locked table), its sync nature becomes the incident, which is exactly when the pg-on-a-pool pattern in the pooling section below is the answer.`,
        },
      ],
    },
    {
      id: 'perf-bench',
      title: 'The benchmark pair: compression, measured',
      lead:
        'A live before/after: the same telemetry payload over the wire with and without compression, plus the server-side CPU cost — because compression trades CPU for bytes and you should see both sides.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-bench:when-it-wins',
          body: `COMPRESSION IS A TRADE, NOT A DEFAULT: you spend CPU (serialization already happened; now add deflate) to save BYTES on the wire and seconds of transfer on slow links. It wins when the payload is TEXT (JSON, HTML, CSV — repetitive, compressible), big enough to amortize the CPU (a ~1KB floor is the usual threshold; the \`compression\` middleware's default), and the server has CPU headroom. It loses — and this is the part teams skip — when payloads are SMALL (fixed overhead dominates), ALREADY COMPRESSED (jpeg/png/webp/zip/gzip: you pay the CPU again to save ~1%; the middleware's filter skips these by content-type), the link is FAST LOCALHOST-to-localhost inside a datacenter (bytes are nearly free, CPU is not), or the server is CPU-BOUND (compression is exactly the sync work the last section warned about — on a saturated loop it makes everything slower). br VS gzip: brotli compresses ~15–20% smaller at similar speed and is what every modern browser negotiates first; gzip is the universal fallback; \`zstd\` is arriving in browsers and already common at the CDN layer. The middleware picks whatever the \`Accept-Encoding\` header ranks highest — the demo shows the negotiation happening. SCOPED, NOT GLOBAL — this app's honest deviation: production apps mount \`compression()\` app-wide; this app mounts it on ONE route, because nearly every response here is a teaching artifact whose headers the specs assert (Content-Length on buffered streams, exact ETag bytes, raw ndjson) — a global middleware would rewrite them all. The demo below is the scoped mount; the tradeoff is stated where it is made.`,
        },
        {
          kind: 'code',
          id: 'perf-bench:mount-quote',
          language: 'ts',
          caption:
            'Verbatim — the route-scoped mount with the teaching switch (presentation/routes/perf_demo_routes.ts)',
          source: 'server/src/presentation/routes/perf_demo_routes.ts',
          code: `/**
 * The middleware is attached per-route below — the whole app's other
 * responses keep their identity headers. The filter ANDs the teaching switch
 * (?noCompress → identity) with compression's own compressible-type check.
 */
const payloadCompression = compression({
  filter: (req, _res) => req.query.noCompress === undefined && compression.filter(req, _res),
});

export const perfDemoRouter = Router();
perfDemoRouter.get('/demo/perf/payload', payloadCompression, payloadController);
perfDemoRouter.get('/demo/perf/benchmark', benchmarkController);`,
        },
        {
          kind: 'text',
          id: 'perf-bench:reading-the-numbers',
          body: `HOW TO READ THE DEMO. Fetch the payload with compression and you see: \`Content-Encoding: gzip\` (or \`br\`, per your browser's negotiation), NO \`Content-Length\` (the middleware streams — the size is not known until deflate finishes, so the transfer is chunked), and the body arrives in a fraction of the raw bytes. Fetch with \`?noCompress=1\` and you get identity: a \`Content-Length\`, full-size transfer, zero extra CPU. The RUN BENCHMARK button is the honest ledger: the server builds the SAME deterministic payload \`runs\` times and reports medians — \`msRaw\` (JSON.stringify alone) vs \`msCompressed\` (stringify + gzipSync), plus \`bytesRaw\` vs \`bytesCompressed\` and the ratio. Watch what the numbers actually say: the byte savings on repetitive telemetry is enormous (often 10–30× — repeated structured text is deflate's favorite food), while the CPU cost per response is fractions of a millisecond at these sizes. That asymmetry — huge wire savings, tiny CPU cost — is WHY compression is a near-default for text APIs, and the same ledger run against a 1KB payload or a pre-compressed image would show the opposite, which is why it is a measurement and not a law.`,
        },
      ],
    },
    {
      id: 'perf-cluster',
      title: 'Clustering',
      lead:
        'The cluster module: fork one process per core, share the port, multiply CPU. When it helps, when it is pure overhead — and the sticky-session trap this app would fall into.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-cluster:what-it-is',
          body: `WHAT CLUSTERING IS: Node runs your JavaScript on ONE core, and no amount of async I/O adds a second. \`node:cluster\` forks N worker processes (N = your core count, by convention) and the MASTER owns the listening socket, handing connections to workers round-robin — one port, N processes, N cores of CPU. The master/worker split matters for operational reasons beyond CPU: the master is a supervisor (a worker that dies is replaced; \`pm2\` and Kubernetes build on the same idea), and each worker is a full isolate — its own heap, its own module state. WHEN IT HELPS: when you are CPU-BOUND — hashing, TLS handshakes, JSON of big payloads, compression at volume, template rendering. Fork per core and throughput scales nearly linearly. WHEN IT DOES NOT: when you are I/O-BOUND (waiting on the database, on redis, on upstream APIs) — extra processes multiply WAITING, which the event loop was already doing perfectly in one; this app is exactly that shape (its routes are thin controllers over sqlite/optional services), which is why the repo runs single-process and this section quotes the pinned teaching exhibit instead of the app. For I/O-bound apps the wins live elsewhere in this topic: keep the loop healthy, pool the connections, cache, compress. THE PM2 PATH (the deployment topic's catalog): \`exec_mode: 'cluster', instances: 2\` gives you the same fork-per-core with rolling reloads — read that section for the supervisor story.`,
        },
        {
          kind: 'code',
          id: 'perf-cluster:sketch',
          language: 'ts',
          caption:
            'Pinned — the canonical cluster shape (server/src/domain/teaching/exhibit_a_node_workers.ts: NOT executed by this app, which is I/O-bound and single-process by design; the node-js topic owns the exhibit)',
          source: 'server/src/domain/teaching/exhibit_a_node_workers.ts',
          code: `import cluster from 'node:cluster';

/** Shape 1 — cluster: one full server process per core, all on the same port. */
export function runClustered(serverBootstrap: () => void): void {
  if (cluster.isPrimary) {
    for (const _core of os.cpus()) cluster.fork(); // each child runs this same file
  } else {
    serverBootstrap(); // child process: start the Express server — connections are shared out
  }
}

// The production master also SUPERVISES — a dead worker is replaced at once
// (pm2's cluster mode and Kubernetes build on exactly this idea):
//   cluster.on('exit', (worker) => { cluster.fork(); });`,
        },
        {
          kind: 'text',
          id: 'perf-cluster:sticky-trap',
          body: `THE TRAP: STICKY SESSIONS AND PER-PROCESS STATE. Fork N workers and you have N ISOLATES — anything in a module-level \`Map\` is per-WORKER, and the round-robin will route a user's second request to a worker that has never heard of them. This app would trip on it three times, and its own session store documents the first one verbatim: in-memory sessions are PER-PROCESS, so a second replica would not see them (the quoted comment below — and its own stated fix, the shared Redis store with TTLs, is exactly what the Redis topic builds). The second trip is the auth topic's in-memory OAuth code store; the third is every demo singleton in this guide (the jobs queue, the chat hub, the breaker you will meet in the next topic). THE TWO EXITS: (1) EXTERNALIZE the state — sessions to redis, queues to a real broker, cache to the shared store — after which workers are interchangeable and any worker can serve any request (the "stateless design" the scaling topic takes up); or (2) STICKY ROUTING — hash the client (usually a cookie) to a worker at the proxy so the same worker always serves them. Sticky works tomorrow but buys you the worse problem long-term: workers stop being interchangeable, a dead worker takes its sessions with it, and load skews with your hash. Externalize early; the guide's own session-store comment is the honest voice of that lesson.`,
        },
        {
          kind: 'code',
          id: 'perf-cluster:session-quote',
          language: 'ts',
          caption:
            'Verbatim — the per-process honesty, in the auth topic\u2019s own session store (domain/auth/session_store.ts)',
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
      ],
    },
    {
      id: 'perf-pooling',
      title: 'Pooling and connection discipline',
      lead:
        'Connections are resources: expensive to build, cheap to reuse, catastrophic to exhaust. Which pools this app needs (and deliberately does not), and the HTTP side almost everyone forgets.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-pooling:the-idea',
          body: `THE IDEA: a connection (TCP handshake + auth + protocol negotiation for a database; TLS for an HTTPS upstream) costs milliseconds you do not want in ANY request's path, and every database server has a CONNECTION CAP far below your peak concurrency. A POOL keeps K warm connections and lends them out — the two numbers that matter are POOL SIZE (K: big enough to hide setup, small enough to respect the database's cap — for postgres, tens, not hundreds; more workers waiting on a saturated resource just queue) and CHECKOUT DISCIPLINE (every \`pool.query\` borrows and returns; a leaked connection is a slow outage). WHAT THIS APP POOLS AND WHAT IT DOES NOT, honestly: better-sqlite3 needs NO pool — there is no connection at all, the database is an in-process C call (one lazily-created handle, quoted below); mongoose and ioredis each keep ONE cached connection per process by design (the data-layer singletons from the mongo/redis topics — a pool of one, which is honest for a demo and the right default for many read loads). The pattern you reach for when a real database arrives is the pinned pg pattern below — \`pg.Pool\`, sized deliberately, \`pool.end()\` in the shutdown drain alongside the guide's other drains.`,
        },
        {
          kind: 'code',
          id: 'perf-pooling:sqlite-quote',
          language: 'ts',
          caption:
            'Verbatim — why the primary database has no pool (data/posts/sqlite_client.ts)',
          source: 'server/src/data/posts/sqlite_client.ts',
          code: `/**
 * Lazy singleton sqlite handle. Nothing here opens a database until the first
 * repository call in live mode — fake-mode runs (and every test using them)
 * never pay for a connection. Under vitest appConfig.dbPath is ':memory:', so
 * tests can't touch a real file.
 */
let db: Database.Database | undefined;

export function getSqlite(): Database.Database {
  db ??= bootstrap(openDatabase());
  return db;
}`,
        },
        {
          kind: 'code',
          id: 'perf-pooling:pg-sketch',
          language: 'ts',
          caption:
            'Pinned — the pg Pool pattern this app would adopt with a server-based database (server/src/domain/teaching/exhibit_c_performance_pg_pool.ts; labeled: no postgres in this repo)',
          source: 'server/src/domain/teaching/exhibit_c_performance_pg_pool.ts',
          code: `/** The pool's configuration, in pg's own field names. */
export const PG_POOL_CONFIG = {
  // Sized deliberately: small enough to respect the database's connection
  // cap, big enough that request spikes queue at the pool (cheap) instead of
  // the TCP handshake (expensive). Start ~20–50 and let p95 tell you where
  // to move it.
  max: 20,
  idleTimeoutMillis: 30_000,
  // Checkout waits at most 5s — then a failure, not a hang.
  connectionTimeoutMillis: 5_000,
  // Where the connection string lives: env, per the environments topic.
  connectionString: process.env.PG_DATABASE_URL,
} as const;

// The construction, the day postgres arrives:
//   import { Pool } from 'pg';
//   export const pool = new Pool({ ...PG_POOL_CONFIG });
//
// Usage borrows and returns in one expression — connections can never leak:
//   const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [id]);
//
// Graceful shutdown drains the pool BEFORE the process exits (the same
// discipline as server.ts draining gRPC → mongo → redis → hub → http):
//   await pool.end();`,
        },
        {
          kind: 'text',
          id: 'perf-pooling:http-side',
          body: `THE HTTP SIDE ALMOST EVERYONE FORGETS: \`fetch\` (undici) keeps a connection pool per origin with keep-alive by default, but \`axios\`/\`node-fetch\` v2-era habits and hand-rolled \`http.request\` calls often open a FRESH TCP+TLS connection per outbound call — on a hot path that is tens of milliseconds and a port exhaustion story. The discipline: ONE shared client/agent per dependency origin, reused across requests; in Node 18+ plain \`fetch\` already does this, so the rule collapses to "don't defeat it". THE ACCIDENTAL-THROTTLING LESSON from this repo's own caching topic: its fake origin runs through ONE serialized promise chain — ten parallel misses QUEUE behind each other, each paying the full origin delay (quoted below). That was built on purpose to model a constrained resource (a single database connection!) and to make the cache-stampede dogpile visible — but read it as the generic warning: a pool of one is a QUEUE, and a serialized shared resource quietly throttles every caller behind it. When p95 climbs and the CPU is idle, look for exactly that shape.`,
        },
        {
          kind: 'code',
          id: 'perf-pooling:origin-quote',
          language: 'ts',
          caption:
            'Verbatim — the serialized origin as a teaching constraint (data/caching/cache_aside_service.ts)',
          source: 'server/src/data/caching/cache_aside_service.ts',
          code: `/**
 * The fake expensive query the whole topic caches: derives a report from the
 * seed posts. Deterministic by construction — same seeds in, same bytes out —
 * which is what makes the etag demo honest.
 *
 * The work is queued through ONE serial promise chain on purpose: it models a
 * constrained origin resource (a single database connection, the way
 * better-sqlite3 serializes). Ten simultaneous misses do not parallelize the
 * origin away — they QUEUE, each paying ORIGIN_DELAY_MS — which is exactly the
 * dogpile the stampede section makes visible.
 */
let originQueue: Promise<unknown> = Promise.resolve();

export async function buildPostsReport(): Promise<PostsReport> {
  const run = async (): Promise<PostsReport> => {
    // …await the 150ms hop, derive the report from SEED_POSTS, freeze it…
  };
  const next = originQueue.then(run, run); // run whether the last build won or lost
  originQueue = next.catch(() => undefined);
  return next;
}`,
        },
      ],
    },
    {
      id: 'perf-memory',
      title: 'Memory and GC basics',
      lead:
        'The heap grows by design and leaks by accident — telling them apart is the skill. Buffers in hot paths, and streaming as the ultimate memory fix.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-memory:growth-vs-leak',
          body: `GROWTH VS LEAK: Node's heap is SUPPOSED to grow — the young generation fills, scavenges, and survives what is still referenced; RSS climbs toward the old-generation ceiling you set (\`--max-old-space-size\`, default a few GB) and a sawtooth under load is HEALTHY. A LEAK is different: a sawtooth whose floor keeps RISING — memory that survives every GC because something still references it. The classic sources in a server: module-level caches with no cap or TTL (this app's rings are all capped for exactly this reason — the log ring at 200, the durations ring at 100), event listeners added per request on long-lived objects, closures capturing a big object through one small callback, and Promises that never settle holding their scope. THE DIAGNOSIS PATH lives in the debugging topic (\`node --inspect\`, heap snapshots diffed between two captures — "what grew between these two" is the leak, almost always); the observability topic's \`/api/demo/obs/metrics\` shows the LIVE rss and heap numbers to know whether you even have a problem. RULE OF THUMB: investigate when the FLOOR rises across restarts-free days, not when the ceiling is high on your busiest afternoon. BUFFERS IN HOT PATHS: allocation is cheap in V8 but not free at scale — a per-request \`Buffer.alloc\` on a hot path is GC pressure you can often remove by reusing one buffer (carefully: only when the use is synchronous, or you reintroduce the shared-mutable-state bug). STREAM EVERYTHING BIG — the strongest memory lever, not a micro one: a 2GB upload streamed to disk holds KBs in memory; buffered, it holds 2GB twice (string + buffer) and probably dies. The files topic's upload pipeline and backpressure writer are the working patterns, and the res.json of a giant report is the anti-pattern — paginate it.`,
        },
      ],
    },
    {
      id: 'perf-checklist',
      title: 'The performance review checklist',
      lead:
        'The compact block — what a senior reviewer asks before a performance-sensitive change merges.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-checklist:how-to-run',
          body: `WHY THESE TEN LINES. Each is a section of this topic compressed to one checkbox, and the compression is the point: a checklist line you cannot trace to an earned lesson is a ritual, and rituals get skipped. MEASURED FIRST/AFTER are the prime directive's two halves — no change without a number before, no merge without the delta (variance included) after. EVENT LOOP, STREAMING, COMPRESSION, POOLS, STATE, CLUSTER HONESTY, and TAIL are the seven failure shapes this topic watched live: a blocking call, a buffered giant body, an uncompressed text response, a leaked or throttled connection, unbounded module state, a cluster added where measurement never asked for one, and a p95 hiding behind a healthy average. HONESTY closes it the way the benchmarking rules did — say what you did not measure. HOW TO RUN ONE: invoke it whenever a change touches a request path, a hot loop, a payload shape, or adds process state — the author answers the ten lines in the PR description (MEASURED AFTER demands the quoted delta), and the reviewer attacks the diff with the same list; a line that cannot be answered is a finding, not a gap to wave through. Run it at PR time, not after the incident — by then it is a postmortem template.`,
        },
        {
          kind: 'code',
          id: 'perf-checklist:block',
          language: 'text',
          caption:
            'The perf review checklist — one line each, every line earned somewhere in this guide',
          code: `[ ] MEASURED FIRST   — a number (p50/p95 or throughput) names the problem BEFORE the change
[ ] MEASURED AFTER  — the same benchmark re-run; the delta quoted in the PR, variance included
[ ] EVENT LOOP      — no sync CPU/fs/regex-catastrophe added to a request path (or it is worker_threads)
[ ] STREAMING       — big bodies stream (request and response); nothing buffers what should not fit in memory
[ ] COMPRESSION     — text responses compressed (or the omission is deliberate and stated); media is not
[ ] POOLS           — shared client/agent per origin; pool size chosen; checkouts cannot leak; drain on shutdown
[ ] STATE           — new module-level state is capped/TTL'd and would survive a second process (or is documented per-process)
[ ] CLUSTER HONESTY — if CPU-bound: cluster/PM2 considered; if the win survives single-process measurement: it does not need it
[ ] TAIL            — p95 (and p99 where users care) checked, not just the average; no new N+1 or serialized-shared-resource shape
[ ] HONESTY         — what was NOT measured is written down`,
        },
      ],
    },
    {
      id: 'perf-see-it-live',
      title: 'See it live',
      lead:
        'The benchmark pair: fetch the same deterministic payload compressed and raw, then run the server-side benchmark and read both ledgers.',
      blocks: [
        {
          kind: 'text',
          id: 'perf-see-it-live:what-you-see',
          body: `THE DEMO pairs the two halves of this topic: a WIRE experiment and an HONEST BENCHMARK. Fetch the payload (small ≈ 2KB, medium ≈ 50KB, large ≈ 500KB of deterministic, deliberately-repetitive telemetry) compressed and you get the negotiated encoding (br or gzip, per your browser), no Content-Length, and a body a fraction of the raw size; fetch it with the no-compress switch and you get identity with an exact Content-Length — same bytes both times, by construction. RUN BENCHMARK and the server measures BOTH variants in-process — medians of serialization alone vs serialization + gzip — and reports the byte ratio beside the CPU cost, so the trade this whole topic has been describing is a table you generated. Or drive it from a terminal and watch the headers change shape:`,
        },
        {
          kind: 'code',
          id: 'perf-see-it-live:curl',
          language: 'bash',
          caption: 'The benchmark pair over curl — the same payload, two wire stories',
          code: `# compressed: Content-Encoding + chunked, no Content-Length
curl -s -D - -o /dev/null 'localhost:4000/api/demo/perf/payload?size=medium' \\
  -H 'Accept-Encoding: gzip'

# identity: exact Content-Length, the full ~50KB
curl -s -D - -o /dev/null 'localhost:4000/api/demo/perf/payload?size=medium&noCompress=1'

# the honest ledger: medians of stringify vs stringify+gzip, byte counts, ratio
curl -s 'localhost:4000/api/demo/perf/benchmark?size=medium&runs=10' | python3 -m json.tool

# the smoke detector beside it — a real event-loop delay histogram:
curl -s localhost:4000/api/demo/obs/metrics | python3 -m json.tool | head -30`,
        },
        {
          kind: 'demo',
          id: 'perf-see-it-live:demo',
          demoId: 'perf:bench',
          title: 'The compression benchmark pair',
          description:
            'Fetch the same deterministic telemetry payload compressed and raw (the negotiated encoding vs identity, side by side), then run the server-side benchmark for the median CPU cost and the byte ratio of both variants.',
        },
      ],
    },
  ],
};
