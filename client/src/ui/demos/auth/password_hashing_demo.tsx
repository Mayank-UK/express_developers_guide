import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `auth:hashing` — the Authentication topic's
 * credential-storage lesson over the real endpoints (auth_demo_routes.ts +
 * domain/auth/password_hasher.ts):
 *
 * 1. HASH — type a password, get the encoded scrypt string back plus the
 *    field-by-field parse (primitive / N / r / p / salt). Hash the same
 *    password twice: a NEW salt means a different string every time — only
 *    the format and the cost parameters stay fixed.
 * 2. VERIFY — the round trip: a candidate password against a produced (or
 *    pasted) hash. The server re-derives with the SAME salt + params and
 *    compares in constant time → matches: true | false, HTTP 200 BOTH ways;
 *    a malformed hash string is the mis-use guard's 400 envelope.
 * 3. CREDENTIAL LOGIN — dana/erin, the fixture whose passwords the store
 *    holds ONLY as scrypt hashes. Wrong credentials → ONE generic 401 for
 *    both failure modes (a login error that says "wrong password" confirms
 *    the username exists — the UI never says which half was wrong either).
 */

const USERS_URL = '/api/demo/auth/users';
const HASH_URL = '/api/demo/auth/hashing/hash';
const VERIFY_URL = '/api/demo/auth/hashing/verify';
const CREDENTIAL_LOGIN_URL = '/api/demo/auth/credential/login';

interface CredentialIdentity {
  username: string;
  displayName: string;
  roles: string[];
  passwordHint: string;
}

/** The parse that rides along with every encoded hash — the format is the contract. */
interface HashParsed {
  primitive: string;
  N: number;
  r: number;
  p: number;
  saltB64: string;
  hashB64: string;
}

type UsersState =
  | { kind: 'loading' }
  | { kind: 'ready'; users: CredentialIdentity[] }
  | { kind: 'failed'; problem: string };

type HashState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'hashed'; hash: string; parsed: HashParsed }
  | { kind: 'failed'; problem: string };

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; matches: boolean }
  | { kind: 'failed'; problem: string };

type LoginState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'logged-in'; displayName: string; username: string; roles: string[]; jwtExpiresAt: string; familyId: string }
  | { kind: 'rejected'; problem: string }
  | { kind: 'failed'; problem: string };

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

function parseHashPayload(value: unknown): { hash: string; parsed: HashParsed } | null {
  if (!isRecord(value) || typeof value.hash !== 'string' || !isRecord(value.parsed)) return null;
  const parsed = value.parsed;
  if (
    typeof parsed.primitive !== 'string' ||
    typeof parsed.N !== 'number' ||
    typeof parsed.r !== 'number' ||
    typeof parsed.p !== 'number' ||
    typeof parsed.saltB64 !== 'string' ||
    typeof parsed.hashB64 !== 'string'
  ) {
    return null;
  }
  return {
    hash: value.hash,
    parsed: {
      primitive: parsed.primitive,
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      saltB64: parsed.saltB64,
      hashB64: parsed.hashB64,
    },
  };
}

