import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { ValidationException } from '../../core/error_handling/exceptions.js';
import { createSession, resetSessionStoreForTests } from '../../domain/auth/session_store.js';
import { signJwt } from '../../domain/auth/jwt_service.js';
import {
  resetDocumentStoreForTests,
  getDocument,
  listDocuments,
  updateDocument,
} from '../../domain/authz/document_store.js';
import {
  AUTHZ_ROLES,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  permissionsForRoles,
  roleHasPermission,
} from '../../domain/authz/permissions.js';

const MOUNT = '/api/demo/authz';

const ALICE_KEY = 'gsk_demo_alice_2mFnQ7xK';
const CAROL_KEY = 'gsk_demo_carol_8vXp4mLb';

const ARCHITECTURE = 'authz-architecture-overview'; // alice's
const RUNBOOK = 'authz-deployment-runbook'; // bob's
const ONBOARDING = 'authz-onboarding-notes'; // carol's

/** A fresh session cookie for a demo user (the store is reset per case). */
function sessionCookie(username: string): string {
  return `guide_session=${createSession(username).token}`;
}

beforeEach(() => {
  resetSessionStoreForTests();
  resetDocumentStoreForTests();
});

describe('the RBAC table (unit) — permissions as data', () => {
  it('admin ⊃ editor ⊃ viewer, and every role can read', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual([
      'documents:read',
      'documents:write',
      'documents:delete',
      'admin:demos',
    ]);
    expect(ROLE_PERMISSIONS.editor).toEqual(['documents:read', 'documents:write']);
    expect(ROLE_PERMISSIONS.viewer).toEqual(['documents:read']);
    for (const role of AUTHZ_ROLES) {
      expect(roleHasPermission([role], 'documents:read')).toBe(true);
    }
  });

  it('multiple roles union, and unknown roles grant NOTHING (deny by default)', () => {
    expect(permissionsForRoles(['editor', 'viewer'])).toEqual(['documents:read', 'documents:write']);
    expect(roleHasPermission(['superuser'], 'documents:delete')).toBe(false); // typo'd role = no grant
    expect(roleHasPermission([], 'documents:read')).toBe(false);
    expect(permissionsForRoles(['nope'])).toEqual([]);
  });

  it('the catalog is DERIVED from the table (permission → which roles)', () => {
    expect(PERMISSION_CATALOG).toHaveLength(4);
    const byPermission = new Map(
      PERMISSION_CATALOG.map((entry) => [entry.permission, entry.roles]),
    );
    expect(byPermission.get('documents:delete')).toEqual(['admin']);
    expect(byPermission.get('documents:write')).toEqual(['admin', 'editor']);
    expect(byPermission.get('documents:read')).toEqual(['admin', 'editor', 'viewer']);
    expect(byPermission.get('admin:demos')).toEqual(['admin']);
    for (const entry of PERMISSION_CATALOG) {
      expect(typeof entry.description).toBe('string');
    }
  });
});

describe('GET /api/demo/authz/catalog — public roles×permissions matrix', () => {
  it('serves the catalog and the roles table without any credential', async () => {
    const res = await request(createApp()).get(`${MOUNT}/catalog`);

    expect(res.status).toBe(200);
    expect(res.body.permissions.map((entry: { permission: string }) => entry.permission)).toEqual([
      'documents:read',
      'documents:write',
      'documents:delete',
      'admin:demos',
    ]);
    expect(res.body.roles).toEqual([
      { role: 'admin', permissions: ROLE_PERMISSIONS.admin },
      { role: 'editor', permissions: ROLE_PERMISSIONS.editor },
      { role: 'viewer', permissions: ROLE_PERMISSIONS.viewer },
    ]);
    expect(typeof res.body.ownershipRule).toBe('string');
  });
});

describe('GET /api/demo/authz/documents — documents:read gate', () => {
  it('lists the seeded documents with their owners for any authenticated caller', async () => {
    for (const username of ['alice', 'bob', 'carol']) {
      const res = await request(createApp())
        .get(`${MOUNT}/documents`)
        .set('Cookie', sessionCookie(username));

      expect(res.status, username).toBe(200);
      expect(res.body.identity).toEqual({ username, roles: [expect.any(String)], scheme: 'session' });
      expect(res.body.documents.map((document: { id: string }) => document.id)).toEqual([
        ARCHITECTURE,
        RUNBOOK,
        ONBOARDING,
      ]);
      expect(res.body.documents.map((document: { ownerUsername: string }) => document.ownerUsername)).toEqual([
        'alice',
        'bob',
        'carol',
      ]);
    }
  });

  it('answers the 401 envelope with no credential', async () => {
    const res = await request(createApp()).get(`${MOUNT}/documents`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'unauthorized',
      scheme: 'session | api-key | bearer',
    });
  });
});

