import type { DemoRole } from '../auth/demo_users.js';

/**
 * The RBAC table as DATA, not code: roles are names, permissions are strings,
 * and the mapping between them is one plain object a review can read in five
 * seconds. Adding a permission is a one-line change every route shares; the
 * alternative — scattering `if (user.roles.includes('admin'))` through the
 * handlers — is how authorization logic drifts out of sync with itself.
 *
 * The permission strings read resource:action (documents:read), mirroring the
 * API-key scopes from the authentication topic (read:profile) so the two
 * vocabularies feel like one family: a scope is a credential's permission set,
 * a role is a user's permission bundle.
 */

/** Every permission the demo knows — the closed set the UI matrix renders. */
export const AUTHZ_PERMISSIONS = [
  'documents:read',
  'documents:write',
  'documents:delete',
  'admin:demos',
] as const;

export type AuthzPermission = (typeof AUTHZ_PERMISSIONS)[number];

/**
 * The role → permissions table. admin is a strict superset of editor which is
 * a strict superset of viewer — the tidy hierarchy that makes a good teaching
 * fixture (and the "role explosion" cautionary tale is taught against it).
 */
export const ROLE_PERMISSIONS: Readonly<Record<DemoRole, readonly AuthzPermission[]>> = {
  admin: ['documents:read', 'documents:write', 'documents:delete', 'admin:demos'],
  editor: ['documents:read', 'documents:write'],
  viewer: ['documents:read'],
};

/** The roles that carry any weight in checks, in hierarchy order. */
export const AUTHZ_ROLES: readonly DemoRole[] = ['admin', 'editor', 'viewer'];

/** Flattens a caller's roles into their deduplicated permission set. */
export function permissionsForRoles(roles: readonly string[]): AuthzPermission[] {
  const granted = new Set<AuthzPermission>();
  for (const role of roles) {
    const table = ROLE_PERMISSIONS[role as DemoRole];
    if (table !== undefined) {
      for (const permission of table) granted.add(permission);
    }
  }
  return AUTHZ_PERMISSIONS.filter((permission) => granted.has(permission));
}

/**
 * THE function every route guard reduces to: does this set of roles include
 * the required permission? Unknown roles grant nothing (deny by default —
 * a typo'd or retired role name must not fall through to "allowed").
 */
export function roleHasPermission(roles: readonly string[], required: AuthzPermission): boolean {
  return permissionsForRoles(roles).includes(required);
}

/** One catalog row: a permission and which roles carry it. */
export interface PermissionCatalogEntry {
  readonly permission: AuthzPermission;
  readonly roles: readonly DemoRole[];
  readonly description: string;
}

const PERMISSION_DESCRIPTIONS: Readonly<Record<AuthzPermission, string>> = {
  'documents:read': 'list and read the demo documents — every authenticated role has it',
  'documents:write':
    'create documents and edit ANY document (the editor rule: editors may edit across owners)',
  'documents:delete':
    'delete ANY document — admin only; ownership is the other path to delete (owners may delete their own)',
  'admin:demos':
    'the admin-only demo permission, shared with the API-key scope of the same name',
};

/**
 * The permission catalog, derived FROM the table (never hand-duplicated): the
 * UI renders its roles×permissions matrix from this, so the matrix can never
 * disagree with the middleware's actual decisions.
 */
export const PERMISSION_CATALOG: readonly PermissionCatalogEntry[] = AUTHZ_PERMISSIONS.map(
  (permission) => ({
    permission,
    roles: AUTHZ_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission)),
    description: PERMISSION_DESCRIPTIONS[permission],
  }),
);
