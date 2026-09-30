import { useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `reqres:inspector` — the request-response topic's
 * interactive request inspector. The server's ANY /api/demo/reqres/inspect
 * endpoint answers every method and reflects exactly what it received: the
 * request line, the parsed query, the lowercased header map (with the
 * correlation id merged in the way a proxy would forward it), and the body
 * BOTH ways — parsed when a body parser claimed the stream, raw (capped)
 * when nothing did. This component is the control panel: pick a method, a
 * path + query, a content type, and a body, fire it, and read the reflected
 * view. Every fire also carries a custom x-inspector-client header, so the
 * highlighted x- rows are always about YOUR request.
 */

const DEFAULT_PATH = '/api/demo/reqres/inspect?via=inspector-demo';
const DEFAULT_BODY = '{"hello": "inspector"}';
/** A custom header sent on every fire — proof headers travel, echoed + highlighted. */
const CLIENT_PROBE_HEADER = 'x-inspector-client';
const CLIENT_PROBE_VALUE = 'browser-demo';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

const CONTENT_TYPES = [
  { value: 'none', label: '(no content type)' },
  { value: 'application/json', label: 'application/json' },
  { value: 'text/plain', label: 'text/plain' },
] as const;
type ContentTypeChoice = (typeof CONTENT_TYPES)[number]['value'];

/** What the reflected endpoint reports back (validated before use). */
interface Reflected {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[]>;
  body: unknown;
  bodyRaw: string | null;
  bodyRawTruncated: boolean;
  requestId: string;
}

/** Client-side payload validation before use (the API layer's house rule). */
function parseReflected(value: unknown): Reflected | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.method !== 'string' ||
    typeof raw.path !== 'string' ||
    typeof raw.requestId !== 'string' ||
    typeof raw.headers !== 'object' ||
    raw.headers === null ||
    Array.isArray(raw.headers)
  ) {
    return null;
  }
  return {
    method: raw.method,
    path: raw.path,
    query:
      typeof raw.query === 'object' && raw.query !== null && !Array.isArray(raw.query)
        ? (raw.query as Record<string, unknown>)
        : {},
    headers: raw.headers as Record<string, string | string[]>,
    body: raw.body ?? null,
    bodyRaw: typeof raw.bodyRaw === 'string' ? raw.bodyRaw : null,
    bodyRawTruncated: raw.bodyRawTruncated === true,
    requestId: raw.requestId,
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

type FireOutcome =
  | { ok: true; reflected: Reflected; status: number; elapsedMs: number }
  | { ok: false; message: string };

async function fireInspector(
  method: Method,
  path: string,
  contentType: ContentTypeChoice,
  bodyText: string,
): Promise<FireOutcome> {
  const bodyEnabled = method !== 'GET' && method !== 'DELETE' && contentType !== 'none';
  const headers: Record<string, string> = { [CLIENT_PROBE_HEADER]: CLIENT_PROBE_VALUE };
  if (bodyEnabled) headers['content-type'] = contentType;

  const startedAt = performance.now();
  try {
    const response = await fetch(path, {
      method,
      headers,
      ...(bodyEnabled ? { body: bodyText } : {}),
    });
    const text = await response.text();
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));

    const parsed = tryParseJson(text);
    const reflected = parsed.ok ? parseReflected(parsed.value) : null;
    if (reflected === null) {
      return {
        ok: false,
        message:
          response.status === 200
            ? 'The server replied with something other than the reflected view.'
            : `The server answered ${String(response.status)} — the inspector reflects requests to /api/demo/reqres/inspect; point the path back there. (A 404 envelope means the edited path matches no route.)`,
      };
    }
    return { ok: true, reflected, status: response.status, elapsedMs };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

type FireState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; outcome: Extract<FireOutcome, { ok: true }> };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none disabled:opacity-50';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const CELL = 'border-b border-outline px-xs py-xs align-top';
const ERROR = 'text-body-sm text-error';

function pretty(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function formatHeaderValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(', ') : value;
}

