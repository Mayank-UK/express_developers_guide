import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `auth:refresh` — refresh-token rotation with reuse
 * detection, over the real endpoints (auth_demo_routes.ts +
 * domain/auth/refresh_store.ts):
 *
 * 1. LOGIN — the hashed-credential login (dana/erin) mints the FIRST pair:
 *    a short-lived access JWT plus an opaque refresh token that opens a token
 *    family. The raw refresh token crosses the wire exactly once — the store
 *    keeps only its sha256 — so this panel is the only place it can ever be
 *    seen.
 * 2. ROTATE — exchange the current refresh token for the NEXT one. The old
 *    token dies (marked 'rotated', kept as evidence) and is SAVED below —
 *    because replaying it is the lesson.
 * 3. REPLAY A SAVED TOKEN — presenting an already-rotated token can only mean
 *    it leaked: the legitimate client holds the newest one. The server revokes
 *    the ENTIRE family (every token, including the current one) and answers a
 *    401 distinguishable from a plain unknown-token 401.
 * 4. FAMILY STATUS — the live chain from the status endpoint: every token the
 *    family ever issued, which is current, rotated, or revoked.
 */

const USERS_URL = '/api/demo/auth/users';
const LOGIN_URL = '/api/demo/auth/credential/login';
const ROTATE_URL = '/api/demo/auth/refresh/rotate';

const familyStatusUrl = (familyId: string): string => `/api/demo/auth/refresh/status/${familyId}`;

interface CredentialIdentity {
  username: string;
  displayName: string;
  passwordHint: string;
}

/** The current pair the demo holds — the raw refresh token exists only client-side. */
interface CurrentPair {
  familyId: string;
  username: string;
  refreshToken: string;
  jwtToken: string;
  jwtExpiresAt: string;
}

/** A rotated token kept for the replay lesson — the thief's copy. */
interface SavedToken {
  masked: string;
  token: string;
}

interface FamilyTokenView {
  n: number;
  tokenMasked: string;
  createdAt: string;
  rotatedAt: string | null;
  state: 'current' | 'rotated' | 'dead' | 'revoked';
}

interface FamilyView {
  familyId: string;
  username: string;
  revoked: boolean;
  revokedReason: string | null;
  tokens: FamilyTokenView[];
  currentTokenMasked: string | null;
}

type UsersState =
  | { kind: 'loading' }
  | { kind: 'ready'; users: CredentialIdentity[] }
  | { kind: 'failed'; problem: string };

type LoginState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed'; problem: string };

type PairState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'issued'; pair: CurrentPair; rotationCount: number }
  | { kind: 'failed'; problem: string };

type ReplayOutcome =
  | { kind: 'reuse-detected'; message: string; familyId?: string }
  | { kind: 'family-revoked'; message: string; familyId?: string }
  | { kind: 'unknown-token'; message: string }
  | { kind: 'failed'; problem: string };

type FamilyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; family: FamilyView }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_DANGER =
  'w-fit rounded-md border border-outline bg-error px-sm py-xs text-body-sm font-semibold text-on-error hover:opacity-90 disabled:opacity-50';
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

/** The error envelope's merged details — rotate's 401s carry reason + familyId. */
function errorRecordFromText(text: string): Record<string, unknown> {
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const error = (parsed.value as Record<string, unknown>).error;
    if (typeof error === 'object' && error !== null) return error as Record<string, unknown>;
  }
  return {};
}

