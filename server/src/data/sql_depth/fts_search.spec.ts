import { describe, expect, it } from 'vitest';
import { searchPostsWithComparison } from './fts_search.js';
import { openSqlDepthDatabase } from './sql_depth_database.js';
import type Database from 'better-sqlite3';

/**
 * The FTS5 exhibit's load-bearing behavior, verified at the data layer:
 * better-sqlite3 ships FTS5 compiled in, the external-content table exists,
 * and the three sync triggers keep the index in step with posts — including
 * the special 'delete' command form on UPDATE and DELETE, which external-content
 * tables REQUIRE (un-indexing needs the old values, not just the rowid).
 */

const INSERT_POST =
  'INSERT INTO posts (id, title, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)';

function insertProbePost(
  db: Database.Database,
  id: string,
  title: string,
  body: string,
): void {
  db.prepare(INSERT_POST).run(
    id,
    title,
    body,
    'probe',
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
  );
}

describe('the migrated handle really has FTS5', () => {
  it('creates posts_fts as an FTS5 virtual table over the seeded posts', () => {
    const db = openSqlDepthDatabase();
    try {
      const row = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE name = 'posts_fts'")
        .get() as { name: string; sql: string };
      expect(row.name).toBe('posts_fts');
      expect(row.sql).toMatch(/USING fts5/i);
      expect(searchPostsWithComparison(db, 'layers').fts.rows.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe('sync triggers keep the external-content index in step', () => {
  it('INSERT: a new post is searchable immediately', () => {
    const db = openSqlDepthDatabase();
    try {
      insertProbePost(db, 'probe-new', 'Fresh probe', 'a zanzibar sunset');
      const { fts, like } = searchPostsWithComparison(db, 'zanzibar');
      expect(fts.rows.map((row) => (row as { id: string }).id)).toEqual(['probe-new']);
      expect(like.rows.map((row) => (row as { id: string }).id)).toEqual(['probe-new']);
    } finally {
      db.close();
    }
  });

  it("UPDATE: the 'delete' command un-indexes old values and indexes the new ones", () => {
    const db = openSqlDepthDatabase();
    try {
      insertProbePost(db, 'probe-edit', 'Old title', 'the old phrasing lives here');
      db.prepare('UPDATE posts SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(
        'New title',
        'entirely new wording',
        '2026-09-02T00:00:00.000Z',
        'probe-edit',
      );
      // old term gone from the index, new term present — and LIKE agrees
      expect(searchPostsWithComparison(db, 'phrasing').fts.rows).toEqual([]);
      expect(searchPostsWithComparison(db, 'phrasing').like.rows).toEqual([]);
      expect(searchPostsWithComparison(db, 'wording').fts.rows.map((row) => (row as { id: string }).id)).toEqual(['probe-edit']);
    } finally {
      db.close();
    }
  });

  it("DELETE: the 'delete' command removes the row from the index", () => {
    const db = openSqlDepthDatabase();
    try {
      insertProbePost(db, 'probe-gone', 'Doomed probe', 'delete me quartz');
      db.prepare('DELETE FROM posts WHERE id = ?').run('probe-gone');
      expect(searchPostsWithComparison(db, 'quartz').fts.rows).toEqual([]);
      expect(searchPostsWithComparison(db, 'quartz').like.rows).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('searchPostsWithComparison — ranking and plans', () => {
  it('bm25 ranks the denser match first and snippet marks the hit inline', () => {
    const db = openSqlDepthDatabase();
    try {
      insertProbePost(db, 'probe-dense', 'telemetry study', 'telemetry telemetry telemetry');
      insertProbePost(db, 'probe-sparse', 'telemetry notes', 'some telemetry among unrelated words');
      const { fts } = searchPostsWithComparison(db, 'telemetry');
      const rows = fts.rows as { id: string; excerpt: string; rank: number }[];
      const ids = rows.map((row) => row.id);
      expect(ids).toContain('probe-dense');
      expect(ids).toContain('probe-sparse');
      expect(ids.indexOf('probe-dense')).toBeLessThan(ids.indexOf('probe-sparse'));
      const dense = rows.find((row) => row.id === 'probe-dense')!;
      expect(dense.excerpt).toContain('[telemetry]');
      expect(dense.rank).toBeLessThan(0); // bm25: negative, more negative = better
    } finally {
      db.close();
    }
  });

  it('reports both plans: the inverted index vs a full table scan', () => {
    const db = openSqlDepthDatabase();
    try {
      const { fts, like } = searchPostsWithComparison(db, 'layers');
      expect(fts.planSteps.join('\n')).toMatch(/posts_fts VIRTUAL TABLE INDEX/);
      expect(fts.usedIndex).toBe(true);
      expect(like.planSteps.join('\n')).toMatch(/SCAN posts/);
      expect(like.usedIndex).toBe(false);
    } finally {
      db.close();
    }
  });
});
