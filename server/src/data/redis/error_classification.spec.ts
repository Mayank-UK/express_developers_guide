import { describe, expect, it } from 'vitest';
import {
  classifyRedisError,
  redisUnavailableFailure,
  runOnClient,
} from './error_classification.js';
import { isRedisConfigured } from './redis_client.js';

/**
 * The shared classifier's units — the ONE place the ioredis error-name →
 * failure taxonomy mapping lives (redis playground, stream lab, outbox, and
 * cache-aside all import it). The route specs prove the 503 envelope end to
 * end for the NULL-CLIENT path (redis not configured); these units pin the
 * MID-FLIGHT path — an error thrown by a command after the connection was
 * resolved — which no offline route spec can reach, because it needs a redis
 * that dies mid-command. Pure and offline: no server, no REDIS_URL.
 */

/** An Error whose NAME is the axis the classifier actually tests. */
function namedError(name: string): Error {
  const error = new Error(`${name}: the socket went away mid-command`);
  error.name = name;
  return error;
}

const OFFLINE_NAMES = [
  'ConnectionError', // ioredis' own connection-lost class
  'MaxRetriesPerRequestError', // ioredis gave up retrying the command
  'TimeoutError', // the command timed out
  'ECONNREFUSED', // Node errno: nothing listening at the target
  'ENOTFOUND', // Node errno: the host does not resolve
  'EHOSTUNREACH', // Node errno: no route to the host
] as const;

describe('classifyRedisError — offline-ish error names degrade, not crash', () => {
  it.each(OFFLINE_NAMES)('%s → unavailable (the 503 degradation)', (name) => {
    const cause = namedError(name);
    const result = classifyRedisError('running the tour', cause);
    expect(result.kind).toBe('unavailable');
    expect(result.message).toBe('redis became unreachable while running the tour');
    expect(result.details).toEqual({ service: 'redis' });
    expect(result.cause).toBe(cause); // the cause rides along for the log
  });

  it('a non-Error cause whose string form is an errno code still degrades', () => {
    // ioredis and raw sockets can reject with non-Error values; the
    // classifier stringifies them, so 'ECONNREFUSED' itself must match.
    const result = classifyRedisError('publishing', 'ECONNREFUSED');
    expect(result.kind).toBe('unavailable');
    expect(result.details).toEqual({ service: 'redis' });
    expect(result.cause).toBe('ECONNREFUSED');
  });

  it('any other error stays an honest internal (500), operation and cause attached', () => {
    const cause = namedError('ReplyError'); // e.g. WRONGTYPE — OUR bug, not an outage
    const result = classifyRedisError('appending to the stream (XADD)', cause);
    expect(result.kind).toBe('internal');
    expect(result.message).toBe('appending to the stream (XADD) failed in redis');
    expect(result.details).toEqual({ operation: 'appending to the stream (XADD)' });
    expect(result.cause).toBe(cause);
  });

  it('a plain non-Error rejection is internal too (stringified name misses the regex)', () => {
    const result = classifyRedisError('reading cache stats', 'boom');
    expect(result.kind).toBe('internal');
    expect(result.message).toBe('reading cache stats failed in redis');
    expect(result.cause).toBe('boom');
  });
});

describe('redisUnavailableFailure — the canonical absent-service 503', () => {
  it('says the service is optional and how to start it', () => {
    const result = redisUnavailableFailure();
    expect(result.kind).toBe('unavailable');
    expect(result.message).toContain('Redis is not configured or not reachable');
    expect(result.message).toContain('docker compose -f .docker/docker-compose.yml up -d redis');
    expect(result.details).toEqual({ service: 'redis' });
    expect(result.cause).toBeUndefined();
  });
});

describe('runOnClient — the null-client path never runs the work', () => {
  it('answers the canonical unavailable failure before touching work (redis off)', async () => {
    if (isRedisConfigured()) return; // live-redis runs: the route specs' live proofs own that world
    let ran = false;
    const result = await runOnClient('testing the boundary', async () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(false); // no client, no side effects
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unavailable');
      expect(result.error.message).toBe(redisUnavailableFailure().message);
    }
  });
});
