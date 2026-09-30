import { Router, type Request, type Response } from 'express';
import { NotFoundException, ValidationException, failureToException } from '../../core/error_handling/exceptions.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  STREAM_DEFAULT_CONSUMER,
  consumeAsWorker,
  inspectPending,
  listDlq,
  produceToStream,
  reclaimStale,
  resetStreamLab,
  streamInfo,
} from '../../data/messaging/stream_service.js';
import {
  enqueuePostUpdateWithOutbox,
  getOutboxDatabase,
  listOutboxRows,
  listOutboxStream,
  resetOutboxLab,
  runRelay,
} from '../../data/messaging/outbox_service.js';
import { findPost } from '../../data/sql_depth/audit_writer.js';

/**
 * The messaging topics' live demo endpoints — the Redis stream lab and the
 * transactional outbox, the two artifacts data/messaging/ implements.
 *
 * - POST /api/demo/msg/stream/produce   {message?}            → XADD (MAXLEN-trimmed), 201 + entry id
 * - POST /api/demo/msg/stream/consume   {consumer?, count?, ack?, fail?} → XREADGROUP '>' as a worker;
 *                                                                     ack:false leaves pending, fail drives retry/DLQ
 * - GET  /api/demo/msg/stream/pending   [?consumer=]          → XPENDING summary + per-entry idle/deliveries
 * - POST /api/demo/msg/stream/reclaim   {consumer?, minIdleMs?} → XAUTOCLAIM of stale pending + XACK
 * - GET  /api/demo/msg/stream/dlq                             → the dead-letter stream (XRANGE)
 * - GET  /api/demo/msg/stream/info                            → length/groups/last-id of stream + DLQ
 * - POST /api/demo/msg/stream/reset                           → DEL + recreate group (spec isolation)
 * - POST /api/demo/msg/outbox/enqueue  {title?, postId?, crash?} → post update + outbox row in ONE transaction
 * - GET  /api/demo/msg/outbox                                 → the outbox ledger (sqlite, always works)
 * - POST /api/demo/msg/outbox/relay    {crashAfterPublish?, failPublish?} → poll, XADD, mark — in that order
 * - GET  /api/demo/msg/outbox/stream                         → the outbox stream (where duplicates show)
 * - POST /api/demo/msg/outbox/reset                           → fresh handle + empty stream
 *
 * Dependency-rule note (the documented teaching-exhibit exception, same as
 * the other data-exhibit routers): these routes import data/messaging/
 * because the mechanism itself — XADD, XREADGROUP, XPENDING, XAUTOCLAIM, the
 * outbox transaction — is the artifact being taught.
 *
 * Error policy follows the exhibit convention: redis absent answers the
 * canonical 503 envelope (optional service), malformed input answers 400,
 * unknown post ids 404 — and every DELIBERATE failure (crash, poison
 * message, crash-after-publish) is a successful OBSERVATION and answers 200
 * with the evidence, exactly like the audit demo's crash=1 rollback.
 */

export const MESSAGING_DEMO_MOUNT_PATH = '/api/demo/msg';

const DEFAULT_MESSAGE = { text: 'hello from the stream lab' };
const MESSAGE_MAX_LENGTH = 500;
const CONSUMER_NAME_MAX_LENGTH = 60;
const TITLE_MAX_LENGTH = 200;
const CHANGED_BY_MAX_LENGTH = 60;
const DEFAULT_POST_ID = SEED_POSTS[0]!.id;

// --- input helpers (thin-controller parse step) --------------------------------------

function readObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationException('the body must be a JSON object', {
      errors: [{ field: '$', message: 'must be a JSON object' }],
    });
  }
  return body as Record<string, unknown>;
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
  fallback: string | undefined,
  maxLength: number,
): string {
  const raw = record[field];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw new ValidationException(`"${field}" is required`, { parameter: field });
    }
    return fallback;
  }
  if (typeof raw !== 'string') {
    throw new ValidationException(`"${field}" must be a string`, { parameter: field, received: typeof raw });
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new ValidationException(`"${field}" must not be blank`, { parameter: field });
  }
  if (trimmed.length > maxLength) {
    throw new ValidationException(`"${field}" must be at most ${String(maxLength)} characters`, {
      parameter: field,
    });
  }
  return trimmed;
}

function readPositiveIntField(
  record: Record<string, unknown>,
  field: string,
  fallback: number,
  max: number,
): number {
  const raw = record[field];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) {
    throw new ValidationException(`"${field}" must be a whole number between 1 and ${String(max)}`, {
      parameter: field,
      received: String(raw),
    });
  }
  return raw;
}

function readBooleanField(record: Record<string, unknown>, field: string): boolean {
  const raw = record[field];
  if (raw === undefined || raw === '') return false;
  if (typeof raw !== 'boolean') {
    throw new ValidationException(`"${field}" must be a boolean`, { parameter: field, received: typeof raw });
  }
  return raw;
}

