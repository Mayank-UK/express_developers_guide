import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `arch:tracer` — the architecture topic's live surface.
 *
 * 1. THE TRACER — a "trace a request" button fires GET /api/demo/arch/trace;
 *    the server handles THAT request as the specimen, running the real
 *    pipeline (request-id middleware → thin controller → the container's REAL
 *    postsUseCase.list()) with timings at each hop. Rendered as a vertical
 *    layer timeline: six cards in order, bars scaled to the slowest hop, mode
 *    + requestId chips, total line. HONESTY is part of the contract: the
 *    use-case bar includes the repository call; the selector bar is that same
 *    store read re-timed in isolation; the repository bar is derived — every
 *    card's note says what it actually measured.
 * 2. THE FOLDER MAP — GET /api/demo/arch/folders walks the RUNNING server's
 *    own src/ tree at request time (three levels). Top-level directories
 *    expand one level, each with its hand-kept purpose line — the map is
 *    live, not a stale diagram.
 *
 * Lives in demos/platform/ beside the env inspector and the error explorer.
 */

const TRACE_URL = '/api/demo/arch/trace';
const FOLDERS_URL = '/api/demo/arch/folders';

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

interface TraceLayer {
  layer: string;
  ms: number;
  note: string;
}

interface TracePayload {
  trace: TraceLayer[];
  totalMs: number;
  mode: 'fake' | 'live';
  injectFailure: boolean;
  postCount: number;
  requestId: string;
  failure?: { kind: string; message: string };
}

interface FolderNode {
  name: string;
  kind: 'dir' | 'file';
  children?: FolderNode[];
}

interface FoldersPayload {
  root: string;
  truncated: boolean;
  purposes: Record<string, string>;
  tree: FolderNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Guarded wire reads — a malformed payload degrades, never crashes. */
function parseTrace(raw: unknown): TracePayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.trace)) return null;
  const layers = raw.trace.filter(
    (entry): entry is TraceLayer =>
      isRecord(entry) &&
      typeof entry.layer === 'string' &&
      typeof entry.ms === 'number' &&
      Number.isFinite(entry.ms) &&
      typeof entry.note === 'string',
  );
  if (layers.length === 0) return null;
  if (typeof raw.totalMs !== 'number' || !Number.isFinite(raw.totalMs)) return null;
  if (raw.mode !== 'fake' && raw.mode !== 'live') return null;
  if (typeof raw.injectFailure !== 'boolean') return null;
  if (typeof raw.postCount !== 'number') return null;
  if (typeof raw.requestId !== 'string' || raw.requestId === '') return null;
  const failureRaw = raw.failure;
  const failure =
    isRecord(failureRaw) && typeof failureRaw.kind === 'string' && typeof failureRaw.message === 'string'
      ? { kind: failureRaw.kind, message: failureRaw.message }
      : undefined;
  return {
    trace: layers,
    totalMs: raw.totalMs,
    mode: raw.mode,
    injectFailure: raw.injectFailure,
    postCount: raw.postCount,
    requestId: raw.requestId,
    failure,
  };
}

function parseFolders(raw: unknown): FoldersPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.tree)) return null;
  if (typeof raw.root !== 'string' || typeof raw.truncated !== 'boolean') return null;
  if (!isRecord(raw.purposes)) return null;
  const purposes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.purposes)) {
    if (typeof value !== 'string') return null;
    purposes[key] = value;
  }
  const tree = raw.tree.filter((node): node is FolderNode => isRecord(node) && typeof node.name === 'string' && (node.kind === 'dir' || node.kind === 'file'));
  if (tree.length === 0) return null;
  return { root: raw.root, truncated: raw.truncated, purposes, tree };
}

/** ms formatted for the card: up to 3 decimals, trailing zeros trimmed. */
function formatMs(ms: number): string {
  return `${String(Math.round(ms * 1000) / 1000)}ms`;
}

