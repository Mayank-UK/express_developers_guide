import type { Failure } from './error-handling/failures';

/**
 * Result<T> — the domain return type for anything that can fail in an expected,
 * recoverable way. Mirrors the react guide's `Result<T>` (sealed `Result` in the
 * Flutter guide).
 *
 * - `Success` carries a value and an *optional* `warning` (a non-blocking
 *   Failure, e.g. "showed stale cache because the network failed").
 * - `Failed` carries the blocking Failure.
 *
 * Implemented as a discriminated union on `ok` so `switch`/narrowing works
 * ergonomically in TypeScript.
 */
export type Result<T> = Success<T> | Failed;

export interface Success<T> {
  ok: true;
  value: T;
  warning?: Failure;
}

export interface Failed {
  ok: false;
  failure: Failure;
}

export const success = <T>(value: T, warning?: Failure): Success<T> => ({
  ok: true,
  value,
  warning,
});

export const failed = (failure: Failure): Failed => ({ ok: false, failure });
