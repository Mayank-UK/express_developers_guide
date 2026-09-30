import type { Topic } from '../types.js';

/**
 * The Logging and Observability topic — the guide's tour of ITS OWN
 * observability stack: the pino logger (tee'd to console + an in-memory ring
 * you can read live), the request-logger middleware, the level discipline the
 * error middleware now follows, hand-rolled metrics, health checks, and the
 * process-level safety nets. Every code block is this app's real running
 * source; the demos are working viewers over the live process, each beside
 * the section that teaches it.
 */
export const topicObservability: Topic = {
  id: 'observability',
  title: 'Logging and Observability',
  subtitle:
    'pino structured logs, request IDs, health checks, and metrics.',
  group: 'platform',
  order: 4,
  sections: [
    {
      id: 'obs-three-questions',
      title: 'The three questions of observability',
      lead:
        'When something breaks at 3am you need three different instruments, answering three different questions. This app has an honest scorecard for all three.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-three-questions:questions',
          body: `THE THREE QUESTIONS. WHAT HAPPENED — logs answer this. A log line is a sentence in the story of one process: "request X failed with 503 because mongo was unreachable." You read logs after the fact, forensically, one event at a time. HOW MUCH — metrics answer this. A metric is a number with a timestamp: requests per second, error ratio, p99 latency, heap used. Metrics tell you the SHAPE of the system's behavior over time (spikes, drift, saturation) without replaying individual events. WHY AND WHERE — traces answer this. A trace follows ONE request across every hop it took (middleware → controller → use case → repository → database) with a duration per hop, so you can see not just THAT it was slow but WHICH layer ate the time. THE HONEST SCORECARD for this app: LOGS — strong. pino structured JSON, one access line per request, one failure line per error, correlated by request id (the rest of this topic). METRICS — basic by design: a hand-rolled /api/demo/obs/metrics endpoint (uptime, memory, event-loop delay, request counters) that teaches what a metrics ENDPOINT is; a production app would export these in Prometheus format via prom-client (the catalog mention). TRACES — real at two scales: the architecture topic's request-flow tracer (GET /api/demo/arch/trace) walks one request through this app's six layers, and the distributed-tracing section below adds the real cross-boundary mechanism — W3C traceparent headers continued from inbound requests and propagated into background jobs, one trace id across every hop. THE POOR MAN'S TRACE that this app DOES have everywhere: the requestId. Every log line carries it — the access log line, the error middleware's failure line, the mongo client's connection warnings. Grep one id and you have reconstructed that request's slice of the story. Distributed tracing (OpenTelemetry spans, W3C traceparent headers) is that idea industrialized: same correlation key, propagated across process boundaries, with durations attached. Learn the id-first discipline here and tracing tools will feel obvious.`,
        },
        {
          kind: 'code',
          id: 'obs-three-questions:verbatim-request-id',
          language: 'ts',
          caption:
            'Verbatim — the correlation key stamped before anything else can run (presentation/middleware/request_id_middleware.ts)',
          source: 'server/src/presentation/middleware/request_id_middleware.ts',
          code: `export function requestIdMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.locals.requestStartedAt = performance.now();
  res.setHeader('x-request-id', requestId);
  next();
}`,
        },
      ],
    },
    {
      id: 'obs-structured-logging',
      title: 'Structured logging: JSON, not prose',
      lead:
        'A log line written for a HUMAN to read is a log line a MACHINE cannot query. Write for the machine first; render for humans at view time.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-structured-logging:why-json',
          body: `WHY JSON. \`logger.info('User ' + id + ' did thing ' + thing)\` feels natural and is nearly useless at scale: to find every request that took over a second you would need a regex over prose, and regexes over prose break the first time someone rewords a message. A structured line — \`{ "msg": "request completed", "reqId": "...", "method": "GET", "path": "/api/posts", "status": 200, "durationMs": 3.1 }\` — is DATA: an aggregator (Loki, Elasticsearch, Datadog, CloudWatch) indexes each FIELD, so "status >= 500 AND durationMs > 1000 over 5 minutes" is a query, not a prayer. It stays greppable too — \`grep '"status":503'\` works — and it round-trips: pretty-printers render it for humans at VIEW time (pino-pretty does exactly that in this app's dev console) without the stored line ever losing its shape. PINO'S MODEL, which this app uses: one logger per process with a LEVEL (trace < debug < info < warn < error < fatal — the level sets what is worth emitting; everything below it is dropped before formatting); every call is \`logger.level(fieldsObject, messageString)\` where the fields object is arbitrary SERIALIZABLE data that becomes JSON keys beside the automatic time/level/pid; child loggers (\`logger.child({ component: 'mongo' })\`) bind recurring context so you stop repeating it in every call. THE SERIALIZABLE DISCIPLINE is real: pino will happily stringify your objects, but circular references and class instances full of methods produce garbage — pass plain data. WHAT NOT TO LOG, the rule that outranks every "log more" instinct: passwords and password hashes, session/API tokens, Authorization headers, raw request bodies, database connection strings with credentials, and personal data you would not paste into a public channel. A log fleet is copied, shipped, indexed, and read by people who never needed to see it — treat every line as publishable. THIS APP'S POLICY: secrets are masked AT THE SOURCE (the environments topic's inspect endpoint shows MONGO_URI/REDIS_URL strictly as 'set (hidden)' and name-rules like /secret|token|password/ force masking — masking at the source, because once a value reaches a log line no downstream redaction can be trusted to catch it), and this logger ships no redaction config by design — the discipline is to never log the secret in the first place.`,
        },
        {
          kind: 'code',
          id: 'obs-structured-logging:verbatim-logger',
          language: 'ts',
          caption:
            'Verbatim — one logger, tee\u2019d to two destinations (core/logging/logger.ts)',
          source: 'server/src/core/logging/logger.ts',
          code: `export const logger =
  appConfig.nodeEnv === 'development'
    ? pino(
        { level: appConfig.logLevel },
        pino.multistream([
          {
            stream: nodeRequire('pino-pretty')({
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            }),
            level: appConfig.logLevel,
          },
          { stream: ringDestination, level: appConfig.logLevel },
        ]),
      )
    : pino(
        { level: appConfig.logLevel },
        pino.multistream([
          { stream: process.stdout, level: appConfig.logLevel },
          { stream: ringDestination, level: appConfig.logLevel },
        ]),
      );`,
        },
        {
          kind: 'text',
          id: 'obs-structured-logging:read-the-logger',
          body: `READING THAT FILE. The level comes from validated config (LOG_LEVEL, per environment file — next sections). In development the first destination is pino-pretty — the same colored, timestamped console output the transport worker used to print, now an in-process stream, loaded with require() INSIDE the dev branch because it is a devDependency a production install must never resolve. In every environment the SECOND destination is the ring: the same JSON lines land in a 200-entry in-memory buffer that GET /api/demo/obs/logs serves — the log viewer in this topic's demo reads what the process ACTUALLY logged, not a parallel logger built for show. That is the multistream lesson: a logger can fan out to any number of destinations (console, file, ring, a TCP shipper) and the call sites never know or care.`,
        },
        {
          kind: 'demo',
          id: 'obs-structured-logging:demo',
          demoId: 'obs:viewer',
          title: 'The observability console',
          description:
            'Live log viewer over the process\u2019s own ring (level filtering + make-noise burst), the hand-rolled metrics strip, and the readiness check strip.',
        },
      ],
    },
    {
      id: 'obs-request-logging',
      title: 'Request logging: one line per request, on finish',
      lead:
        'The access log is the spine of HTTP observability. The whole middleware fits in one screen — and both of its subtleties (when to log, what level) are load-bearing.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-request-logging:finish-not-handler-end',
          body: `WHY 'finish' AND NOT HANDLER-END. The naive request logger logs when the route handler returns — and systematically LIES: it misses response serialization, misses anything the later middleware does, and for a streamed response the handler "returns" long before the last byte leaves. This middleware logs in the response's 'finish' event, which fires when the last chunk has been handed to the socket — so durationMs is the honest end-to-end number the CLIENT experienced, computed from the requestStartedAt stamp the request-id middleware set before anything else ran. ONE LINE, ALL FIELDS: \`{ reqId, method, path, status, durationMs }\` — the correlation key first, then exactly what an access log needs. THE ABORT PATH: 'close' can fire WITHOUT 'finish' when the client hangs up mid-response; the settled flag makes the first of the two events win, so the request logs exactly once and the in-flight counter can never leak on an abort (the aborted line says 'request aborted' — its statusCode is whatever had been set when the connection died, often still the 200 default, which is precisely why the word 'aborted' is in the message). MOUNT ORDER is part of the design: after the request-id middleware (it needs reqId + the start stamp), before every route — including the 404 catch-all, so unknown paths get their warn line too.`,
        },
        {
          kind: 'code',
          id: 'obs-request-logging:verbatim-middleware',
          language: 'ts',
          caption:
            'Verbatim — the access log (presentation/middleware/request_logger_middleware.ts); path and method are captured BEFORE next() because routers mutate req.url to be mount-relative',
          source: 'server/src/presentation/middleware/request_logger_middleware.ts',
          code: `export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  requestStarted();

  const startedAt =
    typeof res.locals.requestStartedAt === 'number' ? res.locals.requestStartedAt : performance.now();

  // Capture the path NOW, before next(): routers MUTATE req.url to be
  // relative to their mount point, so by the time 'finish' fires req.path
  // would read '/health' for a request to '/api/health'.
  const path = req.path;
  const method = req.method;

  let settled = false;
  const settle = (aborted: boolean): void => {
    if (settled) return;
    settled = true;

    const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    const reqId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
    const line = { reqId, method, path, status: res.statusCode, durationMs };

    requestSettled(res.statusCode, durationMs);

    if (aborted) {
      logger.warn({ ...line, aborted: true }, 'request aborted (connection closed early)');
      return;
    }
    if (res.statusCode >= 500) logger.error(line, 'request completed');
    else if (res.statusCode >= 400) logger.warn(line, 'request completed');
    else logger.info(line, 'request completed');
  };

  res.once('finish', () => settle(false));
  res.once('close', () => settle(true));

  next();
}`,
        },
      ],
    },
    {
      id: 'obs-levels',
      title: 'Levels that mean it',
      lead:
        'A log level is a promise about who gets paged. This app keeps exactly one discipline at every layer: 4xx is the client talking, 5xx is us failing.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-levels:discipline',
          body: `THE CONTRACT EACH LEVEL MAKES. fatal — the process is dying or about to (see the safety nets below); a human NOW. error — something is broken and it is OUR fault: 5xx responses, failed database writes, an unreachable dependency that breaks a feature. warn — something is off but expected or client-owned: 4xx responses, aborted connections, a retry that succeeded, an optional service being down while the app degrades gracefully. info — the normal story of the system: request completed lines, server listening, connections opened. debug — everything a developer diagnosing a specific problem wants but an operator never does: scenario toggles, cache decisions. trace — per-function granularity; in production this is effectively compile-time-off. THE REFINEMENT THIS TOPIC LANDS: until now the error middleware logged EVERY failure — including a 400 for a bad email field — at error level, so an ops dashboard counting error lines counted CLIENT MISTAKES as incidents. The exception-handling topic flagged this honestly as a deferral; it is now fixed, and the fix is two lines: 4xx → warn (the client's problem; expected traffic noise), 5xx → error (ours). The request logger applies the IDENTICAL split to its access lines — one discipline, every layer, which is the entire point: your alert on "error-rate" only means something if error MEANS the same thing everywhere it appears. LOG_LEVEL PER ENVIRONMENT, straight from this repo's env files: .env.development sets LOG_LEVEL=debug (you are building; you want the chatter), .env.staging and .env.production set LOG_LEVEL=info (operators want the story, not the commentary — debug lines are dropped before formatting, at zero ship cost). The app config validates the value at boot and refuses to start on a typo'd level — config you can't trust is worse than no config.`,
        },
        {
          kind: 'code',
          id: 'obs-levels:before-after',
          language: 'ts',
          caption:
            'Before/after — the landed fix in presentation/middleware/error_middleware.ts (the BEFORE survives only as this comment — the file itself no longer contains it; both branches carry the same split)',
          source: 'server/src/presentation/middleware/error_middleware.ts',
          code: `// BEFORE (historical, quoted as comment — the file no longer contains it) —
// one level for every failure, so client mistakes paged people:
//   logger.error({ err, statusCode, requestId, failureKind }, 'request failed');
//
// AFTER — the landed fix; the level states whose problem it was:
const logLine = { err, statusCode: err.statusCode, requestId, failureKind: failure.kind };
if (err.statusCode >= 500) logger.error(logLine, 'request failed');
else logger.warn(logLine, 'request failed');`,
        },
        {
          kind: 'text',
          id: 'obs-levels:two-lines-one-request',
          body: `TWO LINES, ONE REQUEST — AND THAT IS CORRECT. A 400 now produces a warn from the error middleware ('request failed', with the failure kind and requestId) AND a warn from the request logger ('request completed', status 400, durationMs). That is not duplication; it is two layers each recording what they know — the error layer the CAUSE (which failure kind, which fields), the access layer the SHAPE (how long, what status). Grep the shared reqId/requestId and both lines line up. What you must NEVER do is log the same thing at two levels — that is how "error-rate" alerts rot.`,
        },
      ],
    },
    {
      id: 'obs-retention',
      title: 'Log retention and viewers',
      lead:
        'Where do logs GO after they are printed? The 12-factor answer is: nowhere — the app writes stdout, someone else owns everything past that boundary.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-retention:stdout-collector',
          body: `STDOUT + A COLLECTOR (the 12-factor way this app follows). The app never opens a log FILE, never rotates one, never knows a retention policy: it writes JSON lines to stdout, full stop. Past that boundary the PLATFORM owns logs — Docker collects the container's stdout/json-file driver (with rotation limits), compose carries that into named volumes, Kubernetes hands them to a logging sidecar or node agent, and a collector (Promtail → Loki, Fluent Bit → Elasticsearch, CloudWatch agent) ships them somewhere with indexes and retention and access control. WHY THIS SPLIT IS LOAD-BEARING: log FILES from inside the app couple you to a disk that must be writable, a rotation strategy (logrotate or your library's), a crash that loses the tail of the buffer, and a container filesystem that dies with the pod. stdout logging means the app stays stateless — which is why this app's Docker images need no log directories at all. THE PINO ECOSYSTEM beyond stdout: pino.transport() targets run in worker threads (pino/file for files, pino-elasticsearch, pino-loki and community shippers for direct-to-destination streams) — the same fan-out this app demonstrates with multistream, pointing at real destinations instead of a ring buffer. THE VIEWER THIS APP BUILDS is honest about what it is: core/logging/log_ring.ts is a 200-entry in-memory ring wired as a second pino destination — a DEV TOOL (live tail in the browser, restart clears it, memory-bounded), not retention. It teaches the read side of structured logging — level filtering, field rendering, correlation — on lines the process actually emitted.`,
        },
        {
          kind: 'code',
          id: 'obs-retention:verbatim-ring',
          language: 'ts',
          caption:
            'Verbatim — the guarded write path: a weird line degrades, never throws (core/logging/log_ring.ts)',
          source: 'server/src/core/logging/log_ring.ts',
          code: `export const ringDestination = {
  write(line: string): void {
    const trimmed = typeof line === 'string' ? line.trim() : '';
    if (trimmed === '') return;

    let parsed = asRecord(safeJsonParse(trimmed));
    if (parsed === null) {
      // Valid JSON that isn't an object, or not JSON at all: keep the raw text.
      parsed = { msg: trimmed.slice(0, 500), unparseable: true };
    }
    // ... every field is typeof-narrowed; the entry lands with levelLabel,
    // msg, reqId/requestId promoted, and every other field in \`fields\`.
    ring.push({
      time,
      level,
      levelLabel: LABEL_BY_NUMBER[level] ?? 'info',
      msg,
      reqId: typeof parsed.reqId === 'string' ? parsed.reqId : undefined,
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
      fields,
    });
    while (ring.length > LOG_RING_CAPACITY) ring.shift();
  },
};`,
        },
      ],
    },
    {
      id: 'obs-health',
      title: 'Health checks: liveness is not readiness',
      lead:
        'Two probes, two different jobs. Confusing them is how you get either endless restarts of a healthy process, or traffic routed to a process that cannot serve it.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-health:two-probes',
          body: `LIVENESS: "is the process alive?" — GET /api/health in this app. It touches NOTHING: no database, no scenario, no container. If it answers, the process has a working event loop and an HTTP stack — a supervisor (Docker healthcheck, Kubernetes liveness probe) restarts the container only when THIS fails, which is why liveness must be cheap and dependency-free: a liveness probe that pings the database will restart a perfectly healthy app whose DATABASE is down, an infinite restart loop that fixes nothing. READINESS: "can this process serve traffic RIGHT NOW?" — it checks the dependencies a request would actually need: primary database reachable, cache connected, queue accepting. A load balancer / Kubernetes readiness probe pulls the process out of rotation while it answers no — no restart, just no traffic, until the dependency returns. THE DEPLOYMENT SUPERPOWER this buys: on rolling deploys the new version starts, readiness says "not yet" (migrations still running, connections still warming), traffic keeps flowing to the old replicas, then flips. Without the distinction you choose between dropping requests during deploys and serving from half-started processes. THIS APP'S HONEST VERSION — GET /api/demo/obs/health: http is trivially ok (you are reading the answer); sqlite is probed for real on a throwaway :memory: handle (embedded, so there is no server to ping — and the probe must never touch guide.db, whose lazy open would create and seed the file as a side effect); mongo and redis — the OPTIONAL services — report three states: ok (configured and answering), down (configured but not answering — readiness says NOT ready while liveness stays alive, exactly the graceful-degradation story their topics teach), or off (not configured, does not participate); grpc reports whether this process started one (server.ts does; under Supertest nothing did, and 'off' says so honestly).`,
        },
        {
          kind: 'code',
          id: 'obs-health:verbatim-liveness',
          language: 'ts',
          caption:
            'Verbatim — the liveness endpoint, deliberately dependency-free (presentation/routes/health_routes.ts)',
          source: 'server/src/presentation/routes/health_routes.ts',
          code: `function healthController(_req: Request, res: Response): void {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    requestId,
  });
}`,
        },
      ],
    },
    {
      id: 'obs-metrics',
      title: 'Metrics without a framework',
      lead:
        'Before you reach for prom-client, it is worth building one metrics endpoint by hand — every framework is a wrapper around numbers Node already has.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-metrics:hand-rolled',
          body: `WHAT THIS APP MEASURES (GET /api/demo/obs/metrics), and where each number really comes from. UPTIME — process.uptime(), seconds since this process started; the first number to check when you SUSPECT restarts are happening. MEMORY — process.memoryUsage(): rss (total resident set — what the OS actually charged us), heapTotal/heapUsed (the V8 heap; a heapUsed that only ever grows across hours is your leak signal), external (ArrayBuffers outside the heap — Buffers count here). EVENT-LOOP DELAY — the real star: perf_hooks.monitorEventLoopDelay() is a histogram the runtime samples for you (here at 20ms resolution, enabled ONCE at module load — creating it per request would measure nothing). Its mean/p99/max are MILLISECONDS the loop was BLOCKED past its expected tick — the single best "is this process actually responsive" number, and the one the Node.js topic's blocking demo deliberately spikes. It is cumulative since boot and never reset — that framing is chosen and stated in the response. REQUEST COUNTERS — total, byStatusClass (2xx/3xx/4xx/5xx), inFlight — maintained by the request-logger middleware's settle path (the only writer, the only decrement path), plus p50/p95 latency over the last 100 durations (nearest-rank percentiles over a small ring — good enough to alert on, honest that it is a window). THE PROMETHEUS WAY this endpoint is a sketch of: prom-client (the catalog mention) keeps registry objects of counters/gauges/histograms and exposes them at /metrics in the exposition format below — a collector scrapes it on an interval and stores the time series. That pull model is why Prometheus metrics are cheap: the app does no shipping; it just answers HTTP. THE RED METHOD — the three per-service metrics that catch most incidents: RATE (requests per second — is load abnormal?), ERRORS (the 5xx fraction — is correctness broken?), DURATION (p50/p95/p99 — is it slow?). This app's counters + duration ring are exactly R, E, D; the byStatusClass split is the E, the p95 the D. Counters and gauges first, histograms when you need percentiles — and always prefer the framework's implementation, because correct histogram buckets are their own rabbit hole.`,
        },
        {
          kind: 'code',
          id: 'obs-metrics:verbatim-endpoint',
          language: 'ts',
          caption:
            'Verbatim — the monitor created ONCE at module load, and the controller that reads it (presentation/routes/obs_demo_routes.ts)',
          source: 'server/src/presentation/routes/obs_demo_routes.ts',
          code: `const eventLoopMonitor: ELDHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();

function metricsController(_req: Request, res: Response): void {
  const memory = process.memoryUsage();
  // The histogram reports NANOSECONDS (verified empirically: a ~22ms stall
  // reads max ≈ 22_118_399) and percentiles is a Map — .get(), not indexing.
  // With few samples the higher percentile keys are absent, so p99 degrades
  // honestly down the ladder to p90 → mean.
  const toMs = (nanoseconds: number | undefined): number | null =>
    nanoseconds === undefined ? null : Math.round((nanoseconds / 1e6) * 1000) / 1000;
  const loopMeanMs = toMs(eventLoopMonitor.mean) ?? 0;
  const loopP99Ms =
    toMs(eventLoopMonitor.percentiles.get(99)) ??
    toMs(eventLoopMonitor.percentiles.get(90)) ??
    loopMeanMs;
  const loopMaxMs = toMs(eventLoopMonitor.max) ?? 0;

  res.json({
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
    },
    eventLoopDelayMs: {
      mean: loopMeanMs,
      p99: loopP99Ms,
      max: loopMaxMs,
      note: 'cumulative since process start (monitor enabled at module load, never reset)',
    },
    requests: snapshotRequestMetrics(),
  });
}`,
        },
        {
          kind: 'code',
          id: 'obs-metrics:prometheus-sketch',
          language: 'text',
          caption:
            'Sketch — the same numbers in Prometheus exposition format (what prom-client would serve at /metrics)',
          code: `# HELP http_requests_total Total requests by status class.
# TYPE http_requests_total counter
http_requests_total{status="2xx"} 4127
http_requests_total{status="4xx"} 96
http_requests_total{status="5xx"} 3
# HELP event_loop_delay_ms_mean Mean event loop delay.
# TYPE event_loop_delay_ms_mean gauge
event_loop_delay_ms_mean 1.413
# HELP process_resident_memory_bytes Resident set size.
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 92856320`,
        },
      ],
    },
    {
      id: 'obs-alerting',
      title: 'Alerting on what matters',
      lead:
        'Every alert that fires and does not need a human teaches the team to ignore alerts. Symptom-based alerting is how you keep the pager honest.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-alerting:symptoms',
          body: `ALERT ON SYMPTOMS, NOT CAUSES. A SYMPTOM is something a USER experiences being wrong: error RATE (5xx fraction over a window), LATENCY (p95/p99 above budget), SATURATION (memory at the limit, event-loop delay climbing, disk filling) — the USE method (Utilization, Saturation, Errors) plus latency. A CAUSE is an internal state that MIGHT produce a symptom: CPU at 90%, a garbage-collection pause, a config reload. Causes make NOISY alerts (high CPU with fine latency is not an incident — you bought the CPU to use it), and quiet failures (a dead circuit breaker that never alerts because no cause metric moved). The discipline: page on symptoms, and use cause metrics for DIAGNOSIS after the page fires — dashboards, not pagers. THE JOBS TOPIC'S EXAMPLE is the shape of a good application-level alert: queue DEPTH (jobs waiting) and OLDEST-JOB AGE (how long the oldest has waited) — both are user-visible symptoms of "work is not getting done," and both are exactly what GET /api/demo/jobs/stats reports (oldestQueuedAgeMs is the honest one: depth 50 with a 2-second oldest age is fine; depth 3 with a 20-minute oldest age is an outage that no depth threshold would catch). RATE WINDOWS matter: a single failed request at 03:00 is not a 1% error RATE — alert on ratios over windows (e.g. 5xx/total over 5 minutes, minimum volume) so one flaky request does not page anyone.`,
        },
        {
          kind: 'code',
          id: 'obs-alerting:sketch',
          language: 'text',
          caption:
            'Sketch — symptom-first alert rules over the metrics this app already produces (the right column is what each rule protects)',
          code: `# page: users are seeing failures
alert: http_error_rate
expr: sum(rate(http_requests_total{status="5xx"}[5m]))
    / sum(rate(http_requests_total[5m])) > 0.02
protects: correctness

# page: users are waiting
alert: http_p95_latency
expr: histogram_quantile(0.95, sum(rate(http_request_duration_bucket[5m])) by (le)) > 0.5
protects: responsiveness

# page: work is stuck even though HTTP looks fine
alert: oldest_job_age
expr: jobs_oldest_queued_age_ms > 300000
protects: background work actually finishing

# dashboard only — a cause, not a symptom (high CPU alone pages nobody)
dashboard: process_cpu_utilization, event_loop_delay_ms_p99`,
        },
      ],
    },
    {
      id: 'obs-safety-nets',
      title: 'Process-level safety nets',
      lead:
        'The last two handlers every Node process should register — and why the right move after an uncaught exception is to crash, not to carry on.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-safety-nets:crash-dont-limp',
          body: `THE TWO EVENTS. uncaughtException fires when an exception unwinds past every handler — a bug, full stop. unhandledRejection fires when a promise rejects and nobody attached a catch — in modern Node an uncaught one is fatal by default anyway, and an EXPLICIT handler is how you control the log line and exit code. WHY CRASHING IS THE STRATEGY: after either event, the process's state is SUSPECT — locks may be held, in-flight writes half-applied, timers half-scheduled, invariants broken mid-mutation. "Log it and keep running" produces a zombie: a process that answers health checks while quietly misbehaving in ways nobody can reproduce. The honest move is the one this app takes — log FATAL with everything known (the ring and stdout both get it), exit non-zero, and let the SUPERVISOR restart a clean process (Docker's restart policy, compose, pm2, Kubernetes — the deployment topic's cast; every one of them treats a non-zero exit as "restart me"). The 100ms grace before exit exists because stdout to a PIPE is asynchronous — exit truncates pending writes, and losing the fatal line that explains the crash would be its own incident. THE TRADEOFF TO KNOW: this registers the handlers at MODULE SCOPE in server.ts, so importing server.ts registers them (specs import app.ts instead, precisely so a test-time fatal cannot exit the worker). If YOU register such handlers inside library code, guard them accordingly — a process.exit(1) inside a test runner is a self-inflicted outage.`,
        },
        {
          kind: 'code',
          id: 'obs-safety-nets:verbatim-handlers',
          language: 'ts',
          caption:
            'Verbatim — the safety nets (src/server.ts, after the SIGINT/SIGTERM handlers)',
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
      id: 'obs-tracing',
      title: 'Distributed tracing: one id across every hop',
      lead:
        'Logs tell you what happened and metrics tell you how much — a trace tells you WHERE THE TIME WENT, hop by hop. This app ships a hand-rolled W3C tracer: real traceparent parsing, real spans, real propagation into a background job.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-tracing:why',
          body: `THE THREE QUESTIONS ONLY A TRACE ANSWERS. (1) WHERE DID THE TIME GO — a p95 metric says checkout is slow; a trace shows that one request spent 8ms in routing, 410ms waiting on the payments call, 12ms writing the row — the fix points at ONE hop, not at the whole endpoint. (2) WHAT CAUSED WHAT — spans carry parent ids, so the CALL TREE is reconstructable even when the work crossed a boundary (an HTTP hop, a queue); log correlation across processes is guesswork, a trace's causality is RECORDED at emission. (3) WHAT HAPPENED ON THE UNLOGGED PATHS — a span opens around every hop by construction, so the middleware nobody instrumented and the retry nobody logged still appear as bars in the waterfall. THE MECHANISM IS DELIBERATELY SMALL: one 16-byte trace id shared by every span of one user action, one 8-byte span id per unit of work, a parent id naming the caller — and one HTTP header carrying all of it across boundaries. This app hand-rolls the entire thing (no OpenTelemetry SDK — the paragraph at the end maps this onto it), in the same spirit as the log ring and the metrics endpoint: the real standard, small enough to read. The anatomy is the source file's own header comment:`,
        },
        {
          kind: 'code',
          id: 'obs-tracing:header-anatomy',
          language: 'ts',
          caption:
            'Verbatim — the header anatomy and the requestId-vs-traceId distinction, as the source file documents itself (core/logging/trace_context.ts)',
          source: 'server/src/core/logging/trace_context.ts',
          code: ` * THE HEADER (version 00):
 *
 *   traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 *                └┬┘ └──────────────┬──────────────┘ └──────┬──────┘ └┬┘
 *              version          trace-id (32 hex)      parent-id (16 hex) flags
 *
 * - trace-id: the WHOLE distributed trace's identity — every hop of one user
 *   action carries the same 16 bytes, across services.
 * - parent-id: the span id of the CALLER — "who caused this work". Each
 *   server hop generates its OWN span id and passes THAT downstream.
 * - flags: 2 hex bits; bit 0 (01) = sampled. Version 00 defines only bit 0.
 *
 * requestId vs traceId — the coexistence that IS the lesson: the request id
 * (request_id_middleware.ts) correlates LOG LINES within this process, one
 * per inbound HTTP request; the trace id correlates WORK across services and
 * processes, many requests per trace. Neither substitutes for the other.`,
        },
        {
          kind: 'text',
          id: 'obs-tracing:continue-or-generate',
          body: `CONTINUE vs GENERATE — the whole protocol in one decision. A VALID inbound traceparent means someone upstream already started this story: CONTINUE it — same trace id, and this hop's span becomes a CHILD of theirs (its parent-id is their span id). Anything else — no header (a browser, a health check), a malformed value, a wrong version, all-zero ids — means a FRESH trace: generate a new identity and carry on. THE FAILURE MODE IS CHOSEN ON PURPOSE: a malformed header is IGNORED, never a throw, never a 400 — observability must not break the request it observes (the hostile-input discipline of the validation topic, applied to a header only we consume). Version 'ff' is reserved-forbidden, and any future version might redefine the fields' meaning, so a version-00 parser starts fresh rather than guessing — the standard's own forward-compatibility rule. The parse below is anchored, total, and lowercase-normalizing; the format/generate/child triple beside it is everything the wire ever sees:`,
        },
        {
          kind: 'code',
          id: 'obs-tracing:verbatim-parse',
          language: 'ts',
          caption:
            'Verbatim — the paranoid parse, the canonical format, and the two identities (core/logging/trace_context.ts)',
          source: 'server/src/core/logging/trace_context.ts',
          code: `export function parseTraceparent(header: string | undefined): ParsedTraceparent | null {
  if (typeof header !== 'string') return null;
  const first = header.split(',')[0]?.trim();
  if (first === undefined || first === '') return null;

  const match = TRACEPARENT_PATTERN.exec(first);
  if (match === null) return null;
  // …lowercase-normalize the four fields, gate on version '00', reject
  // all-zero ids — anything unusable is null, never a throw…

  // Flags: bit 0 = sampled. Higher bits are defined by newer versions and
  // ignored here (masked out, not rejected).
  const sampled = (Number.parseInt(flags, 16) & 0b01) === 0b01;
  return { version, traceId, parentId, sampled };
}

/** Canonical output: always lowercase, version 00, one-line flags byte. */
export function formatTraceparent(context: TraceContext): string {
  return \`\${TRACE_VERSION}-\${context.traceId}-\${context.spanId}-\${context.sampled ? '01' : '00'}\`;
}

/** A fresh identity: new traceId + new spanId (a brand-new trace's first span). */
export function generateTraceContext(sampled = true): TraceContext {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    sampled,
  };
}

/** A CHILD identity: same trace (and sampling decision), NEW span id. */
export function childTraceContext(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: randomBytes(8).toString('hex'), sampled: parent.sampled };
}`,
        },
        {
          kind: 'text',
          id: 'obs-tracing:middleware-wiring',
          body: `THE WIRING — one middleware, mounted beside the request-id middleware. It reads req.headers.traceparent, parses (paranoid and total), turns a valid remote parent into a context, opens the request's ROOT span, and — the load-bearing half — parks the span context on res.locals.traceContext where every handler can parent its own spans off it, and echoes a traceparent RESPONSE header naming this hop, so the CALLER can keep tracing. The root span closes on the response's finish/close events (first one wins — the same settle race the request logger taught), marked error when the status lands at 500+. Mounted in app.ts directly AFTER the request-id middleware (which it must not touch) and BEFORE the request logger and routes — so the access log line and every handler already have the context:`,
        },
        {
          kind: 'code',
          id: 'obs-tracing:verbatim-middleware',
          language: 'ts',
          caption:
            'Verbatim — continue-or-generate, the root span, and the response header (presentation/middleware/trace_middleware.ts)',
          source: 'server/src/presentation/middleware/trace_middleware.ts',
          code: `export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const rawHeader = req.headers.traceparent;
  const parsed: ParsedTraceparent | null = parseTraceparent(Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader);

  // The REMOTE parent as a context: continuing a trace means this hop's span
  // is a CHILD of the caller's span (same traceId, parent = their span id).
  // Fresh requests pass null and get a brand-new trace.
  const remoteParent: TraceContext | null =
    parsed === null
      ? null
      : { traceId: parsed.traceId, spanId: parsed.parentId, sampled: parsed.sampled };

  // …capture req.path NOW (the request logger's lesson: routers rewrite req.url)…
  const { span, context } = startSpan(\`http \${req.method} \${req.path}\`, remoteParent, {
    continuedFromIncoming: parsed !== null,
  });

  // Handlers parent their spans off THIS context (the local root), and the
  // response header names it — the value a caller would need to keep tracing.
  res.locals.traceContext = context;
  res.setHeader('traceparent', formatTraceparent(context));
  // …the span closes on res 'finish'/'close' — first event wins — with
  // status >= 500 recorded as an error…
  next();
}`,
        },
        {
          kind: 'text',
          id: 'obs-tracing:spans-and-propagation',
          body: `SPANS ARE NESTED TIMINGS — withSpan is the whole ergonomics: it runs a function inside a span that closes NO MATTER WHAT ('ok' on return, 'error' with the message attached on throw, and the throw RETHROWS — tracing never swallows a failure), and it hands the function the span's CONTEXT, which is exactly what must be serialized when the work leaves this process. THE PRODUCER→JOB PROPAGATION is the demo's proof, quoted below: the enqueue span formats ITS context into a traceparent and puts it IN THE JOB PAYLOAD — the same header, riding as data (precisely how it would ride an outbound fetch's headers or a Kafka record's) — and the worker side parses it back and records its span UNDER THE PRODUCER'S, with timing taken from the queue's own history events (the worker's real work window, honest provenance — not this poller's observation latency). One trace id, two roles, zero magic; the response body carries requestId beside traceId on purpose, the whole coexistence lesson in one object.`,
        },
        {
          kind: 'code',
          id: 'obs-tracing:verbatim-propagation',
          language: 'ts',
          caption:
            'Verbatim — the propagation moment and its consumer half (presentation/routes/obs_demo_routes.ts): context out as payload data, back in as a child span',
          source: 'server/src/presentation/routes/obs_demo_routes.ts',
          code: `const { result: enqueuedJob } = await withSpan(
  'trace-demo: enqueue email job (producer)',
  async (producerCtx) => {
    // THE PROPAGATION MOMENT: the current span context leaves the process
    // as DATA — a string in the job payload — exactly how it would ride an
    // HTTP header to the next service or a Kafka record header.
    const enqueued = traceQueue.enqueue('email', {
      to: 'student@example.com',
      subject: 'traced by traceparent',
      source: 'trace-demo',
      traceparent: formatTraceparent(producerCtx),
    });
    // …the not-ok branch throws the typed validation exception…
    return enqueued.value;
  },
  routeCtx,
);

// …the worker settles; its span is recorded under the PROPAGATED context:
const consumer = recordCompletedSpan({
  name: 'trace-demo: job worker — email handler (consumer)',
  traceId: propagated.traceId,
  parentId: propagated.parentId,
  startedAtMs: Date.parse(runningAt.at),
  endedAtMs: Date.parse(settledAt.at),
  status: settledAt.event === 'succeeded' ? 'ok' : 'error',
  attributes: {
    jobId: job.id,
    propagatedTraceparent: enqueuedJob.payload.traceparent,
    note: 'parent = the producer span; timing = the queue worker history (real work window)',
  },
});`,
        },
        {
          kind: 'text',
          id: 'obs-tracing:opentelemetry',
          body: `HOW THIS MAPS ONTO OPENTELEMETRY — concept for concept, because OTel is this section industrialized; no SDK code is needed to see the correspondence. The API package (@opentelemetry/api) defines the vocabulary this app hand-rolled: a SPAN with trace id, span id, parent ids, name, attributes, and status — startSpan/endSpan/withSpan are its span lifecycle, and res.locals.traceContext is the manual version of its context propagation. The SDK packages (@opentelemetry/sdk-node, wrapping sdk-trace-node) supply the machinery skipped here: sampling POLICIES (this app parses the sampled bit but records everything — respecting it is a collector decision), batch processors, and automatic context management. INSTRUMENTATION packages (an express instrumentation module, an http one, database-driver ones) do automatically what the middleware above does by hand — a root span per request, child spans per outbound call. And EXPORTERS ship finished spans over OTLP to a collector (Jaeger, Tempo, Zipkin, or a vendor backend) — where this app's 500-span ring is a window on recent work, a collector pipeline is retention, indexing, and the waterfall UI that makes the three questions at the top answerable with a click. TRACE ID vs REQUEST ID, one last time: the requestId is THIS process's correlation key for LOG LINES (one per inbound request); the traceId is the WORK's identity across services and processes (many requests per trace). The demo's answer carries both, side by side.`,
        },
        {
          kind: 'code',
          id: 'obs-tracing:curl',
          language: 'bash',
          caption: 'The trace demo over curl (server running on :4000)',
          code: `# run the chain — root span -> handler -> usecase -> db -> traced job:
curl -s -X POST localhost:4000/api/demo/obs/trace/run | head -c 600

# fetch the settled waterfall for that traceId (copy it from the answer):
curl -s 'localhost:4000/api/demo/obs/trace/spans?traceId=<the-32-hex-traceId>' | head -c 400

# continue a caller's trace — the header is the entire contract:
curl -si -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' \\
  localhost:4000/api/demo/obs/trace/run | grep -i '^traceparent'

# clean slate (span ring + the trace demo's job queue):
curl -s -X POST localhost:4000/api/demo/obs/trace/reset`,
        },
        {
          kind: 'demo',
          id: 'obs-tracing:demo',
          demoId: 'obs:trace',
          title: 'The trace waterfall',
          description:
            'Run the real span chain (root span -> handler -> usecase -> db -> traced job enqueue), inspect one trace\u2019s nested waterfall by traceId, and continue an inbound traceparent header — the producer/consumer link across the job queue, live.',
        },
      ],
    },
    {
      id: 'obs-see-it-live',
      title: 'The same surface from a terminal',
      lead:
        'The console now lives in the structured-logging section above. This closing section is the terminal companion: the ring, the metrics, and the readiness probe read over curl — straight from the running process, never fixtures.',
      blocks: [
        {
          kind: 'text',
          id: 'obs-see-it-live:what-you-see',
          body: `THE CURL VIEW of the same process. LOGS: /logs?minLevel=warn is the ring filtered exactly as the console filters it — the level discipline, queryable; /make-noise fires the controlled burst (3×200 info, one 404 warn, one 400 warn, one 503 error — the 503 toggles failure injection around a real domain call and always restores it), so the next /logs read shows lines landing at the levels the discipline promises, the access line and the error line correlated by reqId. METRICS: /metrics answers uptime, event-loop delay (mean/p99), memory, and the request counters — including inFlight, which reads 1 while its own request is being served. HEALTH: /health answers the readiness strip — sqlite probed for real, mongo/redis ok/down/off, grpc honest about whether this process started one — with liveness living at /api/health, dependency-free. Nothing here is fixture data: every command reads the process you are talking to. The console above renders the same endpoints with level chips and strips; this block is the guide's own tail -f.`,
        },
        {
          kind: 'code',
          id: 'obs-see-it-live:curl',
          language: 'bash',
          caption: 'The same surface over curl (server running on :4000)',
          code: `curl -s localhost:4000/api/demo/obs/logs?minLevel=warn | head -c 400
curl -s -X POST localhost:4000/api/demo/obs/make-noise
curl -s localhost:4000/api/demo/obs/metrics | head -c 400
curl -s localhost:4000/api/demo/obs/health`,
        },
      ],
    },
  ],
};
