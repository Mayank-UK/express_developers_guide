import type { Redis } from 'ioredis';
import { type Failure } from '../../core/error_handling/failures.js';
import { type Result } from '../../core/result/result.js';
import { runOnClient } from '../redis/error_classification.js';

/**
 * The Redis STREAM lab — the messaging topic's core artifact, wrapping one
 * stream end-to-end with the commands a real consumer-group deployment uses:
 *
 *   XADD (with MAXLEN trimming)           → produce
 *   XGROUP CREATE … MKSTREAM              → the consumer group (BUSYGROUP is
 *                                            the expected reply once it exists)
 *   XREADGROUP GROUP g c COUNT n … >      → consume NEW messages as consumer c
 *   XACK                                  → acknowledge (finish the message)
 *   XPENDING (summary + extended form)    → per-message idle + delivery counts
 *   XAUTOCLAIM                            → reclaim messages whose consumer
 *                                            died (the visibility-timeout lesson)
 *   XADD to a dead-letter stream + XACK   → the poison-message DLQ path
 *
 * Conventions carried in code, not prose:
 * - Delivery is AT-LEAST-ONCE. Not acking (or dying before the ack) leaves the
 *   message in the group's PEL (pending entries list) — it is not lost, and
 *   XAUTOCLAIM hands it to a live consumer after min-idle-time.
 * - A message that keeps failing is NOT retried forever: a retryCount header
 *   increments on every failed attempt (via re-queue — stream entries are
 *   immutable), and once the total budget is spent (MAX_DELIVERY_ATTEMPTS, the
 *   same 3-attempt budget the jobs topic's queue gives, so the exhibits rhyme)
 *   the message moves to the DLQ stream and the original is acknowledged.
 * - "Exactly-once" is a myth: the transactional-outbox exhibit next door
 *   PRODUCES the duplicate on purpose. Consumers dedupe by id or stay idempotent.
 *
 * Same Result/Failure discipline as data/redis/redis_playground.ts — literally:
 * the runOnClient helper and the ioredis error classification are IMPORTED
 * from data/redis/error_classification.ts, the one seam every redis-backed
 * data service shares, so the degradation behavior can never drift between
 * them. Methods never throw for expected outcomes; redis absent →
 * 'unavailable' (503), any other ioredis error → 'internal'. Keys live under
 * the guide:demo: namespace (the FLUSH-safety boundary) and the reset deletes
 * ONLY this lab's two keys.
 */

/** The lab's stream — new work lands here via XADD. */
export const STREAM_LAB_KEY = 'guide:demo:stream:lab';
/** The dead-letter stream — poison messages land here once the retry budget is spent. */
export const STREAM_DLQ_KEY = 'guide:demo:stream:dlq';
/** The consumer group every lab consumer belongs to. */
export const STREAM_LAB_GROUP = 'lab-workers';
/** Default consumer name for the consume endpoint. */
export const STREAM_DEFAULT_CONSUMER = 'worker-1';
/** Approximate MAXLEN trim — a stream is a log, and an unbounded log is an outage. */
export const STREAM_MAXLEN = 1000;
/** Total delivery attempts before a message is dead-lettered (jobs-queue parity). */
export const MAX_DELIVERY_ATTEMPTS = 3;
/** How many messages one consume call takes at most. */
export const CONSUME_BATCH_LIMIT = 10;

/** The headers every lab message carries, plus the DLQ extras a dead letter gains. */
export interface StreamMessageHeaders {
  /** The caller's payload, JSON-encoded at the XADD boundary. */
  readonly payload: unknown;
  /** Failed attempts so far (0 on first delivery) — the poison counter. */
  readonly retryCount: number;
  /** UTC ISO stamp of the producing XADD. */
  readonly producedAt: string;
  /** DLQ only: the stream entry id the dead letter was moved from. */
  readonly originalId?: string;
  /** DLQ only: when it was moved. */
  readonly deadAt?: string;
  /** DLQ only: why it was moved. */
  readonly reason?: string;
}

export interface ProduceResult {
  /** The entry id Redis minted (<ms>-<seq>) — the message id consumers see. */
  readonly id: string;
  readonly fields: StreamMessageHeaders;
  readonly streamLength: number;
}

export type ConsumeOutcome =
  | 'acked' // processed → XACK: the happy path
  | 'left-pending' // processed but ack:false — the crash-before-ack simulation
  | 'requeued' // failed, budget left → re-added with retryCount+1, original acked
  | 'dead-lettered'; // failed, budget spent → DLQ + XACK

export interface ConsumedMessage {
  readonly id: string;
  readonly fields: StreamMessageHeaders;
  readonly outcome: ConsumeOutcome;
}

export interface ConsumeResult {
  readonly consumer: string;
  readonly messages: readonly ConsumedMessage[];
  /** True when XREADGROUP had nothing NEW to deliver (the '>' read came back empty). */
  readonly empty: boolean;
}

