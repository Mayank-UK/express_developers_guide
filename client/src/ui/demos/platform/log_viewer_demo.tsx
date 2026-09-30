import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `obs:viewer` — the observability topic's live console.
 *
 * 1. THE LOG VIEWER — polls the process's own in-memory pino ring
 *    (GET /api/demo/obs/logs) and renders each line as {time, level chip,
 *    msg, reqId, key fields}. minLevel buttons refetch with the filter (the
 *    URL carries it), MAKE NOISE fires the controlled burst endpoint so
 *    200/404/400/503 lines land with the right level chips.
 * 2. THE METRICS CARD — uptime, event-loop delay mean/p99, memory, and the
 *    request counters (total, by status class, inFlight, p50/p95 latency).
 * 3. THE HEALTH CARD — the readiness check strip (ok/down/off chips) with the
 *    liveness-vs-readiness distinction spelled out.
 *
 * Polling (2s, toggleable) stops on unmount; every payload is guarded — a
 * malformed response degrades to an error strip, never a crash.
 */

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type Level = (typeof LEVELS)[number];

const POLL_MS = 2000;

const logsUrl = (minLevel: Level, limit: number): string =>
  `/api/demo/obs/logs?limit=${String(limit)}&minLevel=${minLevel}`;
const METRICS_URL = '/api/demo/obs/metrics';
const HEALTH_URL = '/api/demo/obs/health';
const NOISE_URL = '/api/demo/obs/make-noise';

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_QUIET =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface hover:bg-surface-variant disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

/** Level → color class: warn/error/fatal get the semantic tokens they earn. */
function levelClass(level: string): string {
  if (level === 'error' || level === 'fatal') return 'text-error';
  if (level === 'warn') return 'text-warning';
  if (level === 'info') return 'text-on-surface';
  return 'text-on-surface-variant';
}

/** The fields worth showing on a log line (err objects stay out of the chip row). */
const FIELDS_TO_SHOW = [
  'method',
  'path',
  'status',
  'durationMs',
  'statusCode',
  'failureKind',
  'aborted',
] as const;

interface LogEntry {
  time: number;
  level: number;
  levelLabel: string;
  msg: string;
  reqId?: string;
  requestId?: string;
  fields: Record<string, unknown>;
}

interface LogsPayload {
  logs: LogEntry[];
  count: number;
  minLevel: string;
  limit: number;
}

interface MetricsPayload {
  uptimeSeconds: number;
  memory: { rssBytes: number; heapTotalBytes: number; heapUsedBytes: number };
  eventLoopDelayMs: { mean: number; p99: number };
  requests: {
    total: number;
    byStatusClass: Record<string, number>;
    inFlight: number;
    durations: { count: number; p50Ms: number | null; p95Ms: number | null };
  };
}

interface HealthPayload {
  alive: boolean;
  ready: boolean;
  checks: Record<string, { state: string; note: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLogs(raw: unknown): LogsPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.logs)) return null;
  const logs = raw.logs.filter(
    (entry): entry is LogEntry =>
      isRecord(entry) &&
      typeof entry.time === 'number' &&
      typeof entry.levelLabel === 'string' &&
      typeof entry.msg === 'string' &&
      isRecord(entry.fields),
  );
  return {
    logs,
    count: typeof raw.count === 'number' ? raw.count : logs.length,
    minLevel: typeof raw.minLevel === 'string' ? raw.minLevel : 'trace',
    limit: typeof raw.limit === 'number' ? raw.limit : 0,
  };
}

