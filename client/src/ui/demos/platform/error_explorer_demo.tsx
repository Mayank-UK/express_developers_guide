import { useCallback, useEffect, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `errors:explorer` — the exception-handling topic's live
 * surface. Three panels over the REAL error pipeline:
 *
 * 1. THE TAXONOMY TABLE — served by GET /api/demo/errors/taxonomy, which the
 *    server assembles FROM the failure maps themselves (failures.ts), so this
 *    table cannot drift from the code that enforces it. Each row's TRY button
 *    fires GET /api/demo/error?failure=<kind> and renders the envelope, with
 *    the requestId checked against the x-request-id response header.
 * 2. THE INJECTION PANEL — the two-worlds lesson as controls: flip
 *    injectFailure (PATCH /api/demo/scenario) and call GET /api/demo/status,
 *    the Result path (a failure RETURNED by the domain) — and compare with the
 *    throw path above: same envelope either way.
 * 3. THE FALLBACK PANEL — the error middleware's generic branch: a thrown
 *    plain Error (500 internal_error) and a body-parser reject (400
 *    request_failed), neither of which carries a Failure inside.
 *
 * Lives in demos/platform/ beside the jobs console — the app's own operating
 * machinery is the subject.
 */

const TAXONOMY_URL = '/api/demo/errors/taxonomy';
const ERROR_URL = '/api/demo/error';
const SCENARIO_URL = '/api/demo/scenario';
const STATUS_URL = '/api/demo/status';
const PLAIN_ERROR_URL = '/api/demo/middleware/error-path';
const POSTS_URL = '/api/posts';

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

/** One fired request and everything needed to render its error story. */
interface Probe {
  /** The request line as fired — method + url. */
  label: string;
  status: number;
  headerRequestId: string | null;
  body: unknown;
}

interface TaxonomyRow {
  kind: string;
  httpStatus: number;
  errorCode: string;
}

interface ScenarioState {
  dataMode: 'fake' | 'live';
  injectFailure: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Guarded wire reads — a malformed payload degrades, never crashes. */
function parseTaxonomy(raw: unknown): TaxonomyRow[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.kinds)) return null;
  const rows = raw.kinds
    .map((entry): TaxonomyRow | null => {
      if (!isRecord(entry)) return null;
      if (typeof entry.kind !== 'string') return null;
      if (typeof entry.httpStatus !== 'number') return null;
      if (typeof entry.errorCode !== 'string') return null;
      return { kind: entry.kind, httpStatus: entry.httpStatus, errorCode: entry.errorCode };
    })
    .filter((row): row is TaxonomyRow => row !== null);
  return rows.length === 0 ? null : rows;
}

function parseScenario(raw: unknown): ScenarioState | null {
  if (!isRecord(raw)) return null;
  if (raw.dataMode !== 'fake' && raw.dataMode !== 'live') return null;
  if (typeof raw.injectFailure !== 'boolean') return null;
  return { dataMode: raw.dataMode, injectFailure: raw.injectFailure };
}

/** Fire a request and capture status + body + the correlation header. */
async function fireProbe(method: string, url: string, init?: RequestInit): Promise<Probe> {
  const response = await fetch(url, init);
  const headerRequestId = response.headers?.get?.('x-request-id') ?? null;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { label: `${method} ${url}`, status: response.status, headerRequestId, body };
}

/** The error envelope, when the body carries one (200s do not). */
function envelopeOf(probe: Probe): Record<string, unknown> | null {
  if (isRecord(probe.body) && isRecord(probe.body.error)) return probe.body.error;
  return null;
}

function requestIdOf(probe: Probe): string | null {
  const envelope = envelopeOf(probe);
  const requestId = envelope?.requestId;
  return typeof requestId === 'string' && requestId !== '' ? requestId : null;
}

/**
 * One probe result: request line, status/code/requestId chips, the
 * requestId ↔ header correlation note, and the body pretty-printed.
 */
