import type { Failure } from './failures.js';
import { AppException, InternalException, failureToException } from './exceptions.js';

/**
 * Runtime guards shared by every layer. Each guard throws a typed AppException
 * built from the failure you pass in, so guard failures flow through the exact
 * same error pipeline as any other failure.
 */

export function assert(condition: unknown, failure: Failure): asserts condition {
  if (!condition) throw failureToException(failure);
}

export function assertDefined<T>(
  value: T | null | undefined,
  failure: Failure,
): asserts value is T {
  if (value === null || value === undefined) throw failureToException(failure);
}

/**
 * Wraps promise-returning work in NON-route contexts (startup, schedulers,
 * event handlers): AppExceptions rethrow untouched; anything unknown is
 * wrapped in an InternalException with the original error preserved as cause.
 * Express 5 route handlers do not need this — they forward rejected promises
 * to the error middleware automatically.
 */
export async function withGuards(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppException) throw err;
    throw new InternalException('unexpected internal error', undefined, err);
  }
}
