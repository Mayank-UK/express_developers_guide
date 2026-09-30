import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';

/**
 * The Post entity — the domain's own shape. Timestamps are ISO strings (the
 * storage-friendly JSON representation) and ids are UUIDs minted by whichever
 * repository implementation persists a post.
 */
export interface Post {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A post DRAFT: the three fields a create request carries — a Post that does
 * not exist yet (no id, no timestamps; the repository mints those when it
 * persists). The invariants live HERE, in the entity module, beside the shape
 * they protect: the use case orchestrates, the ENTITY decides what a valid
 * post IS. That placement is what stops an invalid draft from existing —
 * every caller (HTTP route, GraphQL resolver, gRPC bridge) funnels through
 * validatePostDraft, so the rules can neither be bypassed nor drift per edge.
 */
export interface PostDraft {
  readonly title: string;
  readonly body: string;
  readonly author: string;
}

/** Field-level invariant limits — the entity's own, not any transport's. */
const TITLE_MAX = 120;
const BODY_MAX = 5000;
const AUTHOR_MAX = 80;
const POST_DRAFT_FIELDS = ['title', 'body', 'author'] as const;

/** Field-level reasons, keyed by the offending property name. */
type FieldErrors = Record<string, string>;

function addFieldRule(
  fields: FieldErrors,
  record: Record<string, unknown>,
  name: (typeof POST_DRAFT_FIELDS)[number],
  max: number,
): void {
  const value = record[name];
  if (typeof value !== 'string') {
    fields[name] = `must be a string of 1 to ${max} characters`;
    return;
  }
  if (value.length < 1 || value.length > max) {
    fields[name] = `must be a string of 1 to ${max} characters (got ${value.length})`;
  }
}

/**
 * The entity's invariant gate: prove an unknown payload is a valid post
 * draft, or produce the canonical validation failure (field-level reasons,
 * never an HTTP status — the presentation edge decides that). Pure: no I/O,
 * no scenario, no repository — just the rules.
 */
export function validatePostDraft(raw: unknown): Result<PostDraft, Failure> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(
      failure('validation', 'post payload must be a JSON object', {
        fields: { body: 'must be a JSON object' },
      }),
    );
  }

  const record = raw as Record<string, unknown>;
  const fields: FieldErrors = {};
  for (const key of Object.keys(record)) {
    if (!(POST_DRAFT_FIELDS as readonly string[]).includes(key)) {
      fields[key] = 'unknown field — only title, body and author are accepted';
    }
  }
  addFieldRule(fields, record, 'title', TITLE_MAX);
  addFieldRule(fields, record, 'body', BODY_MAX);
  addFieldRule(fields, record, 'author', AUTHOR_MAX);

  if (Object.keys(fields).length > 0) {
    return fail(failure('validation', 'post payload is invalid', { fields }));
  }

  return ok({
    title: record.title as string,
    body: record.body as string,
    author: record.author as string,
  });
}
