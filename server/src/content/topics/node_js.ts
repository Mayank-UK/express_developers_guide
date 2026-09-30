import type { Topic } from '../types.js';

/**
 * The runtime topic: the Node.js platform an Express server lives inside.
 * Code samples are real lines from this repo (server.ts, app_config.ts,
 * sqlite_client.ts, node_demo_routes.ts, package.json + tsconfig.json, the
 * reliability circuit breaker, and the domain/teaching exhibits); skeletons
 * that are illustrative rather than verbatim say so in their captions.
 */
export const topicNodeJs: Topic = {
  id: 'node-js',
  title: 'Node.js Fundamentals',
  subtitle:
    'Event loop, async I/O, streams, and the process model your Express app lives inside.',
  group: 'fundamentals',
  order: 2,
  sections: [
    {
      id: 'node-what',
      title: 'What Node.js actually is',
      lead: 'V8 runs your JavaScript; libuv runs everything else. That one split explains almost every behavior a Node server exhibits.',
      blocks: [
        {
          kind: 'text',
          id: 'node-what:concept',
          body: `Concept first: Node.js is three things stacked together. V8 — the same JavaScript engine Chrome ships — executes your code. libuv, a C library, provides the event loop and the asynchronous I/O. And a standard library exposes the operating system to JavaScript: files, sockets, timers, processes, crypto. Your JavaScript runs on ONE thread, one call stack, one instruction at a time, for the entire life of the process. Nothing in your code ever runs in parallel with anything else in your code.\n\nEverything else is delegated. Network sockets use the operating system's own async interfaces (epoll on Linux, kqueue on macOS, IOCP on Windows): you ask the OS to notify you when a socket is readable, and it costs nothing to wait. Operations with no async OS API — some file-system work, DNS lookups, a few CPU-heavy crypto functions — run on libuv's small pool of worker threads (four by default) while your thread moves on. When any of that work completes, the event loop picks up the result and runs your callback.`,
        },
        {
          kind: 'text',
          id: 'node-what:concurrency',
          body: `That architecture is why a single Node process holds thousands of concurrent connections. Each connection served by a traditional thread-per-request server costs an OS thread — megabytes of stack, a context switch per request. Each connection held by a Node process costs a file descriptor and an entry in a queue while it waits, and a slice of the single thread only while your JavaScript actually has something to do. Waiting is free; that is the whole design.\n\nThe cost of the design is the mirror image: exactly one thread also means exactly one point of congestion. One slow synchronous operation delays every connection at once — which is the next section, and the first live demo on this screen.`,
        },
        {
          kind: 'code',
          id: 'node-what:listen',
          language: 'ts',
          caption:
            'server/src/server.ts — verbatim; one call, and the operating system does the waiting',
          source: 'server/src/server.ts',
          code: `const server = app.listen(appConfig.port, '0.0.0.0', () => {
  logger.info(
    { port: appConfig.port, nodeEnv: appConfig.nodeEnv },
    'express_developers_guide server listening',
  );
});
// Underneath: bind a socket, hand it to the OS, return immediately. Every
// incoming connection afterwards arrives as an event; the callback above runs
// once, when the socket is ready — not once per connection.`,
        },
      ],
    },
    {
      id: 'node-loop',
      title: 'The event loop',
      lead: 'Timers, poll, check — and microtasks between everything. The golden rule: never block the loop.',
      blocks: [
        {
          kind: 'text',
          id: 'node-loop:concept',
          body: `Concept first: the event loop is a scheduler with a repeating set of phases. In essence each turn runs: expired timers (setTimeout / setInterval callbacks), then pending system work, then poll — where completed I/O delivers results and new connections arrive — then check, where setImmediate callbacks run. Then the turn starts over. You never see the loop itself; you just keep handing it callbacks and it decides when they run.\n\nThreaded through the phases are the microtask queues, and they outrank everything. After EVERY callback — and between phases — Node first drains the process.nextTick queue, then the promise queue, and only then continues the loop. A pending .then() runs before any timer, any immediate, any I/O event, always.`,
        },
        {
          kind: 'code',
          id: 'node-loop:ordering',
          language: 'ts',
          caption:
            'server/src/presentation/routes/node_demo_routes.ts — verbatim: the stall probe every node demo uses (the microtask-vs-macrotask ordering rules it relies on, in the comments)',
          source: 'server/src/presentation/routes/node_demo_routes.ts',
          code: `// The probe: scheduled NOW, but it cannot fire until this handler's
// synchronous work finishes — the schedule-to-fire gap IS the loop stall.
// Ordering rules it relies on, observable in any Node process:
//   process.nextTick(...)         -> 1. nextTick queue, drained first, always
//   Promise.resolve().then(...)   -> 2. promise microtasks, still before macrotasks
//   setImmediate(...)             -> 3. check phase, this loop turn
//   setTimeout(..., 0)            -> 4. timers phase, NEXT loop turn
// nextTick beats promises; both beat every macrotask. And scheduled from the
// main module, setImmediate beats a 0ms setTimeout because this loop turn
// reaches the check phase before it wraps around to timers.
const scheduledAt = performance.now();
let firedAt = 0;
setImmediate(() => {
  firedAt = performance.now();
});
busyHashFor(workMs, createHash('sha256'));
// One more loop turn so the probe (queued first) has fired before we answer.
await new Promise<void>((resolve) => setImmediate(resolve));`,
        },
        {
          kind: 'text',
          id: 'node-loop:rule',
          body: `The golden rule follows directly from the architecture: never block the loop. The loop is cooperative — your callback runs to completion, and nothing else in the process runs JavaScript until it returns. A handler that returns in two milliseconds keeps ten thousand connections smooth; a handler that computes for three hundred milliseconds pauses the entire server for three hundred milliseconds — health checks time out, load balancers mark the instance dead, every user waits. And "blocking" is not exotic: a *Sync fs call, JSON.parse of a hundred-megabyte payload, a naive regex over hostile input, a tight hash loop — anything that owns the single thread counts.\n\nNode can even measure violations: perf_hooks.monitorEventLoopDelay records the real gaps between loop turns. The demo below uses a simpler probe — a setImmediate callback scheduled before the work starts, timed when it finally fires — which is exactly the stall your other requests would have felt.`,
        },
      ],
    },
    {
      id: 'node-loop-phases',
      title: 'Event loop phases and microtasks',
      lead: 'One turn of the loop, phase by phase — and the two queues that outrank every phase. This is the machinery the golden rule was about.',
      blocks: [
        {
          kind: 'text',
          id: 'node-loop-phases:phases',
          body: `A loop turn runs, in order: TIMERS — callbacks whose deadline has passed, for setTimeout and setInterval; PENDING CALLBACKS — a few system operations deferred from the previous turn; POLL — the heart of the loop, where completed I/O delivers its results and where, when nothing is ready, the loop blocks waiting for the next event; CHECK — setImmediate callbacks; CLOSE — 'close' events from finished handles. Then the turn ends and timers are evaluated again.\n\nTwo phase facts explain most timing surprises. setTimeout(fn, 0) does not mean "next": it means "not before the next TIMERS phase", and a busy poll phase can push that arbitrarily far out — which is why the stall probe in the previous section schedules with setImmediate (this turn's check phase) rather than a timer. And the loop is cooperative at every seam: a phase runs every queued callback to completion before moving on, so one long timer callback delays the poll phase, which delays every socket.`,
        },
        {
          kind: 'text',
          id: 'node-loop-phases:microtasks',
          body: `Threaded through all of it: the microtask queues. After EVERY callback — and again between phases — Node drains the process.nextTick queue first, then the promise queue, before the loop advances even one step. Promises beat setImmediate; setImmediate beats a 0ms timer; nextTick beats everything. For your own code, prefer queueMicrotask (or just an awaited promise): it rides the standard queue. Reserve process.nextTick for needing to run strictly before any promise callback — a niche Node itself uses to keep some backward-compatible APIs synchronous.\n\nThe queues are also the sharpest starvation hazard in the runtime. Microtasks scheduled from within microtasks keep the checkpoint draining forever: a function that recursively schedules itself with nextTick or queueMicrotask never yields a full loop turn, so timers never fire, poll never delivers a socket event, and the process looks dead while burning CPU. The cure is the same as for a blocking while-loop — hand control back to the loop itself, with setImmediate.`,
        },
        {
          kind: 'code',
          id: 'node-loop-phases:slicing',
          language: 'ts',
          caption:
            'server/src/presentation/routes/node_demo_routes.ts — verbatim: the deferred demo endpoint’s cure for starvation — the same CPU work, sliced across loop turns',
          source: 'server/src/presentation/routes/node_demo_routes.ts',
          code: `/** The same CPU work, yielded back to the event loop every SLICE_MS. */
function chunkedHashFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const deadline = performance.now() + ms;
    const slice = (): void => {
      busyHashFor(Math.min(SLICE_MS, deadline - performance.now()), hash);
      if (performance.now() < deadline) setImmediate(slice);
      else resolve();
    };
    slice(); // the first slice runs synchronously, then we start yielding
  });
}`,
        },
        {
          kind: 'text',
          id: 'node-loop-phases:why-slicing-works',
          body: `Read it as a protocol between you and the loop. Each slice runs at most SLICE_MS (10ms) of hashing and then schedules its successor with setImmediate — the check phase of a LATER turn — and returns. Between slices the loop completes full turns: microtask checkpoints drain, timers fire, poll delivers whatever sockets arrived. No single slice owns the thread long enough to hurt anybody. The demo's deferred endpoint runs this exact function, which is why its measured stall stays at one slice no matter how large the total workload — and why the blocking endpoint, doing the identical work in one burst, reports a stall equal to the whole workload. The honest trade: slicing adds a little total wall time (turn overhead between slices) in exchange for a loop that never freezes — the same trade every cooperative scheduler makes.`,
        },
      ],
    },
    {
      id: 'node-streams',
      title: 'Buffers and streams',
      lead: 'A Buffer is raw bytes; a stream is bytes over time. Together they let a process handle payloads far larger than its memory.',
      blocks: [
        {
          kind: 'text',
          id: 'node-streams:concept',
          body: `Concept first, buffers: a Buffer is a fixed-length sequence of raw bytes — not a string. Strings carry an encoding; a Buffer is the bytes themselves. All I/O moves bytes, and encoding is a conversion you ask for at the edges. The classic surprise is length: a Buffer's length counts bytes, and UTF-8 encodes most non-ASCII characters as several bytes each, so "café" is four characters but five bytes.`,
        },
        {
          kind: 'code',
          id: 'node-streams:buffer',
          language: 'ts',
          caption:
            'server/src/presentation/routes/perf_demo_routes.ts — verbatim: a serialized payload measured in bytes (the café arithmetic in the comments)',
          source: 'server/src/presentation/routes/perf_demo_routes.ts',
          code: `// Buffers are bytes, not characters. The classic surprise:
//   const text = 'café';
//   text.length;                     // 4 — characters
//   Buffer.byteLength(text, 'utf8'); // 5 — bytes (é is two bytes in UTF-8)
//   const chunk = Buffer.from(text, 'utf8');
//   chunk.length;                    // 5 — a Buffer's length is always bytes
//   chunk[0];                        // 99 — raw byte values, not characters
// The performance topic's payload endpoint makes the same point on real
// traffic — a header that counts what would actually ride the wire:
res.set('x-payload-raw-bytes', String(Buffer.byteLength(raw)));`,
        },
        {
          kind: 'text',
          id: 'node-streams:streams',
          body: `A stream is a buffer spread over time: an EventEmitter that produces or consumes data in chunks instead of all at once. There are four kinds — readable (a file being read, an HTTP response body), writable (a file being written, an HTTP response you are sending), duplex (both directions, like a TCP socket), and transform (readable and writable that converts in flight, like gzip).\n\nWhy streams beat buffering for big payloads: memory stays constant — a process can pipe a ten-gigabyte log through gzip using a few megabytes of RAM, where readFileSync plus compression would need several full copies. The first byte leaves immediately instead of after the entire payload exists. And streams compose: source → transform → sink, with backpressure — when a consumer cannot keep up, writable.write() returns false and a well-wired pipeline pauses the producer until 'drain', instead of ballooning memory. The second live demo on this screen shows the constant-memory idea from the client's side of the wire.`,
        },
        {
          kind: 'code',
          id: 'node-streams:pipeline',
          language: 'ts',
          caption:
            'server/src/presentation/routes/files_demo_routes.ts — verbatim: streaming a file off disk into the response without ever holding it whole (the compose-with-transforms shape in the comments)',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          code: `// The canonical composing shape (pipeline wires errors AND backpressure):
//   await pipeline(
//     createReadStream('data/access.log'), // fs source…
//     createGzip(),                        // …gzip transform…
//     createWriteStream('data/access.log.gz'), // …file sink
//   );
// (pipeline also closes every stream on error — the reason it replaced the
// older bare .pipe() style, which silently swallowed errors; the files
// topic's streamer keeps .pipe but routes it through a helper that owns the
// 'error' event — the same lesson, hand-rolled.) It is the same source→sink
// idea over an HTTP response — the full representation, straight from disk:
streamFileToResponse(res, absolutePath, requestId); // error-guarded source→sink
// …and a Range slice, 206 + exactly the requested bytes:
//   streamFileToResponse(res, absolutePath, requestId, { start, end });`,
        },
      ],
    },
    {
      id: 'node-fs',
      title: 'The fs and path modules',
      lead: 'The filesystem API comes in three flavors; knowing when each is a tool versus a weapon is the whole skill.',
      blocks: [
        {
          kind: 'text',
          id: 'node-fs:concept',
          body: `Concept first: nearly every fs function ships as a triplet — callback style (fs.readFile), synchronous (fs.readFileSync), and promise style (fs/promises readFile). The choice is a scheduling decision, not a style preference. The sync variants block the event loop until the OS answers: fine at boot, when nothing is serving yet and code that reads top-to-bottom is worth more than concurrency; catastrophic inside a request path, where it is the golden-rule violation from the event-loop section wearing a different hat. For big files, prefer the streaming forms (createReadStream / createWriteStream) over any read-whole-file variant.\n\nThe path module is small and non-optional discipline: path.join assembles segments with the right separator for the platform, path.resolve turns a relative path absolute against the working directory, path.dirname strips the last segment. Hand-concatenating with '/' is how cross-platform bugs are born.`,
        },
        {
          kind: 'code',
          id: 'node-fs:mkdir',
          language: 'ts',
          caption:
            'server/src/data/posts/sqlite_client.ts — verbatim: a deliberate sync call, made once',
          source: 'server/src/data/posts/sqlite_client.ts',
          code: `function openDatabase(): Database.Database {
  // better-sqlite3 creates the db FILE but never its parent directory, and a
  // fresh checkout has no server/data/ — create it before opening (never for
  // the in-memory test database).
  if (appConfig.dbPath !== ':memory:') {
    mkdirSync(path.dirname(appConfig.dbPath), { recursive: true });
  }
  return new Database(appConfig.dbPath);
}
// mkdirSync on the request path would stall every request for a disk round
// trip. Here it runs at most once per process, before the first query — the
// boot-time pattern where sync is the honest choice.`,
        },
        {
          kind: 'code',
          id: 'node-fs:path',
          language: 'ts',
          caption:
            'server/src/core/config/app_config.ts — verbatim: path.resolve anchors a relative path to the package root',
          source: 'server/src/core/config/app_config.ts',
          code: `// Loads \`.env.{nodeEnv}\` from the package root (cwd when run via npm scripts).
dotenv.config({ path: path.resolve(process.cwd(), \`.env.\${nodeEnv}\`) });
// path.resolve: ".env.development" + cwd -> an absolute path, so dotenv finds
// the same file no matter how the process was launched.`,
        },
        {
          kind: 'text',
          id: 'node-fs:judgment',
          body: `Worth naming out loud: this repo's database driver, better-sqlite3, is entirely synchronous by design — every query blocks until SQLite answers. That is a deliberate, defensible trade for a teaching server: one process, a local file database where queries take microseconds, zero connection-pool complexity. The same choice against a networked database would be an outage waiting to happen — network round trips are measured in milliseconds, and blocking the loop for those adds up to the exact stall the first demo measures. Judgment, not dogma: sync is acceptable when the wait is bounded and local; async is mandatory when it is not.`,
        },
      ],
    },
    {
      id: 'node-modules',
      title: 'Modules and the toolchain',
      lead: 'Two module systems, one package — how Node loads your code, why TypeScript imports end in .js, and what each npm script actually runs.',
      blocks: [
        {
          kind: 'text',
          id: 'node-modules:history',
          body: `Node grew up on CommonJS: require() and module.exports, synchronous, dynamic — you can require inside an if. ES modules (import/export) arrived later as the language-standard system: statically analyzable (imports hoist, specifiers resolvable without executing the code), friendly to bundlers and tree-shaking, capable of top-level await, and identical in shape to what browsers run. Node supports both, and "type": "module" in package.json is the switch that makes every file in the package an ES module — the setting this repo's server package uses. The one ESM rule that catches everyone reared on CJS: specifiers are exact. Node does not guess extensions and does not walk directories for you; an import names a file.`,
        },
        {
          kind: 'code',
          id: 'node-modules:package-json',
          language: 'json',
          caption: 'server/package.json — verbatim: the module-system switch and the four scripts that run this package',
          source: 'server/package.json',
          code: `// one flag picks the module system for the whole package:
"type": "module",
// …
"scripts": {
    "dev": "tsx watch src/server.ts",  // run TS directly, restart on save — no build in the loop
    "build": "tsc",                    // type-check + emit dist/ — the gate every change must pass
    "test": "vitest run",              // behavior stays proven (Supertest drives the real app)
    "start": "node dist/server.js"     // production: compiled output, no watcher, no TypeScript
  },`,
        },
        {
          kind: 'text',
          id: 'node-modules:nodenext',
          body: `So why does this repo's TypeScript import './presentation/routes/index.js' — a .js suffix on a .ts file? Because with "module": "NodeNext", the specifier names the file AS IT WILL EXIST AT RUNTIME: tsc compiles src/presentation/routes/index.ts into dist/presentation/routes/index.js, and Node resolves the import against that emitted path. The compiler is simply refusing to let you write an import that would 404 in production. The pleasant surprise is tsx in the dev script: it runs TypeScript directly (transforming on the fly) AND resolves .js specifiers back to their .ts sources, so the same imports work unbuilt in the morning loop and compiled in the Docker image. This is a Node-runtime convention, not a TypeScript lesson — the TypeScript and JavaScript Fundamentals topic owns the language side.`,
        },
        {
          kind: 'code',
          id: 'node-modules:tsconfig',
          language: 'json',
          caption: 'server/tsconfig.json — verbatim (the module-system lines are quoted in the Express setup section)',
          source: 'server/tsconfig.json',
          code: `{
  "compilerOptions": {
    "target": "ES2022",
    // …module + moduleResolution: "NodeNext" — the .js-specifier rule above…
    "outDir": "dist",   // src/server.ts  ->  dist/server.js (what "start" runs)
    "rootDir": "src",   // every input lives under src/ — so dist mirrors it exactly`,
        },
        {
          kind: 'text',
          id: 'node-modules:watch',
          body: `Three ways to run this server, and what each is for. tsx watch (the dev script): transforms TypeScript in memory and restarts the process on every save — fastest inner loop, but note it does NOT type-check, which is why "npm run build" stays the definition of done. node --watch: Node's own restart-on-change, but it runs JavaScript only — it is for watching the compiled dist/ output, not sources. And plain node dist/server.js (the start script): what production runs — no watcher at all, because restarting on file change is a process manager's job, not the process's own (Docker and the deployment topic own that story). One package, one source tree, three runtimes of the same code.`,
        },
      ],
    },
    {
      id: 'node-process',
      title: 'Process, environment, and signals',
      lead: `process is Node's handle on itself: configuration came from the environment, and signals tell it when to stop.`,
      blocks: [
        {
          kind: 'text',
          id: 'node-process:concept',
          body: `Concept first: every Node program runs inside a process, and the process global is that process seen from JavaScript — process.env (the environment it was started with), process.argv (the command line), process.pid, process.uptime(), process.exit(). Two of these deserve senior-level respect.\n\nConfiguration through process.env is the 12-factor rule: the same build of the app is promoted unchanged between environments, and what changes is the environment itself. The companion discipline is validation at boot — read env once, check it, freeze it — which is exactly what this repo's app_config.ts does (the Environments topic covers it in depth). And the exit code is a real API: exit 0 means success, non-zero means failure, and the process manager supervising you — Docker, systemd, Kubernetes — reads it to decide whether to restart, alert, or give up.`,
        },
        {
          kind: 'code',
          id: 'node-process:shutdown',
          language: 'ts',
          caption: `server/src/server.ts — verbatim (the ordered dependency drains elided): this server's actual graceful-shutdown path`,
          source: 'server/src/server.ts',
          code: `/** Graceful shutdown: stop accepting connections, finish in-flight work, exit. */
function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down gracefully');
  // …the drain chain runs in finally order before HTTP closes: stop gRPC,
  // close mongo, close BOTH redis connections, close the websocket chat hub —
  // a failure on any path still reaches server.close()…
  server.close(() => {
    logger.info('http server closed');
    process.exit(0);
  });
  // Safety net: server.close() waits on keep-alive connections; don't hang forever.
  const forceExitTimer = setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));`,
        },
        {
          kind: 'text',
          id: 'node-process:signals',
          body: `SIGINT is Ctrl-C; SIGTERM is what docker stop and kubectl delete actually send. Without a handler, both kill the process instantly — mid-request, mid-query, mid-write. With the handler above, the sequence is: stop accepting NEW connections (server.close), let in-flight requests finish, flush the logs, exit 0. Two details in that snippet reward a second look. The force-exit timer is unref()'d — an unref'd timer does not keep the event loop alive, so it costs nothing if shutdown completes normally. And the timer exists at all because server.close() also waits on keep-alive sockets, which clients may sit on for seconds; a graceful shutdown without a deadline is just a hang with better logging.`,
        },
      ],
    },
    {
      id: 'node-async-patterns',
      title: 'Async patterns you will actually use',
      lead: 'promisify for the legacy world, AbortController for cancellation, AsyncLocalStorage for context — the three runtime utilities a backend reaches for weekly.',
      blocks: [
        {
          kind: 'text',
          id: 'node-async-patterns:promisify',
          body: `Node's older APIs speak callbacks (error-first: (err, result) => void), and you will meet them in the wild and in older tutorials. The bridge is util.promisify: hand it a callback-style function and get a promise-returning one, no hand-rolled Promise wrapper per call site — and for new code, most of the standard library already ships promise forms under node:fs/promises, node:timers/promises, and friends (this repo's better-sqlite3 is synchronous by design, so its calls need neither). Beyond single calls, learn the combinators as a set: Promise.all fails fast, Promise.allSettled always settles and reports each outcome, Promise.race takes the first settled — whichever comes — and Promise.any takes the first FULFILLED. Race in particular is not an exotic tool; it is how deadlines get built.`,
        },
        {
          kind: 'text',
          id: 'node-async-patterns:abort',
          body: `The pattern that matters most in servers is CANCELLATION. A request that timed out or a client that disconnected should stop the work behind it, not just ignore the result — otherwise abandoned work piles up on the loop and the pool. The platform answer is AbortController: create one, race its signal against your deadline, and — the half everyone forgets — HAND THE SIGNAL INTO the operation, because fetch, database drivers, and stream pipelines accept an AbortSignal and will genuinely stop. The quote below is this repo's real deadline machinery, from the hand-rolled circuit breaker: slow counts as down, so every call through the breaker races its own deadline.`,
        },
        {
          kind: 'code',
          id: 'node-async-patterns:race',
          language: 'ts',
          caption:
            'server/src/domain/reliability/circuit_breaker.ts — verbatim: a per-call deadline built from AbortController + Promise.race',
          source: 'server/src/domain/reliability/circuit_breaker.ts',
          code: `/** Races the operation against the deadline; the signal lets it self-cancel. */
private raceDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let handle: unknown;
  if (this.timeoutMs !== undefined) {
    const timeoutMs = this.timeoutMs;
    handle = this.setTimeoutFn(() => controller.abort(), timeoutMs);
  }
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new CircuitTimeoutError(this.timeoutMs as number)),
      { once: true },
    );
  });
  const race = Promise.race([operation(controller.signal), deadline]);
  if (handle === undefined) return race; // no deadline configured — nothing to clean up
  return race.finally(() => this.clearTimeoutFn(handle));
}`,
        },
        {
          kind: 'text',
          id: 'node-async-patterns:abort-reading',
          body: `Every load-bearing detail is in those twenty lines. The timer calls controller.abort(), not reject() directly — aborting the signal is what notifies everyone holding it. The deadline promise rejects exactly once ('abort', { once: true }). Promise.race decides the outcome: first to settle wins, loser ignored. race.finally(clearTimeout) means a fast SUCCESS also clears the deadline timer — no dangling handle keeping the process awake. And the operation is called WITH the signal, operation(controller.signal): a well-behaved dependency receives cancellation and stops its own work. The breaker's state machine around this (thresholds, cooldown, half-open probes) is the Reliability Patterns topic's subject — here it is simply the most honest AbortController example in the repo.`,
        },
        {
          kind: 'text',
          id: 'node-async-patterns:als',
          body: `The third utility solves CONTEXT. Your logger wants the requestId on every line, your tracer wants the current span — but threading both through every function signature pollutes a domain layer that should not know about HTTP. AsyncLocalStorage (node:async_hooks) is the platform answer: call als.run(store, fn) and everything scheduled inside fn — awaits, callbacks, however deep — can read that store via als.getStore(), because Node tracks the async context a callback was BORN in, not the one running when it fires. This repo deliberately does NOT use it: context is passed explicitly instead — request_id_middleware.ts stamps res.locals.requestId, and tracing's withSpan takes the parent TraceContext as an argument — a choice that stays legible and trivially testable at guide scale. Where it would plug in: a first middleware wrapping next() in als.run({ requestId, traceContext }) so use cases and loggers read scope without a single extra parameter. In a larger service that is the standard move — and the OpenTelemetry context API production tracing relies on is built on exactly this mechanism.`,
        },
      ],
    },
    {
      id: 'node-workers',
      title: 'Workers and cluster',
      lead: 'One thread, sixteen cores: two mechanisms for closing the gap, for different jobs.',
      blocks: [
        {
          kind: 'text',
          id: 'node-workers:concept',
          body: `The single-threaded model leaves two gaps, and Node has one answer for each. When the problem is CPU-bound work inside your process — hashing, image processing, parsing giant payloads — worker_threads moves it off the loop: real OS threads in the same process, each with its own V8 isolate, communicating by message-passing (postMessage) or shared memory (SharedArrayBuffer). The event loop hands the job to a worker and stays responsive; the worker's result comes back as a message.\n\nWhen the problem is serving capacity — one thread can only execute so much JavaScript per second — the cluster module starts one full process per CPU core, all listening on the same port, with a primary process distributing incoming connections between them. Same idea, different grain: workers parallelize computation; cluster parallelizes the server itself. In production the same role is often played by replicas behind a load balancer (this guide's Docker setup) or a process manager like PM2 — cluster is the mechanism they build on.`,
        },
        {
          kind: 'code',
          id: 'node-workers:sketch',
          language: 'ts',
          caption:
            'server/src/domain/teaching/exhibit_a_node_workers.ts — the two shapes as a real, compilable teaching exhibit (this guide deliberately runs one process; see below)',
          source: 'server/src/domain/teaching/exhibit_a_node_workers.ts',
          code: `// Shape 1 — cluster: N server processes, one port.
export function runClustered(serverBootstrap: () => void): void {
  if (cluster.isPrimary) {
    for (const _core of os.cpus()) cluster.fork(); // each child runs this same file
  } else {
    serverBootstrap(); // child process: start the Express server — connections are shared out
  }
}

// Shape 2 — worker_threads: heavy CPU off the event loop, in-process.
export function offloadToWorker(workerUrl: URL, input: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { input } });
    worker.on('message', (result) => resolve(result)); // the loop stayed free the whole time
    worker.on('error', reject);
  });
}`,
        },
        {
          kind: 'text',
          id: 'node-workers:this-guide',
          body: `This guide's server deliberately runs one process, one thread. The reasons are honest tradeoffs, not limitations of Node: a teaching server should be legible (everything you have read on this screen describes one process you can watch in a terminal), and its SQLite database allows a single writer anyway — multiple processes would contend for the file, while multiple threads of an HTTP server would gain nothing until the loop saturates. The scaling topics later in the guide pick this back up: process managers and replica counts live in Deployment, and event-loop hygiene under load lives in Performance.`,
        },
      ],
    },
    {
      id: 'node-child-processes',
      title: 'Child processes vs worker threads vs cluster',
      lead: 'The third way to escape one thread: full OS processes. Three grains of the same trade — pick by what you are actually escaping.',
      blocks: [
        {
          kind: 'text',
          id: 'node-child-processes:concept',
          body: `child_process gives you real OS processes, and its four functions are two axes. exec and execFile run a program to completion and BUFFER its output for you (exec through a shell string, execFile with a plain argv array — the difference is the security topic's command-injection lesson: with a shell, untrusted input becomes code). spawn streams instead: the child's stdout arrives as a Readable, which is the only honest option when output can exceed memory. fork is spawn specialized for Node — it starts a Node module as a child and pre-wires a message channel, which is exactly the supervision transport cluster's primary uses to talk to its workers.\n\nWhen does a child process win over the previous section's tools? Workers share your process's memory and are cheap to message — right for CPU-bound work inside YOUR code. Cluster parallelizes the server itself. Child processes win when the work is not yours at all: running an external program (a transcoder, a CLI tool — this repo's image work uses sharp in-process instead), when you want crash containment (a child's segfault cannot corrupt your heap), or when the code needs a different runtime or version than the server's own.`,
        },
        {
          kind: 'code',
          id: 'node-child-processes:exhibit',
          language: 'ts',
          caption:
            'server/src/domain/teaching/exhibit_a_node_child_process.ts — the three shapes as a real, compilable teaching exhibit (no child-process call site exists in this guide; same stance as the workers exhibit)',
          source: 'server/src/domain/teaching/exhibit_a_node_child_process.ts',
          code: `// Shape 1 — execFile: run a program, capture stdout/stderr, get one result.
export function captureToolOutput(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: 5_000, maxBuffer: 1024 * 1024 }, // a deadline and an output cap — always
      // …error ? reject(error) : resolve({ stdout, stderr })…
    );
  });
}

// Shape 2 — spawn: the same program, but output arrives as STREAMS.
export function spawnToolStream(command: string, args: readonly string[]): Readable {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return child.stdout!; // the child's stdout is a Readable — pipe it, don't buffer it
}

// Shape 3 — fork: a Node module as a child, with a message channel pre-wired.
export function forkNodeModule(modulePath: string, job: Serializable): ChildProcess {
  const child = fork(modulePath);
  child.send(job); // rides the built-in IPC channel — JSON-serializable values only
  return child;
}`,
        },
        {
          kind: 'text',
          id: 'node-child-processes:reading',
          body: `Three production habits hide in that exhibit. The execFile options carry a timeout and a maxBuffer deliberately: buffered output is a memory liability, and a child that hangs will hold a promise open forever unless you race a deadline (the AbortController pattern, one section up, applies to process-shaped work too). spawnToolStream returns the child's stdout rather than awaiting anything — the streams section's source-to-sink composition, now with a foreign process as the source. And fork's channel is JSON-serialized: cheap messages, but structured data, not shared objects — unlike a worker thread's SharedArrayBuffer. That is the closing picture of all three sections: worker threads buy parallelism with shared memory, cluster buys throughput with process copies, child processes buy isolation with serialization. Match the mechanism to which of those you are actually buying.`,
        },
      ],
    },
    {
      id: 'node-live',
      title: 'See it live',
      lead: 'Two experiments against this very server: one that blocks the loop and one that streams instead of buffering.',
      blocks: [
        {
          kind: 'text',
          id: 'node-live:intro',
          body: `The first experiment runs the same 300ms of real hash work two ways. The blocking endpoint computes it all in one synchronous burst — the event loop stalls for the entire run, and the response reports the measured stall, which is exactly the delay every other request experienced. The deferred endpoint does the same work in ~10ms slices handed back across setImmediate ticks: same total CPU, but the loop stayed free between slices, so its measured stall stays tiny. Fire both at once and you can also watch the blocking run inflate the deferred one's total time — one process, one loop, one point of congestion.\n\nThe second experiment serves the same telemetry payload two ways: buffered (the whole body built first, Content-Length known up front) and streamed (line by line, chunked transfer encoding, no Content-Length). Same bytes, different delivery contracts.`,
        },
        {
          kind: 'code',
          id: 'node-live:curl',
          language: 'bash',
          caption: 'drive the demo endpoints yourself',
          code: `# 300ms of synchronous hash work — the response reports the loop stall:
curl -s 'localhost:4000/api/demo/node/blocking?workMs=300'

# The same 300ms of work, chunked across event-loop ticks:
curl -s 'localhost:4000/api/demo/node/deferred?workMs=300'

# Identical telemetry payloads, two delivery strategies — compare the headers:
curl -sD - -o /dev/null 'localhost:4000/api/demo/node/stream?mode=buffered&chunks=50'
curl -sD - -o /dev/null 'localhost:4000/api/demo/node/stream?mode=stream&chunks=50'`,
        },
        {
          kind: 'demo',
          id: 'node-live:demo-loop',
          demoId: 'node:event-loop',
          title: 'Event-loop blocking, measured live',
          description:
            'Run 300ms of real hash work two ways — one synchronous burst (the loop stalls for the whole run) and one deferred across ticks (the loop stays responsive) — and read the measured stall from both responses.',
        },
        {
          kind: 'demo',
          id: 'node-live:demo-stream',
          demoId: 'node:streaming',
          title: 'Buffered vs streamed responses',
          description:
            'Download the same 100-line telemetry payload as one buffered body (Content-Length declared up front) and as a chunked stream (no Content-Length, bytes flow as they are produced) — client-observed timing and headers for both.',
        },
      ],
    },
  ],
};