describe('carol (viewer) — the read-only role across the whole matrix', () => {
  it('reads the list and a single document (documents:read she has)', async () => {
    const detail = await request(createApp())
      .get(`${MOUNT}/documents/${ARCHITECTURE}`) // ALICE'S document — read is role-wide
      .set('Cookie', sessionCookie('carol'));
    expect(detail.status).toBe(200);
    expect(detail.body.document).toMatchObject({ id: ARCHITECTURE, ownerUsername: 'alice' });
    expect(detail.body.identity.username).toBe('carol');
  });

  it('create → 403 naming the required permission and her actual set', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/documents`)
      .set('Cookie', sessionCookie('carol'))
      .send({ title: 'carol tries', body: 'nope' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'forbidden',
      requiredPermission: 'documents:write',
      userPermissions: ['documents:read'],
    });
    expect(listDocuments()).toHaveLength(3); // nothing was created
  });

  it("PATCHes her OWN document (the ownership path beats the missing role permission)", async () => {
    const res = await request(createApp())
      .patch(`${MOUNT}/documents/${ONBOARDING}`)
      .set('Cookie', sessionCookie('carol'))
      .send({ body: 'carol can edit her own notes' });

    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({
      id: ONBOARDING,
      ownerUsername: 'carol',
      body: 'carol can edit her own notes',
    });
  });

  it("PATCHes BOB'S document → 403 with the object-level details", async () => {
    const res = await request(createApp())
      .patch(`${MOUNT}/documents/${RUNBOOK}`)
      .set('Cookie', sessionCookie('carol'))
      .send({ body: 'sneaky edit' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'forbidden',
      documentId: RUNBOOK,
      owner: 'bob',
      requiredPermission: 'documents:write',
      userPermissions: ['documents:read'],
    });
    expect(getDocument(RUNBOOK)?.body).not.toContain('sneaky');
  });

  it("DELETEs her own document (ownership), but alice's → 403", async () => {
    const own = await request(createApp())
      .delete(`${MOUNT}/documents/${ONBOARDING}`)
      .set('Cookie', sessionCookie('carol'));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ deleted: true, id: ONBOARDING });
    expect(getDocument(ONBOARDING)).toBeUndefined();

    const aliceDoc = await request(createApp())
      .delete(`${MOUNT}/documents/${ARCHITECTURE}`)
      .set('Cookie', sessionCookie('carol'));
    expect(aliceDoc.status).toBe(403);
    expect(aliceDoc.body.error).toMatchObject({
      code: 'forbidden',
      documentId: ARCHITECTURE,
      owner: 'alice',
      requiredPermission: 'documents:delete',
      userPermissions: ['documents:read'],
    });
    expect(getDocument(ARCHITECTURE)).toBeDefined();
  });
});

describe('bob (editor) — documents:write, but not documents:delete', () => {
  it('creates a document and becomes its owner (owner decided SERVER-side)', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/documents`)
      .set('Cookie', sessionCookie('bob'))
      .send({ title: 'bob creates', body: 'editor powers' });

    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({
      title: 'bob creates',
      ownerUsername: 'bob',
      id: expect.stringMatching(/^authz-doc-\d+$/),
    });
    expect(res.body.identity.username).toBe('bob');
    // A client-sent owner field is IGNORED, not honored (confused-deputy guard).
    expect(getDocument(res.body.document.id)?.ownerUsername).toBe('bob');
  });

  it("the editor rule: PATCHes ALICE'S document (documents:write grants cross-owner edits)", async () => {
    const res = await request(createApp())
      .patch(`${MOUNT}/documents/${ARCHITECTURE}`)
      .set('Cookie', sessionCookie('bob'))
      .send({ title: 'architecture overview (bob touched)' });

    expect(res.status).toBe(200);
    expect(res.body.document.title).toBe('architecture overview (bob touched)');
  });

  it("delete alice's → 403 (no documents:delete), delete own → 200", async () => {
    const aliceDoc = await request(createApp())
      .delete(`${MOUNT}/documents/${ARCHITECTURE}`)
      .set('Cookie', sessionCookie('bob'));
    expect(aliceDoc.status).toBe(403);
    expect(aliceDoc.body.error.requiredPermission).toBe('documents:delete');
    expect(aliceDoc.body.error.userPermissions).toEqual(['documents:read', 'documents:write']);

    const own = await request(createApp())
      .delete(`${MOUNT}/documents/${RUNBOOK}`)
      .set('Cookie', sessionCookie('bob'));
    expect(own.status).toBe(200);
    expect(own.body.deleted).toBe(true);
  });
});

