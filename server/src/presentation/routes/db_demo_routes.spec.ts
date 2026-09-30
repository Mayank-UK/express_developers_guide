import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { DB_DEMO_MOUNT_PATH } from './db_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

const MOUNT = DB_DEMO_MOUNT_PATH; // /api/demo/db

/** The real guide's database file — the demo endpoints must never touch it. */
const GUIDE_DB_PATH = fileURLToPath(new URL('../../../data/guide.db', import.meta.url));

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

interface TableInfo {
  name: string;
  ddl: string;
  rowCount: number;
  columns: ColumnInfo[];
  indexes: { name: string; unique: boolean; origin: string; columns: string[] }[];
  foreignKeys: {
    referencesTable: string;
    column: string;
    referencesColumn: string;
    onDelete: string;
    onUpdate: string;
  }[];
}

async function getSchemaTables(): Promise<TableInfo[]> {
  const res = await request(createApp()).get(`${MOUNT}/schema`);
  expect(res.status).toBe(200);
  return res.body.tables as TableInfo[];
}

describe('GET /api/demo/db/schema — the schema explorer', () => {
  it('lists the posts table AND the richer comments demo table with live row counts', async () => {
    const tables = await getSchemaTables();
    const names = tables.map((table) => table.name);

    expect(names).toContain('posts');
    expect(names).toContain('comments');

    const posts = tables.find((table) => table.name === 'posts');
    const comments = tables.find((table) => table.name === 'comments');
    expect(posts?.rowCount).toBe(3); // the real seed posts
    expect(comments?.rowCount).toBe(3);
    expect(posts?.ddl).toContain('CREATE TABLE posts');
  });

  it('describes columns with their constraints (NOT NULL, PK, DEFAULT)', async () => {
    const tables = await getSchemaTables();
    const comments = tables.find((table) => table.name === 'comments');

    const post_id = comments?.columns.find((column) => column.name === 'post_id');
    expect(post_id).toMatchObject({ type: 'TEXT', notNull: true, primaryKey: false });

    const id = comments?.columns.find((column) => column.name === 'id');
    expect(id?.primaryKey).toBe(true);

    const created_at = comments?.columns.find((column) => column.name === 'created_at');
    expect(created_at?.defaultValue).toContain('strftime');
  });

  it('shows the comments → posts foreign key with its ON DELETE behavior', async () => {
    const tables = await getSchemaTables();
    const comments = tables.find((table) => table.name === 'comments');

    expect(comments?.foreignKeys).toEqual([
      expect.objectContaining({
        referencesTable: 'posts',
        column: 'post_id',
        referencesColumn: 'id',
        onDelete: 'CASCADE',
      }),
    ]);
  });

  it('shows indexes — the explicit post_id index and the posts PK autoindex', async () => {
    const tables = await getSchemaTables();

    const comments = tables.find((table) => table.name === 'comments');
    const explicit = comments?.indexes.find((index) => index.name === 'idx_comments_post_id');
    expect(explicit).toMatchObject({ unique: false, origin: 'c', columns: ['post_id'] });

    // posts.id is a TEXT primary key — SQLite maintains an automatic index for it.
    const posts = tables.find((table) => table.name === 'posts');
    expect(
      posts?.indexes.some((index) => index.origin === 'pk' && index.unique),
    ).toBe(true);
  });

  it('runs on an in-memory handle with FK enforcement turned ON per connection', async () => {
    const res = await request(createApp()).get(`${MOUNT}/schema`);

    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(':memory:');
    expect(res.body.foreignKeysEnforced).toBe(true);
    expect(res.body.note).toContain('OFF');
  });
});

