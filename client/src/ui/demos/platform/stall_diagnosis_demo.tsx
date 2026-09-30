import { useCallback, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `debug:stall` — the debugging topic's live event-loop
 * diagnosis, wired entirely from EXISTING endpoints:
 *
 * 1. BASELINE  — GET /api/demo/obs/metrics reads the real
 *                monitorEventLoopDelay histogram (mean/max) before anything
 *                is disturbed.
 * 2. STALL     — GET /api/demo/node/blocking?workMs=300 (synchronous hash
 *                work that owns the loop ~300ms; the endpoint reports its own
 *                setImmediate-probe measurement), then three metrics polls
 *                500ms apart. The histogram is CUMULATIVE, so the story the
 *                bars tell is: max JUMPS on the first poll (the stall being
 *                absorbed) and stays flat after (no NEW stalls).
 * 3. CONTROL   — the same 300ms through GET /api/demo/node/deferred?workMs=300
 *                (10ms setImmediate slices): probe ≈ one slice, histogram
 *                unmoved.
 */

const METRICS_URL = '/api/demo/obs/metrics';
const BLOCKING_URL = '/api/demo/node/blocking?workMs=300';
const DEFERRED_URL = '/api/demo/node/deferred?workMs=300';
const POLL_GAP_MS = 500;
const POLL_COUNT = 3;
/** Bar scale: the chart's full width is a 400ms max — workMs 300 lands at ~75%. */
const BAR_SCALE_MS = 400;

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

interface LoopSample {
  meanMs: number;
  maxMs: number;
}

interface WorkloadProbe {
  mode: string;
  workMs: number;
  eventLoopDelayMs: number;
}

interface PhaseResult {
  probe: WorkloadProbe;
  polls: LoopSample[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.json();
}

async function readLoopSample(): Promise<LoopSample> {
  const raw = await fetchJson(METRICS_URL);
  if (!isRecord(raw) || !isRecord(raw.eventLoopDelayMs)) throw new Error('malformed metrics');
  const loop = raw.eventLoopDelayMs;
  if (typeof loop.mean !== 'number' || typeof loop.max !== 'number') {
    throw new Error('malformed loop histogram');
  }
  return { meanMs: loop.mean, maxMs: loop.max };
}

async function readWorkloadProbe(url: string): Promise<WorkloadProbe> {
  const raw = await fetchJson(url);
  if (
    !isRecord(raw) ||
    typeof raw.mode !== 'string' ||
    typeof raw.workMs !== 'number' ||
    typeof raw.eventLoopDelayMs !== 'number'
  ) {
    throw new Error('malformed workload probe');
  }
  return { mode: raw.mode, workMs: raw.workMs, eventLoopDelayMs: raw.eventLoopDelayMs };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export default function StallDiagnosisDemo(): ReactNode {
  const [baseline, setBaseline] = useState<LoopSample | null>(null);
  const [stall, setStall] = useState<PhaseResult | null>(null);
  const [control, setControl] = useState<PhaseResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'baseline' | 'stall' | 'control'>('idle');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const readBaseline = useCallback(async (): Promise<void> => {
    setPhase('baseline');
    setError(null);
    try {
      const sample = await readLoopSample();
      if (!mounted.current) return;
      setBaseline(sample);
    } catch {
      if (mounted.current) setError('could not read the metrics endpoint — is the server running?');
    } finally {
      if (mounted.current) setPhase('idle');
    }
  }, []);

  /** Fire the workload, then poll the histogram POLL_COUNT times, POLL_GAP apart. */
  const runPhase = useCallback(
    async (kind: 'stall' | 'control'): Promise<void> => {
      setPhase(kind);
      setError(null);
      try {
        const probe = await readWorkloadProbe(kind === 'stall' ? BLOCKING_URL : DEFERRED_URL);
        const polls: LoopSample[] = [];
        for (let index = 0; index < POLL_COUNT; index += 1) {
          if (index > 0) await sleep(POLL_GAP_MS);
          polls.push(await readLoopSample());
          if (mounted.current) {
            // Render progressively — each poll lands as its own bar.
            (kind === 'stall' ? setStall : setControl)({ probe, polls: [...polls] });
          }
        }
      } catch {
        if (mounted.current) setError('the diagnosis could not reach the server — is it running?');
      } finally {
        if (mounted.current) setPhase('idle');
      }
    },
    [],
  );

  const barWidth = (maxMs: number): string =>
    `${String(Math.min(100, Math.max(2, Math.round((maxMs / BAR_SCALE_MS) * 100))))}%`;

  const firstStallPoll = stall === null ? undefined : stall.polls[0];
  const stallJumped =
    firstStallPoll !== undefined &&
    baseline !== null &&
    firstStallPoll.maxMs > Math.max(baseline.maxMs * 2, baseline.maxMs + 50);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="stall-summary" className="text-body-sm text-on-surface">
        Three moves, real endpoints: read the event-loop histogram, stall the loop for 300ms of
        synchronous hashing and watch the spike land, then run the SAME work in 10ms
        setImmediate slices and watch nothing move. The histogram is cumulative — a jump on the
        first poll is the stall being absorbed; flat after means no new stalls.
      </p>

      {error !== null && (
        <p data-testid="stall-error" className="text-caption text-error">
          {error}
        </p>
      )}

      {/* ---- phase 1: baseline ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">1 · baseline</span>
          <span className={CHIP}>GET /api/demo/obs/metrics</span>
          <button
            type="button"
            data-testid="stall-baseline-button"
            className={BUTTON_PRIMARY}
            onClick={() => void readBaseline()}
            disabled={phase !== 'idle'}
          >
            {phase === 'baseline' ? 'reading…' : 'read the histogram'}
          </button>
        </div>
        {baseline === null ? (
          <p className="text-body-sm text-on-surface-variant">
            the real monitorEventLoopDelay histogram, before anything is disturbed
          </p>
        ) : (
          <div data-testid="stall-baseline" className="flex flex-wrap gap-xs">
            <span className={CHIP_STRONG}>mean: {String(baseline.meanMs)}ms</span>
            <span className={CHIP_STRONG}>max: {String(baseline.maxMs)}ms</span>
            <span className={CHIP}>cumulative since process start</span>
          </div>
        )}
      </section>

      {/* ---- phase 2: the stall ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">2 · stall the loop</span>
          <span className={CHIP}>GET /api/demo/node/blocking?workMs=300</span>
          <button
            type="button"
            data-testid="stall-run-button"
            className={BUTTON_PRIMARY}
            onClick={() => void runPhase('stall')}
            disabled={phase !== 'idle'}
          >
            {phase === 'stall' ? 'stalling + polling…' : 'block for 300ms'}
          </button>
        </div>
        {stall === null ? (
          <p className="text-body-sm text-on-surface-variant">
            300ms of synchronous hashing, then three polls of the histogram 500ms apart
          </p>
        ) : (
          <div className="flex flex-col gap-xxs" data-testid="stall-result">
            <p data-testid="stall-probe" className="text-caption text-on-surface">
              the endpoint&apos;s own setImmediate probe measured{' '}
              <strong>{String(stall.probe.eventLoopDelayMs)}ms</strong> of loop stall for{' '}
              {String(stall.probe.workMs)}ms of requested work — every concurrent request
              waited exactly that out.
            </p>
            {stall.polls.map((poll, index) => (
              <div key={index} className="flex items-center gap-xs" data-testid="stall-poll-row">
                <span className="w-16 font-mono text-caption text-on-surface-variant">
                  poll {String(index + 1)}
                </span>
                <div className="h-4 flex-1 rounded border border-outline bg-surface-variant">
                  <div
                    data-testid="stall-poll-bar"
                    className={`h-full rounded ${stallJumped && index === 0 ? 'bg-error' : 'bg-primary'}`}
                    style={{ width: barWidth(poll.maxMs) }}
                  />
                </div>
                <span className="w-24 text-right font-mono text-caption text-on-surface">
                  max {String(poll.maxMs)}ms
                </span>
              </div>
            ))}
            {baseline !== null && (
              <p data-testid="stall-verdict" className="text-caption text-on-surface">
                {stallJumped
                  ? `verdict: the histogram's max jumped ${String(baseline.maxMs)}ms → ${String(firstStallPoll?.maxMs ?? 0)}ms on the first poll and stayed flat after — a ~300ms synchronous workload stalled the loop ~300ms, and every concurrent request waited.`
                  : `verdict: max was already ${String(baseline.maxMs)}ms before this run (the histogram never resets), so the flat bars here mean: no NEW stall beyond what the process had already absorbed — fire the stall from a fresh server boot to see the clean jump.`}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ---- phase 3: the control ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">3 · the control</span>
          <span className={CHIP}>GET /api/demo/node/deferred?workMs=300</span>
          <button
            type="button"
            data-testid="stall-control-button"
            className={BUTTON_PRIMARY}
            onClick={() => void runPhase('control')}
            disabled={phase !== 'idle'}
          >
            {phase === 'control' ? 'slicing + polling…' : 'slice the same work'}
          </button>
        </div>
        {control === null ? (
          <p className="text-body-sm text-on-surface-variant">
            the same 300ms of hashing in 10ms setImmediate slices, then the same three polls
          </p>
        ) : (
          <div className="flex flex-col gap-xxs" data-testid="stall-control-result">
            <p data-testid="stall-control-probe" className="text-caption text-on-surface">
              probe measured <strong>{String(control.probe.eventLoopDelayMs)}ms</strong> — about
              one 10ms slice, not the whole workload: the loop stayed responsive throughout.
            </p>
            {control.polls.map((poll, index) => (
              <div key={index} className="flex items-center gap-xs" data-testid="stall-control-row">
                <span className="w-16 font-mono text-caption text-on-surface-variant">
                  poll {String(index + 1)}
                </span>
                <div className="h-4 flex-1 rounded border border-outline bg-surface-variant">
                  <div
                    data-testid="stall-control-bar"
                    className="h-full rounded bg-primary"
                    style={{ width: barWidth(poll.maxMs) }}
                  />
                </div>
                <span className="w-24 text-right font-mono text-caption text-on-surface">
                  max {String(poll.maxMs)}ms
                </span>
              </div>
            ))}
            {control.polls.length === POLL_COUNT && (
              <p data-testid="stall-control-verdict" className="text-caption text-on-surface">
                verdict: same 300ms of work, delivered as slices — the probe read{' '}
                {String(control.probe.eventLoopDelayMs)}ms (≈ one slice) and the histogram max did
                not move beyond the stall phase&apos;s{' '}
                {stall !== null && stall.polls.length > 0
                  ? String(stall.polls[stall.polls.length - 1]?.maxMs ?? 'earlier')
                  : 'earlier'}
                ms. Yielding the loop is the fix; the diagnosis was the map to it.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