describe('alice (admin) — documents:delete is the override', () => {
  it("deletes BOB'S document (documents:delete outranks ownership)", async () => {
    const res = await request(createApp())
      .delete(`${MOUNT}/documents/${RUNBOOK}`)
      .set('Cookie', sessionCookie('alice'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, id: RUNBOOK });
    expect(getDocument(RUNBOOK)).toBeUndefined();
  });
});

describe('the three credential families reach the same matrix (the resolver)', () => {
  it("api-key identity: carol's key reads, and earns the same 403 as her session", async () => {
    const read = await request(createApp()).get(`${MOUNT}/documents`).set('x-api-key', CAROL_KEY);
    expect(read.status).toBe(200);
    expect(read.body.identity).toEqual({
      username: 'carol',
      roles: ['viewer'],
      scheme: 'api-key',
    });

    const create = await request(createApp())
      .post(`${MOUNT}/documents`)
      .set('x-api-key', CAROL_KEY)
      .send({ title: 'x', body: 'y' });
    expect(create.status).toBe(403);
    expect(create.body.error.requiredPermission).toBe('documents:write');
  });

  it('bearer JWT identity: a token issued for alice carries admin weight', async () => {
    const issued = await request(createApp())
      .post('/api/demo/auth/jwt/issue')
      .send({ username: 'alice' });
    const token = String(issued.body.token);

    const read = await request(createApp())
      .get(`${MOUNT}/documents`)
      .set('Authorization', `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(read.body.identity).toEqual({ username: 'alice', roles: ['admin'], scheme: 'bearer' });

    const del = await request(createApp())
      .delete(`${MOUNT}/documents/${RUNBOOK}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200); // alice deletes bob's — by token this time
  });

  it('a bearer token signed directly by jwt_service works too (the resolver verifies, then looks up live)', async () => {
    const token = signJwt('bob', ['editor']).token;
    const res = await request(createApp())
      .patch(`${MOUNT}/documents/${ONBOARDING}`) // CAROL'S doc — editor rule applies
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'bob via token' });

    expect(res.status).toBe(200);
    expect(res.body.identity).toEqual({ username: 'bob', roles: ['editor'], scheme: 'bearer' });
    expect(res.body.document.ownerUsername).toBe('carol');
  });

  it('a GARBAGE bearer token is nobody: 401, not a crash and not a 403', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/documents`)
      .set('Authorization', 'Bearer not.a.jwt');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('precedence: when cookie AND api key are both present, the cookie speaks (one caller, one identity)', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/documents`)
      .set('Cookie', sessionCookie('carol'))
      .set('x-api-key', ALICE_KEY);

    expect(res.status).toBe(200);
    expect(res.body.identity).toEqual({
      username: 'carol',
      roles: ['viewer'],
      scheme: 'session',
    });
  });
});