describe('GET /api/demo/db/plan — EXPLAIN QUERY PLAN', () => {
  it('preset=indexed SEARCHes the post_id index', async () => {
    const res = await request(createApp()).get(`${MOUNT}/plan?preset=indexed`);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('preset');
    expect(res.body.sql).toContain('WHERE post_id =');
    expect(res.body.steps.join('\n')).toMatch(/SEARCH\s+comments USING INDEX idx_comments_post_id/);
    expect(res.body.usedIndex).toBe(true);
    expect(res.body.verb).toBe('SEARCH');
  });

  it('preset=scan SCANs the whole table when no index covers the column', async () => {
    const res = await request(createApp()).get(`${MOUNT}/plan?preset=scan`);

    expect(res.status).toBe(200);
    expect(res.body.steps.join('\n')).toMatch(/SCAN\s+comments/);
    expect(res.body.usedIndex).toBe(false);
    expect(res.body.verb).toBe('SCAN');
  });

  it('accepts a custom single SELECT statement', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/plan?sql=${encodeURIComponent('SELECT id FROM posts WHERE author = ?')}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('custom');
    expect(res.body.sql).toBe('SELECT id FROM posts WHERE author = ?');
    expect(Array.isArray(res.body.steps)).toBe(true);
  });

  it('rejects anything that is not exactly one SELECT statement', async () => {
    const attempts = [
      'sql=DELETE FROM posts WHERE id = 1',
      'sql=DROP TABLE posts',
      'sql=PRAGMA table_info(posts)',
      `sql=${encodeURIComponent('SELECT 1; DROP TABLE posts')}`,
      `sql=${encodeURIComponent('SELECT 1; PRAGMA foreign_keys = OFF')}`,
      `sql=${encodeURIComponent('SELECT 1; ATTACH DATABASE \'x.db\' AS x')}`,
      `sql=${encodeURIComponent('WITH x AS (SELECT 1) SELECT * FROM x')}`,
      'sql=',
      'preset=indexed&sql=SELECT 1',
      'preset=nope',
    ];

    for (const attempt of attempts) {
      const res = await request(createApp()).get(`${MOUNT}/plan?${attempt}`);
      expect(res.status, `?${attempt}`).toBe(400);
      expect(res.body.error.code, `?${attempt}`).toBe('validation_failed');
      expect(res.body.error.requestId, `?${attempt}`).toMatch(UUID_RE);
    }
  });

  it('demands a query at all', async () => {
    const res = await request(createApp()).get(`${MOUNT}/plan`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('sql');
  });
});

describe('the real migration runner, over HTTP', () => {
  it('GET /migrations shows a fresh handle with every file pending', async () => {
    const res = await request(createApp()).get(`${MOUNT}/migrations`);

    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(':memory:');
    expect(res.body.files).toEqual(['0001_create_tags_tables.sql', '0002_add_indexes.sql', '0003_create_staff.sql', '0004_add_staff_salary_index.sql', '0005_create_posts_fts.sql', '0006_create_inventory.sql', '0007_create_audit_log.sql', '0008_create_outbox.sql']);
    expect(res.body.applied).toEqual([]);
    expect(res.body.pending).toEqual(['0001_create_tags_tables.sql', '0002_add_indexes.sql', '0003_create_staff.sql', '0004_add_staff_salary_index.sql', '0005_create_posts_fts.sql', '0006_create_inventory.sql', '0007_create_audit_log.sql', '0008_create_outbox.sql']);
  });

  it('POST /migrations/apply applies in order, records them, and proves idempotency', async () => {
    const res = await request(createApp()).post(`${MOUNT}/migrations/apply`);

    expect(res.status).toBe(200);

    // Before: nothing applied, both pending.
    expect(res.body.before.applied).toEqual([]);
    expect(res.body.before.pending).toEqual(['0001_create_tags_tables.sql', '0002_add_indexes.sql', '0003_create_staff.sql', '0004_add_staff_salary_index.sql', '0005_create_posts_fts.sql', '0006_create_inventory.sql', '0007_create_audit_log.sql', '0008_create_outbox.sql']);

    // The run itself: ordered.
    expect(res.body.appliedThisRun).toEqual(['0001_create_tags_tables.sql', '0002_add_indexes.sql', '0003_create_staff.sql', '0004_add_staff_salary_index.sql', '0005_create_posts_fts.sql', '0006_create_inventory.sql', '0007_create_audit_log.sql', '0008_create_outbox.sql']);

    // After: everything applied, nothing pending (the post-apply state rides
    // at the TOP level — applied/pending/files — alongside the nested before).
    expect(res.body.applied).toEqual(['0001_create_tags_tables.sql', '0002_add_indexes.sql', '0003_create_staff.sql', '0004_add_staff_salary_index.sql', '0005_create_posts_fts.sql', '0006_create_inventory.sql', '0007_create_audit_log.sql', '0008_create_outbox.sql']);
    expect(res.body.pending).toEqual([]);

    // Idempotency: a second run on the same database applies nothing.
    expect(res.body.secondRunApplied).toEqual([]);

    // The DDL really ran: tables and both step-0002 indexes exist.
    expect(res.body.tables).toEqual(
      expect.arrayContaining(['demo_posts', 'posts_tags', 'tags', 'schema_migrations']),
    );
    expect(res.body.indexes).toEqual(
      expect.arrayContaining(['idx_posts_tags_tag_id', 'idx_tags_name']),
    );
  });
});