/** The consume endpoint's ack knob: present-and-false leaves messages pending. */
function readAckField(record: Record<string, unknown>): boolean {
  const raw = record.ack;
  if (raw === undefined || raw === '') return true;
  if (typeof raw !== 'boolean') {
    throw new ValidationException('"ack" must be a boolean (false leaves processed messages pending)', {
      parameter: 'ack',
      received: typeof raw,
    });
  }
  return raw;
}

function readOptionalConsumer(record: Record<string, unknown>): string {
  return readStringField(record, 'consumer', STREAM_DEFAULT_CONSUMER, CONSUMER_NAME_MAX_LENGTH);
}

// --- the stream lab controllers --------------------------------------------------------

async function produceController(req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req.body);
  const message = body.message === undefined ? DEFAULT_MESSAGE : body.message;
  // The payload is opaque to the lab (any JSON rides along); only its size is bounded.
  const serialized = JSON.stringify(message);
  if (serialized.length > MESSAGE_MAX_LENGTH * 4) {
    throw new ValidationException(`"message" is too large to be a teaching payload (max ~${String(MESSAGE_MAX_LENGTH * 4)} serialized characters)`, {
      parameter: 'message',
    });
  }
  const result = await produceToStream(message);
  if (!result.ok) throw failureToException(result.error);
  res.status(201).json({
    ...result.value,
    maxlen: '~1000 (XADD MAXLEN trims oldest entries)',
    note: 'XADD minted the id <ms>-<seq> and appended the fields — a stream is an append-only log; MAXLEN ~ keeps it bounded.',
  });
}

async function consumeController(req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req.body);
  const result = await consumeAsWorker({
    consumer: readOptionalConsumer(body),
    count: readPositiveIntField(body, 'count', 1, 10),
    ack: readAckField(body),
    simulateFailure: readBooleanField(body, 'fail'),
  });
  if (!result.ok) throw failureToException(result.error);
  res.json({
    ...result.value,
    attempts: MAX_DELIVERY_ATTEMPTS,
    note: result.value.messages.some((message) => message.outcome === 'dead-lettered')
      ? 'the retry budget was spent: the message moved to the DLQ stream and the original was XACKed — moved, not lost.'
      : result.value.messages.some((message) => message.outcome === 'requeued')
        ? 'processing failed with budget left: re-queued as a NEW entry with retryCount+1 (entries are immutable), original XACKed.'
        : result.value.messages.some((message) => message.outcome === 'left-pending')
          ? 'processed but NOT acknowledged (ack:false) — the entry sits in the group PEL until acked or reclaimed.'
          : "XREADGROUP '>' delivered never-before-seen messages and XACK finished them — the happy path.",
  });
}

async function pendingController(req: Request, res: Response): Promise<void> {
  const raw = req.query.consumer;
  if (raw !== undefined && raw !== '' && typeof raw !== 'string') {
    throw new ValidationException('"consumer" must be a single query string', { parameter: 'consumer' });
  }
  const consumer = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
  if (consumer !== undefined && consumer.length > CONSUMER_NAME_MAX_LENGTH) {
    throw new ValidationException(`"consumer" must be at most ${String(CONSUMER_NAME_MAX_LENGTH)} characters`, {
      parameter: 'consumer',
    });
  }
  const result = await inspectPending(consumer);
  if (!result.ok) throw failureToException(result.error);
  res.json({
    ...result.value,
    note: 'XPENDING: the group summary plus one row per pending entry — id, the consumer holding it, idle milliseconds (the visibility-timeout clock), and how many times it has been delivered.',
  });
}

async function reclaimController(req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req.body);
  const result = await reclaimStale(
    readPositiveIntField(body, 'minIdleMs', 1, 3_600_000),
    readOptionalConsumer(body),
  );
  if (!result.ok) throw failureToException(result.error);
  res.json({
    ...result.value,
    note:
      result.value.reclaimed.length > 0
        ? 'XAUTOCLAIM moved entries idle >= minIdleMs to this consumer (their delivery count incremented) and the lab acked them — the crashed worker\'s message was processed after all.'
        : 'nothing was idle long enough to reclaim — raise minIdleMs, or create a pending entry first: consume {"ack":false}.',
  });
}

async function dlqController(_req: Request, res: Response): Promise<void> {
  const result = await listDlq();
  if (!result.ok) throw failureToException(result.error);
  res.json({
    entries: result.value,
    note: 'the dead-letter stream: every entry kept its original id, payload, and the reason it was moved. A DLQ is where humans look when the automatic path gives up.',
  });
}

async function streamInfoController(_req: Request, res: Response): Promise<void> {
  const result = await streamInfo();
  if (!result.ok) throw failureToException(result.error);
  res.json({
    ...result.value,
    note: 'XINFO STREAM + XINFO GROUPS: the length, the last-generated id, and per-group lag state — the two numbers that tell you whether consumers are keeping up.',
  });
}

async function streamResetController(_req: Request, res: Response): Promise<void> {
  const result = await resetStreamLab();
  if (!result.ok) throw failureToException(result.error);
  res.json({ ...result.value, note: 'DEL both streams + XGROUP CREATE MKSTREAM — a virgin lab for the next run.' });
}

