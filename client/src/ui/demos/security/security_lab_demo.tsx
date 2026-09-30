import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `security:lab` — the Security topic's lab over the real
 * middleware (security_demo_routes.ts + app.ts's helmet mount):
 *
 * 1. HEADERS — GET /api/demo/security/headers returns the headers THIS
 *    response actually carries (helmet set them app-wide); rendered as a
 *    table with a per-header explainer for the security ones.
 * 2. RATE LIMIT — "send 8 requests" fires eight SEQUENTIAL GETs at the
 *    express-rate-limited /ping (5 per 60s per ip) and shows the chip row
 *    200×5 → 429×3 with Retry-After / RateLimit-* from the last response;
 *    a second button trips the handmade fixed-window twin (3 per 30s).
 * 3. CORS — an origin field fires /cors-check, whose verdict comes from the
 *    SAME decision function the mounted corsMiddleware enforces.
 * 4. SSRF GUARD — a URL field against the allowlist guard; the metadata IP
 *    is denied BY NAME, disguises are classified, and nothing is fetched.
 */

const HEADERS_URL = '/api/demo/security/headers';
const PING_URL = '/api/demo/security/ping';
const HANDMADE_URL = '/api/demo/security/handmade-ping';
const CORS_CHECK_URL = '/api/demo/security/cors-check';
const SSRF_URL = '/api/demo/security/ssrf-guard';

const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';
const HEX_DISGUISE_URL = 'http://0x7f000001/';
const ALLOWED_URL = 'http://httpbin.org/get';

/** One explainer per security header — the panel teaches, not just lists. */
const SECURITY_HEADER_EXPLAINERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    'what this page may load/execute — the strongest header; inline script dies here',
  'strict-transport-security': 'https only, for max-age seconds — closes the downgrade strip',
  'x-content-type-options':
    'nosniff — the browser may not second-guess the Content-Type into script',
  'x-frame-options': 'SAMEORIGIN — other sites may not iframe this page (clickjacking)',
  'referrer-policy': 'how much of your URL leaks with outbound clicks',
  'origin-agent-cluster': 'isolates this origin\'s window references (cross-origin isolation)',
  'cross-origin-opener-policy': 'hardens who may hold a window handle to this page',
  'cross-origin-resource-policy': 'who may embed this resource cross-origin',
  'x-dns-prefetch-control': 'prefetching off — no speculative DNS leaks',
  'x-permitted-cross-domain-policies': 'none — no Flash/PDF cross-domain policy files',
  'x-xss-protection': '0 — the old browser XSS auditor is OFF (it caused bugs; CSP replaced it)',
  'x-request-id': 'correlation id from the request-id middleware — not security, but rides every response',
};

type HeadersState =
  | { kind: 'loading' }
  | { kind: 'ready'; headers: Record<string, string> }
  | { kind: 'failed'; problem: string };

/** One fired ping's verdict — chip + header facts. */
interface PingResult {
  seq: number;
  status: number;
  remaining?: number;
  retryAfter?: string;
  ratelimitRemaining?: string;
  ratelimitLimit?: string;
}

type PingState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; results: PingResult[]; lastProblem?: string };

interface CorsVerdict {
  origin: string;
  allowed: boolean;
  accessControlAllowOrigin: string | null;
  credentials: boolean;
  note: string;
}

type CorsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; verdict: CorsVerdict }
  | { kind: 'failed'; problem: string };

interface SsrfVerdict {
  url: string;
  allowed: boolean;
  kind: string;
  reason: string;
  host: string;
}

type SsrfState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; verdict: SsrfVerdict }
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
const INPUT =
  'w-full max-w-md rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface';

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

/** One fetch, one body read — { status, bodyText, headers }. */
async function fetchOnce(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; bodyText: string; headers: Headers }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    bodyText: await readBodyText(response),
    headers: response.headers as Headers,
  };
}

function parseHeadersPayload(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null) return null;
  const headers = (value as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return null;
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
    out[name] = String(raw);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseCorsVerdict(value: unknown): CorsVerdict | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.origin !== 'string' || typeof record.allowed !== 'boolean') return null;
  return {
    origin: record.origin,
    allowed: record.allowed,
    accessControlAllowOrigin:
      typeof record.accessControlAllowOrigin === 'string' ? record.accessControlAllowOrigin : null,
    credentials: record.credentials === true,
    note: typeof record.note === 'string' ? record.note : '',
  };
}

function parseSsrfVerdict(value: unknown): SsrfVerdict | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.allowed !== 'boolean' || typeof record.reason !== 'string') return null;
  return {
    url: typeof record.url === 'string' ? record.url : '',
    allowed: record.allowed,
    kind: typeof record.kind === 'string' ? record.kind : '?',
    reason: record.reason,
    host: typeof record.host === 'string' ? record.host : '?',
  };
}

