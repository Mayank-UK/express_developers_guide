/**
 * Teaching exhibit (the `redis` topic's use-cases section): the two sketches
 * worth internalizing — the fixed-window rate limiter and the token-checked
 * distributed lock.
 *
 * Deliberately NOT executed anywhere: the security topic wires rate limiting
 * to a real trippable limiter and the caching topic builds the cache-aside
 * endpoint; this exhibit holds the two REDIS-SHAPED cores of those patterns
 * (INCR + EXPIRE as the window; SET NX PX + token-checked Lua release as the
 * lock) so the topic quotes real, compilable code instead of a hand-typed
 * sketch. ioredis is installed, so this is honest, typechecked code — just
 * not wired to a route.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * FIXED-WINDOW RATE LIMIT — the whole idea in three commands: INCR the
 * caller's bucket key, arm the window's TTL on the FIRST hit (reply 1), and
 * answer 429 past the limit. INCR is atomic and Redis is shared, so the count
 * is exact across every process behind the load balancer.
 */
export async function isOverFixedWindowLimit(
  client: Redis,
  ip: string,
  minuteBucket: string,
  limit = 100,
): Promise<boolean> {
  const hits = await client.incr(`ratelimit:${ip}:${minuteBucket}`);
  if (hits === 1) await client.expire(`ratelimit:${ip}:${minuteBucket}`, 60);
  return hits > limit; // true → the caller gets a 429
}

/**
 * DISTRIBUTED LOCK, acquire half — SET NX PX is an atomic test-and-set: the
 * token (a random value only this caller knows) is what makes release safe.
 */
export async function acquireLock(client: Redis, key: string): Promise<string | null> {
  const token = randomUUID();
  const acquired = await client.set(key, token, 'PX', 30_000, 'NX');
  return acquired === 'OK' ? token : null; // null → someone else holds it
}

/**
 * DISTRIBUTED LOCK, release half — delete only if the value is OUR token,
 * done in a Lua script so check-and-delete is itself atomic (you must never
 * DEL a lock you no longer own — it may now be someone else's).
 */
export async function releaseIfStillOurs(client: Redis, key: string, token: string): Promise<number> {
  return (await client.eval(
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end',
    1,
    key,
    token,
  )) as number;
}
