import type { Topic } from '../types.js';

/**
 * The Reliability Patterns topic — the distributed-systems half of the
 * platform story: when your dependencies are elsewhere, failure becomes a
 * DESIGN SPACE (timeouts, retries, breakers, degradation) instead of an
 * exception. The core artifact is the repo's real CircuitBreaker
 * (domain/reliability/) wrapped around a steerable flaky dependency; every
 * other quote is this app's own working code (the gRPC deadline, the job
 * queue's backoff+jitter, the optional-service null-fast pattern, the
 * failure-injection scenario store).
 */
export const topicReliability: Topic = {
  id: 'reliability',
  title: 'Reliability Patterns',
  subtitle:
    'Timeouts, retries with jitter, circuit breakers, and graceful degradation.',
  group: 'platform',
  order: 10,
  sections: [
    {
      id: 'reliability-partial-failure',
      title: 'Distributed systems fail differently',
      lead:
        'A crashed dependency is polite: it says no. A HUNG one is the outage. Partial failure is the problem this whole topic exists for.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-partial-failure:the-problem',
          body: `THE PROBLEM WITH MORE BOXES: every dependency you add is a new way to be half-broken. In-process calls either work or throw, fast. Network calls have a THIRD state — the hang: the packet left, nothing came back, and your request sits in a promise that neither resolves nor rejects while its database connection, its memory, and its user's patience are all held open. A crashed dependency is almost the GOOD case — you get ECONNREFUSED in milliseconds and can route around it. The killer is the degraded one: the database that answers 30s late under load, the API that accepts your connection and never writes a byte. Without intervention, ONE slow dependency propagates its slowness upstream — your workers pile up waiting on it, the pile exhausts your threads/connections/heap, and the DEPENDENCY's failure becomes YOUR outage (and then your callers', which is how one slow service takes down a whole graph — cascading failure). THE PRIME DIRECTIVE this topic builds into mechanisms: every outbound call needs a DEADLINE you chose, a retry policy that cannot make things worse, and a way to stop calling something that is demonstrably down. Those three are the next three sections; degradation, bulkheads, and chaos round out the toolkit. And the honest inversion worth saying up front: reliability patterns do not make failures rare — they make failures BOUNDED. A breaker does not fix the flaky dependency; it makes the blast radius yours instead of the graph's.`,
        },
      ],
    },
    {
      id: 'reliability-timeouts',
      title: 'Timeouts: every call gets a deadline',
      lead:
        'Pick them like budgets, not defaults: decompose the user-facing deadline down the call chain, and enforce it with AbortController.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-timeouts:budgets',
          body: `TIMEOUTS ARE BUDGETS. Start from what the CALLER can tolerate — a user-facing API request should answer in ~2s or explain itself — and DECOMPOSE it down the chain: 2s user budget − web/proxy overhead ⇒ ~1.5s for the handler's downstream call ⇒ ~1s for the query inside it. Each layer's deadline must be SMALLER than its parent's, or the parent's timeout never gets to fire meaningfully first (the default-timeout stack, where every layer silently inherits an OS-level 60–120s, is how hung dependencies become hung REQUESTS). THE TWO KINDS: CONNECT timeouts bound the handshake ("can I reach it at all" — short, a few seconds), READ timeouts bound the exchange after connection ("it answered the phone but says nothing" — your budget number). Node's defaults are terrible teachers here precisely because they are invisible: fetch has none, a raw socket none, mysql2 10s, ioredis whatever you set — the point is you must CHOOSE, per dependency, from its budget. ABORTCONTROLLER is the enforcement mechanism in modern Node — and it is not just a race you win and abandon: handing the signal down lets the dependency CANCEL its own work, which is the difference between "I stopped waiting" and "we both stopped wasting resources". This repo's gRPC bridge sets a real 2s deadline on every invoke (quoted); the reliability demo's breaker enforces 300ms the same way — its slow mode (a dependency that would answer at 800ms) is aborted at the deadline, timer cleared, failure recorded.`,
        },
        {
          kind: 'code',
          id: 'reliability-timeouts:grpc-quote',
          language: 'ts',
          caption:
            'Verbatim — the 2s deadline on every gRPC bridge call (presentation/routes/grpc_demo_routes.ts)',
          source: 'server/src/presentation/routes/grpc_demo_routes.ts',
          code: `/** The invoke deadline: every bridge call carries one, so a hung rpc can't hang the browser tab. */
const BRIDGE_DEADLINE_MS = 2_000;

// …inside the invoke controller:
const outcome = await new Promise<{ error: GrpcClientError | null; response?: unknown }>(
  (resolve) => {
    client.stub[instruction.method](
      instruction.payload,
      { deadline: Date.now() + BRIDGE_DEADLINE_MS }, // ← the budget, enforced by grpc-js
      (error, response) => resolve({ error, response }),
    );
  },
);`,
        },
        {
          kind: 'code',
          id: 'reliability-timeouts:abort-sketch',
          language: 'ts',
          caption:
            'Verbatim — the AbortController pattern: the deadline races the call AND hands cancellation down (raceDeadline, domain/reliability/circuit_breaker.ts — the demo breaker\u2019s 300ms deadline drives it)',
          source: 'server/src/domain/reliability/circuit_breaker.ts',
          code: `/** Races the operation against the deadline; the signal lets it self-cancel. */
private raceDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let handle: unknown;
  if (this.timeoutMs !== undefined) {
    const timeoutMs = this.timeoutMs;
    handle = this.setTimeoutFn(() => controller.abort(), timeoutMs);
  }
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new CircuitTimeoutError(this.timeoutMs as number)),
      { once: true },
    );
  });
  const race = Promise.race([operation(controller.signal), deadline]);
  if (handle === undefined) return race; // no deadline configured — nothing to clean up
  return race.finally(() => this.clearTimeoutFn(handle));
}`,
        },
      ],
    },
    {
      id: 'reliability-retries',
      title: 'Retries done right',
      lead:
        'Only idempotent operations, exponential backoff with jitter, hard caps — because a retry is a bet that failure was transient, and the house collects on bad bets.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-retries:rules',
          body: `RETRY = A BET ON TRANSIENCE. A retry is only correct when (a) the failure might be transient (network blip, brief overload — NOT a 400 you will replay identically) and (b) REPLAYING THE OPERATION IS SAFE — the idempotency section of the HTTP topic is the gate: GET/PUT/DELETE with client-supplied ids are safe to replay; a bare POST that charges a card is not (make it idempotent with a key, or accept at-most-once semantics). Retrying a non-idempotent operation under timeout conditions is the classic double-charge bug: the first call may have SUCCEEDED after your deadline fired. EXPONENTIAL BACKOFF WITH JITTER: wait base × 2^(n−1), plus randomness — the jitter is not decoration, it is the thundering-herd defense (without it every failed job in a burst retries in lockstep at exactly t+1s, t+2s, t+4s and the dependency they all share gets DDOSed by its own clients' politeness). This repo's job queue implements exactly that (quoted) with ±20% jitter. CAPS AND BUDGETS: max attempts (the queue dead-letters after 3 — the DLQ section of the jobs topic), AND a total time budget (retrying forever with a shrinking chance of success just moves the hang into your own retry loop). THE AMPLIFICATION WARNING: N layers that each retry 3× turn ONE failed request into up to 3^N calls at the bottom of the stack — the retry storm. The disciplines: retry at ONE layer (usually the one that owns the user-facing budget), cap attempts per layer, and when the failure rate is HIGH, stop retrying entirely — which is not a retry policy at all, it is the next section.`,
        },
        {
          kind: 'code',
          id: 'reliability-retries:backoff-quote',
          language: 'ts',
          caption:
            'Verbatim — exponential backoff ±20% jitter, already running in this repo (domain/jobs/job_queue.ts)',
          source: 'server/src/domain/jobs/job_queue.ts',
          code: `/**
 * Exponential backoff WITH jitter: attempt n waits base × 2^(n-1), ±20%.
 * The jitter is not decoration — without it every failed job in a burst
 * retries in lockstep and the dependency they all share gets thundering-herded.
 */
private backoffDelayMs(attempt: number): number {
  const raw = this.baseDelayMs * 2 ** (attempt - 1);
  const jitter = raw * JITTER_FRACTION * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(raw + jitter));
}`,
        },
      ],
    },
    {
      id: 'reliability-breakers',
      title: 'Circuit breakers',
      lead:
        'Stop calling what is demonstrably down: the CLOSED → OPEN → HALF_OPEN state machine, and the real one this app runs — quoted and steerable below.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-breakers:state-machine',
          body: `WHY A BREAKER BEATS RETRIES-FOREVER: retries are a bet on TRANSIENT failure; when failure is PERSISTENT (the dependency is down), every retry is load you are pouring onto a dying system and latency you are pouring onto your users. The breaker's insight is to FLIP the default: after enough failures, stop calling at all — reject instantly, locally — and give the dependency the one thing it needs to recover: QUIET. THE STATE MACHINE (three states, honest names): CLOSED is normal operation — calls pass, failures counted (this app's breaker counts CONSECUTIVE failures, threshold 3; production breakers often count a failure RATE over a window instead, which catches the slow-trickle case a consecutive counter keeps resetting — the tradeoff is documented in the code). Threshold reached → OPEN: calls are rejected FAST, in-process, ~0ms, no network, and that is the FEATURE — your latency stops tracking the dependency's outage. After a cooldown → HALF_OPEN: a small number of PROBE calls go through (2 here). All succeed → CLOSED, full traffic resumes; any fails → OPEN again with a FRESH cooldown. The half-open probe budget matters: without it, "recovered?" becomes a stampede of your full traffic the instant the cooldown expires — the very herd the cooldown was protecting against. THE FAILURE COUNTING should match your definition of down: errors, timeouts (slow IS down — this app's 300ms deadline feeds its breaker), and optionally slow-but-successful calls (a "consecutive slow successes" breaker is a real pattern). WHAT REJECTION MEANS FOR CALLERS: a fast 'unavailable' failure your code routes around — serve stale cache, queue for later, degrade the feature — which is why this section is sandwiched between retries and graceful degradation.`,
        },
        {
          kind: 'code',
          id: 'reliability-breakers:breaker-quote',
          language: 'ts',
          caption:
            'Verbatim — the OPEN-circuit rejection from this repo\u2019s real breaker (domain/reliability/circuit_breaker.ts)',
          source: 'server/src/domain/reliability/circuit_breaker.ts',
          code: `if (this.state === 'open') {
  this.totalRejected += 1;
  return fail(this.rejectedFastFailure());
}

// …the failure it builds, one private method at the bottom of the file:
private rejectedFastFailure(): Failure {
  const remaining = this.cooldownRemainingMs();
  return failure(
    'unavailable',
    \`circuit "\${this.name}" is OPEN — rejected fast, the dependency was not called (\${String(remaining)}ms of cooldown left)\`,
    {
      circuit: this.name,
      rejectedFast: true,
      cooldownRemainingMs: remaining,
    },
  );
}

// …and the transition that got here — one method, one ring of history:
//   CLOSED ──3 consecutive failures──▶ OPEN ──cooldown──▶ HALF_OPEN
//      ▲                                                        │
//      └────────── 2 probes succeed ──────────  probe fails ─────┘`,
        },
        {
          kind: 'text',
          id: 'reliability-breakers:real-world',
          body: `IN PRODUCTION you reach for a library (\`opossum\` is the Node standard — this repo hand-rolled its own because the mechanism is the lesson; the API surface is the same shape): options become failure-rate thresholds, rolling windows, per-endpoint breakers, and METRICS. The operational notes that matter once you have them: (1) ONE BREAKER PER DEPENDENCY (a shared breaker lets one bad endpoint open the door for all of them); (2) breakers are a SIGNAL, not just a shield — an open breaker page is someone's pager; (3) choose the cooldown from the dependency's failure mode (a process restart recovers in seconds; a flooded database needs tens); (4) decide what callers DO with a rejection before you deploy — a breaker that turns into a 500 for every request protected nobody. The live demo below makes the whole machine watchable: three failing calls open the circuit, the fourth bounces off it in ~0ms, the cooldown ticks down, healthy probes close it — and a SLOW dependency (800ms against a 300ms deadline) trips it just the same.`,
        },
      ],
    },
    {
      id: 'reliability-degradation',
      title: 'Graceful degradation',
      lead:
        'Feature-shaped failures: when a dependency dies, the PRODUCT gets smaller, not gone. The optional-service pattern this app practices, stale-while-error, and the honest 503.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-degradation:optional-services',
          body: `DEGRADE, DON'T DIE. The question every dependency must answer in advance: WHEN YOU ARE GONE, WHAT AM I? Three honest answers exist. (1) OPTIONAL — the feature shrinks: this app's mongo and redis demos are built exactly this way (the NULL-FAST optional-service pattern, quoted): not configured → resolve null IMMEDIATELY; configured but unreachable → fail fast, resolve null, DON'T cache the failure — the guide keeps serving every other topic, and the demo recovers the moment the service does. (2) DEGRADE TO STALE — serve the last good answer with an apology: the caching topic's cache-aside is the substrate (origin down → the cached entry's TTL becomes a floor, not a ceiling, and the response says so); news feeds, dashboards, and anything read-heavy live here. (3) HONEST UNAVAILABILITY — the feature IS the product, so say no properly: the app's canonical 503 envelope through the one error taxonomy (\`failure('unavailable', …)\` → HTTP 503 with \`service_unavailable\`), which is exactly what the reliability demo's breaker-driven route reports and what the failure-injection flows in the exception-handling topic demonstrate end to end. The ANTI-PATTERN is the fourth answer nobody chose: half-serve with wrong data (serving an empty array where a list of transactions should be is a LIE that composes — downstream code happily renders "you have no transactions"). Degradation is a PRODUCT decision per feature; the engineering job is making the three honest answers cheap to implement, which is what this whole topic's mechanisms are for.`,
        },
        {
          kind: 'code',
          id: 'reliability-degradation:null-fast-quote',
          language: 'ts',
          caption:
            'Verbatim — the null-fast optional-service contract (data/mongo/mongo_client.ts; the redis twin is the same shape)',
          source: 'server/src/data/mongo/mongo_client.ts',
          code: `/**
 * - Not configured (MONGO_URI === ''): resolves null IMMEDIATELY, without
 *   touching mongoose at all — importing this module connects nothing.
 * - Configured but unreachable: the attempt fails fast (serverSelectionTimeoutMS
 *   1500), resolves null (never rejects), and the failed attempt is NOT cached
 *   — the next call retries, so booting \`docker compose up mongo\` after the
 *   server flips the demo on without a restart.
 */`,
        },
      ],
    },
    {
      id: 'reliability-bulkheads',
      title: 'Bulkheads and load shedding',
      lead:
        'Isolate failure the way a ship isolates water: separate pools per dependency, bound every queue, and drop work on purpose before the dropping happens to you.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-bulkheads:isolation',
          body: `BULKHEADS: one compartment flooding must not sink the ship. In a server that means SEPARATE, BOUNDED resource pools per dependency — a dedicated connection pool for the payments API, its own concurrency limit for search, its own queue — so a slow dependency can exhaust ONLY its own compartment and the rest of the product keeps answering (the deployment topic's two-network split is the infrastructure bulkhead of the same idea; per-dependency breakers are its circuit-level twin). THE QUEUE DISCIPLINE: every queue needs a DEPTH LIMIT and a DEAD-LETTER policy — the jobs topic built both in-process (cap 50, dead-letter after max attempts, requeue as a deliberate human act) and the reasoning transfers to any broker: an unbounded queue does not absorb load, it POSTPONES the crash while consuming memory, and when it finally fails it fails all at once. LOAD SHEDDING is choosing what to drop: under overload, shed LOW-PRIORITY work first (analytics beacons, prefetch, batch jobs) so the user-facing path keeps its budget — the breaker's fast rejection is automated shedding; rate limiting (the security topic's limiter) is shedding by client fairness; a 503 with Retry-After is shedding with manners. BACKPRESSURE is the same principle aimed the other direction — a producer that outruns its consumer must WAIT, not buffer: the files topic's drain-aware writer (write → false → await 'drain') is the transport-level pattern, and it is why the jobs queue runs concurrency-1 by design — a worker that can only do one thing at a time refuses to pretend otherwise. All three words — bulkhead, shedding, backpressure — name one discipline: REFUSE work you cannot do well, visibly, at the boundary, instead of accepting it and failing in the middle.`,
        },
      ],
    },
    {
      id: 'reliability-chaos',
      title: 'Chaos, small scale',
      lead:
        'Failure injection as an everyday practice: this app has been doing it all along — scenarioStore, alwaysFail, flaky modes. Prod chaos engineering just scales the same experiment.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-chaos:everyday',
          body: `YOU ALREADY PRACTICE CHAOS ENGINEERING — this app has been injecting failures on purpose since its third topic: the scenario store's \`injectFailure\` toggle (quoted), the job payloads' \`alwaysFail\`/\`forceFailures\` knobs, the error taxonomy's TRY buttons, and now the flaky dependency's three modes. The definition underneath all of them is the real one: introduce a failure you CONTROL, observe whether the system behaves the way you DESIGNED it to (breaker opens? envelope 503s? retries jitter? degradation honest?) — the experiment is only chaos engineering if you have a hypothesis and a way to watch the answer. THE EVERYDAY SCALE (start here): kill a dependency in dev (\`docker compose stop redis\`) and watch the health strip flip honestly; fire the breaker in the demo below and read the ~0ms rejections; force a poison message and watch it dead-letter. PROD-SCALE chaos (Netflix's Chaos Monkey is the mascot) adds: real traffic, real blast radius, and therefore GUARDRAILS — experiments scheduled, scoped to one service at a time, with automatic abort when metrics breach, in an environment where the on-call is watching. The value is the same at both scales, and it is the value this whole topic closes on: a reliability mechanism you have never exercised is a HOPE, not a system — the first time your breaker opens should be in an experiment you chose, not an incident you didn't.`,
        },
        {
          kind: 'code',
          id: 'reliability-chaos:scenario-quote',
          language: 'ts',
          caption:
            'Verbatim — the failure-injection toggle this app has shipped since its earliest topics (core/scenario/scenario.ts)',
          source: 'server/src/core/scenario/scenario.ts',
          code: `export interface ScenarioState {
  readonly dataMode: ScenarioDataMode;   // 'fake' | 'live'
  readonly injectFailure: boolean;       // ← the chaos knob
}

// …flipped at runtime by PATCH /api/demo/scenario, and read by the demo
// pipelines so EVERY failure mode (Result-path 503s, thrown envelopes,
// gRPC UNAVAILABLE, graphql extensions) is exercisable on demand.`,
        },
      ],
    },
    {
      id: 'reliability-races',
      title: 'Race conditions and check-then-act',
      lead:
        'The bug that survives a single-threaded runtime: check some state, await something, act on the state you checked — the await yields the event loop, a sibling request re-checks the same stale world, and both act. TOCTOU (time-of-check to time-of-use) is not a threads problem; it is an interleaving problem, and every await is an interleaving point.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-races:toctou',
          body: `SINGLE-THREADED DOES NOT MEAN RACE-FREE, and the reason is one sentence long: the event loop interleaves at every await. Node never runs two statements of yours in parallel — but between your CHECK (SELECT the stock, read the counter, query the dupe) and your USE (UPDATE, INCREMENT, INSERT), an await hands the loop to whoever else is ready, and "whoever else" includes the second copy of this very handler serving a concurrent request. Both requests then act on the SAME stale observation: the last ticket sold twice, the counter undercounted, the uniqueness check passed by both and violated by one. This is the reliability topic's version of a distributed-systems truth — you cannot assume the world held still between your read and your write — compressed into one process. THE SAFETY NET THE DATABASE ALREADY IS: for state whose invariant is uniqueness, the UNIQUE CONSTRAINT is the race-proof backstop, because the check IS the index write — two processes can race past an application-level "does this name exist?" check (this guide's tags.name is UNIQUE for exactly this reason, the schema topic's argument), but they cannot race past the index: exactly one INSERT succeeds, the loser gets a constraint violation it must map (the app's typed conflict failure), and no amount of interleaving breaks it. THE ATOMIC GUARDED UPDATE generalizes that move to numeric invariants: instead of check-then-decrement, make the guard PART of the write — UPDATE … SET stock = stock - 1 WHERE item = ? AND stock > 0 — one statement, indivisible, and the loser observes changes === 0 and reports a clean conflict instead of corrupting the state (optimistic concurrency: no locks, the write detects the conflict, retry or refuse). When several rows must agree, the unit grows to a TRANSACTION (BEGIN IMMEDIATE in SQLite takes the write lock before you read — the SQL with Node topic's isolation section builds that ladder). THIS APP MAKES IT WATCHABLE: the booking exhibit runs both implementations of "book the last ticket" — the naive one with a real ~50ms await between its read and its write (any async work yields the loop — that is the whole lesson), and the guarded one — and the SQL with Node topic's db:race demo (its Isolation levels, locking, and check-then-act section) drives them over HTTP: naive oversells below zero under concurrency, the guard answers clean 409s, same load. The rule to carry into every handler you write: name the invariant, then ask WHERE it is enforced — in your code (raceable across an await) or in the statement/constraint/transaction the database makes indivisible. If the answer is "in my code, between two awaits", you have found tomorrow's incident.`,
        },
        {
          kind: 'code',
          id: 'reliability-races:verbatim-booking',
          language: 'ts',
          source: 'server/src/data/sql_depth/inventory_booking.ts',
          caption:
            'Verbatim — the exhibit\'s own summary plus the three statements (data/sql_depth/inventory_booking.ts): the await is the window, the guard is the fix',
          code: ` * naive — check, then act, with real work in between:
 *   SELECT the stock, await a ~50ms delay (any async work yields the event
 *   loop — that is the whole lesson), then UPDATE stock = stock - 1 guarded
 *   by NOTHING. Two concurrent calls both read the same stock and both write,
 *   overselling below zero.
 *
 * safe — the guard lives in the write itself:
 *   ONE statement, UPDATE ... SET stock = stock - 1 WHERE item = ? AND
 *   stock > 0. SQLite serializes writers, so exactly one attempt can match
 *   the row while stock is still positive; the loser sees changes === 0 and
 *   reports a clean conflict (409) instead of a negative shelf.

export const SELECT_STOCK_SQL = 'SELECT stock FROM inventory WHERE item = ?';
export const NAIVE_DECREMENT_SQL = 'UPDATE inventory SET stock = stock - 1 WHERE item = ?';
export const SAFE_DECREMENT_SQL =
  'UPDATE inventory SET stock = stock - 1 WHERE item = ? AND stock > 0';`,
        },
      ],
    },
    {
      id: 'reliability-see-it-live',
      title: 'See it live',
      lead:
        'The watchable breaker: a real CircuitBreaker around a flaky dependency you steer — trip it, bounce off it, let it heal, all in ~0ms where it matters.',
      blocks: [
        {
          kind: 'text',
          id: 'reliability-see-it-live:what-you-see',
          body: `THE DEMO is the whole topic in two minutes of clicking. The dependency has three modes: healthy (answers in ~50ms), failing (errors after ~50ms), and slow (would answer at 800ms — past the breaker's 300ms deadline, so it counts as a failure: timeouts trip breakers). Set the mode to failing and CALL three times — the state badge flips to OPEN and the transition lands in the timeline. Call again: REJECTED-FAST, in ~0 milliseconds, the dependency never touched — the load-shedding moment, visible as a number. Watch the cooldown count down; when it lapses the breaker half-opens, and with the mode back to healthy, two successful probes close it. Trip it with slow mode if you want the timeout path. The breaker KEEPS its state across mode switches on purpose — that is what makes the heal story real. Or script it from a terminal:`,
        },
        {
          kind: 'code',
          id: 'reliability-see-it-live:curl',
          language: 'bash',
          caption: 'The breaker lifecycle over curl — trip, reject, heal',
          code: `# the state machine: 3 failing calls open the circuit
curl -s -X POST localhost:4000/api/demo/reliability/mode \\
  -H 'content-type: application/json' -d '{"mode":"failing"}' > /dev/null
for i in 1 2 3; do \\
  curl -s -X POST localhost:4000/api/demo/reliability/call | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["outcome"], d["breakerState"], d["ms"])'; \\
done

# the 4th: rejected-fast, ~0ms, the dependency never touched
curl -s -X POST localhost:4000/api/demo/reliability/call | python3 -m json.tool

# the slow path: an 800ms dependency vs a 300ms deadline
curl -s -X POST localhost:4000/api/demo/reliability/mode \\
  -H 'content-type: application/json' -d '{"mode":"slow"}' > /dev/null
curl -s -X POST localhost:4000/api/demo/reliability/call | python3 -m json.tool

# the timeline + the cooldown, then reset and heal
curl -s localhost:4000/api/demo/reliability/status | python3 -m json.tool
curl -s -X POST localhost:4000/api/demo/reliability/reset > /dev/null`,
        },
        {
          kind: 'demo',
          id: 'reliability-see-it-live:demo',
          demoId: 'reliability:breaker',
          title: 'The watchable circuit breaker',
          description:
            'A real circuit breaker around a steerable flaky dependency: trip it with failures, watch calls bounce off the open circuit in ~0ms, ride out the cooldown countdown, and heal it through half-open probes — with the state-transition timeline alongside.',
        },
      ],
    },
  ],
};
