import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `api:grpc-console` — the gRPC topic's console over the
 * REAL HTTP bridge (grpc_demo_routes.ts). Browsers cannot speak native gRPC,
 * so this console drives the real guide.v1.PostsService through the bridge:
 * status (running/port + the proto source itself), a method selector for the
 * three unary rpcs, an editable JSON payload, and an invoke that renders the
 * gRPC outcome — OK chip + response message, or the status code with its
 * message and the app's failure-kind read back from the trailers.
 */

const STATUS_URL = '/api/demo/grpc/status';
const INVOKE_URL = '/api/demo/grpc/invoke';

const METHODS = ['ListPosts', 'GetPost', 'CreatePost'] as const;
type GrpcMethod = (typeof METHODS)[number];

const PAYLOAD_PREFILL: Record<GrpcMethod, string> = {
  ListPosts: '{}',
  GetPost: '{\n  "id": "post_0000"\n}',
  CreatePost: JSON.stringify(
    {
      title: 'A post over HTTP/2',
      body: 'Browser → HTTP bridge → gRPC → the same posts use case.',
      author: 'you',
    },
    null,
    2,
  ),
};

interface BridgeStatus {
  running: boolean;
  port: number | null;
  service: string;
  methods: { method: string; path: string }[];
  proto: string;
}

interface BridgeInvoke {
  method: string;
  status: string;
  code: number;
  response?: unknown;
  message?: string;
  failure?: { kind: string; errorCode: string };
}

type StatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: BridgeStatus }
  | { kind: 'failed'; problem: string };

type InvokeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: BridgeInvoke }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_SELECTED =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const TEXTAREA =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none disabled:opacity-50';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const PRE =
  'max-h-72 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseBridgeStatus(value: unknown): BridgeStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.service !== 'string' || typeof record.proto !== 'string') return null;
  return {
    running: record.running === true,
    port: typeof record.port === 'number' ? record.port : null,
    service: record.service,
    methods: Array.isArray(record.methods)
      ? record.methods.filter(
          (entry): entry is { method: string; path: string } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { method?: unknown }).method === 'string' &&
            typeof (entry as { path?: unknown }).path === 'string',
        )
      : [],
    proto: record.proto,
  };
}

function parseBridgeInvoke(value: unknown): BridgeInvoke | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.status !== 'string' || typeof record.code !== 'number') return null;
  const failure =
    typeof record.failure === 'object' && record.failure !== null
      ? {
          kind: String((record.failure as Record<string, unknown>).kind ?? '?'),
          errorCode: String((record.failure as Record<string, unknown>).errorCode ?? '?'),
        }
      : undefined;
  return {
    method: typeof record.method === 'string' ? record.method : '?',
    status: record.status,
    code: record.code,
    ...(record.response !== undefined && { response: record.response }),
    ...(typeof record.message === 'string' && { message: record.message }),
    ...(failure !== undefined && { failure }),
  };
}

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

