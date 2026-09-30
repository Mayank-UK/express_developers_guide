import type { Topic } from '../types.js';

/**
 * The MongoDB & Mongoose topic: document thinking (and its honest costs), the
 * lazy optional-service connection this repo really runs, schemas/models,
 * client-side validation, the fluent query API, indexes including a live TTL
 * demo, where the model layer sits in THIS app's architecture, and the
 * SQL-vs-document comparison — closing the Data section. Snippets marked
 * verbatim are this app's running source.
 */
export const topicMongodb: Topic = {
  id: 'mongodb',
  title: 'MongoDB and Mongoose',
  subtitle:
    'Document modeling, schemas and validation, and when a document store beats relational.',
  group: 'data',
  order: 3,
  sections: [
    {
      id: 'mongo-documents',
      title: 'Document thinking',
      lead: 'A document database stores JSON-shaped objects the way your program already holds them — nested, self-contained, schema-flexible. That flexibility is both the feature that sells it and the risk that disciplines it.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-documents:model',
          body: `THE UNIT CHANGES: relational rows are FLAT tuples whose meaning depends on the table they sit in (a "comment" is only a comment because of the comments table's columns and its foreign keys); Mongo DOCUMENTS are self-contained objects — the guide's demo event below carries its own nested meta object, and no JOIN ever assembles it, because it was STORED assembled. COLLECTIONS are the loose counterpart of tables, but with no enforced column set: two documents in one collection can have different shapes, which is exactly what makes rapid iteration fast (ship the new field; no ALTER TABLE anywhere) and exactly what makes discipline mandatory (nothing STOPS a typo'd field name from being silently stored). UNDERNEATH, BSON: Mongo stores documents in a binary JSON with extra types this app genuinely uses — ObjectId (the 24-hex-character id the demo returns), Date (millisecond precision — what createdAt/updatedAt really are), and 32/64-bit integers. Mongoose, the ODM this topic uses, is a thin TypeScript layer over the official driver: it adds SCHEMAS (the discipline), casting, validation, and typed models, while every query still compiles down to driver calls. WHEN MONGO FITS: flexible or nested shapes that would need many JOINs to reassemble (an event with meta, an order with line items, a user with embedded preferences); event streams and telemetry (append-only, time-ordered — the demo you will drive below is exactly this); rapid iteration where the schema is still discovering itself. WHEN SQL FITS BETTER: relational integrity is the product (money between accounts, foreign keys that must never dangle — the SQL topics' constraints do this AT THE ENGINE LEVEL), ad-hoc joins across entities (SQL joins are cheap and first-class; Mongo's $lookup is a late addition that pays for every level of nesting), and aggregate reporting over regular shapes. The honest rule: it is not a religion — the shape of your DATA picks the store, and the comparison table near the end of this topic makes the tradeoffs explicit.`,
        },
        {
          kind: 'code',
          id: 'mongo-documents:shapes',
          language: 'ts',
          source: 'server/src/data/mongo/event_model.ts',
          caption: 'The same "event" fact as a row would model it vs the REAL document shape this guide stores (data/mongo/event_model.ts — the demo collection you drive below)',
          code: `// SQL thinking: flatten to columns, reassemble with JOINs later —
// integrity lives in the engine (NOT NULL, FK, CHECK — see the SQL topics):
//   events(id, kind, page, visitor, created_at)   -- meta needs ANOTHER table
//   event_meta(id, event_id REFERENCES events(id), key, value)

// Document thinking: store the object whole — this is the REAL shape the
// guide's demo collection stores. meta is Mixed, so a nested value like
// { referrer: '/topics/sql-node', seconds: 42 } needs no second table and
// no JOIN to come back whole:
export interface EventFields {
  kind: EventKind;     // 'visit' | 'click' | 'error' | 'custom' — enum-enforced
  page: string;        // e.g. '/topics/mongodb'
  visitor: string;     // e.g. 'you'
  meta: unknown;       // Mixed: any BSON-able value — the flexible-schema point
  createdAt: Date;     // BSON Date, millisecond precision — driver-managed
  updatedAt: Date;
}
// On disk this is BSON: _id is an ObjectId (the 24-hex id the demo renders),
// dates are 64-bit ms integers. And 60 seconds after createdAt, the document
// DISAPPEARS — the TTL index in the indexes section below is a promise the
// SERVER keeps for you.`,
        },
      ],
    },
    {
      id: 'mongo-connecting',
      title: 'Connecting: the optional-service discipline',
      lead: 'This repo treats Mongo as an OPTIONAL service — the app must boot, and every other topic must work, with no mongo anywhere. The connection module below is the real one; its laziness and its fail-fast timeout are the whole lesson.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-connecting:states',
          body: `THE THREE STATES a connection can be in, and what each means for YOUR code: NOT CONFIGURED (MONGO_URI is '' — the default in production and in this guide whenever the service is down): getMongoConnection() resolves null IMMEDIATELY without creating so much as a mongoose object, and every repository call translates that into a typed 'unavailable' failure — the HTTP layer answers 503, the app keeps serving, nothing crashes. CONNECTING: mongoose.createConnection() opens a pool of TCP sockets to the server; because Mongo is a NETWORK database (unlike the SQL topic's in-process SQLite), connections can be slow, can fail, and need a TIMEOUT — serverSelectionTimeoutMS: 1500 here, so a down service costs 1.5 seconds ONCE per attempt, not the default 30 seconds of hanging. CONNECTED: one cached connection for the process lifetime (readyState 1 — the status endpoint below reports it live), reused by every request; Express handles the concurrency, the driver's pool handles the sockets. THE TWO DISCIPLINES that make an optional service honest: LAZY — the module-level singleton connects on FIRST USE, so importing it is free and environments that never call the mongo routes never open a socket (the same pattern as the SQL topic's sqlite client, plus a network); NO CRASH — the attempt's failure resolves null (never rejects past the module boundary), the failed attempt is NOT cached (boot the service later, click refresh, the demo recovers without a restart), and an 'error' EVENT listener is attached because a mongoose connection with no error listener turns a socket failure into a process-killing uncaught exception. Shutdown closes the connection in the same graceful chain as the HTTP listener and the gRPC server.`,
        },
        {
          kind: 'code',
          id: 'mongo-connecting:verbatim',
          language: 'ts',
          source: 'server/src/data/mongo/mongo_client.ts',
          caption: 'Verbatim — the real connection singleton (data/mongo/mongo_client.ts), abridged only where marked; server.ts drains it in shutdown',
          code: `let connectionPromise: Promise<Connection | null> | undefined;

export function getMongoConnection(): Promise<Connection | null> {
  if (!isMongoConfigured()) {
    // Feature off: no mongoose object is ever created for this call path.
    return Promise.resolve(null);
  }

  connectionPromise ??= attemptConnection();   // lazy singleton: first use only
  return connectionPromise;
}

function attemptConnection(): Promise<Connection | null> {
  const connection = mongoose.createConnection(appConfig.mongoUri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,   // 1500 — fail fast
  });
  // The connection is an EventEmitter: without a listener, a later socket
  // error would surface as an unhandled 'error' event and kill the process.
  connection.on('error', (err: Error) => {
    logger.warn({ err: err.message }, 'mongo connection error — the mongo demo stays degraded until the service answers');
  });

  return connection
    .asPromise()
    // …the .then logs host/port/db and returns the connected handle…
    .catch((err: Error) => {
      logger.error(
        { err },
        'mongo unreachable — the guide keeps serving; the mongo demo reports unavailable',
      );
      // Do NOT cache the failure: the next caller retries — the demo
      // recovers the moment the service appears.
      connectionPromise = undefined;
      return null;   // null, never a rejection — callers can't crash
    });
}

// server.ts shutdown chain: gRPC stops first, then closeMongoConnection(),
// then HTTP closes.`,
        },
      ],
    },
    {
      id: 'mongo-schemas',
      title: 'Schemas and models',
      lead: 'A mongoose Schema is your discipline made executable: types, required, enum, defaults, timestamps, indexes — declared once, enforced on every save. A Model is that schema bound to a collection: a constructor for documents and your handle for querying them.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-schemas:walkthrough',
          body: `THE SCHEMA WALKTHROUGH (the real EventSchema, field by field): KIND is a String with required: true AND an enum — visit/click/error/custom — so a typo'd kind is rejected before any wire round-trip; enums are the cheapest data-quality tool a schema gives you. PAGE and VISITOR are required Strings — presence enforcement, the counterpart of SQL's NOT NULL, except enforced IN YOUR PROCESS (next section). META is Schema.Types.Mixed — deliberately schemaless, "any BSON-able value", with a default of () => ({}) — a FACTORY, not a literal, because an object-literal default would be one shared object mutated by every document (the classic Mixed footgun; the unit specs prove the factory gives each document its own). TIMESTAMPS: true is a schema OPTION, not a field: mongoose then manages createdAt/updatedAt as BSON Dates on every save — you never set them by hand, exactly like the SQL topic's DEFAULT strftime(...) columns, and updatedAt moves on every mutation. THE INDEX DECLARATIONS at the bottom are part of the schema too (indexes section below): declare once, and the driver builds them idempotently on first use. SCHEMA vs MODEL vs DOCUMENT — the three-layer distinction that trips everyone once: the SCHEMA is the shape+rules (a plain description, connected to nothing); the MODEL is the schema REGISTERED on a connection — connection.model('Event', EventSchema) — which is a constructor bound to one collection AND your query interface (Event.find, Event.create); a DOCUMENT is one instance — new Event({...}) — a live object carrying your data, dirty-tracking, and .save(). One more discipline this repo adds: the model is registered on a DEDICATED connection (mongoose.createConnection — never the global mongoose default connection), so this feature's state can never leak into or be polluted by any other mongoose user in the same process.`,
        },
        {
          kind: 'code',
          id: 'mongo-schemas:verbatim',
          language: 'ts',
          source: 'server/src/data/mongo/event_model.ts',
          caption: 'Verbatim — the entire real schema (data/mongo/event_model.ts); this is the file the demo below runs',
          code: `export const EventSchema = new Schema(
  {
    kind: { type: String, required: true, enum: EVENT_KINDS },  // EVENT_KINDS =
    page: { type: String, required: true },                     // ['visit','click',
    visitor: { type: String, required: true },                  //  'error','custom']
    // Function default on purpose: an object literal default would be shared
    // by reference across documents; a factory gives each document its own.
    meta: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  // createdAt/updatedAt are managed BSON Dates, set by the driver on save —
  // the mongoose twin of SQLite's DEFAULT strftime(...) columns.
  { timestamps: true },
);

// The read pattern the demo list serves: newest events for a given page.
EventSchema.index({ page: 1, createdAt: -1 });
// THE TTL INDEX: mongod's background deleter removes documents whose
// createdAt is older than expireAfterSeconds.
EventSchema.index({ createdAt: 1 }, { expireAfterSeconds: EVENT_TTL_SECONDS });

// Schema → Model, on a DEDICATED connection (not the mongoose default):
export function buildEventModel(connection: Connection): EventModel {
  return connection.model<EventFields>('Event', EventSchema);
}
// Schema → Document → (on save) a row in the collection:
// const doc = new EventModel({ kind: 'visit', page: '/x', visitor: 'you' });`,
        },
      ],
    },
    {
      id: 'mongo-validation',
      title: 'Validation: in the driver, not the database',
      lead: 'Mongoose validators run CLIENT-SIDE — in your Node process, before the wire. That changes what a validation error is, where you handle it, and what the database itself guarantees (almost nothing, by design).',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-validation:where',
          body: `THE DIFFERENCE THAT MATTERS: SQL CHECK constraints and FKs live IN THE DATABASE SERVER — every client, every script, every 3am manual shell session gets the same enforcement, and invalid data CANNOT be inserted from anywhere. Mongoose validation lives in the DRIVER, in your process — it runs on .save()/.create() (and on demand via doc.validate(), which this repo's unit specs run against a never-connected model — no server involved at all), which means it guards every write that goes through YOUR models and nothing else. A document written by a different tool, an older deploy, or a mongosh session bypasses it entirely — which is WHY schema-as-code needs version discipline across the fleet (a writer with an old schema can still write old shapes), and why "flexible schema" was called a risk in the first section. WHAT YOU GET, concretely: required (presence), enum (allowed sets — the kind field), min/max for numbers, match for regex, minlength/maxlength, plus CUSTOM validators — any function of the value — and the whole thing composes with CASTING: a String field fed 42 is cast to "42" (casting is a feature; know it is happening), while a genuinely wrong type surfaces as a CastError. THE ERROR SHAPE is the part your HTTP layer must translate: mongoose throws Error.ValidationError with .errors keyed BY FIELD PATH, each carrying .message/.kind/.name — never hand that raw object to a client. THIS APP's mapping is one function in the repository: a ValidationError becomes failure('validation', message, { errors: [{field, message}], engine: 'mongoose' }) — the SAME normalized [{field, message}] array the validation topic's three-validator arena produces — which the error pipeline merges into the canonical envelope. Fire a bad kind at the demo below and the 400 you get back is this exact path, live.`,
        },
        {
          kind: 'code',
          id: 'mongo-validation:verbatim',
          language: 'ts',
          source: 'server/src/data/mongo/event_repository.ts',
          caption: 'Verbatim — the repository\'s error translation (data/mongo/event_repository.ts) and a custom validator idiom for the shapes this app does not need',
          code: `// The mapping every save flows through — mongoose shape → ONE taxonomy:
function toRepositoryFailure(operation: string, cause: unknown): Failure {
  if (cause instanceof mongoose.Error.ValidationError) {
    return failure(
      'validation',
      \`event failed mongoose validation (\${String(Object.keys(cause.errors).length)} field error(s))\`,
      { errors: validationErrors(cause), engine: 'mongoose' },
      cause,
    );
  }
  const name = cause instanceof Error ? cause.name : String(cause);
  if (/ServerSelection|NetworkTimeout|MongoNetworkErrorTopology|TopologyClosed/.test(name)) {
    return failure('unavailable', \`mongo became unreachable while \${operation}\`, { service: 'mongo' }, cause);
  }
  return failure('internal', \`\${operation} failed in mongo\`, { operation }, cause);
}

// …and the normalizer it calls — mongoose's per-path errors become the SAME
// [{field, message}] array the validation topic's arena produces:
function validationErrors(error: mongoose.Error.ValidationError): { field: string; message: string }[] {
  return Object.entries(error.errors).map(([field, issue]) => ({
    field,
    message: issue.message,
  }));
}

// Custom validator idiom (illustrative — this schema trusts Mixed):
// palette: {
//   type: [String],
//   validate: {
//     validator: (colors: string[]) => colors.every(c => /^#[0-9a-f]{6}$/i.test(c)),
//     message: 'palette colors must be #rrggbb hex strings',
//   },
// },

// The 400 the demo actually returns for kind: "scroll" — canonical envelope,
// mongoose's field details normalized under errors[]:
// { "error": { "code": "validation_failed", "engine": "mongoose",
//     "errors": [{ "field": "kind",
//       "message": "\`scroll\` is not a valid enum value for path \`kind\`." }],
//     "message": "event failed mongoose validation (1 field error(s))",
//     "requestId": "…" } }`,
        },
      ],
    },
    {
      id: 'mongo-queries',
      title: 'Queries and the fluent API',
      lead: 'Mongoose queries are built by chaining, executed by await — the thenable boundary is where "building a query" becomes "running one". The repo\'s real list query shows the idiom, and .lean() shows the free performance win.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-queries:fluent',
          body: `THE CHAIN: model.find(filter) returns a Query object — a description of an intent, nothing sent. .sort(), .limit(), .skip() keep DESCRIBING it. The wire round-trip happens when you await the query (queries are thenables — awaiting both builds and runs) or call .lean()/.exec() — which is why adding a .then() or a console.log after the fact can accidentally execute a query you meant to keep building, and why the repo keeps each query one expression. THE FILTER is itself a document-shaped object (not SQL text): {} means everything, { kind: 'error' } means exactly what it reads as, and the comparison operators are field-keyed — { createdAt: { $gte: since } }, { page: { $in: ['/home', '/about'] } } — Mongo's query language, inherited unchanged from the driver. SORT takes the same key-direction shape as the index declarations: { createdAt: -1 } is newest-first, the demo list's order. LEAN() is the performance idiom worth internalizing: a NORMAL query returns fully hydrated documents — live objects with change tracking, getters, .save() — and hydrating costs allocations on every row. A READ-ONLY list has no use for any of that, so .lean() returns PLAIN objects (≈ 2-3x faster, markedly less GC) — this app's list and stats both lean, because nothing downstream ever saves a listed event. The rule this repo follows: lean on every read path, hydrated documents only where you will actually mutate-and-save.`,
        },
        {
          kind: 'code',
          id: 'mongo-queries:verbatim',
          language: 'ts',
          source: 'server/src/data/mongo/event_repository.ts',
          caption: 'Verbatim — the repository\'s real list query (data/mongo/event_repository.ts) beside the driver-level shapes it is built from',
          code: `// The demo list endpoint's actual query — chain, await, lean:
const rows = (await model
  .find(options.kind === undefined ? {} : { kind: options.kind })  // doc-shaped
  .sort({ createdAt: -1 })   // newest first — what the console renders
  .limit(options.limit)
  .lean()) as unknown as Record<string, unknown>[];  // lean: plain objects,
return ok(rows.map(toListItem));                     // no hydration on a read

// The same intent in the shell/driver (no mongoose) — mongoose compiles to this:
// db.events.find({ kind: 'error' }).sort({ createdAt: -1 }).limit(20)

// Comparison operators when you need them (illustrative):
//   model.find({ createdAt: { $gte: new Date(Date.now() - 60_000) } })  // last minute
//   model.find({ page: { $in: ['/home', '/about'] } })                  // either page
//   model.countDocuments({ kind: 'error' })            // the stats endpoint's count`,
        },
      ],
    },
    {
      id: 'mongo-indexes',
      title: 'Indexes — including TTL',
      lead: 'Same physics as the SQL topic, different syntax: an index is a sorted side-structure that turns a collection scan into a lookup. Plus one thing SQL does not have: the TTL index, which makes documents EXPIRE — this collection auto-deletes 60 seconds after createdAt, and the demo watches it happen.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-indexes:mechanics',
          body: `COMPOUND FIRST: the demo's workload is "newest events for a page", so the schema declares { page: 1, createdAt: -1 } — page ASCENDING then createdAt DESCENDING, exactly matching the query's equality-on-page + sort-on-createdAt shape (the same equality-prefix rule the SQL topic's EXPLAIN SEARCH taught: a compound index serves queries that pin its leading fields). WITHOUT it, every filtered list is a COLLECTION SCAN — read every document, keep the matches — fine at dozens of documents, the classic production killer at millions. Declaring indexes IN THE SCHEMA (EventSchema.index(...)) means the driver builds them idempotently on first use (model.init(); this repo's status endpoint awaits it before listing indexes) — the counterpart of a CREATE INDEX IF NOT EXISTS migration. THE TTL INDEX is the special case worth a section: { createdAt: 1 } with expireAfterSeconds: 60 tells the SERVER to delete every document in this collection whose createdAt is older than 60 seconds — a per-collection retention policy with no cron job, no worker, and no line of application code. THE TIMING IS LAZY, and honesty demands the emphasis: mongod runs a background deleter on roughly a 60-SECOND cadence per index, so a document becomes EXPIRED-ON-PAPER at t+60 and is GONE-ON-DISK somewhere in the next minute-ish — expect observed lifetimes between 60 and ~120 seconds (plus replica-set lag in a cluster; and TTL only fires on DATE fields). In the demo below: insert an event, watch its AGE climb, refresh — it vanishes. This is the exact concept the upcoming Redis topic's key TTL implements (per-KEY there, per-DOCUMENT here, server-enforced in both) — sessions, rate-limit windows, OTP codes, and telemetry retention are all the same pattern wearing four hats.`,
        },
        {
          kind: 'code',
          id: 'mongo-indexes:verbatim',
          language: 'ts',
          source: 'server/src/data/mongo/event_model.ts',
          caption: 'Verbatim — the real TTL constant and both real index declarations (event_model.ts), and what the status endpoint reads back from the live server',
          code: `// Declared on the schema, built by the driver on first use:
export const EVENT_TTL_SECONDS = 60;   // documents live this long after createdAt
EventSchema.index({ page: 1, createdAt: -1 });   // the list query's shape
// THE TTL INDEX (expireAfterSeconds: EVENT_TTL_SECONDS — 60):
EventSchema.index({ createdAt: 1 }, { expireAfterSeconds: EVENT_TTL_SECONDS });

// What the live server actually holds (GET /api/demo/mongo/status → indexes):
// [
//   { "name": "_id_",               "key": { "_id": 1 } },
//   { "name": "page_1_createdAt_-1","key": { "page": 1, "createdAt": -1 } },
//   { "name": "createdAt_1",        "key": { "createdAt": 1 },
//     "expireAfterSeconds": 60 }                  // ← the deletion policy
// ]

// The shell form, if you ever create one by hand instead of via the schema:
// db.events.createIndex(
//   { createdAt: 1 },
//   { expireAfterSeconds: 60, name: 'createdAt_1' }
// )
// Retention arithmetic you can trust: gone ≈ createdAt + 60s + deleter sweep
// (0–60s) — never lean on TTL for exact-time deletion.`,
        },
      ],
    },
    {
      id: 'mongo-layering',
      title: 'The Mongoose-in-Express layering',
      lead: 'Where does a model live when the domain must stay persistence-agnostic? Same answer as the posts pipeline: models are DATA-LAYER machinery, the route calls a small repository that speaks Result/Failure — and nothing above the data layer can name mongoose.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-layering:placement',
          body: `THE DEPENDENCY RULE, unchanged (it is the app's first invariant): presentation → domain ← data. A mongoose MODEL is data-layer machinery the same way the SQL topic's DAO is — it speaks the database's shapes (ObjectId, lean documents, ValidationError) and those MUST NOT leak upward. So the mongo demo routes never import mongoose: they call event_repository.ts — a PORT-STYLE wrapper with exactly four methods (record, list, stats, clear) whose signatures are the app's established Result<_, Failure> — and every mongoose-specific thing is translated INSIDE it: ObjectId → a plain id string, BSON Dates → ISO strings, ValidationError → the normalized errors[] failure, connection-null → 'unavailable'. The routes stay THIN CONTROLLERS in the house style: parse/validate input (limit, kind, body shape — ValidationException before any I/O), call the repository, map Result to HTTP — 201 / canonical 400 / canonical 503, nothing else. WHY NO USE CASE HERE (a deliberate scope call, worth naming): the posts pipeline's full depth (route → controller → use case → repository → DAO) exists to demonstrate DOMAIN RULES living in the domain layer; the mongo demo has no business rules beyond schema validation, so the repository IS the right depth — but the seam is identical, and a real mongo-backed feature would grow a use case the same day it grows a rule the schema cannot express. The file map for this topic, concretely: data/mongo/mongo_client.ts (connection), data/mongo/event_model.ts (schema + model), data/mongo/event_repository.ts (the Result-speaking port wrapper), presentation/routes/mongo_demo_routes.ts (thin controllers) — the exact shape of data/posts/*, one directory over.`,
        },
        {
          kind: 'code',
          id: 'mongo-layering:verbatim',
          language: 'ts',
          source: 'server/src/presentation/routes/mongo_demo_routes.ts',
          caption:
            "Verbatim — the thin controllers (presentation/routes/mongo_demo_routes.ts): parse, call the repository, map Result → HTTP",
          code: `// The create controller, ENTIRE:
async function createEventController(req: Request, res: Response): Promise<void> {
  const input = readEventBody(req.body);            // parse step (throws 400s)
  const result = await recordEvent(input);          // port-style repository call
  if (!result.ok) throw failureToException(result.error);  // Result → HTTP
  res.status(201).json({ event: result.value });
}

// The list controller — two Results, same move per Result:
async function listEventsController(req: Request, res: Response): Promise<void> {
  const limit = readListLimit(req.query);
  const kind = readKindFilter(req.query);

  const [events, stats] = await Promise.all([listEvents({ limit, kind }), eventStats()]);
  if (!events.ok) throw failureToException(events.error);
  if (!stats.ok) throw failureToException(stats.error);
  res.json({ events: events.value, stats: stats.value });
}`,
        },
        {
          kind: 'code',
          id: 'mongo-layering:verbatim-contract',
          language: 'ts',
          source: 'server/src/data/mongo/event_repository.ts',
          caption:
            "Verbatim — the repository signatures the controllers call (data/mongo/event_repository.ts; the mongoose world ends at this boundary — above it: Result, Failure, plain shapes)",
          code: `// The port wrapper's real contract — bodies elided:
export async function recordEvent(input: RecordEventInput): Promise<Result<EventListItem, Failure>> {
  // …'unavailable' | 'validation' failure, or ok(the created event)…
}
export async function listEvents(options: EventListOptions): Promise<Result<readonly EventListItem[], Failure>> {
  // …ok(newest-first lean rows), mapped to plain shapes…
}
export async function eventStats(): Promise<Result<EventStats, Failure>> {
  // …count, oldest/newest, and the TTL facts off the live index list…
}
export async function clearEvents(): Promise<Result<ClearResult, Failure>> {
  // …ok({ deletedCount })…
}

// The posts pipeline beside it (same seam, one more layer because posts have
// domain rules):  routes → controllers (posts_controllers.ts) → postsUseCase
//                 (domain) → PostRepositoryPort (domain) → the sqlite
//                 repository (data — makeSqlitePostRepository)
// The mongo demo: routes → event_repository (data, port-shaped) → mongoose.`,
        },
      ],
    },
    {
      id: 'mongo-vs-sql',
      title: 'SQL vs Mongo — the honest table',
      lead: 'No winners, just tradeoffs along five axes that actually decide it: shape of data, where integrity lives, joins, transactions, and schema change. The two SQL topics earlier in this section are the left column; everything you just read is the right one.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-vs-sql:table',
          body: `FIVE AXES, honestly. SHAPE: SQL normalizes — nested reality becomes tables + FKs and every read reassembles it with JOINs; Mongo embeds — the nested object is stored as the nested object and comes back whole (JOIN-free reads, at the price of duplication when data is SHARED rather than owned). INTEGRITY: SQL puts it IN THE ENGINE (NOT NULL, UNIQUE, FK with ON DELETE, CHECK — enforced against every writer including your 3am shell session); mongoose puts it IN THE DRIVER (required/enum/custom validators — enforced only on writes through your models; the database itself will happily store any BSON you hand it). JOINS: SQL joins are first-class, cheap, and ad-hoc — the day the queries get relational, SQL is home; Mongo's $lookup exists but pays per nesting level, and the idiomatic answer is embedding, which only works when the data's ownership allows it. TRANSACTIONS: SQL had ACID from day one, multi-statement by default (the transfer demo in the SQL topic rolls back two writes atomically); Mongo is atomic on a SINGLE document (a big win — one embedded write IS a mini-transaction) and multi-document transactions exist but need replica-set plumbing and carry real costs, so the design pressure is "shape the document so you don't need one". SCHEMA CHANGE: SQL migrations are ordered, reviewable history (this repo's own runner — the SQL topic drove it live); Mongo's flexible schema means "add a field" often deploys without a migration — and still needs BACKFILL and old-writer discipline, because readers meet every shape that ever existed. THE DECISION IN ONE SENTENCE EACH: ownership-nested data with fast-changing shape and append-heavy access → documents (event streams, catalogs, content, per-user settings); shared, inter-referenced entities with integrity-as-product and ad-hoc relational queries → SQL (money, orders-with-stock, anything audited). And the senior non-answer that is actually the answer: plenty of systems run BOTH — Postgres for the money, Mongo for the telemetry — because the axes above score differently per SUBSYSTEM, not per company.`,
        },
        {
          kind: 'code',
          id: 'mongo-vs-sql:table-code',
          language: 'text',
          caption: 'The same five axes as a table — with this guide\'s own sections as the evidence for each claim',
          code: `                       SQL (SQLite/Postgres…)          MongoDB + Mongoose
unit of storage        row (flat tuple, typed cols)     document (nested BSON obj)
shape discipline       schema IN THE ENGINE             schema in the DRIVER
                       (NOT NULL, FK, CHECK, UNIQUE)    (mongoose required/enum —
                       enforced against EVERY writer    only writes via your models)
nested data            normalize → tables + JOINs      embed → stored assembled
                       (reassemble on every read)       (no JOIN to read it back)
joins / relations      first-class, cheap, ad-hoc       $lookup (costly) or embedding
multi-write atomicity  always (BEGIN…COMMIT/ROLLBACK)   single-document always;
                       — this guide's transfer demo       multi-doc needs replica set
schema evolution       migrations = ordered history      add a field = no migration;
                       (this guide's real runner)        backfills still on you
this guide's proof     SQL & Schema + SQL with Node      this topic (TTL demo below)

When the data is OWNED and NESTED and append-heavy → documents.
When the data is SHARED and CROSS-REFERENCED and integrity IS the product → SQL.`,
        },
      ],
    },
    {
      id: 'mongo-nosql-families',
      title: 'The NoSQL family survey',
      lead: '"NoSQL" is not one technology — it is four or five different answers to "what if the data is not a row in a table?" Knowing which FAMILY a store belongs to tells you what it is good at before you read a single page of its docs.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-nosql-families:survey',
          body: `THE FAMILIES, one honest paragraph each. KEY-VALUE (Redis, DynamoDB): the whole data model is GET/SET on a key, with values opaque to the store — strings, counters, small blobs. That simplicity buys SPEED (the data structures are hash tables with TTLs) and makes it the home of ephemeral, lookup-shaped state: sessions, caches, rate-limit windows, distributed locks. It is NOT a system of record — no query language beyond the key, no joins, no ad-hoc anything (this guide's Redis topic builds exactly that usage). DOCUMENT (MongoDB — this topic): JSON-shaped objects stored whole, queried by fields and nested paths; fits owned, nested, shape-shifting data — the model you just read. WIDE-COLUMN (Cassandra, Bigtable, HBase): rows keyed and sparse over enormous column families, built for write-heavy horizontal scale and huge sparse tables (time series, telemetry at fleet scale) — with the famous trade that you design tables AROUND your queries, because ad-hoc joins and flexible secondary indexes are not the model. GRAPH (Neo4j): nodes and edges as first-class citizens, for data whose VALUE is the relationships — social graphs, fraud rings, dependency trees — where a recursive JOIN ladder in SQL becomes one traversal. SEARCH (Elasticsearch/OpenSearch, and the FTS engines inside databases): inverted indexes over text, relevance ranking, faceting — the full-text search section of the SQL with Node topic shows SQLite's FTS5 doing this job inside your database, which is the honest first stop before a separate search cluster. WHEN IS EACH JUSTIFIED? The question is always about the DATA'S SHAPE and the QUERY'S shape, not the brand: everything is a lookup on a key → key-value; everything is nested and owned by one aggregate → document; writes dwarf reads at massive scale with known query shapes → wide-column; the relationships ARE the data → graph; users type words and expect ranked results → search. WHERE THIS GUIDE SITS, and why: Redis (its own topic) covers the key-value end — TTL'd keys for ephemeral state, deliberately optional; Mongo (this topic) covers the document end — nested event documents with a TTL index. SQLite covers the relational system of record. That is the honest production shape for MOST applications — the senior default is "Postgres (or any real RDBMS) for the truth, Redis for the hot/ephemeral layer, and everything else only when a measured problem names its family": you add a document store when a subsystem's data is genuinely document-shaped, a search engine when the database's FTS measurably stops coping, a graph database when your JOIN ladder is five levels deep and slow. Adopting a store per buzzword is how teams end up maintaining five databases that only you keep alive.`,
        },
        {
          kind: 'code',
          id: 'mongo-nosql-families:verbatim-redis',
          language: 'ts',
          source: 'server/src/data/redis/redis_client.ts',
          caption: 'Verbatim — this repo\'s real Redis client options (data/redis/redis_client.ts): the key-value family\'s operational personality — fast, fail-fast, never silently queueing',
          code: `/** The options every guide-owned connection shares (see the block comment). */
const REDIS_CLIENT_OPTIONS = {
  lazyConnect: true, // nothing connects until the first caller asks
  enableOfflineQueue: false, // commands on a dead connection reject, never queue
  maxRetriesPerRequest: 1, // no burst of retries piling up per command
  connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
  // The guide never silently reconnects: a lost connection surfaces as
  // failures (the demo degrades), and the next call opens a fresh client.
  retryStrategy: null,
} as const;`,
        },
      ],
    },
    {
      id: 'mongo-live',
      title: 'See it live',
      lead: 'One console, every concept: the lazy connection states, schema validation errors normalized into the canonical envelope, the fluent query results, and a TTL index deleting your documents while you watch. Needs the optional mongo service — and gracefully says so when it is missing.',
      blocks: [
        {
          kind: 'text',
          id: 'mongo-live:intro',
          body: `THE SERVICE IS OPTIONAL, on purpose: without MONGO_URI (or with the container down), the status panel reports OFF with the exact command that turns it on — docker compose -f .docker/docker-compose.yml up -d mongo — and the data endpoints answer the canonical 503 envelope; nothing else in the guide so much as notices. WITH THE SERVICE UP, the console is a complete loop: STATUS shows configured → connected, the connection state, the host/db target (never credentials), and the LIVE index list straight from the server — page_1_createdAt_-1 and the TTL index createdAt_1 with expireAfterSeconds 60. INSERT an event (pick a kind, a page, a visitor, and any meta JSON you like — meta is Mixed, it will take whatever BSON can hold); a bad kind comes back as the 400 envelope with mongoose's field detail normalized under errors[] — the validation section's translation, live. THE LIST shows events newest-first with their AGE climbing in seconds — and roughly a minute after each createdAt, the TTL index makes them VANISH on the next refresh (the deleter is lazy: observed lifetimes run 60–120s). The STATS row carries count, oldest/newest, and the TTL facts. CLEAR resets the collection for the next experimenter. The curl block drives the same loop from a terminal.`,
        },
        {
          kind: 'demo',
          id: 'mongo-live:console-demo',
          demoId: 'db:mongo-console',
          title: 'The mongo console',
          description:
            'Live status of the optional connection (with the index list read from the server), an event form that proves schema validation and Mixed meta, the newest-first list with per-event AGE so the 60-second TTL is visible, stats, and a clear button. With Mongo off: the exact command that turns it on.',
        },
        {
          kind: 'code',
          id: 'mongo-live:curl',
          language: 'bash',
          caption: 'The whole loop from a terminal (server: npm run dev in server/; mongo: the compose command above)',
          code: `# 0. the optional service (skip if it is already up):
docker compose -f .docker/docker-compose.yml up -d mongo

# 1. status — connection state, host/db target, and the LIVE indexes
#    (watch for createdAt_1 with expireAfterSeconds: 60):
curl -s localhost:4000/api/demo/mongo/status | jq '{configured, connected, uri, indexes}'

# 2. insert an event (meta is Mixed — any BSON-able JSON):
curl -s -X POST localhost:4000/api/demo/mongo/events \\
  -H 'content-type: application/json' \\
  -d '{"kind":"visit","page":"/topics/mongodb","visitor":"curl","meta":{"from":"terminal"}}' \\
  | jq '.event'

# 3. validation — a bad kind, answered by the canonical envelope with the
#    mongoose field detail normalized under errors[]:
curl -s -X POST localhost:4000/api/demo/mongo/events \\
  -H 'content-type: application/json' \\
  -d '{"kind":"scroll","page":"/x","visitor":"curl"}' | jq '.error'

# 4. list + stats — then refresh again in ~60-120s and watch the TTL delete:
curl -s 'localhost:4000/api/demo/mongo/events?limit=5' \\
  | jq '{stats, first: .events[0]}'

# 5. with Mongo stopped, everything degrades — status says off, data says 503:
docker compose -f .docker/docker-compose.yml stop mongo
curl -s localhost:4000/api/demo/mongo/status | jq '{configured, connected, note}'
curl -s localhost:4000/api/demo/mongo/events | jq '.error.code'   # service_unavailable
docker compose -f .docker/docker-compose.yml up -d mongo          # and it recovers`,
        },
      ],
    },
  ],
};
