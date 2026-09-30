import { useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `reqres:methods` — the request-response topic's
 * response-methods playground. GET /api/demo/reqres/respond?mode=… makes the
 * server answer with one real response family per mode (json / text / status
 * / redirect / cookie / stream / download); this component fires the chosen
 * mode with fetch redirect:'manual' so a 3xx is INSPECTED instead of silently
 * followed, and renders what actually came back: the status line, the
 * headers that family sets (Content-Type, Location, Set-Cookie,
 * Content-Disposition, Transfer-Encoding), the body, and a verdict naming
 * the method that produced it.
 *
 * Two browser honesty notes are handled explicitly, not hidden:
 * - fetch hides Set-Cookie from JavaScript (a forbidden response header) —
 *   when it cannot be read, the demo says so and points at the curl block.
 * - fetch with redirect:'manual' returns an opaque-redirect response in
 *   browsers (status 0, no headers) — the demo detects it, explains it, and
 *   fires a following fetch so the redirect-target arrival is still shown.
 */

const DEMO_BASE = '/api/demo/reqres/respond';

type Mode = 'json' | 'text' | 'status' | 'redirect' | 'cookie' | 'stream' | 'download';

interface ModeSpec {
  id: Mode;
  label: string;
  /** The status dropdown's codes — the server's own safe list. */
  verdict: string;
}

const MODES: readonly ModeSpec[] = [
  {
    id: 'json',
    label: 'res.json()',
    verdict:
      'res.json(object) serialized the object and set Content-Type: application/json — the one payload method this entire app\u2019s API runs on',
  },
  {
    id: 'text',
    label: 'res.type().send()',
    verdict:
      'res.type("text/plain").send(string) set Content-Type explicitly and sent the body as the exact string',
  },
  {
    id: 'status',
    label: 'res.status().json()',
    verdict: 'res.status(code).json(object) — the status line is data too; pick any code from the safe list',
  },
  {
    id: 'redirect',
    label: 'res.redirect()',
    verdict:
      'res.redirect(307, target) set the Location header — 307 preserves the method and body on the follow-up, where 301/302 may rewrite POST into GET',
  },
  {
    id: 'cookie',
    label: 'res.cookie()',
    verdict:
      'res.cookie(name, value, { httpOnly, sameSite, maxAge }) — the attributes are the security model; the lesson is in Set-Cookie',
  },
  {
    id: 'stream',
    label: 'res.write()',
    verdict:
      'res.write per line + res.end — Transfer-Encoding: chunked with no Content-Length, five ndjson lines delivered as they were produced',
  },
  {
    id: 'download',
    label: 'attachment',
    verdict:
      'Content-Disposition: attachment — the one header that turns a body into a download; real files use res.download() / res.sendFile()',
  },
];

const STATUS_CODES = [200, 201, 204, 400, 401, 403, 404, 409, 418, 500, 503] as const;

function statusLabel(status: number): string {
  const labels: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    307: 'Temporary Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    418: "I'm a teapot",
    500: 'Internal Server Error',
    503: 'Service Unavailable',
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

function prettyPreview(text: string): string {
  const parsed = tryParseJson(text);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : text === '' ? '(empty body)' : text;
}

/**
 * Reads response headers defensively: real fetch Headers, minimal test
 * doubles, and opaque responses (no readable headers at all) all work.
 */
function readHeader(response: Response, name: string): string | null {
  const headers: unknown = (response as { headers?: unknown }).headers;
  if (headers === null || headers === undefined) return null;
  const get: unknown = (headers as { get?: unknown }).get;
  if (typeof get !== 'function') return null;
  const value: unknown = (headers as { get: (n: string) => unknown }).get(name);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Set-Cookie is a forbidden response header for Headers#get in browsers;
 * getSetCookie() is the modern read. Returns null when the environment will
 * not expose it at all — the demo then says so instead of pretending.
 */
function readSetCookie(response: Response): string[] | null {
  const headers: unknown = (response as { headers?: unknown }).headers;
  if (headers === null || headers === undefined) return null;
  const getSetCookie: unknown = (headers as { getSetCookie?: unknown }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    const values: unknown = (headers as { getSetCookie: () => unknown }).getSetCookie();
    if (Array.isArray(values) && values.length > 0) return values.map(String);
  }
  const single = readHeader(response, 'set-cookie');
  return single === null ? null : [single];
}

/**
 * Header rows this demo surfaces, per mode — absent ones simply do not render.
 * set-cookie is deliberately absent: it is rendered from readSetCookie()
 * instead (forbidden-response-header handling gets its own path).
 */
const INTERESTING_HEADERS = [
  'content-type',
  'location',
  'content-disposition',
  'transfer-encoding',
  'x-stream-lines',
] as const;

interface FollowedResponse {
  status: number;
  bodyPreview: string;
}

interface ModeOutcome {
  mode: Mode;
  url: string;
  status: number;
  statusLabel: string;
  headerRows: Array<[string, string]>;
  setCookieRows: string[];
  setCookieHidden: boolean;
  bodyPreview: string;
  verdict: string;
  opaqueRedirect: boolean;
  followed: FollowedResponse | null;
}

type FireResult = { ok: true; outcome: ModeOutcome } | { ok: false; message: string };

async function fireMode(mode: Mode, chosenStatus: number): Promise<FireResult> {
  const spec = MODES.find((candidate) => candidate.id === mode);
  if (spec === undefined) return { ok: false, message: 'Unknown mode.' };
  const url =
    mode === 'status'
      ? `${DEMO_BASE}?mode=status&status=${String(chosenStatus)}`
      : `${DEMO_BASE}?mode=${mode}`;

  try {
    // redirect:'manual' on EVERY fire: a 3xx gets inspected, not followed.
    const response = await fetch(url, { method: 'GET', redirect: 'manual' });
    const text = await response.text();

    // Browsers return an opaque-redirect response for manual redirects:
    // status 0, no readable headers. Say so, then follow it the normal way so
    // the arrival is still visible.
    const opaqueRedirect =
      mode === 'redirect' &&
      ((response as { type?: unknown }).type === 'opaqueredirect' || response.status === 0);

    let followed: FollowedResponse | null = null;
    if (opaqueRedirect) {
      try {
        const followResponse = await fetch(url); // default redirect:'follow'
        const followText = await followResponse.text();
        followed = { status: followResponse.status, bodyPreview: prettyPreview(followText) };
      } catch {
        followed = null;
      }
    }

    const headerRows: Array<[string, string]> = [];
    for (const name of INTERESTING_HEADERS) {
      const value = readHeader(response, name);
      if (value !== null) headerRows.push([name, value]);
    }
    const setCookieRows = readSetCookie(response) ?? [];

    const verdict =
      mode === 'status' && chosenStatus === 204
        ? 'res.status(204).end() — 204 means NO body: the response terminated the moment it started'
        : mode === 'status'
          ? `res.status(${String(chosenStatus)}).json(object) — the status line is data too; a chosen status is not a failure, so the body is ordinary JSON, not the error envelope`
          : spec.verdict;

    return {
      ok: true,
      outcome: {
        mode,
        url,
        status: response.status,
        statusLabel: statusLabel(response.status),
        headerRows,
        setCookieRows,
        setCookieHidden: mode === 'cookie' && setCookieRows.length === 0 && !opaqueRedirect,
        bodyPreview: opaqueRedirect ? '(hidden by the browser — see the note)' : prettyPreview(text),
        verdict,
        opaqueRedirect,
        followed,
      },
    };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

type FireState =
  | { kind: 'idle' }
  | { kind: 'running'; mode: Mode }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; outcome: ModeOutcome };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const INPUT =
  'rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none disabled:opacity-50';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const CELL = 'border-b border-outline px-xs py-xs align-top';
const ERROR = 'text-body-sm text-error';

const PRE =
  'max-h-60 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

/** The result panel: status line, headers, body, verdict, honesty notes. */
function OutcomePanel({ outcome }: { outcome: ModeOutcome }): ReactNode {
  return (
    <div data-testid="reqres-methods-result" className="flex flex-col gap-xs">
      <p data-testid="reqres-methods-status-line" className="text-body-sm text-on-surface">
        <span className="font-mono font-semibold">{String(outcome.status)}</span>
        {outcome.statusLabel !== '' && ` ${outcome.statusLabel}`} — GET{' '}
        <span className="font-mono break-all">{outcome.url}</span> fired with{' '}
        <span className="font-mono">redirect: &quot;manual&quot;</span>.
      </p>

      {outcome.opaqueRedirect && (
        <p data-testid="reqres-methods-opaque" className="text-body-sm text-on-surface-variant">
          Your browser returned an <span className="font-mono">opaque-redirect</span> response
          (status 0, headers withheld): fetch with <span className="font-mono">redirect:
          &quot;manual&quot;</span> deliberately hides manual redirects from JavaScript. The 307 and
          Location ARE on the wire — the topic&rsquo;s curl block shows them raw. Following the
          redirect the normal way instead:
        </p>
      )}

      {outcome.followed !== null && (
        <p data-testid="reqres-methods-followed" className="text-body-sm text-on-surface">
          followed → <span className="font-mono font-semibold">{String(outcome.followed.status)}</span>{' '}
          {statusLabel(outcome.followed.status)}
        </p>
      )}
      {outcome.followed !== null && <pre className={PRE}>{outcome.followed.bodyPreview}</pre>}

      <table data-testid="reqres-methods-headers" className="w-full border-collapse text-body-sm">
        <tbody className="text-on-surface">
          {outcome.headerRows.map(([name, value]) => (
            <tr key={name} data-testid={`reqres-methods-header-${name}`}>
              <td className={`${CELL} font-mono`}>{name}</td>
              <td className={`${CELL} font-mono break-all`}>{value}</td>
            </tr>
          ))}
          {outcome.setCookieRows.map((cookie) => (
            <tr key={cookie} data-testid="reqres-methods-header-set-cookie">
              <td className={`${CELL} font-mono`}>set-cookie</td>
              <td className={`${CELL} font-mono break-all`}>{cookie}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {outcome.setCookieHidden && (
        <p data-testid="reqres-methods-set-cookie-hidden" className="text-body-sm text-on-surface-variant">
          Set-Cookie is hidden from JavaScript on purpose — the fetch spec marks it a forbidden
          response header. The cookie WAS set (HttpOnly, SameSite=Strict, Max-Age=60); the
          topic&rsquo;s curl block shows the raw header.
        </p>
      )}

      <pre data-testid="reqres-methods-body" className={PRE}>
        {outcome.bodyPreview}
      </pre>

      <p data-testid="reqres-methods-verdict" className="text-body-sm text-on-surface">
        {outcome.verdict}.
      </p>
    </div>
  );
}

export default function ResponseMethodsDemo() {
  const [fireState, setFireState] = useState<FireState>({ kind: 'idle' });
  const [chosenStatus, setChosenStatus] = useState<number>(409);

  const fire = (mode: Mode): void => {
    setFireState({ kind: 'running', mode });
    void fireMode(mode, chosenStatus).then((result) => {
      if (result.ok) setFireState({ kind: 'done', outcome: result.outcome });
      else setFireState({ kind: 'failed', message: result.message });
    });
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="reqres-methods-summary" className="text-body-sm text-on-surface">
        Seven buttons, seven real response families, one endpoint:{' '}
        <span className="font-mono">GET /api/demo/reqres/respond?mode=…</span>. Each fire is sent
        with <span className="font-mono">redirect: &quot;manual&quot;</span> so a 3xx is inspected
        rather than silently followed — and the verdict line names the method that produced what you
        see.
      </p>

      <div className="flex flex-wrap items-end gap-sm">
        {MODES.map((spec) => (
          <button
            key={spec.id}
            type="button"
            data-testid={`reqres-methods-mode-${spec.id}`}
            title={`${DEMO_BASE}?mode=${spec.id}`}
            onClick={() => fire(spec.id)}
            disabled={fireState.kind === 'running'}
            className={BUTTON}
          >
            {fireState.kind === 'running' && fireState.mode === spec.id
              ? 'firing…'
              : spec.label}
          </button>
        ))}

        <label className="flex flex-col gap-xs">
          <span className={LABEL}>status code (status mode)</span>
          <select
            data-testid="reqres-methods-status"
            value={String(chosenStatus)}
            onChange={(event) => setChosenStatus(Number(event.target.value))}
            className={INPUT}
          >
            {STATUS_CODES.map((code) => (
              <option key={code} value={String(code)}>
                {String(code)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {fireState.kind === 'running' && (
        <p data-testid="reqres-methods-loading" className="text-body-sm text-on-surface-variant">
          firing <span className="font-mono">{fireState.mode}</span>…
        </p>
      )}
      {fireState.kind === 'failed' && (
        <p data-testid="reqres-methods-error" role="alert" className={ERROR}>
          fail — {fireState.message}
        </p>
      )}
      {fireState.kind === 'idle' && (
        <p data-testid="reqres-methods-idle" className="text-body-sm text-on-surface-variant">
          No response yet — fire a family and its status line, headers, body, and verdict appear
          here.
        </p>
      )}
      {fireState.kind === 'done' && <OutcomePanel outcome={fireState.outcome} />}
    </div>
  );
}