/** One fetch, one body read — { status, bodyText }. */
async function fetchOnce(url: string, init?: RequestInit): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(url, init);
  return { status: response.status, bodyText: await readBodyText(response) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCredentialUsers(value: unknown): CredentialIdentity[] | null {
  if (!isRecord(value) || !Array.isArray(value.credentialUsers)) return null;
  const users = value.credentialUsers.filter(
    (raw): raw is CredentialIdentity =>
      isRecord(raw) &&
      typeof raw.username === 'string' &&
      typeof raw.displayName === 'string' &&
      typeof raw.passwordHint === 'string',
  );
  return users.length > 0 ? users : null;
}

function parseFamily(value: unknown): FamilyView | null {
  if (!isRecord(value) || !isRecord(value.family)) return null;
  const family = value.family;
  if (
    typeof family.familyId !== 'string' ||
    typeof family.username !== 'string' ||
    typeof family.revoked !== 'boolean' ||
    !Array.isArray(family.tokens)
  ) {
    return null;
  }
  const tokens = family.tokens.filter(
    (raw): raw is FamilyTokenView =>
      isRecord(raw) &&
      typeof raw.n === 'number' &&
      typeof raw.tokenMasked === 'string' &&
      typeof raw.state === 'string',
  );
  if (tokens.length === 0) return null;
  return {
    familyId: family.familyId,
    username: family.username,
    revoked: family.revoked,
    revokedReason: typeof family.revokedReason === 'string' ? family.revokedReason : null,
    tokens: tokens.map((token) => ({
      n: token.n,
      tokenMasked: token.tokenMasked,
      createdAt: typeof token.createdAt === 'string' ? token.createdAt : '',
      rotatedAt: typeof token.rotatedAt === 'string' ? token.rotatedAt : null,
      state: token.state,
    })),
    currentTokenMasked:
      typeof family.currentTokenMasked === 'string' ? family.currentTokenMasked : null,
  };
}

export default function RefreshRotationDemo(): ReactNode {
  const [usersState, setUsersState] = useState<UsersState>({ kind: 'loading' });
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loginState, setLoginState] = useState<LoginState>({ kind: 'idle' });

  const [pairState, setPairState] = useState<PairState>({ kind: 'idle' });
  const [savedTokens, setSavedTokens] = useState<SavedToken[]>([]);
  const [replayState, setReplayState] = useState<ReplayOutcome | { kind: 'idle' } | { kind: 'loading' }>({
    kind: 'idle',
  });
  const [familyState, setFamilyState] = useState<FamilyState>({ kind: 'idle' });

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshFamily = (familyId: string): void => {
    setFamilyState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(familyStatusUrl(familyId));
        if (!aliveRef.current) return;
        if (status >= 400) {
          setFamilyState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const family = parsed.ok ? parseFamily(parsed.value) : null;
        if (family === null) {
          setFamilyState({ kind: 'failed', problem: 'unexpected family payload' });
          return;
        }
        setFamilyState({ kind: 'ready', family });
      } catch {
        if (aliveRef.current) setFamilyState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  useEffect(() => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(USERS_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setUsersState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const users = parsed.ok ? parseCredentialUsers(parsed.value) : null;
        if (users === null) {
          setUsersState({ kind: 'failed', problem: 'unexpected users payload' });
          return;
        }
        setUsersState({ kind: 'ready', users });
        setSelectedUsername((current) => current ?? users[0]!.username);
        setPassword((current) => (current === '' ? users[0]!.passwordHint : current));
      } catch {
        if (aliveRef.current) setUsersState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  }, []);

  const login = (): void => {
    if (selectedUsername === null) return;
    setLoginState({ kind: 'loading' });
    setPairState({ kind: 'idle' });
    setSavedTokens([]);
    setReplayState({ kind: 'idle' });
    setFamilyState({ kind: 'idle' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(LOGIN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: selectedUsername, password }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setLoginState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
        const user = record !== null && isRecord(record.user) ? record.user : null;
        const jwt = record !== null && isRecord(record.jwt) ? record.jwt : null;
        const refresh = record !== null && isRecord(record.refresh) ? record.refresh : null;
        if (
          user === null ||
          typeof user.username !== 'string' ||
          jwt === null ||
          typeof jwt.token !== 'string' ||
          typeof jwt.expiresAt !== 'string' ||
          refresh === null ||
          typeof refresh.familyId !== 'string' ||
          typeof refresh.refreshToken !== 'string'
        ) {
          setLoginState({ kind: 'failed', problem: 'unexpected login payload' });
          return;
        }
        setLoginState({ kind: 'idle' });
        setPairState({
          kind: 'issued',
          rotationCount: 0,
          pair: {
            familyId: refresh.familyId,
            username: user.username,
            refreshToken: refresh.refreshToken,
            jwtToken: jwt.token,
            jwtExpiresAt: jwt.expiresAt,
          },
        });
        refreshFamily(refresh.familyId);
      } catch {
        if (aliveRef.current) setLoginState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const rotate = (): void => {
    if (pairState.kind !== 'issued') return;
    const current = pairState.pair;
    setPairState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(ROTATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setPairState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
        const user = record !== null && isRecord(record.user) ? record.user : null;
        const jwt = record !== null && isRecord(record.jwt) ? record.jwt : null;
        const refresh = record !== null && isRecord(record.refresh) ? record.refresh : null;
        if (
          user === null ||
          typeof user.username !== 'string' ||
          jwt === null ||
          typeof jwt.token !== 'string' ||
          typeof jwt.expiresAt !== 'string' ||
          refresh === null ||
          typeof refresh.familyId !== 'string' ||
          typeof refresh.refreshToken !== 'string'
        ) {
          setPairState({ kind: 'failed', problem: 'unexpected rotate payload' });
          return;
        }
        // The PRESENTED token is dead now — save it as the thief's copy.
        const rotatedFromMasked =
          typeof refresh.rotatedFromMasked === 'string' ? refresh.rotatedFromMasked : '…saved';
        setSavedTokens((previous) => [...previous, { masked: rotatedFromMasked, token: current.refreshToken }]);
        const rotationCount =
          typeof refresh.rotationCount === 'number' ? refresh.rotationCount : previousCount(pairState);
        setPairState({
          kind: 'issued',
          rotationCount,
          pair: {
            familyId: refresh.familyId,
            username: user.username,
            refreshToken: refresh.refreshToken,
            jwtToken: jwt.token,
            jwtExpiresAt: jwt.expiresAt,
          },
        });
        refreshFamily(refresh.familyId);
      } catch {
        if (aliveRef.current) setPairState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const replay = (saved: SavedToken): void => {
    setReplayState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(ROTATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: saved.token }),
        });
        if (!aliveRef.current) return;
        const record = errorRecordFromText(bodyText);
        const reason = typeof record.reason === 'string' ? record.reason : undefined;
        const familyId = typeof record.familyId === 'string' ? record.familyId : undefined;
        const message =
          typeof record.message === 'string' ? record.message : errorEnvelopeFromText(bodyText);
        if (status < 400) {
          // A rotated token cannot legitimately rotate again — but degrade
          // honestly rather than crash if the store ever says otherwise.
          setReplayState({ kind: 'unknown-token', message: 'unexpected: the replay was accepted' });
          return;
        }
        if (reason === 'reuse_detected') {
          setReplayState({ kind: 'reuse-detected', message, familyId });
        } else if (reason === 'family_revoked') {
          setReplayState({ kind: 'family-revoked', message, familyId });
        } else {
          setReplayState({ kind: 'unknown-token', message });
        }
        // The family's fate (revoked or not) is on the record now — refetch.
        const focus = familyId ?? (pairState.kind === 'issued' ? pairState.pair.familyId : null);
        if (focus !== null) refreshFamily(focus);
        // Whatever the current token was, a reuse-detected family has killed it.
        if (reason === 'reuse_detected' || reason === 'family_revoked') {
          setPairState({ kind: 'idle' });
        }
      } catch {
        if (aliveRef.current) setReplayState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const users = usersState.kind === 'ready' ? usersState.users : [];
  const family = familyState.kind === 'ready' ? familyState.family : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="refresh-summary" className="text-body-sm text-on-surface">
        Refresh-token rotation with reuse detection: log in as a hashed-credential user to mint the
        first pair (a short-lived JWT + an opaque refresh token), rotate it — the old token dies and
        is saved below — then REPLAY a saved one and watch the server revoke the entire family:
        rotation makes single-use tokens, and reuse is treated as theft.
      </p>

      {/* 1 — login */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          1 · Log in — mint the first pair
        </h3>

        {usersState.kind === 'loading' && (
          <p data-testid="refresh-users-loading" className="text-caption text-on-surface-variant">
            loading the demo identities…
          </p>
        )}
        {usersState.kind === 'failed' && (
          <pre data-testid="refresh-users-failed" className={PRE}>
            {usersState.problem}
          </pre>
        )}

        {usersState.kind === 'ready' && (
          <div data-testid="refresh-user-picker" className="flex flex-col gap-sm sm:flex-row">
            {users.map((user) => (
              <button
                key={user.username}
                type="button"
                data-testid={`refresh-user-${user.username}`}
                onClick={() => {
                  setSelectedUsername(user.username);
                  setPassword(user.passwordHint);
                }}
                className={`${CARD} flex-1 hover:bg-surface-variant ${
                  selectedUsername === user.username ? CARD_SELECTED : ''
                }`}
              >
                <span className="font-mono text-body-sm font-semibold text-on-surface">
                  {user.displayName}
                </span>
                <span className="font-mono text-caption text-on-surface-variant">
                  @{user.username} · password: <code>{user.passwordHint}</code>
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
              data-testid="refresh-login-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface"
            />
          </label>
          <button
            type="button"
            data-testid="refresh-login-button"
            onClick={login}
            disabled={loginState.kind === 'loading' || selectedUsername === null}
            className={BUTTON_PRIMARY}
          >
            {loginState.kind === 'loading' ? 'logging in…' : 'LOGIN'}
          </button>
          <span className="text-caption text-on-surface-variant">
            wrong credentials → the same generic 401 the session login answers
          </span>
        </div>

        {loginState.kind === 'failed' && (
          <pre data-testid="refresh-login-rejected" className={PRE}>
            {loginState.problem}
          </pre>
        )}
      </section>

      {/* 2 — the current pair + rotation */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          2 · The current pair — rotate it
        </h3>

        {pairState.kind === 'idle' && (
          <p data-testid="refresh-pair-idle" className="text-caption text-on-surface-variant">
            no pair yet — log in above (or the last family was revoked: log in again to start a new one)
          </p>
        )}
        {pairState.kind === 'loading' && (
          <p data-testid="refresh-pair-loading" className="text-caption text-on-surface-variant">
            talking to the rotate endpoint…
          </p>
        )}
        {pairState.kind === 'failed' && (
          <pre data-testid="refresh-rotate-failed" className={PRE}>
            {pairState.problem}
          </pre>
        )}

        {pairState.kind === 'issued' && (
          <div data-testid="refresh-issued" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span data-testid="refresh-family-chip" className={CHIP_OK}>
                family {pairState.pair.familyId}
              </span>
              <span className={CHIP}>@{pairState.pair.username}</span>
              <span className={CHIP}>
                {pairState.rotationCount === 0
                  ? 'issued at login'
                  : `rotation #${String(pairState.rotationCount)}`}
              </span>
              <span className="text-on-surface-variant">access JWT expires {pairState.pair.jwtExpiresAt}</span>
            </p>
            <p className="text-caption text-on-surface-variant">
              access JWT (self-contained, minutes to live — verify it in the auth:jwt demo):
            </p>
            <pre data-testid="refresh-access-jwt" className={PRE}>
              {pairState.pair.jwtToken}
            </pre>
            <p className="text-caption text-on-surface-variant">
              refresh token (opaque, family {pairState.pair.familyId} — the raw value crosses the
              wire exactly once; the store keeps only its sha256):
            </p>
            <pre data-testid="refresh-refresh-token" className={PRE}>
              {pairState.pair.refreshToken}
            </pre>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="refresh-rotate-button"
            onClick={rotate}
            disabled={pairState.kind !== 'issued'}
            className={BUTTON_PRIMARY}
          >
            {pairState.kind === 'loading' ? 'rotating…' : 'rotate the current token'}
          </button>
          <span className="text-caption text-on-surface-variant">
            each rotation: new pair, old token marked rotated and SAVED below
          </span>
        </div>

        {pairState.kind === 'issued' && pairState.rotationCount > 0 && (
          <p data-testid="refresh-rotated-note" className="font-mono text-caption text-on-surface-variant">
            rotated — the token you held a moment ago is dead (kept as evidence), a fresh pair is
            above, and the old value sits in the replay list below
          </p>
        )}
      </section>

      {/* 3 — replay a saved (rotated) token */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          3 · Replay a saved (rotated) token — the theft signal
        </h3>

        {savedTokens.length === 0 && (
          <p data-testid="refresh-saved-empty" className="text-caption text-on-surface-variant">
            nothing saved yet — rotate at least once; every rotated token lands here as the copy a
            thief could have made
          </p>
        )}

        {savedTokens.length > 0 && (
          <div data-testid="refresh-saved-tokens" className="flex flex-col gap-xxs">
            {savedTokens.map((saved, index) => (
              <div
                key={`${saved.masked}-${String(index)}`}
                data-testid="refresh-saved-row"
                className="flex flex-wrap items-center gap-xs"
              >
                <span className={CHIP}>{saved.masked}</span>
                <button
                  type="button"
                  data-testid="refresh-replay-button"
                  onClick={() => replay(saved)}
                  disabled={replayState.kind === 'loading'}
                  className={BUTTON_DANGER}
                >
                  replay it
                </button>
              </div>
            ))}
          </div>
        )}

        {replayState.kind === 'loading' && (
          <p data-testid="refresh-replay-loading" className="text-caption text-on-surface-variant">
            presenting the old token to the rotate endpoint…
          </p>
        )}
        {replayState.kind === 'reuse-detected' && (
          <div data-testid="refresh-replay-result" className="flex flex-col gap-xxs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_ERROR}>REUSE DETECTED — FAMILY REVOKED</span>
              {replayState.familyId !== undefined && <span className={CHIP}>{replayState.familyId}</span>}
            </p>
            <pre className={PRE}>{replayState.message}</pre>
            <p className="text-caption text-on-surface-variant">
              the legitimate holder&apos;s CURRENT token died with it — that is deliberate: the
              attacker demonstrably had family material, so nothing in the family is trusted. Log
              in again to open a new family.
            </p>
          </div>
        )}
        {replayState.kind === 'family-revoked' && (
          <div data-testid="refresh-replay-result" className="flex flex-col gap-xxs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_ERROR}>401 — family already revoked</span>
              {replayState.familyId !== undefined && <span className={CHIP}>{replayState.familyId}</span>}
            </p>
            <pre className={PRE}>{replayState.message}</pre>
          </div>
        )}
        {replayState.kind === 'unknown-token' && (
          <div data-testid="refresh-replay-result" className="flex flex-col gap-xxs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_ERROR}>401 — unknown token</span>
            </p>
            <pre className={PRE}>{replayState.message}</pre>
            <p className="text-caption text-on-surface-variant">
              a plain 401 that implicates no family — the store has no record of this token at all.
            </p>
          </div>
        )}
        {replayState.kind === 'failed' && (
          <pre data-testid="refresh-replay-failed" className={PRE}>
            {replayState.problem}
          </pre>
        )}
      </section>

      {/* 4 — family status */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">4 · Family status</h3>
          <button
            type="button"
            data-testid="refresh-refetch-button"
            onClick={() => {
              const focus = family !== null
                ? family.familyId
                : pairState.kind === 'issued'
                  ? pairState.pair.familyId
                  : null;
              if (focus !== null) refreshFamily(focus);
            }}
            disabled={familyState.kind === 'loading' || (family === null && pairState.kind !== 'issued')}
            className={BUTTON}
          >
            {familyState.kind === 'loading' ? 'fetching…' : 'refetch'}
          </button>
        </div>

        {familyState.kind === 'idle' && (
          <p data-testid="refresh-family-idle" className="text-caption text-on-surface-variant">
            the chain appears here after login — every token the family ever issued
          </p>
        )}
        {familyState.kind === 'failed' && (
          <pre data-testid="refresh-family-failed" className={PRE}>
            {familyState.problem}
          </pre>
        )}

        {family !== null && (
          <div data-testid="refresh-family-panel" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_OK}>{family.familyId}</span>
              <span className={CHIP}>@{family.username}</span>
              {family.revoked ? (
                <span data-testid="refresh-family-revoked" className={CHIP_ERROR}>
                  REVOKED{family.revokedReason !== null ? ` (${family.revokedReason})` : ''}
                </span>
              ) : (
                <span data-testid="refresh-family-active" className={CHIP_OK}>
                  active
                </span>
              )}
              <span data-testid="refresh-current-token" className="text-on-surface-variant">
                accepts: {family.currentTokenMasked ?? 'nothing — every token is dead'}
              </span>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-caption">
                <thead>
                  <tr className="text-left text-on-surface-variant">
                    <th className="border-b border-outline px-xs py-xxs">#</th>
                    <th className="border-b border-outline px-xs py-xxs">token</th>
                    <th className="border-b border-outline px-xs py-xxs">state</th>
                    <th className="border-b border-outline px-xs py-xxs">rotated at</th>
                  </tr>
                </thead>
                <tbody data-testid="refresh-family-rows">
                  {family.tokens.map((token) => (
                    <tr key={token.n} data-testid="refresh-family-row">
                      <td className="border-b border-outline px-xs py-xxs">{String(token.n)}</td>
                      <td className="border-b border-outline px-xs py-xxs">{token.tokenMasked}</td>
                      <td className="border-b border-outline px-xs py-xxs">
                        <span
                          data-testid="refresh-token-state"
                          className={
                            token.state === 'current'
                              ? CHIP_OK
                              : token.state === 'rotated'
                                ? CHIP
                                : CHIP_ERROR
                          }
                        >
                          {token.state}
                        </span>
                      </td>
                      <td className="border-b border-outline px-xs py-xxs">{token.rotatedAt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** Fallback rotation count when the response omits it (1 + the last count we showed). */
function previousCount(state: PairState): number {
  return state.kind === 'issued' ? state.rotationCount + 1 : 1;
}