export default function PasswordHashingDemo(): ReactNode {
  // panel 3's fixture users
  const [usersState, setUsersState] = useState<UsersState>({ kind: 'loading' });
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginState, setLoginState] = useState<LoginState>({ kind: 'idle' });

  // panel 1 — the hash playground
  const [hashPassword, setHashPassword] = useState('correct horse battery staple');
  const [hashState, setHashState] = useState<HashState>({ kind: 'idle' });

  // panel 2 — the verify round trip (hash field auto-fills from panel 1)
  const [verifyPassword, setVerifyPassword] = useState('correct horse battery staple');
  const [verifyHash, setVerifyHash] = useState('');
  const [verifyState, setVerifyState] = useState<VerifyState>({ kind: 'idle' });

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
        setLoginPassword((current) => (current === '' ? users[0]!.passwordHint : current));
      } catch {
        if (aliveRef.current) setUsersState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  }, []);

  const runHash = (): void => {
    if (hashPassword === '') return;
    setHashState({ kind: 'loading' });
    setVerifyState({ kind: 'idle' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(HASH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: hashPassword }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setHashState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseHashPayload(parsed.value) : null;
        if (payload === null) {
          setHashState({ kind: 'failed', problem: 'unexpected hash payload' });
          return;
        }
        setHashState({ kind: 'hashed', ...payload });
        // The round trip starts here: the verify panel gets the fresh hash.
        setVerifyHash(payload.hash);
      } catch {
        if (aliveRef.current) setHashState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const runVerify = (): void => {
    if (verifyPassword === '' || verifyHash === '') return;
    setVerifyState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(VERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: verifyPassword, hash: verifyHash }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          // 200 both ways for a WELL-FORMED hash; the 400 envelope is the
          // mis-use guard (malformed hash string) — a first-class teaching
          // state, not a crash.
          setVerifyState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
        if (record === null || typeof record.matches !== 'boolean') {
          setVerifyState({ kind: 'failed', problem: 'unexpected verify payload' });
          return;
        }
        setVerifyState({ kind: 'done', matches: record.matches });
      } catch {
        if (aliveRef.current) setVerifyState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const credentialLogin = (): void => {
    if (selectedUsername === null) return;
    setLoginState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(CREDENTIAL_LOGIN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: selectedUsername, password: loginPassword }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setLoginState({ kind: 'rejected', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
        const user = record !== null && isRecord(record.user) ? record.user : null;
        const jwt = record !== null && isRecord(record.jwt) ? record.jwt : null;
        const refresh = record !== null && isRecord(record.refresh) ? record.refresh : null;
        if (
          user === null ||
          typeof user.displayName !== 'string' ||
          typeof user.username !== 'string' ||
          jwt === null ||
          typeof jwt.expiresAt !== 'string' ||
          refresh === null ||
          typeof refresh.familyId !== 'string'
        ) {
          setLoginState({ kind: 'failed', problem: 'unexpected login payload' });
          return;
        }
        setLoginState({
          kind: 'logged-in',
          displayName: user.displayName,
          username: user.username,
          roles: Array.isArray(user.roles)
            ? user.roles.filter((role): role is string => typeof role === 'string')
            : [],
          jwtExpiresAt: jwt.expiresAt,
          familyId: refresh.familyId,
        });
      } catch {
        if (aliveRef.current) setLoginState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const users = usersState.kind === 'ready' ? usersState.users : [];

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="hashing-summary" className="text-body-sm text-on-surface">
        The credential-storage lesson, live: hash a password with scrypt and read the encoded
        string&apos;s parts, verify a candidate against it (the same salt + params re-derive the key
        — the password is never &quot;decrypted&quot;), then log in as dana or erin, whose
        passwords the store holds only as hashes like these.
      </p>

      {/* 1 — the hash playground */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          1 · Hash a password
        </h3>

        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex flex-1 items-center gap-xxs text-caption text-on-surface-variant">
            password
            <input
              type="text"
              data-testid="hashing-password-input"
              value={hashPassword}
              onChange={(event) => setHashPassword(event.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="hashing-hash-button"
            onClick={runHash}
            disabled={hashState.kind === 'loading' || hashPassword === ''}
            className={BUTTON_PRIMARY}
          >
            {hashState.kind === 'loading' ? 'hashing…' : 'hash it'}
          </button>
        </div>

        {hashState.kind === 'failed' && (
          <pre data-testid="hashing-hash-failed" className={PRE}>
            {hashState.problem}
          </pre>
        )}

        {hashState.kind === 'hashed' && (
          <div data-testid="hashing-hash-result" className="flex flex-col gap-xs">
            <code data-testid="hashing-hash-string" className="break-all font-mono text-caption text-on-surface">
              {hashState.hash}
            </code>
            <div className="flex flex-col gap-xxs">
              {(
                [
                  ['primitive', hashState.parsed.primitive],
                  ['N (CPU/memory cost)', String(hashState.parsed.N)],
                  ['r (block size)', String(hashState.parsed.r)],
                  ['p (parallelization)', String(hashState.parsed.p)],
                  ['salt (base64url)', hashState.parsed.saltB64],
                ] as const
              ).map(([field, value]) => (
                <p key={field} data-testid="hashing-parsed-row" className="flex flex-wrap gap-xxs font-mono text-caption">
                  <span className="text-on-surface-variant">{field}</span>
                  <span className="break-all text-on-surface">{value}</span>
                </p>
              ))}
            </div>
            <p className="text-caption text-on-surface-variant">
              hash the SAME password again — new salt, different string; the store never compares
              passwords, it compares derivations.
            </p>
          </div>
        )}
      </section>

      {/* 2 — the verify round trip */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          2 · Verify a password against a hash
        </h3>

        <div className="flex flex-col gap-xs sm:flex-row sm:flex-wrap sm:items-center">
          <label className="flex flex-1 items-center gap-xxs text-caption text-on-surface-variant">
            candidate password
            <input
              type="text"
              data-testid="hashing-verify-password"
              value={verifyPassword}
              onChange={(event) => setVerifyPassword(event.target.value)}
              className={INPUT}
            />
          </label>
        </div>
        <label className="flex flex-col gap-xxs text-caption text-on-surface-variant">
          encoded hash (auto-filled from panel 1 — paste any produced hash)
          <input
            type="text"
            data-testid="hashing-verify-hash-input"
            value={verifyHash}
            onChange={(event) => setVerifyHash(event.target.value)}
            className={`${INPUT} max-w-full`}
          />
        </label>

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="hashing-verify-button"
            onClick={runVerify}
            disabled={verifyState.kind === 'loading' || verifyPassword === '' || verifyHash === ''}
            className={BUTTON_PRIMARY}
          >
            {verifyState.kind === 'loading' ? 'verifying…' : 'verify'}
          </button>
          <span className="text-caption text-on-surface-variant">
            the verdict is data, HTTP 200 both ways — true or false, never an error
          </span>
        </div>

        {verifyState.kind === 'done' && (
          <p data-testid="hashing-verify-verdict" className="flex flex-wrap items-center gap-xs font-mono text-caption">
            {verifyState.matches ? (
              <span className={CHIP_OK}>MATCHES</span>
            ) : (
              <span className={CHIP_ERROR}>DOES NOT MATCH</span>
            )}
            <span className="text-on-surface-variant">
              {verifyState.matches
                ? 'same password, same salt + params → identical derivation'
                : 'a single differing byte fails the whole comparison (timing-safe, no early exit)'}
            </span>
          </p>
        )}
        {verifyState.kind === 'failed' && (
          <pre data-testid="hashing-verify-failed" className={PRE}>
            {verifyState.problem}
          </pre>
        )}
      </section>

      {/* 3 — credential login over hashed passwords */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          3 · Log in as a hashed-credential user
        </h3>

        {usersState.kind === 'loading' && (
          <p data-testid="hashing-users-loading" className="text-caption text-on-surface-variant">
            loading the demo identities…
          </p>
        )}
        {usersState.kind === 'failed' && (
          <pre data-testid="hashing-users-failed" className={PRE}>
            {usersState.problem}
          </pre>
        )}

        {usersState.kind === 'ready' && (
          <div data-testid="hashing-cred-picker" className="flex flex-col gap-sm sm:flex-row">
            {users.map((user) => (
              <button
                key={user.username}
                type="button"
                data-testid={`hashing-cred-user-${user.username}`}
                onClick={() => {
                  setSelectedUsername(user.username);
                  setLoginPassword(user.passwordHint);
                }}
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
              data-testid="hashing-cred-password"
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
              className="rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface"
            />
          </label>
          <button
            type="button"
            data-testid="hashing-cred-login-button"
            onClick={credentialLogin}
            disabled={loginState.kind === 'loading' || selectedUsername === null}
            className={BUTTON_PRIMARY}
          >
            {loginState.kind === 'loading' ? 'logging in…' : 'LOGIN'}
          </button>
          <span className="text-caption text-on-surface-variant">
            wrong credentials → one generic 401 for both failure modes
          </span>
        </div>

        {loginState.kind === 'rejected' && (
          <pre data-testid="hashing-cred-rejected" className={PRE}>
            {loginState.problem}
          </pre>
        )}
        {loginState.kind === 'failed' && (
          <pre data-testid="hashing-cred-failed" className={PRE}>
            {loginState.problem}
          </pre>
        )}

        {loginState.kind === 'logged-in' && (
          <div data-testid="hashing-cred-result" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_OK}>logged in</span>
              <span className="font-semibold text-on-surface">{loginState.displayName}</span>
              {loginState.roles.map((role) => (
                <span key={role} className={CHIP}>
                  {role}
                </span>
              ))}
            </p>
            <p className="font-mono text-caption break-all text-on-surface-variant">
              the hash verified: a session cookie was set, a JWT expires {loginState.jwtExpiresAt},
              and refresh family {loginState.familyId} was opened — the demos below take each of
              those apart.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
