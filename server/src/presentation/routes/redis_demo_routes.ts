import { Router, type Request, type Response } from 'express';
import { ValidationException, failureToException } from '../../core/error_handling/exceptions.js';
// Deliberate teaching exception (the dependency rule is presentation → domain
// ← data; same note as db_demo_routes.ts): the redis client and playground
// service ARE the artifact this topic teaches, so the exhibit routes import
// the data layer directly.
import {
  describeRedisTarget,
  getRedisClient,
  isRedisConfigured,
} from '../../data/redis/redis_client.js';
import {
  REDIS_DEMO_CHANNEL,
  ensureDemoSubscribed,
  inspectTtl,
  listReceivedMessages,
  publish,
  runStructureTour,
  setWithTtl,
} from '../../data/redis/redis_playground.js';

/**
 * The Redis topic's live demo endpoints — the only HTTP surface that talks to
 * the optional redis service, always through the playground service (same
 * Result/Failure discipline as the mongo routes; these controllers only parse
 * input and map Result → HTTP).
 *
 * - GET  /api/demo/redis/status            → { configured, connected, host, serverInfo }
 * - GET  /api/demo/redis/tour              → the structure tour transcript (command + reply per row)
 * - POST /api/demo/redis/ttl               → set a key with an expiry (201 + { key, value, seconds, setAt })
 * - GET  /api/demo/redis/ttl?key=          → { exists, ttlSecondsRemaining | null, value } — poll to watch it die
 * - POST /api/demo/redis/publish           → { receivers, received, messages } — PUBLISH + our own subscriber's view
 * - GET  /api/demo/redis/messages?channel= → the ring of what the server's OWN subscriber received
 *
 * Availability policy: the redis service is OPTIONAL. With REDIS_URL unset or
 * the service down, every endpoint still answers — status reports off, the
 * data endpoints answer the canonical 503 unavailable envelope, and nothing
 * crashes or hangs (a down service fails fast after ~1.2s of connect timeout).
 */

export const REDIS_DEMO_MOUNT_PATH = '/api/demo/redis';

const DEFAULT_TTL_KEY = 'ttl:watch';
const DEFAULT_TTL_VALUE = 'this key expires — watch the countdown';
const DEFAULT_TTL_SECONDS = 10;
const MAX_TTL_SECONDS = 600;
const DEFAULT_PUBLISH_MESSAGE = 'hello from the express guide';

// --- input parsing (thin-controller parse step; ValidationException on bad shape)

function readOptionalString(record: Record<string, unknown>, field: string, fallback: string, maxLength: number): string {
  const raw = record[field];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') {
    throw new ValidationException(`"${field}" must be a string`, {
      parameter: field,
      received: String(raw),
    });
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new ValidationException(`"${field}" must not be blank`, { parameter: field, received: raw });
  }
  if (trimmed.length > maxLength) {
    throw new ValidationException(`"${field}" must be at most ${String(maxLength)} characters`, {
      parameter: field,
      received: `${String(trimmed.length)} characters`,
    });
  }
  return trimmed;
}

/** POST bodies: must be a JSON object; FIELD validation is deliberately local. */
function readObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationException('the payload must be a JSON object', {
      errors: [{ field: '$', message: 'must be a JSON object' }],
    });
  }
  return body as Record<string, unknown>;
}

function readTtlBody(body: unknown): { key: string; value: string; seconds: number } {
  const record = readObjectBody(body);
  const secondsRaw = record.seconds;
  if (secondsRaw !== undefined && secondsRaw !== '') {
    const parsed = Number(secondsRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TTL_SECONDS) {
      throw new ValidationException(`"seconds" must be an integer between 1 and ${String(MAX_TTL_SECONDS)}`, {
        parameter: 'seconds',
        received: String(secondsRaw),
      });
    }
    return {
      key: readOptionalString(record, 'key', DEFAULT_TTL_KEY, 200),
      value: readOptionalString(record, 'value', DEFAULT_TTL_VALUE, 500),
      seconds: parsed,
    };
  }
  return {
    key: readOptionalString(record, 'key', DEFAULT_TTL_KEY, 200),
    value: readOptionalString(record, 'value', DEFAULT_TTL_VALUE, 500),
    seconds: DEFAULT_TTL_SECONDS,
  };
}

