import type { Topic } from '../types.js';

/**
 * The Messaging & Event Streaming topic: the guide's "systems talking to
 * systems" story, closing the Caching & Messaging section. Two real artifacts
 * carry it — the Redis stream lab (data/messaging/stream_service.ts: XADD,
 * XGROUP, XREADGROUP, XACK, XPENDING, XAUTOCLAIM, the DLQ path) and the
 * transactional outbox (data/messaging/outbox_service.ts +
 * data/migrations/0008_create_outbox.sql) — and every code block below quotes
 * their real running source. Demos drive the live endpoints under /api/demo/msg.
 */
export const topicMessaging: Topic = {
  id: 'messaging',
  title: 'Messaging & Event Streaming',
  subtitle:
    'Logs vs queues, consumer groups, delivery guarantees, and the transactional outbox.',
  group: 'caching-messaging',
  order: 3,
  sections: [
    {
      id: 'messaging:why',
      title: 'Why messaging',
      lead:
        'A request that triggers work should not have to know about the work it triggered. The systems that carry that work between processes — brokers, streams, queues — are what this topic maps.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:why:decoupling',
          body: `THE DECOUPLING ARGUMENT, in one sentence: the handler that changes data has one job — change it and answer — and everything ELSE that needs to know is a different system with its own latency, its own availability, and its own appetite for freshness. A post update may matter to search indexing, analytics, email, and three cache layers. Call each of those synchronously from the write path and you have coupled your API to every downstream's worst day: one slow indexer is now your page latency, one crashed analytics service is now your 500s. A messaging layer inserts an intermediary with a memory: the producer publishes "post.updated" and returns in microseconds; consumers read when they can. That buys decoupling in three dimensions at once — TIME (a consumer may be down when the message is published and still get it when it returns), CARDINALITY (one event can feed zero, one, or seven consumers without the producer knowing), and IDENTITY (the producer names a TOPIC, never a receiver — new subscribers attach without touching a line of producer code).

WHAT YOU HAVE ALREADY MET, named properly. The Redis topic's pub/sub is the lightest messaging there is: channels, PUBLISH to whoever is subscribed right now, fire-and-forget with no memory — a listener that was reconnecting simply missed the message, and that is the contract, not a bug. The Background Jobs topic built the other pole by hand: a durable queue where work waits, retries with backoff, and dead-letters when it cannot succeed — one producer, a pool of workers draining a shared backlog. Between those poles lies the whole design space this topic maps: brokers that REMEMBER (so consumers can catch up and replay), delivery guarantees stronger than fire-and-forget, and the database-side trick — the transactional outbox — that makes "commit and publish" atomic despite spanning two systems.`,
        },
        {
          kind: 'text',
          id: 'messaging:why:pubsub-recap',
          body: `THE VOCABULARY, once, because every product uses it slightly differently. A PRODUCER (publisher) creates messages. A CONSUMER (subscriber) receives them. A BROKER (Kafka, RabbitMQ, Redis) sits between and stores or routes. A TOPIC (channel, routing key, stream) is the named destination producers write to and consumers read from. A MESSAGE (event, record) is what travels — and its shape deserves the same discipline an HTTP envelope gets: a small serialized payload plus HEADERS (an id, a timestamp, a topic name) is what makes messages debuggable and consumers idempotent later.

PUB/SUB VERSUS MESSAGING, the recap that matters: pub/sub is a DELIVERY pattern — broadcast to current subscribers — not a storage system. The moment any consumer needs to receive messages published while it was down, to re-read history after a bug, or to have exactly one worker process each message, you are in messaging territory. The first fork in that territory is the choice between a LOG and a QUEUE, and it is the single most useful map of this whole landscape: figure out which side your problem is on and most of the product-comparison noise dissolves — which is exactly what the next section draws.`,
        },
      ],
    },
    {
      id: 'messaging:two-families',
      title: 'Two families: logs and queues',
      lead:
        'Log-based and queue-based brokers answer "who gets this message?" in opposite ways: a log keeps the message so many readers can have it over time; a queue hands it to exactly one worker, and the ack destroys it.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:two-families:comparison',
          body: `LOG-BASED (Kafka, Redis Streams, Kinesis, Pulsar): the broker is an append-only sequence of records. Producers append; the log RETAINS messages for a configured time or size no matter who reads; each consumer group tracks its own POSITION and advances at its own pace. Nothing is destroyed by reading — ten different applications can read the same history, a brand-new one can start at the beginning and replay years of events, and a consumer that falls behind simply catches up later. THE UNIT OF ORDERING is the partition (Kafka) or the stream (Redis): within one partition, strict order; across partitions, none is promised. Retention is a first-class knob, and an unbounded one is an outage — which is why the quote below pins its retention policy (MAXLEN ~ 1000) in the produce call itself.

QUEUE-BASED (RabbitMQ, Amazon SQS, ActiveMQ): the broker routes each message to ONE consumer, and the message's lifetime ends at the ACK — acknowledged means gone. Delivery is work distribution: a backlog that a pool of workers drains in parallel, with per-message acknowledgment, redelivery of un-acked messages, and (in RabbitMQ) a routing topology — exchanges binding messages onto queues by key. The Background Jobs topic's hand-rolled queue is conceptually this family: enqueue appends, a worker claims, dead-letter parks the hopeless. THE DISCRIMINATOR is what the message IS: when the message is WORK — send this email, render this invoice, and nobody else needs it — a queue is the right shape; when the message is a FACT — "order 42 was placed" — that several systems may need now, later, or again, a log is. This guide implements the log family on Redis Streams (the lab below) and teaches the queue family's guarantees through it, because streams make every queue idea — acks, pending, reclaim, dead-lettering — visible as commands you can watch.`,
        },
        {
          kind: 'code',
          id: 'messaging:two-families:table',
          language: 'text',
          caption: 'The fork in the messaging landscape — and the question that resolves it: is the message WORK or a FACT?',
          code: `family       examples             message lifetime       who reads it                       ordering unit     wins when
───────────  ───────────────────  ─────────────────────  ─────────────────────────────────  ────────────────  ─────────────────────────────────
log-based    Kafka, Redis Streams retained (time / size) any consumer, any time — replay     partition/stream  one fact, many consumers over time
queue-based  RabbitMQ, SQS        gone at the ack        exactly one consumer per delivery  queue             one task, drained by a worker pool`,
        },
        {
          kind: 'code',
          id: 'messaging:two-families:verbatim-xadd',
          language: 'ts',
          source: 'server/src/data/messaging/stream_service.ts',
          caption: 'Verbatim — produce: XADD appends to the log; MAXLEN is the retention policy (data/messaging/stream_service.ts)',
          code: `/**
 * XGROUP CREATE with MKSTREAM — the stream and its group in one command.
 * BUSYGROUP is the EXPECTED reply once the group exists: "ensure exists" is
 * idempotent by design, so it is swallowed; anything else rethrows (the
 * caller's runOnClient maps it onto the Failure taxonomy).
 */
async function ensureGroup(client: Redis): Promise<void> {
  try {
    await client.xgroup('CREATE', STREAM_LAB_KEY, STREAM_LAB_GROUP, '$', 'MKSTREAM');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.includes('BUSYGROUP')) throw cause;
  }
}

// --- produce -------------------------------------------------------------------------

export async function produceToStream(
  payload: unknown,
  retryCount = 0,
): Promise<Result<ProduceResult, Failure>> {
  return runOnClient('appending to the stream (XADD)', async (client) => {
    await ensureGroup(client);
    const headers: StreamMessageHeaders = {
      payload,
      retryCount,
      producedAt: new Date().toISOString(),
    };
    // '*' mints the id <ms>-<seq> — the entry's POSITION in the log; MAXLEN ~
    // is the retention policy written in code: an unbounded log is an outage.
    const id = (await client.xadd(
      STREAM_LAB_KEY,
      'MAXLEN',
      '~',
      STREAM_MAXLEN,
      '*',
      ...fieldsForXadd(headers),
    )) as string;
    const streamLength = await client.xlen(STREAM_LAB_KEY);
    return { id, fields: headers, streamLength };
  });
}`,
        },
      ],
    },
    {
      id: 'messaging:consumer-groups',
      title: 'Consumer groups and ordering',
      lead:
        'A consumer group is how a log becomes a work-distribution engine without giving up the log: the group has one position, each member gets different messages — and ordering survives exactly as far as one stream.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:consumer-groups:ordering',
          body: `A CONSUMER GROUP is the bridge between the two families. The group — as a whole — has ONE read position in the stream; every consumer inside it receives DIFFERENT messages, so four consumers parallelize one stream roughly four ways, and each message reaches exactly one member. Two DIFFERENT groups reading the same stream each get everything independently: a "search-indexers" group and an "analytics" group can both consume the same events, each at its own pace, each with its own position. That is queue-style parallel workers over a log-style retained history — XGROUP CREATE is the whole bridge, and note in the quote how cheaply it is kept alive: every produce and consume path calls ensureGroup first, and BUSYGROUP (the "already exists" reply) is swallowed because "ensure exists" must be idempotent — workers boot and restart constantly, and a group-create race must never be fatal.

ORDERING is guaranteed exactly as far as one stream, and no further. Redis delivers entries in id order — the <ms>-<seq> ids the XADD above mints are monotonic, which is what makes the stream a LOG; Kafka guarantees order within a partition and nothing across partitions. So the design move when you need "all events about entity X, in order" is KEYING: Kafka producers hash a message key to pick a partition, so every event for the same key lands in the same partition and stays ordered; a stream-per-entity does the same in Redis at smaller scale. This lab is deliberately ONE stream with ONE group — global order, no sharding noise — so the harder lessons (pending, reclaim, dead-lettering) stay visible. The read itself is one command, and its strangest argument is its most important: the ">" id in XREADGROUP means "only messages NEVER delivered to anyone in this group" — the group's memory of what it has already handed out is server-side, and that memory is what the next two sections lean on.`,
        },
        {
          kind: 'code',
          id: 'messaging:consumer-groups:verbatim-readgroup',
          language: 'ts',
          source: 'server/src/data/messaging/stream_service.ts',
          caption: 'Verbatim — consume: XREADGROUP with the ">" id — never-delivered messages only (data/messaging/stream_service.ts)',
          code: `export async function consumeAsWorker(options: ConsumeOptions = {}): Promise<Result<ConsumeResult, Failure>> {
  const consumer = options.consumer ?? STREAM_DEFAULT_CONSUMER;
  const count = Math.min(Math.max(options.count ?? 1, 1), CONSUME_BATCH_LIMIT);

  return runOnClient('reading from the consumer group (XREADGROUP)', async (client) => {
    await ensureGroup(client);
    // '>' = only messages NEVER delivered to anyone in this group. The reply
    // is NULL (not an empty array) when there is nothing new — ioredis is
    // honest about the protocol here.
    const raw = await client.xreadgroup(
      'GROUP',
      STREAM_LAB_GROUP,
      consumer,
      'COUNT',
      count,
      'STREAMS',
      STREAM_LAB_KEY,
      '>',
    );
    if (raw === null || raw.length === 0) {
      return { consumer, messages: [], empty: true };
    }

    const consumed: ConsumedMessage[] = [];
    for (const entry of entriesFromRaw(raw[0]![1] ?? [])) {
      const outcome = await processOne(client, entry, options);
      consumed.push({ id: entry.id, fields: entry.fields, outcome });
    }
    return { consumer, messages: consumed, empty: consumed.length === 0 };
  });
}`,
        },
      ],
    },
    {
      id: 'messaging:delivery-guarantees',
      title: 'Delivery guarantees, and the exactly-once myth',
      lead:
        'Every messaging system offers at-most-once or at-least-once — physics allows nothing else. What you really choose is which failure you prefer, and what your consumers must tolerate.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:delivery-guarantees:spectrum',
          body: `THE SPECTRUM, honestly. AT-MOST-ONCE: send and forget — Redis pub/sub, an ack-less fire. A crash anywhere loses messages and nothing redelivers; right for signals ("invalidate this cache"), wrong for anything you would miss. AT-LEAST-ONCE: the broker delivers, the consumer ACKS only after processing, and anything un-acked is redelivered — crashes lose nothing but can DUPLICATE, because a worker may finish the work and die before the ack, and the redelivery runs it again. Those are the only two options. "EXACTLY-ONCE", as a marketing line, is the myth this topic keeps puncturing: even Kafka's exactly-once semantics are exactly-once WITHIN Kafka's transaction scope — broker-side state to broker-side state. Stretch the path across your database, your broker, and a third-party API — the shape of every real system — and no atomic transaction spans it; you are back to at-least-once delivery, and correctness moves to the consumer (idempotency and dedup, the second-to-last section). The outbox exhibit below manufactures the duplicate ON PURPOSE so you watch it happen rather than take it on faith.

ACK DISCIPLINE and the POISON path. The rule the quote below enforces: XACK LAST — after the side effects, never before; acknowledging before processing is at-most-once wearing an at-least-once costume. With ack:false, the lab processes a message and skips the ack deliberately: the entry stays in the group's PEL (pending entries list) — delivered but not acknowledged — which is exactly the state a crashed worker leaves behind, and the raw material for the next section. A message that keeps FAILING must not retry forever: the lab carries a retryCount header, and because stream entries are IMMUTABLE (you cannot edit a pending entry's fields), retrying means re-queueing — appending a NEW entry with retryCount+1 and acking the old one. Once the budget is spent — three attempts, the same budget the Background Jobs queue gives, so the exhibits rhyme — the message moves to the DLQ STREAM and the original is acknowledged. Moved, not lost: the dead-letter entry keeps the original id, the payload, and the reason. A DLQ nobody watches is just a slower crash — the jobs topic said it first; it is no less true here.`,
        },
        {
          kind: 'code',
          id: 'messaging:delivery-guarantees:verbatim-process-one',
          language: 'ts',
          source: 'server/src/data/messaging/stream_service.ts',
          caption: 'Verbatim — one message, the whole contract: ack, leave-pending, requeue, dead-letter (data/messaging/stream_service.ts)',
          code: `/**
 * One message's worker logic — the whole delivery contract in one place:
 * succeed → XACK; success + ack:false → leave pending (a PEL entry appears);
 * failure → requeue with retryCount+1, or the DLQ once the budget is spent.
 */
async function processOne(client: Redis, entry: StreamEntry, options: ConsumeOptions): Promise<ConsumeOutcome> {
  if (options.simulateFailure === true) {
    if (entry.fields.retryCount + 1 >= MAX_DELIVERY_ATTEMPTS) {
      // Poison confirmed: this attempt spends the last of the budget. Move it,
      // don't lose it — the DLQ entry keeps the original id for the postmortem.
      await client.xadd(
        STREAM_DLQ_KEY,
        'MAXLEN',
        '~',
        STREAM_MAXLEN,
        '*',
        ...fieldsForXadd({ ...entry.fields, retryCount: entry.fields.retryCount + 1 }),
        'originalId',
        entry.id,
        'deadAt',
        new Date().toISOString(),
        'reason',
        \`failed all \${String(MAX_DELIVERY_ATTEMPTS)} allowed attempts\`,
      );
      await client.xack(STREAM_LAB_KEY, STREAM_LAB_GROUP, entry.id);
      return 'dead-lettered';
    }
    // Retry via re-queue: a NEW entry with retryCount+1 (stream entries are
    // immutable — a pending entry's headers cannot be edited in place), then
    // XACK the old one so it leaves the PEL. Redelivery, at-least-once.
    await client.xadd(
      STREAM_LAB_KEY,
      // …the same MAXLEN-trimmed XADD, re-added with retryCount+1 and a fresh producedAt…
    );
    await client.xack(STREAM_LAB_KEY, STREAM_LAB_GROUP, entry.id);
    return 'requeued';
  }
  if (options.ack === false) {
    return 'left-pending'; // processed, but the worker "died" before XACK
  }
  await client.xack(STREAM_LAB_KEY, STREAM_LAB_GROUP, entry.id);
  return 'acked';
}`,
        },
      ],
    },
    {
      id: 'messaging:visibility-timeout',
      title: 'Pending entries and the visibility timeout',
      lead:
        'A consumer that reads a message and dies before acking leaves it pending — forever, unless someone takes it back. The pending-entries list plus a minimum idle time is the visibility timeout: how a stream stays correct when workers crash.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:visibility-timeout:mechanics',
          body: `THE PEL is the stream's conscience. Every delivery moves an entry into the group's PENDING ENTRIES LIST; every XACK removes it. A healthy worker's entries pass through in milliseconds; a crashed worker's stay — and XPENDING reads them two ways: a group-level summary (total pending, split per consumer — "worker-1 owes three") and per-entry rows carrying the owning consumer, IDLE MILLISECONDS since delivery, and a DELIVERY COUNT. That idle number is the VISIBILITY-TIMEOUT CLOCK: it is how a live consumer decides a dead one's work is ripe to take over. Amazon SQS formalizes the same idea — a delivered message becomes invisible for a visibility timeout, then reappears if it was never acknowledged — and the trade-off is identical in both.

XAUTOCLAIM is the takeover. Hand it a minimum idle time and it re-assigns every pending entry idle at least that long to a live consumer; the delivery count increments (proof the message was handed out again — watch it climb on a poison message), and the lab then ACKS each reclaimed entry, finishing the recovery the dead worker never managed. CHOOSING THE THRESHOLD is a real decision, not a default to accept: longer than your worst legitimate processing time — or you steal live work and process it twice, the classic visibility-timeout bug — but shorter than how long you can tolerate a message being stuck. One edge the quote handles honestly: entries whose ids were TRIMMED from the stream (MAXLEN claimed them) come back with NULL fields — there is nothing left to re-deliver, their ack is moot, and XAUTOCLAIM's third reply element lists them so the PEL can be cleaned.`,
        },
        {
          kind: 'code',
          id: 'messaging:visibility-timeout:verbatim-autoclaim',
          language: 'ts',
          source: 'server/src/data/messaging/stream_service.ts',
          caption: 'Verbatim — XPENDING\'s row shape, then XAUTOCLAIM: reclaim and finish (data/messaging/stream_service.ts)',
          code: `export interface PendingEntry {
  readonly id: string;
  /** The consumer that claimed it and never acked. */
  readonly consumer: string;
  /** Milliseconds since delivery — the visibility-timeout clock. */
  readonly idleMs: number;
  /** How many times XREADGROUP handed it out (each reclaim increments it). */
  readonly deliveries: number;
}

// …XPENDING fills those rows; then, when the clock has run long enough:

/**
 * The visibility-timeout lesson in one command: XAUTOCLAIM takes every pending
 * message idle >= minIdleMs and re-assigns it to \`consumer\` (its delivery
 * count increments — proof it was handed out again). The lab then ACKs each
 * reclaimed message, completing the recovery the dead worker never managed.
 * Entries whose ids were trimmed from the stream come back with NULL fields —
 * dropped here, their ack is moot (XAUTOCLAIM's third reply element lists them).
 */
export async function reclaimStale(
  minIdleMs: number,
  consumer = 'worker-2',
): Promise<Result<ReclaimResult, Failure>> {
  return runOnClient('reclaiming stale pending messages (XAUTOCLAIM)', async (client) => {
    const raw = (await client.xautoclaim(
      STREAM_LAB_KEY,
      STREAM_LAB_GROUP,
      consumer,
      minIdleMs,
      '0-0',
      'COUNT',
      CONSUME_BATCH_LIMIT,
    )) as unknown as readonly [string, readonly RawEntry[], readonly string[]];

    const [nextCursor, claimedRaw] = raw;
    const reclaimed: { id: string; fields: StreamMessageHeaders; acked: boolean }[] = [];
    for (const entry of entriesFromRaw(claimedRaw ?? [])) {
      const acked = (await client.xack(STREAM_LAB_KEY, STREAM_LAB_GROUP, entry.id)) === 1;
      reclaimed.push({ id: entry.id, fields: entry.fields, acked });
    }
    return { consumer, minIdleMs, reclaimed, nextCursor: nextCursor ?? '0-0' };
  });
}`,
        },
      ],
    },
    {
      id: 'messaging:outbox',
      title: 'The transactional outbox',
      lead:
        'The database commit and the message publish are two systems, and no transaction spans them. The outbox pattern stops pretending otherwise: write the message INTO the database next to the change, and let a relay move it out afterwards.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:outbox:dual-write',
          body: `THE DUAL-WRITE PROBLEM, precisely: one request needs TWO systems to change — the database (a post's new title) and the broker (the post.updated event). Sequence them either way and a crash in between corrupts one of them forever. Update-then-publish, crash between: the database says the change happened and NO EVENT EVER SHIPS — every downstream quietly diverges, and because the failure is invisible (nothing errors, the rows just disagree), it can go unnoticed for days, which is what makes it vicious. Publish-then-update, crash between: consumers receive an event describing a change that ROLLED BACK. Wrapping both writes in one transaction is impossible — nothing spans SQLite and Redis — so the pattern stops trying: if you cannot publish atomically with the change, make the publish A ROW IN THE SAME DATABASE.

ENQUEUE, the first half: the business write and an outbox row — topic, payload, timestamps — commit inside ONE better-sqlite3 transaction, so a row exists IF AND ONLY IF its change committed. That equivalence is the entire correctness claim, and the crashBetweenWrites knob exists to attack it: it throws from INSIDE the transaction, between the two writes, and the demo (and the spec) watch both roll back — no title change, no phantom row. The schema, in the migration below, is deliberately boring — with one non-boring detail: the PARTIAL index covers only unpublished rows, because "what is due?" is the relay's one hot query and the growing archive of shipped rows should never pay for it.`,
        },
        {
          kind: 'code',
          id: 'messaging:outbox:verbatim-enqueue',
          language: 'ts',
          source: 'server/src/data/messaging/outbox_service.ts',
          caption: 'Verbatim — enqueue: the business write and its event row, one transaction (data/messaging/outbox_service.ts)',
          code: `/**
 * The pattern's first half: change the post AND enqueue its event, atomically.
 * Returns undefined when the post does not exist; throws only when
 * crashBetweenWrites is set (from INSIDE the transaction — better-sqlite3
 * rolls both writes back, which is exactly what the demo observes).
 */
export function enqueuePostUpdateWithOutbox(
  db: Database.Database,
  input: OutboxEnqueueInput,
): OutboxEnqueueResult | undefined {
  const updateWithOutbox = db.transaction((): OutboxEnqueueResult | undefined => {
    const before = db.prepare(SELECT_POST_SQL).get(input.postId) as PostRow | undefined;
    if (before === undefined) return undefined;

    const now = new Date().toISOString();
    const after: PostRow = { ...before, title: input.title, updated_at: now };
    db.prepare(UPDATE_POST_TITLE_SQL).run(after.title, after.updated_at, before.id);

    if (input.crashBetweenWrites) {
      throw new Error('simulated crash between the post UPDATE and the outbox INSERT');
    }

    const payload: OutboxPayload = {
      postId: before.id,
      title: input.title,
      changedBy: input.changedBy,
      changedAt: now,
    };
    const insert = db
      .prepare(INSERT_OUTBOX_SQL)
      .run(input.topic ?? DEFAULT_OUTBOX_TOPIC, JSON.stringify(payload), now, now);
    const row = db.prepare(SELECT_ONE_SQL).get(Number(insert.lastInsertRowid)) as OutboxSqliteRow;

    return { before, after, outboxRow: toOutboxRow(row) };
  });
  return updateWithOutbox();
}`,
        },
        {
          kind: 'code',
          id: 'messaging:outbox:verbatim-migration',
          language: 'sql',
          source: 'server/src/data/migrations/0008_create_outbox.sql',
          caption: 'Verbatim — the outbox table and its due-index (data/migrations/0008_create_outbox.sql)',
          code: `-- 0008 — the transactional outbox: rows describing messages a relay must
-- ship to the message stream, written in the SAME transaction as the business
-- change they describe (a row exists if and only if its change committed).
-- published_at NULL = still to ship; attempts + next_attempt_at carry the
-- relay's own retry state (backoff pushes next_attempt_at into the future).
-- Timestamps are UTC ISO-8601 TEXT, like every timestamp in this guide, and
-- the PARTIAL index serves the relay's one hot query — "what is due?" — over
-- only the still-unpublished rows, never the growing archive of shipped ones.

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL
);

CREATE INDEX idx_outbox_due ON outbox(next_attempt_at) WHERE published_at IS NULL;`,
        },
        {
          kind: 'text',
          id: 'messaging:outbox:relay',
          body: `THE RELAY, the second half: a separate loop that polls due rows (published_at IS NULL and next_attempt_at has arrived), XADDs each to the outbox stream, and only THEN marks the row published. THE ORDER IS THE LESSON. Mark before publish, crash between: the message never ships and never will — LOST. Publish before mark, crash between: the next relay run ships it AGAIN — DUPLICATED. Duplicates are the cheap failure: a consumer that dedupes by the outbox id (which the relay stamps onto every stream entry, precisely so it can) or is idempotent is correct under both orders; a lost message has no consumer-side rescue. So the relay publishes first — and the crashAfterPublish knob proves the duplicate live: the entry IS in the stream, the row still says due, and the next plain run ships it again. At-least-once, demonstrated rather than claimed.

The retry state lives in the row, not in memory. failPublish simulates a broker outage BEFORE any XADD: attempts increments and next_attempt_at moves monotonically into the future — exponential backoff, base 200ms — so a frantic re-run ships NOTHING until the backoff lapses. And the mark itself is GUARDED: the WHERE clause says published_at IS NULL, so a row is marked published at most once no matter how relay passes race it. The jitter-and-thundering-herd half of this story is the Background Jobs topic's; the shapes are identical, one layer down — this is the same lesson where the queue is a database table.`,
        },
        {
          kind: 'code',
          id: 'messaging:outbox:verbatim-relay',
          language: 'ts',
          source: 'server/src/data/messaging/outbox_service.ts',
          caption: 'Verbatim — the relay loop: publish first, mark after (data/messaging/outbox_service.ts)',
          code: `/**
 * One relay pass — poll, publish, mark, in THAT order. See the header for why
 * the order is the lesson. All outcomes are REPORTED, never thrown: a
 * simulated crash is a successful observation, not a 500.
 */
export async function runRelay(
  db: Database.Database,
  options: RelayOptions = {},
): Promise<Result<RelayResult, Failure>> {
  // …the redis null-check (the 503), the accumulators, then: poll the due rows…
  const due = (db.prepare(SELECT_DUE_SQL).all(new Date().toISOString(), RELAY_BATCH_LIMIT) as OutboxSqliteRow[]).map(
    toOutboxRow,
  );

  for (const row of due) {
    // …the failPublish branch: broker "down" — attempts+1, backoff pushed out…

    // PUBLISH first… (and detect the duplicate we may be about to create)
    const alreadyDelivered = (await existingDeliveries(client, row.id)) > 0;
    const entryId = (await client.xadd(OUTBOX_STREAM_KEY, '*', ...outboxStreamFields(row))) as string;

    if (options.crashAfterPublish === true) {
      // …then DIE before the mark. The entry IS in the stream; the row still
      // says unpublished; the next relay run ships it AGAIN. At-least-once,
      // demonstrated rather than claimed.
      crashedAfterPublish = { outboxId: row.id, entryId };
      break;
    }

    // …then mark, guarded so a message is marked published at most once.
    const marked =
      db
        .prepare('UPDATE outbox SET published_at = ? WHERE id = ? AND published_at IS NULL')
        .run(new Date().toISOString(), row.id).changes === 1;
    published.push({ outboxId: row.id, topic: row.topic, entryId, alreadyDelivered, markedPublished: marked });
  }`,
        },
      ],
    },
    {
      id: 'messaging:idempotent-consumers',
      title: 'Idempotent consumers: exactly-once, the achievable version',
      lead:
        'Since every honest delivery guarantee is at-least-once, correctness moves to the consumer: processing the same message twice must leave the same state as once. That is the price of admission.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:idempotent-consumers:discipline',
          body: `TWO TOOLS. DEDUPLICATION: stamp every message with a stable id — the relay stamps outboxId onto every entry — and have the consumer keep a seen-set, a table of processed ids checked inside the consumer's OWN transaction, so the second delivery is a no-op. The quoted detector is the demo-scale version: it scans the stream for an existing delivery rather than keeping a window, and its own comment says so — a real relay keeps a bounded dedupe window, or trusts idempotent consumers entirely, because at real volume the consumer is the only party that knows what it actually processed.

IDEMPOTENCY BY CONSTRUCTION, the stronger tool: make the operation naturally safe to repeat. UPSERT by id replays harmlessly; SET absolute values ("status = shipped") rather than deltas ("count = count + 1"); key side effects by their cause (a payment's idempotency key, not "charge now") so a duplicate maps to the same effect. This is the same discipline the Background Jobs topic demanded of every handler and the same reason HTTP idempotency keys exist — messaging just makes duplicates frequent enough that you cannot ignore them. Which is the honest resolution of the exactly-once myth: AT-LEAST-ONCE DELIVERY plus AN IDEMPOTENT CONSUMER equals exactly-once EFFECT, observed from outside. The myth dies; the effect is real and shippable — and the outbox demo's duplicate-then-dedupe walkthrough is those two halves running on one screen.`,
        },
        {
          kind: 'code',
          id: 'messaging:idempotent-consumers:verbatim-dedup',
          language: 'ts',
          source: 'server/src/data/messaging/outbox_service.ts',
          caption: 'Verbatim — the duplicate detector and the relay\'s backoff (data/messaging/outbox_service.ts)',
          code: `/** Exponential backoff in milliseconds for the attempt about to be recorded. */
export function relayBackoffMs(attempts: number): number {
  return OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

/**
 * How many entries the outbox stream already carries for one outbox id — the
 * duplicate detector. An O(n) XRANGE scan is honest at demo scale; a real
 * relay keeps a bounded dedupe window or trusts idempotent consumers.
 */
async function existingDeliveries(client: Redis, outboxId: number): Promise<number> {
  const entries = (await client.xrange(OUTBOX_STREAM_KEY, '-', '+')) as [string, string[]][];
  return entries.filter(([, flat]) => {
    // Pair the flat field array and compare the outboxId FIELD — never a loose
    // includes(), which would false-positive on any field that happens to
    // equal the id as a string.
    for (let index = 0; index + 1 < flat.length; index += 2) {
      if (flat[index] === 'outboxId' && flat[index + 1] === String(outboxId)) return true;
    }
    return false;
  }).length;
}`,
        },
      ],
    },
    {
      id: 'messaging:live',
      title: 'See it live',
      lead:
        'Two consoles over the real endpoints: the stream lab walks produce, consume, pending, reclaim and the DLQ with every Redis command visible in the responses; the outbox exhibit walks enqueue, relay, crash-after-publish, and the duplicate\u2019s recovery.',
      blocks: [
        {
          kind: 'text',
          id: 'messaging:live:stream-intro',
          body: `THE STREAM CONSOLE is the lab's whole lifecycle over the real endpoints under /api/demo/msg/. PRODUCE appends with XADD — the minted <ms>-<seq> id and the stream length come back in the 201. CONSUME runs one worker pass with three knobs: a consumer name (any string — this is how you impersonate worker-2), ack false to process-and-not-acknowledge (the crash-before-ack lesson; one PEL entry appears), and fail true to fail processing on purpose (watch the requeued outcome carry retryCount+1, then the dead-lettered outcome on the third strike). PENDING renders XPENDING's two views — the per-consumer summary, then one row per entry with the idle clock ticking. RECLAIM posts XAUTOCLAIM with a minimum idle you choose and shows the takeover: entries moved to a live consumer, delivery counts incremented, acks closed. DLQ lists the dead-letter stream — original ids, payloads, reasons. INFO is XINFO's honest two numbers: stream length plus each group's pending count and last-delivered id, which is how you answer "are consumers keeping up?". RESET hands the next run a virgin lab, and the curl block does the same tour from a terminal.`,
        },
        {
          kind: 'demo',
          id: 'messaging:live:stream-demo',
          demoId: 'msg:stream',
          title: 'Stream console',
          description:
            'Produce to the Redis stream, consume as any named worker with ack and fail knobs, watch the pending-entries idle clock, reclaim a dead worker\'s message with XAUTOCLAIM, and walk a poison message into the dead-letter stream — every step against the real /api/demo/msg/stream endpoints. Needs the optional redis service; without it the endpoints answer the canonical 503 and say how to start it.',
        },
        {
          kind: 'code',
          id: 'messaging:live:stream-curl',
          language: 'bash',
          caption: 'The stream lab from a terminal — produce, consume, crash-before-ack, reclaim, poison, DLQ',
          code: `# 0. a virgin lab first (DEL both streams + XGROUP CREATE MKSTREAM):
curl -s -X POST localhost:4000/api/demo/msg/stream/reset -H 'content-type: application/json' -d '{}' > /dev/null

# 1. produce — XADD mints the <ms>-<seq> id; MAXLEN keeps the log bounded:
curl -s -X POST localhost:4000/api/demo/msg/stream/produce \\
  -H 'content-type: application/json' \\
  -d '{"message":{"text":"hello stream lab"}}' | jq '{id, streamLength}'

# 2. consume as worker-1 — XREADGROUP '>' + XACK, the happy path:
curl -s -X POST localhost:4000/api/demo/msg/stream/consume \\
  -H 'content-type: application/json' -d '{"consumer":"worker-1"}' | jq '.messages[]'

# 3. crash-before-ack: process but never acknowledge — one PEL entry:
curl -s -X POST localhost:4000/api/demo/msg/stream/produce \\
  -H 'content-type: application/json' -d '{}' > /dev/null
curl -s -X POST localhost:4000/api/demo/msg/stream/consume \\
  -H 'content-type: application/json' -d '{"consumer":"worker-1","ack":false}' | jq '.messages[].outcome'

# 4. the pending entries — idle milliseconds IS the visibility-timeout clock:
curl -s localhost:4000/api/demo/msg/stream/pending | jq

# 5. reclaim: XAUTOCLAIM moves entries idle >= minIdleMs to worker-2, then acks:
curl -s -X POST localhost:4000/api/demo/msg/stream/reclaim \\
  -H 'content-type: application/json' -d '{"consumer":"worker-2","minIdleMs":1000}' | jq

# 6. a poison message: produce, then fail it THREE times (budget = 3) -> DLQ:
curl -s -X POST localhost:4000/api/demo/msg/stream/produce \\
  -H 'content-type: application/json' -d '{}' > /dev/null
for i in 1 2 3; do
  curl -s -X POST localhost:4000/api/demo/msg/stream/consume \\
    -H 'content-type: application/json' \\
    -d '{"consumer":"worker-1","fail":true}' | jq -c '.messages[] | {outcome, retryCount: .fields.retryCount}'
done
curl -s localhost:4000/api/demo/msg/stream/dlq | jq '.entries[0].fields'

# 7. the two numbers that say whether consumers keep up, then reset:
curl -s localhost:4000/api/demo/msg/stream/info | jq
curl -s -X POST localhost:4000/api/demo/msg/stream/reset -H 'content-type: application/json' -d '{}' | jq`,
        },
        {
          kind: 'text',
          id: 'messaging:live:outbox-intro',
          body: `THE OUTBOX CONSOLE walks the second artifact end to end. ENQUEUE renames a seeded post and writes its event row in ONE transaction — with a crash toggle that throws between the two writes and rolls BOTH back (enqueued false, the ledger count unchanged: the dual-write problem solved, then re-broken on purpose so you see both states). The LEDGER is the outbox table itself: published_at NULL means "the relay owes this"; attempts and next_attempt_at are the relay's own retry state. RELAY runs one pass, with two independent lessons on toggles — crashAfterPublish dies between publish and mark (the row stays due; run the relay again plainly and the duplicate ships, alreadyDelivered true, two stream entries sharing one outbox id), and failPublish simulates the broker down before any publish (attempts increments, backoff pushes the next attempt out, and an immediate re-run ships nothing). THE STREAM view is where the duplicate becomes visible — and the recovery, dedupe by outbox id, is the idempotent-consumer section running live.`,
        },
        {
          kind: 'demo',
          id: 'messaging:live:outbox-demo',
          demoId: 'msg:outbox',
          title: 'Outbox console',
          description:
            'The transactional outbox end to end: enqueue a post update and its event row in one transaction (or crash between the writes and watch both roll back), run the relay to ship due rows, crash after publish and re-run to deliver the at-least-once duplicate, then dedupe by outbox id — against the real /api/demo/msg/outbox endpoints. The ledger always works (pure sqlite); publishing needs the optional redis service.',
        },
        {
          kind: 'code',
          id: 'messaging:live:outbox-curl',
          language: 'bash',
          caption: 'The outbox exhibit from a terminal — enqueue, the rollback, the relay, the duplicate, the backoff',
          code: `# 0. a virgin outbox (fresh in-memory handle + empty stream):
curl -s -X POST localhost:4000/api/demo/msg/outbox/reset -H 'content-type: application/json' -d '{}' > /dev/null

# 1. enqueue: post update + outbox row in ONE transaction:
curl -s -X POST localhost:4000/api/demo/msg/outbox/enqueue \\
  -H 'content-type: application/json' \\
  -d '{"title":"Layers keep concerns apart (revised)","changedBy":"curl"}' | jq '{enqueued, rolledBack, outboxRowCount}'

# 2. the dual-write crash: same endpoint, crash between the writes — BOTH roll back:
curl -s -X POST localhost:4000/api/demo/msg/outbox/enqueue \\
  -H 'content-type: application/json' \\
  -d '{"title":"never happens","crash":true}' | jq '{enqueued, rolledBack, outboxRowCount}'

# 3. the relay — poll, XADD, mark, in that order: one shipped event:
curl -s -X POST localhost:4000/api/demo/msg/outbox/relay \\
  -H 'content-type: application/json' -d '{}' | jq '.note'

# 4. the duplicate, demonstrated: enqueue, crash AFTER publish…
curl -s -X POST localhost:4000/api/demo/msg/outbox/enqueue \\
  -H 'content-type: application/json' -d '{}' > /dev/null
curl -s -X POST localhost:4000/api/demo/msg/outbox/relay \\
  -H 'content-type: application/json' -d '{"crashAfterPublish":true}' | jq '.crashedAfterPublish, .note'
# …the row is still due, so a plain re-run ships it AGAIN (at-least-once):
curl -s -X POST localhost:4000/api/demo/msg/outbox/relay \\
  -H 'content-type: application/json' -d '{}' | jq '.published[] | {outboxId, alreadyDelivered}'
# two entries share the outbox id — the duplicate, delivered:
curl -s localhost:4000/api/demo/msg/outbox/stream | jq '[.entries[].outboxId]'

# 5. broker down before any publish: attempts+1, backoff pushed out —
#    an immediate re-run ships NOTHING until the backoff lapses:
curl -s -X POST localhost:4000/api/demo/msg/outbox/enqueue \\
  -H 'content-type: application/json' -d '{}' > /dev/null
curl -s -X POST localhost:4000/api/demo/msg/outbox/relay \\
  -H 'content-type: application/json' -d '{"failPublish":true}' | jq '.failedRetries, .note'

# 6. the ledger, then a clean slate:
curl -s localhost:4000/api/demo/msg/outbox | jq '.rows[0] | {id, topic, publishedAt, attempts, nextAttemptAt}'
curl -s -X POST localhost:4000/api/demo/msg/outbox/reset -H 'content-type: application/json' -d '{}' | jq`,
        },
      ],
    },
  ],
};
