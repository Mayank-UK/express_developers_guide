import type Database from 'better-sqlite3';
import type { Redis } from 'ioredis';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import { logger } from '../../core/logging/logger.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import { getRedisClient } from '../redis/redis_client.js';
import { classifyRedisError } from '../redis/error_classification.js';
import type { PostRow } from '../posts/post_dao.js';
import { openSqlDepthDatabase } from '../sql_depth/sql_depth_database.js';

/**
 * The TRANSACTIONAL OUTBOX — the messaging topic's second core artifact, in
 * its two halves:
 *
 * 1. ENQUEUE (pure sqlite, no redis anywhere): the business write (a seeded
 *    post's new title) and its outbox row commit inside ONE better-sqlite3
 *    transaction — an outbox row exists if and only if its change committed.
 *    Same atomic-multi-write shape as data/sql_depth/audit_writer.ts; the
 *    crashBetweenWrites flag throws between the two writes on purpose so the
 *    demo (and the spec) can watch both roll back.
 *
 * 2. RELAY (sqlite + redis): poll the due rows (published_at IS NULL AND
 *    next_attempt_at <= now), XADD each to the outbox stream, and only THEN
 *    mark it published. The publish/mark order is the whole lesson:
 *    - mark BEFORE publish loses messages (crash between = the message never
 *      ships and never will),
 *    - publish BEFORE mark delivers DUPLICATES (crash between = the next run
 *      ships it again — at-least-once, proven live by crashAfterPublish),
 *    - and duplicates are the CHEAP failure: a consumer that dedupes by
 *      outbox id (or is idempotent) is correct under both. The relay stamps
 *      every stream entry with the outbox id precisely so consumers CAN.
 *
 * Failure handling: failPublish simulates a broker outage BEFORE any XADD —
 * the row stays unpublished, attempts increments, and next_attempt_at moves
 * monotonically into the future (exponential backoff, base 200ms), so a
 * frantic re-run publishes NOTHING until the backoff lapses.
 *
 * The outbox rows live on a process-global :memory: handle (the same
 * migrated-handle factory the sql-depth exhibits use — migrations 0001-0008
 * plus the shared SEED_POSTS; resetOutboxDatabase() recreates it for spec
 * isolation). The relay publishes to a DEDICATED stream so the stream lab's
 * state never bleeds into the outbox evidence.
 */

/** The stream the relay publishes to — entries carry the outbox id for dedup. */
export const OUTBOX_STREAM_KEY = 'guide:demo:stream:outbox';
/** Default topic for the demo's business events. */
export const DEFAULT_OUTBOX_TOPIC = 'post.updated';
/** Relay backoff base: attempt n retries in ~200ms × 2^(n-1). */
export const OUTBOX_BACKOFF_BASE_MS = 200;
/** One relay pass ships at most this many due rows (a batch, not a flood). */
export const RELAY_BATCH_LIMIT = 20;

// --- the process-global demo handle ---------------------------------------------------

let demoDb: Database.Database | undefined;

/** The outbox demo's dedicated in-memory handle (specs reset it for isolation). */
export function getOutboxDatabase(): Database.Database {
  demoDb ??= openSqlDepthDatabase();
  return demoDb;
}

/** Drops and recreates the in-memory handle: fresh posts, empty outbox. */
export function resetOutboxDatabase(): void {
  demoDb?.close();
  demoDb = openSqlDepthDatabase();
}

/**
 * Graceful shutdown: close the demo handle WITHOUT reopening — unlike
 * resetOutboxDatabase (which keeps a virgin handle live for the next spec),
 * this leaves the module unopened, so the next getOutboxDatabase() pays the
 * migration cost again. A :memory: database cannot outlive its handle, so
 * closing it is the whole point; the rows' published state was process-local
 * demo state anyway. Idempotent — safe when the demo never ran.
 */
export function closeOutboxDatabase(): void {
  // Same defensive shape as closeSqlite: drop the handle even if close()
  // throws, so a later getOutboxDatabase() reopens rather than handing back
  // a half-closed one.
  try {
    demoDb?.close();
  } finally {
    demoDb = undefined;
  }
}

// One relay pass at a time (single-flight): without the guard, two
// overlapping passes can both poll the same due rows and XADD them before
// either's published_at mark lands — double-shipping every row in the
// overlap window. The guard only prevents CONCURRENT passes; the pattern's
// at-least-once duplicate semantics (crash after publish → the next pass
// ships the row again) are unchanged.
let relayInFlight = false;

// --- half 1: enqueue inside the business transaction ----------------------------------

