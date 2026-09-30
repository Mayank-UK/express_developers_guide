import type { Redis } from 'ioredis';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import { getRedisClient } from './redis_client.js';

/**
 * ONE error-classification seam for every ioredis error in the guide — the
 * boundary where the ioredis world ends and the app's ONE failure taxonomy
 * begins. Four data-layer services talk to the same optional redis service
 * (the playground, the stream lab, the transactional outbox, cache-aside),
 * and they must degrade IDENTICALLY when it goes away:
 *
 *   - connection absent/offline  → 'unavailable' (503 — the demo degrades)
 *   - anything else              → 'internal' (500, cause attached)
 *
 * This module exists because that rule used to be copy-pasted into all four
 * files — four regexes that would have to move in lockstep the day ioredis
 * renames an error class. Drift waiting to happen; now it is one regex.
 * The names it matches are ioredis' own error classes (ConnectionError,
 * MaxRetriesPerRequest exceeded, command TimeoutError) plus the errno codes
 * Node surfaces for a dead socket (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH).
 *
 * LAYERING: intra-data imports (messaging/caching → redis) are allowed — the
 * dependency rule governs presentation/domain/data, not sharing WITHIN the
 * data layer, exactly like the shared sql_depth factory the outbox uses.
 */

/** The one failure every method returns when the optional service is absent. */
export function redisUnavailableFailure(): Failure {
  return failure(
    'unavailable',
    'Redis is not configured or not reachable — start it with `docker compose -f .docker/docker-compose.yml up -d redis` and retry',
    { service: 'redis' },
  );
}

/**
 * ioredis error names that mean "the optional service is gone RIGHT NOW":
 * those become 'unavailable' (the 503 every redis-backed demo degrades to);
 * every other error is an honest 'internal' with the operation named and the
 * cause attached. Non-Error causes are classified by their string form.
 */
export function classifyRedisError(operation: string, cause: unknown): Failure {
  const name = cause instanceof Error ? cause.name : String(cause);
  if (/ConnectionError|MaxRetriesPerRequest|TimeoutError|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(name)) {
    return failure('unavailable', `redis became unreachable while ${operation}`, { service: 'redis' }, cause);
  }
  return failure('internal', `${operation} failed in redis`, { operation }, cause);
}

/**
 * Runs one unit of redis work on the main (commands) connection, mapping the
 * null-client and error paths onto the Result taxonomy: absent service → the
 * canonical unavailable failure; a thrown error → classifyRedisError. The
 * ioredis world ends at this boundary — callers only ever see a Result.
 */
export async function runOnClient<T>(
  operation: string,
  work: (client: Redis) => Promise<T>,
): Promise<Result<T, Failure>> {
  const client = await getRedisClient();
  if (client === null) return fail(redisUnavailableFailure());
  try {
    return ok(await work(client));
  } catch (cause) {
    return fail(classifyRedisError(operation, cause));
  }
}
