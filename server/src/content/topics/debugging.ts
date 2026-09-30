import type { Topic } from '../types.js';

/**
 * The Debugging topic — the tools and, more importantly, the METHOD: from
 * "it's broken" to a verified fix, with this app's own artifacts as the
 * exhibits (the pino err lines as the server-side stack trace, the
 * monitorEventLoopDelay histogram as the stall detector, the SSE cleanup
 * discipline and capped rings as the leak-prevention patterns). Every command
 * in the --inspect section was executed against this repo's own tsx setup.
 */
export const topicDebugging: Topic = {
  id: 'debugging',
  title: 'Debugging',
  subtitle: 'node --inspect, profiling, and diagnosing event-loop stalls.',
  group: 'platform',
  order: 6,
  sections: [
    {
      id: 'debug-mindset',
      title: 'The debugging mindset',
      lead:
        'Debugging is not guessing faster — it is a loop: reproduce, isolate, hypothesize, verify. The tools in the rest of this topic only accelerate the loop; they do not replace it.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-mindset:the-loop',
          body: `THE LOOP, IN FOUR MOVES. (1) REPRODUCE — a bug you cannot trigger on demand you cannot observe; the first question is always "what is the MINIMAL sequence that makes it happen?" (a curl, a click path, a single test — this repo's flake investigation, retold in the testing topic, turned on being able to run the suite eight times in a row). (2) ISOLATE — peel away everything that is not necessary: does it fail on fake data or only live? Only through HTTP or also from a unit call? Only on the second request? Each peeling halves the search space. (3) HYPOTHESIZE — state a FALSIFIABLE sentence: "the cookie is set but the path attribute excludes /api". Not "maybe something with auth" — a vague hypothesis cannot be tested and is just anxiety wearing a lab coat. (4) VERIFY — design the observation that would PROVE the hypothesis wrong: check the exact Set-Cookie string, print the parsed path. If the observation contradicts you, you learned something — update the hypothesis, never the data. BINARY SEARCH OVER CAUSES: when the search space is large and ordered (a regression between two commits — git bisect; a bad middleware in a chain — disable half; a slow layer in a pipeline — time the halves), halve it repeatedly. Six halvings cover 64 possibilities with SIX observations; that is the entire superpower. READING A STACK TRACE PROPERLY is a skill nobody teaches: read it TOP-FIRST for the WHAT (the error type and message), then find the FIRST FRAME YOU OWN — the frames above it are the platform telling you how you got there, the frames below it are your callers. In THIS app the server-side "stack trace" is usually a pino line: the error middleware serializes the whole Error (pino's err serializer emits type, message, and STACK) with the requestId attached — grep that id and the access line, the failure line, and any domain warnings line up into one request's story.`,
        },
        {
          kind: 'text',
          id: 'debug-mindset:three-kinds',
          body: `LOGIC vs STATE vs PERFORMANCE — three different diseases that all look like "it's broken", each with its own tool. A LOGIC bug produces the WRONG ANSWER deterministically: 2+2=5 on every call. Tools: unit tests, breakpoints (the --inspect section), and the case-reproduction discipline above. A STATE bug is timing- or order-dependent: the same input is right the second time, the store has a stale value, a race ate an update. Tools: logs with CORRELATION IDS (the requestId — you reconstruct interleaved histories), deliberate reproduction of orderings (the testing topic's fake clock fires timers in sequence instead of praying at real timing), and breakpoints that FREEZE the world — a paused process cannot race itself, which is both the debugger's superpower and its lying flaw (Heisenberg warning: some races vanish under the breakpoint because you removed the concurrency). A PERFORMANCE bug answers correctly but SLOWLY — and it splits again into "the CPU is busy" (a hot function — profile it, the event-loop section) and "everything is WAITING" (a stalled loop, a lock, an N+1 query — the profiler shows idle where you expected work). Diagnosing a slow endpoint with a BREAKPOINT is usually a dead end: pausing shows you what the code is doing, not what it is doing for 800ms. Match the tool to the disease before you reach for any of them — the rest of this topic is that matching, made concrete.`,
        },
      ],
    },
    {
      id: 'debug-console',
      title: 'console.log is fine (and its limits)',
      lead:
        'Print debugging is not a moral failing — undisciplined print debugging is. The graduation path runs from console.log to structured logs to a real debugger.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-console:discipline',
          body: `THE DEFENSIBLE console.log. When you are three questions deep in a logic bug, \`console.log({ parsed, size })\` on the exact line in question is the fastest possible observation loop — no tooling, no attach, no ceremony. Two disciplines keep it honest: (1) log the OBJECT, not the interpolation — console.log({ parsed }) prints a labeled object you can expand in Node and inspect structurally; console.log('parsed:', parsed) is the same information with worse ergonomics in every runtime. (2) DELETE IT when done — stray debug prints in committed code are noise on every future run, and worse, they can print things that should never be printed (the security topic's never-log rule applies to debug prints TOO — a temporary console.log of a token becomes a permanent one the day you forget). THE GRADUATION LADDER, and when to climb each rung: (1) console.log — one function, one suspected line, seconds of setup. (2) STRUCTURED LOGGING at levels — when the question is "what happened across many requests" rather than "what is this variable right now"; this app's pino logger with the requestId correlation is exactly that (the observability topic). (3) A REAL DEBUGGER — when the question becomes ITERATIVE ("what is in the closure here? now step into that; now what does this return?") — the moment you are re-running the same print cycle three times to follow a chain of values, you are manually simulating STEP OVER, and the --inspect section's breakpoints do it without code edits or re-runs. THE LIVE DEBUGGER'S CONSOLE — this app's own bridge between rungs: the observability topic's log ring (GET /api/demo/obs/logs) is a pino destination, so logger.debug(...) in server code shows up in the browser's log viewer WHILE the code runs — print debugging with structured logs' discipline and no terminal attached. That is not a replacement for a debugger; it is print debugging that already survives production.`,
        },
        {
          kind: 'code',
          id: 'debug-console:ring-cap',
          language: 'ts',
          caption:
            'Verbatim — a debug surface that cannot eat the process: the ring is capped at write time (core/logging/log_ring.ts)',
          source: 'server/src/core/logging/log_ring.ts',
          code: `    ring.push({
      // …the normalized entry: time, level, levelLabel, msg, promoted ids…
      fields,
    });
    while (ring.length > LOG_RING_CAPACITY) ring.shift();`,
        },
      ],
    },
    {
      id: 'debug-inspect',
      title: 'node --inspect and breakpoints',
      lead:
        'The real commands, verified against this repo\u2019s own tsx dev setup — plus Chrome DevTools, VS Code attach, and the async-stack caveat that will otherwise eat an afternoon.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-inspect:the-commands',
          body: `HOW IT WORKS. --inspect starts a WebSocket DEBUG SERVER inside the Node process (default 127.0.0.1:9229) speaking the Chrome DevTools Protocol; a CLIENT — Chrome DevTools, VS Code, WebStorm — attaches and drives the process: set breakpoints, inspect scopes, step, evaluate expressions in a paused frame. --inspect-brk is the same but breaks IMMEDIATELY before the first line — for debugging BOOT (config loading, middleware registration): by the time you attach with plain --inspect, boot already ran. THE INSTRUCTIONS FOR THIS REPO (this app runs TypeScript through tsx, so the incantation has a wrinkle — every command in the block below was EXECUTED against this repo's tsx 4.x and printed the real "Debugger listening on ws://127.0.0.1:9229" banner): tsx is a thin wrapper around the node binary and FORWARDS node CLI flags, so the direct form is \`tsx --inspect src/server.ts\` — the one to prefer here. The equivalent in pure node form (and the one to reach for when you want node flags EXPLICITLY, e.g. alongside --cpu-prof later) is \`node --import tsx --inspect src/server.ts\` — --import tsx registers tsx's loader in a plain node process. WITH WATCH MODE: \`npx tsx watch --inspect src/server.ts\` works directly — on restart the inspector comes back with a NEW websocket id, so a DevTools session may need one reconnect after a file change. THE NODE_OPTIONS ESCAPE HATCH (\`NODE_OPTIONS=--inspect npm run dev\`) is the universal form for wrappers you do not control — but with tsx specifically it has an empirically verified wart worth knowing: tsx spawns a CHILD node process, BOTH inherit NODE_OPTIONS, BOTH try to bind 9229, and the loser prints "Starting inspector on 127.0.0.1:9229 failed: address already in use" — the script still runs, but the listener you attach to may be the wrapper's, so with tsx prefer the direct flags and keep NODE_OPTIONS for the wrappers that genuinely need it. ATTACH: open Chrome at chrome://inspect, wait for the Remote Target on port 9229, click inspect; the Sources pane shows the server's files, TypeScript INCLUDED (tsx serves source-mapped TS to the debugger — set breakpoints IN the .ts files, not the transpiled output).`,
        },
        {
          kind: 'code',
          id: 'debug-inspect:commands',
          language: 'bash',
          caption:
            'Verified against this repo (each printed the real "Debugger listening on ws://127.0.0.1:9229" banner)',
          code: `# the direct form — tsx forwards node CLI flags to the node binary it wraps:
npx tsx --inspect src/server.ts

# break before the FIRST line (for boot-time debugging: config, DI wiring):
npx tsx --inspect-brk src/server.ts

# pure-node form — tsx registered as a loader in an explicit node process:
node --import tsx --inspect src/server.ts

# through any wrapper (npm scripts, watch mode) — NOTE the wart, verified live:
# tsx spawns a child node, BOTH inherit NODE_OPTIONS, both try 9229; the
# loser prints "address already in use". Works, but prefer the direct flags:
NODE_OPTIONS=--inspect npm run dev
npx tsx watch --inspect src/server.ts

# then: Chrome → chrome://inspect → the target on :9229 → inspect`,
        },
        {
          kind: 'text',
          id: 'debug-inspect:vscode-and-tools',
          body: `VS CODE — the ATTACH configuration (run the process yourself with --inspect, then attach; launch-with-debugger of a tsx watch process is fiddly in a plain launch.json, and attach works identically for a process on localhost OR inside a container with a published 9229): the sketch below attaches to 9229 and (crucially) sets sourceMaps on, so breakpoints land in the .ts sources. A \`debugger;\` STATEMENT in code is a breakpoint that survives client-attach timing — useful when the moment you need is early or inside a hot loop you cannot click fast enough; delete it like a console.log (it is the same discipline). CONDITIONAL BREAKPOINTS (right-click a breakpoint: only pause when \`id === 'job_3'\`) keep hot paths usable — a breakpoint on every request is useless, a breakpoint on THE request is gold. LOGPOINTS are breakpoint-shaped console.log WITHOUT pausing: "log \`attempt \${attempt} delay \${delayMs}\`" on the retry line gives you the print-debug trail with zero code edits and no process freeze. THE ASYNC STACK CAVEAT — the one that eats afternoons: after every await, your function's callers may no longer be on the stack, because the continuation runs as a NEW stack; by default the debugger shows you only the SYNC frame chain of the current tick, and the interesting "who called this handler" frame is GONE. Node's async hooks can stitch async stacks (DevTools shows "async" stack frames when available; VS Code does the same via js-debug), but the stitch is best-effort and OFF across some boundaries — so when a breakpoint shows a bafflingly SHORT stack, before concluding "it was called by nobody", check whether you are across an await boundary; grepping the requestId in the logs (the observability topic's discipline) reconstructs the CALL STORY that the async stack lost.`,
        },
        {
          kind: 'code',
          id: 'debug-inspect:vscode-sketch',
          language: 'json',
          caption:
            'Sketch — .vscode/launch.json attach config for the --inspect process (kept as a pinned teaching exhibit at server/src/domain/teaching/exhibit_c_debugging_launch_attach.ts; copy the JSON into .vscode/launch.json to use it — the shape is the portable part)',
          source: 'server/src/domain/teaching/exhibit_c_debugging_launch_attach.ts',
          code: `{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to tsx --inspect",
      "port": 9229,
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"],
      "sourceMaps": true
    }
  ]
}`,
        },
      ],
    },
    {
      id: 'debug-post-mortem',
      title: 'Post-mortem debugging',
      lead:
        'The crash already happened — now what? Capture everything in the moment, and design the process so the corpse tells you who killed it.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-post-mortem:fatal-then-exit',
          body: `THE PATTERN THIS APP USES: fatal-log, brief grace, exit — let the SUPERVISOR restart a clean process. When an exception unwinds past every handler (uncaughtException) or a promise rejects with no catch (unhandledRejection), the process's state is SUSPECT — locks half-held, invariants broken mid-mutation — and "log it and carry on" produces a zombie that answers health checks while misbehaving un-reproducibly. So server.ts registers the two handlers you see quoted below: log FATAL with the full error serialized (the ring AND stdout both capture it), wait 100ms — stdout to a pipe is asynchronous, and exit truncating the one line that explains the crash would be its own incident — then exit(1). Docker/pm2/Kubernetes treat the non-zero exit as "restart me", and the clean process comes up with intact invariants. WHY THIS IS "POST-MORTEM" DEBUGGING: your only evidence is what was captured BEFORE the exit — the fatal line (with its STACK — pino serializes err fully), every requestId'd line before it, and the metrics at the time. WHICH IS WHY THE CAPTURE DISCIPLINE IS THE DEBUGGING: (1) the requestId correlation — the fatal's stack tells you WHERE; the last requestId-bearing lines before it tell you WHAT REQUEST was in flight (grep the id: its access line, its domain warnings, its payload shape); (2) LOG THE ERROR OBJECT, never err.message alone — the stack is the autopsy; (3) the graceful-shutdown logs (this app drains grpc → mongo → redis → hub → http and says so) mean an crash-adjacent log tells you WHICH drain was mid-flight. TRUE POST-MORTEM TOOLS, as the catalog: a CORE DUMP (ulimit -c unlimited, or report-on-fatalerror) freezes the entire heap at death, and llnode loads it into lldb with node-aware pretty-printing — you can walk the exact object graph at the moment of the crash. Indispensable for the crash you cannot reproduce; heavyweight enough that it is the LAST rung, not the first. Node's lighter sibling is the diagnostic REPORT (--report-on-fatalerror) — a JSON snapshot of stacks, heap stats, and env written at crash time, readable without lldb.`,
        },
        {
          kind: 'code',
          id: 'debug-post-mortem:verbatim-handlers',
          language: 'ts',
          caption:
            'Verbatim — the fatal-log-then-exit safety nets (src/server.ts; note the 100ms flush grace before exit)',
          source: 'server/src/server.ts',
          code: `process.on('uncaughtException', (err: Error) => {
  logger.fatal({ err }, 'uncaught exception — exiting so the supervisor restarts a clean process');
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal(
    { err: reason },
    'unhandled promise rejection — exiting so the supervisor restarts a clean process',
  );
  setTimeout(() => process.exit(1), 100);
});`,
        },
      ],
    },
    {
      id: 'debug-event-loop',
      title: 'Event-loop diagnosis',
      lead:
        'The signature symptom: everything is slow, nothing is failing. This app carries a live loop-delay histogram — and a demo that stalls it on demand.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-event-loop:symptoms-and-probe',
          body: `THE SYMPTOM SIGNATURE. An event-loop stall does not fail requests — it AGES them: p99 latency climbs while CPU may be pegged (a hot synchronous loop) OR idle (awaiting something that never yields back), error rate stays flat, and EVERY concurrent request is slow TOGETHER (one blocked loop blocks all of them — that is the definition). Classic causes: JSON.parse of a 50MB payload, a synchronous crypto/hash marathon, a naive regex catastrophic backtracker, better-sqlite3's synchronous API on a huge query, or a giant for-loop that should have been chunked. THE PROBE — and this app HAS it live: perf_hooks.monitorEventLoopDelay() is a histogram the runtime samples for you; a setImmediate callback scheduled before suspect work and timed when it fires measures the gap the loop could not run ANY JavaScript. The observability topic's /api/demo/obs/metrics exposes the REAL histogram (created and enabled ONCE at module load — per-request creation would measure nothing; the numbers are cumulative since boot, nanoseconds → ms), and the Node.js topic's /api/demo/node/blocking endpoint measures a single stall with the setImmediate probe directly. THE DIAGNOSIS PLAYBOOK: (1) confirm the stall — hit /api/demo/obs/metrics and watch eventLoopDelayMs.max jump when you fire blocking?workMs=300 (this topic's demo does exactly this, three polls, charted); (2) find the WHERE — --cpu-prof (node's built-in sampling profiler: \`node --import tsx --cpu-prof src/server.ts\` writes a .cpuprofile you open in Chrome DevTools' Performance pane; the fattest frame IS your stall), or the clinic/0x flamegraph tooling as the catalog mention (autocannon for load while you profile); (3) fix by YIELDING — slice the work across setImmediate ticks (the /api/demo/node/deferred endpoint is the same 300ms of hashing delivered in 10ms slices, loop-responsive throughout), or move it to a worker thread / worker pool for the CPU-bound cases slicing cannot fix.`,
        },
        {
          kind: 'code',
          id: 'debug-event-loop:verbatim-monitor',
          language: 'ts',
          caption:
            'Verbatim — the probe, live in this app (presentation/routes/obs_demo_routes.ts; GET /api/demo/obs/metrics reports it)',
          source: 'server/src/presentation/routes/obs_demo_routes.ts',
          code: `// Created + enabled ONCE per process (module load), never per request: the
// histogram accumulates from boot, so mean/percentiles describe the process's
// whole life, not the last read.
const eventLoopMonitor: ELDHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();

// ...in the controller — nanoseconds → ms, percentiles is a Map (.get()):
const loopMeanMs = toMs(eventLoopMonitor.mean) ?? 0;
const loopP99Ms =
  toMs(eventLoopMonitor.percentiles.get(99)) ??
  toMs(eventLoopMonitor.percentiles.get(90)) ??
  loopMeanMs;
// …mean/p99/max land in the response's eventLoopDelayMs object…`,
        },
        {
          kind: 'demo',
          id: 'debug-event-loop:demo',
          demoId: 'debug:stall',
          title: 'The event-loop stall, diagnosed live',
          description:
            'Read the real loop-delay histogram, stall it for 300ms with synchronous work, watch the spike land in three polls — then run the same workload sliced across setImmediate ticks and watch nothing move.',
        },
      ],
    },
    {
      id: 'debug-memory',
      title: 'Memory leaks',
      lead:
        'A leak is a growth PATTERN, not a big number — and the three-snapshot technique turns "it feels slow after a day" into a named retainer.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-memory:diagnosis',
          body: `RECOGNIZE THE PATTERN FIRST: heapUsed that grows across GCs and never returns to baseline. A single big number means nothing (V8 grooms lazily; a spike after startup is normal) — the SIGNAL is the SAWTOOTH'S FLOOR rising over hours (the observability topic's /api/demo/obs/metrics reports heapUsed on every poll; graph it, or let the metrics dashboard of your platform do it). THE THREE-SNAPSHOT TECHNIQUE, the canonical DevTools flow: with the app under repeatable load (autocannon, catalog mention), (1) take heap snapshot #1, (2) run the workload you suspect (N requests / N connects / N minutes), (3) snapshot #2, (4) force GC and snapshot #3 — then COMPARISON-view (#3 vs #1): objects present in #3 but not #1 are the survivors; the RETAINERS pane answers the money question — WHO is holding a reference? — with the reference chain from the object to its GC root. The retainer is the bug: a Map key nobody deletes, a listener never removed, a closure that captured the request. THE COMMON NODE LEAKS, all retainers you will meet: (1) CLOSURES IN LONG-LIVED MAPS — a cache Map whose values capture big scopes; every cache needs an eviction policy (this repo's rings are hard-capped at write time — the log ring's while-shift quote in the console section above; the SSE history ring holds 50, the session store 100, the webhook inbox 50 — arrays that only push are a leak wearing a feature's clothes). (2) FORGOTTEN LISTENERS AND TIMERS — every setInterval you start is a leak until something clears it; this repo's SSE feed is the discipline IN CODE: the tick interval starts lazily on the FIRST listener and the LAST disconnect clears it — an idle server holds no timers (quoted below), and the per-connection heartbeat is cleared on 'close' so an abandoned connection cannot leave an orphan timer. (3) UNBOUNDED BUFFERS — concatenating into an ever-growing string/array for a stream that never ends; cap it or consume it. THE FIX IS ALWAYS THE SAME SHAPE: find the retainer, add the missing release path (delete the key, remove the listener, clear the timer, cap the buffer) — and then write the test that would have caught it (the SSE spec proves the no-timer-leak property across five connect/disconnect cycles by watching the running flag).`,
        },
        {
          kind: 'code',
          id: 'debug-memory:verbatim-sse-cleanup',
          language: 'ts',
          caption:
            'Verbatim — leak prevention as a design rule: the feed owns exactly one interval, and an idle server holds none (presentation/routes/sse_demo_routes.ts)',
          source: 'server/src/presentation/routes/sse_demo_routes.ts',
          code: `/**
 * (Re)arm the one interval: the feed runs at its FASTEST listener's pace,
 * recomputed on every attach/detach. Started lazily on the first listener,
 * stopped on the last — an idle server holds no timers.
 */
function syncFeedTimer(): void {
  // ...
  if (feed.connections.size === 0) {
    if (feed.timer !== undefined) {
      clearInterval(feed.timer);
      feed.timer = undefined;
    }
    feed.intervalMs = TICK_INTERVAL_MS_DEFAULT;
    return;
  }
  // …otherwise (re)arm the interval at the fastest listener's pace…`,
        },
      ],
    },
    {
      id: 'debug-production',
      title: 'Debugging in production',
      lead:
        'You cannot breakpoint production — so everything you wish you had at 3am must have been shipped at 3pm. Observability is debugging, pre-paid.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-production:no-breakpoints',
          body: `THE CONSTRAINT defines the toolkit: no breakpoints, no stepping, no "let me just try it in the console" — production debugging is FORENSIC, done from what the process already recorded. The stack, in order of what answers fastest: METRICS (seconds) — is it this process or all of them? Latency or errors? Event-loop delay or heap? The observability topic's RED method turns "something feels slow" into a directed question. LOGS (minutes) — the requestId is the entire method: from the failing response's x-request-id header (this app returns it on EVERY response, and the error envelope CARRIES it in the body) to the complete story of that request — the access line, every domain warning, the failure line with the serialized stack. THE REPRODUCTION DISCIPLINE that closes the loop: requestId → the request's log lines → the request's SHAPE (method, path, the payload the logs recorded — and only the payload, never credentials: the never-log rule is what makes this loop safe to run) → replay that shape against staging (the environments topic's world) where a debugger IS allowed. SOURCE MAPS: the stack trace in prod describes the BUILT artifact (this repo's dist/*.js — or, in a container, whatever the Dockerfile shipped); ship the .map files beside the build (or to an error tracker) so the trace translates back to src/*.ts — a stack into minified/transpiled output without a map is a postcode with no city. ERROR AGGREGATION (the catalog mention): Sentry and its peers do the deduplication no grep can — same stack, 40,000 occurrences, ONE issue, first/last seen, affected users, release-tagged — plus the breadcrumbs (the request, the user, the route) that turn "an error object" into "the user's session". All of it rests on what this app demonstrates at demo scale: structured logs with correlation ids, metrics that include the loop and the heap, and an error path that serializes the whole error rather than its message.`,
        },
        {
          kind: 'code',
          id: 'debug-production:loop',
          language: 'text',
          caption:
            'The production debugging loop — every step here maps to an artifact this app already ships',
          code: `1. symptom     → the user says / the alert fires (RED metrics: rate, errors, duration)
2. scope       → which process? /api/demo/obs/metrics: eventLoopDelayMs, heapUsed, uptime
3. identify    → the failing response's x-request-id header (or the envelope's requestId)
4. reconstruct → grep the id in the logs: access line + domain lines + failure line (stack included)
5. replay      → the logged request shape, against staging — where breakpoints ARE allowed
6. fix + ship  → and the regression test that pins the behavior (the testing topic's contract)`,
        },
      ],
    },
    {
      id: 'debug-see-it-live',
      title: 'The stall diagnosis from a terminal',
      lead:
        'Stall the event loop from a terminal, watch the histogram catch it, then run the same workload the deferred way and watch it not care.',
      blocks: [
        {
          kind: 'text',
          id: 'debug-see-it-live:what-you-see',
          body: `THE TOUR wires three EXISTING endpoints into one diagnosis (the interactive panel lives in the Event-loop diagnosis section above): (1) BASELINE — GET /api/demo/obs/metrics reads the real monitorEventLoopDelay histogram (mean + max) before anything is disturbed. (2) STALL — fire GET /api/demo/node/blocking?workMs=300 (a synchronous hash marathon that owns the loop for ~300ms), then poll the metrics endpoint three times, half a second apart: the histogram's max JUMPS to ≥300ms on the first poll and stays flat after (the histogram is cumulative — the jump is the stall being absorbed; flat later polls mean no NEW stalls), and the blocking endpoint itself reports its setImmediate-probe measurement — the direct evidence that every concurrent request waited out the stall. The verdict line names it. (3) CONTROL — the SAME 300ms of hashing through GET /api/demo/node/deferred?workMs=300, sliced into 10ms setImmediate ticks: the probe reads ≈ one slice, the histogram does not move — the diagnosis, the cause, and the fix, all three in one tour. Drive it from a terminal:`,
        },
        {
          kind: 'code',
          id: 'debug-see-it-live:curl',
          language: 'bash',
          caption: 'The same diagnosis over curl (server running on :4000)',
          code: `curl -s localhost:4000/api/demo/obs/metrics | grep -o '"eventLoopDelayMs":{[^}]*}'
curl -s 'localhost:4000/api/demo/node/blocking?workMs=300'   # → {"mode":"blocking","workMs":300,"eventLoopDelayMs":~300}
curl -s localhost:4000/api/demo/obs/metrics | grep -o '"max":[0-9.]*'   # the jump
curl -s 'localhost:4000/api/demo/node/deferred?workMs=300'   # → the control: eventLoopDelayMs ≈ 10`,
        },
      ],
    },
  ],
};