const SELECT_POST_SQL = 'SELECT id, title, body, author, created_at, updated_at FROM posts WHERE id = ?';
const UPDATE_POST_TITLE_SQL = 'UPDATE posts SET title = ?, updated_at = ? WHERE id = ?';
const INSERT_OUTBOX_SQL = `
  INSERT INTO outbox (topic, payload, created_at, published_at, attempts, next_attempt_at)
  VALUES (?, ?, ?, NULL, 0, ?)
`;
const SELECT_DUE_SQL = `
  SELECT id, topic, payload, created_at, published_at, attempts, next_attempt_at
  FROM outbox
  WHERE published_at IS NULL AND next_attempt_at <= ?
  ORDER BY id
  LIMIT ?
`;
const SELECT_NOT_DUE_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL AND next_attempt_at > ?
`;
const SELECT_ALL_SQL = `
  SELECT id, topic, payload, created_at, published_at, attempts, next_attempt_at
  FROM outbox
  ORDER BY id
`;
const SELECT_ONE_SQL = `
  SELECT id, topic, payload, created_at, published_at, attempts, next_attempt_at
  FROM outbox
  WHERE id = ?
`;

/** The stable payload shape — fixed key order, so the JSON reads cleanly. */
export interface OutboxPayload {
  readonly postId: string;
  readonly title: string;
  readonly changedBy: string;
  readonly changedAt: string;
}

export interface OutboxRow {
  readonly id: number;
  readonly topic: string;
  readonly payload: OutboxPayload;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: string;
}

interface OutboxSqliteRow {
  id: number;
  topic: string;
  payload: string;
  created_at: string;
  published_at: string | null;
  attempts: number;
  next_attempt_at: string;
}

function toOutboxRow(row: OutboxSqliteRow): OutboxRow {
  return {
    id: row.id,
    topic: row.topic,
    payload: JSON.parse(row.payload) as OutboxPayload,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

export interface OutboxEnqueueInput {
  readonly postId: string;
  readonly title: string;
  readonly changedBy: string;
  readonly topic?: string;
  /** Throw between the post UPDATE and the outbox INSERT — both must roll back. */
  readonly crashBetweenWrites?: boolean;
}

export interface OutboxEnqueueResult {
  readonly before: PostRow;
  readonly after: PostRow;
  readonly outboxRow: OutboxRow;
}

/**
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
}

/** Every outbox row, oldest first — the demo's ledger view. */
export function listOutboxRows(db: Database.Database): readonly OutboxRow[] {
  return (db.prepare(SELECT_ALL_SQL).all() as OutboxSqliteRow[]).map(toOutboxRow);
}

// --- half 2: the relay -----------------------------------------------------------------

export interface RelayOptions {
  /** Publish the first due row, then "die" before marking it — duplicate bait. */
  readonly crashAfterPublish?: boolean;
  /** Simulate a broker outage BEFORE any XADD: attempts+1, backoff pushed out. */
  readonly failPublish?: boolean;
}

export interface RelayPublishOutcome {
  readonly outboxId: number;
  readonly topic: string;
  /** The stream entry id this run minted. */
  readonly entryId: string;
  /** True when the stream ALREADY carried this outbox id — the at-least-once duplicate. */
  readonly alreadyDelivered: boolean;
  readonly markedPublished: boolean;
}

export interface RelayResult {
  readonly published: readonly RelayPublishOutcome[];
  readonly failedRetries: readonly { outboxId: number; attempts: number; nextAttemptAt: string }[];
  /** Unpublished rows whose backoff has not lapsed — the reason a re-run ships nothing. */
  readonly skippedNotDue: number;
  /** Present when crashAfterPublish struck: the row is IN the stream but still unpublished. */
  readonly crashedAfterPublish: { readonly outboxId: number; readonly entryId: string } | null;
  readonly note: string;
}

// Mid-flight ioredis errors classify through the shared seam every redis-backed
// data service uses (data/redis/error_classification.ts): offline-ish error
// names → the 503 'unavailable' degradation, everything else → 'internal'.

/** Exponential backoff in milliseconds for the attempt about to be recorded. */
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
}

function outboxStreamFields(row: OutboxRow): string[] {
  return [
    'topic',
    row.topic,
    'payload',
    JSON.stringify(row.payload),
    'outboxId',
    String(row.id),
    'publishedAt',
    new Date().toISOString(),
  ];
}

/**
 * One relay pass — poll, publish, mark, in THAT order. See the header for why
 * the order is the lesson. All outcomes are REPORTED, never thrown: a
 * simulated crash is a successful observation, not a 500.
 */
export async function runRelay(
  db: Database.Database,
  options: RelayOptions = {},
): Promise<Result<RelayResult, Failure>> {
  // Single-flight: a pass launched while one is already running returns
  // without shipping anything — the in-flight pass owns the due rows, and
  // overlapping passes would double-ship them before the published_at guard
  // can mark (the guard below closes the CONCURRENCY window, not the
  // at-least-once duplicates the crash knobs still demonstrate). Reported
  // like every other relay outcome, never thrown.
  if (relayInFlight) {
    logger.info('outbox relay pass already in flight — the concurrent call ships nothing');
    return ok({
      published: [],
      failedRetries: [],
      skippedNotDue: 0,
      crashedAfterPublish: null,
      note: 'another relay pass was already in flight — this call shipped nothing, so two passes cannot double-ship the same due rows before the published_at guard marks them. At-least-once delivery semantics are unchanged.',
    });
  }
  relayInFlight = true;
  try {
    const client = await getRedisClient();
    if (client === null) {
      return fail(
        failure(
          'unavailable',
          'Redis is not configured or not reachable — the relay cannot publish. Start it with `docker compose -f .docker/docker-compose.yml up -d redis` and retry',
          { service: 'redis' },
        ),
      );
    }

    try {
      const published: RelayPublishOutcome[] = [];
      const failedRetries: { outboxId: number; attempts: number; nextAttemptAt: string }[] = [];
      let crashedAfterPublish: { outboxId: number; entryId: string } | null = null;

      const due = (db.prepare(SELECT_DUE_SQL).all(new Date().toISOString(), RELAY_BATCH_LIMIT) as OutboxSqliteRow[]).map(
        toOutboxRow,
      );

      for (const row of due) {
        if (options.failPublish === true) {
          // Broker "down" before any publish: count the attempt, push the retry
          // monotonically into the future, ship nothing. next_attempt_at only
          // ever moves forward — now >= the row's due time by the query itself.
          const attempts = row.attempts + 1;
          const nextAttemptAt = new Date(Date.now() + relayBackoffMs(attempts)).toISOString();
          db.prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?').run(
            attempts,
            nextAttemptAt,
            row.id,
          );
          failedRetries.push({ outboxId: row.id, attempts, nextAttemptAt });
          continue;
        }

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
      }

      const skippedNotDue = (
        db.prepare(SELECT_NOT_DUE_COUNT_SQL).get(new Date().toISOString()) as { n: number }
      ).n;

      return ok({
        published,
        failedRetries,
        skippedNotDue,
        crashedAfterPublish,
        note:
          crashedAfterPublish !== null
            ? 'published, then crashed BEFORE marking published — the row is still due, so the next relay run will deliver it AGAIN. That is at-least-once: consumers dedupe by outboxId or stay idempotent.'
            : failedRetries.length > 0
              ? 'the broker was "down" before any publish: attempts incremented and next_attempt_at moved monotonically out (backoff), so an immediate re-run ships nothing until it lapses.'
              : 'due rows were XADDed to the stream and only then marked published — publish-before-mark loses duplicates at worst, never messages.',
      });
    } catch (cause) {
      return fail(classifyRedisError('running the outbox relay', cause));
    }
  } finally {
    relayInFlight = false;
  }
}

export interface OutboxStreamEntry {
  readonly id: string;
  readonly topic: string;
  readonly payload: OutboxPayload;
  readonly outboxId: number;
  readonly publishedAt: string;
}

/** The outbox stream, oldest first — where the duplicate becomes visible. */
export async function listOutboxStream(): Promise<Result<readonly OutboxStreamEntry[], Failure>> {
  const client = await getRedisClient();
  if (client === null) {
    return fail(
      failure('unavailable', 'Redis is not configured or not reachable — the outbox stream cannot be read', {
        service: 'redis',
      }),
    );
  }
  try {
    const raw = (await client.xrange(OUTBOX_STREAM_KEY, '-', '+')) as [string, string[]][];
    const entries: OutboxStreamEntry[] = raw.map(([id, flat]) => {
      const fields: Record<string, string> = {};
      for (let index = 0; index + 1 < flat.length; index += 2) fields[flat[index] as string] = flat[index + 1] as string;
      return {
        id,
        topic: fields['topic'] ?? '',
        payload: JSON.parse(fields['payload'] ?? '{}') as OutboxPayload,
        outboxId: Number(fields['outboxId'] ?? '0'),
        publishedAt: fields['publishedAt'] ?? '',
      };
    });
    return ok(entries);
  } catch (cause) {
    return fail(classifyRedisError('reading the outbox stream', cause));
  }
}

/** The outbox exhibit's reset: fresh handle AND a deleted outbox stream. */
export async function resetOutboxLab(): Promise<Result<{ readonly reset: boolean }, Failure>> {
  resetOutboxDatabase();
  const client = await getRedisClient();
  if (client === null) {
    return fail(
      failure('unavailable', 'Redis is not configured or not reachable — the outbox stream cannot be reset', {
        service: 'redis',
      }),
    );
  }
  try {
    await client.del(OUTBOX_STREAM_KEY);
    return ok({ reset: true });
  } catch (cause) {
    return fail(classifyRedisError('resetting the outbox stream', cause));
  }
}