function ProbeOutput({ probe, testPrefix }: { probe: Probe; testPrefix: string }): ReactNode {
  const envelope = envelopeOf(probe);
  const requestId = requestIdOf(probe);
  const code = envelope !== null && typeof envelope.code === 'string' ? envelope.code : null;
  const matchNote =
    requestId === null
      ? 'success payload — no requestId field (only the error envelope and the header carry one)'
      : probe.headerRequestId === null
        ? 'no x-request-id header observed on this response'
        : probe.headerRequestId === requestId
          ? 'requestId ↔ x-request-id response header: MATCH — one id, three places (envelope, header, log line)'
          : 'requestId MISMATCH — envelope and header disagree';

  return (
    <div data-testid={`${testPrefix}-probe`} className="flex flex-col gap-xxs">
      <p className="font-mono text-caption text-on-surface-variant">
        {probe.label} → <span className="font-semibold text-on-surface">{String(probe.status)}</span>
      </p>
      <div className="flex flex-wrap items-center gap-xs">
        {code !== null && (
          <span data-testid={`${testPrefix}-probe-code`} className={CHIP_STRONG}>
            code: {code}
          </span>
        )}
        <span data-testid={`${testPrefix}-probe-request-id`} className={CHIP}>
          {requestId === null ? 'requestId: —' : `requestId: ${requestId}`}
        </span>
        <span data-testid={`${testPrefix}-probe-match`} className="text-caption text-on-surface-variant">
          {matchNote}
        </span>
      </div>
      <pre
        data-testid={`${testPrefix}-probe-body`}
        className="overflow-x-auto rounded-md border border-outline bg-surface p-sm font-mono text-caption leading-relaxed text-on-surface"
      >
        {JSON.stringify(probe.body, null, 2)}
      </pre>
    </div>
  );
}

