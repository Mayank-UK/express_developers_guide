import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `auth:api-keys` — the Authentication topic's second
 * credential family over the real endpoints (auth_demo_routes.ts):
 *
 * 1. KEY CARDS — the three fixed demo keys from GET /keys, selectable, the
 *    key string copyable, scopes as chips (gsk_ = "guide secret key", the
 *    mirror of real vendor prefixes like stripe's sk_).
 * 2. CALL /api-protected (any valid key) and CALL /api-admin (needs the
 *    admin:demos scope) — the selected key rides the x-api-key header, and
 *    the response panel renders 200 identities and 401/403 envelopes with
 *    equal honesty: bob's valid key earning the 403 is half the lesson.
 * 3. A per-key curl snippet — the exact terminal command for the selection.
 */

const KEYS_URL = '/api/demo/auth/keys';
const PROTECTED_URL = '/api/demo/auth/api-protected';
const ADMIN_URL = '/api/demo/auth/api-admin';

interface DemoKey {
  key: string;
  username: string;
  scopes: string[];
}

type KeysState =
  | { kind: 'loading' }
  | { kind: 'ready'; keys: DemoKey[] }
  | { kind: 'failed'; problem: string };

type CallState =
  | { kind: 'idle' }
  | { kind: 'loading'; endpoint: string }
  | { kind: 'ready'; endpoint: string; status: number; bodyText: string }
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
const CARD = 'flex flex-col gap-xxs rounded-md border border-outline p-sm text-left';
const CARD_SELECTED = 'border-primary bg-surface-variant';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

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

/** Pretty-prints a JSON body, extracting the envelope's code for the status line. */
function describeBody(bodyText: string): { pretty: string; code: string | null } {
  const parsed = tryParseJson(bodyText);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return { pretty: bodyText, code: null };
  }
  const error = (parsed.value as Record<string, unknown>).error;
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  return {
    pretty: JSON.stringify(parsed.value, null, 2),
    code: typeof record.code === 'string' ? record.code : null,
  };
}

function parseKeys(value: unknown): DemoKey[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  return keys.filter(
    (raw): raw is DemoKey =>
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { key?: unknown }).key === 'string' &&
      typeof (raw as { username?: unknown }).username === 'string',
  );
}

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