export interface PendingEntry {
  readonly id: string;
  /** The consumer that claimed it and never acked. */
  readonly consumer: string;
  /** Milliseconds since delivery — the visibility-timeout clock. */
  readonly idleMs: number;
  /** How many times XREADGROUP handed it out (each reclaim increments it). */
  readonly deliveries: number;
}

export interface PendingResult {
  /** XPENDING's group-level summary: total pending + per-consumer split. */
  readonly summary: {
    readonly total: number;
    readonly perConsumer: readonly { consumer: string; count: number }[];
  };
  readonly entries: readonly PendingEntry[];
}

export interface ReclaimResult {
  readonly consumer: string;
  readonly minIdleMs: number;
  /** Messages XAUTOCLAIM moved to this consumer — each then acked, closing the loop. */
  readonly reclaimed: readonly { id: string; fields: StreamMessageHeaders; acked: boolean }[];
  /** The cursor a follow-up call would start from ('0-0' when drained). */
  readonly nextCursor: string;
}

export interface StreamEntry {
  readonly id: string;
  readonly fields: StreamMessageHeaders;
}

export interface StreamInfo {
  readonly stream: {
    readonly key: string;
    readonly length: number;
    readonly lastGeneratedId: string | null;
  };
  readonly dlq: { readonly key: string; readonly length: number };
  readonly groups: readonly {
    readonly name: string;
    readonly consumers: number;
    readonly pending: number;
    readonly lastDeliveredId: string;
  }[];
}

// The ioredis boundary itself — runOnClient and the error-name → failure
// classification — lives in data/redis/error_classification.ts, imported at
// the top: this lab and the redis playground share ONE implementation.

// --- field (de)serialization ---------------------------------------------------------

/** RESP2 carries stream fields as a flat [k1, v1, k2, v2, …] — pair them up. */
function pairsToRecord(flat: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index + 1 < flat.length; index += 2) {
    record[flat[index] as string] = flat[index + 1] as string;
  }
  return record;
}

function headersFromRaw(raw: Record<string, string>): StreamMessageHeaders {
  const retryCount = Number(raw['retryCount'] ?? '0');
  return {
    payload: raw['payload'] === undefined ? null : (JSON.parse(raw['payload']) as unknown),
    retryCount: Number.isFinite(retryCount) ? retryCount : 0,
    producedAt: raw['producedAt'] ?? '',
    ...(raw['originalId'] !== undefined && { originalId: raw['originalId'] }),
    ...(raw['deadAt'] !== undefined && { deadAt: raw['deadAt'] }),
    ...(raw['reason'] !== undefined && { reason: raw['reason'] }),
  };
}

function fieldsForXadd(headers: StreamMessageHeaders): string[] {
  return [
    'payload',
    JSON.stringify(headers.payload),
    'retryCount',
    String(headers.retryCount),
    'producedAt',
    headers.producedAt,
  ];
}

/** Raw entry shape from XREADGROUP/XAUTOCLAIM/XRANGE; fields are NULL for trimmed entries. */
type RawEntry = readonly [string, readonly string[] | null];

function entriesFromRaw(raw: readonly RawEntry[]): StreamEntry[] {
  return raw
    .filter(([, fields]) => fields !== null)
    .map(([id, fields]) => ({ id, fields: headersFromRaw(pairsToRecord(fields as readonly string[])) }));
}

/** XINFO replies are flat [key, value, …] pairs; keep the scalar ones we read. */
function scalarFields(raw: readonly unknown[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const key = String(raw[index]);
    const value = raw[index + 1];
    if (typeof value === 'string' || typeof value === 'number') record[key] = String(value);
  }
  return record;
}

// --- stream + group bootstrap --------------------------------------------------------

/**
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
}

// --- consume -------------------------------------------------------------------------

export interface ConsumeOptions {
  readonly consumer?: string;
  readonly count?: number;
  /** false leaves successfully processed messages PENDING (the crash lesson). */
  readonly ack?: boolean;
  /** true = every processed message fails (the poison/retry/DLQ lesson). */
  readonly simulateFailure?: boolean;
}

export async function consumeAsWorker(options: ConsumeOptions = {}): Promise<Result<ConsumeResult, Failure>> {
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
}

/**
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
        `failed all ${String(MAX_DELIVERY_ATTEMPTS)} allowed attempts`,
      );
      await client.xack(STREAM_LAB_KEY, STREAM_LAB_GROUP, entry.id);
      return 'dead-lettered';
    }
    // Retry via re-queue: a NEW entry with retryCount+1 (stream entries are
    // immutable — a pending entry's headers cannot be edited in place), then
    // XACK the old one so it leaves the PEL. Redelivery, at-least-once.
    await client.xadd(
      STREAM_LAB_KEY,
      'MAXLEN',
      '~',
      STREAM_MAXLEN,
      '*',
      ...fieldsForXadd({
        ...entry.fields,
        retryCount: entry.fields.retryCount + 1,
        producedAt: new Date().toISOString(),
      }),
    );
    await client.xack(STREAM_LAB_KEY, STREAM_LAB_GROUP, entry.id);
    return 'requeued';
  }
  if (options.ack === false) {
    return 'left-pending'; // processed, but the worker "died" before XACK
  }
  await client.xack(STREAM_LAB_KEY, STREAM_LAB_GROUP, entry.id);
  return 'acked';
}

// --- pending inspection --------------------------------------------------------------

/**
 * XPENDING twice, honestly: the group-level summary (total + per-consumer
 * split), then the extended form for per-message rows — id, owning consumer,
 * idle milliseconds, delivery count. The IDLE number is the visibility-timeout
 * clock a reclaimer must wait out; the entry shape is [id, consumer, idle,
 * deliveries] (verified live by the spec, not against docs).
 */