function parseMetrics(raw: unknown): MetricsPayload | null {
  if (!isRecord(raw) || !isRecord(raw.memory) || !isRecord(raw.requests)) return null;
  if (typeof raw.uptimeSeconds !== 'number') return null;
  if (!isRecord(raw.eventLoopDelayMs) || typeof raw.eventLoopDelayMs.mean !== 'number') return null;
  const memory = raw.memory;
  const requests = raw.requests;
  if (
    typeof memory.rssBytes !== 'number' ||
    typeof memory.heapTotalBytes !== 'number' ||
    typeof memory.heapUsedBytes !== 'number'
  ) {
    return null;
  }
  if (typeof requests.total !== 'number' || typeof requests.inFlight !== 'number') return null;
  if (!isRecord(requests.byStatusClass) || !isRecord(requests.durations)) return null;
  const eventLoopDelayMs = raw.eventLoopDelayMs as { mean: number; p99?: unknown };
  return {
    uptimeSeconds: raw.uptimeSeconds,
    memory: {
      rssBytes: memory.rssBytes,
      heapTotalBytes: memory.heapTotalBytes,
      heapUsedBytes: memory.heapUsedBytes,
    },
    eventLoopDelayMs: {
      mean: eventLoopDelayMs.mean,
      p99: typeof eventLoopDelayMs.p99 === 'number' ? eventLoopDelayMs.p99 : eventLoopDelayMs.mean,
    },
    requests: {
      total: requests.total,
      byStatusClass: requests.byStatusClass as Record<string, number>,
      inFlight: requests.inFlight,
      durations: {
        count: typeof requests.durations.count === 'number' ? requests.durations.count : 0,
        p50Ms: typeof requests.durations.p50Ms === 'number' ? requests.durations.p50Ms : null,
        p95Ms: typeof requests.durations.p95Ms === 'number' ? requests.durations.p95Ms : null,
      },
    },
  };
}

function parseHealth(raw: unknown): HealthPayload | null {
  if (!isRecord(raw) || !isRecord(raw.checks)) return null;
  if (typeof raw.alive !== 'boolean' || typeof raw.ready !== 'boolean') return null;
  const checks: HealthPayload['checks'] = {};
  for (const [name, value] of Object.entries(raw.checks)) {
    if (!isRecord(value) || typeof value.state !== 'string' || typeof value.note !== 'string') {
      return null;
    }
    checks[name] = { state: value.state, note: value.note };
  }
  return { alive: raw.alive, ready: raw.ready, checks };
}

function timeOfDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 23);
}

function mb(bytes: number): string {
  return `${String(Math.round((bytes / 1024 / 1024) * 10) / 10)} MB`;
}

function ms(value: number | null): string {
  return value === null ? '—' : `${String(Math.round(value * 1000) / 1000)}ms`;
}

