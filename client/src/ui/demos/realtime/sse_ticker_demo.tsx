import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `realtime:ticker` — the SSE half of the realtime topic,
 * streaming the real feed at GET /api/demo/realtime/ticker (sse_demo_routes.ts):
 *
 * 1. THE STREAM — a plain EventSource (the browser's built-in SSE client):
 *    named 'tick' events append to a sparkline (last 30 values, one SVG
 *    polyline), and the seq/id/value/change line shows the wire payload.
 * 2. THE CONNECTION CHIP — EventSource's own readyState, mapped. onerror is
 *    NOT fatal: the browser auto-reconnects (with Last-Event-ID) unless the
 *    server permanently refuses — kill the guide server and watch the badge,
 *    then restart it and watch the stream resume on its own.
 * 3. THE SPEED STRIP — ?intervalMs= (server clamps 100–5000) swaps the
 *    connection for a faster or slower cadence.
 * 4. THE RECONNECT BUTTON — the honest lesson: a MANUAL reopen is a NEW
 *    EventSource, and Last-Event-ID only rides the browser's OWN automatic
 *    reconnects — so this fresh stream starts at "now" and the seq visibly
 *    skips the gap.
 */

const TICKER_URL = '/api/demo/realtime/ticker';

const SPEEDS = [1000, 500, 200] as const;
const SPARK_POINTS = 30;
const KEPT_TICKS = 60;

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_WARN =
  'rounded-md border border-outline bg-warning px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

interface TickPayload {
  seq: number;
  time: string;
  value: number;
  change: number;
}

type ConnBadge = { label: string; className: string };

function badgeFor(status: 'connecting' | 'open' | 'reconnecting', readyState: number): ConnBadge {
  if (status === 'open') return { label: `open · readyState ${String(readyState)}`, className: CHIP_OK };
  if (status === 'reconnecting') return { label: `reconnecting · readyState ${String(readyState)}`, className: CHIP_WARN };
  return { label: `connecting · readyState ${String(readyState)}`, className: CHIP };
}

/** Guarded parse — the client never trusts the wire, even a friendly one. */
function parseTick(raw: unknown): TickPayload | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.seq !== 'number' ||
      typeof record.time !== 'string' ||
      typeof record.value !== 'number' ||
      typeof record.change !== 'number'
    ) {
      return null;
    }
    return { seq: record.seq, time: record.time, value: record.value, change: record.change };
  } catch {
    return null;
  }
}

