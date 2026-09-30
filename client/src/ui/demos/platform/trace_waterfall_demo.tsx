import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `obs:trace` — the observability topic's tracing surface
 * over the real endpoints (obs_demo_routes.ts + core/logging/trace_context.ts):
 *
 * 1. RUN A TRACED REQUEST — POST /trace/run makes the server do REAL traced
 *    work (route handler → usecase → sqlite step → traced job enqueue, plus
 *    the queue worker's span under the PROPAGATED traceparent — one traceId
 *    across the HTTP request and the background job). The response carries
 *    the traceId (also visible in its traceparent), the requestId beside it
 *    (the coexistence lesson), and the span tree.
 * 2. THE WATERFALL — the tree rendered as nested rows: parent/child nesting
 *    by indentation, each span's name, duration, and status (ok / error /
 *    open). The root span is still OPEN in the run response — it closes when
 *    the response finishes.
 * 3. REFETCH — GET /trace/spans?traceId= re-reads the ring for the SAME
 *    trace: the root settles with its real duration, exactly what a trace
 *    viewer shows after the fact. The ring is a 500-span window — traces age
 *    out, and the 404 envelope for an unknown id is a first-class state.
 */

const TRACE_RUN_URL = '/api/demo/obs/trace/run';

const traceSpansUrl = (traceId: string): string =>
  `/api/demo/obs/trace/spans?traceId=${traceId}`;

/** The ring's span record, as the wire serves it. */
interface SpanView {
  spanId: string;
  name: string;
  parentId: string | null;
  startedAtMs: number;
  durationMs: number | null;
  status: 'open' | 'ok' | 'error';
}

interface SpanTreeNodeView {
  span: SpanView;
  children: SpanTreeNodeView[];
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; traceId: string; requestId: string; traceparent: string | null; tree: SpanTreeNodeView[] }
  | { kind: 'failed'; problem: string };

type SpansState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; spanCount: number; tree: SpanTreeNodeView[] }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') return response.text();
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

function errorEnvelopeFromText(text: string): string {
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const error = (parsed.value as Record<string, unknown>).error;
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return `${record.code}: ${record.message}`;
    }
  }
  return text;
}

/** One fetch, one body read — { status, bodyText }. */
async function fetchOnce(url: string, init?: RequestInit): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(url, init);
  return { status: response.status, bodyText: await readBodyText(response) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSpan(raw: unknown): SpanView | null {
  if (
    !isRecord(raw) ||
    typeof raw.spanId !== 'string' ||
    typeof raw.name !== 'string' ||
    (raw.parentId !== null && typeof raw.parentId !== 'string') ||
    typeof raw.startedAtMs !== 'number' ||
    (raw.durationMs !== null && typeof raw.durationMs !== 'number') ||
    (raw.status !== 'open' && raw.status !== 'ok' && raw.status !== 'error')
  ) {
    return null;
  }
  return {
    spanId: raw.spanId,
    name: raw.name,
    parentId: (raw.parentId as string | null) ?? null,
    startedAtMs: raw.startedAtMs,
    durationMs: (raw.durationMs as number | null) ?? null,
    status: raw.status,
  };
}

/** Recursive, guarded — a malformed node is dropped, its children with it. */
function parseTree(raw: unknown): SpanTreeNodeView[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.tree)) return null;
  const walk = (node: unknown): SpanTreeNodeView | null => {
    if (!isRecord(node)) return null;
    const span = parseSpan(node.span);
    if (span === null) return null;
    const children = Array.isArray(node.children)
      ? node.children.map(walk).filter((child): child is SpanTreeNodeView => child !== null)
      : [];
    return { span, children };
  };
  const roots = raw.tree.map(walk).filter((node): node is SpanTreeNodeView => node !== null);
  return roots.length > 0 ? roots : null;
}

/** ms formatted for a row: up to 3 decimals, trailing zeros trimmed. */
function formatMs(ms: number): string {
  return `${String(Math.round(ms * 1000) / 1000)}ms`;
}