// --- the transactional outbox controllers ----------------------------------------------

interface OutboxEnqueueBody {
  postId: string;
  title: string;
  changedBy: string;
  crash: boolean;
}

function readOutboxEnqueueBody(req: Request): OutboxEnqueueBody {
  const body = readObjectBody(req.body);
  return {
    postId: readStringField(body, 'postId', DEFAULT_POST_ID, 64),
    title: readStringField(body, 'title', 'Layers keep concerns apart (revised)', TITLE_MAX_LENGTH),
    changedBy: readStringField(body, 'changedBy', 'the demo editor', CHANGED_BY_MAX_LENGTH),
    crash: readBooleanField(body, 'crash'),
  };
}

function outboxEnqueueController(req: Request, res: Response): void {
  const input = readOutboxEnqueueBody(req);
  const db = getOutboxDatabase();
  if (findPost(db, input.postId) === undefined) {
    throw new NotFoundException(`no post with id "${input.postId}"`, { postId: input.postId });
  }

  let result;
  if (input.crash) {
    try {
      result = enqueuePostUpdateWithOutbox(db, { ...input, crashBetweenWrites: true });
    } catch {
      // The deliberate throw INSIDE the transaction already rolled both writes
      // back — observing that rollback IS this endpoint's job.
    }
  } else {
    result = enqueuePostUpdateWithOutbox(db, input);
  }

  const rows = listOutboxRows(db);
  const after = findPost(db, input.postId)!; // the row existed moments ago
  res.json({
    crash: input.crash,
    enqueued: result !== undefined,
    rolledBack: input.crash && result === undefined,
    post: { id: input.postId, title: after.title },
    outboxRowCount: rows.length,
    outboxRows: rows,
    note: result !== undefined
      ? 'the posts UPDATE and the outbox INSERT committed in ONE transaction — the row exists if and only if the change did.'
      : 'the simulated crash hit BETWEEN the post UPDATE and the outbox INSERT; the transaction rolled back both — no change, no message queued. Dual-write problem: solved.',
  });
}

function outboxListController(_req: Request, res: Response): void {
  res.json({
    rows: listOutboxRows(getOutboxDatabase()),
    note: 'the outbox ledger: published_at NULL means the relay has not shipped it yet; attempts + next_attempt_at are the relay\'s own retry state.',
  });
}

async function outboxRelayController(req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req.body);
  const crashAfterPublish = readBooleanField(body, 'crashAfterPublish');
  const failPublish = readBooleanField(body, 'failPublish');
  if (crashAfterPublish && failPublish) {
    throw new ValidationException(
      '"crashAfterPublish" and "failPublish" are separate lessons — combine them and neither is observable',
      { parameters: ['crashAfterPublish', 'failPublish'] },
    );
  }
  const result = await runRelay(getOutboxDatabase(), { crashAfterPublish, failPublish });
  if (!result.ok) throw failureToException(result.error);
  res.json({ ...result.value, rows: listOutboxRows(getOutboxDatabase()) });
}

async function outboxStreamController(_req: Request, res: Response): Promise<void> {
  const result = await listOutboxStream();
  if (!result.ok) throw failureToException(result.error);
  res.json({
    entries: result.value,
    note: 'the relay\'s output stream — every entry stamped with its outbox id. Two entries sharing an outbox id = the at-least-once duplicate, delivered.',
  });
}

async function outboxResetController(_req: Request, res: Response): Promise<void> {
  const result = await resetOutboxLab();
  if (!result.ok) throw failureToException(result.error);
  res.json({ ...result.value, note: 'fresh in-memory handle + empty outbox stream — a virgin outbox for the next run.' });
}

export const messagingDemoRouter = Router();
// Stream lab (demoId: msg:stream)
messagingDemoRouter.post('/demo/msg/stream/produce', produceController);
messagingDemoRouter.post('/demo/msg/stream/consume', consumeController);
messagingDemoRouter.get('/demo/msg/stream/pending', pendingController);
messagingDemoRouter.post('/demo/msg/stream/reclaim', reclaimController);
messagingDemoRouter.get('/demo/msg/stream/dlq', dlqController);
messagingDemoRouter.get('/demo/msg/stream/info', streamInfoController);
// Unauthenticated reset of shared demo state (stream + groups) — a deliberate
// DEMO affordance so any visitor can restore the fixture; production resets
// demand credentials. Never copy this into prod.
messagingDemoRouter.post('/demo/msg/stream/reset', streamResetController);
// Transactional outbox (demoId: msg:outbox)
messagingDemoRouter.post('/demo/msg/outbox/enqueue', outboxEnqueueController);
messagingDemoRouter.get('/demo/msg/outbox', outboxListController);
messagingDemoRouter.post('/demo/msg/outbox/relay', outboxRelayController);
messagingDemoRouter.get('/demo/msg/outbox/stream', outboxStreamController);
// Unauthenticated reset of the outbox tables — same deliberate DEMO affordance
// as the stream reset above; never copy into prod.
messagingDemoRouter.post('/demo/msg/outbox/reset', outboxResetController);
