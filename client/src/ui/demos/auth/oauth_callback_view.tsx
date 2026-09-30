import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { topicPath } from '../../routing/routes';

/**
 * The OAuth flow's registered redirect target — route /demos/oauth/callback
 * (wired in router.tsx). The provider lands the browser here after the
 * consent decision with either ?code=…&state=… (approve) or ?error=… (deny,
 * most commonly access_denied). This view then completes the remaining acts
 * against the SAME API the rest of the guide talks to (same-origin — the Vite
 * dev server proxies /api):
 *
 *   act II'  the redirect arrived (code + state rendered)
 *   act III  POST /api/demo/oauth/demo-exchange — the demo's stand-in for the
 *            confidential client's BACKEND exchange (secret server-side)
 *   act IV   GET /api/demo/oauth/userinfo with Authorization: Bearer <token>
 *
 * Each act renders as a numbered step as it completes; a denied flow renders
 * the access_denied state instead; a code that cannot be exchanged (replay,
 * 60s expiry) renders the provider's invalid_grant error honestly.
 */

const EXCHANGE_URL = '/api/demo/oauth/demo-exchange';
const USERINFO_URL = '/api/demo/oauth/userinfo';

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  note: string;
}

interface UserInfo {
  username: string;
  displayName: string;
  roles: string[];
}

type ExchangeState =
  | { kind: 'loading' }
  | { kind: 'done'; token: TokenResponse }
  | { kind: 'failed'; status: number; problem: string };

type IdentityState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; identity: UserInfo }
  | { kind: 'failed'; status: number; problem: string };

const BUTTON =
  'inline-flex w-fit items-center gap-xs rounded-md border border-outline bg-primary px-md py-xs text-body-sm font-semibold text-on-primary hover:opacity-90';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';
const STEP_BOX = 'flex flex-col gap-xxs rounded-md border border-outline p-sm';
const STEP_TITLE = 'flex flex-wrap items-center gap-xs font-mono text-body-sm font-semibold text-on-surface';

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** `first…last` — masked middle, because the full token never needs to be on screen. */
function maskTokenMiddle(token: string): string {
  if (token.length <= 28) return token;
  return `${token.slice(0, 20)}…${token.slice(-8)}`;
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

function parseTokenResponse(value: unknown): TokenResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.access_token !== 'string' ||
    typeof record.token_type !== 'string' ||
    typeof record.expires_in !== 'number' ||
    typeof record.scope !== 'string'
  ) {
    return null;
  }
  return {
    access_token: record.access_token,
    token_type: record.token_type,
    expires_in: record.expires_in,
    scope: record.scope,
    note: typeof record.note === 'string' ? record.note : '',
  };
}

function parseUserInfo(value: unknown): UserInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.username !== 'string' || typeof record.displayName !== 'string') return null;
  return {
    username: record.username,
    displayName: record.displayName,
    roles: Array.isArray(record.roles)
      ? record.roles.filter((role): role is string => typeof role === 'string')
      : [],
  };
}

/** The OAuth error shape: {error, error_description} — the spec's language. */
function oauthErrorFromText(text: string): string {
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const record = parsed.value as Record<string, unknown>;
    if (typeof record.error === 'string') {
      return typeof record.error_description === 'string'
        ? `${record.error}: ${record.error_description}`
        : record.error;
    }
  }
  return text;
}