export default function ApiKeyDemo(): ReactNode {
  const [keysState, setKeysState] = useState<KeysState>({ kind: 'loading' });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [callState, setCallState] = useState<CallState>({ kind: 'idle' });
  const [copied, setCopied] = useState<string | null>(null);
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
        const response = await fetch(KEYS_URL);
        const bodyText = await readBodyText(response);
        if (!aliveRef.current) return;
        if (response.status >= 400) {
          const parsed = tryParseJson(bodyText);
          setKeysState({ kind: 'failed', problem: parsed.ok ? bodyText : UNREACHABLE });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const keys = parsed.ok ? parseKeys(parsed.value) : null;
        if (keys === null || keys.length === 0) {
          setKeysState({ kind: 'failed', problem: 'unexpected keys payload' });
          return;
        }
        setKeysState({ kind: 'ready', keys });
        setSelectedKey((current) => current ?? keys[0]!.key);
      } catch {
        if (aliveRef.current) setKeysState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  }, []);

  const keys = keysState.kind === 'ready' ? keysState.keys : [];
  const selected = keys.find((entry) => entry.key === selectedKey) ?? null;

  const call = (endpoint: string, url: string): void => {
    if (selected === null) return;
    setCallState({ kind: 'loading', endpoint });
    void (async () => {
      try {
        const response = await fetch(url, { headers: { 'x-api-key': selected.key } });
        const bodyText = await readBodyText(response);
        if (!aliveRef.current) return;
        setCallState({ kind: 'ready', endpoint, status: response.status, bodyText });
      } catch {
        if (aliveRef.current) setCallState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const copyKey = (key: string): void => {
    // Clipboard API guarded: jsdom and non-secure contexts may not provide it.
    const clipboard: unknown = (navigator as { clipboard?: unknown }).clipboard;
    if (
      typeof clipboard === 'object' &&
      clipboard !== null &&
      typeof (clipboard as { writeText?: unknown }).writeText === 'function'
    ) {
      void (clipboard as { writeText: (text: string) => Promise<void> })
        .writeText(key)
        .then(() => {
          if (aliveRef.current) setCopied(key);
        })
        .catch(() => undefined);
    }
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="auth-keys-summary" className="text-body-sm text-on-surface">
        Machine identity: the three fixed demo keys, one per user, scopes attached to the KEY
        (gsk_ = "guide secret key" — the mirror of real conventions like stripe's sk_). Pick a
        key, call the protected endpoint (any valid key passes), then the admin endpoint —
        alice carries admin:demos, bob does not, and the 403 names what was missing.
      </p>

      {/* 1 — the key cards */}
      {keysState.kind === 'loading' && (
        <p data-testid="auth-keys-loading" className="text-caption text-on-surface-variant">
          loading the demo keys…
        </p>
      )}
      {keysState.kind === 'failed' && (
        <pre data-testid="auth-keys-failed" className={PRE}>
          {keysState.problem}
        </pre>
      )}

      {keysState.kind === 'ready' && (
        <div data-testid="auth-key-cards" className="flex flex-col gap-sm sm:flex-row">
          {keys.map((entry) => (
            <button
              key={entry.key}
              type="button"
              data-testid={`auth-key-card-${entry.username}`}
              onClick={() => setSelectedKey(entry.key)}
              className={`${CARD} flex-1 hover:bg-surface-variant ${
                selectedKey === entry.key ? CARD_SELECTED : ''
              }`}
            >
              <span className="font-mono text-body-sm font-semibold text-on-surface">
                @{entry.username}
              </span>
              <code
                data-testid={`auth-key-value-${entry.username}`}
                className="break-all rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface"
              >
                {entry.key}
              </code>
              <span className="flex flex-wrap gap-xxs">
                {entry.scopes.map((scope) => (
                  <span key={scope} className={CHIP}>
                    {scope}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 2 — the calls */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="auth-call-protected"
            onClick={() => call('api-protected', PROTECTED_URL)}
            disabled={callState.kind === 'loading' || selected === null}
            className={BUTTON}
          >
            call /api-protected
          </button>
          <button
            type="button"
            data-testid="auth-call-admin"
            onClick={() => call('api-admin', ADMIN_URL)}
            disabled={callState.kind === 'loading' || selected === null}
            className={BUTTON_PRIMARY}
          >
            call /api-admin (needs admin:demos)
          </button>
          <span className="text-caption text-on-surface-variant">
            the selected key rides the <code>x-api-key</code> header
          </span>
        </div>

        {selected !== null && (
          <div className="flex flex-wrap items-center gap-sm">
            <button
              type="button"
              data-testid={`auth-key-copy-${selected.username}`}
              onClick={() => copyKey(selected.key)}
              className={BUTTON}
            >
              copy @{selected.username}'s key
            </button>
            {copied === selected.key && (
              <span data-testid={`auth-key-copied-${selected.username}`} className={CHIP_OK}>
                copied
              </span>
            )}
          </div>
        )}

        {callState.kind === 'loading' && (
          <p data-testid="auth-api-loading" className="text-caption text-on-surface-variant">
            calling /api/demo/auth/{callState.endpoint} with the selected key…
          </p>
        )}
        {callState.kind === 'failed' && (
          <pre data-testid="auth-api-failed" className={PRE}>
            {callState.problem}
          </pre>
        )}
        {callState.kind === 'ready' && <CallResult state={callState} />}
      </section>

      {/* 3 — the per-key curl snippet */}
      {selected !== null && (
        <section className="flex flex-col gap-xs rounded-md border border-outline p-sm">
          <p className="font-mono text-body-sm font-semibold text-on-surface">
            From a terminal, with @{selected.username}'s key:
          </p>
          <pre data-testid="auth-curl-snippet" className={PRE}>
            {`curl -s -H 'x-api-key: ${selected.key}' \\\n  localhost:4000/api/demo/auth/api-protected | jq\n\ncurl -s -H 'x-api-key: ${selected.key}' \\\n  localhost:4000/api/demo/auth/api-admin | jq`}
          </pre>
        </section>
      )}
    </div>
  );
}

/** The response panel: 200 identity vs 401/403 envelope, both first-class. */
function CallResult({
  state,
}: {
  state: { endpoint: string; status: number; bodyText: string };
}): ReactNode {
  const { pretty, code } = describeBody(state.bodyText);
  const ok = state.status < 400;
  return (
    <div data-testid="auth-api-result" className="flex flex-col gap-xs">
      <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
        <span data-testid="auth-api-status" className={ok ? CHIP_OK : CHIP_ERROR}>
          {String(state.status)} {state.endpoint}
        </span>
        {code !== null && (
          <span data-testid="auth-api-code" className={CHIP_ERROR}>
            {code}
          </span>
        )}
        {!ok && state.status === 403 && (
          <span data-testid="auth-api-scope-note" className="text-on-surface-variant">
            authenticated (the key is valid) but not permitted — the scope check is what failed
          </span>
        )}
      </p>
      <pre data-testid="auth-api-body" className={PRE}>
        {pretty}
      </pre>
    </div>
  );
}
