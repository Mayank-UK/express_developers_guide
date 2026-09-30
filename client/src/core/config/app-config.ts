/**
 * Application configuration — mirrors the react guide's `AppConfig`.
 *
 * React/Vite selects `.env.*` files by `--mode` (dev → development, build →
 * production, vitest → test) and exposes them at build time via
 * `import.meta.env`. See `src/core/config/index.ts`.
 *
 * `Environment` is a const object + literal union (not an `enum`) to stay
 * compatible with `erasableSyntaxOnly` and modern TS conventions.
 */
export const Environment = {
  Dev: 'dev',
  Prod: 'prod',
} as const;

export type Environment = (typeof Environment)[keyof typeof Environment];

export interface AppConfig {
  environment: Environment;
  /**
   * Base URL every API request is resolved against. Defaults to '/api' so the
   * browser hits the Vite dev proxy, which forwards to the Express server.
   */
  apiBaseUrl: string;
  enableLogs: boolean;
}

export const isDev = (c: AppConfig): boolean => c.environment === Environment.Dev;
export const isProd = (c: AppConfig): boolean => c.environment === Environment.Prod;