export default function OauthCallbackView(): ReactNode {
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  const [exchange, setExchange] = useState<ExchangeState>({ kind: 'loading' });
  const [identity, setIdentity] = useState<IdentityState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (code === null) return; // denied / empty states render instead
    setExchange({ kind: 'loading' });
    void (async () => {
      try {
        // Act III — the demo-exchange stand-in for the confidential client's
        // backend exchange. redirect_uri must EXACTLY match the authorize
        // request: the code is bound to it at birth.
        const response = await fetch(EXCHANGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            redirect_uri: `${window.location.origin}/demos/oauth/callback`,
          }),
        });
        const bodyText = await readBodyText(response);
        if (!aliveRef.current) return;
        if (response.status >= 400) {
          setExchange({
            kind: 'failed',
            status: response.status,
            problem: oauthErrorFromText(bodyText),
          });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const token = parsed.ok ? parseTokenResponse(parsed.value) : null;
        if (token === null) {
          setExchange({ kind: 'failed', status: response.status, problem: 'unexpected token payload' });
          return;
        }
        setExchange({ kind: 'done', token });

        // Act IV — the API call, Bearer token attached.
        setIdentity({ kind: 'loading' });
        const userinfoResponse = await fetch(USERINFO_URL, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const userinfoText = await readBodyText(userinfoResponse);
        if (!aliveRef.current) return;
        if (userinfoResponse.status >= 400) {
          setIdentity({
            kind: 'failed',
            status: userinfoResponse.status,
            problem: oauthErrorFromText(userinfoText),
          });
          return;
        }
        const parsedIdentity = tryParseJson(userinfoText);
        const maybeIdentity = parsedIdentity.ok ? parseUserInfo(parsedIdentity.value) : null;
        if (maybeIdentity === null) {
          setIdentity({ kind: 'failed', status: userinfoResponse.status, problem: 'unexpected userinfo payload' });
          return;
        }
        setIdentity({ kind: 'done', identity: maybeIdentity });
      } catch {
        if (aliveRef.current) setExchange({ kind: 'failed', status: 0, problem: UNREACHABLE });
      }
    })();
    // One run per landing: the code is single-use anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // --- the denied flow -----------------------------------------------------------------
  if (error !== null && code === null) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-md px-md py-lg">
        <div data-testid="oauth-callback-denied" className="flex flex-col gap-xs rounded-md border border-outline p-md">
          <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
            <span className={CHIP_ERROR}>access_denied</span>
            <span className="text-on-surface-variant">the OAuth flow's honest "no"</span>
          </p>
          <p className="text-body-sm text-on-surface">
            The user pressed <strong>Deny</strong> on the consent page, and the provider redirected
            here with <code className="font-mono">?error=access_denied</code>
            {state !== null ? (
              <>
                {' '}and the state echoed back (<code className="font-mono">{state}</code>) — proof
                this redirect answers THIS flow
              </>
            ) : null}
            . No code was issued, nothing was exchanged, and no token exists. A client app must
            treat this as a first-class outcome — the user said no.
          </p>
          <Link to={topicPath('authentication')} className={BUTTON}>
            ← back to the Authentication topic (try again, or Approve)
          </Link>
        </div>
      </div>
    );
  }

  // --- no flow at all -------------------------------------------------------------------
  if (code === null) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-md px-md py-lg">
        <div data-testid="oauth-callback-empty" className="flex flex-col gap-xs rounded-md border border-outline p-md">
          <h1 className="text-title-md text-on-surface">OAuth callback</h1>
          <p className="text-body-sm text-on-surface-variant">
            This route is the registered redirect_uri of the guide's OAuth demo — landing here
            without <code className="font-mono">?code=…</code> or <code className="font-mono">?error=…</code>{' '}
            means no flow is in progress. Start one from the Authentication topic's OAuth demo.
          </p>
          <Link to={topicPath('authentication')} className={BUTTON}>
            → the Authentication topic
          </Link>
        </div>
      </div>
    );
  }

  // --- the approved flow: the four acts as numbered steps --------------------------------
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-md px-md py-lg">
      <h1 className="text-title-md text-on-surface">OAuth callback — the flow, act by act</h1>

      <div data-testid="oauth-step-redirect" className={STEP_BOX}>
        <p className={STEP_TITLE}>
          <span className={CHIP_OK}>1</span> the redirect arrived
          <span className="text-caption font-normal text-on-surface-variant">act II complete</span>
        </p>
        <p className="font-mono text-caption break-all text-on-surface-variant" data-testid="oauth-callback-code">
          code: {code}
          {state !== null ? ` · state: ${state}` : ''}
        </p>
        <p className="text-caption text-on-surface-variant">
          The provider sent the browser back with a one-time, 60-second code. It crossed the FRONT
          channel — the browser's address bar — so it is built to be useless to anyone who merely
          glimpses it: single-use, short-lived, bound to the client and redirect_uri.
        </p>
      </div>

      <div data-testid="oauth-step-exchange" className={STEP_BOX}>
        <p className={STEP_TITLE}>
          <span className={CHIP_OK}>2</span> the back-channel exchange
          <span className="text-caption font-normal text-on-surface-variant">act III</span>
        </p>
        {exchange.kind === 'loading' && (
          <p data-testid="oauth-exchange-loading" className="text-caption text-on-surface-variant">
            exchanging the code (plus the client_secret, applied server-side)…
          </p>
        )}
        {exchange.kind === 'failed' && (
          <div className="flex flex-col gap-xxs" data-testid="oauth-exchange-failed">
            <p className="font-mono text-caption">
              <span className={CHIP_ERROR}>{exchange.status === 0 ? 'network' : String(exchange.status)}</span>{' '}
              {exchange.problem}
            </p>
            <p className="text-caption text-on-surface-variant">
              The provider refused the exchange — most often because the code was already used
              (single-use) or older than 60 seconds. Reload the flow to mint a fresh one.
            </p>
          </div>
        )}
        {exchange.kind === 'done' && (
          <div className="flex flex-col gap-xxs" data-testid="oauth-exchange-done">
            <p className="font-mono text-caption break-all text-on-surface" data-testid="oauth-token-masked">
              {exchange.token.token_type} {maskTokenMiddle(exchange.token.access_token)}{' '}
              <span className={CHIP}>expires_in {exchange.token.expires_in}s</span>{' '}
              <span className={CHIP}>scope {exchange.token.scope}</span>
            </p>
            <p className="text-caption text-on-surface-variant" data-testid="oauth-exchange-note">
              {exchange.token.note}
            </p>
          </div>
        )}
      </div>

      <div data-testid="oauth-step-userinfo" className={STEP_BOX}>
        <p className={STEP_TITLE}>
          <span className={CHIP_OK}>3</span> the API call
          <span className="text-caption font-normal text-on-surface-variant">act IV</span>
        </p>
        {identity.kind === 'idle' && (
          <p className="text-caption text-on-surface-variant">waiting for the token…</p>
        )}
        {identity.kind === 'loading' && (
          <p data-testid="oauth-userinfo-loading" className="text-caption text-on-surface-variant">
            calling /api/demo/oauth/userinfo with Authorization: Bearer…
          </p>
        )}
        {identity.kind === 'failed' && (
          <p data-testid="oauth-userinfo-failed" className="font-mono text-caption">
            <span className={CHIP_ERROR}>{identity.status === 0 ? 'network' : String(identity.status)}</span>{' '}
            {identity.problem}
          </p>
        )}
        {identity.kind === 'done' && (
          <p className="flex flex-wrap items-center gap-xs font-mono text-caption" data-testid="oauth-userinfo-identity">
            <span className="font-semibold text-on-surface">{identity.identity.displayName}</span>
            <span className="text-on-surface-variant">@{identity.identity.username}</span>
            {identity.identity.roles.map((role) => (
              <span key={role} className={CHIP}>
                {role}
              </span>
            ))}
          </p>
        )}
      </div>

      <Link to={topicPath('authentication')} className={BUTTON}>
        ← back to the Authentication topic
      </Link>
    </div>
  );
}
