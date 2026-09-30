import mongoose, { type Connection } from 'mongoose';
import { appConfig } from '../../core/config/app_config.js';
import { logger } from '../../core/logging/logger.js';

/**
 * Lazy mongoose connection singleton — the MongoDB twin of the sqlite client
 * in data/posts/sqlite_client.ts, with one extra property the SQL world never
 * needs: Mongo is an OPTIONAL service here, so this module must never crash
 * the app and never make a caller wait long when the service is absent.
 *
 * - Not configured (MONGO_URI === ''): resolves null IMMEDIATELY, without
 *   touching mongoose at all — importing this module connects nothing.
 * - Configured but unreachable: the attempt fails fast (serverSelectionTimeoutMS
 *   1500), resolves null (never rejects), and the failed attempt is NOT cached
 *   — the next call retries, so booting `docker compose up mongo` after the
 *   server flips the demo on without a restart.
 * - Configured and reachable: the one open connection is cached for the
 *   process lifetime; shutdown closes it (closeMongoConnection).
 */

/** Fail fast when the service is off: 1.5s is the worst any caller waits. */
const SERVER_SELECTION_TIMEOUT_MS = 1500;

/** True when MONGO_URI names a database — false means the feature is off. */
export function isMongoConfigured(): boolean {
  return appConfig.mongoUri !== '';
}

let connectionPromise: Promise<Connection | null> | undefined;

export function getMongoConnection(): Promise<Connection | null> {
  if (!isMongoConfigured()) {
    // Feature off: no mongoose object is ever created for this call path.
    return Promise.resolve(null);
  }

  connectionPromise ??= attemptConnection();
  return connectionPromise;
}

function attemptConnection(): Promise<Connection | null> {
  const connection = mongoose.createConnection(appConfig.mongoUri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
  // The connection is an EventEmitter: without a listener, a later socket
  // error would surface as an unhandled 'error' event and kill the process.
  connection.on('error', (err: Error) => {
    logger.warn({ err: err.message }, 'mongo connection error — the mongo demo stays degraded until the service answers');
  });

  return connection
    .asPromise()
    .then((connected) => {
      logger.info(
        { host: connected.host, port: connected.port, db: connected.name },
        'mongo connected',
      );
      return connected;
    })
    .catch((err: Error) => {
      logger.error(
        { err },
        'mongo unreachable — the guide keeps serving; the mongo demo reports unavailable',
      );
      // Tear the half-open connection down (sockets, timers, and mongoose's
      // own connections list — destroy, not close, because this attempt is
      // dead and must never be reopened) and do NOT cache the failure: the
      // next caller retries (bounded by the same 1.5s server-selection
      // timeout), so the demo recovers the moment the service appears.
      connection.destroy(true).catch(() => undefined);
      connectionPromise = undefined;
      return null;
    });
}

/** Graceful shutdown: close the connection if one was ever opened. */
export async function closeMongoConnection(): Promise<void> {
  const pending = connectionPromise;
  connectionPromise = undefined;
  if (pending === undefined) return;

  const connection = await pending.catch(() => null);
  if (connection === null) return;

  try {
    // force — during shutdown we are done waiting on socket handshakes.
    await connection.close(true);
    logger.info('mongo connection closed');
  } catch (err) {
    logger.warn({ err }, 'mongo connection close failed during shutdown — continuing');
  }
}

/**
 * A display-safe label for the configured target: host/database ONLY.
 * Credentials in a mongodb://user:pass@host/db URI must never reach a response
 * body, so this deliberately rebuilds the label from parsed components (the
 * uri parameter exists so specs can prove the strip without touching config).
 */
export function describeMongoTarget(uri: string = appConfig.mongoUri): string {
  if (uri === '') return '';
  try {
    const parsed = new URL(uri);
    // URL keeps userinfo out of .host; pathname is "/db" (or '' for no db).
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable MONGO_URI)';
  }
}
