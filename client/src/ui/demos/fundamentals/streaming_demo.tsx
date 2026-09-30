import { useState } from 'react';

/**
 * Demo for DemoBlock `node:streaming` — downloads the same telemetry payload
 * two ways from GET /api/demo/node/stream:
 * - ?mode=buffered — the server builds the whole body, then sends it:
 *   Content-Length declares the exact size up front
 * - ?mode=stream — the server writes line by line with pauses between
 *   writes: chunked transfer encoding, no Content-Length, bytes flow as they
 *   are produced
 * The client measures its own elapsed time and reads the headers that make
 * the delivery contracts visible.
 */

const CHUNKS = 100;

type StreamMode = 'buffered' | 'stream';

interface StreamOutcome {
  mode: StreamMode;
  /** Client-observed wall time of fetch + reading the full body. */
  elapsedMs: number;
  /** Header value, or null when absent (stream mode sends none). */
  contentLength: string | null;
  streamModeHeader: string | null;
  /** Server-side prep time before the response could start (x-elapsed-ms header, raw string). */
  serverElapsedMs: string | null;
  lineCount: number;
  /** Approximate payload size — telemetry lines are ASCII, so chars ≈ bytes. */
  bytes: number;
}

type ModeState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; outcome: StreamOutcome }
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

type FetchOutcome = { ok: true; outcome: StreamOutcome } | { ok: false; message: string };

async function fetchStreamOutcome(mode: StreamMode): Promise<FetchOutcome> {
  try {
    const startedAt = performance.now();
    const response = await fetch(`/api/demo/node/stream?mode=${mode}&chunks=${CHUNKS}`, {
      headers: { accept: 'application/x-ndjson' },
    });
    const text = await response.text();
    const elapsedMs = performance.now() - startedAt;

    if (!response.ok) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { ok: false, message: envelopeMessage(parsed, response.status) };
    }

    return {
      ok: true,
      outcome: {
        mode,
        elapsedMs: Math.round(elapsedMs * 10) / 10,
        contentLength: response.headers.get('content-length'),
        streamModeHeader: response.headers.get('x-stream-mode'),
        serverElapsedMs: response.headers.get('x-elapsed-ms'),
        lineCount: text.split('\n').filter((line) => line !== '').length,
        bytes: text.length,
      },
    };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

const CELL = 'border-b border-outline px-xs py-xs';
const OVERLINE = 'text-overline font-semibold uppercase tracking-[0.08em] text-on-surface-variant';

function OutcomeRows({ outcome }: { outcome: StreamOutcome }) {
  return (
    <tbody className="text-on-surface">
      <tr>
        <td className={CELL}>client-observed elapsed</td>
        <td data-testid="streaming-elapsed" className={`${CELL} font-mono`}>
          {outcome.elapsedMs} ms
        </td>
      </tr>
      <tr>
        <td className={CELL}>content-length</td>
        <td className={`${CELL} font-mono`}>
          {outcome.contentLength === null ? 'not sent' : `${outcome.contentLength} bytes`}
        </td>
      </tr>
      <tr>
        <td className={CELL}>x-stream-mode</td>
        <td className={`${CELL} font-mono`}>{outcome.streamModeHeader ?? 'not sent'}</td>
      </tr>
      <tr>
        <td className={CELL}>server prep (x-elapsed-ms)</td>
        <td className={`${CELL} font-mono`}>
          {outcome.serverElapsedMs === null ? 'not sent' : `${outcome.serverElapsedMs} ms`}
        </td>
      </tr>
      <tr>
        <td className={CELL}>body</td>
        <td className={`${CELL} font-mono`}>
          {outcome.lineCount} lines ≈ {outcome.bytes} bytes
        </td>
      </tr>
    </tbody>
  );
}

function ModePanel({
  mode,
  state,
  onRun,
}: {
  mode: StreamMode;
  state: ModeState;
  onRun: () => void;
}) {
  const label =
    mode === 'buffered' ? 'buffered — build it all, then send' : 'stream — send as produced';
  return (
    <section className="flex flex-col gap-xs">
      <p className={OVERLINE}>{label}</p>
      <button
        type="button"
        data-testid={`streaming-run-${mode}`}
        onClick={onRun}
        disabled={state.kind === 'busy'}
        className="w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
      >
        {state.kind === 'busy' ? 'downloading…' : `download ${CHUNKS} lines (${mode})`}
      </button>

      {state.kind === 'error' && (
        <p data-testid={`streaming-error-${mode}`} role="alert" className="text-body-sm text-error">
          fail — {state.message}
        </p>
      )}

      {state.kind === 'done' && (
        <table
          data-testid={`streaming-result-${mode}`}
          className="w-full border-collapse text-body-sm"
        >
          <OutcomeRows outcome={state.outcome} />
        </table>
      )}
    </section>
  );
}

export default function StreamingDemo() {
  const [buffered, setBuffered] = useState<ModeState>({ kind: 'idle' });
  const [streamed, setStreamed] = useState<ModeState>({ kind: 'idle' });

  const runMode = (mode: StreamMode, setState: (state: ModeState) => void): void => {
    setState({ kind: 'busy' });
    void fetchStreamOutcome(mode).then((fetchOutcome) => {
      setState(
        fetchOutcome.ok
          ? { kind: 'done', outcome: fetchOutcome.outcome }
          : { kind: 'error', message: fetchOutcome.message },
      );
    });
  };

  const bothDone =
    buffered.kind === 'done' && streamed.kind === 'done'
      ? { buffered: buffered.outcome, streamed: streamed.outcome }
      : null;

  return (
    <div className="flex flex-col gap-md">
      <div className="grid grid-cols-1 gap-md lg:grid-cols-2">
        <ModePanel
          mode="buffered"
          state={buffered}
          onRun={() => runMode('buffered', setBuffered)}
        />
        <ModePanel mode="stream" state={streamed} onRun={() => runMode('stream', setStreamed)} />
      </div>

      {bothDone !== null && (
        <p data-testid="streaming-verdict" className="text-body-sm text-on-surface-variant">
          Same {bothDone.buffered.lineCount} lines, ≈{bothDone.buffered.bytes} bytes, both ways.
          Buffered declared its full size up front (content-length{' '}
          {bothDone.buffered.contentLength ?? '—'} bytes) but could only start once the whole body
          existed. Streamed sent no content-length — the first line left immediately and the rest
          followed chunk by chunk, which is how a server moves payloads far larger than its memory.
        </p>
      )}
    </div>
  );
}
