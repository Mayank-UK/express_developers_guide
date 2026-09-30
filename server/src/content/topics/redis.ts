import type { Topic } from '../types.js';

/**
 * The Redis topic: what an in-memory data structure server actually IS (and
 * why "just a cache" undersells it), the lazy optional-service connection this
 * repo really runs, the five core structures with their real commands, TTL
 * (per-KEY expiry the server enforces for you), pub/sub over a real second
 * connection, and the use cases worth adding a second datastore for — opening
 * the Caching & Messaging section. Snippets marked verbatim are this app's
 * running source.
 */
export const topicRedis: Topic = {
  id: 'redis',
  title: 'Redis',
  subtitle:
    'Data structures, TTLs, pub/sub, and the use cases worth adding a second datastore for.',
  group: 'caching-messaging',
  order: 1,
  sections: [
    {
      id: 'redis-what',
      title: 'What Redis is',
      lead: 'Redis is an in-memory data STRUCTURE server: a network daemon whose entire dataset usually lives in RAM, exposing strings, hashes, lists, sets and sorted sets as first-class server-side types with one command each. "Cache" is one job it does — the structures are the product.',
      blocks: [
        {
          kind: 'text',
          id: 'redis-what:model',
          body: `THE MENTAL MODEL SHIFT: a database like SQLite (this guide's SQL topics) stores ROWS and answers in a query language; Redis stores KEYS, each holding a data structure, and answers in a COMMAND language — SET, GET, INCR, LPUSH, ZADD — one operation per request, executed against data that lives in memory. Because reads and writes never touch a disk on the hot path, a single Redis instance answers tens of thousands to hundreds of thousands of simple commands per second on commodity hardware, at sub-millisecond latency — that speed is the whole reason it earns a second datastore next to your SQL database. THE SINGLE THREAD is the second half of the story: each connection's commands run on one event loop, one command at a time — which sounds like a weakness and is actually the guarantee. No command observes another command's half-written state, no locks are needed anywhere, and INCR is atomic not because Redis implemented locking but because there is only ever one thread mutating the key. (The exceptions — disk writes, AOF fsync — happen on background threads precisely so the command loop never waits on them.) THE COST side of the trade, stated honestly: RAM is expensive and finite, so a Redis dataset is gigabytes, not terabytes — the data you put there must be SMALL and VOLATILE enough to justify the medium (a cache entry, a counter, a session, a queue's in-flight items), while the SQL database remains the durable system of record. THE WORD "SERVER" matters too: Redis is a separate PROCESS your app talks to over TCP (here, the compose service you will start below) — which means it is shared by every app process that can reach it, making it the natural place for cross-process state like locks, rate counters and pub/sub.`,
        },
        {
          kind: 'text',
          id: 'redis-what:persistence',
          body: `PERSISTENCE IS OPTIONAL — the honest paragraph. RAM loses everything on restart, so Redis offers two mechanisms to survive one: RDB (point-in-time SNAPSHOTS of the dataset written to disk every N minutes or on demand — compact, fast to restore, loses everything since the last snapshot) and AOF (APPEND-ONLY FILE: every write command logged as it happens, replayed on boot — durable to the second or even per-write with fsync policies, at the cost of a growing file that must be rewritten-compacted periodically). The two compose; the common production settings are AOF everysec (accept losing ~1 second) or RDB-only for pure caches. THE GUIDE'S STANCE: for the use cases this topic actually teaches — caches, rate-limit windows, locks — the data is RECOMPUTABLE by definition, so this guide's compose Redis runs with the defaults and nothing here depends on durability; treat "what if Redis restarts empty" as a DESIGN QUESTION you must be able to answer (the cache-aside pattern in the next section answers it: you just miss and refill), not a configuration problem you must solve.`,
        },
      ],
    },
    {
      id: 'redis-connecting',
      title: 'Connecting: the optional-service discipline, again',
      lead: 'This repo treats Redis exactly like Mongo: an OPTIONAL service the app must boot and run without. The client module below is the real one — lazy connect, fail-fast timeout, never a crash.',
      blocks: [
        {
          kind: 'text',
          id: 'redis-connecting:states',
          body: `THE THREE STATES, redis edition: NOT CONFIGURED (REDIS_URL is '' — the state under plain \`npm test\` right now): getRedisClient() resolves null IMMEDIATELY, no ioredis object is ever constructed, and every playground call translates that null into a typed 'unavailable' failure — the HTTP layer answers 503, the guide keeps serving. CONNECTING: ioredis opens one TCP socket with lazyConnect: true (nothing dials until the first caller asks) and connectTimeout ~1200ms, so an absent service costs ~1.2 seconds ONCE, not an endless hang. CONNECTED: the one client is cached for the process lifetime and every command rides it. THE THREE OPTIONS that make a Redis client honest in an optional-service world — read them as the lesson: enableOfflineQueue: false means a command issued while the connection is down REJECTS immediately instead of silently queueing until the server returns (a queued write to a cache is usually a lie — you wanted a cache hit, not a delayed hit); maxRetriesPerRequest: 1 caps how hard one failed command retries, so a flap does not compound into a burst; retryStrategy: null disables the client's own reconnect loop — the guide prefers failures you can SEE over a connection that heals invisibly (the failed client is not cached, so the next call builds a fresh one and the demo recovers the moment the service answers). And the rule shared with the mongo client: an 'error' EVENT listener is attached because ioredis is an EventEmitter and a socket failure with no listener is an unhandled 'error' event that KILLS the process. PUB/SUB CHANGES THE SHAPE of this module (the section below explains why): this app keeps TWO connections — one for commands, one dedicated subscriber — and shutdown closes both.`,
        },
        {
          kind: 'code',
          id: 'redis-connecting:verbatim',
          language: 'ts',
          source: 'server/src/data/redis/redis_client.ts',
          caption: 'Verbatim — the real client singleton (data/redis/redis_client.ts), abridged only where marked; server.ts drains both connections in shutdown',
          code: `const REDIS_CLIENT_OPTIONS = {
  lazyConnect: true,          // nothing dials until the first caller asks
  enableOfflineQueue: false,  // commands on a dead connection reject, never queue
  maxRetriesPerRequest: 1,    // no burst of retries piling up per command
  connectTimeout: REDIS_CONNECT_TIMEOUT_MS,  // 1200 — absent service, fast no
  // The guide never silently reconnects: a lost connection surfaces as
  // failures (the demo degrades), and the next call opens a fresh client.
  retryStrategy: null,
} as const;

export function getRedisClient(): Promise<Redis | null> {
  if (!isRedisConfigured()) {
    // Feature off: no ioredis object is ever created for this call path.
    return Promise.resolve(null);
  }
  clientPromise ??= attemptConnection('commands');   // lazy singleton
  return clientPromise;
}

function attemptConnection(role: 'commands' | 'subscriber'): Promise<Redis | null> {
  const client = new Redis(appConfig.redisUrl, REDIS_CLIENT_OPTIONS);
  // EventEmitter rule (mandatory): without a listener, a socket error becomes
  // an unhandled 'error' event and KILLS the process.
  client.on('error', (err: Error) => {
    logger.warn(
      { err: err.message, role },
      'redis connection error — the redis demo stays degraded until the service answers',
    );
  });
  // 'end' fires when the connection is gone for good (retryStrategy is null,
  // so ioredis never reconnects on its own). Drop ONLY this connection's cache
  // slot so the NEXT caller opens a fresh client:
  client.on('end', () => {
    if (activeClient === client) {
      // …drop the commands slot: activeClient/clientPromise = undefined…
    }
    if (activeSubscriber === client) {
      // …drop the subscriber slot the same way…
    }
  });

  return client
    .connect()
    .then(() => {
      if (role === 'commands') activeClient = client;
      else activeSubscriber = client;
      // …log target + role, then:
      return client;
    })
    .catch((err: Error) => {
      // …log 'redis unreachable — the guide keeps serving'…
      client.disconnect();   // tear down the half-open client
      if (role === 'commands') clientPromise = undefined;   // do NOT cache
      else subscriberPromise = undefined;                   // the failure
      return null;           // null, never a rejection
    });
}

// server.ts shutdown chain: gRPC stops → mongo drains → closeRedis() closes
// BOTH connections (commands + subscriber) → HTTP closes.`,
        },
      ],
    },
    {
      id: 'redis-structures',
      title: 'The core structures',
      lead: 'Five server-side types carry almost every Redis workload. Each row below is a REAL command with its REAL reply from this guide\'s tour — the demo below runs them live.',
      blocks: [
        {
          kind: 'text',
          id: 'redis-structures:tour',
          body: `STRING (SET/GET/INCR): the atom — any bytes up to 512MB, though in practice a JSON blob, a rendered fragment, a flag. The superpower is that a string can be treated as a NUMBER: INCR reads, increments and writes ATOMICALLY in one command (single thread, remember — no lock needed), which is why Redis counters are the canonical "how many" primitive: page views, API hits, inventory dips. The tour runs INCR twice on guide:demo:page:views and the replies are 1 then 2 — a complete read-modify-write cycle with zero race window. HASH (HSET/HGETALL): one key holding FIELD/VALUE pairs — an OBJECT, with fields addressable by name. Reach for it when you would otherwise store a serialized blob and re-parse it to touch one field: HSET profile name Ada role engineer, then HGETALL reads it whole, and HGET profile role reads one field without ever deserializing the rest. LIST (LPUSH/LRANGE): an ordered sequence, pushable and poppable at BOTH ends — a deque. Queues (LPUSH work, a worker BRPOPs it), "recent items" feeds (LPUSH + LTRIM to keep the newest 100), timelines. The tour LPUSHes first/second/third and LRANGE 0 -1 reads back third/second/first — prepends reverse insertion order, which is exactly the "newest first" a feed wants. SET (SADD/SMEMBERS): an unordered collection of UNIQUE members — SADD returns how many it ADDED, so adding an existing member is a no-op with reply 0 (the tour proves it: adding redis again + docker returns 1). Tags, dedupe, presence, "who is online". One honesty note the tour surfaces live: SMEMBERS returns members in an UNSPECIFIED order — Redis gives you uniqueness, never ordering; if you need order, you wanted a sorted set. SORTED SET (ZADD/ZRANGE): members each carrying a SCORE, kept ordered by it — the structure with no clean SQL equivalent (an indexed ORDER BY, materialized). ZADD leaderboard scores its members; ZRANGE 0 -1 REV WITHSCORES reads them ranked, best first, in one command. Leaderboards, priority queues, rate-limit sliding windows, "top N" anything.`,
        },
        {
          kind: 'code',
          id: 'redis-structures:verbatim',
          language: 'ts',
          source: 'server/src/data/redis/redis_playground.ts',
          caption: 'Verbatim — the tour the demo runs (data/redis/redis_playground.ts); these exact commands and replies render in the transcript below',
          code: `// The tour cleans ONLY its own namespace first (SCAN + DEL — never FLUSHDB,
// which would wipe every other key on a shared instance):
const [next, keys] = await client.scan(cursor, 'MATCH', \`\${REDIS_DEMO_NAMESPACE}*\`, 'COUNT', 100);
// …cursor walks every page; then: return client.del(...doomed);

// STRING — SET then GET: the smallest complete round-trip in Redis.
await client.set(\`\${REDIS_DEMO_NAMESPACE}greeting\`, 'Hello from the express guide');
steps.push(step('string', \`SET \${REDIS_DEMO_NAMESPACE}greeting "Hello from the express guide"\`, 'OK', NOTES.string));
const greeting = await client.get(\`\${REDIS_DEMO_NAMESPACE}greeting\`);   // → the string back

// COUNTER — INCR is atomic and creates the key at 1: two INCRs prove it.
const firstCount = await client.incr(\`\${REDIS_DEMO_NAMESPACE}page:views\`);   // → 1
const secondCount = await client.incr(\`\${REDIS_DEMO_NAMESPACE}page:views\`);  // → 2

// HASH — HSET stores field/value pairs; HGETALL reads the object whole.
const fieldsAdded = await client.hset(\`\${REDIS_DEMO_NAMESPACE}profile\`, {
  name: 'Ada',
  role: 'engineer',
});   // → 2
const profile = await client.hgetall(\`\${REDIS_DEMO_NAMESPACE}profile\`);   // → { name: "Ada", role: "engineer" }

// LIST — LPUSH prepends; LRANGE 0 -1 reads the whole list (newest first).
const listLength = await client.lpush(\`\${REDIS_DEMO_NAMESPACE}queue\`, 'first', 'second', 'third');  // → 3
const queue = await client.lrange(\`\${REDIS_DEMO_NAMESPACE}queue\`, 0, -1);  // → ["third","second","first"]

// SET — SADD ignores members already present: the second call adds ONE.
const firstTags = await client.sadd(\`\${REDIS_DEMO_NAMESPACE}tags\`, 'node', 'express', 'redis');  // → 3
const secondTags = await client.sadd(\`\${REDIS_DEMO_NAMESPACE}tags\`, 'redis', 'docker');          // → 1 (!)
const tags = await client.smembers(\`\${REDIS_DEMO_NAMESPACE}tags\`);  // → 4 members, UNSPECIFIED order

// SORTED SET — ZADD scores members; ZRANGE REV WITHSCORES ranks them.
const ranked = await client.zadd(\`\${REDIS_DEMO_NAMESPACE}leaderboard\`, 100, 'ada', 250, 'grace', 180, 'linus');  // → 3
const flat = await client.zrange(\`\${REDIS_DEMO_NAMESPACE}leaderboard\`, 0, '-1', 'REV', 'WITHSCORES');
// RESP2 returns WITHSCORES as a flat [member, score, member, score, …] —
// pair it up so the transcript reads like the leaderboard it is:
// → [{ member: "grace", score: "250" }, { member: "linus", score: "180" },
//    { member: "ada", score: "100" }]`,
        },
        {
          kind: 'demo',
          id: 'redis-structures:playground-demo',
          demoId: 'redis:playground',
          title: 'The redis playground',
          description:
            'Live connection status of the optional redis service, the structure tour as a command→reply transcript, a 10-second TTL key you can watch count down and vanish, and pub/sub with the server\'s own second connection as the proof of delivery. With Redis off: the exact command that turns it on.',
        },
      ],
    },
    {
      id: 'redis-ttl',
      title: 'TTL and expiry',
      lead: 'Every key can carry its own death sentence: SET ... EX seconds (or EXPIRE after the fact), TTL to read what remains, PERSIST to pardon. The SERVER enforces it — no cron, no sweep job in your app. The playground\'s TTL panel (the core-structures section above) watches a key count down to nothing.',
      blocks: [
        {
          kind: 'text',
          id: 'redis-ttl:mechanics',
          body: `THE FOUR COMMANDS: SET guide:key value EX 10 writes the key AND arms a 10-second expiry in one atomic command (SET is "write with options" — EX expires, NX only-if-absent, GET return-the-old-value — and combinations compose); EXPIRE key seconds arms (or re-arms) a TTL on an existing key; TTL key reads the remaining seconds with an honest TRI-STATE — a non-negative count, -1 for "exists but never expires", -2 for "no such key" (the tour's poll endpoint maps that to { exists: false, ttlSecondsRemaining: null }); PERSIST key strips the expiry and makes the key immortal again. TWO SUBTLETIES worth money: a TTL is attached to the KEY, not the value — any SET (a plain overwrite) CLEARS the timer, while INCR/HSET-style field writes do NOT touch it (that is why the demo's POST uses SET ... EX explicitly, every time); and expiry is LAZY-ish — expired keys are removed as they are touched plus by an active background cycle that samples the keyspace, so a key that just expired may answer -2 a moment after its theoretical deadline, never long after. TTL is the feature that turns Redis from "shared memory" into "shared memory that cleans up after itself": cache entries that cannot serve stale data forever, session ids that die with the session, rate-limit windows that close themselves, OTP codes that stop being guessable. KEYSPACE NOTIFICATIONS are the reactive half: Redis can be configured (notify-keyspace-events, the compose service here includes Ex-style events only if you enable them) to PUBLISH expiry events on a channel when keys die — and consuming them uses exactly the subscribe pattern the next section teaches. The honest warning that travels with it: notifications are FIRE-AND-FORGET on pub/sub, so a subscriber that is reconnecting MISSES them — treat expiry events as an optimization (wake up now) with the TTL read as the source of truth (or miss), never as a reliable queue of deaths.`,
        },
        {
          kind: 'code',
          id: 'redis-ttl:verbatim',
          language: 'ts',
          source: 'server/src/data/redis/redis_playground.ts',
          caption: 'Verbatim — the demo\'s real set and poll (redis_playground.ts), and the tri-state TTL read the poll endpoint serves',
          code: `// The SET: value + expiry in ONE atomic command (an overwrite resets the
// timer, which is exactly what a demo rerun wants):
await client.set(key, value, 'EX', seconds);   // → OK

// The POLL: value and remaining seconds together — poll this from the UI:
const [value, ttl] = await Promise.all([client.get(key), client.ttl(key)]);
return {
  key,
  exists: ttl !== -2,                       // -2 = no such key (it died)
  ttlSecondsRemaining: ttl >= 0 ? ttl : null, // -1 = exists, NO expiry
  value,                                      // null once expired
};

// The family, for the record:
//   EXPIRE guide:demo:key 30   // arm a TTL on an existing key
//   TTL guide:demo:key         // 7 | 0 | -1 (no expiry) | -2 (gone)
//   PERSIST guide:demo:key     // strip the expiry — the key lives forever

// Keyspace notifications (config-gated; fire-and-forget — see the warning):
//   subscriber.subscribe('__keyevent@0__:expired')  // events PUBLISH themselves`,
        },
      ],
    },
    {
      id: 'redis-pubsub',
      title: 'Pub/Sub',
      lead: 'PUBLISH sends a message to every subscriber of a channel — except that a SUBSCRIBEd connection cannot run regular commands, so real pub/sub needs a SECOND connection. The demo round-trips through one, live.',
      blocks: [
        {
          kind: 'text',
          id: 'redis-pubsub:model',
          body: `THE MODEL: publishers address CHANNELS, not receivers — PUBLISH guide:demo:channel "hello" returns the number of subscriber CONNECTIONS that received it (a count you can alert on: zero means nobody was listening), and every connection currently SUBSCRIBEd to that channel gets the message pushed to it in real time. Publishers and subscribers never know each other exist — that decoupling is the point: a cache can subscribe to invalidation signals, a websocket gateway to chat channels, ten workers to job announcements. THE ONE RULE that bites everyone: after a connection issues SUBSCRIBE it is in SUBSCRIBER MODE and may only (p|s)subscribe and (p|s)unsubscribe — send it a GET and the server answers with an error. So an app doing pub/sub while also doing commands holds TWO connections (exactly what this guide's client module does: one commands client, one dedicated subscriber created lazily on the first subscribe — never at boot). THE DELIVERY CONTRACT, honestly: pub/sub is fire-and-forget with NO persistence — a published message reaches whoever is subscribed AT THAT INSTANT and then ceases to exist; a listener that was reconnecting missed it and will never see it; there is no replay, no acknowledgment, no backlog. That makes it right for FANOUT and SIGNALS (invalidate caches, tickle presence, broadcast "reload config") and wrong for WORK QUEUES — a job that must not be lost needs a LIST (LPUSH/BRPOP) or a STREAM (which adds consumer groups, acks and history) instead. Missed-message risk is not a bug to engineer around downstream; it is the contract, so the design question is always "is it okay that nobody got this?" — and this guide's demo makes the answer visible: PUBLISH answers with the receiver count, and its messages list shows only what the server's OWN subscriber (a real second connection, subscribed before the publish) actually received.`,
        },
        {
          kind: 'code',
          id: 'redis-pubsub:verbatim',
          language: 'ts',
          source: 'server/src/data/redis/redis_playground.ts',
          caption: 'Verbatim — the real two-connection pattern (redis_playground.ts): subscribe on the dedicated connection, publish on the commands one',
          code: `// SUBSCRIBE — on the DEDICATED connection (getRedisSubscriber(), a second
// socket; after SUBSCRIBE this connection may not run regular commands).
// ONE 'message' handler dispatches to every listener on every channel:
subscriber.on('message', (deliveredChannel: string, message: string) => {
  const received: ReceivedMessage = {
    channel: deliveredChannel,
    message,
    receivedAt: new Date().toISOString(),
  };
  appendCapped(receivedRing, received);
  for (const registered of listeners.get(deliveredChannel) ?? []) registered(received);
});
// …then the channel's own SUBSCRIBE — awaiting the reply GUARANTEES the
// server registered the subscription before the next line runs:
await subscriber.subscribe(channel);
// ^ a PUBLISH after this point is guaranteed to be counted and delivered.

// UNSUBSCRIBE — the teardown twin, and the ordering rule this file leans on:
await subscriber.unsubscribe(channel).catch(() => undefined);
// UNSUBSCRIBE (subscriber socket) and a later PUBLISH (commands socket) are
// DIFFERENT connections with no ordering between them — await the unsubscribe
// before publishing if "receivers: 0" must be deterministic.

// PUBLISH — on the COMMANDS connection:
const result = await runOnClient(\`publishing to \${channel}\`, async (client) => client.publish(channel, message));
// result.value === how many subscriber CONNECTIONS got it (0 = nobody listening)`,
        },
      ],
    },
    {
      id: 'redis-usecases',
      title: 'The use cases worth a second datastore',
      lead: 'Caching, rate limiting, sessions, leaderboards, distributed locks — the five workloads that justify Redis in an Express stack, each with the structure that carries it and the honest caveat that ships with it.',
      blocks: [
        {
          kind: 'text',
          id: 'redis-usecases:catalog',
          body: `CACHING (STRINGS, with TTL): the pattern is CACHE-ASIDE — your code checks Redis first, on a miss loads from the slow source (SQL, an API), writes the value back WITH a TTL, and serves; invalidation is deletion (DEL the key when the source changes), and staleness is bounded by the TTL you chose. Because Redis is shared across processes, every app instance sees the SAME cache — the multi-process version of an in-memory Map, minus the per-process divergence. The full pattern (including stampedes — a thousand requests all missing on the same hot key at once) is the NEXT TOPIC in this section, which builds on this one. RATE LIMITING (INCR + EXPIRE): the fixed window is three lines — INCR the caller's key, and if the reply is 1 it is a NEW window so EXPIRE it N seconds; reply > limit → 429. Because INCR is atomic and Redis is shared, the count is exact across every process behind your load balancer — something no single Node process can promise. The sliding-window refinement replaces the integer with a SORTED SET (ZADD the timestamp, ZREMRANGEBYSCORE everything older than the window, ZCARD the count) — smoother at window edges, more memory per key. The SECURITY topic will wire this to a real trippable limiter. SESSIONS (HASHES or STRINGS, with TTL): a session id in a cookie, its server-side state in Redis keyed by that id, TTL = idle timeout (touched on activity). Shared across processes (any instance can serve any request), evicted automatically when abandoned — and the AUTH topics implement exactly this store. LEADERBOARDS AND COUNTERS (SORTED SETS, INCR): ZINCRBY updates a score atomically; ZREVRANK reads a rank; the top-N is one ZRANGE REV — all O(log n) server-side work your SQL would do with an indexed ORDER BY plus a query per question. DISTRIBUTED LOCKS (SET NX): SET lock-key token NX PX 30000 acquires — one command, atomic test-and-set; the TOKEN (a random value you generated) makes release safe: release is "delete only if the value is MY token", done in a Lua script so check-and-delete is itself atomic (you must never DEL a lock you no longer own — it may now be someone else's). The honest paragraph this deserves: the naive lock is BROKEN for long work — if your process pauses (GC, CPU starvation) past the lock's TTL, the lock EXPIRES, another process acquires, and your resumed process now holds a STALE belief it owns the lock; the standard mitigations are token-checked release (above) plus renewal (a background task extends the TTL while work continues, with its own failure modes) — and the standing advice to reach for proven implementations (Redlock and its critics are a famous literature) before hand-rolling. A lock in Redis is an optimistic coordination tool, not a correctness guarantee the engine gives you.`,
        },
        {
          kind: 'code',
          id: 'redis-usecases:sketches',
          language: 'ts',
          source: 'server/src/domain/teaching/exhibit_b_redis_usecase_sketches.ts',
          caption: 'The two sketches worth internalizing, quoted from the teaching exhibit server/src/domain/teaching/exhibit_b_redis_usecase_sketches.ts (the caching and security topics make them real endpoints)',
          code: `// FIXED-WINDOW RATE LIMIT — the whole idea in three commands:
export async function isOverFixedWindowLimit(
  client: Redis,
  ip: string,
  minuteBucket: string,
  limit = 100,
): Promise<boolean> {
  const hits = await client.incr(\`ratelimit:\${ip}:\${minuteBucket}\`);
  if (hits === 1) await client.expire(\`ratelimit:\${ip}:\${minuteBucket}\`, 60);
  return hits > limit; // true → the caller gets a 429
}

// DISTRIBUTED LOCK — acquire, work, release-if-still-yours. Acquire half:
// SET NX PX is an atomic test-and-set; the token (a random value only this
// caller knows) is what makes release safe.
export async function acquireLock(client: Redis, key: string): Promise<string | null> {
  const token = randomUUID();
  const acquired = await client.set(key, token, 'PX', 30_000, 'NX');
  return acquired === 'OK' ? token : null; // null → someone else holds it
}
// …the work MUST finish inside the TTL — or "renew" while working (see the
// text above). Release half — delete only if the value is OUR token, in a Lua
// script so check-and-delete is itself atomic (never DEL a lock you no
// longer own — it may now be someone else's):
export async function releaseIfStillOurs(client: Redis, key: string, token: string): Promise<number> {
  return (await client.eval(
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end',
    1,
    key,
    token,
  )) as number;
}`,
        },
      ],
    },
    {
      id: 'redis-live',
      title: 'The tour from a terminal',
      lead: 'The playground\'s endpoints driven from a terminal (the interactive panel lives in the core-structures section above): the status of the optional connection, the structure tour as a real command→reply transcript, a TTL you watch count down to nothing, and pub/sub proving itself through the server\'s own second connection. Needs the optional redis service — and gracefully says so when it is missing.',
      blocks: [
        {
          kind: 'text',
          id: 'redis-live:intro',
          body: `THE SERVICE IS OPTIONAL, like Mongo before it: without REDIS_URL (or with the container down), the status endpoint reports OFF with the exact command that turns it on — docker compose -f .docker/docker-compose.yml up -d redis — and the data endpoints answer the canonical 503 envelope while nothing else in the guide notices. WITH THE SERVICE UP, the curl block below drives the playground's endpoints (the panel itself lives in the core-structures section above): the TOUR runs every command with its REAL reply, grouped by family, including the SADD that adds only "docker" because "redis" was already a member, and the sorted set's ranked reply. TTL sets a key with a 10-second death sentence, then polling reads it back every second — a counter going 9, 8, 7 … until exists flips to false and the key is gone (the server did that; no code of ours ran). PUB/SUB publishes to the demo channel and shows what came back: PUBLISH's receiver count, whether this server's OWN subscriber (its real second connection, subscribed before you published) received it, and the ring of recent messages — channel, message, and the moment it landed.`,
        },
        {
          kind: 'code',
          id: 'redis-live:curl',
          language: 'bash',
          caption: 'The whole loop from a terminal (server: npm run dev in server/; redis: the compose command above)',
          code: `# 0. the optional service (skip if it is already up):
docker compose -f .docker/docker-compose.yml up -d redis

# 1. status — connection state, target, and the live server version:
curl -s localhost:4000/api/demo/redis/status | jq '{configured, connected, host, serverInfo}'

# 2. the structure tour — every command with its REAL reply (run it twice:
#    the tour cleans its guide:demo:* keys first, so transcripts match):
curl -s localhost:4000/api/demo/redis/tour | jq '.steps[] | {structure, command, reply}'

# 3. TTL — set a 10s key, then poll and watch it count down to nothing:
curl -s -X POST localhost:4000/api/demo/redis/ttl \\
  -H 'content-type: application/json' \\
  -d '{"key":"ttl:watch","value":"this key expires","seconds":10}' | jq
sleep 4
curl -s 'localhost:4000/api/demo/redis/ttl?key=guide:demo:ttl:watch' | jq
sleep 7
curl -s 'localhost:4000/api/demo/redis/ttl?key=guide:demo:ttl:watch' | jq '{exists, ttlSecondsRemaining}'

# 4. pub/sub — publish (note "receivers": our own second connection) and
#    read what the server's own subscriber actually received:
curl -s -X POST localhost:4000/api/demo/redis/publish \\
  -H 'content-type: application/json' \\
  -d '{"channel":"guide:demo:channel","message":"hello from curl"}' \\
  | jq '{receivers, received, messages}'
curl -s 'localhost:4000/api/demo/redis/messages?channel=guide:demo:channel' | jq '.messages[0]'

# 5. with Redis stopped, everything degrades — status says off, data says 503:
docker compose -f .docker/docker-compose.yml stop redis
curl -s localhost:4000/api/demo/redis/status | jq '{configured, connected, note}'
curl -s localhost:4000/api/demo/redis/tour | jq '.error.code'   # service_unavailable
docker compose -f .docker/docker-compose.yml up -d redis        # and it recovers`,
        },
      ],
    },
  ],
};
