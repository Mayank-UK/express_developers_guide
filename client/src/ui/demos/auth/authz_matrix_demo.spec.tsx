import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AuthzMatrixDemo from './authz_matrix_demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USERS_URL = '/api/demo/auth/users';
const LOGIN_URL = '/api/demo/auth/login';
const DOCS_BASE = '/api/demo/authz/documents';
const CATALOG_URL = '/api/demo/authz/catalog';

const TEACHING_PW = 'guide-demo-pw';

const USERS = [
  { username: 'alice', displayName: 'Alice Admin', roles: ['admin'] },
  { username: 'bob', displayName: 'Bob Builder', roles: ['editor'] },
  { username: 'carol', displayName: 'Carol Reader', roles: ['viewer'] },
];

const ROLE_PERMS: Record<string, string[]> = {
  admin: ['documents:read', 'documents:write', 'documents:delete', 'admin:demos'],
  editor: ['documents:read', 'documents:write'],
  viewer: ['documents:read'],
};

const ARCHITECTURE = 'authz-architecture-overview'; // alice's
const RUNBOOK = 'authz-deployment-runbook'; // bob's
const ONBOARDING = 'authz-onboarding-notes'; // carol's

function jsonLike(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (): string | null => null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

function forbidden(requiredPermission: string, extra: Record<string, unknown> = {}) {
  return jsonLike(
    {
      error: {
        code: 'forbidden',
        message: `this endpoint requires the ${requiredPermission} permission`,
        requiredPermission,
        ...extra,
        requestId: 'test',
      },
    },
    403,
  );
}

function unauthorized() {
  return jsonLike(
    {
      error: {
        code: 'unauthorized',
        message: 'authentication required — present a session cookie, x-api-key, or Bearer token',
        requestId: 'test',
      },
    },
    401,
  );
}

/**
 * A stateful stand-in for the guide: the real login sets the "session", the
 * document store mutates, and the RBAC + ownership rules answer EXACTLY as
 * authz_demo_routes.ts does — so the chips the demo renders are the chips the
 * real server produces.
 */
function stubAuthzServer() {
  let active: { username: string; roles: string[] } | null = null;
  let documents = [
    { id: ARCHITECTURE, title: 'Architecture overview', body: 'the layers…', ownerUsername: 'alice', updatedAt: '2026-09-28T10:00:00.000Z' },
    { id: RUNBOOK, title: 'Deployment runbook', body: 'compose up…', ownerUsername: 'bob', updatedAt: '2026-09-28T10:00:00.000Z' },
    { id: ONBOARDING, title: 'Onboarding notes', body: 'start with auth…', ownerUsername: 'carol', updatedAt: '2026-09-28T10:00:00.000Z' },
  ];
  let counter = 3;

  const identityEcho = () => ({
    username: active!.username,
    roles: active!.roles,
    scheme: 'session',
  });

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === USERS_URL) {
      return jsonLike({ users: USERS.map((user) => ({ ...user, passwordHint: TEACHING_PW })) });
    }
    if (url === LOGIN_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { username: string; password: string };
      const user = USERS.find((candidate) => candidate.username === body.username);
      if (user === undefined || body.password !== TEACHING_PW) {
        return jsonLike({ error: { code: 'unauthorized', message: 'invalid username or password' } }, 401);
      }
      active = { username: user.username, roles: [...user.roles] };
      return jsonLike({ user, session: { expiresAt: '2026-09-28T22:00:00.000Z', tokenMasked: '…wxyz' } });
    }
    if (url === CATALOG_URL) {
      return jsonLike({
        permissions: [
          { permission: 'documents:read', roles: ['admin', 'editor', 'viewer'], description: 'read' },
          { permission: 'documents:write', roles: ['admin', 'editor'], description: 'write' },
          { permission: 'documents:delete', roles: ['admin'], description: 'delete' },
          { permission: 'admin:demos', roles: ['admin'], description: 'admin' },
        ],
        roles: ['admin', 'editor', 'viewer'].map((role) => ({ role, permissions: ROLE_PERMS[role] })),
        ownershipRule: 'ownership is an alternative path (test stub wording)',
      });
    }
    if (url === DOCS_BASE && method === 'GET') {
      if (active === null) return unauthorized();
      return jsonLike({ documents, identity: identityEcho() });
    }
    if (url === DOCS_BASE && method === 'POST') {
      if (active === null) return unauthorized();
      if (!ROLE_PERMS[active.roles[0]!]!.includes('documents:write')) {
        return forbidden('documents:write', { userPermissions: ROLE_PERMS[active.roles[0]!]! });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { title: string; body: string };
      counter += 1;
      const created = {
        id: `authz-doc-${String(counter)}`,
        title: body.title,
        body: body.body,
        ownerUsername: active.username,
        updatedAt: '2026-09-28T12:00:00.000Z',
      };
      documents = [...documents, created];
      return jsonLike({ document: created, identity: identityEcho() }, 201);
    }
    const detail = url.match(/^\/api\/demo\/authz\/documents\/([^/]+)$/);
    if (detail !== null && (method === 'GET' || method === 'PATCH' || method === 'DELETE')) {
      if (active === null) return unauthorized();
      const document = documents.find((row) => row.id === detail[1]);
      if (document === undefined) {
        return jsonLike({ error: { code: 'not_found', message: 'no such document' } }, 404);
      }
      const role = active.roles[0]!;
      const isOwner = document.ownerUsername === active.username;
      const required = method === 'DELETE' ? 'documents:delete' : 'documents:write';
      const allowed = method === 'GET' || isOwner || ROLE_PERMS[role]!.includes(required);
      if (!allowed) {
        return forbidden(required, {
          documentId: document.id,
          owner: document.ownerUsername,
          userPermissions: ROLE_PERMS[role]!,
        });
      }
      if (method === 'DELETE') {
        documents = documents.filter((row) => row.id !== document.id);
        return jsonLike({ deleted: true, id: document.id, identity: identityEcho() });
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(String(init?.body ?? '{}')) as { body?: string };
        documents = documents.map((row) =>
          row.id === document.id ? { ...row, body: patch.body ?? row.body } : row,
        );
        return jsonLike({ document: { ...document, body: patch.body ?? document.body }, identity: identityEcho() });
      }
      return jsonLike({ document, identity: identityEcho() });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
  });
}

