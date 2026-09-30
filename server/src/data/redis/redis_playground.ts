import { Redis } from 'ioredis';
import { type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';
import { getRedisSubscriber } from './redis_client.js';
import { classifyRedisError, redisUnavailableFailure, runOnClient } from './error_classification.js';

/**
 * The Redis playground — the port-style service the redis demo routes call,
 * in the exact shape of the mongo event repository: methods return
 * Result<_, Failure>, never throw, and translate every ioredis error into the
 * app's ONE taxonomy:
 *
 *   - connection absent/offline  → 'unavailable' (503 — the demo degrades)
 *   - anything else              → 'internal' (500, cause attached)
 *
 * The classification itself lives next door in error_classification.ts — ONE
 * seam shared by every redis-backed data service (the stream lab, the outbox,
 * and cache-aside import the very same module), so the ioredis error-name →
 * failure mapping can never drift between this file and its siblings.
 *
 * LAYERING CALL (deliberate, matching the mongo topic's): there is no domain
 * use case here because the redis demo has no business rules beyond the route
 * edge's input validation — the data-layer service IS the right depth, the
 * same seam as data/mongo/event_repository.ts.
 *
 * All demo keys live under the `guide:demo:` namespace — enforced HERE, in
 * the service, not at the route edge: every public entry point prefixes
 * caller keys through toDemoKey(), so no future caller can write its way to
 * a key outside the namespace. The tour deletes ONLY those keys (SCAN + DEL)
 * — never FLUSHDB, which would wipe every other key on a shared instance
 * (other developers' caches, sessions, queues — and the messaging topic's
 * streams, which deliberately share this namespace).
 */

/** Every key this demo touches starts here — the FLUSH boundary. */
export const REDIS_DEMO_NAMESPACE = 'guide:demo:';

/** How many received pub/sub messages the in-memory ring keeps (newest kept). */
export const REDIS_MESSAGE_RING_CAP = 50;

/** The channel the demo's own subscriber listens on by default. */
export const REDIS_DEMO_CHANNEL = 'guide:demo:channel';

/**
 * After PUBLISH returns, the subscriber's message event still has to cross
 * the socket — this settle window lets the publish endpoint honestly report
 * whether OUR OWN demo subscriber received the message it just fanned out.
 */
const PUBLISH_SETTLE_MS = 150;

// --- key namespacing ---------------------------------------------------------------

/**
 * Forces a caller-supplied key into the demo namespace: bare names are
 * prefixed, already-namespaced names pass through untouched. Every public
 * key-taking function applies it INTERNALLY — the namespace is the FLUSH
 * safety boundary, so it is owned here (not by whoever calls) and proven by
 * the offline specs without a server.
 */
export function toDemoKey(raw: string): string {
  return raw.startsWith(REDIS_DEMO_NAMESPACE) ? raw : `${REDIS_DEMO_NAMESPACE}${raw}`;
}

// --- the structure tour ------------------------------------------------------------

export interface TourStep {
  /** Which structure family this command exercises (the demo groups by it). */
  readonly structure: 'string' | 'counter' | 'hash' | 'list' | 'set' | 'sorted-set';
  /** The command as a human reads it in redis-cli (args joined, strings quoted). */
  readonly command: string;
  /** The REAL reply, JSON-rendered — this is the teaching transcript. */
  readonly reply: string;
  /** When to reach for this structure (one line per family). */
  readonly note: string;
}

/** Renders command args the way redis-cli echoes them: numbers bare, strings quoted. */
function fmtArgs(args: readonly unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'number' ? String(arg) : `"${String(arg)}"`))
    .join(' ');
}

function step(
  structure: TourStep['structure'],
  command: string,
  reply: unknown,
  note: string,
): TourStep {
  return { structure, command, reply: JSON.stringify(reply) as string, note };
}

const NOTES: Readonly<Record<TourStep['structure'], string>> = {
  string: 'strings: the atom — cache entries, serialized blobs, feature flags',
  counter: 'INCR on a string: atomic counters — views, hits, sequence numbers',
  hash: 'hashes: one object\'s fields addressable by name — no read-modify-write of a whole blob',
  list: 'lists: ordered, both ends push/pop — queues and recent-item feeds',
  set: 'sets: uniqueness for free — tags, dedupe, presence — members come back in UNSPECIFIED order',
  'sorted-set': 'sorted sets: members ordered by score — leaderboards, sliding windows, priorities',
};