export default function ArchTracerDemo(): ReactNode {
  // --- the tracer ---
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [running, setRunning] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  // --- the folder map ---
  const [folders, setFolders] = useState<FoldersPayload | null>(null);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runTrace = useCallback(async (): Promise<void> => {
    setRunning(true);
    setTraceError(null);
    try {
      const response = await fetch(TRACE_URL);
      if (!mounted.current) return;
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const parsed = parseTrace(await response.json());
      if (!mounted.current) return;
      if (parsed === null) throw new Error('malformed trace payload');
      setTrace(parsed);
    } catch {
      if (mounted.current) {
        setTraceError('the tracer could not reach the server — is it running?');
      }
    } finally {
      if (mounted.current) setRunning(false);
    }
  }, []);

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const response = await fetch(FOLDERS_URL);
        if (!mounted.current) return;
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const parsed = parseFolders(await response.json());
        if (!mounted.current) return;
        if (parsed === null) throw new Error('malformed folders payload');
        setFolders(parsed);
      } catch {
        if (mounted.current) {
          setFoldersError('the folder map is unavailable — this build may not ship the source tree');
        }
      }
    })();
  }, []);

  const toggleDir = useCallback((name: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const maxLayerMs = trace === null ? 0 : Math.max(...trace.trace.map((entry) => entry.ms));

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="arch-summary" className="text-body-sm text-on-surface">
        One request, six layers, real timings. The server handles{' '}
        <span className="font-mono">GET /api/demo/arch/trace</span> by timing ITS OWN journey
        through the pipeline — the same <code className="font-mono">postsUseCase.list()</code> GET
        /api/posts runs — then reports each hop. The repository bars are honest sub-spans of the
        use-case call; every card says what it measured.
      </p>

      {/* ---- panel 1: the tracer ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">1 · the request-flow tracer</span>
          <span className={CHIP}>{TRACE_URL}</span>
        </div>
        <button
          type="button"
          data-testid="arch-run-button"
          className={BUTTON_PRIMARY}
          onClick={() => void runTrace()}
          disabled={running}
        >
          {running ? 'tracing…' : 'trace a request'}
        </button>

        {traceError !== null && (
          <p data-testid="arch-error" className="text-caption text-error">
            {traceError}
          </p>
        )}

        {trace === null && traceError === null && (
          <p data-testid="arch-idle" className="text-body-sm text-on-surface-variant">
            press the button — the trace below will be THIS console&apos;s own request.
          </p>
        )}

        {trace !== null && (
          <>
            <div className="flex flex-wrap items-center gap-xs">
              <span data-testid="arch-mode-chip" className={CHIP_STRONG}>
                mode: {trace.mode}
              </span>
              {trace.injectFailure && <span className={CHIP}>failure injection ON</span>}
              <span className={CHIP}>posts: {String(trace.postCount)}</span>
              <span data-testid="arch-request-chip" className={CHIP} title="this trace's own request id">
                request: {trace.requestId.slice(0, 13)}…
              </span>
            </div>

            <div data-testid="arch-layers" className="flex flex-col gap-xs">
              {trace.trace.map((entry) => {
                const width = maxLayerMs <= 0 ? 0 : Math.max((entry.ms / maxLayerMs) * 100, entry.ms > 0 ? 2 : 0.5);
                return (
                  <div
                    key={entry.layer}
                    data-testid="arch-layer-card"
                    className="flex flex-col gap-xxs rounded-md border border-outline p-xs"
                  >
                    <div className="flex items-baseline justify-between gap-sm">
                      <span className="font-mono text-caption font-semibold text-on-surface">
                        {entry.layer}
                      </span>
                      <span className="font-mono text-caption text-on-surface-variant">
                        {formatMs(entry.ms)}
                      </span>
                    </div>
                    <div className="h-xxs w-full rounded bg-surface-variant">
                      <div
                        data-testid="arch-layer-bar"
                        className="h-xxs rounded bg-primary"
                        style={{ width: `${String(Math.min(100, width))}%` }}
                      />
                    </div>
                    <span className="text-caption text-on-surface-variant">{entry.note}</span>
                  </div>
                );
              })}
            </div>

            <p data-testid="arch-total" className="font-mono text-caption text-on-surface">
              total: {formatMs(trace.totalMs)} — requestId {trace.requestId} matches this
              response&apos;s x-request-id header
            </p>

            {trace.failure !== undefined && (
              <p data-testid="arch-failure" className="text-caption text-error">
                the domain gate fired: {trace.failure.kind} — {trace.failure.message}
              </p>
            )}
          </>
        )}
      </section>

      {/* ---- panel 2: the live folder map ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">2 · the folder map, live</span>
          <span className={CHIP}>{FOLDERS_URL}</span>
          <span className="text-caption text-on-surface-variant">
            walked from the running server&apos;s own source tree at request time
          </span>
        </div>

        {foldersError !== null && (
          <p data-testid="arch-folders-error" className="text-caption text-error">
            {foldersError}
          </p>
        )}

        {folders === null && foldersError === null && (
          <p data-testid="arch-folders-loading" className="text-body-sm text-on-surface-variant">
            walking server/src…
          </p>
        )}

        {folders !== null && (
          <div data-testid="arch-tree" className="flex flex-col gap-xxs">
            <p className="font-mono text-caption text-on-surface-variant">{folders.root}</p>
            {folders.tree
              .filter((node) => node.kind === 'dir')
              .map((node) => {
                const isOpen = expanded.has(node.name);
                const purpose = folders.purposes[node.name];
                return (
                  <div key={node.name} className="flex flex-col gap-xxs">
                    <div className="flex flex-wrap items-center gap-xs">
                      <button
                        type="button"
                        data-testid="arch-tree-expand"
                        aria-expanded={isOpen}
                        onClick={() => toggleDir(node.name)}
                        className="rounded border border-outline px-xxs font-mono text-caption text-on-surface hover:bg-surface-variant"
                      >
                        {isOpen ? '−' : '+'}
                      </button>
                      <span data-testid="arch-tree-dir" className="font-mono text-caption font-semibold text-on-surface">
                        {node.name}/
                      </span>
                      {purpose !== undefined && (
                        <span data-testid="arch-purpose" className="text-caption text-on-surface-variant">
                          {purpose}
                        </span>
                      )}
                      {purpose === undefined && (
                        <span className="text-caption text-on-surface-variant">
                          ({String(node.children?.length ?? 0)} entries)
                        </span>
                      )}
                    </div>
                    {isOpen && (
                      <div className="ml-sm flex flex-col gap-xxs" data-testid="arch-tree-children">
                        {(node.children ?? []).map((child) => (
                          <span key={child.name} data-testid="arch-tree-row" className="font-mono text-caption text-on-surface-variant">
                            {child.kind === 'dir' ? `${child.name}/` : child.name}
                            {child.kind === 'dir' && child.children !== undefined
                              ? ` — ${String(child.children.length)} entries (depth capped at three levels)`
                              : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            {folders.truncated && (
              <p className="text-caption text-on-surface-variant">
                tree truncated by the endpoint&apos;s safety cap — the source tree outgrew it
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
