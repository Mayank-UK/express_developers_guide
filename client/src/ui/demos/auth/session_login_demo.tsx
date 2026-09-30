import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `auth:sessions` — the Authentication topic's login flow
 * over the real endpoints (auth_demo_routes.ts):
 *
 * 1. USER PICKER — the three demo identities from GET /users, password
 *    prefilled (it is the fixed teaching password — completing the flow is
 *    the point).
 * 2. LOGIN → the identity card + the HttpOnly honesty note: browser fetch
 *    hides Set-Cookie from JavaScript, and HttpOnly hides the cookie from
 *    the page even if it tried — so the panel proves the session the honest
 *    way: by calling /me and rendering who the cookie says you are.
 * 3. ME / SESSIONS / LOGOUT — the cookie rides along automatically on every
 *    same-origin request (no code here manages it); 401 envelopes are rendered
 *    as first-class states, because watching them IS the demo after logout.
 */

const USERS_URL = '/api/demo/auth/users';
const LOGIN_URL = '/api/demo/auth/login';
const LOGOUT_URL = '/api/demo/auth/logout';
const ME_URL = '/api/demo/auth/me';
const SESSIONS_URL = '/api/demo/auth/sessions';

interface DemoIdentity {
  username: string;
  displayName: string;
  roles: string[];
  passwordHint: string;
}

interface SessionView {
  createdAt?: string;
  expiresAt: string;
  tokenMasked: string;
}

interface MePayload {
  user: { username: string; displayName: string; roles: string[] };
  session: SessionView;
}

interface SessionRow extends SessionView {
  username: string;
  createdAt: string;
}

type UsersState =
  | { kind: 'loading' }
  | { kind: 'ready'; users: DemoIdentity[] }
  | { kind: 'failed'; problem: string };

type LoginState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'logged-in'; user: MePayload['user']; session: SessionView }
  | { kind: 'rejected'; problem: string }
  | { kind: 'failed'; problem: string };

type CallState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; status: number; body: string }
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
const CARD =
  'flex flex-col gap-xxs rounded-md border border-outline p-sm text-left';
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

/** Parses "code: message" from an error envelope in an ALREADY-READ body text. */
function errorEnvelopeFromText(text: string): string {
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const error = (parsed.value as Record<string, unknown>).error;
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return `${record.code}: ${record.message}`;
    }
  }
  return text;
}

function parseIdentities(value: unknown): DemoIdentity[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const users = (value as { users?: unknown }).users;
  if (!Array.isArray(users)) return null;
  return users.filter(
    (raw): raw is DemoIdentity =>
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { username?: unknown }).username === 'string' &&
      typeof (raw as { displayName?: unknown }).displayName === 'string' &&
      typeof (raw as { passwordHint?: unknown }).passwordHint === 'string',
  );
}

function parseMe(value: unknown): MePayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const user = record.user;
  const session = record.session;
  if (
    typeof user !== 'object' ||
    user === null ||
    typeof (user as { username?: unknown }).username !== 'string'
  ) {
    return null;
  }
  if (
    typeof session !== 'object' ||
    session === null ||
    typeof (session as { tokenMasked?: unknown }).tokenMasked !== 'string'
  ) {
    return null;
  }
  return {
    user: {
      username: (user as { username: string }).username,
      displayName: typeof (user as { displayName?: unknown }).displayName === 'string' ? (user as { displayName: string }).displayName : '',
      roles: Array.isArray((user as { roles?: unknown }).roles)
        ? ((user as { roles: unknown[] }).roles.filter((role): role is string => typeof role === 'string'))
        : [],
    },
    session: session as SessionView,
  };
}

function parseSessions(value: unknown): SessionRow[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return null;
  return sessions.filter(
    (raw): raw is SessionRow =>
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { username?: unknown }).username === 'string' &&
      typeof (raw as { tokenMasked?: unknown }).tokenMasked === 'string',
  );
}

/** One fetch, one body read — { status, bodyText }. */
async function fetchOnce(url: string, init?: RequestInit): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(url, init);
  return { status: response.status, bodyText: await readBodyText(response) };
}

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

