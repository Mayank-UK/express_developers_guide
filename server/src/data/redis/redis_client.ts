import { Redis } from 'ioredis';
import { appConfig } from '../../core/config/app_config.js';
import { logger } from '../../core/logging/logger.js';

/**
 * Lazy ioredis client singletons — the Redis twin of the mongo connection in
 * data/mongo/mongo_client.ts, with the same optional-service contract:
 *
 * - Not configured (REDIS_URL === ''): resolves null IMMEDIATELY, without
 *   creating an ioredis object — importing this module connects nothing.
 * - Configured but unreachable: the attempt fails fast (connectTimeout 1200ms
 *   and NO reconnect loop), resolves null (never rejects), and the failed
 *   attempt is NOT cached — boot `docker compose up redis` after the server
 *   and the demo recovers without a restart.
 * - Configured and reachable: one cached connection per role for the process
 *   lifetime; shutdown closes both (closeRedis).
 *
 * TWO connections by design: once a connection SUBSCRIBEs it is in subscriber
 * mode and must not carry regular commands, so pub/sub gets its own dedicated
 * connection (created lazily on the first subscribe, never before).
 *
 * The 'error' listener is MANDATORY: ioredis is an EventEmitter, and without a
 * listener a socket failure surfaces as an unhandled 'error' event that kills
 * the process — the same rule the mongo client follows.
 */

/** Fail fast when the service is off: ~1.2s is the worst any caller waits. */
export const REDIS_CONNECT_TIMEOUT_MS = 1200;

/** The options every guide-owned connection shares (see the block comment). */
const REDIS_CLIENT_OPTIONS = {
  lazyConnect: true, // nothing connects until the first caller asks
  enableOfflineQueue: false, // commands on a dead connection reject, never queue
  maxRetriesPerRequest: 1, // no burst of retries piling up per command
  connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
  // The guide never silently reconnects: a lost connection surfaces as
  // failures (the demo degrades), and the next call opens a fresh client.
  retryStrategy: null,
} as const;

/** True when REDIS_URL names a server — false means the feature is off. */
export function isRedisConfigured(): boolean {
  return appConfig.redisUrl !== '';
}

let clientPromise: Promise<Redis | null> | undefined;
let subscriberPromise: Promise<Redis | null> | undefined;
// The resolved connections, for identity checks in the 'end' handler below:
// only the slot whose OWN connection died is dropped from the cache.
let activeClient: Redis | undefined;
let activeSubscriber: Redis | undefined;

/** The main (commands) connection — null when the optional service is off/away. */
export function getRedisClient(): Promise<Redis | null> {
  if (!isRedisConfigured()) {
    // Feature off: no ioredis object is ever created for this call path.
    return Promise.resolve(null);
  }
  clientPromise ??= attemptConnection('commands');
  return clientPromise;
}

/**
 * The dedicated subscriber connection for pub/sub — a SEPARATE socket, created
 * lazily on the first subscribe (never at boot), because a connection that has
 * issued SUBSCRIBE is in subscriber mode and must not run regular commands.
 */
export function getRedisSubscriber(): Promise<Redis | null> {
  if (!isRedisConfigured()) {
    return Promise.resolve(null);
  }
  subscriberPromise ??= attemptConnection('subscriber');
  return subscriberPromise;
}

function attemptConnection(role: 'commands' | 'subscriber'): Promise<Redis | null> {
  const client = new Redis(appConfig.redisUrl, REDIS_CLIENT_OPTIONS);

  // EventEmitter rule (mandatory): without a listener, a socket error becomes
  // an unhandled 'error' event and KILLS the process.
  client.on('error', (err: Error) => {
    logger.warn(
      { err: err.message, role },
      'redis connection error — the redis demo stays degraded until the service answers',
    );
  });
  // 'end' fires when the connection is gone for good (retryStrategy is null,
  // so ioredis never reconnects on its own). Drop ONLY this connection's cache
  // slot so the NEXT caller opens a fresh client — the demo recovers the
  // moment the service reappears (the other role's socket is untouched).
  client.on('end', () => {
    if (activeClient === client) {
      logger.warn({ role }, 'redis commands connection ended — the next call will reconnect');
      activeClient = undefined;
      clientPromise = undefined;
    }
    if (activeSubscriber === client) {
      logger.warn({ role }, 'redis subscriber connection ended — the next subscribe will reconnect');
      activeSubscriber = undefined;
      subscriberPromise = undefined;
    }
  });

  return client
    .connect()
    .then(() => {
      if (role === 'commands') activeClient = client;
      else activeSubscriber = client;
      logger.info(
        { target: describeRedisTarget(), role },
        'redis connected',
      );
      return client;
    })
    .catch((err: Error) => {
      logger.error(
        { err },
        'redis unreachable — the guide keeps serving; the redis demo reports unavailable',
      );
      // Tear the half-open client down (timers and sockets) and do NOT cache
      // the failure: the next caller retries, bounded by connectTimeout.
      client.disconnect();
      if (role === 'commands') clientPromise = undefined;
      else subscriberPromise = undefined;
      return null;
    });
}

/**
 * Graceful shutdown: close BOTH connections (commands and subscriber) if either
 * was ever opened. Idempotent — safe to call when Redis was never configured.
 */
export async function closeRedis(): Promise<void> {
  const pendingClient = clientPromise;
  const pendingSubscriber = subscriberPromise;
  clientPromise = undefined;
  subscriberPromise = undefined;

  const connections = await Promise.all([
    pendingClient?.catch(() => null) ?? null,
    pendingSubscriber?.catch(() => null) ?? null,
  ]);

  for (const connection of connections) {
    if (connection === null) continue;
    try {
      // disconnect() closes immediately — during shutdown we are done waiting
      // on socket handshakes (the twin of mongo's close(force: true)).
      connection.disconnect();
    } catch (err) {
      logger.warn({ err }, 'redis connection close failed during shutdown — continuing');
    }
  }
  if (connections.some((connection) => connection !== null)) {
    logger.info('redis connection(s) closed');
  }
}

/**
 * A display-safe label for the configured target: host:port/db ONLY.
 * Credentials in a redis://user:pass@host:port/db URL must never reach a
 * response body, so this deliberately rebuilds the label from parsed
 * components (the uri parameter exists so specs can prove the strip).
 */
export function describeRedisTarget(uri: string = appConfig.redisUrl): string {
  if (uri === '') return '';
  try {
    const parsed = new URL(uri);
    // URL keeps userinfo out of .host; pathname is "/db" (or '' for no db).
    const db = parsed.pathname === '/' || parsed.pathname === '' ? '' : parsed.pathname;
    return `${parsed.host}${db}`;
  } catch {
    return '(unparseable REDIS_URL)';
  }
}