describe('AuthzMatrixDemo — the whole matrix, explorable', () => {
  it('anonymous board 401-state → act as carol → viewer row highlighted → delete alice\'s → forbidden chip naming the permission', async () => {
    vi.stubGlobal('fetch', stubAuthzServer());
    render(<AuthzMatrixDemo />);

    // 1. Before any login: the board is honestly anonymous.
    expect(await screen.findByTestId('authz-board-anonymous')).toHaveTextContent('documents:read');
    expect(screen.getByTestId('authz-identity-anonymous')).toHaveTextContent('anonymous');

    // 2. Act as carol — the identity card, the board with owner badges.
    fireEvent.click(screen.getByTestId('authz-act-carol'));
    expect(await screen.findByTestId('authz-identity-card')).toHaveTextContent('@carol');
    expect(screen.getByTestId('authz-identity-card')).toHaveTextContent('viewer');
    expect(await screen.findByTestId(`authz-doc-${ARCHITECTURE}`)).toHaveTextContent('Architecture overview');
    expect(screen.getByTestId(`authz-owner-${ARCHITECTURE}`)).toHaveTextContent('owner: @alice');
    expect(screen.getByTestId(`authz-owner-${ONBOARDING}`)).toHaveTextContent('owner: @carol (you)');

    // 3. The matrix renders from /catalog with carol's row highlighted.
    expect(screen.getByTestId('authz-matrix-row-viewer')).toHaveTextContent('← you');
    expect(screen.getByTestId('authz-matrix-row-admin')).not.toHaveTextContent('← you');
    expect(screen.getByTestId('authz-matrix')).toHaveTextContent('documents:delete');

    // 4. DELETE alice's document as carol → the 403 chip with requiredPermission.
    fireEvent.click(screen.getByTestId(`authz-delete-${ARCHITECTURE}`));
    const chip = await screen.findByTestId(`authz-chip-${ARCHITECTURE}`);
    expect(chip).toHaveTextContent('403');
    expect(chip).toHaveTextContent('documents:delete');
    expect(chip).toHaveTextContent('owner: @alice');
    // …and the document survived.
    expect(screen.getByTestId(`authz-doc-${ARCHITECTURE}`)).toBeDefined();
  });

  it('carol PATCHes her own (owner rule) but bob\'s → 403; the ownership overlay is real', async () => {
    vi.stubGlobal('fetch', stubAuthzServer());
    render(<AuthzMatrixDemo />);

    fireEvent.click(await screen.findByTestId('authz-act-carol'));
    await screen.findByTestId(`authz-doc-${ONBOARDING}`);

    fireEvent.click(screen.getByTestId(`authz-patch-${ONBOARDING}`));
    expect(await screen.findByTestId(`authz-chip-${ONBOARDING}`)).toHaveTextContent('200');

    fireEvent.click(screen.getByTestId(`authz-patch-${RUNBOOK}`));
    const chip = await screen.findByTestId(`authz-chip-${RUNBOOK}`);
    expect(chip).toHaveTextContent('403');
    expect(chip).toHaveTextContent('documents:write');
  });

  it('acting as bob: create → appears with owner bob (decided server-side)', async () => {
    vi.stubGlobal('fetch', stubAuthzServer());
    render(<AuthzMatrixDemo />);

    fireEvent.click(await screen.findByTestId('authz-act-bob'));
    await screen.findByTestId(`authz-doc-${ARCHITECTURE}`);

    fireEvent.change(screen.getByTestId('authz-create-title'), { target: { value: 'bob creates' } });
    fireEvent.change(screen.getByTestId('authz-create-body'), { target: { value: 'editor powers' } });
    fireEvent.click(screen.getByTestId('authz-create-button'));

    expect(await screen.findByTestId('authz-create-result')).toHaveTextContent('201');
    expect(await screen.findByTestId('authz-owner-authz-doc-4')).toHaveTextContent('owner: @bob (you)');
  });

  it('acting as alice: delete bob\'s runbook → ok verdict, the document disappears, the log remembers', async () => {
    vi.stubGlobal('fetch', stubAuthzServer());
    render(<AuthzMatrixDemo />);

    fireEvent.click(await screen.findByTestId('authz-act-alice'));
    await screen.findByTestId(`authz-doc-${RUNBOOK}`);

    fireEvent.click(screen.getByTestId(`authz-delete-${RUNBOOK}`));

    // The card leaves the board (the refresh is honest)…
    await screen.findByTestId('authz-log');
    expect(screen.queryByTestId(`authz-doc-${RUNBOOK}`)).toBeNull();
    // …and the action log keeps the 200 verdict for the deleted row.
    const entry = await screen.findAllByTestId('authz-log-entry');
    expect(entry[0]).toHaveTextContent('200');
    expect(entry[0]).toHaveTextContent('DELETE');
    expect(entry[0]).toHaveTextContent('Deployment runbook');
    expect(entry[0]).toHaveTextContent('as alice');
  });

  it('anonymous CREATE fires the real 401 (the server is the only enforcer)', async () => {
    vi.stubGlobal('fetch', stubAuthzServer());
    render(<AuthzMatrixDemo />);

    await screen.findByTestId('authz-act-alice');
    fireEvent.change(screen.getByTestId('authz-create-title'), { target: { value: 'sneaky' } });
    fireEvent.click(screen.getByTestId('authz-create-button'));

    expect(await screen.findByTestId('authz-create-result')).toHaveTextContent('401');
    expect(screen.queryByTestId(/authz-doc-authz-doc-/)).toBeNull();
  });

  it('re-login switches identity cleanly (bob → carol re-sorts the matrix highlight)', async () => {
    vi.stubGlobal('fetch', stubAuthzServer());
    render(<AuthzMatrixDemo />);

    fireEvent.click(await screen.findByTestId('authz-act-bob'));
    expect(await screen.findByTestId('authz-identity-card')).toHaveTextContent('@bob');
    expect(screen.getByTestId('authz-matrix-row-editor')).toHaveTextContent('← you');

    fireEvent.click(screen.getByTestId('authz-act-carol'));
    expect(await screen.findByTestId('authz-identity-card')).toHaveTextContent('@carol');
    expect(screen.getByTestId('authz-matrix-row-viewer')).toHaveTextContent('← you');
    expect(screen.getByTestId('authz-matrix-row-editor')).not.toHaveTextContent('← you');
  });

  it('degrades to reachable-server messages for both panels, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<AuthzMatrixDemo />);

    expect(await screen.findByTestId('authz-users-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(await screen.findByTestId('authz-board-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(await screen.findByTestId('authz-catalog-failed')).toHaveTextContent(
      'could not reach the server',
    );
  });
});
