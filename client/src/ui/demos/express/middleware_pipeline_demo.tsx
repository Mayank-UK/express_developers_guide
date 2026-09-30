import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `middleware:pipeline` — the middleware topic's
 * pipeline-order visualizer. The server runs a real route-level stack
 * (logger → auth → validator → handler) where every layer stamps a trace
 * entry relative to the first middleware's clock, and exposes it three ways:
 *
 * - GET /api/demo/middleware/pipeline — 200; the trace rides the BODY
 *   ({ pipeline, stages, note }) and the x-pipeline header alike.
 * - GET /api/demo/middleware/short-circuit — 401; the auth layer answers
 *   itself and never calls next(), so the error envelope owns the body and
 *   the truncated trace (logger, auth, short-circuit) rides the HEADER.
 * - GET /api/demo/middleware/error-path — 500; the async handler throws, a
 *   4-arg error middleware appends 'error-handler' and rethrows, and the
 *   global error handler renders the envelope — trace again via the HEADER.
 *
 * This component reads whichever trace it can (body first, header second)
 * and lights exactly the cards whose labels appear in it — the lighting is
 * derived from the data, never from which button was pressed.
 */

const DEMO_BASE = '/api/demo/middleware';

/** One recorded pipeline step; elapsedMs is relative to the first middleware. */
interface PipelineStage {
  stage: number;
  label: string;
  elapsedMs: number;
}

type RunId = 'happy' | 'short-circuit' | 'error-path';

interface RunSpec {
  id: RunId;
  url: string;
  buttonLabel: string;
  verdict: string;
}

const RUNS: readonly RunSpec[] = [
  {
    id: 'happy',
    url: `${DEMO_BASE}/pipeline`,
    buttonLabel: 'run the happy path',
    verdict:
      'every layer called next() — the handler at the bottom of the stack answered the request itself',
  },
  {
    id: 'short-circuit',
    url: `${DEMO_BASE}/short-circuit`,
    buttonLabel: 'run the short-circuit',
    verdict: 'the auth layer responded itself — nothing after it ran',
  },
  {
    id: 'error-path',
    url: `${DEMO_BASE}/error-path`,
    buttonLabel: 'run the error path',
    verdict:
      'the async handler threw — the 4-arg error middleware annotated the trace and rethrew, and the global error handler rendered the envelope',
  },
];

/**
 * The five display slots, in registration order — the same order the server
 * stamps stage numbers. 'error-handler' is the 4-arg machinery that sits
 * AFTER the routes; it renders dashed until a run actually reaches it.
 */
const STAGE_SLOTS = [
  { label: 'logger', kind: 'flow' },
  { label: 'auth', kind: 'flow' },
  { label: 'validator', kind: 'flow' },
  { label: 'handler', kind: 'flow' },
  { label: 'error-handler', kind: 'error' },
] as const;

type SlotKind = (typeof STAGE_SLOTS)[number]['kind'];

const SLOT_LABELS: ReadonlySet<string> = new Set(STAGE_SLOTS.map((slot) => slot.label));

/** Client-side payload validation before use (the API layer's house rule). */
function parseStages(value: unknown): PipelineStage[] | null {
  if (!Array.isArray(value)) return null;
  const stages: PipelineStage[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.stage !== 'number' ||
      typeof candidate.label !== 'string' ||
      typeof candidate.elapsedMs !== 'number'
    ) {
      return null;
    }
    stages.push({ stage: candidate.stage, label: candidate.label, elapsedMs: candidate.elapsedMs });
  }
  return stages;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * The x-pipeline header, tolerated leniently: header objects are read via
 * get() only, so minimal test doubles without a Headers instance still work.
 */
function readPipelineHeader(response: Response): string | null {
  const headers: unknown = response.headers;
  if (headers === null || headers === undefined) return null;
  const get: unknown = (headers as { get?: unknown }).get;
  if (typeof get !== 'function') return null;
  const value: unknown = (headers as { get: (name: string) => unknown }).get('x-pipeline');
  return typeof value === 'string' ? value : null;
}