export async function inspectPending(consumer?: string): Promise<Result<PendingResult, Failure>> {
  return runOnClient('inspecting pending entries (XPENDING)', async (client) => {
    const summaryRaw = await client.xpending(STREAM_LAB_KEY, STREAM_LAB_GROUP);
    const [total, , , perConsumerRaw] = normalizePendingSummary(summaryRaw);
    // RESP2 bulk strings throughout — Number() the count (live-redis verified:
    // the summary answers count as "1", not 1).
    const perConsumer = perConsumerRaw.map(([name, count]) => ({ consumer: name, count: Number(count) }));

    const LIMIT = String(CONSUME_BATCH_LIMIT * 10);
    const entriesRaw = (consumer === undefined
      ? await client.xpending(STREAM_LAB_KEY, STREAM_LAB_GROUP, '-', '+', LIMIT)
      : await client.xpending(STREAM_LAB_KEY, STREAM_LAB_GROUP, '-', '+', LIMIT, consumer)
    ) as PendingEntryRow[];

    return {
      summary: { total, perConsumer },
      entries: entriesRaw.map((row) => ({
        id: row[0],
        consumer: row[1],
        idleMs: Number(row[2]),
        deliveries: Number(row[3]),
      })),
    };
  });
}

type PendingSummary = readonly [total: unknown, minId: unknown, maxId: unknown, perConsumer: unknown];
type PendingEntryRow = readonly [id: string, consumer: string, idleMs: string, deliveries: string];

function normalizePendingSummary(raw: readonly unknown[]): [number, string | null, string | null, [string, unknown][]] {
  const [total, min, max, perConsumer] = raw;
  return [
    Number(total ?? 0),
    typeof min === 'string' ? min : null,
    typeof max === 'string' ? max : null,
    Array.isArray(perConsumer) ? (perConsumer as [string, unknown][]) : [],
  ];
}

// --- reclaim (XAUTOCLAIM) --------------------------------------------------------------

/**
 * The visibility-timeout lesson in one command: XAUTOCLAIM takes every pending
 * message idle >= minIdleMs and re-assigns it to `consumer` (its delivery
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
}

// --- DLQ + info + reset ----------------------------------------------------------------

export async function listDlq(): Promise<Result<readonly StreamEntry[], Failure>> {
  return runOnClient('reading the dead-letter stream (XRANGE)', async (client) =>
    entriesFromRaw(await client.xrange(STREAM_DLQ_KEY, '-', '+')),
  );
}

export async function streamInfo(): Promise<Result<StreamInfo, Failure>> {
  return runOnClient('inspecting the stream (XINFO)', async (client) => {
    const streamRaw = (await client.xinfo('STREAM', STREAM_LAB_KEY)) as unknown as readonly unknown[];
    const stream = scalarFields(streamRaw);
    const groupsRaw = (await client.xinfo('GROUPS', STREAM_LAB_KEY)) as unknown as readonly unknown[][];
    const groups = groupsRaw.map((rawGroup) => {
      const group = scalarFields(rawGroup);
      return {
        name: group['name'] ?? '',
        consumers: Number(group['consumers'] ?? '0'),
        pending: Number(group['pending'] ?? '0'),
        lastDeliveredId: group['last-delivered-id'] ?? '0-0',
      };
    });
    const dlqLength = await client.xlen(STREAM_DLQ_KEY);
    return {
      stream: {
        key: STREAM_LAB_KEY,
        length: Number(stream['length'] ?? '0'),
        lastGeneratedId: stream['last-generated-id'] ?? null,
      },
      dlq: { key: STREAM_DLQ_KEY, length: dlqLength },
      groups,
    };
  });
}

/**
 * The lab's reset: DEL both streams (the group dies with its stream) and
 * recreate the group with MKSTREAM — the next produce starts virgin. Specs
 * call this before AND after their scenarios for isolation.
 */
export async function resetStreamLab(): Promise<Result<{ readonly reset: boolean }, Failure>> {
  return runOnClient('resetting the stream lab', async (client) => {
    await client.del(STREAM_LAB_KEY, STREAM_DLQ_KEY);
    await ensureGroup(client); // BUSYGROUP cannot happen right after DEL — kept for symmetry
    return { reset: true };
  });
}
