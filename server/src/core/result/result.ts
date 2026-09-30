import type { Failure } from '../error_handling/failures.js';

/**
 * The Result type used by every use case. Domain and data layers signal
 * failures as VALUES (never by throwing), so control flow stays explicit and
 * the presentation edge decides how failures map onto HTTP.
 */
export type Result<T, E extends Failure = Failure> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E extends Failure>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Transforms the success value, passing failures through untouched. */
export function mapResult<T, U, E extends Failure>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Returns the success value, or a fallback when the result is a failure. */
export function unwrapOr<T, E extends Failure>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