function statusLabel(status: number): string {
  const labels: Record<number, string> = {
    200: 'OK',
    401: 'Unauthorized',
    500: 'Internal Server Error',
  };
  return labels[status] ?? '';
}

interface RunOutcome {
  url: string;
  status: number;
  statusLabel: string;
  verdict: string;
  bodyPreview: string;
  trace: readonly PipelineStage[];
  traceSource: 'body' | 'header' | 'none';
}

type FireResult = { ok: true; outcome: RunOutcome } | { ok: false; message: string };

async function fireRun(spec: RunSpec): Promise<FireResult> {
  try {
    const response = await fetch(spec.url, { method: 'GET', headers: { accept: 'application/json' } });
    const text = await response.text();

    const parsed = tryParseJson(text);
    const bodyPreview =
      parsed.ok ? JSON.stringify(parsed.value, null, 2) : text === '' ? '(empty body)' : text;

    // Body first (the happy path carries the trace there); header second (the
    // failure paths' bodies belong to the error envelope, so the truncated
    // trace travels in x-pipeline instead).
    let trace: PipelineStage[] | null = null;
    let traceSource: RunOutcome['traceSource'] = 'none';
    if (parsed.ok) {
      const raw = parsed.value;
      const pipeline =
        typeof raw === 'object' && raw !== null ? (raw as { pipeline?: unknown }).pipeline : undefined;
      const bodyTrace = parseStages(pipeline);
      if (bodyTrace !== null) {
        trace = bodyTrace;
        traceSource = 'body';
      }
    }
    if (trace === null) {
      const headerRaw = readPipelineHeader(response);
      if (headerRaw !== null) {
        const headerParsed = tryParseJson(headerRaw);
        if (headerParsed.ok) {
          const headerTrace = parseStages(headerParsed.value);
          if (headerTrace !== null) {
            trace = headerTrace;
            traceSource = 'header';
          }
        }
      }
    }

    return {
      ok: true,
      outcome: {
        url: spec.url,
        status: response.status,
        statusLabel: statusLabel(response.status),
        verdict: spec.verdict,
        bodyPreview,
        trace: trace ?? [],
        traceSource,
      },
    };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; url: string }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; outcome: RunOutcome };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const ERROR = 'text-body-sm text-error';

function formatElapsed(ms: number): string {
  return `+${ms.toFixed(1)} ms`;
}

interface StageCardProps {
  label: string;
  kind: SlotKind;
  entry: PipelineStage | undefined;
  /** Canonical stage number, shown when the layer never ran. */
  position: number;
}

/** One stage card: filled with the token accent when it ran, muted when not. */
function StageCard({ label, kind, entry, position }: StageCardProps): ReactNode {
  const ran = entry !== undefined;
  const cardClass = ran
    ? kind === 'error'
      ? 'rounded-md border border-outline bg-error px-sm py-xs text-center text-on-error'
      : 'rounded-md border border-outline bg-primary px-sm py-xs text-center text-on-primary'
    : kind === 'error'
      ? 'rounded-md border border-dashed border-outline bg-surface px-sm py-xs text-center text-on-surface-variant'
      : 'rounded-md border border-outline bg-surface px-sm py-xs text-center text-on-surface-variant';
  const caption = ran
    ? `stage ${String(entry.stage)} · ${formatElapsed(entry.elapsedMs)}`
    : `stage ${String(position)} · not run`;
  return (
    <div data-testid={`mw-pipeline-stage-${label}`} className={cardClass}>
      <span className="block font-mono font-semibold">{label}</span>
      <span className="block font-mono text-caption">{caption}</span>
    </div>
  );
}

