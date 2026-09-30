import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Validated, immutable application configuration.
 *
 * Resolution order:
 *  1. NODE_ENV from the real environment (shell / Docker env_file) decides which
 *     `.env.{nodeEnv}` file to load. Defaults to "development".
 *  2. dotenv loads that file — it never overrides variables already present in
 *     the environment, so explicit env always wins over the file.
 *  3. PORT / GRPC_PORT / LOG_LEVEL / SQLITE_PATH / MONGO_URI / REDIS_URL are
 *     read from the merged environment and validated.
 *
 * MONGO_URI and REDIS_URL are the "optional service" pattern: '' (the default)
 * means the feature is OFF — the app boots and every other topic works without
 * that service. Under test the same rule as SQLITE_PATH applies: the
 * environment file is ignored and only an explicit MONGO_TEST_URI /
 * REDIS_TEST_URI opts a vitest run into the real service (mirrors ':memory:'
 * for sqlite).
 */

const VALID_NODE_ENVS = ['development', 'staging', 'production'] as const;
export type NodeEnv = (typeof VALID_NODE_ENVS)[number];

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

export interface AppConfig {
  readonly port: number;
  /** The gRPC (HTTP/2) listener's port — a second listener beside Express's. */
  readonly grpcPort: number;
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly dbPath: string;
  /**
   * MongoDB connection string for the mongo topic's demo. '' (empty) is VALID
   * and means the feature is OFF — the app boots and serves everything else
   * without a mongo service anywhere.
   */
  readonly mongoUri: string;
  /**
   * Redis connection URL for the redis topic's demo (redis://host:port/db).
   * '' (empty) is VALID and means the feature is OFF — the app boots and
   * serves everything else without a redis service anywhere.
   */
  readonly redisUrl: string;
}

function resolveNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined || raw === '') return 'development';
  // vitest runs with NODE_ENV=test; the app treats it like development.
  if (raw === 'test') return 'development';
  if ((VALID_NODE_ENVS as readonly string[]).includes(raw)) return raw as NodeEnv;
  throw new Error(
    `Invalid NODE_ENV "${raw}". Expected one of: ${VALID_NODE_ENVS.join(', ')}.`,
  );
}

function parsePort(raw: string | undefined, name: string, fallback: number): number {
  const port = Number(raw === undefined || raw === '' ? String(fallback) : raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ${name} "${raw ?? ''}". Expected an integer between 0 and 65535.`);
  }
  return port;
}

function parseLogLevel(raw: string | undefined, nodeEnv: NodeEnv): LogLevel {
  const value = raw ?? (nodeEnv === 'development' ? 'debug' : 'info');
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid LOG_LEVEL "${value}". Expected one of: ${VALID_LOG_LEVELS.join(', ')}.`,
    );
  }
  return value as LogLevel;
}

function parseDbPath(raw: string | undefined): string {
  if (raw !== undefined && raw !== '') return raw;
  // Relative on purpose: resolved against the package cwd, so dev runs keep
  // the db in server/data/ and Docker volumes can mount an absolute path.
  return 'data/guide.db';
}

/**
 * '' (unset/blank) is the VALID "feature off" state — never an error. A blank
 * MONGO_URI / REDIS_URL must not fail config, because the whole app must keep
 * booting in environments that have no such service at all.
 */
function parseOptionalServiceUrl(raw: string | undefined): string {
  return raw?.trim() ?? '';
}

export function createAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Captured BEFORE the test→development mapping in resolveNodeEnv: a vitest
  // run must never touch a real sqlite file, so it forces ':memory:' even
  // though dotenv below loads .env.development (which sets SQLITE_PATH).
  const isTestRun = env.NODE_ENV === 'test';
  const nodeEnv = resolveNodeEnv(env.NODE_ENV);

  // Loads `.env.{nodeEnv}` from the package root (cwd when run via npm scripts).
  dotenv.config({ path: path.resolve(process.cwd(), `.env.${nodeEnv}`) });

  return Object.freeze({
    port: parsePort(env.PORT, 'PORT', 4000),
    // The gRPC listener's port (the guide's HTTP/2 surface). Tests never need
    // it: the demo bridge lazily binds an ephemeral port-0 server instead.
    grpcPort: parsePort(env.GRPC_PORT, 'GRPC_PORT', 50051),
    nodeEnv,
    logLevel: parseLogLevel(env.LOG_LEVEL, nodeEnv),
    dbPath: isTestRun ? ':memory:' : parseDbPath(env.SQLITE_PATH),
    // Same test discipline as dbPath: a vitest run must never touch a real
    // mongo just because .env.development sets MONGO_URI — only an explicit
    // MONGO_TEST_URI opts the mongo connection specs into a live database.
    mongoUri: isTestRun ? parseOptionalServiceUrl(env.MONGO_TEST_URI) : parseOptionalServiceUrl(env.MONGO_URI),
    // And the identical rule for Redis: REDIS_URL off the file, REDIS_TEST_URI
    // under test — the redis demo specs only go live when it is set.
    redisUrl: isTestRun ? parseOptionalServiceUrl(env.REDIS_TEST_URI) : parseOptionalServiceUrl(env.REDIS_URL),
  });
}

export const appConfig: AppConfig = createAppConfig();