export default function ErrorExplorerDemo(): ReactNode {
  const [taxonomy, setTaxonomy] = useState<TaxonomyRow[] | null>(null);
  const [scenario, setScenario] = useState<ScenarioState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taxonomyProbe, setTaxonomyProbe] = useState<Probe | null>(null);
  const [statusProbe, setStatusProbe] = useState<Probe | null>(null);
  const [fallbackProbe, setFallbackProbe] = useState<Probe | null>(null);

  const loadScenario = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(SCENARIO_URL);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      setScenario(parseScenario(await response.json()));
    } catch {
      // the strip below reports the strip; the panels still work
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const response = await fetch(TAXONOMY_URL);
        if (!alive) return;
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const rows = parseTaxonomy(await response.json());
        if (!alive) return;
        if (rows === null) throw new Error('malformed taxonomy payload');
        setTaxonomy(rows);
        setError(null);
      } catch {
        if (alive) setError('the demo API is unreachable — reload once the server is up');
      }
    })();
    void loadScenario();
    return () => {
      alive = false;
    };
  }, [loadScenario]);

  const tryKind = async (kind: string): Promise<void> => {
    try {
      setTaxonomyProbe(await fireProbe('GET', `${ERROR_URL}?failure=${kind}`));
    } catch {
      setError('the demo API is unreachable — reload once the server is up');
    }
  };

  const patchScenario = async (patch: Partial<ScenarioState>): Promise<void> => {
    try {
      await fetch(SCENARIO_URL, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      await loadScenario();
    } catch {
      setError('the demo API is unreachable — reload once the server is up');
    }
  };

  const callStatus = async (): Promise<void> => {
    try {
      setStatusProbe(await fireProbe('GET', STATUS_URL));
    } catch {
      setError('the demo API is unreachable — reload once the server is up');
    }
  };

  const firePlainError = async (): Promise<void> => {
    try {
      setFallbackProbe(await fireProbe('GET', PLAIN_ERROR_URL));
    } catch {
      setError('the demo API is unreachable — reload once the server is up');
    }
  };

  const fireBadJson = async (): Promise<void> => {
    try {
      setFallbackProbe(
        await fireProbe('POST', POSTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"title": ', // deliberately malformed — the parser rejects it
        }),
      );
    } catch {
      setError('the demo API is unreachable — reload once the server is up');
    }
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="errors-summary" className="text-body-sm text-on-surface">
        The app&apos;s real error pipeline, fired live: every failure kind in the taxonomy, the
        failure-injection toggle, and the error middleware&apos;s fallback branch — each result
        rendered as the envelope with its <code className="font-mono">requestId</code> checked
        against the <code className="font-mono">x-request-id</code> response header.
      </p>

      {error !== null && (
        <p data-testid="errors-error" className="text-caption text-error">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            1 · the taxonomy — the throw path
          </span>
          <span className="text-caption text-on-surface-variant">
            table served from the real failure maps ({TAXONOMY_URL}); each TRY throws the
            AppException for that kind
          </span>
        </div>
        {taxonomy === null && error === null && (
          <p data-testid="errors-loading" className="text-body-sm text-on-surface-variant">
            loading the taxonomy…
          </p>
        )}
        {taxonomy !== null && (
          <div data-testid="errors-taxonomy-table" className="flex flex-col gap-xxs">
            <div className="flex items-center gap-sm border-b border-outline pb-xxs font-mono text-caption text-on-surface-variant">
              <span className="w-32 shrink-0">kind</span>
              <span className="w-16 shrink-0">HTTP</span>
              <span className="w-40 shrink-0">machine code</span>
              <span>action</span>
            </div>
            {taxonomy.map((row) => (
              <div
                key={row.kind}
                data-testid="errors-taxonomy-row"
                className="flex items-center gap-sm font-mono text-caption text-on-surface"
              >
                <span className="w-32 shrink-0">{row.kind}</span>
                <span className="w-16 shrink-0">{String(row.httpStatus)}</span>
                <span className="w-40 shrink-0">{row.errorCode}</span>
                <button
                  type="button"
                  data-testid={`errors-try-${row.kind}`}
                  onClick={() => void tryKind(row.kind)}
                  className={BUTTON}
                >
                  try
                </button>
              </div>
            ))}
          </div>
        )}
        {taxonomyProbe !== null && <ProbeOutput probe={taxonomyProbe} testPrefix="errors-taxonomy" />}
      </section>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            2 · failure injection — the Result path
          </span>
          <span className="text-caption text-on-surface-variant">
            the domain RETURNS a failure (DemoService), the controller converts it at the edge
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-xs">
          <span data-testid="errors-scenario-state" className={CHIP}>
            {scenario === null
              ? 'scenario …'
              : `dataMode ${scenario.dataMode} · injectFailure ${scenario.injectFailure ? 'on' : 'off'}`}
          </span>
          <button
            type="button"
            data-testid="errors-toggle-inject"
            onClick={() => void patchScenario({ injectFailure: !(scenario?.injectFailure ?? false) })}
            className={BUTTON_PRIMARY}
          >
            inject failure: {scenario?.injectFailure ? 'on — turn off' : 'off — turn on'}
          </button>
          <button
            type="button"
            data-testid="errors-toggle-data-mode"
            onClick={() =>
              void patchScenario({ dataMode: scenario?.dataMode === 'live' ? 'fake' : 'live' })
            }
            className={BUTTON}
          >
            data mode: {scenario?.dataMode ?? 'fake'}
            {scenario?.dataMode === 'live' ? ' — switch to fake' : ' — switch to live'}
          </button>
          <button type="button" data-testid="errors-call-status" onClick={() => void callStatus()} className={BUTTON}>
            call GET /api/demo/status
          </button>
        </div>
        <p className="text-caption text-on-surface-variant">
          THE LESSON: flip the toggle, call status, and compare the 503 envelope with any taxonomy
          row above — a failure RETURNED by the domain and a failure THROWN by a route produce the
          SAME envelope. Two worlds, one pipeline.
        </p>
        {statusProbe !== null && <ProbeOutput probe={statusProbe} testPrefix="errors-status" />}
      </section>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            3 · the fallback branch — errors that carry no Failure
          </span>
          <span className="text-caption text-on-surface-variant">
            the error middleware&apos;s generic extraction: status/code scavenged by convention
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-xs">
          <button type="button" data-testid="errors-plain-error" onClick={() => void firePlainError()} className={BUTTON}>
            plain Error (async throw → 500)
          </button>
          <button type="button" data-testid="errors-bad-json" onClick={() => void fireBadJson()} className={BUTTON}>
            malformed JSON (body-parser → 400)
          </button>
        </div>
        {fallbackProbe !== null && <ProbeOutput probe={fallbackProbe} testPrefix="errors-fallback" />}
      </section>
    </div>
  );
}