/** The raw outcome panel: status line, plain-words verdict, pretty body. */
function RunOutcomePanel({ outcome }: { outcome: RunOutcome }): ReactNode {
  const sourceNote =
    outcome.traceSource === 'body'
      ? 'trace read from the response body'
      : outcome.traceSource === 'header'
        ? 'trace read from the x-pipeline response header — the body belongs to the error envelope'
        : 'no pipeline trace found in the body or the x-pipeline header';
  return (
    <div data-testid="mw-pipeline-result" className="flex flex-col gap-xs">
      <p data-testid="mw-pipeline-status" className="text-body-sm text-on-surface">
        <span className="font-mono font-semibold">{String(outcome.status)}</span>
        {outcome.statusLabel !== '' && ` ${outcome.statusLabel}`} — GET{' '}
        <span className="font-mono break-all">{outcome.url}</span>
      </p>
      <p data-testid="mw-pipeline-verdict" className="text-body-sm text-on-surface">
        {outcome.verdict}.
      </p>
      <p data-testid="mw-pipeline-trace-source" className="text-body-sm text-on-surface-variant">
        {sourceNote}.
      </p>
      <pre
        data-testid="mw-pipeline-body"
        className="max-h-80 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all"
      >
        {outcome.bodyPreview}
      </pre>
    </div>
  );
}

export default function MiddlewarePipelineDemo() {
  const [runState, setRunState] = useState<RunState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  // No setState after unmount when a slow fetch outlives the component.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = (spec: RunSpec): void => {
    setRunState({ kind: 'running', url: spec.url });
    void fireRun(spec).then((result) => {
      if (!aliveRef.current) return;
      if (result.ok) setRunState({ kind: 'done', outcome: result.outcome });
      else setRunState({ kind: 'failed', message: result.message });
    });
  };

  const trace: readonly PipelineStage[] = runState.kind === 'done' ? runState.outcome.trace : [];
  const entryByLabel = new Map(trace.map((stage) => [stage.label, stage]));
  // Trace labels outside the five flow slots — the recorded exit itself
  // ('short-circuit'), proving where the chain stopped.
  const exits = trace.filter((stage) => !SLOT_LABELS.has(stage.label));

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="mw-pipeline-summary" className="text-body-sm text-on-surface">
        Three runs of the same real stack —{' '}
        <span className="font-mono">logger → auth → validator → handler</span>. Each layer stamps
        the trace as it runs, so a card lights only when its layer actually executed; a layer that
        answers the request itself (or never gets the chance) leaves everything after it dark.
      </p>

      <div className="flex flex-wrap gap-xs">
        {RUNS.map((spec) => (
          <button
            key={spec.id}
            type="button"
            data-testid={`mw-pipeline-run-${spec.id}`}
            title={`GET ${spec.url}`}
            onClick={() => run(spec)}
            disabled={runState.kind === 'running'}
            className={BUTTON}
          >
            {runState.kind === 'running' && runState.url === spec.url
              ? 'running…'
              : spec.buttonLabel}
          </button>
        ))}
      </div>

      {runState.kind === 'running' && (
        <p data-testid="mw-pipeline-loading" className="text-body-sm text-on-surface-variant">
          running <span className="font-mono">GET {runState.url}</span>…
        </p>
      )}
      {runState.kind === 'failed' && (
        <p data-testid="mw-pipeline-error" role="alert" className={ERROR}>
          fail — {runState.message}
        </p>
      )}

      <div data-testid="mw-pipeline-flow" className="flex flex-wrap items-center gap-xs">
        {STAGE_SLOTS.map((slot, index) => (
          <Fragment key={slot.label}>
            {index > 0 && (
              <span aria-hidden="true" className="text-on-surface-variant">
                →
              </span>
            )}
            <StageCard
              label={slot.label}
              kind={slot.kind}
              entry={entryByLabel.get(slot.label)}
              position={index + 1}
            />
          </Fragment>
        ))}
      </div>

      {exits.length > 0 && (
        <p data-testid="mw-pipeline-exit" className="text-body-sm text-on-surface-variant">
          chain exit recorded:{' '}
          {exits.map((exit) => `${exit.label} (stage ${String(exit.stage)})`).join(', ')} — the
          response left the stack there.
        </p>
      )}

      {runState.kind === 'idle' && (
        <p data-testid="mw-pipeline-idle" className="text-body-sm text-on-surface-variant">
          No run yet — fire one of the three runs above to light the chain.
        </p>
      )}

      {runState.kind === 'done' && <RunOutcomePanel outcome={runState.outcome} />}
    </div>
  );
}
