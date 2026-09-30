import { useCallback, useEffect, useState } from 'react';

/**
 * Demo for DemoBlock `express:app-info` — calls GET /api/demo/app-info and
 * renders the response as a definition list with a refresh button. The demo is
 * deliberately self-contained: it shows exactly how a client consumes one
 * endpoint, including loading and error states.
 */

interface AppInfoResponse {
  app: string;
  nodeVersion: string;
  expressVersion: string;
  env: string;
  uptimeSeconds: number;
  pid: number;
  scenario: { dataMode: string; injectFailure: boolean };
}

type AppInfoState =
  | { kind: 'loading' }
  | { kind: 'ready'; info: AppInfoResponse }
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

async function loadAppInfo(): Promise<AppInfoState> {
  try {
    const response = await fetch('/api/demo/app-info', { headers: { accept: 'application/json' } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { kind: 'error', message: envelopeMessage(body, response.status) };
    if (typeof body !== 'object' || body === null) return { kind: 'error', message: envelopeMessage(null, response.status) };
    return { kind: 'ready', info: body as AppInfoResponse };
  } catch {
    return { kind: 'error', message: 'Could not reach the server.' };
  }
}

interface InfoRow {
  label: string;
  value: string;
}

function toRows(info: AppInfoResponse): InfoRow[] {
  return [
    { label: 'node', value: info.nodeVersion },
    { label: 'express', value: info.expressVersion },
    { label: 'env', value: info.env },
    { label: 'uptime', value: `${String(info.uptimeSeconds)}s` },
    { label: 'pid', value: String(info.pid) },
    { label: 'data mode', value: info.scenario.dataMode },
    { label: 'failure injection', value: info.scenario.injectFailure ? 'on' : 'off' },
  ];
}

export default function AppInfoDemo() {
  const [state, setState] = useState<AppInfoState>({ kind: 'loading' });

  const refresh = useCallback(() => {
    setState({ kind: 'loading' });
    void loadAppInfo().then(setState);
  }, []);

  useEffect(() => {
    void loadAppInfo().then(setState);
  }, []);

  return (
    <div className="flex flex-col gap-sm">
      {state.kind === 'loading' && (
        <p data-testid="app-info-loading" className="text-body-sm text-on-surface-variant">
          asking the server…
        </p>
      )}

      {state.kind === 'error' && (
        <p data-testid="app-info-error" className="text-body-sm text-error" role="alert">
          fail — {state.message}
        </p>
      )}

      {state.kind === 'ready' && (
        <dl data-testid="app-info-fields" className="grid grid-cols-1 gap-xs sm:grid-cols-2">
          {toRows(state.info).map((row) => (
            <div
              key={row.label}
              className="flex flex-col rounded-md border border-outline bg-surface px-sm py-xs"
            >
              <dt className="text-overline font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
                {row.label}
              </dt>
              <dd className="font-mono text-body-sm text-on-surface">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
        >
          refresh
        </button>
      </div>
    </div>
  );
}
