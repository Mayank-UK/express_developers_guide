import { useEffect, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `routing:explorer` — the routing topic's live route
 * explorer. The server's routing demo router publishes a catalog of its own
 * route table (GET /api/demo/routing/catalog); this component renders that
 * table and lets you FIRE any row at an editable path (and, for POST, an
 * editable JSON body), showing status, elapsed time, and the response body —
 * which always starts with a `matched` echo naming the pattern that answered.
 * Unrouted paths fall through to the app-level 404 catch-all, and that
 * envelope is shown in the same panel.
 */

const CATALOG_URL = '/api/demo/routing/catalog';
const DEFAULT_POST_BODY = '{"name": "new-project"}';

interface CatalogRoute {
  method: 'GET' | 'POST';
  pattern: string;
  fullPath: string;
  purpose: string;
  params: readonly string[];
  examplePath: string;
}

interface Catalog {
  mountPath: string;
  routeCount: number;
  routes: readonly CatalogRoute[];
}

/** Stable, testid-safe key for one row: "GET /projects/:projectId" → get-projects-projectid. */
function rowKey(route: CatalogRoute): string {
  return `${route.method} ${route.pattern}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Client-side payload validation before use (the API layer's house rule). */
function parseCatalog(body: unknown): Catalog | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as { mountPath?: unknown; routes?: unknown };
  if (typeof raw.mountPath !== 'string' || !Array.isArray(raw.routes)) return null;
  const routes: CatalogRoute[] = [];
  for (const entry of raw.routes) {
    if (typeof entry !== 'object' || entry === null) return null;
    const candidate = entry as Record<string, unknown>;
    if (
      (candidate.method !== 'GET' && candidate.method !== 'POST') ||
      typeof candidate.pattern !== 'string' ||
      typeof candidate.fullPath !== 'string' ||
      typeof candidate.purpose !== 'string' ||
      !Array.isArray(candidate.params) ||
      typeof candidate.examplePath !== 'string'
    ) {
      return null;
    }
    routes.push({
      method: candidate.method,
      pattern: candidate.pattern,
      fullPath: candidate.fullPath,
      purpose: candidate.purpose,
      params: candidate.params.map(String),
      examplePath: candidate.examplePath,
    });
  }
  return { mountPath: raw.mountPath, routeCount: routes.length, routes };
}

type CatalogState =
  | { kind: 'loading' }
  | { kind: 'ready'; catalog: Catalog }
  | { kind: 'error'; message: string };

interface FiredResult {
  rowKey: string;
  method: string;
  url: string;
  status: number;
  statusLabel: string;
  elapsedMs: number;
  bodyPreview: string;
}

/** The short reason phrase for the statuses this demo actually produces. */
function statusLabel(status: number): string {
  const labels: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    400: 'Bad Request',
    404: 'Not Found',
    500: 'Internal Server Error',
  };
  return labels[status] ?? '';
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function loadCatalog(): Promise<CatalogState> {
  try {
    const response = await fetch(CATALOG_URL, { headers: { accept: 'application/json' } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { kind: 'error', message: `The catalog request failed with status ${response.status}.` };
    }
    const catalog = parseCatalog(body);
    if (catalog === null || catalog.routes.length === 0) {
      return { kind: 'error', message: 'The server\u2019s route catalog was missing or malformed.' };
    }
    return { kind: 'ready', catalog };
  } catch {
    return { kind: 'error', message: 'Could not reach the server.' };
  }
}

type FireOutcome = { ok: true; result: FiredResult } | { ok: false; message: string };

async function fireRoute(
  route: CatalogRoute,
  url: string,
  postBody: string,
): Promise<FireOutcome> {
  const startedAt = performance.now();
  try {
    const init: RequestInit =
      route.method === 'POST'
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: postBody,
          }
        : { method: 'GET' };
    const response = await fetch(url, init);
    const text = await response.text();
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));

    const parsed = tryParseJson(text);
    const bodyPreview =
      parsed.ok ? JSON.stringify(parsed.value, null, 2) : text === '' ? '(empty body)' : text;

    return {
      ok: true,
      result: {
        rowKey: rowKey(route),
        method: route.method,
        url,
        status: response.status,
        statusLabel: statusLabel(response.status),
        elapsedMs,
        bodyPreview,
      },
    };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const METHOD_CHIP =
  'inline-block rounded border border-outline px-xs py-1 font-mono text-body-sm font-semibold text-on-surface-variant';
const CELL = 'border-b border-outline px-xs py-xs align-top';
const ERROR = 'text-body-sm text-error';

/** The method chip — deliberately no testid: several GET rows would duplicate it. */
function MethodChip({ method }: { method: string }): ReactNode {
  return <span className={METHOD_CHIP}>{method}</span>;
}

export default function RoutingExplorerDemo() {
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: 'loading' });
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [postBodies, setPostBodies] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [result, setResult] = useState<FiredResult | null>(null);
  const [fireError, setFireError] = useState<string | null>(null);

  useEffect(() => {
    void loadCatalog().then(setCatalogState);
  }, []);

  if (catalogState.kind === 'loading') {
    return (
      <p data-testid="routing-explorer-loading" className="text-body-sm text-on-surface-variant">
        fetching the server’s route catalog…
      </p>
    );
  }

  if (catalogState.kind === 'error') {
    return (
      <p data-testid="routing-explorer-load-error" role="alert" className={ERROR}>
        fail — {catalogState.message}
      </p>
    );
  }

  const { catalog } = catalogState;

  const pathFor = (route: CatalogRoute): string => paths[rowKey(route)] ?? route.examplePath;
  const bodyFor = (route: CatalogRoute): string =>
    postBodies[rowKey(route)] ?? DEFAULT_POST_BODY;

  const fire = (route: CatalogRoute): void => {
    const url = pathFor(route).trim();
    if (url === '') {
      setFireError('Enter a path to fire.');
      return;
    }
    setFireError(null);
    setBusyRow(rowKey(route));
    void fireRoute(route, url, bodyFor(route)).then((outcome) => {
      setBusyRow(null);
      if (outcome.ok) setResult(outcome.result);
      else setFireError(outcome.message);
    });
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="routing-explorer-summary" className="text-body-sm text-on-surface">
        The server published its own route table: {String(catalog.routeCount)} patterns mounted at{' '}
        <span className="font-mono">{catalog.mountPath}</span>. Edit any path (and the POST body),
        fire it, and read the answer — the <span className="font-mono">matched</span> field names
        the exact row that responded.
      </p>

      <table data-testid="routing-explorer-table" className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="text-left text-on-surface-variant">
            <th className={CELL}>method</th>
            <th className={CELL}>pattern (at the mount)</th>
            <th className={CELL}>purpose</th>
            <th className={CELL}>try it</th>
          </tr>
        </thead>
        <tbody className="text-on-surface">
          {catalog.routes.map((route) => {
            const key = rowKey(route);
            return (
              <tr key={key} data-testid={`routing-explorer-row-${key}`}>
                <td className={CELL}>
                  <MethodChip method={route.method} />
                </td>
                <td className={`${CELL} font-mono break-all`}>
                  {route.pattern}
                  {route.params.length > 0 && (
                    <span className="block text-on-surface-variant">
                      captures: {route.params.join(', ')}
                    </span>
                  )}
                </td>
                <td className={CELL}>{route.purpose}</td>
                <td className={CELL}>
                  <div className="flex flex-col gap-xs">
                    <input
                      type="text"
                      data-testid={`routing-explorer-input-${key}`}
                      value={pathFor(route)}
                      aria-label={`path for ${route.method} ${route.pattern}`}
                      onChange={(event) =>
                        setPaths((current) => ({ ...current, [key]: event.target.value }))
                      }
                      className={INPUT}
                    />
                    {route.method === 'POST' && (
                      <textarea
                        rows={2}
                        data-testid={`routing-explorer-body-${key}`}
                        value={bodyFor(route)}
                        aria-label={`JSON body for POST ${route.pattern}`}
                        onChange={(event) =>
                          setPostBodies((current) => ({ ...current, [key]: event.target.value }))
                        }
                        className={INPUT}
                      />
                    )}
                    <button
                      type="button"
                      data-testid={`routing-explorer-fire-${key}`}
                      onClick={() => fire(route)}
                      disabled={busyRow !== null}
                      className={BUTTON}
                    >
                      {busyRow === key ? 'firing…' : `FIRE ${route.method}`}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {fireError !== null && (
        <p data-testid="routing-explorer-error" role="alert" className={ERROR}>
          fail — {fireError}
        </p>
      )}

      {result !== null && (
        <div data-testid="routing-explorer-result" className="flex flex-col gap-xs">
          <p data-testid="routing-explorer-status" className="text-body-sm text-on-surface">
            <span className="font-mono font-semibold">{String(result.status)}</span>
            {result.statusLabel !== '' && ` ${result.statusLabel}`} — {result.method}{' '}
            <span className="font-mono break-all">{result.url}</span> answered in{' '}
            <span data-testid="routing-explorer-elapsed">{String(result.elapsedMs)} ms</span>.
          </p>
          <pre
            data-testid="routing-explorer-body"
            className="max-h-80 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all"
          >
            {result.bodyPreview}
          </pre>
        </div>
      )}
    </div>
  );
}
