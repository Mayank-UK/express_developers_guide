import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { ENV_DEMO_MOUNT_PATH, maskEnvValue } from './env_demo_routes.js';
import { appConfig } from '../../core/config/app_config.js';

/**
 * The inspect endpoint reports the app's OWN frozen config, so these specs pin
 * it against the imported appConfig (it cannot drift) and attack the masking
 * contract the way the content teaches: a secret-shaped NAME and a
 * credential-bearing URL VALUE must both come out hidden, never as raw values.
 */

interface InspectBody {
  nodeEnv: string;
  port: number;
  grpcPort: number;
  logLevel: string;
  dbPath: string;
  mongoConfigured: boolean;
  redisConfigured: boolean;
  nodeVersion: string;
  pid: number;
  cwd: string;
  envFileLoaded: string;
  envFileExists: boolean;
  maskedEnv: Record<string, string>;
  hiddenSecretNames: string[];
}

const TOKEN_NAME = 'DEMO_API_TOKEN';
const TOKEN_VALUE = 'sk-demo-never-render-me';

afterEach(() => {
  // The one spec that plants a fake secret cleans up after itself.
  delete process.env[TOKEN_NAME];
});

describe('GET /api/demo/env/inspect', () => {
  it('introspects the real appConfig plus process facts', async () => {
    const res = await request(createApp()).get(`${ENV_DEMO_MOUNT_PATH}/inspect`);
    expect(res.status).toBe(200);

    const body = res.body as InspectBody;
    // Pinned against the frozen config every other module reads — no drift.
    expect(body.nodeEnv).toBe(appConfig.nodeEnv);
    expect(body.port).toBe(appConfig.port);
    expect(body.grpcPort).toBe(appConfig.grpcPort);
    expect(body.logLevel).toBe(appConfig.logLevel);
    expect(body.dbPath).toBe(appConfig.dbPath);
    expect(body.mongoConfigured).toBe(appConfig.mongoUri !== '');
    expect(body.redisConfigured).toBe(appConfig.redisUrl !== '');
    // Process facts.
    expect(body.nodeVersion).toBe(process.version);
    expect(body.pid).toBe(process.pid);
    expect(body.cwd).toBe(process.cwd());
    // The derivation: dotenv loaded `.env.${resolvedNodeEnv}` — under vitest
    // that is .env.development (NODE_ENV=test maps to development).
    expect(body.envFileLoaded).toBe(`.env.${appConfig.nodeEnv}`);
    expect(typeof body.envFileExists).toBe('boolean');
  });

  it('NEVER leaks service values: MONGO_URI / REDIS_URL are set-hidden or unset, nothing else', async () => {
    const res = await request(createApp()).get(`${ENV_DEMO_MOUNT_PATH}/inspect`);
    const body = res.body as InspectBody;

    const allowed = ['set (hidden)', 'unset'];
    expect(allowed).toContain(body.maskedEnv.MONGO_URI);
    expect(allowed).toContain(body.maskedEnv.REDIS_URL);
    // The flags and the masked view agree.
    expect(body.maskedEnv.MONGO_URI).toBe(body.mongoConfigured ? 'set (hidden)' : 'unset');
    expect(body.maskedEnv.REDIS_URL).toBe(body.redisConfigured ? 'set (hidden)' : 'unset');
    // Belt and braces: no connection-string syntax anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb:\/\//);
    expect(JSON.stringify(res.body)).not.toMatch(/redis:\/\//);
  });

  it('hides secret-shaped variables by NAME — value never rendered', async () => {
    process.env[TOKEN_NAME] = TOKEN_VALUE;
    const res = await request(createApp()).get(`${ENV_DEMO_MOUNT_PATH}/inspect`);
    const body = res.body as InspectBody;

    expect(body.hiddenSecretNames).toContain(TOKEN_NAME);
    // The value must not survive anywhere in the serialized payload.
    expect(JSON.stringify(res.body)).not.toContain(TOKEN_VALUE);
  });

  it('maskEnvValue — the two rules and the passthrough', () => {
    // Unset/empty.
    expect(maskEnvValue('ANYTHING', undefined)).toBe('unset');
    expect(maskEnvValue('ANYTHING', '')).toBe('unset');
    // Rule 1: the NAME confesses.
    expect(maskEnvValue('DEMO_API_TOKEN', 'abc')).toBe('set (hidden)');
    expect(maskEnvValue('CLIENT_SECRET', 'abc')).toBe('set (hidden)');
    expect(maskEnvValue('db_password', 'abc')).toBe('set (hidden)');
    // Rule 2: the VALUE carries URL credentials.
    expect(maskEnvValue('INNOCENT_NAME', 'mongodb://alice:hunter2@host:27017/db')).toBe(
      'set (hidden)',
    );
    expect(maskEnvValue('INNOCENT_NAME', 'https://bob:pw@example.com/x')).toBe('set (hidden)');
    // A URL WITHOUT credentials and a plain path are not secrets.
    expect(maskEnvValue('MONGO_URI', 'mongodb://127.0.0.1:27017/db')).toBe(
      'mongodb://127.0.0.1:27017/db',
    );
    expect(maskEnvValue('SQLITE_PATH', 'data/guide.db')).toBe('data/guide.db');
    expect(maskEnvValue('PORT', '4000')).toBe('4000');
  });
});