export default function SessionLoginDemo(): ReactNode {
  const [usersState, setUsersState] = useState<UsersState>({ kind: 'loading' });
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loginState, setLoginState] = useState<LoginState>({ kind: 'idle' });
  const [meState, setMeState] = useState<CallState>({ kind: 'idle' });
  const [sessionsState, setSessionsState] = useState<CallState>({ kind: 'idle' });
  const [logoutState, setLogoutState] = useState<CallState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadUsers = (): void => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(USERS_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setUsersState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const users = parsed.ok ? parseIdentities(parsed.value) : null;
        if (users === null || users.length === 0) {
          setUsersState({ kind: 'failed', problem: 'unexpected users payload' });
          return;
        }
        setUsersState({ kind: 'ready', users });
        setSelectedUsername((current) => current ?? users[0]!.username);
        // Prefill the shared teaching password — the picker shows it anyway.
        setPassword((current) => (current === '' ? users[0]!.passwordHint : current));
      } catch {
        if (aliveRef.current) setUsersState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const selectUser = (user: DemoIdentity): void => {
    setSelectedUsername(user.username);
    setPassword(user.passwordHint);
  };

  const login = (): void => {
    if (selectedUsername === null) return;
    setLoginState({ kind: 'loading' });
    // credentials: 'same-origin' is fetch's DEFAULT (cookies ride on same-origin
    // requests automatically) — stated explicitly because it is the lesson.
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(LOGIN_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: selectedUsername, password }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setLoginState({ kind: 'rejected', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseMe(parsed.value) : null;
        if (payload === null) {
          setLoginState({ kind: 'failed', problem: 'unexpected login payload' });
          return;
        }
        setLoginState({ kind: 'logged-in', user: payload.user, session: payload.session });
      } catch {
        if (aliveRef.current) setLoginState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const callWithCookie = (
    url: string,
    setter: React.Dispatch<React.SetStateAction<CallState>>,
  ): void => {
    setter({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(url, { credentials: 'same-origin' });
        if (!aliveRef.current) return;
        setter({ kind: 'ready', status, body: bodyText });
      } catch {
        if (aliveRef.current) setter({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const logout = (): void => {
    setLogoutState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(LOGOUT_URL, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!aliveRef.current) return;
        setLogoutState({ kind: 'ready', status, body: bodyText });
        if (status < 400) {
          setLoginState({ kind: 'idle' });
        }
      } catch {
        if (aliveRef.current) setLogoutState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const users = usersState.kind === 'ready' ? usersState.users : [];
  const selected = users.find((user) => user.username === selectedUsername) ?? null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="auth-summary" className="text-body-sm text-on-surface">
        The session login flow, end to end: pick a demo identity (the password is the fixed
        teaching value — completing the flow is the point), log in, then prove the session by
        calling /me, list the server-side sessions, and log out to watch the 401s arrive.
      </p>

      {/* 1 — user picker + login */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">Log in as…</h3>

        {usersState.kind === 'loading' && (
          <p data-testid="auth-users-loading" className="text-caption text-on-surface-variant">
            loading the demo identities…
          </p>
        )}
        {usersState.kind === 'failed' && (
          <pre data-testid="auth-users-failed" className={PRE}>
            {usersState.problem}
          </pre>
        )}

        {usersState.kind === 'ready' && (
          <div data-testid="auth-user-picker" className="flex flex-col gap-sm sm:flex-row">
            {users.map((user) => (
              <button
                key={user.username}
                type="button"
                data-testid={`auth-user-option-${user.username}`}
                onClick={() => selectUser(user)}
                className={`${CARD} flex-1 hover:bg-surface-variant ${
                  selectedUsername === user.username ? CARD_SELECTED : ''
                }`}
              >
                <span className="font-mono text-body-sm font-semibold text-on-surface">
                  {user.displayName}
                </span>
                <span className="font-mono text-caption text-on-surface-variant">
                  @{user.username}
                </span>
                <span className="flex flex-wrap gap-xxs">
                  {user.roles.map((role) => (
                    <span key={role} className={CHIP}>
                      {role}
                    </span>
                  ))}
                </span>
                <span className="font-mono text-caption text-on-surface-variant">
                  password: <code>{user.passwordHint}</code>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex items-center gap-xxs text-caption text-on-surface-variant">
            password
            <input
              type="text"
              data-testid="auth-login-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface"
            />
          </label>
          <button
            type="button"
            data-testid="auth-login-button"
            onClick={login}
            disabled={loginState.kind === 'loading' || selected === null}
            className={BUTTON_PRIMARY}
          >
            {loginState.kind === 'loading' ? 'logging in…' : 'LOGIN'}
          </button>
          <span className="text-caption text-on-surface-variant">
            wrong password → the 401 envelope (one message for both failure modes)
          </span>
        </div>

        {loginState.kind === 'rejected' && (
          <pre data-testid="auth-login-rejected" className={PRE}>
            {loginState.problem}
          </pre>
        )}
        {loginState.kind === 'failed' && (
          <pre data-testid="auth-login-failed" className={PRE}>
            {loginState.problem}
          </pre>
        )}

        {loginState.kind === 'logged-in' && (
          <div data-testid="auth-login-result" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_OK}>logged in</span>
              <span className="font-semibold text-on-surface">{loginState.user.displayName}</span>
              {loginState.user.roles.map((role) => (
                <span key={role} className={CHIP}>
                  {role}
                </span>
              ))}
            </p>
            <p className="font-mono text-caption break-all text-on-surface-variant" data-testid="auth-login-session">
              session: expires {loginState.session.expiresAt} · token masked {loginState.session.tokenMasked}
            </p>
            <p data-testid="auth-httponly-note" className="text-caption text-on-surface-variant">
              The cookie rides automatically — fetch hides Set-Cookie from JavaScript, and HttpOnly
              means even this page's JS can't read it, which is the point. The proof is /me below:
              it answers with who the cookie says you are.
            </p>
          </div>
        )}
      </section>

      {/* 2 — me / sessions / logout */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">Prove the session</h3>
          <button
            type="button"
            data-testid="auth-me-button"
            onClick={() => callWithCookie(ME_URL, setMeState)}
            className={BUTTON}
          >
            ME
          </button>
          <button
            type="button"
            data-testid="auth-sessions-button"
            onClick={() => callWithCookie(SESSIONS_URL, setSessionsState)}
            className={BUTTON}
          >
            SESSIONS
          </button>
          <button
            type="button"
            data-testid="auth-logout-button"
            onClick={logout}
            disabled={logoutState.kind === 'loading'}
            className={BUTTON}
          >
            {logoutState.kind === 'loading' ? 'logging out…' : 'LOGOUT'}
          </button>
        </div>

        {meState.kind === 'ready' && <MeResult state={meState} />}
        {meState.kind === 'failed' && (
          <pre data-testid="auth-me-failed" className={PRE}>
            {meState.problem}
          </pre>
        )}

        {sessionsState.kind === 'ready' && <SessionsResult state={sessionsState} />}
        {sessionsState.kind === 'failed' && (
          <pre data-testid="auth-sessions-failed" className={PRE}>
            {sessionsState.problem}
          </pre>
        )}

        {logoutState.kind === 'ready' && (
          <div data-testid="auth-logout-result" className="flex flex-col gap-xxs">
            {logoutState.status < 400 ? (
              <p className="font-mono text-caption">
                <span className={CHIP_OK}>{String(logoutState.status)}</span> session destroyed —
                Set-Cookie clears the browser copy (Max-Age=0). Press ME again: the 401 envelope is
                the old cookie being dead server-side.
              </p>
            ) : (
              <p className="font-mono text-caption" data-testid="auth-logout-rejected">
                <span className={CHIP_ERROR}>{String(logoutState.status)}</span>{' '}
                {errorEnvelopeFromText(logoutState.body)}
              </p>
            )}
          </div>
        )}
        {logoutState.kind === 'failed' && (
          <pre data-testid="auth-logout-failed" className={PRE}>
            {logoutState.problem}
          </pre>
        )}
      </section>
    </div>
  );
}

/** /me renderer — 200 identity card or the 401 envelope as a first-class state. */
function MeResult({ state }: { state: { status: number; body: string } }): ReactNode {
  if (state.status >= 400) {
    return (
      <div data-testid="auth-me-result" className="flex flex-col gap-xxs">
        <p className="font-mono text-caption">
          <span data-testid="auth-me-status" className={CHIP_ERROR}>
            {String(state.status)} unauthorized
          </span>
        </p>
        <pre className={PRE}>{errorEnvelopeFromText(state.body)}</pre>
      </div>
    );
  }
  const parsed = tryParseJson(state.body);
  const payload = parsed.ok ? parseMe(parsed.value) : null;
  return (
    <div data-testid="auth-me-result" className="flex flex-col gap-xxs">
      <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
        <span data-testid="auth-me-status" className={CHIP_OK}>
          {String(state.status)} — the cookie says:
        </span>
        <span data-testid="auth-me-username" className="font-semibold text-on-surface">
          {payload?.user.displayName ?? '?'} (@{payload?.user.username ?? '?'})
        </span>
        {payload?.user.roles.map((role) => (
          <span key={role} className={CHIP}>
            {role}
          </span>
        ))}
      </p>
      {payload !== null && (
        <p className="font-mono text-caption break-all text-on-surface-variant">
          session since {payload.session.createdAt ?? '?'} · expires {payload.session.expiresAt} ·
          token masked {payload.session.tokenMasked}
        </p>
      )}
    </div>
  );
}

/** /sessions renderer — the active server-side sessions, masked tokens only. */
function SessionsResult({ state }: { state: { status: number; body: string } }): ReactNode {
  if (state.status >= 400) {
    return (
      <div data-testid="auth-sessions-result" className="flex flex-col gap-xxs">
        <p className="font-mono text-caption">
          <span className={CHIP_ERROR}>{String(state.status)} — no session, no listing</span>
        </p>
        <pre className={PRE}>{errorEnvelopeFromText(state.body)}</pre>
      </div>
    );
  }
  const parsed = tryParseJson(state.body);
  const rows = parsed.ok ? parseSessions(parsed.value) : null;
  return (
    <div data-testid="auth-sessions-result" className="flex flex-col gap-xs">
      <p className="text-caption text-on-surface-variant">
        {rows === null ? 'unexpected sessions payload' : `${String(rows.length)} active session(s) — server-side state, masked tokens only:`}
      </p>
      {rows !== null && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-caption">
            <thead>
              <tr className="text-left text-on-surface-variant">
                <th className="border-b border-outline px-xs py-xxs">token</th>
                <th className="border-b border-outline px-xs py-xxs">user</th>
                <th className="border-b border-outline px-xs py-xxs">expires</th>
              </tr>
            </thead>
            <tbody data-testid="auth-sessions-rows">
              {rows.map((row) => (
                <tr key={row.tokenMasked}>
                  <td className="border-b border-outline px-xs py-xxs" data-testid="auth-session-mask">
                    {row.tokenMasked}
                  </td>
                  <td className="border-b border-outline px-xs py-xxs">@{row.username}</td>
                  <td className="border-b border-outline px-xs py-xxs">{row.expiresAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
