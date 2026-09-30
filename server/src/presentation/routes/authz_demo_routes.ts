import { Router, type NextFunction, type Request, type Response } from 'express';
import { ForbiddenException, NotFoundException, UnauthorizedException, ValidationException } from '../../core/error_handling/exceptions.js';
import {
  AUTHZ_ROLES,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  permissionsForRoles,
  roleHasPermission,
  type AuthzPermission,
} from '../../domain/authz/permissions.js';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  toDocumentPublicView,
  updateDocument,
} from '../../domain/authz/document_store.js';
import { resolveRequestIdentity, type ResolvedIdentity } from '../../domain/authz/identity_resolver.js';

/**
 * The authorization topic's live demo endpoints — the RBAC + ownership rules
 * the topic teaches, enforced by REAL middleware over the same identity
 * fixture the authentication topic introduced (alice/admin, bob/editor,
 * carol/viewer). Identity may arrive by ANY of PART 1's three credential
 * families — session cookie, x-api-key, or Bearer JWT — because authz sits
 * downstream of authn: the resolver unifies them, the guards never care.
 *
 * - GET  /api/demo/authz/catalog            → PUBLIC: the permission catalog + roles matrix (derived from the RBAC table)
 * - GET  /api/demo/authz/documents          → documents:read (every authenticated role has it)
 * - POST /api/demo/authz/documents          → documents:write; the caller becomes the owner → 201
 * - GET  /api/demo/authz/documents/:id      → documents:read (any authenticated caller may READ any document)
 * - PATCH /api/demo/authz/documents/:id     → owner OR documents:write (the editor rule: editors edit across owners)
 * - DELETE /api/demo/authz/documents/:id    → owner OR documents:delete (so alice deletes anything; bob/carol only their own)
 *
 * The two guards are the curriculum:
 * - requirePermission(permission)            — the ROLE-level check (RBAC)
 * - requireDocumentOwnerOrPermission(p)      — the OBJECT-level check (ownership OR role)
 *
 * Failure order is deliberate and spec'd: 401 (no identity) → 404 (unknown id)
 * → 403 (known id, insufficient grant). Every failure rides the standard
 * envelope, with details that NAME the missing permission — a 403 you can
 * read is a 403 you can fix.
 */

export const AUTHZ_DEMO_MOUNT_PATH = '/api/demo/authz';

// --- the guards (the real artifacts) ------------------------------------------------------

/** Typed view of what the guards attach for downstream handlers. */
interface AuthzLocals {
  identity?: ResolvedIdentity;
}

/**
 * Express 5 types route params as string | string[] (wildcards are arrays) —
 * this route's :documentId is always a single segment, so coerce once here.
 */
function documentIdFrom(req: Request): string {
  return String(req.params.documentId);
}

function identityOf(res: Response): ResolvedIdentity {
  const identity = (res.locals as AuthzLocals).identity;
  if (identity === undefined) {
    // Unreachable when a guard ran first — routes and guards are declared together.
    throw new UnauthorizedException('no identity on the request (guard missing)');
  }
  return identity;
}

/**
 * requirePermission(permission) — the ROLE-level guard: authenticate via the
 * unified resolver, then check the RBAC table. 401 when no credential
 * resolves (the caller is nobody); 403 when the identity lacks the
 * permission, with the required permission and the caller's actual set in
 * the envelope details so the failure is self-explanatory.
 */
export function requirePermission(permission: AuthzPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = resolveRequestIdentity(req);
    if (identity === null) {
      throw new UnauthorizedException(
        'authentication required — present a session cookie, x-api-key, or Bearer token',
        { scheme: 'session | api-key | bearer' },
      );
    }
    (res.locals as AuthzLocals).identity = identity;

    if (!roleHasPermission(identity.roles, permission)) {
      throw new ForbiddenException(
        `this endpoint requires the ${permission} permission`,
        {
          requiredPermission: permission,
          userPermissions: permissionsForRoles(identity.roles),
        },
      );
    }
    next();
  };
}

/**
 * requireDocumentOwnerOrPermission(permission) — the OBJECT-level guard: the
 * request names ONE document (:documentId), and the caller passes when they
 * own it OR their roles carry the permission. This is the IDOR defense in
 * miniature: the object's owner is loaded from the store and compared, not
 * trusted from the request.
 *
 * Failure order: 401 (no identity) → 404 (unknown id — never 403, which
 * would confirm the id exists) → 403 (known id, neither owner nor holder).
 */
export function requireDocumentOwnerOrPermission(permission: AuthzPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = resolveRequestIdentity(req);
    if (identity === null) {
      throw new UnauthorizedException(
        'authentication required — present a session cookie, x-api-key, or Bearer token',
        { scheme: 'session | api-key | bearer' },
      );
    }
    (res.locals as AuthzLocals).identity = identity;

    const document = getDocument(documentIdFrom(req));
    if (document === undefined) {
      throw new NotFoundException(`no document with id "${documentIdFrom(req)}"`);
    }

    const isOwner = document.ownerUsername === identity.username;
    if (!isOwner && !roleHasPermission(identity.roles, permission)) {
      throw new ForbiddenException(
        `only the owner or a caller with ${permission} may do this`,
        {
          documentId: document.id,
          owner: document.ownerUsername,
          requiredPermission: permission,
          userPermissions: permissionsForRoles(identity.roles),
        },
      );
    }
    next();
  };
}