export default function SecurityLabDemo(): ReactNode {
  // panel 1
  const [headersState, setHeadersState] = useState<HeadersState>({ kind: 'loading' });
  // panel 2
  const [pingState, setPingState] = useState<PingState>({ kind: 'idle' });
  const [handmadeState, setHandmadeState] = useState<PingState>({ kind: 'idle' });
  // panel 3
  const [corsOrigin, setCorsOrigin] = useState('https://example.com');
  const [corsState, setCorsState] = useState<CorsState>({ kind: 'idle' });
  // panel 4
  const [ssrfUrl, setSsrfUrl] = useState(METADATA_URL);
  const [ssrfState, setSsrfState] = useState<SsrfState>({ kind: 'idle' });

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Panel 1 loads with the demo.
  useEffect(() => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(HEADERS_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setHeadersState({ kind: 'failed', problem: `${String(status)} — ${bodyText}` });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const headers = parsed.ok ? parseHeadersPayload(parsed.value) : null;
        if (headers === null) {
          setHeadersState({ kind: 'failed', problem: 'unexpected headers payload' });
          return;
        }
        setHeadersState({ kind: 'ready', headers });
      } catch {
        if (aliveRef.current) setHeadersState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  }, []);

  /** Fires `count` SEQUENTIAL pings and records every verdict. */
  const runPings = (url: string, count: number, setter: (state: PingState) => void): void => {
    setter({ kind: 'running' });
    void (async () => {
      const results: PingResult[] = [];
      let lastProblem: string | undefined;
      try {
        for (let seq = 1; seq <= count; seq += 1) {
          const { status, bodyText, headers } = await fetchOnce(url);
          const parsed = tryParseJson(bodyText);
          const body =
            parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
              ? (parsed.value as Record<string, unknown>)
              : {};
          const retryAfter = headers.get('retry-after');
          const entry: PingResult = {
            seq,
            status,
            remaining: typeof body.remaining === 'number' ? body.remaining : undefined,
            retryAfter: retryAfter ?? undefined,
            ratelimitRemaining: headers.get('ratelimit-remaining') ?? undefined,
            ratelimitLimit: headers.get('ratelimit-limit') ?? undefined,
          };
          results.push(entry);
          if (aliveRef.current) setter({ kind: 'done', results: [...results] });
        }
      } catch {
        lastProblem = UNREACHABLE;
      }
      if (aliveRef.current) setter({ kind: 'done', results, ...(lastProblem !== undefined && { lastProblem }) });
    })();
  };

  const runCorsCheck = (): void => {
    setCorsState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(
          `${CORS_CHECK_URL}?origin=${encodeURIComponent(corsOrigin)}`,
        );
        if (!aliveRef.current) return;
        if (status >= 400) {
          setCorsState({ kind: 'failed', problem: `${String(status)} — ${bodyText}` });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const verdict = parsed.ok ? parseCorsVerdict(parsed.value) : null;
        if (verdict === null) {
          setCorsState({ kind: 'failed', problem: 'unexpected cors-check payload' });
          return;
        }
        setCorsState({ kind: 'ready', verdict });
      } catch {
        if (aliveRef.current) setCorsState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const runSsrfCheck = (): void => {
    setSsrfState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(`${SSRF_URL}?url=${encodeURIComponent(ssrfUrl)}`);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setSsrfState({ kind: 'failed', problem: `${String(status)} — ${bodyText}` });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const verdict = parsed.ok ? parseSsrfVerdict(parsed.value) : null;
        if (verdict === null) {
          setSsrfState({ kind: 'failed', problem: 'unexpected ssrf-guard payload' });
          return;
        }
        setSsrfState({ kind: 'ready', verdict });
      } catch {
        if (aliveRef.current) setSsrfState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const headerNames =
    headersState.kind === 'ready'
      ? Object.keys(headersState.headers).sort((a, b) => a.localeCompare(b))
      : [];
  const securityCount = headerNames.filter((name) => SECURITY_HEADER_EXPLAINERS[name] !== undefined).length;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="security-summary" className="text-body-sm text-on-surface">
        Four panels over real middleware: the security headers this very response carries, a rate
        limit you can trip in eight clicks, CORS verdicts from the enforcing allowlist function,
        and the SSRF guard denying the cloud metadata IP by name.
      </p>

      {/* 1 — headers */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          1 · The headers helmet set on YOUR request
        </h3>

        {headersState.kind === 'loading' && (
          <p data-testid="security-headers-loading" className="text-caption text-on-surface-variant">
            fetching the headers this response carries…
          </p>
        )}
        {headersState.kind === 'failed' && (
          <pre data-testid="security-headers-failed" className={PRE}>
            {headersState.problem}
          </pre>
        )}

        {headersState.kind === 'ready' && (
          <div data-testid="security-headers-table" className="overflow-x-auto">
            <p className="mb-xs text-caption text-on-surface-variant">
              {String(headerNames.length)} headers on the wire · {String(securityCount)} with a security job:
            </p>
            <table className="w-full border-collapse font-mono text-caption">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="border-b border-outline px-xs py-xxs">header</th>
                  <th className="border-b border-outline px-xs py-xxs">value (abridged)</th>
                  <th className="border-b border-outline px-xs py-xxs">its job</th>
                </tr>
              </thead>
              <tbody>
                {headerNames.map((name) => (
                  <tr key={name} data-testid="security-headers-row">
                    <td className="border-b border-outline px-xs py-xxs text-on-surface">{name}</td>
                    <td className="border-b border-outline px-xs py-xxs break-all text-on-surface-variant">
                      {headersState.headers[name]!.length > 90
                        ? `${headersState.headers[name]!.slice(0, 90)}…`
                        : headersState.headers[name]}
                    </td>
                    <td className="border-b border-outline px-xs py-xxs text-on-surface-variant">
                      {SECURITY_HEADER_EXPLAINERS[name] ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 2 — rate limit */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          2 · Trip the rate limit (8 clicks worth of patience not required)
        </h3>

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="security-ping-button"
            onClick={() => runPings(PING_URL, 8, setPingState)}
            disabled={pingState.kind === 'running'}
            className={BUTTON_PRIMARY}
          >
            {pingState.kind === 'running' ? 'pinging…' : 'send 8 requests → /ping (limit 5/60s)'}
          </button>
          <button
            type="button"
            data-testid="security-handmade-button"
            onClick={() => runPings(HANDMADE_URL, 4, setHandmadeState)}
            disabled={handmadeState.kind === 'running'}
            className={BUTTON}
          >
            {handmadeState.kind === 'running' ? 'pinging…' : 'send 4 → the handmade twin (3/30s)'}
          </button>
        </div>

        {pingState.kind === 'done' && (
          <div data-testid="security-ping-results" className="flex flex-col gap-xs">
            <div className="flex flex-wrap gap-xxs">
              {pingState.results.map((result) => (
                <span
                  key={result.seq}
                  data-testid="security-ping-chip"
                  title={result.remaining !== undefined ? `remaining: ${String(result.remaining)}` : undefined}
                  className={result.status < 400 ? CHIP_OK : CHIP_ERROR}
                >
                  {String(result.status)}
                </span>
              ))}
            </div>
            {(() => {
              const last429 = [...pingState.results].reverse().find((result) => result.status === 429);
              return (
                <p data-testid="security-ping-summary" className="font-mono text-caption text-on-surface-variant">
                  {last429 === undefined
                    ? 'every ping made it under the limit — wait for the window or check the headers column'
                    : `the 429s arrived with Retry-After: ${last429.retryAfter ?? '?'}s · RateLimit-Limit: ${last429.ratelimitLimit ?? '?'} · RateLimit-Remaining: ${last429.ratelimitRemaining ?? '?'}`}
                  {' · the limiter keys by CLIENT IP — you just spent your own window'}
                  {pingState.lastProblem !== undefined ? ` · ${pingState.lastProblem}` : ''}
                </p>
              );
            })()}
          </div>
        )}

        {handmadeState.kind === 'done' && (
          <div data-testid="security-handmade-results" className="flex flex-col gap-xs">
            <div className="flex flex-wrap gap-xxs">
              {handmadeState.results.map((result) => (
                <span
                  key={result.seq}
                  data-testid="security-handmade-chip"
                  className={result.status < 400 ? CHIP_OK : CHIP_ERROR}
                >
                  {String(result.status)}
                </span>
              ))}
            </div>
            <p className="font-mono text-caption text-on-surface-variant">
              the fixed window at work — 3 pass, the 4th is the envelope + Retry-After; a fresh
              window rolls every 30s
            </p>
          </div>
        )}

        <p className="text-caption text-on-surface-variant">
          200×5 then 429×3 on the first button — the express-rate-limited route; the second button
          trips the hand-rolled twin whose code the topic walks.
        </p>
      </section>

      {/* 3 — CORS */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">3 · CORS verdicts</h3>

        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex flex-1 items-center gap-xxs text-caption text-on-surface-variant">
            origin
            <input
              type="text"
              data-testid="security-cors-input"
              value={corsOrigin}
              onChange={(event) => setCorsOrigin(event.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="security-cors-button"
            onClick={runCorsCheck}
            disabled={corsState.kind === 'loading' || corsOrigin.trim() === ''}
            className={BUTTON_PRIMARY}
          >
            {corsState.kind === 'loading' ? 'checking…' : 'check origin'}
          </button>
        </div>
        <div className="flex flex-wrap gap-xxs">
          {[
            { label: 'allowed: example.com', value: 'https://example.com' },
            { label: 'disallowed: evil.example', value: 'https://evil.example' },
            { label: "the guide's dev origin", value: 'http://localhost:5173' },
          ].map((preset) => (
            <button
              key={preset.value}
              type="button"
              data-testid={`security-cors-preset-${preset.value === 'https://evil.example' ? 'evil' : preset.value === 'http://localhost:5173' ? 'dev' : 'allowed'}`}
              onClick={() => setCorsOrigin(preset.value)}
              className={CHIP}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {corsState.kind === 'idle' && (
          <p data-testid="security-cors-idle" className="text-caption text-on-surface-variant">
            the verdict below comes from the SAME decision function the mounted middleware
            enforces — it cannot disagree with reality
          </p>
        )}
        {corsState.kind === 'failed' && (
          <pre data-testid="security-cors-failed" className={PRE}>
            {corsState.problem}
          </pre>
        )}
        {corsState.kind === 'ready' && (
          <div data-testid="security-cors-verdict" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={corsState.verdict.allowed ? CHIP_OK : CHIP_ERROR}>
                {corsState.verdict.allowed ? 'ALLOWED' : 'DENIED'}
              </span>
              <span className="text-on-surface">{corsState.verdict.origin}</span>
              <span data-testid="security-cors-acao" className="text-on-surface-variant">
                ACAO → {corsState.verdict.accessControlAllowOrigin ?? '(none — the browser blocks the page)'}
              </span>
              {corsState.verdict.credentials && <span className={CHIP}>credentials: on</span>}
            </p>
            <p className="text-caption text-on-surface-variant">
              {corsState.verdict.note} A denial is NOT an error: the request would still RUN —
              the BROWSER is what refuses to hand the response to the calling page.
            </p>
          </div>
        )}
      </section>

      {/* 4 — ssrf guard */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">4 · The SSRF guard</h3>

        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex flex-1 items-center gap-xxs text-caption text-on-surface-variant">
            url
            <input
              type="text"
              data-testid="security-ssrf-input"
              value={ssrfUrl}
              onChange={(event) => setSsrfUrl(event.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="security-ssrf-button"
            onClick={runSsrfCheck}
            disabled={ssrfState.kind === 'loading' || ssrfUrl.trim() === ''}
            className={BUTTON_PRIMARY}
          >
            {ssrfState.kind === 'loading' ? 'checking…' : 'check url'}
          </button>
        </div>
        <div className="flex flex-wrap gap-xxs">
          {[
            { label: 'cloud metadata IP', value: METADATA_URL, testid: 'security-ssrf-preset-metadata' },
            { label: 'hex disguise (0x7f000001)', value: HEX_DISGUISE_URL, testid: 'security-ssrf-preset-hex' },
            { label: 'allowed: httpbin.org', value: ALLOWED_URL, testid: 'security-ssrf-preset-allowed' },
          ].map((preset) => (
            <button
              key={preset.value}
              type="button"
              data-testid={preset.testid}
              onClick={() => setSsrfUrl(preset.value)}
              className={CHIP}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {ssrfState.kind === 'idle' && (
          <p data-testid="security-ssrf-idle" className="text-caption text-on-surface-variant">
            prefilled with the classic target — press check and watch the guard name it. This
            endpoint NEVER fetches anything.
          </p>
        )}
        {ssrfState.kind === 'failed' && (
          <pre data-testid="security-ssrf-failed" className={PRE}>
            {ssrfState.problem}
          </pre>
        )}
        {ssrfState.kind === 'ready' && (
          <div data-testid="security-ssrf-verdict" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={ssrfState.verdict.allowed ? CHIP_OK : CHIP_ERROR}>
                {ssrfState.verdict.allowed ? 'ALLOWED' : 'DENIED'}
              </span>
              <span className={CHIP}>{ssrfState.verdict.kind}</span>
              <span className="text-on-surface-variant">host: {ssrfState.verdict.host}</span>
            </p>
            <p data-testid="security-ssrf-reason" className="font-mono text-caption break-all text-on-surface-variant">
              {ssrfState.verdict.reason}
            </p>
            <p className="text-caption text-on-surface-variant">
              the guard, not the fetch — a real outbound caller consults this verdict BEFORE any
              socket opens (and still has to beat DNS rebinding; see the topic).
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
