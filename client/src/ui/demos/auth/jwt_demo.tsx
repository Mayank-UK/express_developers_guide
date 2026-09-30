import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `auth:jwt` — the Authentication topic's token workbench
 * over the real endpoints (auth_demo_routes.ts + domain/auth/jwt_service.ts):
 *
 * 1. USER PICKER + ISSUE — the token renders SPLIT INTO ITS THREE SEGMENTS
 *    (header / payload / signature, color-coded), each decoded IN THE PAGE by
 *    a tiny base64url decoder — the payload is readable by anyone holding the
 *    token (signed is not encrypted), and seeing it is the lesson.
 * 2. VERIFY — the server's verdict, 200 both ways: valid + payload, or
 *    invalid + reason (signature mismatch / token expired / malformed).
 * 3. TAMPER — rewrites the payload's claims (sub → admin) while KEEPING the
 *    signature, so VERIFY demonstrates the signature refusing a forged
 *    payload. The signature segment is never touched — the mismatch is the
 *    point.
 * 4. ISSUE 2-SECOND TOKEN — a countdown to exp; VERIFY then returns
 *    "token expired".
 * 5. CALL jwt-protected — the Bearer header in action: 200 identity or 401.
 */

const USERS_URL = '/api/demo/auth/users';
const ISSUE_URL = '/api/demo/auth/jwt/issue';
const VERIFY_URL = '/api/demo/auth/jwt/verify';
const PROTECTED_URL = '/api/demo/auth/jwt-protected';

interface DemoIdentity {
  username: string;
  displayName: string;
  roles: string[];
  passwordHint: string;
}

interface IssuedToken {
  token: string;
  expiresAt: string;
  ttlSeconds: number;
  expEpochSeconds: number;
}

type UsersState =
  | { kind: 'loading' }
  | { kind: 'ready'; users: DemoIdentity[] }
  | { kind: 'failed'; problem: string };

type IssueState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'issued'; issued: IssuedToken }
  | { kind: 'failed'; problem: string };

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; valid: boolean; payload?: unknown; reason?: string; reasonCode?: string }
  | { kind: 'failed'; problem: string };

type BearerState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; status: number; bodyText: string }
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

/** The three segments' color coding — header primary, payload secondary, signature warning. */
const SEGMENT_LABEL_HEADER =
  'rounded-md bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const SEGMENT_LABEL_PAYLOAD =
  'rounded-md bg-secondary px-xs py-xxs font-mono text-caption font-semibold text-on-secondary';
const SEGMENT_LABEL_SIGNATURE =
  'rounded-md border border-warning px-xs py-xxs font-mono text-caption font-semibold text-warning';
