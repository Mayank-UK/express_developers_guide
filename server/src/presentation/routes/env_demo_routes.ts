import { existsSync } from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { appConfig } from '../../core/config/app_config.js';

/**
 * Environments demo endpoints (the `environments` topic's live surface).
 * GET /api/demo/env/inspect introspects the app's OWN validated config — the
 * frozen AppConfig every other topic has been reading — plus the process facts
 * and a MASKED view of the environment. The masking contract is the teaching
 * point: config values that are safe to show (ports, paths, levels) are shown;
 * anything secret-shaped is reported as present but never rendered.
 */

export const ENV_DEMO_MOUNT_PATH = '/api/demo/env';

/** A variable whose NAME confesses ("token", "secret", "password"…) is always hidden. */
const SECRET_NAME_PATTERN = /secret|token|passkey|password|passwd|credential/i;

/**
 * The masking rule for a single environment variable:
 *  - unset/empty → 'unset';
 *  - secret-shaped NAME (token/secret/password/passkey/credential…) → 'set (hidden)';
 *  - a value that parses as a URL CARRYING CREDENTIALS (scheme://user:pass@…)
 *    → 'set (hidden)' — the password leaks through the value, not the name;
 *  - anything else → the raw value (ports, paths and log levels are not secrets).
 */
export function maskEnvValue(name: string, raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'unset';
  if (SECRET_NAME_PATTERN.test(name)) return 'set (hidden)';
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') return 'set (hidden)';
  } catch {
    // Not a URL — a plain value; the rules above already decided.
  }
  return raw;
}

/**
 * Config-relevant variables whose VALUES are safe to show (they ride through
 * maskEnvValue anyway, so a secret-shaped rename of any of them would still
 * hide). MONGO_URI / REDIS_URL are handled separately: connection strings can
 * carry credentials, so their contract is strictly 'set (hidden)' | 'unset'.
 */
const SHOWN_ENV_KEYS = ['NODE_ENV', 'PORT', 'GRPC_PORT', 'LOG_LEVEL', 'SQLITE_PATH'] as const;

function inspectController(_req: Request, res: Response): void {
  // Derived exactly the way app_config derives it: dotenv loaded
  // `.env.${resolvedNodeEnv}` — and appConfig.nodeEnv IS the resolved value
  // (a vitest run maps test→development and therefore loaded .env.development).
  const envFileLoaded = `.env.${appConfig.nodeEnv}`;

  const maskedEnv: Record<string, string> = {};
  for (const key of SHOWN_ENV_KEYS) {
    maskedEnv[key] = maskEnvValue(key, process.env[key]);
  }
  maskedEnv.MONGO_URI = appConfig.mongoUri !== '' ? 'set (hidden)' : 'unset';
  maskedEnv.REDIS_URL = appConfig.redisUrl !== '' ? 'set (hidden)' : 'unset';

  // The honest count of what is being protected: names are safe to show, the
  // values never are (and never leave this process through this endpoint).
  const hiddenSecretNames = Object.keys(process.env)
    .filter((key) => SECRET_NAME_PATTERN.test(key))
    .sort();

  res.json({
    nodeEnv: appConfig.nodeEnv,
    port: appConfig.port,
    grpcPort: appConfig.grpcPort,
    logLevel: appConfig.logLevel,
    // Not a secret — a filesystem path the app was configured to use.
    dbPath: appConfig.dbPath,
    mongoConfigured: appConfig.mongoUri !== '',
    redisConfigured: appConfig.redisUrl !== '',
    nodeVersion: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    envFileLoaded,
    // dotenv does not error on a missing file — it just sets nothing. Reporting
    // existence keeps the derivation honest (staging/prod boxes may not ship one).
    envFileExists: existsSync(path.resolve(process.cwd(), envFileLoaded)),
    maskedEnv,
    hiddenSecretNames,
  });
}

export const envDemoRouter = Router();
envDemoRouter.get('/demo/env/inspect', inspectController);
