import mongoose from 'mongoose';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import { EVENT_TTL_SECONDS, getEventModel, type EventKind } from './event_model.js';

/**
 * The Event repository — the port-style wrapper the mongo routes call, in the
 * exact shape of the posts pipeline: methods return Result<_, Failure>, never
 * throw, and translate every mongoose error into the app's ONE taxonomy:
 *
 *   - connection absent/offline  → 'unavailable' (503 — the demo degrades)
 *   - mongoose ValidationError  → 'validation' (400, normalized errors[])
 *   - anything else             → 'internal' (500, cause attached)
 *
 * The routes above it stay thin controllers that only map Result → HTTP.
 */

export interface RecordEventInput {
  readonly kind: EventKind;
  readonly page: string;
  readonly visitor: string;
  readonly meta?: unknown;
}

/** What a lean read returns — dates pre-serialized to ISO strings. */
export interface EventListItem {
  readonly id: string;
  readonly kind: EventKind;
  readonly page: string;
  readonly visitor: string;
  readonly meta: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventListOptions {
  readonly limit: number;
  readonly kind?: EventKind;
}

export interface EventStats {
  readonly count: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly ttlSeconds: number;
  /** Name of the TTL index mongod actually holds, or null before it exists. */
  readonly ttlIndex: string | null;
}

export interface ClearResult {
  readonly deletedCount: number;
}

/** The one failure every method returns when the optional service is absent. */
export function mongoUnavailableFailure(): Failure {
  return failure(
    'unavailable',
    'MongoDB is not configured or not reachable — start it with `docker compose -f .docker/docker-compose.yml up -d mongo` and retry',
    { service: 'mongo' },
  );
}

function toListItem(raw: Record<string, unknown>): EventListItem {
  return {
    id: String(raw._id),
    kind: raw.kind as EventKind,
    page: String(raw.page),
    visitor: String(raw.visitor),
    meta: raw.meta,
    createdAt: new Date(raw.createdAt as Date).toISOString(),
    updatedAt: new Date(raw.updatedAt as Date).toISOString(),
  };
}

/**
 * Translates anything thrown by the driver. Server-selection/network failures
 * mean "the optional service is gone RIGHT NOW" (unavailable), a ValidationError
 * is user input, everything else is internal with the cause attached.
 */
function toRepositoryFailure(operation: string, cause: unknown): Failure {
  if (cause instanceof mongoose.Error.ValidationError) {
    return failure(
      'validation',
      `event failed mongoose validation (${String(Object.keys(cause.errors).length)} field error(s))`,
      { errors: validationErrors(cause), engine: 'mongoose' },
      cause,
    );
  }
  const name = cause instanceof Error ? cause.name : String(cause);
  if (/ServerSelection|NetworkTimeout|MongoNetworkErrorTopology|TopologyClosed/.test(name)) {
    return failure('unavailable', `mongo became unreachable while ${operation}`, { service: 'mongo' }, cause);
  }
  return failure('internal', `${operation} failed in mongo`, { operation }, cause);
}

/** Normalizes mongoose's ValidationError.errors into the app's [{field, message}]. */
function validationErrors(error: mongoose.Error.ValidationError): { field: string; message: string }[] {
  return Object.entries(error.errors).map(([field, issue]) => ({
    field,
    message: issue.message,
  }));
}

export async function recordEvent(input: RecordEventInput): Promise<Result<EventListItem, Failure>> {
  const model = await getEventModel();
  if (model === null) return fail(mongoUnavailableFailure());

  try {
    // Schema validation runs HERE, client-side in the driver, before any wire
    // round-trip — the topic's "validation lives in your process" point.
    const created = await model.create({
      kind: input.kind,
      page: input.page,
      visitor: input.visitor,
      ...(input.meta !== undefined && { meta: input.meta }),
    });
    return ok(
      toListItem(created.toObject() as unknown as Record<string, unknown>),
    );
  } catch (cause) {
    return fail(toRepositoryFailure('recording an event', cause));
  }
}

export async function listEvents(options: EventListOptions): Promise<Result<readonly EventListItem[], Failure>> {
  const model = await getEventModel();
  if (model === null) return fail(mongoUnavailableFailure());

  try {
    const rows = (await model
      .find(options.kind === undefined ? {} : { kind: options.kind })
      .sort({ createdAt: -1 }) // newest first — what the demo console renders
      .limit(options.limit)
      .lean()) as unknown as Record<string, unknown>[];
    return ok(rows.map(toListItem));
  } catch (cause) {
    return fail(toRepositoryFailure('listing events', cause));
  }
}

export async function eventStats(): Promise<Result<EventStats, Failure>> {
  const model = await getEventModel();
  if (model === null) return fail(mongoUnavailableFailure());

  try {
    // init() is idempotent: the first call builds the declared indexes (the
    // TTL index included) and creates the collection; later calls return
    // immediately. Without it, listIndexes() could race index creation.
    await model.init();

    const [count, oldest, newest, indexes] = await Promise.all([
      model.countDocuments(),
      model.findOne().sort({ createdAt: 1 }).lean(),
      model.findOne().sort({ createdAt: -1 }).lean(),
      model.listIndexes() as Promise<{ name: string; expireAfterSeconds?: number }[]>,
    ]);
    const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);

    return ok({
      count,
      oldest: oldest === null ? null : new Date((oldest as unknown as Record<string, unknown>).createdAt as Date).toISOString(),
      newest: newest === null ? null : new Date((newest as unknown as Record<string, unknown>).createdAt as Date).toISOString(),
      ttlSeconds: EVENT_TTL_SECONDS,
      ttlIndex: ttl?.name ?? null,
    });
  } catch (cause) {
    return fail(toRepositoryFailure('computing event stats', cause));
  }
}

export async function clearEvents(): Promise<Result<ClearResult, Failure>> {
  const model = await getEventModel();
  if (model === null) return fail(mongoUnavailableFailure());

  try {
    const result = await model.deleteMany({});
    return ok({ deletedCount: result.deletedCount });
  } catch (cause) {
    return fail(toRepositoryFailure('clearing the events collection', cause));
  }
}