const SEGMENT_BOX_HEADER = 'flex flex-col gap-xxs rounded-md border border-l-4 border-outline border-l-primary p-sm';
const SEGMENT_BOX_PAYLOAD = 'flex flex-col gap-xxs rounded-md border border-l-4 border-outline border-l-secondary p-sm';
const SEGMENT_BOX_SIGNATURE = 'flex flex-col gap-xxs rounded-md border border-l-4 border-outline border-l-warning p-sm';

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Pretty-prints JSON bodies for display; passes plain text through. */
function prettyJsonOrText(text: string): string {
  const parsed = tryParseJson(text);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
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

/** Tiny base64url decoder — the payload was never a secret, and the page proves it. */
function decodeBase64Url(segment: string): string | null {
  try {
    const base64 = segment.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

/** Decodes one segment to pretty JSON for display (null when it isn't JSON). */
function decodeSegmentJson(segment: string): string | null {
  const decoded = decodeBase64Url(segment);
  if (decoded === null) return null;
  const parsed = tryParseJson(decoded);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : null;
}

function encodeBase64Url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * The tamper: rewrite the payload's CLAIMS (sub → admin) and re-encode it,
 * leaving header and signature untouched. Editing claims while keeping the
 * signature is the honest forgery — and keeping the payload valid JSON
 * guarantees the verdict is "signature mismatch", not a decode error.
 */
function tamperToken(token: string): string {
  const segments = token.split('.');
  if (segments.length !== 3) return token;
  const [header = '', payloadSegment = '', signature = ''] = segments;
  const decoded = decodeBase64Url(payloadSegment);
  if (decoded === null) return token;
  const parsed = tryParseJson(decoded);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return token;
  const claims = { ...(parsed.value as Record<string, unknown>), sub: 'admin', roles: ['admin'] };
  return `${header}.${encodeBase64Url(JSON.stringify(claims))}.${signature}`;
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
      Array.isArray((raw as { roles?: unknown }).roles) &&
      (raw as { roles: unknown[] }).roles.every((role) => typeof role === 'string'),
  );
}

interface IssueResponse {
  token: string;
  decoded: { payload: { exp: number; iat: number } };
  expiresAt: string;
}

function parseIssueResponse(value: unknown): IssueResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const token = record.token;
  const decoded = record.decoded;
  if (typeof token !== 'string' || typeof decoded !== 'object' || decoded === null) return null;
  const payload = (decoded as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const exp = (payload as { exp?: unknown }).exp;
  const iat = (payload as { iat?: unknown }).iat;
  if (typeof exp !== 'number' || typeof iat !== 'number') return null;
  return { token, decoded: { payload: { exp, iat } }, expiresAt: String(record.expiresAt ?? '') };
}

/** One fetch, one body read — { status, bodyText }. */
async function fetchOnce(url: string, init?: RequestInit): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(url, init);
  return { status: response.status, bodyText: await readBodyText(response) };
}

export default function JwtDemo(): ReactNode {
  const [usersState, setUsersState] = useState<UsersState>({ kind: 'loading' });
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [issueState, setIssueState] = useState<IssueState>({ kind: 'idle' });
  const [verifyState, setVerifyState] = useState<VerifyState>({ kind: 'idle' });
  const [bearerState, setBearerState] = useState<BearerState>({ kind: 'idle' });
  const [tamper, setTamper] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // The countdown clock: ticks while a token is on screen so the expiry demo
  // has a visible second hand (VERIFY asks the SERVER for the real verdict).
  const countdownActive = issueState.kind === 'issued';
  useEffect(() => {
    if (!countdownActive) return;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [countdownActive]);

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
        const users = parsed.ok ? parseIdentities(parsed.value) : null;
        if (users === null || users.length === 0) {
          setUsersState({ kind: 'failed', problem: 'unexpected users payload' });
          return;
        }
        setUsersState({ kind: 'ready', users });
        setSelectedUsername((current) => current ?? users[0]!.username);
      } catch {
        if (aliveRef.current) setUsersState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  }, []);

  const issue = (ttlSeconds: number): void => {
    if (selectedUsername === null) return;
    setIssueState({ kind: 'loading' });
    setVerifyState({ kind: 'idle' });
    setBearerState({ kind: 'idle' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(ISSUE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: selectedUsername, ttlSeconds }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setIssueState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseIssueResponse(parsed.value) : null;
        if (payload === null || payload.token.split('.').length !== 3) {
          setIssueState({ kind: 'failed', problem: 'unexpected issue payload' });
          return;
        }
        setNowMs(Date.now());
        setIssueState({
          kind: 'issued',
          issued: {
            token: payload.token,
            expiresAt: payload.expiresAt,
            ttlSeconds: payload.decoded.payload.exp - payload.decoded.payload.iat,
            expEpochSeconds: payload.decoded.payload.exp,
          },
        });
      } catch {
        if (aliveRef.current) setIssueState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const issuedToken = issueState.kind === 'issued' ? issueState.issued.token : null;
  const effectiveToken = useMemo(() => {
    if (issuedToken === null) return null;
    return tamper ? tamperToken(issuedToken) : issuedToken;
  }, [issuedToken, tamper]);

  const verify = (): void => {
    if (effectiveToken === null) return;
    setVerifyState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(VERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: effectiveToken }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setVerifyState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record =
          parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
            ? (parsed.value as Record<string, unknown>)
            : null;
        if (record === null || typeof record.valid !== 'boolean') {
          setVerifyState({ kind: 'failed', problem: 'unexpected verify payload' });
          return;
        }
        setVerifyState({
          kind: 'done',
          valid: record.valid,
          payload: record.payload,
          reason: typeof record.reason === 'string' ? record.reason : undefined,
          reasonCode: typeof record.reasonCode === 'string' ? record.reasonCode : undefined,
        });
      } catch {
        if (aliveRef.current) setVerifyState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const callProtected = (): void => {
    if (effectiveToken === null) return;
    setBearerState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(PROTECTED_URL, {
          headers: { Authorization: `Bearer ${effectiveToken}` },
        });
        if (!aliveRef.current) return;
        setBearerState({ kind: 'ready', status, bodyText });
      } catch {
        if (aliveRef.current) setBearerState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const users = usersState.kind === 'ready' ? usersState.users : [];
  const segments = issuedToken !== null ? issuedToken.split('.') : [];
  const [segmentHeader = '', segmentPayload = '', segmentSignature = ''] = segments;
  const remainingSeconds =
    issueState.kind === 'issued'
      ? Math.max(0, Math.ceil((issueState.issued.expEpochSeconds * 1000 - nowMs) / 1000))
      : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="jwt-summary" className="text-body-sm text-on-surface">
        The token workbench: issue an HS256 JWT for a demo user and read its three segments (the
        payload decodes right here — signed is not encrypted), verify it against the server, forge
        the claims with TAMPER (the signature refuses), race a 2-second expiry, and call the
        Bearer-protected endpoint.
      </p>

      {/* 1 — user picker + issue */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">Issue a token as…</h3>

        {usersState.kind === 'loading' && (
          <p data-testid="jwt-users-loading" className="text-caption text-on-surface-variant">
            loading the demo identities…
          </p>
        )}
        {usersState.kind === 'failed' && (
          <pre data-testid="jwt-users-failed" className={PRE}>
            {usersState.problem}
          </pre>
        )}

        {usersState.kind === 'ready' && (
          <div data-testid="jwt-user-picker" className="flex flex-col gap-sm sm:flex-row">
            {users.map((user) => (
              <button
                key={user.username}
                type="button"
                data-testid={`jwt-user-option-${user.username}`}
                onClick={() => setSelectedUsername(user.username)}
                className={`${CARD} flex-1 hover:bg-surface-variant ${
                  selectedUsername === user.username ? CARD_SELECTED : ''
                }`}
              >
                <span className="font-mono text-body-sm font-semibold text-on-surface">
                  {user.displayName}
                </span>
                <span className="font-mono text-caption text-on-surface-variant">
                  @{user.username} · roles: {user.roles.join(', ')}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="jwt-issue-button"
            onClick={() => issue(300)}
            disabled={issueState.kind === 'loading' || selectedUsername === null}
            className={BUTTON_PRIMARY}
          >
            issue (5 min)
          </button>
          <button
            type="button"
            data-testid="jwt-issue-short-button"
            onClick={() => issue(2)}
            disabled={issueState.kind === 'loading' || selectedUsername === null}
            className={BUTTON}
          >
            issue 2-second token
          </button>
          <span className="text-caption text-on-surface-variant">
            no password — a JWT is issued AFTER something else proved who you are
          </span>
        </div>

        {issueState.kind === 'failed' && (
          <pre data-testid="jwt-issue-failed" className={PRE}>
            {issueState.problem}
          </pre>
        )}
      </section>

      {/* 2 — the dissected token */}
      {issueState.kind === 'issued' && segments.length === 3 && (
        <section data-testid="jwt-token-dissection" className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">The token, dissected</h3>
            <span className={CHIP}>ttl {issueState.issued.ttlSeconds}s</span>
            {remainingSeconds !== null &&
              (remainingSeconds > 0 ? (
                <span data-testid="jwt-countdown" className={CHIP_OK}>
                  expires in {remainingSeconds}s
                </span>
              ) : (
                <span data-testid="jwt-countdown" className={CHIP_ERROR}>
                  expired by the page's clock — press VERIFY to ask the server
                </span>
              ))}
          </div>

          <div className={SEGMENT_BOX_HEADER}>
            <span className="flex items-center gap-xs">
              <span className={SEGMENT_LABEL_HEADER}>1 · header</span>
              <span className="text-caption text-on-surface-variant">the algorithm claim — attacker-editable input</span>
            </span>
            <code data-testid="jwt-segment-header" className="break-all font-mono text-caption text-on-surface">
              {segmentHeader}
            </code>
            <pre data-testid="jwt-decoded-header" className={PRE}>
              {decodeSegmentJson(segmentHeader) ?? '(not decodable)'}
            </pre>
          </div>

          <div className={SEGMENT_BOX_PAYLOAD}>
            <span className="flex items-center gap-xs">
              <span className={SEGMENT_LABEL_PAYLOAD}>2 · payload</span>
              <span className="text-caption text-on-surface-variant">
                the claims — readable by ANYONE holding the token (signed ≠ encrypted)
              </span>
            </span>
            <code data-testid="jwt-segment-payload" className="break-all font-mono text-caption text-on-surface">
              {segmentPayload}
            </code>
            <pre data-testid="jwt-decoded-payload" className={PRE}>
              {decodeSegmentJson(segmentPayload) ?? '(not decodable)'}
            </pre>
          </div>

          <div className={SEGMENT_BOX_SIGNATURE}>
            <span className="flex items-center gap-xs">
              <span className={SEGMENT_LABEL_SIGNATURE}>3 · signature</span>
              <span className="text-caption text-on-surface-variant">
                HMAC-SHA256(secret, header.payload) — binary bytes, not JSON; the only secret-derived part
              </span>
            </span>
            <code data-testid="jwt-segment-signature" className="break-all font-mono text-caption text-on-surface">
              {segmentSignature}
            </code>
          </div>

          <p data-testid="jwt-readonly-note" className="text-caption text-on-surface-variant">
            base64url is an ENCODING, not a cipher — the page decoded the payload with no secret at
            all. Never put anything sensitive inside a JWT.
          </p>
        </section>
      )}

      {/* 3 — verify / tamper / bearer */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="jwt-verify-button"
            onClick={verify}
            disabled={verifyState.kind === 'loading' || effectiveToken === null}
            className={BUTTON_PRIMARY}
          >
            {verifyState.kind === 'loading' ? 'verifying…' : 'verify'}
          </button>
          <button
            type="button"
            data-testid="jwt-bearer-button"
            onClick={callProtected}
            disabled={bearerState.kind === 'loading' || effectiveToken === null}
            className={BUTTON}
          >
            call /jwt-protected (Bearer)
          </button>
          <label className="flex items-center gap-xxs text-caption text-on-surface-variant">
            <input
              type="checkbox"
              data-testid="jwt-tamper-toggle"
              checked={tamper}
              onChange={(event) => setTamper(event.target.checked)}
            />
            tamper: rewrite the claims (sub → admin), keep the signature
          </label>
        </div>

        {tamper && effectiveToken !== null && (
          <p data-testid="jwt-tampered-note" className="text-caption text-on-surface-variant">
            The payload now claims <code>admin</code> with the ORIGINAL signature still attached —
            the exact forgery an attacker hopes you'll accept. Verify it, and watch the HMAC
            disagree.
          </p>
        )}

        {verifyState.kind === 'loading' && (
          <p data-testid="jwt-verify-loading" className="text-caption text-on-surface-variant">
            asking the server…
          </p>
        )}
        {verifyState.kind === 'failed' && (
          <pre data-testid="jwt-verify-failed" className={PRE}>
            {verifyState.problem}
          </pre>
        )}
        {verifyState.kind === 'done' && (
          <div data-testid="jwt-verify-result" className="flex flex-col gap-xxs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              {verifyState.valid ? (
                <span data-testid="jwt-verify-verdict" className={CHIP_OK}>
                  VALID
                </span>
              ) : (
                <span data-testid="jwt-verify-verdict" className={CHIP_ERROR}>
                  INVALID{verifyState.reasonCode ? ` (${verifyState.reasonCode})` : ''}
                </span>
              )}
              {!verifyState.valid && verifyState.reason && (
                <span data-testid="jwt-verify-reason" className="text-on-surface">
                  reason: {verifyState.reason}
                </span>
              )}
            </p>
            <pre className={PRE}>
              {verifyState.valid
                ? JSON.stringify(verifyState.payload ?? {}, null, 2)
                : '// the server refused the token — the verdict (and its reason) is the lesson,\n// delivered as data with HTTP 200, not as an error state.'}
            </pre>
          </div>
        )}

        {bearerState.kind === 'loading' && (
          <p data-testid="jwt-bearer-loading" className="text-caption text-on-surface-variant">
            calling /api/demo/auth/jwt-protected…
          </p>
        )}
        {bearerState.kind === 'failed' && (
          <pre data-testid="jwt-bearer-failed" className={PRE}>
            {bearerState.problem}
          </pre>
        )}
        {bearerState.kind === 'ready' && (
          <div data-testid="jwt-bearer-result" className="flex flex-col gap-xxs">
            <p className="font-mono text-caption">
              {bearerState.status < 400 ? (
                <span className={CHIP_OK}>{bearerState.status} — the Bearer token speaks for:</span>
              ) : (
                <span className={CHIP_ERROR}>{bearerState.status} — refused</span>
              )}
            </p>
            <pre className={PRE}>{prettyJsonOrText(bearerState.bodyText)}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