describe('failure ORDER: 401 before 404, 404 before 403', () => {
  it('an unknown id with NO credential → 401 (authenticate first)', async () => {
    const res = await request(createApp()).patch(`${MOUNT}/documents/authz-nope`);
    expect(res.status).toBe(401);
  });

  it('an unknown id WITH authentication → 404, never 403 (a 403 would confirm the id exists)', async () => {
    for (const [method, send] of [
      ['patch', () => ({ body: 'x' })],
      ['delete', () => undefined],
    ] as const) {
      const res = await request(createApp())
        [method](`${MOUNT}/documents/authz-nope`)
        .set('Cookie', sessionCookie('carol'))
        .send(send());
      expect(res.status, method).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
  });

  it('GET detail on an unknown id → 404 as well', async () => {
    const res = await request(createApp())
      .get(`${MOUNT}/documents/authz-nope`)
      .set('Cookie', sessionCookie('alice'));
    expect(res.status).toBe(404);
  });
});

describe('input validation — 400 envelopes before any authz decision changes state', () => {
  it('create rejects malformed bodies', async () => {
    const bodies: { label: string; send: () => unknown }[] = [
      { label: 'empty object', send: () => ({}) },
      { label: 'blank title', send: () => ({ title: '   ', body: 'x' }) },
      { label: 'non-string body', send: () => ({ title: 'ok', body: 42 }) },
      { label: 'array', send: () => ['nope'] },
    ];
    for (const { label, send } of bodies) {
      const res = await request(createApp())
        .post(`${MOUNT}/documents`)
        .set('Cookie', sessionCookie('alice'))
        .send(send() as Record<string, unknown>);
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe('validation_failed');
    }
    expect(listDocuments()).toHaveLength(3);
  });

  it('patch rejects an empty patch and non-string fields', async () => {
    const empty = await request(createApp())
      .patch(`${MOUNT}/documents/${ONBOARDING}`)
      .set('Cookie', sessionCookie('carol'))
      .send({});
    expect(empty.status).toBe(400);

    const badTitle = await request(createApp())
      .patch(`${MOUNT}/documents/${ONBOARDING}`)
      .set('Cookie', sessionCookie('carol'))
      .send({ title: 7 });
    expect(badTitle.status).toBe(400);
  });

  it('patch rejects blank and wrong-typed titles with the 400 envelope, storing nothing', async () => {
    for (const title of ['', '   ', 7]) {
      const res = await request(createApp())
        .patch(`${MOUNT}/documents/${ONBOARDING}`)
        .set('Cookie', sessionCookie('carol'))
        .send({ title });
      expect(res.status, `title=${JSON.stringify(title)}`).toBe(400);
      expect(res.body.error.code, `title=${JSON.stringify(title)}`).toBe('validation_failed');
    }
    expect(getDocument(ONBOARDING)?.title).toBe('Onboarding notes'); // nothing was stored
  });

  it('patch rejects an oversized body — the STORE cap answers 400, not the parser 413', async () => {
    const res = await request(createApp())
      .patch(`${MOUNT}/documents/${ONBOARDING}`)
      .set('Cookie', sessionCookie('carol'))
      .send({ body: 'x'.repeat(70 * 1024) }); // over the store's 64KiB cap, under the parser's 100kb

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_failed' });
    expect(getDocument(ONBOARDING)?.body).not.toContain('xxxx'); // nothing was stored
  });

  it('titles are trimmed and capped at 120 characters', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/documents`)
      .set('Cookie', sessionCookie('alice'))
      .send({ title: `  ${'t'.repeat(500)}  `, body: '' });

    expect(res.status).toBe(201);
    expect(res.body.document.title).toHaveLength(120);
    expect(res.body.document.title).toMatch(/^t+$/);
  });

  it('a valid patch still applies — the omitted field is untouched', async () => {
    const before = getDocument(RUNBOOK);
    const res = await request(createApp())
      .patch(`${MOUNT}/documents/${RUNBOOK}`)
      .set('Cookie', sessionCookie('bob'))
      .send({ title: 'revised runbook' });

    expect(res.status).toBe(200);
    const stored = getDocument(RUNBOOK);
    expect(stored?.title).toBe('revised runbook');
    expect(stored?.body).toBe(before?.body); // undefined field ⇒ unchanged
    expect(stored?.ownerUsername).toBe('bob'); // owner is never patchable
  });
});

describe('the store wall (unit) — document_store enforces its invariants for ANY caller', () => {
  it('rejects blank, oversized, and wrong-typed titles without storing anything', () => {
    for (const title of ['', '   ', 7, 't'.repeat(121)]) {
      expect(() => updateDocument(ONBOARDING, { title } as { title: string })).toThrow(
        ValidationException,
      );
    }
    expect(getDocument(ONBOARDING)?.title).toBe('Onboarding notes');
  });

  it('rejects an oversized body and a wrong-typed body', () => {
    expect(() => updateDocument(ONBOARDING, { body: 'x'.repeat(64 * 1024 + 1) })).toThrow(
      ValidationException,
    );
    expect(() => updateDocument(ONBOARDING, { body: 42 as unknown as string })).toThrow(
      ValidationException,
    );
  });

  it('rejects unknown patch fields — a stray "owner" is the confused-deputy shape', () => {
    expect(() =>
      updateDocument(ONBOARDING, {
        title: 'hijack',
        owner: 'mallory',
      } as unknown as { title?: string }),
    ).toThrow(/unknown patch field "owner"/);
    expect(getDocument(ONBOARDING)?.ownerUsername).toBe('carol');
  });

  it('applies a valid patch, keeps undefined fields unchanged, and unknown ids stay undefined', () => {
    const before = getDocument(RUNBOOK);
    const updated = updateDocument(RUNBOOK, { title: 'store-level patch' });
    expect(updated?.title).toBe('store-level patch');
    expect(updated?.body).toBe(before?.body);
    expect(updateDocument('authz-nope', { title: 'x' })).toBeUndefined(); // 404 path
  });
});