/** The reflected view: request table, header table with x- highlights, body. */
function ReflectedPanel({ outcome }: { outcome: Extract<FireOutcome, { ok: true }> }): ReactNode {
  const { reflected, status, elapsedMs } = outcome;
  const queryEntries = Object.entries(reflected.query);
  const headerEntries = Object.entries(reflected.headers);

  const bodySection = reflected.body !== null && reflected.body !== undefined
        ? {
            kind: 'parsed' as const,
            preview: pretty(reflected.body),
          }
        : reflected.bodyRaw !== null
          ? { kind: 'raw' as const, preview: reflected.bodyRaw }
          : { kind: 'none' as const, preview: '' };

  return (
    <div data-testid="reqres-inspector-result" className="flex flex-col gap-sm">
      <p data-testid="reqres-inspector-status" className="text-body-sm text-on-surface">
        <span className="font-mono font-semibold">{String(status)}</span> — the server reflected
        your <span className="font-mono font-semibold">{reflected.method}</span> in{' '}
        <span data-testid="reqres-inspector-elapsed">{String(elapsedMs)} ms</span>. Correlation id:{' '}
        <span data-testid="reqres-inspector-request-id" className="font-mono break-all">
          {reflected.requestId}
        </span>
        .
      </p>

      <table data-testid="reqres-inspector-request" className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="text-left text-on-surface-variant">
            <th className={CELL}>request line</th>
            <th className={CELL}>what the router parsed</th>
          </tr>
        </thead>
        <tbody className="text-on-surface">
          <tr>
            <td className={`${CELL} font-mono break-all`}>
              {reflected.method} {reflected.path}
            </td>
            <td className={`${CELL} font-mono break-all`}>
              {queryEntries.length === 0
                ? '(empty query — nothing after the ?)'
                : queryEntries
                    .map(
                      ([key, value]) =>
                        `${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}`,
                    )
                    .join('  ·  ')}
            </td>
          </tr>
        </tbody>
      </table>

      <div data-testid="reqres-inspector-headers" className="flex flex-col gap-xs">
        <p className="font-mono text-caption text-on-surface-variant">
          headers as the server saw them ({String(headerEntries.length)} — names lowercased by
          Node; x- rows highlighted)
        </p>
        <table className="w-full border-collapse text-body-sm">
          <tbody className="text-on-surface">
            {headerEntries.map(([name, value]) => {
              const isCustom = name.startsWith('x-');
              return (
                <tr
                  key={name}
                  {...(isCustom ? { 'data-testid': `reqres-inspector-header-x-${name}` } : {})}
                  className={
                    isCustom ? 'bg-primary-container text-on-primary-container' : undefined
                  }
                >
                  <td className={`${CELL} font-mono break-all`}>{name}</td>
                  <td className={`${CELL} font-mono break-all`}>{formatHeaderValue(value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {bodySection.kind === 'parsed' && (
        <div data-testid="reqres-inspector-body-parsed" className="flex flex-col gap-xs">
          <p className="text-body-sm text-on-surface">
            body — <span className="font-semibold">parsed</span>: the JSON parser matched your
            content type, so <span className="font-mono">req.body</span> was the parsed value and
            the stream was consumed for you.
          </p>
          <pre className="max-h-60 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all">
            {bodySection.preview}
          </pre>
        </div>
      )}
      {bodySection.kind === 'raw' && (
        <div data-testid="reqres-inspector-body-raw" className="flex flex-col gap-xs">
          <p className="text-body-sm text-on-surface">
            body — <span className="font-semibold">raw, from the stream</span>: no parser matched
            your content type, so <span className="font-mono">req.body</span> was undefined and the
            endpoint read the bytes itself
            {reflected.bodyRawTruncated ? ' (capped at the demo\u2019s length limit)' : ''}.
          </p>
          <pre className="max-h-60 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all">
            {bodySection.preview}
          </pre>
        </div>
      )}
      {bodySection.kind === 'none' && (
        <p data-testid="reqres-inspector-body-none" className="text-body-sm text-on-surface-variant">
          body — none arrived: nothing was parsed, and nothing was left in the stream to read.
        </p>
      )}
    </div>
  );
}

export default function RequestInspectorDemo() {
  const [method, setMethod] = useState<Method>('POST');
  const [path, setPath] = useState(DEFAULT_PATH);
  const [contentType, setContentType] = useState<ContentTypeChoice>('application/json');
  const [bodyText, setBodyText] = useState(DEFAULT_BODY);
  const [fireState, setFireState] = useState<FireState>({ kind: 'idle' });

  const bodyEnabled = method !== 'GET' && method !== 'DELETE' && contentType !== 'none';

  const fire = (): void => {
    const target = path.trim();
    if (target === '') {
      // An empty URL would fetch the current page, not the inspector.
      setFireState({ kind: 'failed', message: 'Enter a path to fire.' });
      return;
    }
    setFireState({ kind: 'running' });
    void fireInspector(method, target, contentType, bodyText).then((outcome) => {
      if (outcome.ok) setFireState({ kind: 'done', outcome });
      else setFireState({ kind: 'failed', message: outcome.message });
    });
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="reqres-inspector-summary" className="text-body-sm text-on-surface">
        One endpoint, <span className="font-mono">ANY /api/demo/reqres/inspect</span>, every method.
        Pick a verb, a path + query, and a content type — then read what the server actually
        received. POST it JSON and POST it text/plain to watch the body switch between{' '}
        <span className="font-mono">parsed</span> and <span className="font-mono">raw</span> (the
        Express 5 body-undefined gotcha, live). Every fire also sends{' '}
        <span className="font-mono">{CLIENT_PROBE_HEADER}</span> — find it highlighted below.
      </p>

      <div className="flex flex-col gap-sm">
        <div className="flex flex-wrap items-end gap-sm">
          <label className="flex flex-col gap-xs">
            <span className={LABEL}>method</span>
            <select
              data-testid="reqres-inspector-method"
              value={method}
              onChange={(event) => setMethod(event.target.value as Method)}
              className={`${INPUT} w-fit`}
            >
              {METHODS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-xs">
            <span className={LABEL}>content type</span>
            <select
              data-testid="reqres-inspector-content-type"
              value={contentType}
              onChange={(event) => setContentType(event.target.value as ContentTypeChoice)}
              className={`${INPUT} w-fit`}
            >
              {CONTENT_TYPES.map((candidate) => (
                <option key={candidate.value} value={candidate.value}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-xs">
          <span className={LABEL}>path + query (editable — try an unrouted one and read the 404)</span>
          <input
            type="text"
            data-testid="reqres-inspector-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            className={INPUT}
          />
        </label>

        <label className="flex flex-col gap-xs">
          <span className={LABEL}>
            request body{' '}
            {bodyEnabled
              ? '(sent with the content type above)'
              : '(not sent — disabled for GET/DELETE or when no content type is chosen)'}
          </span>
          <textarea
            rows={3}
            data-testid="reqres-inspector-body"
            value={bodyText}
            aria-label="request body"
            disabled={!bodyEnabled}
            onChange={(event) => setBodyText(event.target.value)}
            className={INPUT}
          />
        </label>

        <button
          type="button"
          data-testid="reqres-inspector-fire"
          onClick={fire}
          disabled={fireState.kind === 'running'}
          className={BUTTON}
        >
          {fireState.kind === 'running' ? 'firing…' : `FIRE ${method}`}
        </button>
      </div>

      {fireState.kind === 'running' && (
        <p data-testid="reqres-inspector-loading" className="text-body-sm text-on-surface-variant">
          firing <span className="font-mono">{method} {path.trim()}</span>…
        </p>
      )}
      {fireState.kind === 'failed' && (
        <p data-testid="reqres-inspector-error" role="alert" className={ERROR}>
          fail — {fireState.message}
        </p>
      )}
      {fireState.kind === 'idle' && (
        <p data-testid="reqres-inspector-idle" className="text-body-sm text-on-surface-variant">
          No request yet — fire one and the reflected view appears here.
        </p>
      )}
      {fireState.kind === 'done' && <ReflectedPanel outcome={fireState.outcome} />}
    </div>
  );
}