/** Last N values as one polyline — flat data needs no chart library. */
function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 3 - ((value - min) / span) * (height - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function formatChange(change: number): string {
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}`;
}

export default function SseTickerDemo(): ReactNode {
  const [speedMs, setSpeedMs] = useState<number>(500);
  /** Bumped by the reconnect button — the effect re-runs and opens a fresh source. */
  const [streamVersion, setStreamVersion] = useState(0);
  const [ticks, setTicks] = useState<TickPayload[]>([]);
  const [status, setStatus] = useState<'connecting' | 'open' | 'reconnecting'>('connecting');
  const [readyState, setReadyState] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [manualReconnects, setManualReconnects] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);

  // The stream itself. Dependencies re-run on speed change / manual reconnect;
  // the cleanup CLOSES the previous source — and on unmount, the last one.
  useEffect(() => {
    const source = new EventSource(`${TICKER_URL}?intervalMs=${String(speedMs)}`);
    sourceRef.current = source;
    setStatus('connecting');
    setReadyState(source.readyState);

    source.onopen = (): void => {
      setStatus('open');
      setReadyState(source.readyState);
    };
    // Named events need a named listener: 'tick' frames never fire onmessage.
    source.addEventListener('tick', (event: Event) => {
      const payload = parseTick((event as MessageEvent<string>).data);
      if (payload === null) return;
      setTicks((previous) => [...previous.slice(-KEPT_TICKS + 1), payload]);
    });
    source.onerror = (): void => {
      // Not fatal: EventSource auto-reconnects (sending Last-Event-ID) unless
      // the server permanently refuses — the badge says which state we're in.
      setStatus('reconnecting');
      setReadyState(source.readyState);
      setErrorCount((count) => count + 1);
    };

    return () => {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [speedMs, streamVersion]);

  const latest: TickPayload | null = ticks.length > 0 ? (ticks[ticks.length - 1] ?? null) : null;
  const sparkValues = ticks.slice(-SPARK_POINTS).map((tick) => tick.value);
  const badge = badgeFor(status, readyState);
  const firstKeptSeq = ticks.length > 0 ? (ticks[0]?.seq ?? null) : null;
  // The LATEST hole in the seq sequence — what a fresh stream skipped.
  const gapSeqs = (() => {
    for (let index = ticks.length - 1; index > 0; index -= 1) {
      const later = ticks[index];
      const earlier = ticks[index - 1];
      if (later === undefined || earlier === undefined) continue;
      const skipped = later.seq - earlier.seq - 1;
      if (skipped > 0) return skipped;
    }
    return null;
  })();

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="sse-summary" className="text-body-sm text-on-surface">
        One EventSource against the real feed: ticks append to the sparkline, the chip tracks the
        connection&apos;s own readyState, and the reconnect button proves which reconnects carry
        Last-Event-ID (the browser&apos;s own) and which start at &quot;now&quot; (a manual reopen).
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center justify-between gap-xs">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">
            GUIDE-TICKER · /api/demo/realtime/ticker
          </h3>
          <span data-testid="sse-status" className={badge.className}>
            {badge.label}
          </span>
        </div>

        <div className="flex flex-wrap items-baseline gap-sm">
          <span
            data-testid="sse-value"
            className={`font-mono text-title-md ${latest !== null && latest.change < 0 ? 'text-error' : 'text-primary'}`}
          >
            {latest !== null ? latest.value.toFixed(2) : '—'}
          </span>
          {latest !== null && (
            <span
              data-testid="sse-change"
              className={`font-mono text-body-sm ${latest.change < 0 ? 'text-error' : 'text-primary'}`}
            >
              {formatChange(latest.change)}
            </span>
          )}
          <span data-testid="sse-seq" className={CHIP}>
            {latest !== null ? `seq ${String(latest.seq)} · id ${String(latest.seq)}` : 'waiting for first tick…'}
          </span>
          <span data-testid="sse-count" className={CHIP}>
            {String(ticks.length)} events received
          </span>
          {errorCount > 0 && (
            <span data-testid="sse-error-count" className={CHIP_WARN}>
              {String(errorCount)} onerror {errorCount === 1 ? 'event' : 'events'} — browser auto-reconnecting
            </span>
          )}
        </div>

        {/* The sparkline: last 30 values as one polyline — no chart library. */}
        <svg
          data-testid="sse-sparkline"
          viewBox="0 0 300 64"
          className="h-16 w-full"
          role="img"
          aria-label="last thirty ticker values"
        >
          <polyline
            data-testid="sse-sparkline-line"
            points={sparklinePoints(sparkValues, 300, 64)}
            fill="none"
            strokeWidth="1.5"
            className="stroke-primary"
          />
          {latest !== null && (
            <circle
              cx="300"
              cy={
                sparkValues.length >= 2
                  ? 64 -
                    3 -
                    ((latest.value - Math.min(...sparkValues)) /
                      (Math.max(...sparkValues) - Math.min(...sparkValues) || 1)) *
                      (64 - 6)
                  : 32
              }
              r="2.5"
              className="fill-primary"
            />
          )}
        </svg>
        <p className="text-caption text-on-surface-variant">
          last {String(Math.min(SPARK_POINTS, ticks.length))} values (ring keeps {String(KEPT_TICKS)})
          {firstKeptSeq !== null && ` · retained from seq ${String(firstKeptSeq)}`}
          {gapSeqs !== null && (
            <span data-testid="sse-gap" className="text-warning">
              {' '}
              · {String(gapSeqs)} seq{gapSeqs === 1 ? '' : 's'} skipped by a fresh stream — manual reopens
              send no Last-Event-ID
            </span>
          )}
        </p>
      </section>

      <section className="flex flex-wrap items-center gap-sm">
        <span className="text-caption text-on-surface-variant">tick interval:</span>
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            data-testid={`sse-speed-${String(speed)}`}
            onClick={() => setSpeedMs(speed)}
            className={speed === speedMs ? CHIP_OK : CHIP}
          >
            {String(speed)}ms
          </button>
        ))}
        <button
          type="button"
          data-testid="sse-reconnect"
          onClick={() => {
            sourceRef.current?.close();
            setManualReconnects((count) => count + 1);
            setStreamVersion((version) => version + 1);
          }}
          className={BUTTON}
        >
          reconnect (new EventSource)
        </button>
        <span data-testid="sse-manual-reconnects" className={CHIP}>
          {String(manualReconnects)} manual {manualReconnects === 1 ? 'reopen' : 'reopens'}
        </span>
      </section>

      <p data-testid="sse-note" className="text-caption text-on-surface-variant">
        The honest reconnect lesson: the browser sends <code className="font-mono">Last-Event-ID</code>{' '}
        only on ITS OWN automatic reconnects (after onerror, ~3s backoff) — and the server replays
        the retained gap. A manual reopen — the button, or the speed strip — is a NEW stream that
        starts at &quot;now&quot;; watch the seq counter skip. Kill and restart the guide server to
        see the automatic path resume the sequence for real.
      </p>
    </div>
  );
}
