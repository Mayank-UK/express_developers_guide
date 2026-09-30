import type Database from 'better-sqlite3';
import type { PostRow } from '../posts/post_dao.js';

/**
 * The audit-log pattern: the trail row is written INSIDE the same transaction
 * as the change it describes, so a row in audit_log exists if and only if its
 * change committed. old_values/new_values are JSON snapshots of the changed
 * columns ({title, body}) — object literals in a fixed key order, so the
 * serialization is stable and diffs read cleanly. Timestamps are UTC ISO
 * strings, minted once per update and shared by both writes.
 *
 * DAO-convention module (same spirit as post_dao): raw SQL straight on the
 * handle, no Failure mapping — the demo router that exhibits it decides what
 * an empty result means.
 */

const SELECT_POST_SQL =
  'SELECT id, title, body, author, created_at, updated_at FROM posts WHERE id = ?';
const UPDATE_POST_SQL = 'UPDATE posts SET title = ?, body = ?, updated_at = ? WHERE id = ?';
const INSERT_AUDIT_SQL = `
  INSERT INTO audit_log (entity, entity_id, action, changed_by, old_values, new_values, created_at)
  VALUES (?, ?, 'update', ?, ?, ?, ?)
`;
export const SELECT_AUDIT_TRAIL_SQL = `
  SELECT id, entity, entity_id, action, changed_by, old_values, new_values, created_at
  FROM audit_log
  WHERE entity = ? AND entity_id = ?
  ORDER BY id
`;

/** The columns an audit snapshot carries — fixed order, stable JSON. */
interface PostSnapshot {
  readonly title: string;
  readonly body: string;
}

const snapshot = (post: PostRow): PostSnapshot => ({ title: post.title, body: post.body });

/** One post row by id — the demo router's existence check and after-select. */
export function findPost(db: Database.Database, id: string): PostRow | undefined {
  return db.prepare(SELECT_POST_SQL).get(id) as PostRow | undefined;
}

export interface AuditedUpdateInput {
  readonly postId: string;
  /** Omitted fields keep their current value — PATCH semantics. */
  readonly title?: string;
  readonly body?: string;
  readonly changedBy: string;
  /** Throw between the post UPDATE and the audit INSERT, proving both roll back. */
  readonly crashBetweenWrites?: boolean;
}

export interface AuditedUpdateResult {
  readonly before: PostRow;
  readonly after: PostRow;
}

/**
 * Update a post's title/body and write its audit row, atomically. Returns
 * undefined when the post does not exist. A crash flag throws from INSIDE the
 * transaction on purpose — better-sqlite3 rolls back both writes, which is
 * exactly the atomicity the demo observes.
 */
export function updatePostWithAudit(
  db: Database.Database,
  input: AuditedUpdateInput,
): AuditedUpdateResult | undefined {
  const updateWithAudit = db.transaction((): AuditedUpdateResult | undefined => {
    const before = db.prepare(SELECT_POST_SQL).get(input.postId) as PostRow | undefined;
    if (before === undefined) return undefined;

    const now = new Date().toISOString();
    const after: PostRow = {
      ...before,
      title: input.title ?? before.title,
      body: input.body ?? before.body,
      updated_at: now,
    };

    db.prepare(UPDATE_POST_SQL).run(after.title, after.body, after.updated_at, before.id);
    if (input.crashBetweenWrites) {
      throw new Error('simulated crash between the post UPDATE and the audit INSERT');
    }
    db.prepare(INSERT_AUDIT_SQL).run(
      'post',
      before.id,
      input.changedBy,
      JSON.stringify(snapshot(before)),
      JSON.stringify(snapshot(after)),
      now,
    );

    return { before, after };
  });
  return updateWithAudit();
}

export interface AuditEntry {
  readonly id: number;
  readonly entity: string;
  readonly entityId: string;
  readonly action: string;
  readonly changedBy: string;
  readonly oldValues: PostSnapshot;
  readonly newValues: PostSnapshot;
  readonly createdAt: string;
}

interface AuditRow {
  id: number;
  entity: string;
  entity_id: string;
  action: string;
  changed_by: string;
  old_values: string;
  new_values: string;
  created_at: string;
}

/** The trail for one entity, oldest first — the idx_audit_entity read. */
export function auditTrailFor(
  db: Database.Database,
  entity: string,
  entityId: string,
): { sql: string; rows: readonly AuditEntry[] } {
  const rows = db.prepare(SELECT_AUDIT_TRAIL_SQL).all(entity, entityId) as AuditRow[];
  return {
    sql: SELECT_AUDIT_TRAIL_SQL,
    rows: rows.map((row) => ({
      id: row.id,
      entity: row.entity,
      entityId: row.entity_id,
      action: row.action,
      changedBy: row.changed_by,
      oldValues: JSON.parse(row.old_values) as PostSnapshot,
      newValues: JSON.parse(row.new_values) as PostSnapshot,
      createdAt: row.created_at,
    })),
  };
}