describe('GET /api/demo/db/injection — parameterized or else', () => {
  it("the classic ' OR '1'='1 payload matches NOTHING when bound as a parameter", async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/injection?attempt=${encodeURIComponent("' OR '1'='1")}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.attempt).toBe(`' OR '1'='1`);
    expect(res.body.boundParameter).toBe(`' OR '1'='1`);
    expect(res.body.safeQuery).toBe('SELECT id, title, author FROM posts WHERE title = ?');
    expect(res.body.matchedCount).toBe(0);
    expect(res.body.matchedRows).toEqual([]);
  });

  it('defaults to the classic payload when no attempt is supplied', async () => {
    const res = await request(createApp()).get(`${MOUNT}/injection`);

    expect(res.status).toBe(200);
    expect(res.body.attempt).toBe(`' OR '1'='1`);
    expect(res.body.matchedCount).toBe(0);
  });

  it('shows the naive concatenated query as an INERT string, never executes it', async () => {
    const payload = `' OR '1'='1`;
    const res = await request(createApp()).get(
      `${MOUNT}/injection?attempt=${encodeURIComponent(payload)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.naiveQuery).toBe(
      `SELECT id, title, author FROM posts WHERE title = '' OR '1'='1'`,
    );
    expect(res.body.naiveNote).toContain('INERT');
    // The proof of inertness: had that string run, every row would match.
    expect(res.body.matchedCount).toBe(0);
  });

  it('is still a real lookup: an attempt equal to an actual title finds that row', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/injection?attempt=${encodeURIComponent('Failures are values here')}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.matchedCount).toBe(1);
    expect(res.body.matchedRows[0]).toMatchObject({ title: 'Failures are values here' });
  });

  it('rejects a repeated attempt parameter with a 400 envelope', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/injection?attempt=a&attempt=b`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('attempt');
  });
});

describe('POST /api/demo/db/transfer — transactions', () => {
  it('happy path: both writes commit, the tag moves from alpha to beta', async () => {
    const res = await request(createApp()).post(`${MOUNT}/transfer`);

    expect(res.status).toBe(200);
    expect(res.body.crash).toBe(false);
    expect(res.body.transferred).toBe(true);
    expect(res.body.rolledBack).toBe(false);
    expect(res.body.before).toEqual({ 'post-alpha': 1, 'post-beta': 0 });
    expect(res.body.after).toEqual({ 'post-alpha': 0, 'post-beta': 1 });
  });

  it('crash=1: the throw is caught, BOTH writes roll back, the endpoint stays 200', async () => {
    const res = await request(createApp()).post(`${MOUNT}/transfer?crash=1`);

    expect(res.status).toBe(200); // observing a rollback IS the successful outcome
    expect(res.body.crash).toBe(true);
    expect(res.body.transferred).toBe(false);
    expect(res.body.rolledBack).toBe(true);
    // Atomicity: after == before — neither the DELETE nor the INSERT is visible.
    expect(res.body.before).toEqual({ 'post-alpha': 1, 'post-beta': 0 });
    expect(res.body.after).toEqual({ 'post-alpha': 1, 'post-beta': 0 });
  });

  it('rejects a crash flag that is not absent-or-1', async () => {
    const res = await request(createApp()).post(`${MOUNT}/transfer?crash=yes`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('crash');
  });
});

describe('the demo endpoints never touch the real guide.db', () => {
  it('uses :memory: handles only — the guide database file is unchanged', async () => {
    const before = existsSync(GUIDE_DB_PATH)
      ? statSync(GUIDE_DB_PATH).mtimeMs
      : null;

    const app = createApp();
    await request(app).get(`${MOUNT}/schema`);
    await request(app).get(`${MOUNT}/plan?preset=indexed`);
    await request(app).get(`${MOUNT}/migrations`);
    await request(app).post(`${MOUNT}/migrations/apply`);
    await request(app).get(`${MOUNT}/injection`);
    await request(app).post(`${MOUNT}/transfer?crash=1`);

    const after = existsSync(GUIDE_DB_PATH)
      ? statSync(GUIDE_DB_PATH).mtimeMs
      : null;

    expect(after).toBe(before); // not created, not modified
  });
});
