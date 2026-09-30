import { useState } from 'react';

/**
 * Demo for DemoBlock `node:event-loop` — fires the same 300ms of hash work at
 * two endpoints on this server, in parallel (deferred first, blocking second):
 * - GET /api/demo/node/blocking — one synchronous burst: the event loop
 *   stalls for the whole workload, and the response reports the measured stall
 * - GET /api/demo/node/deferred — the same work in ~10ms slices across
 *   setImmediate ticks: total time similar, stall stays tiny
 * Both requests run against one process with one event loop — the blocking
 * one's stall visibly delays its deferred neighbor's slices.
 */

const WORK_MS = 300;

type LoopMode = 'blocking' | 'deferred';

interface LoopResult {
  mode: LoopMode;
  workMs: number;
  eventLoopDelayMs: number;
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; blocking: LoopResult; deferred: LoopResult }
  | { kind: 'error'; message: string };

/** Pull the server's message out of the `{ error: { message } }` envelope. */
function envelopeMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
    }
  }
  return `Request failed with status ${status}.`;
}

type FetchOutcome = { ok: true; result: LoopResult } | { ok: false; message: string };

/** Fetches one mode; validates the payload shape before trusting it. */
async function fetchLoopResult(mode: LoopMode): Promise<FetchOutcome> {
  try {
    const response = await fetch(`/api/demo/node/${mode}?workMs=${WORK_MS}`, {
      headers: { accept: 'application/json' },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: envelopeMessage(body, response.status) };
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as { mode?: unknown }).mode === mode &&
      typeof (body as { workMs?: unknown }).workMs === 'number' &&
      typeof (body as { eventLoopDelayMs?: unknown }).eventLoopDelayMs === 'number'
    ) {
      return { ok: true, result: body as LoopResult };
    }
    return { ok: false, message: envelopeMessage(null, response.status) };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

const CELL = 'border-b border-outline px-xs py-xs';
const OVERLINE = 'text-overline font-semibold uppercase tracking-[0.08em] text-on-surface-variant';

function ResultRow({ result }: { result: LoopResult }) {
  return (
    <tr data-testid={`event-loop-row-${result.mode}`}>
      <td className={`${CELL} font-mono`}>{result.mode}</td>
      <td className={CELL}>{result.workMs} ms</td>
      <td className={`${CELL} font-mono`}>{Math.round(result.eventLoopDelayMs)} ms</td>
    </tr>
  );
}

export default function EventLoopDemo() {
  const [run, setRun] = useState<RunState>({ kind: 'idle' });

  const onRun = (): void => {
    setRun({ kind: 'busy' });
    // Deferred first, blocking second — both in flight together. On one event
    // loop the blocking run's stall also holds up the deferred slices; the
    // deferred request takes longer overall, but its own measured stall stays
    // at one slice. That asymmetry is the lesson.
    const deferred = fetchLoopResult('deferred');
    const blocking = fetchLoopResult('blocking');
    void Promise.all([deferred, blocking]).then(([deferredOutcome, blockingOutcome]) => {
      if (!deferredOutcome.ok) {
        setRun({ kind: 'error', message: deferredOutcome.message });
        return;
      }
      if (!blockingOutcome.ok) {
        setRun({ kind: 'error', message: blockingOutcome.message });
        return;
      }
      setRun({ kind: 'done', deferred: deferredOutcome.result, blocking: blockingOutcome.result });
    });
  };

  return (
    <div className="flex flex-col gap-md">
      <section className="flex flex-col gap-sm">
        <p className={OVERLINE}>
          Run 300ms of real hash work two ways — against this server, in parallel
        </p>
        <button
          type="button"
          data-testid="event-loop-run"
          onClick={onRun}
          disabled={run.kind === 'busy'}
          className="w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          {run.kind === 'busy' ? 'running the hash work…' : 'Run both for 300ms'}
        </button>

        {run.kind === 'error' && (
          <p data-testid="event-loop-error" role="alert" className="text-body-sm text-error">
            fail — {run.message}
          </p>
        )}

        {run.kind === 'done' && (
          <div data-testid="event-loop-results" className="flex flex-col gap-xs">
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="border-b border-outline px-xs py-xs font-semibold">mode</th>
                  <th className="border-b border-outline px-xs py-xs font-semibold">work</th>
                  <th className="border-b border-outline px-xs py-xs font-semibold">
                    measured loop stall
                  </th>
                </tr>
              </thead>
              <tbody className="text-on-surface">
                <ResultRow result={run.deferred} />
                <ResultRow result={run.blocking} />
              </tbody>
            </table>
            <p data-testid="event-loop-verdict" className="text-body-sm text-on-surface-variant">
              blocking froze the loop for {Math.round(run.blocking.eventLoopDelayMs)} ms — every
              other request on this process waited, including the deferred one you fired
              alongside it (which is why it finished late). Doing the same{' '}
              {run.deferred.workMs} ms of work in ~10 ms slices kept the measured stall down to{' '}
              {Math.round(run.deferred.eventLoopDelayMs)} ms. Same work; only one of the two is
              compatible with serving anyone else.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
