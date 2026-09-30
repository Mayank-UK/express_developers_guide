import type { Topic } from '../types.js';

/**
 * The Advanced Architecture topic — the canon's "after the capstone" block:
 * DDD vocabulary, monolith-vs-microservices, sagas, CQRS, and event sourcing,
 * each named honestly against what THIS small repo does versus what large
 * systems need. The two live exhibits are real: domain/patterns/event_store.ts
 * and domain/patterns/order_saga.ts were built for this screen, and every
 * code block below is quoted from this repository (paths in the captions).
 */
export const topicAdvancedArchitecture: Topic = {
  id: 'advanced-architecture',
  title: 'Advanced Architecture',
  subtitle:
    'DDD vocabulary, service boundaries, sagas, CQRS, and event sourcing — the patterns past the monolith, on this repo\u2019s real running exhibits.',
  group: 'platform',
  order: 14,
  sections: [
    {
      id: 'advanced-architecture:the-map',
      title: 'The map: consistency before patterns',
      lead:
        'Every pattern in this topic trades consistency for something — scale, autonomy, uptime. Name the trade (CAP, consistency models, eventual consistency) before the patterns that price it.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:the-map:cap',
          body: `CAP, STATED PLAINLY: a distributed data system can guarantee at most two of Consistency (every read sees the latest write, everywhere), Availability (every request receives a response), and Partition tolerance (the system keeps operating when the network between nodes fails). The choice is forced, not stylistic — network partitions ARE going to happen, so partition tolerance is not optional; during one, you refuse answers (consistency) or answer possibly-stale data (availability). Most business systems pick AP-with-tuning: available through partitions, converging after. CONSISTENCY MODELS are the dial underneath that choice: STRONG (linearizable — the system acts as if there were one copy; a read after a completed write returns it), READ-YOUR-OWN-WRITES (your writes are visible to you immediately, maybe not yet to others — the session-level compromise most user-facing systems ship), and EVENTUAL consistency: replicas may disagree for a window, but if writes stop, all replicas converge on the same state. Note what "eventual" does NOT promise — no deadline, only a direction. And it is never just a backend decision: it surfaces in the UI (stale lists, optimistic-concurrency rejections, "processing…" states) — where the CQRS section returns to. WHAT THIS REPOSITORY IS, in the canon's own words: a MODULAR MONOLITH — one deployable process — organized by CLEAN / HEXAGONAL architecture, also called PORTS-AND-ADAPTERS. The Architecture topic taught the layering (presentation → domain ← data, domain-owned ports); hexagonal is the same picture from above — the domain at the center, every technology (HTTP, sqlite, redis, the queue) an interchangeable adapter on the rim. This topic builds on those layers rather than re-teaching them: every pattern here is a way of drawing boundaries, and you have practiced drawing them in the small.`,
        },
      ],
    },
    {
      id: 'advanced-architecture:ddd',
      title: 'The DDD vocabulary',
      lead:
        'Entities, value objects, aggregates, domain events, bounded contexts, anti-corruption layers — tactical Domain-Driven Design, mapped onto code you have already read in this repo.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:ddd:entities-and-values',
          body: `ENTITIES VS VALUE OBJECTS — the first cut of any domain model. An ENTITY is an object whose IDENTITY matters: it has an id, a lifecycle, and mutable-ish state, and two instances with the same attributes but different ids are DIFFERENT things. A VALUE OBJECT is the opposite: defined entirely by its ATTRIBUTES, no identity, immutable — two instances with equal attributes are interchangeable, so "5 dollars" equals every other "5 dollars" and nothing about it changes. The distinction decides equality, caching, and mutation discipline. The quote below is this repo's own Post — an entity, and a deliberately pragmatic one: identity by UUID, timestamps as ISO strings, every field readonly. THE HONEST READING of that file is the lesson: Post has NO value objects — title and body are bare strings. A full DDD treatment would wrap them (a PostTitle with its length rule), and this repo CHOSE NOT TO: at this size a wrapper around one string is ceremony without payoff — the length check lives in the entity module ITSELF (validatePostDraft, right below the quoted interface), so the entity owns its invariants without the per-field ceremony. Reach for value objects when a concept accrues RULES (money arithmetic, date ranges — the moment "two fields must agree" appears), not to make a diagram look architectural; when the rules do accrue, they centralize invariants and eliminate the "which string is this?" bugs the compiler cannot see.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:ddd:verbatim-post',
          language: 'ts',
          caption: 'Verbatim — the entity\u2019s data shape (domain/posts/post.ts): identity by id, no value objects, deliberately — the invariants live in the same file (validatePostDraft), not in a wrapper per field',
          source: 'server/src/domain/posts/post.ts',
          code: `/**
 * The Post entity — the domain's own shape. Timestamps are ISO strings (the
 * storage-friendly JSON representation) and ids are UUIDs minted by whichever
 * repository implementation persists a post.
 */
export interface Post {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}`,
        },
        {
          kind: 'text',
          id: 'advanced-architecture:ddd:aggregates-and-the-rest',
          body: `AGGREGATES — the consistency boundary. An aggregate is a cluster of objects written as ONE unit: it has a ROOT (the thing outsiders reference), and the ROOT enforces the aggregate's INVARIANTS — rules that must hold after every write; nothing outside may bypass it. This repo's sharpest aggregate is the event store's Account (two sections down): its invariant is "the balance never goes negative", enforced AT THE BOUNDARY — the append() gate folds the whole history plus incoming events and refuses an append that would overdraw. In a database-first design that invariant is a CHECK constraint; aggregate-first puts the check with the behavior it governs — which is the point. DOMAIN EVENTS — facts in the past tense ('money-deposited', not 'deposit'): immutable once recorded, carrying what happened rather than what should happen (those are commands). The event union is quoted below — four past-tense facts, including the subtle one: 'withdrawal-rejected' records that a withdrawal was ATTEMPTED and refused, because the attempt is history too. UBIQUITOUS LANGUAGE — the cheapest, highest-leverage DDD practice: the code speaks the domain's words (withdraw, deposit, overdraft), so code, commits, and humans share one vocabulary and translation bugs (where "settle" means one thing to the code and another to the business) cannot start. BOUNDED CONTEXTS — one word means different things in different parts of the system: this repo's domain/posts and domain/auth keep entirely separate models (a Post means nothing to authentication), and neither imports the other. At monolith scale contexts are module boundaries; at microservice scale, service boundaries — which is why the canon says learn this vocabulary FIRST. ANTI-CORRUPTION LAYERS — the defensive translation between YOUR model and someone else's: a foreign shape (a third-party payload, legacy records) becomes your own domain shapes AT THE EDGE, so its quirks cannot leak inward — the Architecture topic's DTO boundary and the Third-Party Services topic's email adapter are the small-scale versions. THE HONEST SUMMARY: full DDD ceremony — aggregate repositories, event buses, per-context glossaries — would be OVERKILL at this size, and the guide does not pretend otherwise; the exhibits exist to teach the vocabulary on running code, not to argue this app needed them.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:ddd:verbatim-events',
          language: 'ts',
          caption: 'Verbatim — the aggregate\u2019s events as a discriminated union of past-tense facts (domain/patterns/event_store.ts)',
          source: 'server/src/domain/patterns/event_store.ts',
          code: `export type AccountEventData =
  | { readonly type: 'account-opened'; readonly owner: string }
  | { readonly type: 'money-deposited'; readonly amountCents: number }
  | { readonly type: 'money-withdrawn'; readonly amountCents: number }
  | {
      readonly type: 'withdrawal-rejected';
      readonly amountCents: number;
      readonly reason: string;
    };`,
        },
      ],
    },
    {
      id: 'advanced-architecture:split',
      title: 'Monolith first, split on evidence',
      lead:
        'A modular monolith is a starting strategy, not a compromise. Split when a specific force demands it — and learn the distributed monolith, the anti-pattern you get when you split without one.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:split:when',
          body: `WHAT A MODULAR MONOLITH BUYS YOU: one process, one deploy, one database to back up — with boundaries that are REAL but cheap. This repo is the shape: modules under domain/ own their models, the DI container wires them, and boundaries are enforced by imports rather than network hops. Everything the advanced patterns promise — clear ownership, independent change, swappable implementations — already exists here at process scale; the ports-and-adapters seam is where a future split would be cut. WHEN TO ACTUALLY SPLIT, in order of legitimacy: (1) INDEPENDENT SCALING — one component needs 40 instances and the rest need two (the Scaling topic's reasoning applies per-service instead of per-app); if everything scales together, splitting buys nothing. (2) DATA OWNERSHIP — one component needs a fundamentally different store (a graph or time-series engine with its own consistency needs), and the cleanest way to own data exclusively is to own it in a service. (3) TEAM TOPOLOGY — Conway's law is not optional: architecture mirrors communication structure, so when five teams step on one deploy pipeline, a boundary that lets each ship independently is worth its operational price. WHEN NOT TO SPLIT: when the BOUNDARIES ARE UNCLEAR — a service boundary in the wrong place is the most expensive mistake in this topic, because every later refactor crosses the network (one boundary's data gets smeared across two, and joins become integration code); when the TEAM IS SMALL (you add pager duty, deployment orchestration, and network failure modes to a staffing level that cannot absorb them — the Deployment topic's single-compose-file setup is the counter-example live in this repo); and when you cannot yet NAME the boundaries confidently — the modular monolith is where you learn them cheaply, at the cost of an import change. THE DISTRIBUTED MONOLITH — the anti-pattern with a name, earned when services are split but COUPLING is not: services that must deploy together (every contract change is a coordinated release), services that SHARE A DATABASE (the boundary everyone can see and no one can enforce — one schema change breaks three services), and chains of synchronous calls where one internal refactor still touches everything, now through latency and partial failure. You pay the full distributed tax — network reliability, tracing, eventual consistency — and keep the monolith's rigidity: strictly worse than either honest choice. The guard once you have split: each service deploys alone, owns its data alone, and talks through contracts designed to change independently — the three properties the distributed monolith quietly gives up.`,
        },
      ],
    },
    {
      id: 'advanced-architecture:communication',
      title: 'Talking between services',
      lead:
        'Synchronous calls couple services in time; asynchronous events couple them only in causality. Gateways and discovery are the plumbing that makes either livable.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:communication:sync-async',
          body: `SYNCHRONOUS — the caller waits: HTTP for broadest reach, gRPC for internal service-to-service calls with contracts and deadlines (the gRPC topic taught that wire from this repo's own bridge). Sync's virtue is SIMPLICITY: the answer or the failure arrives now, in this stack trace. Its costs: the caller's latency budget now includes the callee's (a chain adds latencies AND multiplies failure modes), and a slow callee takes callers down with it — which is where the Reliability Patterns topic's toolkit (deadlines, retries with jitter, circuit breakers) earns its keep. ASYNCHRONOUS — the sender emits an event and MOVES ON; a consumer processes it later. The coupling drops from "I need your answer" to "this happened" — senders do not know consumers, consumers can be added without touching senders, and bursts get absorbed by queues instead of propagating. The costs move instead of disappearing: delivery is at-least-once in practice (consumers must be idempotent), ordering across partitions is usually NOT guaranteed, and the consistency becomes eventual — the caller who "completed" an order has not yet confirmed anything downstream. This repo's asynchronous spine is the Background Jobs topic's queue — and the saga you will meet next deliberately RIDES it, step identity living in the job payload, exactly as production sagas behave. API GATEWAY — the single entry point in front of your services: TLS termination, routing, authentication offloaded once instead of per-service, rate limiting, sometimes response shaping per client. Useful at scale; DANGEROUS as an accreting surface — the moment business logic ("apply regional pricing") sneaks into the gateway, it becomes the shared god-service every team deploys through: a distributed monolith with better marketing. At this repo's scale the Express app plays the role honestly — one front door, middleware once, ~40 routers behind it. SERVICE DISCOVERY — how a caller finds a healthy instance of another service. At small scale: DNS and a load balancer, full stop. At platform scale: the registry (Kubernetes Services, Consul) plus health checks that evict dead instances — awareness, not something to hand-roll. Even as a monolith this repo models the rule that makes discovery work: HEALTH ENDPOINTS that tell the truth (the Reliability topic's graceful degradation), because discovery is only as good as the liveness signal beneath it.`,
        },
      ],
    },
    {
      id: 'advanced-architecture:sagas',
      title: 'Sagas: transactions across boundaries',
      lead:
        'Without a shared database there is no rollback — a saga sequences local transactions and undoes them with compensations. The hard design decision is when failure counts as final.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:sagas:no-2pc',
          body: `WHY NOT JUST USE A TRANSACTION: atomicity rests on locks and a log INSIDE one database. Span services and the options collapse — two-phase commit holds locks across the network while participants vote: one slow participant degrades everyone, one lost participant blocks everything; at internet scale, distributed transactions are effectively retired. THE SAGA replaces one big transaction with a SEQUENCE OF LOCAL ones: each step commits its own store, and if a later step fails, earlier steps are undone by COMPENSATIONS — business-level reversals (refund the card, release the stock), not database rollbacks. Two shapes: CHOREOGRAPHY (each service reacts to the previous one's events; no coordinator, but the flow's shape lives implicitly across services and gets hard to see at five-plus steps) and ORCHESTRATION (a manager explicitly drives the steps and the recovery; the flow is readable in one place, at the cost of a central brain). This repo's exhibit is an ORCHESTRATION, and it is honest infrastructure all the way down: the SagaManager's steps are real jobs on the Background Jobs queue — FIFO pickup, retries with backoff and jitter, and the dead-letter verdict — so the step lifecycle you watch in the demo is the queue's real semantics, not a simulation. The quoted constants are the story's skeleton: four forward steps, each with its named undo.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:sagas:verbatim-steps',
          language: 'ts',
          caption: 'Verbatim — the forward steps, their compensations, and the step log the UI renders (domain/patterns/order_saga.ts)',
          source: 'server/src/domain/patterns/order_saga.ts',
          code: `export const SAGA_FORWARD_STEPS = ['place-order', 'reserve-stock', 'charge-card', 'ship'] as const;
export type SagaForwardStep = (typeof SAGA_FORWARD_STEPS)[number];

/** The undo for each forward step — run in reverse order on failure. */
export const SAGA_COMPENSATIONS: Readonly<Record<SagaForwardStep, string>> = {
  'place-order': 'cancel-order',
  'reserve-stock': 'release-stock',
  'charge-card': 'refund-card',
  ship: 'cancel-shipment',
};

// …state + step-status unions elided…

export interface SagaStepRecord {
  readonly step: string;
  readonly kind: 'forward' | 'compensation';
  /** The queue job that executed it (absent for skipped steps). */
  jobId?: string;
  status: SagaStepStatus;
  /** Queue attempts consumed (0 for skipped). */
  attempts: number;
  readonly at: string;
}`,
        },
        {
          kind: 'text',
          id: 'advanced-architecture:sagas:verdict-rule',
          body: `THE LOAD-BEARING DECISION — WHEN IS A STEP "FAILED"? This saga's answer is deliberate: a failing step is retried BY THE QUEUE first (3 total attempts, exponential backoff with jitter — transience is the queue's job to absorb), and compensation begins ONLY when the queue returns its final dead-letter verdict. The rule generalizes: COMPENSATE ON FINAL FAILURE, NEVER ON FIRST ERROR — a saga that unwinds on every hiccup undoes work that was half a second from succeeding, and under flakiness it thrashes: do, undo, do, undo. The quoted header states it in the code's own words. THE UNWINDING SEMANTICS are equally deliberate, and both halves matter: compensations run in REVERSE over every ATTEMPTED forward step — INCLUDING the failed one, because "failed" means FAILED-TO-CONFIRM: the card charge may have landed even if its confirmation never came, so refund-card must run regardless. And compensations are IDEMPOTENT BY CONTRACT — release-stock on never-reserved stock is a no-op; a second refund finds nothing to refund — because at-least-once delivery makes "exactly once" a myth you design around, not a guarantee you receive. Compensations are never failure-injected in this exhibit and, in a real system, retry until they SUCCEED: a saga stuck half-compensated is strictly worse than the original failure — money moved, stock gone, no order — where production systems page a human (the exhibit marks its step log 'failed' loudly instead). Steps after the broken one are 'skipped' — never run, never compensated — and every step lands in the step log with its status and attempt count, which is the progress record the live demo polls.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:sagas:verbatim-compensate',
          language: 'ts',
          caption: 'Verbatim — the deliberate verdict rule (the file\u2019s header) and the reverse unwind it triggers (domain/patterns/order_saga.ts)',
          source: 'server/src/domain/patterns/order_saga.ts',
          code: ` * THE JOB-QUEUE INTERPLAY DECISION (deliberate, and load-bearing):
 * a failing forward step IS retried by the queue before the saga gives up —
 * 3 total attempts with ~300ms/~600ms backoff (demo defaults, ±20% jitter).
 * Transient failures are the queue's to absorb; compensation begins ONLY when
 * the queue returns its final verdict (status 'dead', i.e. dead-lettered).
 * That both bounds the wait (≤ ~2s per failing step at demo timing) and
 * matches the real-world rule: compensate on FINAL failure, never on first
 * error — a saga that compensates on every hiccup undoes work that was about
 * to succeed.

// …

  /**
   * Undoes every ATTEMPTED forward step, in reverse — including the failed
   * one (failed-to-confirm is not did-not-happen). Compensations are jobs
   * too, so they get the queue's retries; they are never failure-injected.
   */
  private async compensate(saga: OrderSaga): Promise<void> {
    const attempted = saga.steps.filter(
      (record) => record.kind === 'forward' && record.status !== 'skipped',
    );
    for (const forward of [...attempted].reverse()) {
      const compensationName = SAGA_COMPENSATIONS[forward.step as SagaForwardStep];
      const record: SagaStepRecord = {
        step: compensationName,
        kind: 'compensation',
        status: 'attempted',
        attempts: 0,
        at: this.isoNow(),
      };
      saga.steps.push(record);
      const outcome = await this.runStepJob(
        saga,
        \`\${compensationName} (undoes \${forward.step})\`,
        record,
        false, // compensations never fail on purpose — see the header
      );
      record.status = outcome === 'succeeded' ? 'compensated' : 'dead-lettered';
      if (outcome !== 'succeeded') {
        // A compensation that dead-letters leaves the saga half-undone — the
        // loudest state a saga has. Real systems page a human here.
        saga.state = 'failed';
        saga.lastError = \`compensation "\${compensationName}" could not complete\`;
      }
    }
  }`,
        },
      ],
    },
    {
      id: 'advanced-architecture:cqrs',
      title: 'CQRS and the read/write split',
      lead:
        'One model to change the world, another to display it — and the honesty that the split\'s real cost lands in the UI, as eventual consistency.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:cqrs:models',
          body: `THE PATTERN: COMMANDS and QUERIES want different shapes. A write must be VALIDATED against invariants and kept small and auditable; a read wants whatever the screen displays — denormalized, pre-joined, sorted, paginated — and validating a list view is meaningless. CQRS (Command Query Responsibility Segregation) formalizes the split: a WRITE MODEL that accepts commands and enforces the rules, and one or more READ MODELS — PROJECTIONS — shaped per query, derived FROM the write model rather than shared with it. The test that separates a real projection from an accident: REBUILDABILITY. Throw the read model away — can you re-derive it? If not, it is not a projection but a second source of truth, which is a bug wearing architecture's clothes. The quote below is this repo's event store making that test into an API: project() discards the derived history and re-derives it from every stream's events in global order — and the rebuild counter in the demo's stats is that test run live, on demand. WHAT CQRS IS NOT: it is not event sourcing (you can split read/write models over ordinary tables — read replicas are the boring, widespread version), and it is not a license to skip normalization in the write model. It is a RECOGNITION that the two sides optimize differently, worth paying for when they genuinely diverge — many screens, read shapes far from the write shape, scaling the two apart.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:cqrs:verbatim-project',
          language: 'ts',
          caption: 'Verbatim — the rebuildability test as an API: throw the read model away, re-derive it (domain/patterns/event_store.ts)',
          source: 'server/src/domain/patterns/event_store.ts',
          code: `  /**
   * CQRS's other half, on demand: throw the read model away and DERIVE it
   * again from the write model (every stream's events, in global append
   * order). A "projection" that cannot be rebuilt from the events is not a
   * projection — it is a second source of truth, which is a bug.
   */
  project(): { rebuilt: readonly TransactionEntry[]; stats: ProjectionStats } {
    const allEvents = [...this.streams.values()]
      .flatMap((record) => record.events.map((event) => ({ streamId: record.streamId, event })))
      .sort((a, b) => a.event.globalSeq - b.event.globalSeq);
    const rebuilt = projectTransactionHistory(allEvents);
    this.projectionEntries = [...rebuilt];
    // The rebuild re-derives the running balances too — the incremental path
    // and the from-scratch path must stay interchangeable.
    this.projectionBalances.clear();
    for (const entry of rebuilt) this.projectionBalances.set(entry.streamId, entry.balanceAfterCents);
    this.projectionRebuilds += 1;
    this.projectionLastRebuiltAt = new Date().toISOString();
    return { rebuilt: this.projectionEntries, stats: this.projectionStats() };
  }`,
        },
        {
          kind: 'text',
          id: 'advanced-architecture:cqrs:eventual-consistency-ui',
          body: `THE UI PAYS THE INTEREST. Once reads are derived, they LAG writes — maybe milliseconds (an in-process update, like this exhibit), maybe hundreds of milliseconds (a projection worker across a process boundary). The design consequences, none optional: STALE READS are normal — the screen you render after a write may not yet include it, so the UI either renders from the WRITE'S OWN RESPONSE (the append result already carries the new state; trust it), polls until it catches up, or shows the honest "processing" state — the worst move is the lie of empty: an empty list where a list-plus-one should be tells the user their data is GONE. VERSION FIELDS turn lag into safety: this exhibit's expectedVersion is optimistic concurrency for the read side too — the client states the version it SAW, the store rejects appends built on stale state (the 409 in the demo), which is how you keep two users from overwriting each other through a lagging view. And ORDER is designed, not assumed: entries appear in append order here because the projection replays by global sequence — across real infrastructure you build ordering (single-partition streams, sequence numbers). THIS REPO'S HONEST POSITION: the posts slice uses ONE model for reads and writes — correct at its size, and the default you should need reasons to leave. The natural CQRS already shipping here is the guide itself: the WRITE side is these topic files; the READ side is the typed JSON the content API serves — a read-optimized projection of the source tree, rebuilt on deploy, never mutated by readers. The event store is the full pattern in miniature.`,
        },
      ],
    },
    {
      id: 'advanced-architecture:event-sourcing',
      title: 'Event sourcing (handle with care)',
      lead:
        'The canon saves this for last and calls it the most expensive pattern and the most often misapplied. Start with the reasons not to; the mechanics are seductive and that is exactly the trap.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:event-sourcing:warning',
          body: `START WITH NO. Event sourcing means: the EVENTS are the system of record, and current state is always DERIVED from them — nothing else is stored. Count the costs before finding it elegant. You give up ad-hoc reads: "accounts with balance over X" cannot be answered without folding streams or maintaining projections for every query — needs you discover after shipping. You take on SCHEMA EVOLUTION FOREVER: events written two years ago must still be readable, so every event-type change means versioning or upcasting old events (transformers from old shapes to new, run at read time) — and it never ends, because immutable facts cannot be edited retroactively without becoming lies. You take on operational surface: an event store to run (or build carefully on Postgres/Kafka), replay infrastructure, snapshot management, and debugging where nothing is inspectable without tooling that folds. ADOPT IT WHEN those costs buy something you actually need: a complete AUDIT TRAIL (regulatory, financial), TEMPORAL queries ("the balance as of March"), EVENT REPLAY into new projections whenever the business dreams up a new view, and recovery narratives where "rebuild the read model" fixes projection bugs wholesale. If none of those is on your list, a table with good constraints and a backup is the correct technology, full stop — this guide stores posts in sqlite precisely because posts need none of it. The exhibit exists so you learn the mechanics on running code before meeting them in a system that bet on them — the same reason the saga rides a real queue.`,
        },
        {
          kind: 'text',
          id: 'advanced-architecture:event-sourcing:mechanics',
          body: `THE MECHANICS, in the exhibit's order. THE FOLD is the whole idea compressed: state is a PURE function of events — same events in, same state out, no side effects, no clock. The aggregate is never stored; every read re-derives it. Replay "working" is what a pure fold IS. THE APPEND GATE is where an event store differs from a log: the writer states the version it believes (OPTIMISTIC CONCURRENCY — if another writer moved the stream, the append is rejected with a typed conflict and the loser reloads and retries; no locks anywhere), and the DOMAIN INVARIANT runs at append time, against the fold of history plus the incoming events — with events about to become immutable facts, the only safe moment to enforce "balance never goes negative" is BEFORE storing. A rejected append writes NOTHING; the overdraft refusal in the demo then records ITSELF as a withdrawal-rejected event. SNAPSHOTS answer long histories: every few events, persist the fold; loads then fold snapshot + TAIL — O(tail) instead of O(history). The trap is a snapshot silently disagreeing with the full replay, so the exhibit computes BOTH folds on every snapshot load and reports 'consistent' — a wrong snapshot is corruption you would otherwise never see. THE PROJECTION is the CQRS section's read model, updated incrementally on append and rebuildable from scratch. And SCHEMA EVOLUTION — already named as the permanent tax — is the one dimension the exhibit deliberately keeps at one schema, because a teaching store that versions its own events would teach versioning instead of sourcing.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:event-sourcing:verbatim-fold',
          language: 'ts',
          caption: 'Verbatim — the fold: events → aggregate, purely; replay IS this function (domain/patterns/event_store.ts)',
          source: 'server/src/domain/patterns/event_store.ts',
          code: `/**
 * Events → aggregate, purely. No input mutation, no side effects, no clock:
 * the same events always fold to the same state — which is exactly why
 * replay works, and why a snapshot must reproduce it. withdrawal-rejected
 * events are history; they change nothing about the balance.
 */
export function foldAccount(events: readonly AccountEventData[]): AccountFold {
  let fold = EMPTY_FOLD;
  for (const event of events) {
    switch (event.type) {
      case 'account-opened':
        fold = { opened: true, owner: event.owner, balanceCents: 0 };
        break;
      case 'money-deposited':
        fold = { ...fold, balanceCents: fold.balanceCents + event.amountCents };
        break;
      case 'money-withdrawn':
        fold = { ...fold, balanceCents: fold.balanceCents - event.amountCents };
        break;
      case 'withdrawal-rejected':
        break; // the attempt left the balance untouched
    }
  }
  return fold;
}`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:event-sourcing:verbatim-append',
          language: 'ts',
          caption: 'Verbatim — the append gates: optimistic concurrency, then the invariant against the fold (domain/patterns/event_store.ts; shape gate and details elided)',
          source: 'server/src/domain/patterns/event_store.ts',
          code: `  /**
   * The write side. Three gates, in order:
   *   1. optimistic concurrency — expectedVersion must equal the current
   *      version (-1 while the stream is empty, so "must be new" is just
   *      expectedVersion -1);
   *   2. shape — every stream must BEGIN with account-opened, exactly once;
   *   3. the domain invariant — folding history + incoming events may never
   *      drive the balance negative.
   * A rejected append writes NOTHING: events are immutable, so there is no
   * "undo" — the only safe moment to enforce an invariant is before storing.
   */
  append(
    streamId: string,
    events: readonly AccountEventData[],
    expectedVersion: number,
  ): Result<AppendResult, Failure> {
    if (events.length === 0) {
      return fail(failure('validation', 'append requires at least one event', { streamId }));
    }
    const record = this.streams.get(streamId);
    const currentVersion = record === undefined ? -1 : record.events.length - 1;

    if (expectedVersion !== currentVersion) {
      return fail(
        failure(
          'conflict',
          \`optimistic-concurrency conflict on "\${streamId}": expected version \${String(expectedVersion)} but the stream is at \${String(currentVersion)} — someone appended first; reload and retry\`,
          { streamId, expectedVersion, actualVersion: currentVersion },
        ),
      );
    }

    // Validate the WHOLE resulting history — stored events + incoming ones.
    const resultingEvents: readonly AccountEventData[] = [
      ...(record?.events ?? []).map((event) => event.data),
      ...events,
    ];

    // …shape gate (account-opened first, exactly once) elided…

    // The invariant, at append time, against the fold of the whole history.
    let running = 0;
    for (const event of resultingEvents) {
      if (event.type === 'money-deposited') running += event.amountCents;
      if (event.type === 'money-withdrawn') running -= event.amountCents;
      if (running < 0) {
        const balanceBefore =
          event.type === 'money-withdrawn' ? running + event.amountCents : running;
        const attemptedChangeCents = // …the signed amount, elided…
        return fail(
          failure(
            'conflict',
            'domain invariant rejected the append: this event would overdraw the account (the balance cannot go negative)',
            // …details (invariant, balances) elided…
          ),
        );
      }
    }`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:event-sourcing:verbatim-snapshot',
          language: 'ts',
          caption: 'Verbatim — snapshot minting on append, and the snapshot + tail load that verifies itself (domain/patterns/event_store.ts)',
          source: 'server/src/domain/patterns/event_store.ts',
          code: `    // Snapshot when this append lands ON a SNAPSHOT_EVERY boundary (version
    // 5, 10, …): replay after that folds the snapshot + tail, not history.
    const newVersion = target.events.length - 1;
    let snapshot: StreamSnapshot | null = null;
    if (newVersion > 0 && newVersion % SNAPSHOT_EVERY === 0) {
      snapshot = {
        streamId,
        version: newVersion,
        balanceCents: foldAccount(target.events.map((event) => event.data)).balanceCents,
        createdAt: at,
      };
      target.snapshot = snapshot;
    }

// …

  /**
   * The read side. Folds snapshot + tail when a snapshot exists — the
   * shortcut that keeps replay O(tail) instead of O(history) — and computes
   * the full-history fold TOO, reporting \`consistent\` so a lying snapshot can
   * never hide. An unknown stream is version -1 with no events (the caller
   * decides whether that is a 404).
   */
  loadStream(streamId: string): LoadResult {
    // …the unknown-stream and no-snapshot paths elided…
    const events = [...record.events];
    const total = events.length;
    const snapshot = record.snapshot;
    if (snapshot !== null && snapshot.version < total) {
      const tail = events.filter((event) => event.seq > snapshot.version);
      const fromSnapshot = snapshot.balanceCents + foldAccount(tail.map((event) => event.data)).balanceCents;
      const fullReplay = foldAccount(events.map((event) => event.data)).balanceCents;
      return {
        // …stream/version/events fields elided…
        balanceCents: fromSnapshot,
        load: {
          usedSnapshot: true,
          replayedEvents: tail.length,
          totalEvents: total,
          fullReplayBalanceCents: fullReplay,
          consistent: fromSnapshot === fullReplay,
        },
      };
    }`,
        },
      ],
    },
    {
      id: 'advanced-architecture:tracing',
      title: 'Distributed tracing across boundaries',
      lead:
        'One trace id for the whole journey, parent ids that name who caused what — and the discipline of carrying context through asynchronous hops.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:tracing:traceparent',
          body: `THE STANDARD (W3C Trace Context) in one header: traceparent — version, TRACE-ID, PARENT-ID, flags. The TRACE-ID identifies the WHOLE trace — one user action, many services, every hop carrying the same 16 bytes; the PARENT-ID is the caller's span: each hop mints its own span id and passes THAT downstream, so the finished tree answers "who caused this work", not just "where did time go". Sampling keeps it affordable: trace 1% of everything rather than nothing. THE INBOUND RULE: parse the incoming header, or — absent or malformed — MINT a fresh trace and carry on; observability must never break the request it observes (this repo's parser ignores any unusable header, never a 400). THE ASYNC RULE is the one that matters here: when work crosses a queue, the trace context must ride the PAYLOAD — serialized like any other data, restored on the consumer side — because the consumer is a different process, possibly hours later, and without the context the trace silently ends at the enqueue. This repo does both: HTTP hops read and write the header, and the traced-job flow carries context inside job payloads. THE COEXISTENCE that IS the lesson: the REQUEST-ID (the Exception Handling topic's correlation triangle) identifies one inbound HTTP request INSIDE this process; the TRACE-ID identifies the WORK across processes — many requests per trace. Neither substitutes for the other; conflating them is how traces get cut short or logs lose their join key. The Logging and Observability topic owns this machinery in depth; what this topic adds is only the boundary-crossing view: context as DATA, handed to whatever comes next. The quote is the propagation itself: format a header, mint a fresh identity, derive a child's.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:tracing:verbatim-propagation',
          language: 'ts',
          caption: 'Verbatim — the propagation mechanics: canonical output, a fresh identity, a child identity (core/logging/trace_context.ts)',
          source: 'server/src/core/logging/trace_context.ts',
          code: `/** Canonical output: always lowercase, version 00, one-line flags byte. */
export function formatTraceparent(context: TraceContext): string {
  return \`\${TRACE_VERSION}-\${context.traceId}-\${context.spanId}-\${context.sampled ? '01' : '00'}\`;
}

/** A fresh identity: new traceId + new spanId (a brand-new trace's first span). */
export function generateTraceContext(sampled = true): TraceContext {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    sampled,
  };
}

/** A CHILD identity: same trace (and sampling decision), NEW span id. */
export function childTraceContext(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: randomBytes(8).toString('hex'), sampled: parent.sampled };
}`,
        },
      ],
    },
    {
      id: 'advanced-architecture:see-it-live',
      title: 'See it live',
      lead:
        'Both exhibits, live: append events and watch the fold refuse an overdraft; run a saga with a broken step and watch the compensations unwind it.',
      blocks: [
        {
          kind: 'text',
          id: 'advanced-architecture:see-it-live:endpoints',
          body: `THE EVENT STORE console drives the real endpoints under /api/demo/patterns/eventstore: open an account (POST /accounts — a stream is minted, account-opened appended at version -1→0), deposit and withdraw (POST /accounts/:id/deposit and /withdraw — each append returns the new version, and both take an OPTIONAL expectedVersion so you can stage the stale-version 409 yourself). Attempt an OVERDRAFT and two things happen at once: the canonical 409 envelope (the typed conflict from the invariant gate), and the refusal itself recorded as a withdrawal-rejected event — reload the account and the attempt is in the history. GET /accounts/:id returns events, fold, load metadata (usedSnapshot, replayedEvents, consistent — the snapshot-verification proof, live once a stream's version lands on a multiple of five; the sixth event mints the first snapshot), and the projection slice; POST /project throws the read model away and re-derives it (the rebuild counter increments); POST /reset clears the store. THE SAGA console drives /api/demo/patterns/saga: start an order with failAt set to any forward step (POST /saga/start — returns immediately; the saga runs on real queue jobs), then poll GET /saga/:id and watch the step log fill: forward steps succeeding with attempt counts, the broken step exhausting the queue's retries, dead-lettering, then the compensations running in REVERSE — refund-card, release-stock, cancel-order — until the saga lands on 'compensated' (a clean run walks all four steps to 'completed'). Both consoles script everything below.`,
        },
        {
          kind: 'code',
          id: 'advanced-architecture:see-it-live:curl',
          language: 'bash',
          caption: 'Both exhibits from a terminal',
          code: `# --- the event store: open, deposit, attempt the overdraft ---
curl -s -X POST localhost:4000/api/demo/patterns/eventstore/reset > /dev/null
curl -s -X POST localhost:4000/api/demo/patterns/eventstore/accounts \\
  -H 'content-type: application/json' -d '{"owner":"the demo student"}' | jq '.streamId'
curl -s -X POST localhost:4000/api/demo/patterns/eventstore/accounts/account-1/deposit \\
  -H 'content-type: application/json' -d '{"amountCents": 2500}' | jq '{version, balanceCents}'

# the overdraft: a typed 409 envelope, AND the refusal recorded as an event
curl -s -X POST localhost:4000/api/demo/patterns/eventstore/accounts/account-1/withdraw \\
  -H 'content-type: application/json' -d '{"amountCents": 9999}' | jq '{code, details}'
# the stale version: optimistic concurrency answers its own 409
curl -s -X POST localhost:4000/api/demo/patterns/eventstore/accounts/account-1/withdraw \\
  -H 'content-type: application/json' -d '{"amountCents": 100, "expectedVersion": 0}' | jq '{code, details}'

# the read side: fold metadata, the projection slice, a from-scratch rebuild
curl -s localhost:4000/api/demo/patterns/eventstore/accounts/account-1 | jq '{version, load, history}'
curl -s -X POST localhost:4000/api/demo/patterns/eventstore/project | jq '.stats'

# --- the saga: a clean run, then a broken step and the reverse unwind ---
curl -s -X POST localhost:4000/api/demo/patterns/saga/start \\
  -H 'content-type: application/json' -d '{"orderId": "order-1"}' | jq '.saga.sagaId'
curl -s -X POST localhost:4000/api/demo/patterns/saga/start \\
  -H 'content-type: application/json' -d '{"orderId": "order-2", "failAt": "charge-card"}' | jq '.saga.sagaId'

# poll until the state is "completed" / "compensated", then read the step log:
curl -s localhost:4000/api/demo/patterns/saga/saga_2 | jq '.saga.state'
curl -s localhost:4000/api/demo/patterns/saga/saga_2 \\
  | jq '.saga.steps[] | {step, kind, status, attempts}'`,
        },
        {
          kind: 'demo',
          id: 'advanced-architecture:see-it-live:eventstore-demo',
          demoId: 'arch:eventstore',
          title: 'The event store, live',
          description:
            'Open an account stream, deposit, then attempt the overdraft: the append is refused at the invariant gate (a typed 409) and the refusal itself is recorded as a withdrawal-rejected event. Watch load metadata prove snapshot + tail equals the full replay, and rebuild the projection from scratch with one click.',
        },
        {
          kind: 'demo',
          id: 'advanced-architecture:see-it-live:saga-demo',
          demoId: 'arch:saga',
          title: 'The order saga, live',
          description:
            'Start an order — optionally with a permanently failing step (failAt). Every step is a real queue job with real retries; when the queue dead-letters the broken step, compensations unwind every attempted step in reverse (the failed one included). The step log, with per-step attempt counts, is the progress record the UI polls.',
        },
      ],
    },
  ],
};
