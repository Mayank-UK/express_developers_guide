import { Environment, type AppConfig } from './app-config';

/**
 * Build the AppConfig from Vite env vars. Vite selects `.env.<mode>` based on
 * `--mode` (dev → development, build → production; vitest runs with `test`).
 *
 * `VITE_*` prefixed vars are the only ones exposed to client code.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

/**
 * Resolve the runtime environment from the Vite mode. Unknown modes throw
 * (rather than silently falling through to Dev, which would enable dev-only
 * behavior in an environment that didn't ask for it).
 */
function resolveEnvironment(mode: string): Environment {
  switch (mode) {
    case 'development':
    case 'test':
      return Environment.Dev;
    case 'production':
      return Environment.Prod;
    default:
      throw new Error(
        `Unknown Vite mode "${mode}"; expected development|test|production.`,
      );
  }
}

export function createAppConfig(env: ImportMetaEnv = import.meta.env): AppConfig {
  const environment = resolveEnvironment(env.MODE);

  return {
    environment,
    apiBaseUrl: env.VITE_API_BASE_URL ?? '/api',
    enableLogs: parseBoolean(env.VITE_ENABLE_LOGS, environment !== Environment.Prod),
  };
}
