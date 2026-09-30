import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `authz:matrix` — the Authorization topic's access
 * checker over the real endpoints (authz_demo_routes.ts):
 *
 * 1. ACT-AS STRIP — one-click logins as alice/bob/carol through the REAL
 *    /api/demo/auth/login (the fixed teaching password), setting the session
 *    cookie every later call rides. Identity comes back from the SERVER's
 *    echo on /documents, not from local optimism.
 * 2. THE DOCUMENTS BOARD — the owned documents with owner badges, per-doc
 *    VIEW / PATCH / DELETE buttons firing the true calls with the CURRENT
 *    identity; results render as chips (200 / 401 / 403 with the envelope's
 *    requiredPermission + owner) both inline and in a rolling action log.
 *    A create form POSTs a document (no owner field exists in the UI — the
 *    server decides the owner, which is the confused-deputy lesson).
 * 3. THE MATRIX — roles × permissions rendered from /catalog (derived from
 *    the RBAC table the middleware enforces), with the current user's role
 *    row highlighted and the ownership rule spelled out.
 */

const USERS_URL = '/api/demo/auth/users';
const LOGIN_URL = '/api/demo/auth/login';
const DOCS_BASE = '/api/demo/authz/documents';
const CATALOG_URL = '/api/demo/authz/catalog';

const TEACHING_ROLES: readonly string[] = ['admin', 'editor', 'viewer'];

interface DemoIdentity {
  username: string;
  displayName: string;
  roles: string[];
  passwordHint: string;
}

interface AuthzDocument {
  id: string;
  title: string;
  body: string;
  ownerUsername: string;
  updatedAt: string;
}

interface CatalogPermission {
  permission: string;
  roles: string[];
  description: string;
}

interface AuthzCatalog {
  permissions: CatalogPermission[];
  roles: { role: string; permissions: string[] }[];
  ownershipRule?: string;
}

/** The current identity as the SERVER resolves it (anonymous until a login). */
type IdentityState =
  | { kind: 'anonymous' }
  | { kind: 'switching'; username: string }
  | { kind: 'acting'; username: string; displayName: string; roles: string[]; scheme: string };

type UsersState =
  | { kind: 'loading' }
  | { kind: 'ready'; users: DemoIdentity[] }
  | { kind: 'failed'; problem: string };

type BoardState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'ready'; documents: AuthzDocument[] }
  | { kind: 'failed'; problem: string };

type CatalogState =
  | { kind: 'loading' }
  | { kind: 'ready'; catalog: AuthzCatalog }
  | { kind: 'failed'; problem: string };

/** One fired action's verdict — the envelope details made visible. */
interface ActionEntry {
  seq: number;
  action: 'VIEW' | 'PATCH' | 'DELETE' | 'CREATE';
  docId: string;
  docTitle: string;
  actingAs: string;
  status: number;
  note: string;
  requiredPermission?: string;
  owner?: string;
}

type CreateState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; entry: ActionEntry };

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
const CARD = 'flex flex-col gap-xxs rounded-md border border-outline p-sm text-left';
const CARD_SELECTED = 'border-primary bg-surface-variant';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';
const INPUT =
  'rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface';

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

function errorEnvelopeFromText(text: string): Record<string, unknown> {
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const error = (parsed.value as Record<string, unknown>).error;
    if (typeof error === 'object' && error !== null) return error as Record<string, unknown>;
  }
  return {};
}

/** The envelope's message when parseable, the raw text otherwise. */
function envelopeMessage(text: string): string {
  const message = errorEnvelopeFromText(text).message;
  return typeof message === 'string' ? message : text;
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

function parseDocumentsPayload(
  value: unknown,
): { documents: AuthzDocument[]; identity: { username: string; roles: string[]; scheme: string } } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const documents = record.documents;
  const identity = record.identity;
  if (!Array.isArray(documents)) return null;
  if (typeof identity !== 'object' || identity === null) return null;
  const id = identity as { username?: unknown; roles?: unknown; scheme?: unknown };
  if (typeof id.username !== 'string') return null;
  return {
    documents: documents.filter(
      (raw): raw is AuthzDocument =>
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { id?: unknown }).id === 'string' &&
        typeof (raw as { title?: unknown }).title === 'string' &&
        typeof (raw as { ownerUsername?: unknown }).ownerUsername === 'string',
    ),
    identity: {
      username: id.username,
      roles: Array.isArray(id.roles)
        ? id.roles.filter((role): role is string => typeof role === 'string')
        : [],
      scheme: typeof id.scheme === 'string' ? id.scheme : '?',
    },
  };
}

