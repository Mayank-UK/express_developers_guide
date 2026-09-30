import type { Topic } from '../types.js';

/**
 * The Authorization topic: what an AUTHENTICATED caller may do. Built on the
 * same fixture as the authentication topic (alice/admin, bob/editor,
 * carol/viewer), with the live demo driving the real guards from
 * authz_demo_routes.ts — RBAC as data, ownership as the object-level check,
 * and the 401/403/404 discipline that makes failures readable.
 */
export const topicAuthorization: Topic = {
  id: 'authorization',
  title: 'Authorization',
  subtitle:
    'RBAC, permission middleware, and ownership checks — what an authenticated caller may do.',
  group: 'auth-security',
  order: 2,
  sections: [
    {
      id: 'authz-vs-authn',
      title: 'Authentication vs authorization',
      lead:
        'Authentication (the previous topic) proved WHO is calling. Authorization answers WHAT that identity may do — per request, per resource. Related words, different jobs, different bugs when conflated.',
      blocks: [
        {
          kind: 'text',
          id: 'authz-vs-authn:definition',
          body: `AUTHENTICATION IS WHO; AUTHORIZATION IS WHAT. By the time this topic's code runs, the caller has already proven their identity through one of the three credential families the authentication topic built — a session cookie, an API key, or a Bearer JWT. Authorization is every decision AFTER that: may this caller list documents? Edit THIS one? Delete another user's? The output of authentication is an identity (alice, admin); the output of authorization is a verdict (allow, or 403 with a reason). THE CLASSIC CONFLATION BUG, worth naming first because it ships in real products: an endpoint that checks "is there a valid session?" and calls it access control. carol is logged in — carol's session is perfectly valid — and carol must still not be able to delete alice's document. "Logged in" is a statement about authentication; it grants exactly nothing. The demo makes the distinction physical: GET /api/demo/authz/documents is guarded by requirePermission('documents:read') — a PERMISSION check, not a login check — and it happens to be a permission every role holds, so it feels like "any logged-in user may list". That coincidence is a design choice visible in the RBAC table, not a shortcut in the guard; flip viewer's row and the same endpoint starts refusing carol with a 403 naming the permission. WHY THEY'RE SEPARATE CONCERNS, beyond the bug above: they change on different schedules (credentials rotate; permissions change with every reorg), they fail differently (401 "I don't know who you are" vs 403 "I know you, and no"), and they're administered by different people (identity is an account concern; access is a product/policy concern). Coupling them — permissions hard-coded into the login handler, roles inferred from URL paths — guarantees that the next permission change is a deploy instead of a data change. THE CHECK HAPPENS AT TWO LAYERS, and this is the structural insight for the whole topic: (1) the ROUTE GUARD — middleware that runs before any handler, checking the coarse-grained question ("does this caller hold documents:write at all?"); (2) the DOMAIN RULE — the check that needs business state the route layer doesn't own ("is this caller the OWNER of document authz-deployment-runbook?"). In this app the first lives in presentation middleware (requirePermission / requireDocumentOwnerOrPermission in authz_demo_routes.ts) and the second in the domain's document_store + guard composition — both shown verbatim below. A permission system that lives ONLY at layer 1 goes stale the moment an endpoint forgets its guard; one that lives ONLY at layer 2 drowns every handler in hand-rolled checks. The two-layer shape — cheap coarse gate at the edge, precise object check where the data lives — is what you'll actually build.`,
        },
      ],
    },
    {
      id: 'authz-rbac',
      title: 'RBAC — role-based access control',
      lead:
        'A role is a NAME for a bundle of permissions: admin, editor, viewer. Users get roles; roles get permissions; routes require permissions. One table, readable in five seconds, drives every guard.',
      blocks: [
        {
          kind: 'text',
          id: 'authz-rbac:model',
          body: `THE MODEL IN THREE SENTENCES: users carry ROLES (the fixture: alice→admin, bob→editor, carol→viewer); roles map to PERMISSIONS through one table (admin ⊃ editor ⊃ viewer here); every protected route names the PERMISSION it requires, never a role. That last clause is the one teams break first — requireRole('admin') reads fine and rots fast (next quarter you add 'superadmin' and every admin:-check silently misses it); requirePermission('documents:delete') survives role renames, role additions, and re-bundling, because the route asked for WHAT it needed, not WHO it imagined providing it. THE TABLE IS DATA, NOT CODE — the entire point of the file you're about to read: ROLES = { admin: ['documents:read','documents:write','documents:delete','admin:demos'], editor: ['documents:read','documents:write'], viewer: ['documents:read'] }. Adding a permission is a one-line change every guard shares; the alternative — scattering if (user.roles.includes('admin')) through handlers — is how two endpoints that should enforce the same rule drift into enforcing different ones. Deny-by-default falls out of the shape for free: an unknown role name (typo, retired role, token from an older deploy) grants NOTHING, because the lookup just misses. WHERE ROLES LIVE — the identity plumbing: in the session world, the session stores only a USERNAME and roles are looked up live from the user record on every request (a role change takes effect immediately — demote alice and her next request is mortal). In the JWT world, roles ride IN the token as a claim — a snapshot from issue time that keeps speaking until exp, the staleness trade the authentication topic taught. This app's resolver deliberately normalizes both to the same answer: it takes the LIVE fixture record's roles even for bearer callers, so the demo's matrix behaves identically no matter which credential drove it — and the tension between "live lookup" (revocable, needs the store) and "claim snapshot" (stateless, stale) is exactly the session-vs-JWT seesaw you already know, now with authorization consequences. ROLE HIERARCHY PITFALLS: the tidy admin⊃editor⊃viewer pyramid is a TEACHING fixture, and real pyramids lie. The failure mode is implicit inheritance — code that assumes "editor can do everything viewer can" because the pyramid says so, instead of because the TABLE says so; this table makes the inheritance EXPLICIT by listing every permission per role (viewer's documents:read appears in all three rows — duplication is the price of no hidden coupling). The second failure mode is the hierarchy growing TALLER over time (viewer < editor < admin < superadmin < platform-admin...) until nobody can answer "who can delete a document?" without a meeting. WHEN RBAC GETS STALE — ROLE EXPLOSION: the moment a legitimate access pattern doesn't fit the bundles ("carol should edit HER team's documents but not others'"), the tempting fix is a new role (viewer-plus, team-editor, documents-editor-lite), and eighteen months later you have forty roles whose meanings survive only in tribal memory. The correct escalations, in order: check whether the missing axis is actually OWNERSHIP (next section — it usually is), whether it's a fine-grained PERMISSION (add one to the table), or whether the decision genuinely depends on attributes beyond roles (ABAC — the in-the-wild section). Roles are coarse BY DESIGN; when you find yourself encoding a matrix in role names, the model has run out.`,
        },
        {
          kind: 'code',
          id: 'authz-rbac:verbatim-table',
          language: 'ts',
          source: 'server/src/domain/authz/permissions.ts',
          caption: 'Verbatim — the RBAC table and the one function every guard reduces to (domain/authz/permissions.ts)',
          code: `// THE TABLE — the whole policy, readable in five seconds. Permissions read
// resource:action; roles are plain names; unknown roles grant NOTHING.
export const ROLE_PERMISSIONS: Readonly<Record<DemoRole, readonly AuthzPermission[]>> = {
  admin: ['documents:read', 'documents:write', 'documents:delete', 'admin:demos'],
  editor: ['documents:read', 'documents:write'],
  viewer: ['documents:read'],
};

// Flatten a caller's roles into their deduplicated permission set.
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

// THE function every route guard reduces to: does this set of roles include
// the required permission? A typo'd or retired role name must not fall
// through to "allowed" — deny by default.
export function roleHasPermission(roles: readonly string[], required: AuthzPermission): boolean {
  return permissionsForRoles(roles).includes(required);
}`,
        },
        {
          kind: 'code',
          id: 'authz-rbac:verbatim-middleware',
          language: 'ts',
          source: 'server/src/presentation/routes/authz_demo_routes.ts',
          caption: 'Verbatim — requirePermission: the middleware that turns the table into an HTTP gate (authz_demo_routes.ts)',
          code: `// requirePermission(permission) — the ROLE-level guard: authenticate via
// the unified resolver, then check the RBAC table. 401 when no credential
// resolves; 403 when the identity lacks the permission, WITH the required
// permission and the caller's actual set in the envelope details.
export function requirePermission(permission: AuthzPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = resolveRequestIdentity(req);   // cookie | x-api-key | Bearer
    if (identity === null) {
      throw new UnauthorizedException(
        'authentication required — present a session cookie, x-api-key, or Bearer token',
        { scheme: 'session | api-key | bearer' },
      );
    }
    (res.locals as AuthzLocals).identity = identity;

    if (!roleHasPermission(identity.roles, permission)) {
      throw new ForbiddenException(
        \`this endpoint requires the \${permission} permission\`,
        {
          requiredPermission: permission,          // the envelope NAMES the gap —
          userPermissions: permissionsForRoles(identity.roles),  // a 403 you can fix
        },
      );
    }
    next();
  };
}

// Mounted per route, so the guard is VISIBLE at the declaration site:
authzDemoRouter.get(
  '/demo/authz/documents',
  requirePermission('documents:read'),
  listDocumentsController,
);
authzDemoRouter.post(
  '/demo/authz/documents',
  requirePermission('documents:write'),
  createDocumentController,
);`,
        },
        {
          kind: 'demo',
          id: 'authz-rbac:matrix-demo',
          demoId: 'authz:matrix',
          title: 'The access checker: every action, every identity, real verdicts',
          description:
            'Act as alice/bob/carol (one-click real logins), then fire view/patch/delete at every owned document and watch the guards answer — 200 where allowed, 403 chips naming requiredPermission, 401 when anonymous. A create form (owner = the caller, decided server-side) and the roles×permissions matrix rendered from /catalog with the current row highlighted.',
        },
      ],
    },
    {
      id: 'authz-permissions-scopes',
      title: 'Permissions and scopes',
      lead:
        'Permissions grow finer than roles: resource:action strings, scope claims on credentials, and the catalog that keeps the UI honest about what the guards enforce.',
      blocks: [
        {
          kind: 'text',
          id: 'authz-permissions-scopes:model',
          body: `PERMISSIONS AS FINE-GRAINED CLAIMS: the strings in this topic's table — documents:read, documents:write, documents:delete, admin:demos — follow the resource:action convention you already met as the API-key SCOPES in the authentication topic (read:profile, write:profile, admin:demos). They are the same idea at two altitudes: a SCOPE is a CREDENTIAL's permission set (what THIS key may do — attached to the key, so alice can hold a read-only dashboard key and a full-power admin key on the same account), while a PERMISSION here is a ROLE's bundle (what holders of this role may do). Same vocabulary, different attachment point — and that difference is a real design lever: per-credential narrowing (scopes) lets you revoke the risky key without touching the account, while per-identity bundling (roles) keeps policy about PEOPLE in one place. Production systems often COMBINE them: the effective grant is the intersection of what the identity may do and what the credential it presented may do — this demo keeps them separate on purpose (the resolver resolves the USER, and the RBAC table answers) so each mechanism stays watchable; the intersection rule is the exercise left stated. CHECKS AS DATA, NOT CODE — the catalog: because the table is data, it can be SERVED as data. GET /api/demo/authz/catalog (public, deliberately — the policy for a teaching app is teaching material) returns the permission catalog DERIVED from the table: for each permission, which roles carry it and a one-line description. The demo UI renders its roles×permissions matrix FROM that endpoint, which means the matrix the user explores can never disagree with the middleware actually enforcing — the same single-source-of-truth discipline the OpenAPI drift-check specs apply to the API surface, applied to the POLICY surface. When permissions live as if-statements instead, no such catalog is derivable: the "what can roles do?" question gets answered by reading every handler, which is how documentation drifts into fiction. THE FORM OF A PERMISSION STRING matters more than it looks: resource:action sorts by noun (all documents:* permissions cluster), reads naturally in an audit log ("denied documents:delete for carol"), and greps precisely — a flat "canDeleteDocuments" boolean family loses the noun/verb split that makes 40-API surfaces stay nameable. Versions happen too: read:profile.v2 is a real pattern at API companies that need to ship a narrower claim without breaking v1 holders. FEATURE FLAGS ARE NEIGHBORS, ONE PARAGRAPH: a feature flag ("enable the new editor for 10% of users") and a permission ("documents:write") share machinery — a named boolean resolved per request from facts about the caller — and small systems routinely implement flags AS permissions and permissions AS flags. The difference is semantics and stakes: a permission is a SECURITY invariant whose wrong answer is a vulnerability; a flag is a RELEASE control whose wrong answer is a bug. Conflating them gets you either "security rollout gated on the flag platform's next outage" or "the admin kill-switch needs a security review"; keep the stores separate, share at most the evaluation habits (named, data-driven, deny-by-default, logged).`,
        },
        {
          kind: 'code',
          id: 'authz-permissions-scopes:verbatim-catalog',
          language: 'ts',
          source: 'server/src/domain/authz/permissions.ts',
          caption: 'Verbatim — the catalog, derived from the table (never hand-duplicated) so UI and guards cannot drift',
          code: `// PERMISSION_CATALOG is DERIVED — map over the closed permission set,
// filter the roles that carry each. The UI matrix renders from this; the
// middleware decides from the same ROLE_PERMISSIONS table; one source.
export const PERMISSION_CATALOG: readonly PermissionCatalogEntry[] = AUTHZ_PERMISSIONS.map(
  (permission) => ({
    permission,
    roles: AUTHZ_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission)),
    description: PERMISSION_DESCRIPTIONS[permission],
  }),
);

// Served publicly — the endpoint the demo's matrix panel fetches:
// GET /api/demo/authz/catalog →
// {
//   "permissions": [
//     { "permission": "documents:read",   "roles": ["admin","editor","viewer"], ... },
//     { "permission": "documents:write",  "roles": ["admin","editor"], ... },
//     { "permission": "documents:delete", "roles": ["admin"], ... },
//     { "permission": "admin:demos",      "roles": ["admin"], ... }
//   ],
//   "roles": [ { "role": "admin", "permissions": [...] }, ... ],
//   "ownershipRule": "ownership is an alternative path: the owner of a
//     document may PATCH and DELETE it regardless of role permissions ..."
// }`,
        },
      ],
    },
    {
      id: 'authz-ownership',
      title: 'Ownership — the object-level check',
      lead:
        "RBAC answers \"who may edit documents\". It cannot answer \"WHOSE document\" — that needs the object's owner in the check. The gap between the two questions is where IDOR, the most common access-control vuln on the web, lives.",
      blocks: [
        {
          kind: 'text',
          id: 'authz-ownership:model',
          body: `THE QUESTION RBAC CANNOT ANSWER: requirePermission('documents:write') can gate the EDITING FEATURE — but after the gate, the request names ONE document: PATCH /documents/authz-deployment-runbook. Whether THIS caller may touch THAT document depends on a fact the RBAC table will never contain: the document's OWNER. This is the object-level (row-level, per-resource) check, and it needs business state — load the row, compare its ownerUsername to the caller's identity. The demo's rule is deliberately two-pathed so both halves are visible: PATCH passes if the caller is the OWNER (carol, a viewer with no documents:write, can still edit her own onboarding notes — ownership beats the missing role permission) OR holds documents:write (the editor rule: bob may edit alice's architecture overview, because editors edit across owners — the UI says so explicitly so it never surprises you); DELETE passes if owner OR documents:delete — so alice (admin) can delete anything, while bob and carol can delete only their own. IDOR — INSECURE DIRECT OBJECT REFERENCE, the classic vulnerability class this section exists for: the request carries an object reference (the :documentId in the URL — equally a record id in a body or query param), the server faithfully loads that object, and the only missing line is "…and verify the CALLER may access it". The attack is not exotic: carol logs in (authenticated!), the UI only ever LINKS her to her own documents (the client did its job!), and then she edits the URL from /documents/authz-onboarding-notes to /documents/authz-deployment-runbook — and the server, asked for a document by id, returns it. OWASP has ranked broken access control at the TOP of its web Top 10 for years precisely because IDOR is this mechanical: no exploit tooling, no crypto to break, just an endpoint that forgot one comparison. Try it in the demo: act as carol, press PATCH on bob's runbook — the 403 envelope you get back (documentId, owner: bob, requiredPermission: documents:write) is the one line of code the vulnerable version omitted. THE CONFUSED-DEPUTY SHAPE — the sibling bug: a deputy is trusted code acting with YOUR authority; it becomes confused when it acts on an attacker's INSTRUCTIONS while holding someone else's AUTHORITY. In the object-check world the canonical shape: the create endpoint accepts an "owner" field from the client and the server, acting with its own authority, writes the attacker's choice — so anyone can mint documents owned by anyone (or transfer them). The fix in this app's createDocumentController is one line of placement: the owner is THE RESOLVED CALLER, decided server-side from the authenticated identity; a client-sent owner field is not honored, not read, not even looked at. The general rule: every input that names WHO or WHICH (owner, userId, accountId, tenantId) must be re-derived from the authenticated identity server-side, because the client is not just untrusted for authorization — it is the ATTACK SURFACE for authorization. RESOURCE-SHAPE VS VISIBILITY — THE HONEST TENSION: this API answers 404 for an unknown id and 403 for a known-but-forbidden one, which means a 403 CONFIRMS the id exists (and its owner, in the details!). Systems that must not leak existence — private profiles, payment records — answer 404 for BOTH, trading debuggability for opacity: the caller cannot distinguish "no such thing" from "none of your business". This demo chose readable 403s (with details naming the permission) because the lesson is watching the checks fire; the 404-as-denial pattern is the production variant to reach for when object existence is itself sensitive. Note the ordering discipline that makes either variant safe: 401 (no identity) BEFORE 404 (unknown id — never 403, which would confirm existence) BEFORE 403 (known id, insufficient grant) — spec'd and tested in that order.`,
        },
        {
          kind: 'code',
          id: 'authz-ownership:verbatim-guard',
          language: 'ts',
          source: 'server/src/presentation/routes/authz_demo_routes.ts',
          caption:
            "Verbatim — requireDocumentOwnerOrPermission: the object-level check, IDOR's one-line defense (authz_demo_routes.ts)",
          code: `// The OBJECT-level guard: the request names ONE document; the caller
// passes when they OWN it OR their roles carry the permission. This is the
// IDOR defense in miniature — the owner is loaded from the STORE and
// compared, never trusted from the request.
export function requireDocumentOwnerOrPermission(permission: AuthzPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = resolveRequestIdentity(req);
    if (identity === null) {
      throw new UnauthorizedException(
        'authentication required — present a session cookie, x-api-key, or Bearer token',  // 401 first
        { scheme: 'session | api-key | bearer' },
      );
    }
    (res.locals as AuthzLocals).identity = identity;

    const document = getDocument(documentIdFrom(req));
    if (document === undefined) {
      throw new NotFoundException(\`no document with id "\${documentIdFrom(req)}"\`);
    }   // ^ 404 BEFORE 403 — an unknown id is "not found", never "forbidden":
        //   a 403 would CONFIRM the id exists (resource-shape vs visibility).

    const isOwner = document.ownerUsername === identity.username;   // THE line
    if (!isOwner && !roleHasPermission(identity.roles, permission)) {
      throw new ForbiddenException(
        \`only the owner or a caller with \${permission} may do this\`,
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

// And the confused-deputy guard at CREATE — the owner is THE CALLER,
// decided server-side; a client-sent "owner" field would be the bug:
const document = createDocument({ title, body, ownerUsername: identity.username });

// Mounted per action, with the two-path rule visible at the declaration:
authzDemoRouter.patch(
  '/demo/authz/documents/:documentId',
  requireDocumentOwnerOrPermission('documents:write'),   // owner OR write
  patchDocumentController,
);
authzDemoRouter.delete(
  '/demo/authz/documents/:documentId',
  requireDocumentOwnerOrPermission('documents:delete'),  // owner OR delete
  deleteDocumentController,
);`,
        },
      ],
    },
    {
      id: 'authz-deny-by-default',
      title: 'Deny by default, fail closed',
      lead:
        'When anything about the decision is uncertain — unknown role, missing identity, errored lookup — the answer is NO. Plus the two disciplines that keep the system honest: 401 vs 403 semantics, and never authorizing in the client.',
      blocks: [
        {
          kind: 'text',
          id: 'authz-deny-by-default:rules',
          body: `DENY BY DEFAULT means the ABSENCE of an allow is a deny, everywhere: a role that isn't in the table grants nothing (roleHasPermission misses and returns false), a route without a guard gets no authenticated identity (the resolver returns null and the first protected action 401s), an unknown permission string in a guard would fail every caller — loudly, which is the point. The opposite posture, allow-by-default, usually sneaks in through error handling: the lookup of the caller's roles THROWS and a try/catch somewhere swallows it and continues; the token-verification service times out and the gateway routes anyway; the permissions cache returns empty and someone decides empty means "no restrictions". FAIL CLOSED is the same rule under failure: when the decision cannot be made, the request is REFUSED — this app's shape does it structurally (verifyJwt returns a Result, the resolver returns null on any failed verification, and null flows to a 401 — there is no code path where a failed check becomes an allow). In distributed systems the classic fail-open bug is the auth service being DOWN: the fallback that serves reads unauthenticated "for availability" is a breach waiting for exactly one outage. 401 VS 403 SEMANTICS — the recap that keeps clients honest (PART 1 drilled it; authorization owns it): 401 UNAUTHORIZED is an AUTHENTICATION failure — no credential, expired session, garbage token; the client's correct response is to (re)authenticate, which is why 401 carries WWW-Authenticate in the wild. 403 FORBIDDEN is an AUTHORIZATION failure — identity fully established, verdict NO; re-authenticating changes nothing (carol logging in HARDER is still carol). Returning 401 for a permission failure sends clients into login loops; returning 403 for a missing credential hides the fix. This app's envelopes make the distinction machine-readable too: the 403 carries requiredPermission (+ userPermissions, and for object checks documentId/owner) so a client can render "you need documents:write" instead of a shrug — and note what those details never contain: anything that would help an ATTACKER enumerate (the envelope names the policy, not other users' secrets). NEVER AUTHORIZE IN THE CLIENT — the rule with no exception: a React component that hides the DELETE button from carol is UX, not security; the request carol's browser didn't send, her curl can. The client's job is to be a GOOD CITIZEN (hide what would 403, show honest error states — this demo's forbidden chips), and the server's job is to be the ONLY enforcer — which is why the demo lets you fire every action as every user: the UI never pretends a button's absence is a control. The related trap is SERVER-TRUSTED CLIENT INPUT: the Referer header, a "role" field in a JSON body, an isAdmin query param — every authorization-relevant fact must derive from the verified credential server-side (the ownership section's confused-deputy rule, restated because it IS the client rule). LOGGING DENIALS — the discipline that pays for itself the first time something is off: every 401/403 this app produces already rides the error pipeline, which means pino logs it with the request ID, the path, the identity-when-known, and the failure details (requiredPermission and friends) — the exact trail an incident review needs ("who was probing admin endpoints at 3am, and did anything SUCCEED right after"). What denials logs must NOT contain: the credential itself (no tokens, no passwords, no keys in logs — the session store's masked-token discipline applies to log lines too). Alerting on the shape is cheap and catches both attacks (sudden 403 bursts) and bugs (a shipped UI calling an endpoint nobody can pass — your own confused deputy, caught by the same log).`,
        },
        {
          kind: 'code',
          id: 'authz-deny-by-default:verbatim-ordering',
          language: 'ts',
          source: 'server/src/presentation/routes/authz_demo_routes.spec.ts',
          caption: 'Verbatim — the failure order, spec\'d and tested: 401 before 404, 404 before 403 (authz_demo_routes.spec.ts)',
          code: `it('an unknown id with NO credential → 401 (authenticate first)', async () => {
  const res = await request(createApp()).patch(\`\${MOUNT}/documents/authz-nope\`);
  expect(res.status).toBe(401);
});

it('an unknown id WITH authentication → 404, never 403 (a 403 would confirm the id exists)', async () => {
  for (const [method, send] of [
    ['patch', () => ({ body: 'x' })],
    ['delete', () => undefined],
  ] as const) {
    const res = await request(createApp())
      [method](\`\${MOUNT}/documents/authz-nope\`)
      .set('Cookie', sessionCookie('carol'))
      .send(send());
    expect(res.status, method).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  }
});

// The full matrix the spec walks (every cell the topic teaches):
//   carol (viewer):   list ✓ · create ✗403 · patch OWN ✓(owner) · patch bob's ✗403 ·
//                     delete own ✓(owner) · delete alice's ✗403
//   bob   (editor):   create ✓(becomes owner) · patch alice's ✓(documents:write —
//                     the editor rule) · delete alice's ✗403 · delete own ✓
//   alice (admin):    delete bob's ✓(documents:delete outranks ownership)
//   nobody:           everything 401 · and by cookie, key, OR bearer alike`,
        },
      ],
    },
    {
      id: 'authz-in-the-wild',
      title: 'Authorization in the wild',
      lead:
        'Beyond roles: attribute-based rules and policy engines, the tenant-isolation variant of the object check, and how services authorize each other.',
      blocks: [
        {
          kind: 'text',
          id: 'authz-in-the-wild:map',
          body: `ABAC AND POLICY ENGINES — one paragraph, because you should know the names before you need them: when decisions stop fitting "role + ownership" — "editors may unpublished-drafts only in their DEPARTMENT, during BUSINESS HOURS, from MANAGED DEVICES" — the model becomes ABAC (attribute-based access control): rules over attributes of the subject (roles, department), the resource (owner, status), the action, and the environment (time, IP). Hand-rolling ABAC as nested ifs is unmaintainable by rule ten, which is why policy engines exist: CASBIN (the polyglot favorite — policies as a model file, access_control_model + policy CSV, enforced via an adapter in your handler) and OPA / Open Policy Agent (policies in its rego language, evaluated out-of-process with the request as input JSON — the Kubernetes admission-controller pedigree). The adoption rule of thumb: RBAC + ownership covers most apps to a comfortable size; reach for an engine when the POLICY itself needs to be deployed or audited independently of the code — and note that this topic's "table as data" move (ROLE_PERMISSIONS, the catalog endpoint) is the same decoupling at toy scale: the policy became data the day it was a table. MULTI-TENANT ISOLATION — the object check at platform scale: a tenant (organization, workspace) is just an owner with a foreign key — every row carries tenant_id the way these documents carry ownerUsername — and "may the caller touch this row" becomes "does the caller's tenant match the row's tenant", enforced in ONE place (the query's WHERE clause or the repository's scope, not per-endpoint) so no handler can forget it. The failure story is the same IDOR with more zeroes: the cross-tenant read leaks an entire company's data instead of one user's document. The two hard rules: the tenant filter must be UNFORGETTABLE (default-scoped queries where an unscoped finder is impossible or loud) and the tenant id must come from the AUTHENTICATED identity server-side (the confused-deputy rule — a tenant-id in a JWT claim set by YOUR token issuer, never a header the client freely types). This guide's demo keeps ownerUsername per-document and the check in the guard — the single-place enforcement in miniature. SERVICE-TO-SERVICE AUTHORIZATION — the last axis, pointer included: when the caller is another SERVICE, "who" becomes a workload identity and the credentials are the ones the authentication topic's choosing section mapped — scoped API keys (the scope check IS the authorization), or mTLS where BOTH sides present certificates signed by a cluster CA (the authorization is the certificate's identity + SPIFFE-style workload names, and the TLS handshake is simultaneously the encryption), or short-lived JWTs minted per hop. The pattern that scales past pairwise trust: a token SERVICE issues narrowly-scoped, short-TTL tokens for each call chain (the OAuth machinery you already read, minus the human) — service A never holds service B's long-lived secret, it holds a five-minute assertion of exactly what it's doing. The security topic returns to the credential-hygiene half of this story; the authorization half is what you built above, unchanged: identify, then check the permission — the callee decides, always.`,
        },
      ],
    },
    {
      id: 'authz-live',
      title: 'The permission matrix from a terminal',
      lead:
        'The access checker now lives in the RBAC section above. This closing section is the terminal companion: the same matrix driven by curl — through the session cookie, the API key, and the Bearer JWT alike, which is exactly how the resolver sees every caller.',
      blocks: [
        {
          kind: 'text',
          id: 'authz-live:intro',
          body: `THE TERMINAL MATRIX, top to bottom. Start from the POLICY itself: GET /catalog serves the RBAC table AS DATA — the derived catalog the checker's matrix renders above, so what you read is what the middleware enforces. Log in as carol (viewer) with a cookie jar, then walk the verdicts: reading the document list passes (documents:read she has); creating one is the 403 envelope that NAMES documents:write beside her actual permission set — a 403 you can fix, not a shrug; patching her OWN document passes on ownership alone (the object-level check beating the missing role permission); and patching alice's is the same check failing — IDOR, defended, with documentId and owner in the details. SWITCH IDENTITY BY HEADER instead of cookie: alice's API key deleting bob's runbook (documents:delete outranks ownership), then a freshly issued Bearer JWT for bob editing alice's document under the editor rule — three credential families, one resolver, one identity shape, which is the whole point of the guard. End on the FAILURE ORDER the specs pin: an unknown id with no credential is 401 (authenticate first), with one it is 404 — never a 403 that would confirm the id exists. The interactive checker above renders these same verdicts as chips; this block is the script's-eye view of the identical guards.`,
        },
        {
          kind: 'code',
          id: 'authz-live:curl',
          language: 'bash',
          caption: 'The permission matrix from a terminal — session, API key, and Bearer alike',
          code: `# The policy, served as data (public — the matrix the UI renders):
curl -s localhost:4000/api/demo/authz/catalog | jq '.permissions'

# Log in as carol (viewer) — the cookie jar carries the session:
curl -s -c /tmp/guide.jar -X POST localhost:4000/api/demo/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"carol","password":"guide-demo-pw"}' > /dev/null

# Viewer CAN read (documents:read she has)…
curl -s -b /tmp/guide.jar localhost:4000/api/demo/authz/documents | jq '{count: (.documents|length), owners: [.documents[].ownerUsername]}'

# …create → 403 naming the permission, create → the envelope's details:
curl -s -b /tmp/guide.jar -X POST localhost:4000/api/demo/authz/documents \\
  -H 'Content-Type: application/json' -d '{"title":"nope","body":"x"}' \\
  | jq '.error | {code, requiredPermission, userPermissions}'
# → { "code": "forbidden", "requiredPermission": "documents:write",
#     "userPermissions": ["documents:read"] }

# …PATCH her OWN document → 200 (ownership beats the missing permission)…
curl -s -b /tmp/guide.jar -X PATCH localhost:4000/api/demo/authz/documents/authz-onboarding-notes \\
  -H 'Content-Type: application/json' -d '{"body":"carol edits her own"}' | jq '.document.ownerUsername'

# …but PATCH alice's → the object-level 403 (IDOR, defended):
curl -s -b /tmp/guide.jar -X PATCH localhost:4000/api/demo/authz/documents/authz-architecture-overview \\
  -H 'Content-Type: application/json' -d '{"body":"sneaky"}' \\
  | jq '.error | {code, documentId, owner, requiredPermission}'

# Switch to alice by API KEY — the resolver unifies the schemes; admin deletes
# bob's runbook (documents:delete outranks ownership):
curl -s -H 'x-api-key: gsk_demo_alice_2mFnQ7xK' \\
  -X DELETE localhost:4000/api/demo/authz/documents/authz-deployment-runbook | jq '{deleted, id}'

# …or by BEARER JWT (issue per PART 1, then present it):
TOKEN=$(curl -s -X POST localhost:4000/api/demo/auth/jwt/issue \\
  -H 'Content-Type: application/json' -d '{"username":"bob"}' | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" \\
  -X PATCH localhost:4000/api/demo/authz/documents/authz-architecture-overview \\
  -H 'Content-Type: application/json' -d '{"title":"edited by bob (editor rule)"}' \\
  | jq '{identity: .identity.username, owner: .document.ownerUsername}'

# The failure order: unknown id + no credential → 401; with one → 404 (never 403):
curl -s -o /dev/null -w '%{http_code}\\n' -X PATCH localhost:4000/api/demo/authz/documents/authz-nope   # 401
curl -s -o /dev/null -w '%{http_code}\\n' -b /tmp/guide.jar \\
  -X PATCH localhost:4000/api/demo/authz/documents/authz-nope                                          # 404`,
        },
      ],
    },
  ],
};
