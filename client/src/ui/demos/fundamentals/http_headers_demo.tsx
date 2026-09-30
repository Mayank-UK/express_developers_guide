import { useState } from 'react';

/**
 * Demo for DemoBlock `http:headers` — two experiments against this server:
 * - INSPECTOR: GET /api/demo/http/inspect asks the server to echo the request
 *   as IT saw it — request line (method, path, HTTP version), parsed query,
 *   and every header that actually arrived — rendered next to the response
 *   headers the browser received, so both directions of the metadata channel
 *   are visible at once.
 * - NEGOTIATOR: GET /api/demo/http/negotiate with three different Accept
 *   headers — same resource, three representations, with the server's choice
 *   announced in Content-Type and the raw body preview showing the shape.
 */

const INSPECT_URL = '/api/demo/http/inspect?via=browser-demo';
const NEGOTIATE_URL = '/api/demo/http/negotiate';

const NEGOTIATE_OPTIONS = [
  { key: 'json', accept: 'application/json', label: 'Accept: application/json' },
  { key: 'text', accept: 'text/plain', label: 'Accept: text/plain' },
  { key: 'html', accept: 'text/html', label: 'Accept: text/html' },
] as const;

interface InspectResult {
  method: string;
  httpVersion: string;
  path: string;
  query: Record<string, unknown>;
  /** Sorted name → value pairs, as the server received them. */
  requestHeaders: Array<[string, string]>;
  requestId: string;
  /** Name → value pairs the browser saw on the response. */
  responseHeaders: Array<[string, string]>;
}

interface NegotiateResult {
  acceptSent: string;
  contentType: string;
  vary: string | null;
  /** The raw body text, pretty-printed when it arrived as JSON. */
  bodyPreview: string;
}

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

/** Parse a text body as JSON, or report why it is not JSON. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

type FetchOutcome<T> = { ok: true; result: T } | { ok: false; message: string };

/**
 * Reads the response's headers as sorted [name, value] pairs. Real fetch
 * Headers supports entries(); older stand-ins get a get()-based fallback that
 * still surfaces the headers this demo teaches.
 */
function readResponseHeaders(response: Response): Array<[string, string]> {
  if (typeof response.headers.entries === 'function') {
    return Array.from(response.headers.entries()).sort(([a], [b]) => a.localeCompare(b));
  }
  const names = [
    'content-type',
    'cache-control',
    'vary',
    'x-teaching-header',
    'x-your-accept',
    'x-request-id',
  ];
  const pairs: Array<[string, string]> = [];
  for (const name of names) {
    const value = response.headers.get(name);
    if (value !== null) pairs.push([name, value]);
  }
  return pairs;
}

async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<FetchOutcome<{ text: string; response: Response }>> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) {
      const parsed = tryParseJson(text);
      return {
        ok: false,
        message: envelopeMessage(parsed.ok ? parsed.value : null, response.status),
      };
    }
    return { ok: true, result: { text, response } };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

async function fetchInspect(): Promise<FetchOutcome<InspectResult>> {
  const outcome = await fetchText(INSPECT_URL);
  if (!outcome.ok) return outcome;
  const parsed = tryParseJson(outcome.result.text);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return { ok: false, message: 'The server replied with something other than the expected JSON.' };
  }
  const body = parsed.value as {
    method?: unknown;
    httpVersion?: unknown;
    path?: unknown;
    query?: unknown;
    headers?: unknown;
    requestId?: unknown;
  };
  if (
    typeof body.method !== 'string' ||
    typeof body.httpVersion !== 'string' ||
    typeof body.path !== 'string' ||
    typeof body.requestId !== 'string' ||
    typeof body.headers !== 'object' ||
    body.headers === null
  ) {
    return { ok: false, message: 'The inspect reply was missing expected fields.' };
  }

  const requestHeaders: Array<[string, string]> = Object.entries(
    body.headers as Record<string, unknown>,
  ).map(([name, value]) => [
    name,
    Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value),
  ]);

  const query =
    typeof body.query === 'object' && body.query !== null
      ? (body.query as Record<string, unknown>)
      : {};

  return {
    ok: true,
    result: {
      method: body.method,
      httpVersion: body.httpVersion,
      path: body.path,
      query,
      requestHeaders,
      requestId: body.requestId,
      responseHeaders: readResponseHeaders(outcome.result.response),
    },
  };
}

async function fetchNegotiate(accept: string): Promise<FetchOutcome<NegotiateResult>> {
  const outcome = await fetchText(NEGOTIATE_URL, { headers: { accept } });
  if (!outcome.ok) return outcome;
  const { text, response } = outcome.result;

  const contentType = response.headers.get('content-type') ?? '(none)';
  let bodyPreview = text;
  if (contentType.includes('json')) {
    // The honest trigger is what the server actually sent, not what we asked
    // for — the fallback representation is JSON too.
    const parsed = tryParseJson(text);
    if (parsed.ok) bodyPreview = JSON.stringify(parsed.value, null, 2);
  }

  return {
    ok: true,
    result: { acceptSent: accept, contentType, vary: response.headers.get('vary'), bodyPreview },
  };
}

