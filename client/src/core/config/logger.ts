/**
 * Minimal structured logger — mirrors the react guide's `Logger` (the Flutter
 * guide's `logging` package). Keeps a name tag (the active environment) and
 * respects `AppConfig.enableLogs`. In a real app you'd swap this for Pino /
 * Sentry etc., but the abstraction boundary stays the same.
 */

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
};

export class Logger {
  private readonly name: string;
  private readonly minPriority: number;

  constructor(name: string, enableLogs = true) {
    this.name = name;
    this.minPriority = enableLogs ? LEVEL_PRIORITY.debug : LEVEL_PRIORITY.error;
  }

  private log(level: LogLevel, message: string, error?: unknown): void {
    if (LEVEL_PRIORITY[level] < this.minPriority) return;
    const tag = `[${this.name}] ${level.toUpperCase()}: ${message}`;
    // Route by severity so browser tooling / log aggregators can filter:
    // warnings to console.warn, errors to console.error.
    const fn =
      level === 'error'
        ? console.error
        : level === 'warning'
          ? console.warn
          : console.log;
    if (error !== undefined) fn(tag, error);
    else fn(tag);
  }

  debug(message: string): void {
    this.log('debug', message);
  }
  info(message: string): void {
    this.log('info', message);
  }
  warning(message: string, error?: unknown): void {
    this.log('warning', message, error);
  }
  error(message: string, error?: unknown): void {
    this.log('error', message, error);
  }
}