// --- input parsing -------------------------------------------------------------------------

const MAX_TITLE_LENGTH = 120;

function parseCreateBody(raw: unknown): { title: string; body: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationException('the create payload must be a JSON object', {
      fields: { body: 'must be a JSON object with title and body' },
    });
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.title !== 'string' || record.title.trim().length === 0) {
    throw new ValidationException('"title" must be a non-empty string', {
      fields: { title: `a non-empty string, at most ${String(MAX_TITLE_LENGTH)} characters` },
    });
  }
  if (typeof record.body !== 'string') {
    throw new ValidationException('"body" must be a string (empty is fine)', {
      fields: { body: 'a string' },
    });
  }
  const title = record.title.trim().slice(0, MAX_TITLE_LENGTH);
  return { title, body: record.body };
}

function parsePatchBody(raw: unknown): { title?: string; body?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationException('the patch payload must be a JSON object', {
      fields: { body: 'must be a JSON object with optional title and body' },
    });
  }
  const record = raw as Record<string, unknown>;
  if (record.title === undefined && record.body === undefined) {
    throw new ValidationException('nothing to update — provide title and/or body', {
      fields: { body: 'at least one of title, body is required' },
    });
  }
  const patch: { title?: string; body?: string } = {};
  if (record.title !== undefined) {
    if (typeof record.title !== 'string' || record.title.trim().length === 0) {
      throw new ValidationException('"title" must be a non-empty string when provided', {
        fields: { title: 'a non-empty string' },
      });
    }
    patch.title = record.title.trim().slice(0, MAX_TITLE_LENGTH);
  }
  if (record.body !== undefined) {
    if (typeof record.body !== 'string') {
      throw new ValidationException('"body" must be a string when provided', {
        fields: { body: 'a string' },
      });
    }
    patch.body = record.body;
  }
  return patch;
}

// --- controllers ---------------------------------------------------------------------------

function catalogController(_req: Request, res: Response): void {
  // Public by design: the RBAC table is teaching material, and the UI matrix
  // renders FROM it — one source of truth for what the guards enforce.
  res.status(200).json({
    permissions: PERMISSION_CATALOG,
    roles: AUTHZ_ROLES.map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] })),
    ownershipRule:
      'ownership is an alternative path: the owner of a document may PATCH and DELETE it regardless of role permissions (viewers can edit their own)',
  });
}

function listDocumentsController(_req: Request, res: Response): void {
  const identity = identityOf(res);
  res.status(200).json({
    documents: listDocuments().map(toDocumentPublicView),
    identity,
  });
}

function createDocumentController(req: Request, res: Response): void {
  const identity = identityOf(res);
  const { title, body } = parseCreateBody(req.body);
  // The owner is THE CALLER, decided server-side — a client-sent "owner"
  // field would be the confused-deputy bug the topic teaches.
  const document = createDocument({ title, body, ownerUsername: identity.username });
  res.status(201).json({ document: toDocumentPublicView(document), identity });
}

function documentDetailController(req: Request, res: Response): void {
  const identity = identityOf(res);
  const document = getDocument(documentIdFrom(req));
  if (document === undefined) {
    throw new NotFoundException(`no document with id "${documentIdFrom(req)}"`);
  }
  res.status(200).json({ document: toDocumentPublicView(document), identity });
}

function patchDocumentController(req: Request, res: Response): void {
  const identity = identityOf(res);
  const patch = parsePatchBody(req.body);
  const document = updateDocument(documentIdFrom(req), patch);
  if (document === undefined) {
    // The guard already proved existence; this guards the race where the row
    // vanished between guard and write (delete-then-patch from two tabs).
    throw new NotFoundException(`no document with id "${documentIdFrom(req)}"`);
  }
  res.status(200).json({ document: toDocumentPublicView(document), identity });
}

function deleteDocumentController(req: Request, res: Response): void {
  const identity = identityOf(res);
  const id = documentIdFrom(req);
  const deleted = deleteDocument(id);
  if (!deleted) {
    throw new NotFoundException(`no document with id "${id}"`);
  }
  res.status(200).json({ deleted: true, id, identity });
}

export const authzDemoRouter = Router();
authzDemoRouter.get('/demo/authz/catalog', catalogController);
authzDemoRouter.get(
  '/demo/authz/documents',
  requirePermission('documents:read'),
  listDocumentsController,
);
authzDemoRouter.post(
  '/demo/authz/documents',
  requirePermission('documents:write'),
  createDocumentController,
);
authzDemoRouter.get(
  '/demo/authz/documents/:documentId',
  requirePermission('documents:read'),
  documentDetailController,
);
authzDemoRouter.patch(
  '/demo/authz/documents/:documentId',
  requireDocumentOwnerOrPermission('documents:write'),
  patchDocumentController,
);
authzDemoRouter.delete(
  '/demo/authz/documents/:documentId',
  requireDocumentOwnerOrPermission('documents:delete'),
  deleteDocumentController,
);