export default function LogViewerDemo(): ReactNode {
  const [minLevel, setMinLevel] = useState<Level>('info');
  const [limit, setLimit] = useState(100);
  const [polling, setPolling] = useState(true);

  const [logs, setLogs] = useState<LogsPayload | null>(null);
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [noise, setNoise] = useState<
    { attempted: Array<{ label: string; gotStatus: number | 'error' }>; note: string } | null
  >(null);
  const [noiseBusy, setNoiseBusy] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [logsRes, metricsRes, healthRes] = await Promise.all([
        fetch(logsUrl(minLevel, limit)),
        fetch(METRICS_URL),
        fetch(HEALTH_URL),
      ]);
      if (!mounted.current) return;
      if (!logsRes.ok || !metricsRes.ok || !healthRes.ok) throw new Error('HTTP error');
      const parsedLogs = parseLogs(await logsRes.json());
      const parsedMetrics = parseMetrics(await metricsRes.json());
      const parsedHealth = parseHealth(await healthRes.json());
      if (!mounted.current) return;
      if (parsedLogs === null || parsedMetrics === null || parsedHealth === null) {
        throw new Error('malformed payload');
      }
      setLogs(parsedLogs);
      setMetrics(parsedMetrics);
      setHealth(parsedHealth);
      setPanelError(null);
    } catch {
      if (mounted.current) {
        setPanelError('the console could not reach the server — is it running?');
      }
    }
  }, [minLevel, limit]);

  // The poll loop: fire immediately, then every POLL_MS while polling is on.
  // Cancelled via `cancelled` + clearTimeout on unmount or on dependency
  // change (a filter click re-runs the effect and refetches at once).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      await refresh();
      if (cancelled || !polling) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    if (polling) void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [polling, refresh]);

  const makeNoise = useCallback(async (): Promise<void> => {
    setNoiseBusy(true);
    try {
      const response = await fetch(NOISE_URL, { method: 'POST' });
      if (!mounted.current) return;
      if (!response.ok) throw new Error('HTTP error');
      const raw: unknown = await response.json();
      if (!mounted.current) return;
      if (!isRecord(raw) || !Array.isArray(raw.attempted) || typeof raw.note !== 'string') {
        throw new Error('malformed payload');
      }
      setNoise({
        attempted: raw.attempted.filter(
          (entry): entry is { label: string; gotStatus: number | 'error' } =>
            isRecord(entry) && typeof entry.label === 'string',
        ),
        note: raw.note,
      });
      await refresh();
    } catch {
      if (mounted.current) {
        setNoise({ attempted: [], note: 'make-noise failed — is the server running?' });
      }
    } finally {
      if (mounted.current) setNoiseBusy(false);
    }
  }, [refresh]);

  const statusClasses =
    metrics === null
      ? []
      : (['2xx', '3xx', '4xx', '5xx'] as const).map((key) => ({
          key,
          count: metrics.requests.byStatusClass[key] ?? 0,
        }));

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="obs-summary" className="text-body-sm text-on-surface">
        Everything below reads THIS running process: the log viewer tails the in-memory pino ring,
        the metrics card reads the hand-rolled counters, the health card runs the readiness probe.
        The level chips carry the topic&apos;s discipline — 4xx warns, 5xx errors.
      </p>

      {/* ---- panel 1: the log viewer ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">1 · the log viewer</span>
          <span className={CHIP}>GET /api/demo/obs/logs</span>
          <button
            type="button"
            data-testid="obs-poll-toggle"
            className={BUTTON_QUIET}
            onClick={() => setPolling((value) => !value)}
          >
            polling: {polling ? 'on (2s)' : 'off'}
          </button>
          <button
            type="button"
            data-testid="obs-noise-button"
            className={BUTTON_PRIMARY}
            onClick={() => void makeNoise()}
            disabled={noiseBusy}
          >
            {noiseBusy ? 'firing…' : 'make noise'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-xxs" data-testid="obs-filters">
          <span className="text-caption text-on-surface-variant">minLevel:</span>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              data-testid={`obs-filter-${level}`}
              className={`${BUTTON_QUIET} ${minLevel === level ? 'bg-surface-variant font-semibold' : ''}`}
              onClick={() => setMinLevel(level)}
            >
              {level}
            </button>
          ))}
          <span className="text-caption text-on-surface-variant">limit:</span>
          {[50, 100, 200].map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`obs-limit-${String(value)}`}
              className={`${BUTTON_QUIET} ${limit === value ? 'bg-surface-variant font-semibold' : ''}`}
              onClick={() => setLimit(value)}
            >
              {String(value)}
            </button>
          ))}
        </div>

        {panelError !== null && (
          <p data-testid="obs-error" className="text-caption text-error">
            {panelError}
          </p>
        )}

        {noise !== null && (
          <div data-testid="obs-noise-result" className="flex flex-col gap-xxs">
            <p className="text-caption text-on-surface-variant">{noise.note}</p>
            <p data-testid="obs-noise-attempts" className="font-mono text-caption text-on-surface">
              {noise.attempted
                .map((attempt) => `${attempt.label}→${String(attempt.gotStatus)}`)
                .join('  ')}
            </p>
          </div>
        )}

        {logs === null && panelError === null && (
          <p data-testid="obs-logs-loading" className="text-body-sm text-on-surface-variant">
            reading the ring…
          </p>
        )}

        {logs !== null && logs.logs.length === 0 && (
          <p data-testid="obs-logs-empty" className="text-body-sm text-on-surface-variant">
            the ring has nothing at this level yet — press make noise, or drop the filter.
          </p>
        )}

        {logs !== null && logs.logs.length > 0 && (
          <div data-testid="obs-logs" className="flex max-h-80 flex-col gap-xxs overflow-y-auto">
            {logs.logs.map((entry, index) => {
              const shown = FIELDS_TO_SHOW.filter((key) => entry.fields[key] !== undefined).map(
                (key) => `${key}=${String(entry.fields[key])}`,
              );
              const correlation = entry.reqId ?? entry.requestId;
              return (
                <div
                  key={`${String(entry.time)}-${String(index)}`}
                  data-testid="obs-log-line"
                  className="flex flex-wrap items-baseline gap-x-xs gap-y-xxs font-mono text-caption"
                >
                  <span className="text-on-surface-variant">{timeOfDay(entry.time)}</span>
                  <span
                    data-testid="obs-level-chip"
                    className={`rounded border border-outline px-xxs font-semibold ${levelClass(entry.levelLabel)}`}
                  >
                    {entry.levelLabel}
                  </span>
                  <span className="text-on-surface">{entry.msg}</span>
                  {shown.map((field) => (
                    <span key={field} className="text-on-surface-variant">
                      {field}
                    </span>
                  ))}
                  {correlation !== undefined && (
                    <span className="text-on-surface-variant" title="the correlation key — grep it to line up this request's lines">
                      reqId: {correlation.slice(0, 13)}…
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {logs !== null && (
          <p data-testid="obs-logs-meta" className="text-caption text-on-surface-variant">
            {String(logs.count)} lines at minLevel {logs.minLevel} · oldest → newest · this poll
            cannot contain its own request line (the access line lands on finish, after the
            response is sent)
          </p>
        )}
      </section>

      {/* ---- panel 2: the metrics card ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">2 · the metrics strip</span>
          <span className={CHIP}>GET /api/demo/obs/metrics</span>
        </div>

        {metrics === null ? (
          <p data-testid="obs-metrics-loading" className="text-body-sm text-on-surface-variant">
            reading process metrics…
          </p>
        ) : (
          <div data-testid="obs-metrics" className="flex flex-col gap-xxs">
            <div className="flex flex-wrap gap-xs">
              <span className={CHIP_STRONG}>uptime: {String(metrics.uptimeSeconds)}s</span>
              <span className={CHIP}>event-loop mean: {ms(metrics.eventLoopDelayMs.mean)}</span>
              <span className={CHIP}>p99: {ms(metrics.eventLoopDelayMs.p99)}</span>
              <span className={CHIP}>rss: {mb(metrics.memory.rssBytes)}</span>
              <span className={CHIP}>heap: {mb(metrics.memory.heapUsedBytes)}</span>
            </div>
            <div className="flex flex-wrap gap-xs">
              <span className={CHIP_STRONG}>requests: {String(metrics.requests.total)}</span>
              <span data-testid="obs-inflight" className={CHIP}>
                in flight: {String(metrics.requests.inFlight)}
              </span>
              {statusClasses.map((entry) => (
                <span key={entry.key} className={CHIP}>
                  {entry.key}: {String(entry.count)}
                </span>
              ))}
              <span className={CHIP}>
                p50: {ms(metrics.requests.durations.p50Ms)} · p95:{' '}
                {ms(metrics.requests.durations.p95Ms)} (last{' '}
                {String(metrics.requests.durations.count)})
              </span>
            </div>
            <p className="text-caption text-on-surface-variant">
              inFlight reads 1 while its own request is being served — the counters settle on
              finish. The event-loop histogram is cumulative since process start.
            </p>
          </div>
        )}
      </section>

      {/* ---- panel 3: the health card ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">3 · the readiness probe</span>
          <span className={CHIP}>GET /api/demo/obs/health</span>
        </div>

        {health === null ? (
          <p data-testid="obs-health-loading" className="text-body-sm text-on-surface-variant">
            probing dependencies…
          </p>
        ) : (
          <div data-testid="obs-health" className="flex flex-col gap-xxs">
            <div className="flex flex-wrap gap-xs">
              <span className={CHIP_STRONG}>alive: {health.alive ? 'true' : 'false'}</span>
              <span
                data-testid="obs-ready-chip"
                className={`rounded-md border border-outline px-xs py-xxs font-mono text-caption font-semibold ${
                  health.ready ? 'text-on-surface' : 'text-error'
                }`}
              >
                ready: {health.ready ? 'true' : 'false'}
              </span>
            </div>
            <div className="flex flex-col gap-xxs">
              {Object.entries(health.checks).map(([name, check]) => (
                <div key={name} className="flex flex-wrap items-baseline gap-x-xs gap-y-xxs">
                  <span
                    data-testid="obs-health-chip"
                    className={`rounded border border-outline px-xxs font-mono text-caption font-semibold ${
                      check.state === 'down' ? 'text-error' : 'text-on-surface'
                    }`}
                  >
                    {name}: {check.state}
                  </span>
                  <span className="text-caption text-on-surface-variant">{check.note}</span>
                </div>
              ))}
            </div>
            <p className="text-caption text-on-surface-variant">
              LIVENESS (GET /api/health) asks only &quot;is the process up&quot; — it touches
              nothing, so a dead dependency never causes restart loops. READINESS (this probe)
              asks &quot;can it serve traffic&quot; — a configured-but-down optional service
              reports down, the app stays alive but stops being ready. Off = not configured; it
              does not participate.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