function readKeyQuery(query: Request['query']): string {
  const raw = query.key;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationException('"key" is required (a single non-empty query string)', {
      parameter: 'key',
      received: raw,
    });
  }
  if (raw.trim().length > 200) {
    throw new ValidationException('"key" must be at most 200 characters', {
      parameter: 'key',
      received: `${String(raw.trim().length)} characters`,
    });
  }
  // Deliberately NOT namespaced here — the service owns the guide:demo: prefix
  // (setWithTtl/inspectTtl apply it), so a bare name round-trips either way.
  return raw.trim();
}

function readChannelQuery(query: Request['query']): string | undefined {
  const raw = query.channel;
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationException('"channel" must be a single non-empty query string', {
      parameter: 'channel',
      received: raw,
    });
  }
  return raw.trim();
}

// --- controllers -------------------------------------------------------------------

function redisVersionFromInfo(info: string): string | null {
  const match = /redis_version:([^\r\n]+)/.exec(info);
  return match === null ? null : (match[1] ?? '').trim() || null;
}

async function statusController(_req: Request, res: Response): Promise<void> {
  // Fast path when the feature is off: no ioredis object is ever created.
  if (!isRedisConfigured()) {
    res.json({
      configured: false,
      connected: false,
      host: '',
      serverInfo: null,
      note: 'REDIS_URL is not set — the Redis feature is OFF by design. The app '
        + 'boots and every other topic works without a redis service.',
    });
    return;
  }

  const client = await getRedisClient();
  const connected = client !== null && client.status === 'ready';

  let serverInfo: { version: string } | null = null;
  if (connected) {
    try {
      serverInfo = { version: redisVersionFromInfo(await client.info('server')) ?? 'unknown' };
    } catch {
      serverInfo = null; // status stays truthful even if introspection hiccups
    }
  }

  res.json({
    configured: true,
    connected,
    host: describeRedisTarget(),
    serverInfo,
    note: connected
      ? 'One connection for commands, one for pub/sub (a SUBSCRIBEd connection must not carry '
        + 'regular commands). Every key this demo touches lives under guide:demo:*.'
      : 'Configured but unreachable — the attempt failed fast (connectTimeout ~1200ms, no '
        + 'reconnect loop). Start the service (`docker compose -f .docker/docker-compose.yml '
        + 'up -d redis`) and retry; failed attempts are not cached, so the demo recovers '
        + 'without a restart.',
  });
}

async function tourController(_req: Request, res: Response): Promise<void> {
  const result = await runStructureTour();
  if (!result.ok) throw failureToException(result.error);
  res.json({ steps: result.value });
}

async function setTtlController(req: Request, res: Response): Promise<void> {
  const input = readTtlBody(req.body);
  const result = await setWithTtl(input.key, input.value, input.seconds);
  if (!result.ok) throw failureToException(result.error);
  res.status(201).json(result.value);
}

async function getTtlController(req: Request, res: Response): Promise<void> {
  const key = readKeyQuery(req.query);
  const result = await inspectTtl(key);
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

async function publishController(req: Request, res: Response): Promise<void> {
  const record = readObjectBody(req.body);
  const channel = readOptionalString(record, 'channel', REDIS_DEMO_CHANNEL, 120);
  const message = readOptionalString(record, 'message', DEFAULT_PUBLISH_MESSAGE, 500);

  const result = await publish(channel, message);
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

async function messagesController(req: Request, res: Response): Promise<void> {
  const channel = readChannelQuery(req.query);
  // Subscribe BEFORE listing (idempotent) so the next publish round-trips even
  // if this is the first pub/sub call of the process.
  const subscribed = await ensureDemoSubscribed();
  if (!subscribed.ok) throw failureToException(subscribed.error);
  res.json({ channel: channel ?? REDIS_DEMO_CHANNEL, messages: listReceivedMessages(channel) });
}

export const redisDemoRouter = Router();
redisDemoRouter.get('/demo/redis/status', statusController);
redisDemoRouter.get('/demo/redis/tour', tourController);
redisDemoRouter.post('/demo/redis/ttl', setTtlController);
redisDemoRouter.get('/demo/redis/ttl', getTtlController);
redisDemoRouter.post('/demo/redis/publish', publishController);
redisDemoRouter.get('/demo/redis/messages', messagesController);
