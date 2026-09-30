import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `scaling:stateless` — THE PROCESS-STATE INSPECTOR: the
 * server inventories its own statelessness with LIVE counts (sessions,
 * limiter windows, queue depth, SSE connections) and this component renders
 * the verdict — the hazard table with its fix column, the already-shared
 * stores, and the process facts that make the whole thing concrete: pid and
 * replicas explain WHY two tabs behind a load balancer would disagree.
 */

const BASE_URL = '/api/demo/scaling/state';

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';
const BADGE_BREAKS =
  'rounded-md border border-error bg-error px-xs py-xxs font-mono text-caption font-bold text-on-error';

interface StatefulItem {
  readonly name: string;
  readonly count: number | null;
  readonly countNote?: string;
  readonly configured?: boolean;
  readonly configuration?: string;
  readonly shared: false;
  readonly breaksScaling: true;
  readonly where: string;
  readonly fix: string;
}

interface SharedItem {
  readonly name: string;
  readonly shared: boolean | string;
  readonly configured: boolean;
  readonly note: string;
}

interface StateBody {
  readonly process: { pid: number; uptimeSeconds: number; replicas: number; note: string };
  readonly stateful: StatefulItem[];
  readonly statelessOrShared: SharedItem[];
  readonly verdict: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Guarded parse — a malformed body throws here, never renders as nonsense. */
function parseState(raw: unknown): StateBody {
  if (!isRecord(raw) || !isRecord(raw.process) || !Array.isArray(raw.stateful) || !Array.isArray(raw.statelessOrShared)) {
    throw new Error('malformed state inventory');
  }
  if (typeof raw.verdict !== 'string') throw new Error('malformed verdict');
  return {
    process: {
      pid: typeof raw.process.pid === 'number' ? raw.process.pid : 0,
      uptimeSeconds: typeof raw.process.uptimeSeconds === 'number' ? raw.process.uptimeSeconds : 0,
      replicas: typeof raw.process.replicas === 'number' ? raw.process.replicas : 1,
      note: typeof raw.process.note === 'string' ? raw.process.note : '',
    },
    stateful: raw.stateful.filter(
      (item): item is StatefulItem =>
        isRecord(item) && typeof item.name === 'string' && typeof item.fix === 'string' && typeof item.where === 'string',
    ),
    statelessOrShared: raw.statelessOrShared.filter(
      (item): item is SharedItem => isRecord(item) && typeof item.name === 'string' && typeof item.note === 'string',
    ),
    verdict: raw.verdict,
  };
}

function sharedLabel(shared: boolean | string): string {
  if (shared === true) return 'shared store';
  if (shared === false) return 'not shared';
  return shared;
}

export default function StatelessInventoryDemo(): ReactNode {
  const [state, setState] = useState<StateBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch(BASE_URL);
      if (!aliveRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const parsed = parseState(await response.json());
      if (!aliveRef.current) return;
      setState(parsed);
      setError(null);
    } catch {
      if (aliveRef.current) {
        setError('the scaling API is unreachable — the inventory needs the dev server running');
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="scaling-summary" className="text-body-sm text-on-surface">
        This app grades its own statelessness: every hazard below is counted LIVE from the running
        process — log in, open the ticker, enqueue a job, then hit REFRESH and watch the numbers
        move. Each hazard names the fix that relocates it to a shared store.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <span data-testid="scaling-process" className={CHIP_STRONG}>
            pid {String(state?.process.pid ?? '…')} · up {String(state?.process.uptimeSeconds ?? '…')}s
            · replicas {String(state?.process.replicas ?? '…')}
          </span>
          <button
            type="button"
            data-testid="scaling-refresh"
            className={BUTTON}
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? 'measuring…' : 'refresh'}
          </button>
        </div>
        <p data-testid="scaling-explainer" className="text-caption text-on-surface-variant">
          Why pid/replicas matter: this endpoint measures only the process that answered it — two
          browser tabs behind a load balancer on two replicas would see DIFFERENT session counts,
          queue depths, and connection counts. That disagreement is the scaling hazard, observed.
        </p>
        {error !== null && (
          <p data-testid="scaling-error" className="text-caption text-error">
            {error}
          </p>
        )}
      </section>

      <section data-testid="scaling-hazards" className="flex flex-col gap-xs rounded-md border border-outline p-sm">
        <span className="text-caption font-semibold text-on-surface">
          stateful — breaks horizontal scaling ({String(state?.stateful.length ?? 0)})
        </span>
        <div className="hidden gap-sm font-mono text-caption text-on-surface-variant sm:flex">
          <span className="w-2/5">hazard</span>
          <span className="w-1/5">live count</span>
          <span className="w-2/5">the fix</span>
        </div>
        {state?.stateful.map((item) => (
          <div
            key={item.name}
            data-testid="scaling-hazard-row"
            className="flex flex-col gap-xxs rounded-md border border-outline bg-surface p-xs sm:flex-row sm:gap-sm"
          >
            <div className="flex w-full flex-col gap-xxs sm:w-2/5">
              <span className="font-mono text-caption font-semibold text-on-surface">{item.name}</span>
              <span className="text-caption text-on-surface-variant">{item.where}</span>
            </div>
            <div className="flex w-full flex-col gap-xxs sm:w-1/5">
              <span data-testid="scaling-hazard-count" className={CHIP_STRONG}>
                {item.count === null ? 'not exposed' : String(item.count)}
              </span>
              {item.count === null && item.configuration !== undefined && (
                <span className="font-mono text-caption text-on-surface-variant">{item.configuration}</span>
              )}
              <span data-testid="scaling-hazard-badge" className={BADGE_BREAKS}>
                breaks scaling
              </span>
            </div>
            <div className="flex w-full items-start sm:w-2/5">
              <span className="text-caption text-on-surface">{item.fix}</span>
            </div>
          </div>
        ))}
      </section>

      <section data-testid="scaling-shared" className="flex flex-col gap-xs rounded-md border border-outline p-sm">
        <span className="text-caption font-semibold text-on-surface">
          shared or single-writer — safe to replicate the app around ({String(state?.statelessOrShared.length ?? 0)})
        </span>
        {state?.statelessOrShared.map((item) => (
          <div key={item.name} data-testid="scaling-shared-row" className="flex flex-col gap-xxs rounded-md border border-outline bg-surface p-xs">
            <div className="flex flex-wrap items-center gap-xs">
              <span className="font-mono text-caption font-semibold text-on-surface">{item.name}</span>
              <span className={CHIP}>{sharedLabel(item.shared)}</span>
              <span className={CHIP}>{item.configured ? 'configured' : 'optional service off'}</span>
            </div>
            <span className="text-caption text-on-surface-variant">{item.note}</span>
          </div>
        ))}
      </section>

      {state !== null && (
        <p data-testid="scaling-verdict" className="rounded-md border border-outline bg-surface-variant p-sm text-body-sm font-semibold text-on-surface">
          {state.verdict}
        </p>
      )}
    </div>
  );
}