/** The slowest CLOSED span in the tree — the scale the bars divide by. */
function maxDurationMs(roots: readonly SpanTreeNodeView[]): number {
  let max = 0;
  const walk = (node: SpanTreeNodeView): void => {
    if (node.span.durationMs !== null && node.span.durationMs > max) max = node.span.durationMs;
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return max;
}

export default function TraceWaterfallDemo(): ReactNode {
  const [runState, setRunState] = useState<RunState>({ kind: 'idle' });
  const [spansState, setSpansState] = useState<SpansState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const runTracedRequest = (): void => {
    setRunState({ kind: 'loading' });
    setSpansState({ kind: 'idle' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(TRACE_RUN_URL, { method: 'POST' });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setRunState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
        const tree = record !== null ? parseTree(record) : null;
        if (
          record === null ||
          typeof record.traceId !== 'string' ||
          typeof record.requestId !== 'string' ||
          tree === null
        ) {
          setRunState({ kind: 'failed', problem: 'unexpected trace-run payload' });
          return;
        }
        setRunState({
          kind: 'ready',
          traceId: record.traceId,
          requestId: record.requestId,
          traceparent:
            typeof record.traceparent === 'string' ? record.traceparent : null,
          tree,
        });
      } catch {
        if (aliveRef.current) setRunState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const refetchSpans = (traceId: string): void => {
    setSpansState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(traceSpansUrl(traceId));
        if (!aliveRef.current) return;
        if (status >= 400) {
          setSpansState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
        const tree = record !== null ? parseTree(record) : null;
        if (record === null || typeof record.spanCount !== 'number' || tree === null) {
          setSpansState({ kind: 'failed', problem: 'unexpected spans payload' });
          return;
        }
        setSpansState({ kind: 'ready', spanCount: record.spanCount, tree });
      } catch {
        if (aliveRef.current) setSpansState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const activeTree =
    spansState.kind === 'ready'
      ? spansState.tree
      : runState.kind === 'ready'
        ? runState.tree
        : null;
  const treeSource = spansState.kind === 'ready' ? 'spans' : 'run';

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="trace-summary" className="text-body-sm text-on-surface">
        Distributed tracing on real work: one click runs a traced request — route handler, usecase,
        sqlite step, a job enqueue and the queue worker&apos;s span under the PROPAGATED
        traceparent — and renders the span tree as a waterfall. Same traceId across the HTTP
        request and the background job; the requestId beside it correlates log lines within this
        process only.
      </p>

      {/* 1 — run + identity */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="trace-run-button"
            onClick={runTracedRequest}
            disabled={runState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            {runState.kind === 'loading' ? 'running the traced request…' : 'run traced request'}
          </button>
          <button
            type="button"
            data-testid="trace-refetch-button"
            onClick={() => {
              if (runState.kind === 'ready') refetchSpans(runState.traceId);
            }}
            disabled={runState.kind !== 'ready' || spansState.kind === 'loading'}
            className={BUTTON}
          >
            {spansState.kind === 'loading' ? 'refetching…' : 'refetch spans'}
          </button>
          <span className="text-caption text-on-surface-variant">
            the refetch re-reads the ring for the SAME traceId — the root span settles with its
            real duration
          </span>
        </div>

        {runState.kind === 'idle' && (
          <p data-testid="trace-idle" className="text-caption text-on-surface-variant">
            no trace yet — press the button and this panel fills with the request&apos;s own spans
          </p>
        )}
        {runState.kind === 'failed' && (
          <pre data-testid="trace-error" className={PRE}>
            {runState.problem}
          </pre>
        )}

        {runState.kind === 'ready' && (
          <div data-testid="trace-run-result" className="flex flex-col gap-xxs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className="text-on-surface-variant">traceId</span>
              <span data-testid="trace-id-chip" className="break-all font-semibold text-on-surface">
                {runState.traceId}
              </span>
            </p>
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span data-testid="trace-request-chip" className={CHIP}>
                requestId {runState.requestId}
              </span>
              <span className="text-on-surface-variant">
                one log line&apos;s correlation id vs the whole trace&apos;s identity
              </span>
            </p>
            {runState.traceparent !== null && (
              <p className="flex flex-col gap-xxs font-mono text-caption text-on-surface-variant">
                traceparent (version-traceid-parentid-flags)
                <code data-testid="trace-traceparent" className="break-all text-on-surface">
                  {runState.traceparent}
                </code>
              </p>
            )}
          </div>
        )}

        {spansState.kind === 'failed' && (
          <pre data-testid="trace-spans-failed" className={PRE}>
            {spansState.problem}
          </pre>
        )}
      </section>

      {/* 2 — the waterfall */}
      {activeTree !== null && (
        <section data-testid="trace-waterfall" className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">The waterfall</h3>
            {spansState.kind === 'ready' && (
              <span data-testid="trace-count-chip" className={CHIP}>
                {String(spansState.spanCount)} spans · from /trace/spans
              </span>
            )}
            {treeSource === 'run' && (
              <span className={CHIP}>from the run response — root still open</span>
            )}
          </div>
          <div className="flex flex-col gap-xxs">
            {activeTree.map((node) => (
              <WaterfallNode key={node.span.spanId} node={node} maxMs={maxDurationMs(activeTree)} />
            ))}
          </div>
          <p className="text-caption text-on-surface-variant">
            nesting = parent/child (each child&apos;s parent-id names the span that caused it);
            bars scale against the slowest span; the worker&apos;s span hangs under the enqueue
            span because its traceparent was carried in the JOB PAYLOAD — context propagation
            across a process boundary.
          </p>
        </section>
      )}
    </div>
  );
}

/** One waterfall row + its indented children. */
function WaterfallNode({ node, maxMs }: { node: SpanTreeNodeView; maxMs: number }): ReactNode {
  const { span } = node;
  const width =
    span.durationMs === null || maxMs <= 0
      ? 0
      : Math.max((span.durationMs / maxMs) * 100, span.durationMs > 0 ? 2 : 0.5);
  return (
    <div className="flex flex-col gap-xxs">
      <div data-testid="trace-span-row" className="flex flex-col gap-xxs rounded-md border border-outline p-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-sm">
          <span className="break-all font-mono text-caption font-semibold text-on-surface">
            {span.name}
          </span>
          <span className="flex flex-wrap items-center gap-xxs">
            {span.status === 'ok' && <span data-testid="trace-span-status" className={CHIP_OK}>ok</span>}
            {span.status === 'error' && <span data-testid="trace-span-status" className={CHIP_ERROR}>error</span>}
            {span.status === 'open' && <span data-testid="trace-span-status" className={CHIP}>open</span>}
            <span className="font-mono text-caption text-on-surface-variant">
              {span.durationMs === null
                ? '— settles when the response finishes'
                : formatMs(span.durationMs)}
            </span>
          </span>
        </div>
        <div className="h-xxs w-full rounded bg-surface-variant">
          <div
            data-testid="trace-span-bar"
            className="h-xxs rounded bg-primary"
            style={{ width: `${String(Math.min(100, width))}%` }}
          />
        </div>
      </div>
      {node.children.length > 0 && (
        <div data-testid="trace-span-children" className="ml-sm flex flex-col gap-xxs">
          {node.children.map((child) => (
            <WaterfallNode key={child.span.spanId} node={child} maxMs={maxMs} />
          ))}
        </div>
      )}
    </div>
  );
}