type InspectState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; result: InspectResult }
  | { kind: 'error'; message: string };

type NegotiateState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; result: NegotiateResult }
  | { kind: 'error'; message: string };

const CELL = 'border-b border-outline px-xs py-xs';
const OVERLINE = 'text-overline font-semibold uppercase tracking-[0.08em] text-on-surface-variant';
const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const ERROR = 'text-body-sm text-error';

function HeaderTable({
  caption,
  testId,
  pairs,
  highlight,
}: {
  caption: string;
  testId: string;
  pairs: Array<[string, string]>;
  highlight?: string;
}) {
  return (
    <div className="flex flex-col gap-xs">
      <p className={OVERLINE}>{caption}</p>
      <table data-testid={testId} className="w-full border-collapse text-body-sm">
        <tbody className="text-on-surface">
          {pairs.map(([name, value]) => {
            const isHighlighted = highlight !== undefined && name === highlight;
            return (
              <tr
                key={name}
                data-testid={isHighlighted ? `${testId}-highlight` : undefined}
                className={isHighlighted ? 'font-semibold text-on-surface' : undefined}
              >
                <td className={`${CELL} font-mono align-top`}>{name}</td>
                <td className={`${CELL} font-mono break-all`}>{value}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function InspectorPanel() {
  const [state, setState] = useState<InspectState>({ kind: 'idle' });

  const run = (): void => {
    setState({ kind: 'busy' });
    void fetchInspect().then((outcome) => {
      setState(
        outcome.ok
          ? { kind: 'done', result: outcome.result }
          : { kind: 'error', message: outcome.message },
      );
    });
  };

  return (
    <section className="flex flex-col gap-sm">
      <p className={OVERLINE}>a · inspect my request</p>
      <button
        type="button"
        data-testid="http-inspect-run"
        onClick={run}
        disabled={state.kind === 'busy'}
        className={BUTTON}
      >
        {state.kind === 'busy' ? 'inspecting…' : 'Inspect my request'}
      </button>

      {state.kind === 'error' && (
        <p data-testid="http-inspect-error" role="alert" className={ERROR}>
          fail — {state.message}
        </p>
      )}

      {state.kind === 'done' && (
        <div className="flex flex-col gap-sm">
          <p data-testid="http-inspect-summary" className="text-body-sm text-on-surface">
            The server received{' '}
            <span className="font-mono">
              {state.result.method} {state.result.path}
            </span>{' '}
            over HTTP/{state.result.httpVersion}
            {Object.keys(state.result.query).length > 0 && (
              <>
                {' '}
                with query{' '}
                <span className="font-mono">{JSON.stringify(state.result.query)}</span>
              </>
            )}
            . It assigned correlation id{' '}
            <span className="font-mono">{state.result.requestId}</span> — highlighted below, the
            way a proxy would forward it.
          </p>
          <div className="grid grid-cols-1 gap-md xl:grid-cols-2">
            <HeaderTable
              caption="request headers (as the server saw them)"
              testId="http-inspect-req-headers"
              pairs={state.result.requestHeaders}
              highlight="x-request-id"
            />
            <HeaderTable
              caption="response headers (as the browser received them)"
              testId="http-inspect-res-headers"
              pairs={state.result.responseHeaders}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function NegotiatorPanel() {
  const [state, setState] = useState<NegotiateState>({ kind: 'idle' });

  const run = (accept: string): void => {
    setState({ kind: 'busy' });
    void fetchNegotiate(accept).then((outcome) => {
      setState(
        outcome.ok
          ? { kind: 'done', result: outcome.result }
          : { kind: 'error', message: outcome.message },
      );
    });
  };

  return (
    <section className="flex flex-col gap-sm">
      <p className={OVERLINE}>b · negotiate my representation</p>
      <div className="flex flex-wrap gap-xs">
        {NEGOTIATE_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            data-testid={`http-negotiate-${option.key}`}
            onClick={() => run(option.accept)}
            disabled={state.kind === 'busy'}
            className={`${BUTTON} font-mono`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {state.kind === 'error' && (
        <p data-testid="http-negotiate-error" role="alert" className={ERROR}>
          fail — {state.message}
        </p>
      )}

      {state.kind === 'done' && (
        <div className="flex flex-col gap-xs">
          <p data-testid="http-negotiate-result" className="text-body-sm text-on-surface">
            Sent <span className="font-mono">Accept: {state.result.acceptSent}</span> — got back{' '}
            <span className="font-mono">Content-Type: {state.result.contentType}</span>
            {state.result.vary !== null && (
              <>
                {' '}
                and <span className="font-mono">Vary: {state.result.vary}</span>
              </>
            )}
            .
          </p>
          <pre
            data-testid="http-negotiate-body"
            className="max-h-80 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all"
          >
            {state.result.bodyPreview}
          </pre>
        </div>
      )}
    </section>
  );
}

export default function HttpHeadersDemo() {
  return (
    <div className="flex flex-col gap-md">
      <InspectorPanel />
      <NegotiatorPanel />
    </div>
  );
}