export default function GrpcConsoleDemo(): ReactNode {
  const [statusState, setStatusState] = useState<StatusState>({ kind: 'loading' });
  const [method, setMethod] = useState<GrpcMethod>('ListPosts');
  const [payload, setPayload] = useState<string>(PAYLOAD_PREFILL.ListPosts);
  const [invokeState, setInvokeState] = useState<InvokeState>({ kind: 'idle' });
  const [protoOpen, setProtoOpen] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(STATUS_URL);
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseBridgeStatus(parsed.value) : null;
        if (shaped === null) {
          setStatusState({ kind: 'failed', problem: `status ${String(response.status)} — the answer was not a bridge status:\n${text}` });
          return;
        }
        setStatusState({ kind: 'ready', status: shaped });
      } catch {
        if (aliveRef.current) {
          setStatusState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  }, []);

  const selectMethod = (next: GrpcMethod): void => {
    setMethod(next);
    setPayload(PAYLOAD_PREFILL[next]);
    setInvokeState({ kind: 'idle' });
  };

  /** INVOKE — payload parsed locally; the envelope carries { method, payload }. */
  const invoke = (): void => {
    const parsed = tryParseJson(payload);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      setInvokeState({
        kind: 'failed',
        problem: 'payload must be a JSON object — the rpc was not invoked.',
      });
      return;
    }

    setInvokeState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(INVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, payload: parsed.value }),
        });
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsedBody = tryParseJson(text);
        const shaped = parsedBody.ok ? parseBridgeInvoke(parsedBody.value) : null;
        if (shaped === null) {
          setInvokeState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a bridge outcome:\n${text}`,
          });
          return;
        }
        setInvokeState({ kind: 'answered', outcome: shaped });
      } catch {
        if (aliveRef.current) {
          setInvokeState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const outcome = invokeState.kind === 'answered' ? invokeState.outcome : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="grpc-console-summary" className="text-body-sm text-on-surface">
        Invoke <span className="font-mono">guide.v1.PostsService</span> from the browser: pick an rpc, edit the JSON
        request message, INVOKE — the bridge turns your instruction into a real gRPC call (2s deadline) over HTTP/2 to
        the same posts use case REST and GraphQL use. Error outcomes are the demo:{' '}
        <span className="font-mono">GetPost</span> keeps a placeholder id that answers NOT_FOUND; flip failure
        injection on in the REST workbench topic and every call answers UNAVAILABLE.
      </p>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">service status</h3>
          {statusState.kind === 'ready' && (
            <span
              data-testid="grpc-console-port"
              className="rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant"
            >
              {statusState.status.running
                ? `guide.v1.PostsService · running on :${String(statusState.status.port)}`
                : 'not running yet — the first invoke starts an ephemeral server'}
            </span>
          )}
        </div>
        {statusState.kind === 'loading' && (
          <p data-testid="grpc-console-status-loading" className="text-body-sm text-on-surface-variant">
            checking the gRPC listener…
          </p>
        )}
        {statusState.kind === 'failed' && (
          <pre data-testid="grpc-console-status-failed" className={PRE}>
            {statusState.problem}
          </pre>
        )}
        {statusState.kind === 'ready' && (
          <div className="flex flex-col gap-xs">
            <p data-testid="grpc-console-service" className="font-mono text-caption text-on-surface-variant">
              {statusState.status.service} — {statusState.status.methods.map((entry) => entry.path).join(' · ')}
            </p>
            <button
              type="button"
              data-testid="grpc-console-proto-toggle"
              onClick={() => setProtoOpen((open) => !open)}
              className={BUTTON}
            >
              {protoOpen ? 'hide' : 'show'} the .proto the server loaded
            </button>
            {protoOpen && (
              <pre data-testid="grpc-console-proto" className={PRE}>
                {statusState.status.proto}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          {METHODS.map((entry) => (
            <button
              key={entry}
              type="button"
              data-testid={`grpc-console-method-${entry.toLowerCase()}`}
              onClick={() => selectMethod(entry)}
              className={method === entry ? BUTTON_SELECTED : BUTTON}
            >
              {entry}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-xxs">
          <span className={LABEL}>request message (JSON object)</span>
          <textarea
            data-testid="grpc-console-payload"
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            rows={5}
            spellCheck={false}
            className={TEXTAREA}
          />
        </label>

        <button
          type="button"
          data-testid="grpc-console-invoke"
          onClick={invoke}
          disabled={invokeState.kind === 'loading'}
          className={BUTTON_PRIMARY}
        >
          {invokeState.kind === 'loading' ? 'invoking…' : `invoke ${method}`}
        </button>
      </div>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">gRPC outcome</h3>
          {outcome !== null && (
            <span data-testid="grpc-console-status" className={outcome.code === 0 ? CHIP_OK : CHIP_ERROR}>
              {outcome.status}
            </span>
          )}
          {outcome !== null && (
            <span className="font-mono text-caption text-on-surface-variant">code {String(outcome.code)}</span>
          )}
        </div>

        {invokeState.kind === 'loading' && (
          <p data-testid="grpc-console-loading" className="text-body-sm text-on-surface-variant">
            {method} in flight — browser → HTTP bridge → gRPC over HTTP/2 → posts use case…
          </p>
        )}

        {invokeState.kind === 'failed' && (
          <pre data-testid="grpc-console-failed" className={PRE}>
            {invokeState.problem}
          </pre>
        )}

        {outcome !== null && outcome.code !== 0 && (
          <div data-testid="grpc-console-error" className="flex flex-col gap-xxs">
            <p data-testid="grpc-console-message" className="text-body-sm text-error">
              {outcome.message ?? '(no status message)'}
            </p>
            {outcome.failure !== undefined && (
              <p className="font-mono text-caption text-on-surface-variant">
                failure kind: {outcome.failure.kind} · error code: {outcome.failure.errorCode} — read back from the
                gRPC trailers
              </p>
            )}
          </div>
        )}

        {outcome !== null && outcome.code === 0 && (
          <div data-testid="grpc-console-response-panel" className="flex flex-col gap-xxs">
            <p className="text-body-sm text-on-surface-variant">
              {outcome.method} answered OK — the response message, pretty-printed:
            </p>
            <pre data-testid="grpc-console-response" className={PRE}>
              {JSON.stringify(outcome.response, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
