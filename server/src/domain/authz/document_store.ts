/**
 * The authorization topic's owned resources: an in-memory document store where
 * every document carries an OWNER — because RBAC answers "who may edit
 * documents" and ownership answers "WHOSE document", and the gap between
 * those two questions is where IDOR lives (the topic's centerpiece lesson).
 *
 * Same in-memory-per-process trade as the session store, stated once: a real
 * app persists these rows; the mechanism being taught is the ACCESS RULE, not
 * the storage. State is deliberately simple — a fixed seeded set, create
 * allowed, delete allowed, no row-count cap needed at demo scale (field-level
 * caps ARE enforced below — the store does not trust its callers; and reset
 * between specs via the test-only helper, mirroring session_store's pattern).
 */

import { ValidationException } from '../../core/error_handling/exceptions.js';

/** What a stored document is. `ownerUsername` is the authorization-relevant column. */
export interface StoredDocument {
  readonly id: string;
  title: string;
  body: string;
  /** WHO owns this row — the object-level check's subject. */
  readonly ownerUsername: string;
  updatedAt: number;
}

/** What any response may echo (updatedAt as ISO, id stable). */
export interface DocumentPublicView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly ownerUsername: string;
  readonly updatedAt: string;
}

export function toDocumentPublicView(document: StoredDocument): DocumentPublicView {
  return {
    id: document.id,
    title: document.title,
    body: document.body,
    ownerUsername: document.ownerUsername,
    updatedAt: new Date(document.updatedAt).toISOString(),
  };
}

const documents = new Map<string, StoredDocument>();

/** Ids are authz- prefixed per the demo conventions and human-readable in curls. */
function seed(): void {
  const rows: ReadonlyArray<Omit<StoredDocument, 'updatedAt'>> = [
    {
      id: 'authz-architecture-overview',
      title: 'Architecture overview',
      body: 'The guide app is a monorepo: an Express server that owns 100% of the teaching content, and a React client that only renders it.',
      ownerUsername: 'alice',
    },
    {
      id: 'authz-deployment-runbook',
      title: 'Deployment runbook',
      body: 'docker compose up the dev stack, or build both packages and compose the prod stack. Ports: server 4000, client 5173.',
      ownerUsername: 'bob',
    },
    {
      id: 'authz-onboarding-notes',
      title: 'Onboarding notes',
      body: 'Start with the Authentication topic, then this one. The demo password is guide-demo-pw and the API keys are listed by a public endpoint.',
      ownerUsername: 'carol',
    },
  ];
  const updatedAt = Date.parse('2026-09-28T10:00:00.000Z'); // fixed, so listings are deterministic
  for (const row of rows) {
    documents.set(row.id, { ...row, updatedAt });
  }
}
seed();

/** Lists every document in stable order (seeded first, then created order). */
export function listDocuments(): StoredDocument[] {
  return [...documents.values()];
}

/** Exact-match lookup by id (undefined when unknown — the 404 path). */
export function getDocument(id: string): StoredDocument | undefined {
  return documents.get(id);
}

/** Monotonic suffix for created documents: authz-doc-4, authz-doc-5, … */
let createdCounter = documents.size;

// --- entity invariants: the store does not trust its callers -------------------
//
// The route layer validates for NICE ERRORS (field-level messages, titles
// trimmed, the 120-cap applied by truncation); these invariants are DEFENSE IN
// DEPTH — the second, independent wall. Any caller that reaches past the HTTP
// edge (a future use case, a script, a test) must not be able to store what
// the API itself would have refused: a blank title, a 10 MB "body", or a
// wrong-typed field riding on `any`. A breach throws the app's ONE typed
// taxonomy from the write itself, so the global error middleware renders the
// standard 400 validation envelope — by the time it reaches a client it is
// indistinguishable from an edge-validation failure.
//
// The caps, chosen to agree with limits the app already documents:
// - TITLE: 120 characters — the same ceiling the routes apply (they truncate
//   to it; the store refuses PAST it: one number, belt and suspenders).
// - BODY: 64 KiB — a text note's ceiling, deliberately UNDER the root JSON
//   parser's 100kb default so the STORE's 400 envelope is what a caller sees;
//   the files topic makes the same trade in the other direction (a 5MB cap
//   enforced by the controller under a 6mb raw limit — the entity owns the
//   real cap, the transport sits above it, and the 413 stays unreachable).

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 64 * 1024;

function assertValidTitle(title: unknown): void {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new ValidationException('a document title must be a non-empty string', {
      fields: { title: `a non-empty string, at most ${String(MAX_TITLE_LENGTH)} characters` },
    });
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationException(
      `a document title may not exceed ${String(MAX_TITLE_LENGTH)} characters`,
      { fields: { title: `at most ${String(MAX_TITLE_LENGTH)} characters (got ${String(title.length)})` } },
    );
  }
}

function assertValidBody(body: unknown): void {
  if (typeof body !== 'string') {
    throw new ValidationException('a document body must be a string', {
      fields: { body: 'a string (empty is fine)' },
    });
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new ValidationException(
      `a document body may not exceed ${String(MAX_BODY_LENGTH)} characters`,
      { fields: { body: `at most ${String(MAX_BODY_LENGTH)} characters (got ${String(body.length)})` } },
    );
  }
}

export function createDocument(input: {
  title: string;
  body: string;
  ownerUsername: string;
}): StoredDocument {
  assertValidTitle(input.title);
  assertValidBody(input.body);
  createdCounter += 1;
  const createdAt = Date.now();
  const document: StoredDocument = {
    id: `authz-doc-${String(createdCounter)}`,
    title: input.title,
    body: input.body,
    ownerUsername: input.ownerUsername,
    updatedAt: createdAt,
  };
  documents.set(document.id, document);
  return document;
}

/**
 * Applies a partial update and stamps updatedAt. Returns the new row state,
 * or undefined when the id is unknown (the 404 path — checked FIRST, mirroring
 * the route's documented order: 404 before 400). Patch invariants: only title
 * and body may appear, each right-typed and within its cap (an unknown key —
 * a stray "owner", say — is the confused-deputy shape, refused loudly); every
 * field is validated BEFORE any is applied, so a half-valid patch stores
 * NOTHING (all-or-nothing, not best-effort).
 */
export function updateDocument(
  id: string,
  patch: { title?: string; body?: string },
): StoredDocument | undefined {
  const document = documents.get(id);
  if (document === undefined) return undefined;
  if (typeof patch !== 'object' || patch === null) {
    throw new ValidationException('the patch must be an object with optional title and body');
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'title' && key !== 'body') {
      throw new ValidationException(
        `unknown patch field "${key}" — only title and body may be updated`,
        { fields: { [key]: 'not a patchable field' } },
      );
    }
  }
  if (patch.title !== undefined) assertValidTitle(patch.title);
  if (patch.body !== undefined) assertValidBody(patch.body);
  if (patch.title !== undefined) document.title = patch.title;
  if (patch.body !== undefined) document.body = patch.body;
  document.updatedAt = Date.now();
  return document;
}

/** Deletes by id. Returns whether there was a row to delete. */
export function deleteDocument(id: string): boolean {
  return documents.delete(id);
}

/** Test-only: a clean slate between cases (the session-store reset pattern). */
export function resetDocumentStoreForTests(): void {
  documents.clear();
  seed();
  createdCounter = documents.size;
}