/**
 * Deletes every `guide:demo:*` key — SCAN (never KEYS, which blocks the single
 * command thread on big keyspaces) plus batched DEL. This is the tour's reset,
 * and it is why runs are repeatable. FLUSHDB is NEVER called: it would destroy
 * every other key on the instance, and Redis instances are routinely shared.
 */
async function cleanDemoKeys(client: Redis): Promise<number> {
  let cursor = '0';
  const doomed: string[] = [];
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${REDIS_DEMO_NAMESPACE}*`, 'COUNT', 100);
    cursor = next;
    doomed.push(...keys);
  } while (cursor !== '0');
  if (doomed.length === 0) return 0;
  return client.del(...doomed);
}

/**
 * Executes the REAL structure tour: every core family with its real commands
 * and real replies, recorded as a transcript. The tour cleans its namespace
 * first, so two runs in a row produce the same transcript.
 */
export async function runStructureTour(): Promise<Result<readonly TourStep[], Failure>> {
  return runOnClient('running the structure tour', async (client) => {
    await cleanDemoKeys(client);

    const steps: TourStep[] = [];

    // STRING — SET then GET: the smallest complete round-trip in Redis.
    await client.set(`${REDIS_DEMO_NAMESPACE}greeting`, 'Hello from the express guide');
    steps.push(step('string', `SET ${REDIS_DEMO_NAMESPACE}greeting "Hello from the express guide"`, 'OK', NOTES.string));
    const greeting = await client.get(`${REDIS_DEMO_NAMESPACE}greeting`);
    steps.push(step('string', `GET ${REDIS_DEMO_NAMESPACE}greeting`, greeting, NOTES.string));

    // COUNTER — INCR is atomic and creates the key at 1: two INCRs prove it.
    const firstCount = await client.incr(`${REDIS_DEMO_NAMESPACE}page:views`);
    steps.push(step('counter', `INCR ${REDIS_DEMO_NAMESPACE}page:views`, firstCount, NOTES.counter));
    const secondCount = await client.incr(`${REDIS_DEMO_NAMESPACE}page:views`);
    steps.push(step('counter', `INCR ${REDIS_DEMO_NAMESPACE}page:views`, secondCount, NOTES.counter));

    // HASH — HSET stores field/value pairs; HGETALL reads the object whole.
    const fieldsAdded = await client.hset(`${REDIS_DEMO_NAMESPACE}profile`, {
      name: 'Ada',
      role: 'engineer',
    });
    steps.push(step('hash', `HSET ${REDIS_DEMO_NAMESPACE}profile name "Ada" role "engineer"`, fieldsAdded, NOTES.hash));
    const profile = await client.hgetall(`${REDIS_DEMO_NAMESPACE}profile`);
    steps.push(step('hash', `HGETALL ${REDIS_DEMO_NAMESPACE}profile`, profile, NOTES.hash));

    // LIST — LPUSH prepends; LRANGE 0 -1 reads the whole list (newest first).
    const listLength = await client.lpush(`${REDIS_DEMO_NAMESPACE}queue`, 'first', 'second', 'third');
    steps.push(step('list', `LPUSH ${REDIS_DEMO_NAMESPACE}queue ${fmtArgs(['first', 'second', 'third'])}`, listLength, NOTES.list));
    const queue = await client.lrange(`${REDIS_DEMO_NAMESPACE}queue`, 0, -1);
    steps.push(step('list', `LRANGE ${REDIS_DEMO_NAMESPACE}queue 0 -1`, queue, NOTES.list));

    // SET — SADD ignores members already present: the second call adds ONE.
    const firstTags = await client.sadd(`${REDIS_DEMO_NAMESPACE}tags`, 'node', 'express', 'redis');
    steps.push(step('set', `SADD ${REDIS_DEMO_NAMESPACE}tags ${fmtArgs(['node', 'express', 'redis'])}`, firstTags, NOTES.set));
    const secondTags = await client.sadd(`${REDIS_DEMO_NAMESPACE}tags`, 'redis', 'docker');
    steps.push(
      step('set', `SADD ${REDIS_DEMO_NAMESPACE}tags ${fmtArgs(['redis', 'docker'])}`, secondTags, `${NOTES.set} — "redis" was already a member, so only "docker" counts`),
    );
    const tags = await client.smembers(`${REDIS_DEMO_NAMESPACE}tags`);
    steps.push(step('set', `SMEMBERS ${REDIS_DEMO_NAMESPACE}tags`, tags, `${NOTES.set} — these four arrived in this order THIS time; never depend on it`));

    // SORTED SET — ZADD scores members; ZRANGE REV WITHSCORES ranks them.
    const ranked = await client.zadd(`${REDIS_DEMO_NAMESPACE}leaderboard`, 100, 'ada', 250, 'grace', 180, 'linus');
    steps.push(step('sorted-set', `ZADD ${REDIS_DEMO_NAMESPACE}leaderboard 100 "ada" 250 "grace" 180 "linus"`, ranked, NOTES['sorted-set']));
    const flat = await client.zrange(`${REDIS_DEMO_NAMESPACE}leaderboard`, 0, '-1', 'REV', 'WITHSCORES');
    // RESP2 returns WITHSCORES as a flat [member, score, member, score, …] —
    // pair it up so the transcript reads like the leaderboard it is.
    const leaderboard: { member: string; score: string }[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      leaderboard.push({ member: flat[index] as string, score: flat[index + 1] as string });
    }
    steps.push(step('sorted-set', `ZRANGE ${REDIS_DEMO_NAMESPACE}leaderboard 0 -1 REV WITHSCORES`, leaderboard, NOTES['sorted-set']));

    return steps;
  });
}

// --- TTL ---------------------------------------------------------------------------

export interface TtlSetResult {
  readonly key: string;
  readonly value: string;
  readonly seconds: number;
  readonly setAt: string;
}

export interface TtlState {
  readonly key: string;
  readonly exists: boolean;
  /** Seconds remaining (>= 0), or null when the key is gone / has no expiry. */
  readonly ttlSecondsRemaining: number | null;
  readonly value: string | null;
}

/**
 * SET with an expiry, in one atomic command (SET key value EX seconds). The
 * key is namespaced toDemoKey-style INSIDE the service: a caller passing a
 * bare name lands under `guide:demo:` all the same — that guarantee is the
 * FLUSH-safety argument, so it cannot depend on the route remembering it.
 * The result reports the NAMESPACED key (what redis actually stores).
 */
export async function setWithTtl(rawKey: string, value: string, seconds: number): Promise<Result<TtlSetResult, Failure>> {
  const key = toDemoKey(rawKey);
  return runOnClient(`setting ${key} with a TTL`, async (client) => {
    await client.set(key, value, 'EX', seconds);
    return { key, value, seconds, setAt: new Date().toISOString() };
  });
}

/**
 * The poll side of the TTL demo: GET the value AND read TTL's honest tri-state
 * — a non-negative count of seconds remaining, -1 for "no expiry", -2 for "no
 * such key". The route reports it as { exists, ttlSecondsRemaining, value }.
 * Namespaces the key the same way setWithTtl does, so a bare name round-trips.
 */
export async function inspectTtl(rawKey: string): Promise<Result<TtlState, Failure>> {
  const key = toDemoKey(rawKey);
  return runOnClient(`inspecting the TTL of ${key}`, async (client) => {
    const [value, ttl] = await Promise.all([client.get(key), client.ttl(key)]);
    return {
      key,
      exists: ttl !== -2,
      ttlSecondsRemaining: ttl >= 0 ? ttl : null,
      value,
    };
  });
}

// --- pub/sub ------------------------------------------------------------------------

export interface ReceivedMessage {
  readonly channel: string;
  readonly message: string;
  readonly receivedAt: string;
}

/** One message from the dedicated subscriber connection. */
type Listener = (message: ReceivedMessage) => void;

const listeners = new Map<string, Set<Listener>>();
const receivedRing: ReceivedMessage[] = [];
let messageHandlerAttached = false;

/**
 * Appends to the in-memory ring, keeping the newest REDIS_MESSAGE_RING_CAP
 * entries. Exported as a pure helper so the offline specs prove the cap
 * without a server.
 */
export function appendCapped(ring: ReceivedMessage[], message: ReceivedMessage, cap: number = REDIS_MESSAGE_RING_CAP): ReceivedMessage[] {
  ring.push(message);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
  return ring;
}

/**
 * Subscribes a callback on the DEDICATED subscriber connection (a connection
 * that has issued SUBSCRIBE is in subscriber mode and must not carry regular
 * commands — this is why pub/sub needs its own socket). Returns an
 * unsubscribe function that RESOLVES when the server has dropped the
 * subscription — awaiting it before a PUBLISH makes the ordering explicit.
 */
export async function subscribe(channel: string, listener: Listener): Promise<Result<() => Promise<void>, Failure>> {
  const subscriber = await getRedisSubscriber();
  if (subscriber === null) return fail(redisUnavailableFailure());

  try {
    if (!messageHandlerAttached) {
      // ONE 'message' handler dispatches to every listener on every channel.
      subscriber.on('message', (deliveredChannel: string, message: string) => {
        const received: ReceivedMessage = {
          channel: deliveredChannel,
          message,
          receivedAt: new Date().toISOString(),
        };
        appendCapped(receivedRing, received);
        for (const registered of listeners.get(deliveredChannel) ?? []) registered(received);
      });
      messageHandlerAttached = true;
    }

    let set = listeners.get(channel);
    if (set === undefined) {
      // The SUBSCRIBE reply arriving guarantees the SERVER registered the
      // subscription before this function resolves — a PUBLISH after this
      // point is guaranteed to be counted and delivered.
      await subscriber.subscribe(channel);
      // A concurrent subscribe() may have won the race while we awaited:
      // reuse its set so no listener is silently dropped.
      set = listeners.get(channel) ?? new Set<Listener>();
      listeners.set(channel, set);
    }
    set.add(listener);

    return ok((): Promise<void> => {
      const current = listeners.get(channel);
      if (current === undefined) return Promise.resolve();
      current.delete(listener);
      if (current.size > 0) return Promise.resolve();
      listeners.delete(channel);
      // Await-able UNSUBSCRIBE over the shared connection: resolving only
      // when the SERVER confirms makes ordering vs a later PUBLISH explicit.
      // A dead socket here surfaces as a handled 'error' event, not a crash.
      return (async () => {
        await subscriber.unsubscribe(channel).catch(() => undefined);
      })();
    });
  } catch (cause) {
    return fail(classifyRedisError(`subscribing to ${channel}`, cause));
  }
}

/**
 * Ensures the SERVER'S OWN demo subscriber is listening — this is what makes
 * the /messages round-trip honest: you publish, and the list shows what a real
 * subscriber on a real second connection actually received.
 */
export async function ensureDemoSubscribed(): Promise<Result<null, Failure>> {
  if (listeners.has(REDIS_DEMO_CHANNEL)) return ok(null);
  const result = await subscribe(REDIS_DEMO_CHANNEL, () => undefined);
  return result.ok ? ok(null) : result;
}

export interface PublishResult {
  readonly channel: string;
  readonly message: string;
  /** PUBLISH's own return: how many subscriber CONNECTIONS received it. */
  readonly receivers: number;
  /** Whether this server's own demo subscriber got it (settled after the fanout). */
  readonly received: boolean;
  readonly messages: readonly ReceivedMessage[];
}

/** PUBLISHes on the main connection and reports the fanout honestly. */
export async function publish(channel: string, message: string): Promise<Result<PublishResult, Failure>> {
  // Subscribe before publishing so OUR receiver is in the count — and so the
  // round-trip below is guaranteed for the demo's own channel.
  await ensureDemoSubscribed();

  const result = await runOnClient(`publishing to ${channel}`, async (client) => client.publish(channel, message));
  if (!result.ok) return result;

  // The message event crosses the subscriber socket asynchronously: give it a
  // short settle window so `received` and the ring reflect reality.
  await new Promise((resolve) => setTimeout(resolve, PUBLISH_SETTLE_MS));

  const received = receivedRing.some(
    (entry) => entry.channel === channel && entry.message === message,
  );
  return ok({
    channel,
    message,
    receivers: result.value,
    received,
    messages: listReceivedMessages(channel),
  });
}

/** The newest-first ring of what the server's own subscriber received. */
export function listReceivedMessages(channel?: string): readonly ReceivedMessage[] {
  const scoped = channel === undefined ? receivedRing : receivedRing.filter((entry) => entry.channel === channel);
  return [...scoped].reverse();
}
