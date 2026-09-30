import { Router, type Request, type Response } from 'express';
import { ValidationException, failureToException } from '../../core/error_handling/exceptions.js';
// Deliberate teaching exception (the dependency rule is presentation → domain
// ← data; same note as db_demo_routes.ts): the Event repository IS the
// artifact this topic teaches, so its exhibit routes import the data layer
// directly.
import {
  describeMongoTarget,
  getMongoConnection,
  isMongoConfigured,
} from '../../data/mongo/mongo_client.js';
import { EVENT_KINDS, getEventModel, type EventKind } from '../../data/mongo/event_model.js';
import {
  clearEvents,
  eventStats,
  listEvents,
  recordEvent,
  type RecordEventInput,
} from '../../data/mongo/event_repository.js';

/**
 * The MongoDB topic's live demo endpoints — the only HTTP surface that talks
 * to the optional mongo service, always through the Event repository (same
 * Result/Failure discipline as the posts pipeline; these controllers only
 * parse input and map Result → HTTP).
 *
 * - GET    /api/demo/mongo/status         → { configured, connected, uri, model, indexes }
 * - POST   /api/demo/mongo/events         → 201 + the created event (or 400/503 envelopes)
 * - GET    /api/demo/mongo/events?limit&kind → { events, stats }
 * - DELETE /api/demo/mongo/events         → clears the collection (demo reset)
 *
 * Availability policy: the mongo service is OPTIONAL. With MONGO_URI unset or
 * the service down, every endpoint still answers — status reports off, the
 * data endpoints answer the canonical 503 unavailable envelope, and nothing
 * crashes or hangs (a down service fails fast after 1.5s of server selection).
 */

export const MONGO_DEMO_MOUNT_PATH = '/api/demo/mongo';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

// --- input parsing (thin-controller parse step; ValidationException on bad shape)

function readListLimit(query: Request['query']): number {
  const raw = query.limit;
  if (raw === undefined || raw === '') return DEFAULT_LIST_LIMIT;
  if (typeof raw !== 'string') {
    throw new ValidationException('"limit" must be a single query string', {
      parameter: 'limit',
      received: raw,
    });
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw new ValidationException(
      `"limit" must be an integer between 1 and ${String(MAX_LIST_LIMIT)}`,
      { parameter: 'limit', received: raw },
    );
  }
  return parsed;
}

function readKindFilter(query: Request['query']): EventKind | undefined {
  const raw = query.kind;
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !(EVENT_KINDS as readonly string[]).includes(raw)) {
    throw new ValidationException(
      `"kind" must be one of ${EVENT_KINDS.map((kind) => `"${kind}"`).join(', ')}`,
      { parameter: 'kind', received: raw },
    );
  }
  return raw as EventKind;
}

/** POST bodies: must be a JSON object; FIELD validation is deliberately left to mongoose. */
function readEventBody(body: unknown): RecordEventInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationException('the event payload must be a JSON object', {
      errors: [{ field: '$', message: 'must be a JSON object' }],
    });
  }
  const record = body as Record<string, unknown>;
  return {
    kind: record.kind,
    page: record.page,
    visitor: record.visitor,
    ...(record.meta !== undefined && { meta: record.meta }),
  } as RecordEventInput;
}

// --- controllers -----------------------------------------------------------------

async function statusController(_req: Request, res: Response): Promise<void> {
  // Fast path when the feature is off: no mongoose object is ever created.
  if (!isMongoConfigured()) {
    res.json({
      configured: false,
      connected: false,
      connectionState: 'disconnected',
      uri: '',
      model: 'Event',
      indexes: [],
      note: 'MONGO_URI is not set — the MongoDB feature is OFF by design. The app '
        + 'boots and every other topic works without a mongo service.',
    });
    return;
  }

  const connection = await getMongoConnection();
  const connected = connection !== null && connection.readyState === 1;

  // host/db ONLY — credentials in the configured URI never reach the response.
  const uri =
    connection !== null
      ? `${connection.host}:${String(connection.port)}/${connection.name}`
      : describeMongoTarget();

  let indexes: { name: string; key: Record<string, unknown>; expireAfterSeconds?: number }[] = [];
  if (connected) {
    try {
      const model = await getEventModel();
      if (model !== null) {
        await model.init(); // idempotent: builds the declared indexes first
        const raw = (await model.listIndexes()) as {
          name: string;
          key: Record<string, unknown>;
          expireAfterSeconds?: number;
        }[];
        indexes = raw.map((index) => ({
          name: index.name,
          key: index.key,
          ...(index.expireAfterSeconds !== undefined && { expireAfterSeconds: index.expireAfterSeconds }),
        }));
      }
    } catch {
      indexes = []; // status stays truthful even if introspection hiccups
    }
  }

  res.json({
    configured: true,
    connected,
    connectionState:
      connection === null
        ? 'disconnected'
        : (['disconnected', 'connected', 'connecting', 'disconnecting'][connection.readyState] ?? 'unknown'),
    uri,
    model: 'Event',
    indexes,
    note: connected
      ? `The TTL index (createdAt_1, expireAfterSeconds 60) makes documents vanish ~60s after `
        + 'creation — mongod\'s background deleter runs on its own lazy ~60s cadence.'
      : 'Configured but unreachable — the attempt failed fast (serverSelectionTimeoutMS 1500). '
        + 'Start the service (`docker compose -f .docker/docker-compose.yml up -d mongo`) and retry; '
        + 'failed attempts are not cached, so the demo recovers without a restart.',
  });
}

async function createEventController(req: Request, res: Response): Promise<void> {
  const input = readEventBody(req.body);
  const result = await recordEvent(input);
  if (!result.ok) throw failureToException(result.error);
  res.status(201).json({ event: result.value });
}

async function listEventsController(req: Request, res: Response): Promise<void> {
  const limit = readListLimit(req.query);
  const kind = readKindFilter(req.query);

  const [events, stats] = await Promise.all([listEvents({ limit, kind }), eventStats()]);
  if (!events.ok) throw failureToException(events.error);
  if (!stats.ok) throw failureToException(stats.error);
  res.json({ events: events.value, stats: stats.value });
}

async function clearEventsController(_req: Request, res: Response): Promise<void> {
  const result = await clearEvents();
  if (!result.ok) throw failureToException(result.error);
  res.json({ cleared: true, deletedCount: result.value.deletedCount });
}

export const mongoDemoRouter = Router();
mongoDemoRouter.get('/demo/mongo/status', statusController);
mongoDemoRouter.post('/demo/mongo/events', createEventController);
mongoDemoRouter.get('/demo/mongo/events', listEventsController);
mongoDemoRouter.delete('/demo/mongo/events', clearEventsController);