function parseCatalog(value: unknown): AuthzCatalog | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const permissions = record.permissions;
  if (!Array.isArray(permissions)) return null;
  const parsed = permissions.filter(
    (raw): raw is CatalogPermission =>
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { permission?: unknown }).permission === 'string' &&
      Array.isArray((raw as { roles?: unknown }).roles),
  );
  if (parsed.length === 0) return null;
  const roles = Array.isArray(record.roles)
    ? record.roles.filter(
        (raw): raw is { role: string; permissions: string[] } =>
          typeof raw === 'object' &&
          raw !== null &&
          typeof (raw as { role?: unknown }).role === 'string' &&
          Array.isArray((raw as { permissions?: unknown }).permissions),
      )
    : [];
  return {
    permissions: parsed,
    roles,
    ownershipRule: typeof record.ownershipRule === 'string' ? record.ownershipRule : undefined,
  };
}

/** One fetch, one body read — { status, bodyText }. */
async function fetchOnce(url: string, init?: RequestInit): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(url, init);
  return { status: response.status, bodyText: await readBodyText(response) };
}

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

export default function AuthzMatrixDemo(): ReactNode {
  const [usersState, setUsersState] = useState<UsersState>({ kind: 'loading' });
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: 'loading' });
  const [boardState, setBoardState] = useState<BoardState>({ kind: 'loading' });
  const [identityState, setIdentityState] = useState<IdentityState>({ kind: 'anonymous' });
  const [log, setLog] = useState<ActionEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [createState, setCreateState] = useState<CreateState>({ kind: 'idle' });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const seqRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const appendLog = (entry: Omit<ActionEntry, 'seq'>): ActionEntry => {
    seqRef.current += 1;
    const full: ActionEntry = { ...entry, seq: seqRef.current };
    setLog((current) => [full, ...current].slice(0, 12));
    return full;
  };

  const loadBoard = (): void => {
    setBoardState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(DOCS_BASE, { credentials: 'same-origin' });
        if (!aliveRef.current) return;
        if (status === 401) {
          setBoardState({ kind: 'anonymous' });
          setIdentityState({ kind: 'anonymous' }); // the cookie is dead — the server says so
          return;
        }
        if (status >= 400) {
          setBoardState({
            kind: 'failed',
            problem: `${String(status)} ${envelopeMessage(bodyText)}`,
          });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseDocumentsPayload(parsed.value) : null;
        if (payload === null) {
          setBoardState({ kind: 'failed', problem: 'unexpected documents payload' });
          return;
        }
        setBoardState({ kind: 'ready', documents: payload.documents });
        // The board's identity is the SERVER's resolution of the cookie — the
        // honest source (this is /me discipline, reused).
        setIdentityState((current) =>
          current.kind === 'switching' || current.kind === 'anonymous'
            ? {
                kind: 'acting',
                username: payload.identity.username,
                displayName: payload.identity.username,
                roles: payload.identity.roles,
                scheme: payload.identity.scheme,
              }
            : current,
        );
      } catch {
        if (aliveRef.current) setBoardState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  useEffect(() => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(USERS_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setUsersState({ kind: 'failed', problem: envelopeMessage(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const users = parsed.ok ? parseIdentities(parsed.value) : null;
        if (users === null || users.length === 0) {
          setUsersState({ kind: 'failed', problem: 'unexpected users payload' });
          return;
        }
        setUsersState({ kind: 'ready', users });
      } catch {
        if (aliveRef.current) setUsersState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();

    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(CATALOG_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setCatalogState({ kind: 'failed', problem: envelopeMessage(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const catalog = parsed.ok ? parseCatalog(parsed.value) : null;
        if (catalog === null) {
          setCatalogState({ kind: 'failed', problem: 'unexpected catalog payload' });
          return;
        }
        setCatalogState({ kind: 'ready', catalog });
      } catch {
        if (aliveRef.current) setCatalogState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();

    loadBoard();
  }, []);

  const actAs = (user: DemoIdentity): void => {
    setIdentityState({ kind: 'switching', username: user.username });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(LOGIN_URL, {
          method: 'POST',
          credentials: 'same-origin', // the Set-Cookie must land in this origin's jar
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user.username, password: user.passwordHint }),
        });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setIdentityState({ kind: 'anonymous' });
          appendLog({
            action: 'CREATE',
            docId: '(login)',
            docTitle: `login as ${user.username}`,
            actingAs: user.username,
            status,
          note: envelopeMessage(bodyText),
          });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
          ? (parsed.value as { user?: { username?: unknown; displayName?: unknown; roles?: unknown } })
          : {};
        const loginUser = record.user ?? {};
        setIdentityState({
          kind: 'acting',
          username: user.username,
          displayName:
            typeof loginUser.displayName === 'string' ? loginUser.displayName : user.displayName,
          roles:
            Array.isArray(loginUser.roles) && loginUser.roles.every((role) => typeof role === 'string')
              ? (loginUser.roles as string[])
              : user.roles,
          scheme: 'session',
        });
        loadBoard(); // the new cookie's board — the server re-confirms identity
      } catch {
        if (aliveRef.current) setIdentityState({ kind: 'anonymous' });
      }
    })();
  };

  /** Fires one action and turns the verdict into a log entry (+ chip). */
  const runAction = (
    action: ActionEntry['action'],
    document: AuthzDocument | { id: string; title: string; body?: string },
  ): void => {
    const actingAs = identityState.kind === 'acting' ? identityState.username : 'anonymous';
    setBusy(`${action}:${document.id}`);
    void (async () => {
      try {
        let url = `${DOCS_BASE}/${document.id}`;
        let init: RequestInit = { credentials: 'same-origin' };
        if (action === 'PATCH') {
          init = {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: `edited by ${actingAs}` }),
          };
        } else if (action === 'DELETE') {
          init = { method: 'DELETE', credentials: 'same-origin' };
        }
        const { status, bodyText } = await fetchOnce(url, init);
        if (!aliveRef.current) return;
        const envelope = status >= 400 ? errorEnvelopeFromText(bodyText) : {};
        appendLog({
          action,
          docId: document.id,
          docTitle: document.title,
          actingAs,
          status,
          note:
            status < 400
              ? action === 'VIEW'
                ? 'read the document — documents:read held (or the owner rule)'
                : action === 'PATCH'
                  ? 'the edit landed (owner or documents:write)'
                  : action === 'DELETE'
                    ? 'gone — owner or documents:delete'
                    : 'created — the caller is the owner, decided server-side'
              : envelopeMessage(bodyText),
          requiredPermission: typeof envelope.requiredPermission === 'string' ? envelope.requiredPermission : undefined,
          owner: typeof envelope.owner === 'string' ? envelope.owner : undefined,
        });
        if (status < 400 && (action === 'PATCH' || action === 'DELETE')) {
          loadBoard(); // show the new state (or the absence) honestly
        }
      } catch {
        appendLog({
          action,
          docId: document.id,
          docTitle: document.title,
          actingAs,
          status: 0,
          note: UNREACHABLE,
        });
      } finally {
        if (aliveRef.current) setBusy(null);
      }
    })();
  };

  const createDocument = (): void => {
    const actingAs = identityState.kind === 'acting' ? identityState.username : 'anonymous';
    setCreateState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(DOCS_BASE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body }),
        });
        if (!aliveRef.current) return;
        const envelope = status >= 400 ? errorEnvelopeFromText(bodyText) : {};
        const entry = appendLog({
          action: 'CREATE',
          docId: status < 400 ? '(new document)' : '(create)',
          docTitle: title || '(untitled)',
          actingAs,
          status,
          note:
            status < 400
              ? 'created — you are the owner (the form has no owner field; the server decides)'
              : envelopeMessage(bodyText),
          requiredPermission:
            typeof envelope.requiredPermission === 'string' ? envelope.requiredPermission : undefined,
        });
        setCreateState({ kind: 'done', entry });
        if (status < 400) {
          setTitle('');
          setBody('');
          loadBoard();
        }
      } catch {
        setCreateState({ kind: 'done', entry: {
          seq: 0, action: 'CREATE', docId: '(create)', docTitle: title, actingAs, status: 0, note: UNREACHABLE,
        } });
      }
    })();
  };

  const users = usersState.kind === 'ready' ? usersState.users : [];
  const documents = boardState.kind === 'ready' ? boardState.documents : [];
  const currentRoles = identityState.kind === 'acting' ? identityState.roles : [];
  const latestForDoc = (docId: string): ActionEntry | undefined =>
    log.find((entry) => entry.docId === docId);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="authz-summary" className="text-body-sm text-on-surface">
        Act as alice, bob, or carol — then fire every action at every document and watch the guards
        answer: 200s where the table allows, 403s that name the required permission, 401s while
        anonymous. The matrix below is the exact table the middleware enforces.
      </p>

      {/* 1 — act-as strip */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">Act as…</h3>

        {usersState.kind === 'loading' && (
          <p data-testid="authz-users-loading" className="text-caption text-on-surface-variant">
            loading the demo identities…
          </p>
        )}
        {usersState.kind === 'failed' && (
          <pre data-testid="authz-users-failed" className={PRE}>
            {usersState.problem}
          </pre>
        )}

        {usersState.kind === 'ready' && (
          <div data-testid="authz-act-strip" className="flex flex-col gap-sm sm:flex-row">
            {users.map((user) => (
              <button
                key={user.username}
                type="button"
                data-testid={`authz-act-${user.username}`}
                onClick={() => actAs(user)}
                disabled={identityState.kind === 'switching'}
                className={`${CARD} flex-1 hover:bg-surface-variant ${
                  identityState.kind !== 'anonymous' && identityState.username === user.username
                    ? CARD_SELECTED
                    : ''
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
              </button>
            ))}
          </div>
        )}

        {identityState.kind === 'switching' && (
          <p data-testid="authz-identity-switching" className="text-caption text-on-surface-variant">
            logging in as {identityState.username}…
          </p>
        )}
        {identityState.kind === 'acting' && (
          <p data-testid="authz-identity-card" className="flex flex-wrap items-center gap-xs font-mono text-caption">
            <span className={CHIP_OK}>acting as</span>
            <span className="font-semibold text-on-surface">
              {identityState.displayName} (@{identityState.username})
            </span>
            {identityState.roles.map((role) => (
              <span key={role} className={CHIP}>
                {role}
              </span>
            ))}
            <span className="text-on-surface-variant">· by {identityState.scheme}</span>
          </p>
        )}
        {identityState.kind === 'anonymous' && (
          <p data-testid="authz-identity-anonymous" className="text-caption text-on-surface-variant">
            anonymous — no credential presented. Fire any action below and watch the 401s.
          </p>
        )}
      </section>

      {/* 2 — the documents board */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">The documents board</h3>

        {boardState.kind === 'loading' && (
          <p data-testid="authz-board-loading" className="text-caption text-on-surface-variant">
            loading the documents…
          </p>
        )}
        {boardState.kind === 'anonymous' && (
          <p data-testid="authz-board-anonymous" className="text-caption text-on-surface-variant">
            the board needs an identity — GET /documents is guarded by documents:read, and anonymous
            gets the 401 envelope. Act as someone above (or CREATE below while anonymous to watch it).
          </p>
        )}
        {boardState.kind === 'failed' && (
          <pre data-testid="authz-board-failed" className={PRE}>
            {boardState.problem}
          </pre>
        )}

        {boardState.kind === 'ready' && (
          <div data-testid="authz-board" className="flex flex-col gap-sm">
            {documents.map((document) => {
              const chip = latestForDoc(document.id);
              const isOwner =
                identityState.kind === 'acting' && document.ownerUsername === identityState.username;
              return (
                <div
                  key={document.id}
                  data-testid={`authz-doc-${document.id}`}
                  className="flex flex-col gap-xs rounded-md border border-outline p-sm"
                >
                  <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
                    <span className="font-semibold text-on-surface">{document.title}</span>
                    <span data-testid={`authz-owner-${document.id}`} className={CHIP}>
                      owner: @{document.ownerUsername}
                      {isOwner ? ' (you)' : ''}
                    </span>
                  </p>
                  <p className="font-mono text-caption text-on-surface-variant">
                    {document.id} · updated {document.updatedAt}
                  </p>
                  <div className="flex flex-wrap gap-xs">
                    <button
                      type="button"
                      data-testid={`authz-view-${document.id}`}
                      onClick={() => runAction('VIEW', document)}
                      disabled={busy !== null}
                      className={BUTTON}
                    >
                      VIEW
                    </button>
                    <button
                      type="button"
                      data-testid={`authz-patch-${document.id}`}
                      onClick={() => runAction('PATCH', document)}
                      disabled={busy !== null}
                      className={BUTTON}
                    >
                      PATCH
                    </button>
                    <button
                      type="button"
                      data-testid={`authz-delete-${document.id}`}
                      onClick={() => runAction('DELETE', document)}
                      disabled={busy !== null}
                      className={BUTTON_DANGER}
                    >
                      DELETE
                    </button>
                  </div>
                  {chip !== undefined && (
                    <p
                      data-testid={`authz-chip-${document.id}`}
                      className="flex flex-wrap items-center gap-xs font-mono text-caption"
                    >
                      <span className={chip.status < 400 ? CHIP_OK : CHIP_ERROR}>
                        {String(chip.status)}
                      </span>
                      {chip.requiredPermission !== undefined && (
                        <span>needs {chip.requiredPermission}</span>
                      )}
                      {chip.owner !== undefined && <span>owner: @{chip.owner}</span>}
                      <span className="text-on-surface-variant">{chip.note}</span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* create form — no owner field exists; the server decides */}
        <div className="flex flex-col gap-xs rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <label className="flex items-center gap-xxs text-caption text-on-surface-variant">
              title
              <input
                type="text"
                data-testid="authz-create-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className={INPUT}
              />
            </label>
            <label className="flex items-center gap-xxs text-caption text-on-surface-variant">
              body
              <input
                type="text"
                data-testid="authz-create-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                className={INPUT}
              />
            </label>
            <button
              type="button"
              data-testid="authz-create-button"
              onClick={createDocument}
              disabled={createState.kind === 'loading' || title.trim().length === 0}
              className={BUTTON_PRIMARY}
            >
              {createState.kind === 'loading' ? 'creating…' : 'CREATE (documents:write)'}
            </button>
          </div>
          {createState.kind === 'done' && (
            <p data-testid="authz-create-result" className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={createState.entry.status < 400 ? CHIP_OK : CHIP_ERROR}>
                {String(createState.entry.status)}
              </span>
              {createState.entry.requiredPermission !== undefined && (
                <span>needs {createState.entry.requiredPermission}</span>
              )}
              <span className="text-on-surface-variant">{createState.entry.note}</span>
            </p>
          )}
        </div>

        {/* rolling action log — survives deletions (the chip's memory) */}
        {log.length > 0 && (
          <div data-testid="authz-log" className="flex flex-col gap-xxs">
            <p className="text-caption text-on-surface-variant">
              action log (newest first — entries survive deletions):
            </p>
            {log.map((entry) => (
              <p
                key={entry.seq}
                data-testid="authz-log-entry"
                className="flex flex-wrap items-center gap-xs font-mono text-caption"
              >
                <span className={entry.status < 400 ? CHIP_OK : CHIP_ERROR}>
                  {String(entry.status)}
                </span>
                <span className="text-on-surface-variant">
                  {entry.action} “{entry.docTitle}” as {entry.actingAs}
                </span>
                {entry.requiredPermission !== undefined && (
                  <span>needs {entry.requiredPermission}</span>
                )}
                {entry.owner !== undefined && <span>owner: @{entry.owner}</span>}
              </p>
            ))}
          </div>
        )}
      </section>

      {/* 3 — the roles×permissions matrix */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          The matrix (from /catalog — what the middleware enforces)
        </h3>

        {catalogState.kind === 'loading' && (
          <p data-testid="authz-catalog-loading" className="text-caption text-on-surface-variant">
            loading the permission catalog…
          </p>
        )}
        {catalogState.kind === 'failed' && (
          <pre data-testid="authz-catalog-failed" className={PRE}>
            {catalogState.problem}
          </pre>
        )}

        {catalogState.kind === 'ready' && (
          <div data-testid="authz-matrix" className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-caption">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="border-b border-outline px-xs py-xxs">role</th>
                  {catalogState.catalog.permissions.map((permission) => (
                    <th key={permission.permission} className="border-b border-outline px-xs py-xxs">
                      {permission.permission}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(catalogState.catalog.roles.length > 0
                  ? catalogState.catalog.roles.map((role) => role.role)
                  : [...TEACHING_ROLES]
                ).map((role) => {
                  const isCurrent = currentRoles.includes(role);
                  return (
                    <tr
                      key={role}
                      data-testid={`authz-matrix-row-${role}`}
                      className={isCurrent ? 'bg-surface-variant font-semibold' : ''}
                    >
                      <td className="border-b border-outline px-xs py-xxs text-on-surface">
                        {role}
                        {isCurrent ? ' ← you' : ''}
                      </td>
                      {catalogState.catalog.permissions.map((permission) => (
                        <td key={permission.permission} className="border-b border-outline px-xs py-xxs">
                          {permission.roles.includes(role) ? '✓' : '—'}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-xs text-caption text-on-surface-variant">
              {catalogState.catalog.ownershipRule ??
                'ownership is an alternative path: owners may PATCH and DELETE their own documents regardless of role permissions.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
