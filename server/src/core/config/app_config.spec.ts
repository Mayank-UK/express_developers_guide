import { describe, expect, it } from 'vitest';
import { createAppConfig } from './app_config.js';

/**
 * createAppConfig's contract, table-driven: defaults, explicit-env-wins, the
 * NODE_ENV=test discipline, optional-service URLs, and the validation errors.
 *
 * Determinism note: createAppConfig calls dotenv.config() internally — loading
 * `.env.{nodeEnv}` into the REAL process.env is a side effect it cannot skip
 * (its resolution order is env file first, real environment second). That side
 * effect never reaches these assertions: every field of the RETURNED config is
 * read from the env object PASSED IN, never from process.env, so nothing here
 * depends on which .env.* files exist or what they contain — and nothing below
 * asserts on process.env.
 */
describe('createAppConfig — defaults', () => {
  it('builds the documented defaults from an empty environment', () => {
    expect(createAppConfig({})).toEqual({
      port: 4000,
      grpcPort: 50051,
      nodeEnv: 'development',
      logLevel: 'debug',
      dbPath: 'data/guide.db',
      mongoUri: '',
      redisUrl: '',
    });
  });

  it('treats an empty-string NODE_ENV exactly like unset', () => {
    for (const env of [{}, { NODE_ENV: '' }]) {
      const config = createAppConfig(env);
      expect(config.nodeEnv, JSON.stringify(env)).toBe('development');
      // NOT ':memory:' — only NODE_ENV=test forces the in-memory database.
      expect(config.dbPath, JSON.stringify(env)).toBe('data/guide.db');
    }
  });

  it('defaults LOG_LEVEL by environment: debug in development, info otherwise', () => {
    expect(createAppConfig({}).logLevel).toBe('debug');
    for (const nodeEnv of ['staging', 'production'] as const) {
      expect(createAppConfig({ NODE_ENV: nodeEnv }).logLevel, nodeEnv).toBe('info');
    }
  });

  it('treats empty-string PORT/GRPC_PORT as unset (fallbacks apply)', () => {
    expect(createAppConfig({ PORT: '', GRPC_PORT: '' })).toMatchObject({
      port: 4000,
      grpcPort: 50051,
    });
  });
});

describe('createAppConfig — explicit environment wins', () => {
  it('reads every field from the passed env', () => {
    const config = createAppConfig({
      PORT: '8080',
      GRPC_PORT: '50124',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      SQLITE_PATH: 'data/elsewhere.db',
      MONGO_URI: 'mongodb://mongo:27017/guide',
      REDIS_URL: 'redis://redis:6379/3',
    });

    expect(config).toEqual({
      port: 8080,
      grpcPort: 50124,
      nodeEnv: 'production',
      logLevel: 'warn',
      dbPath: 'data/elsewhere.db',
      mongoUri: 'mongodb://mongo:27017/guide',
      redisUrl: 'redis://redis:6379/3',
    });
  });

  it('accepts the inclusive port boundaries 0 and 65535', () => {
    expect(createAppConfig({ PORT: '0', GRPC_PORT: '65535' })).toMatchObject({
      port: 0,
      grpcPort: 65535,
    });
  });
});

describe('createAppConfig — the NODE_ENV=test discipline', () => {
  it('maps test to development AND forces the in-memory database', () => {
    const config = createAppConfig({ NODE_ENV: 'test', SQLITE_PATH: 'data/guide.db' });

    expect(config.nodeEnv).toBe('development');
    // An explicit SQLITE_PATH must not leak a real file into a vitest run.
    expect(config.dbPath).toBe(':memory:');
  });

  it('reads MONGO_TEST_URI instead of MONGO_URI under test', () => {
    expect(
      createAppConfig({ NODE_ENV: 'test', MONGO_URI: 'mongodb://real/db', MONGO_TEST_URI: 'mongodb://test/uri' }).mongoUri,
    ).toBe('mongodb://test/uri');
    expect(createAppConfig({ NODE_ENV: 'test', MONGO_URI: 'mongodb://real/uri' }).mongoUri).toBe('');
  });

  it('reads REDIS_TEST_URI instead of REDIS_URL under test', () => {
    expect(
      createAppConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://real:6379', REDIS_TEST_URI: 'redis://test:6379/1' }).redisUrl,
    ).toBe('redis://test:6379/1');
    expect(createAppConfig({ NODE_ENV: 'test', REDIS_URL: 'redis://real:6379' }).redisUrl).toBe('');
  });
});

describe('createAppConfig — optional service URLs', () => {
  it("treats '' as the VALID feature-off state and trims surrounding whitespace", () => {
    const cases: ReadonlyArray<{ raw: string | undefined; expected: string }> = [
      { raw: undefined, expected: '' },
      { raw: '', expected: '' },
      { raw: '   ', expected: '' },
      { raw: '  mongodb://mongo:27017/guide  ', expected: 'mongodb://mongo:27017/guide' },
      { raw: 'redis://redis:6379/2', expected: 'redis://redis:6379/2' },
    ];
    for (const { raw, expected } of cases) {
      expect(createAppConfig({ MONGO_URI: raw }).mongoUri, `MONGO_URI ${JSON.stringify(raw)}`).toBe(expected);
      expect(createAppConfig({ REDIS_URL: raw }).redisUrl, `REDIS_URL ${JSON.stringify(raw)}`).toBe(expected);
    }
  });
});

describe('createAppConfig — validation errors', () => {
  it('rejects an unknown NODE_ENV with the documented message', () => {
    for (const raw of ['banana', 'prod', 'DEVELOPMENT', 'production ']) {
      expect(() => createAppConfig({ NODE_ENV: raw }), `NODE_ENV "${raw}"`).toThrow(
        `Invalid NODE_ENV "${raw}". Expected one of: development, staging, production.`,
      );
    }
  });

  it('rejects malformed ports with the documented message, naming the variable', () => {
    const cases: ReadonlyArray<{ name: 'PORT' | 'GRPC_PORT'; raw: string }> = [
      { name: 'PORT', raw: 'abc' },
      { name: 'PORT', raw: '80.5' },
      { name: 'PORT', raw: '-1' },
      { name: 'PORT', raw: '65536' },
      { name: 'GRPC_PORT', raw: 'nope' },
      { name: 'GRPC_PORT', raw: '70000' },
    ];
    for (const { name, raw } of cases) {
      expect(() => createAppConfig({ [name]: raw }), `${name} ${raw}`).toThrow(
        `Invalid ${name} "${raw}". Expected an integer between 0 and 65535.`,
      );
    }
  });

  it('rejects an unknown LOG_LEVEL with the documented message (empty string is NOT unset here)', () => {
    for (const raw of ['loud', 'DEBUG', '']) {
      expect(() => createAppConfig({ LOG_LEVEL: raw }), `LOG_LEVEL "${raw}"`).toThrow(
        `Invalid LOG_LEVEL "${raw}". Expected one of: fatal, error, warn, info, debug, trace.`,
      );
    }
  });
});

describe('createAppConfig — immutability', () => {
  it('returns a frozen config', () => {
    expect(Object.isFrozen(createAppConfig({}))).toBe(true);
  });
});
