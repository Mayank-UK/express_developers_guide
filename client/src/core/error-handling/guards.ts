import {
  AppException,
  NetworkException,
  ServerException,
} from './exceptions';
import {
  Failure,
  NetworkFailure,
  ServerFailure,
  UnknownFailure,
} from './failures';
import { failed, type Result } from '../result';
import type { Logger } from '../config/logger';

/**
 * Guards — the heart of the error pipeline. Mirrors the react guide's
 * `guards.ts` (the Flutter guide's `guards.dart`), trimmed to this client's
 * fetch-based data layer.
 *
 *  1. `guardedApiCall`     : wraps a raw data-source call and upgrades thrown
 *                            engine errors (fetch / JSON) into typed
 *                            `AppException`s.
 *  2. `mapExceptionToFailure`: turns an `AppException` into a user-facing
 *                            `Failure`, preserving the machine diagnostics.
 *  3. `safeRepositoryCall` : wraps a repository method and returns a `Result`.
 */

/** Wrap a low-level data-source operation. Re-throws typed AppExceptions. */
export async function guardedApiCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw toAppException(e);
  }
}

/** Convert any thrown value into a typed AppException (idempotent if already one). */
export function toAppException(error: unknown): AppException {
  if (error instanceof AppException) return error;

  if (error instanceof TypeError) {
    // fetch()/network failures surface as TypeError ("Failed to fetch").
    return new NetworkException('Could not reach the server.', { cause: error });
  }

  return new ServerException('Unexpected error', { cause: error });
}

/** Map an AppException to a Failure, preserving the machine diagnostics. */
export function mapExceptionToFailure(e: AppException): Failure {
  const diagnostics = { code: e.code, status: e.status };

  if (e instanceof NetworkException) {
    return new NetworkFailure(e.message, diagnostics);
  }
  if (e instanceof ServerException) {
    return new ServerFailure(e.message, diagnostics);
  }

  return new UnknownFailure(e.message, diagnostics);
}

interface SafeRepositoryCallOptions<TResult> {
  call: () => Promise<TResult>;
  logger: Logger;
}

/** Wrap a repository method and return a Result. */
export async function safeRepositoryCall<TResult>({
  call,
  logger,
}: SafeRepositoryCallOptions<TResult>): Promise<Result<TResult>> {
  try {
    const value = await call();
    return { ok: true, value };
  } catch (e) {
    if (e instanceof AppException) {
      return failed(mapExceptionToFailure(e));
    }
    logger.error('Unexpected repository error', e);
    return failed(new UnknownFailure());
  }
}
