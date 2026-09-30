import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { SQL_DEPTH_DEMO_MOUNT_PATH } from './sql_depth_demo_routes.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import { UUID_RE } from '../../test_support/index.js';

const MOUNT = SQL_DEPTH_DEMO_MOUNT_PATH; // /api/demo/db
const FIRST_POST = SEED_POSTS[0]!;

/** The real guide's database file — these demo endpoints must never touch it. */
const GUIDE_DB_PATH = fileURLToPath(new URL('../../../data/guide.db', import.meta.url));

describe('GET /api/demo/db/sql-lab/org-chart — the recursive CTE', () => {
  it('defaults to the CEO and walks all 12 staff across 3 levels', async () => {
    const res = await request(createApp()).get(`${MOUNT}/sql-lab/org-chart`);

    expect(res.status).toBe(200);
    expect(res.body.root).toBe('staff-001');
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.maxDepth).toBe(2);
    expect(res.body.sql).toContain('WITH RECURSIVE');
    expect(res.body.sql).toContain('?'); // the root id is a bound parameter

    const ceo = res.body.rows.find((row: { id: string }) => row.id === 'staff-001');
    expect(ceo).toMatchObject({ depth: 0, manager_id: null, path: 'Ada Lovelace' });

    const report = res.body.rows.find((row: { id: string }) => row.id === 'staff-005');
    expect(report).toMatchObject({ depth: 2, path: 'Ada Lovelace > Grace Hopper > Linus Torvalds' });
  });

  it('scopes the subtree to ?manager= — Grace plus her three reports', async () => {
    const res = await request(createApp()).get(`${MOUNT}/sql-lab/org-chart?manager=staff-002`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(4);
    expect(res.body.maxDepth).toBe(1);
    expect(res.body.rows.filter((row: { depth: number }) => row.depth === 1)).toHaveLength(3);
  });

  it('404s an unknown manager with the standard envelope', async () => {
    const res = await request(createApp()).get(`${MOUNT}/sql-lab/org-chart?manager=staff-999`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.parameter).toBe('manager');
    expect(res.body.error.requestId).toMatch(UUID_RE);
  });

  it('rejects a repeated manager parameter', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/sql-lab/org-chart?manager=staff-001&manager=staff-002`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('manager');
  });
});

describe('GET /api/demo/db/sql-lab/salary-window — RANK() and SUM() OVER', () => {
  it('returns all 12 staff with in-department ranks and a running hire-order total', async () => {
    const res = await request(createApp()).get(`${MOUNT}/sql-lab/salary-window`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.sql).toContain('RANK() OVER (PARTITION BY department');
    expect(res.body.sql).toContain('SUM(salary_cents) OVER (PARTITION BY department ORDER BY hired_at)');

    const platform = (
      res.body.rows as {
        name: string;
        salary_rank_in_department: number;
        running_salary_total_cents: number;
        department: string;
      }[]
    ).filter((row) => row.department === 'platform');
    expect(platform.map((row) => row.name)).toEqual([
      'Grace Hopper', // hired first — running total starts at her salary
      'Linus Torvalds',
      'Barbara Liskov',
      'Margaret Hamilton',
    ]);
    // ranks are by salary DESC, not hire order — Grace 16.5M, Barbara 13.1M, Linus 12.4M, Margaret 11.9M
    expect(platform.map((row) => row.salary_rank_in_department)).toEqual([1, 3, 2, 4]);
    // the window accumulates in hire order without collapsing any row away
    expect(platform.map((row) => row.running_salary_total_cents)).toEqual([
      16_500_000,
      28_900_000,
      42_000_000,
      53_900_000,
    ]);
  });
});

describe('GET /api/demo/db/sql-lab/department-rollup — join + aggregate', () => {
  it('rolls up one row per department with the manager LEFT JOINed in', async () => {
    const res = await request(createApp()).get(`${MOUNT}/sql-lab/department-rollup`);

    expect(res.status).toBe(200);
    expect(res.body.sql).toContain('LEFT JOIN staff mgr');
    expect(res.body.sql).toContain('GROUP BY department');

    const byDepartment = new Map(
      (res.body.rows as {
        department: string;
        headcount: number;
        total_salary_cents: number;
        avg_salary_cents: number;
        manager_name: string | null;
      }[]).map((row) => [row.department, row]),
    );
    expect(res.body.rows).toHaveLength(4);

    expect(byDepartment.get('data')).toEqual({
      department: 'data',
      headcount: 3,
      total_salary_cents: 39_000_000,
      avg_salary_cents: 13_000_000,
      manager_name: 'Edsger Dijkstra',
    });
    expect(byDepartment.get('platform')).toMatchObject({
      headcount: 4,
      total_salary_cents: 53_900_000,
      avg_salary_cents: 13_475_000, // rounded back to integer cents
      manager_name: 'Grace Hopper',
    });
    // LEFT JOIN proof: the CEO's department survives with no manager.
    expect(byDepartment.get('executive')).toMatchObject({ headcount: 1, manager_name: null });
  });
});

describe('GET /api/demo/db/sql-lab/plan-comparison — EXPLAIN QUERY PLAN', () => {
  it('the bare column SEARCHes the salary index; the expression forces a SCAN', async () => {
    const res = await request(createApp()).get(`${MOUNT}/sql-lab/plan-comparison`);

    expect(res.status).toBe(200);
    const [friendly, defeating] = res.body.variants;
    expect(friendly.label).toBe('index-friendly');
    expect(friendly.steps.join('\n')).toMatch(/SEARCH staff USING INDEX idx_staff_salary_cents/);
    expect(friendly.usedIndex).toBe(true);
    expect(friendly.verb).toBe('SEARCH');
    expect(friendly.sql).toBe('SELECT id, name FROM staff WHERE salary_cents > ?');

    expect(defeating.label).toBe('index-defeating');
    expect(defeating.steps.join('\n')).toMatch(/SCAN staff/);
    expect(defeating.usedIndex).toBe(false);
    expect(defeating.verb).toBe('SCAN');
    expect(defeating.boundValue).toBe(144_000_000); // the same filter, annualized
    expect(res.body.thresholdCents).toBe(12_000_000);
  });
});

describe('GET /api/demo/db/search — FTS5 vs LIKE', () => {
  it('answers with bm25-ranked FTS rows, LIKE rows, and both plans', async () => {
    const res = await request(createApp()).get(`${MOUNT}/search?q=layers`);

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('layers');

    const ftsIds = (res.body.fts.rows as { id: string; rank: number }[]).map((row) => row.id);
    expect(ftsIds).toContain(FIRST_POST.id);
    expect(res.body.fts.rows[0].rank).toBeLessThan(0); // bm25: negative, best first
    expect(res.body.fts.planSteps.join('\n')).toMatch(/posts_fts VIRTUAL TABLE INDEX/);
    expect(res.body.fts.usedIndex).toBe(true);

    const likeIds = (res.body.like.rows as { id: string }[]).map((row) => row.id);
    expect(likeIds).toContain(FIRST_POST.id);
    expect(res.body.like.planSteps.join('\n')).toMatch(/SCAN posts/);
    expect(res.body.like.usedIndex).toBe(false);

    expect(res.body.fts.sql).toContain('MATCH ?');
    expect(res.body.like.sql).toContain("'%' || ? || '%'");
  });

  it('rejects a term that is not valid FTS5 syntax, a blank, or an overload', async () => {
    const attempts = [
      'q=%22', // a lone quote — FTS5 query syntax error
      'q=',
      `q=${encodeURIComponent('   ')}`,
      `q=${encodeURIComponent('x'.repeat(101))}`,
      'q=a&q=b',
    ];
    for (const attempt of attempts) {
      const res = await request(createApp()).get(`${MOUNT}/search?${attempt}`);
      expect(res.status, `?${attempt}`).toBe(400);
      expect(res.body.error.code, `?${attempt}`).toBe('validation_failed');
      expect(res.body.error.requestId, `?${attempt}`).toMatch(UUID_RE);
    }
  });
});

describe('POST /api/demo/db/race — check-then-act vs the atomic guard', () => {
  it('naive mode with stock=1 and concurrency=2 OVERSELLS to -1', async () => {
    const res = await request(createApp()).post(`${MOUNT}/race?mode=naive&concurrency=2&stock=1`);

    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(':memory:');
    expect(res.body.mode).toBe('naive');
    expect(res.body.initialStock).toBe(1);
    expect(res.body.finalStock).toBe(-1);
    expect(res.body.oversold).toBe(true);
    expect(res.body.successCount).toBe(2);
    // THE evidence of check-then-act: both attempts read the SAME stock=1.
    expect(res.body.attempts).toHaveLength(2);
    for (const attempt of res.body.attempts) {
      expect(attempt.succeeded).toBe(true);
      expect(attempt.stockObserved).toBe(1);
    }
    expect(res.body.sql.safeDecrement).toContain('AND stock > 0');
  });

  it('safe mode with the same setup ends at 0 with exactly one success and one 409', async () => {
    const res = await request(createApp()).post(`${MOUNT}/race?mode=safe&concurrency=2&stock=1`);

    expect(res.status).toBe(200);
    expect(res.body.finalStock).toBe(0);
    expect(res.body.oversold).toBe(false);
    expect(res.body.successCount).toBe(1);

    const [winner, loser] = res.body.attempts;
    expect(winner).toMatchObject({ succeeded: true, rowsMatched: 1 });
    expect(loser).toMatchObject({
      succeeded: false,
      failureKind: 'conflict',
      httpStatus: 409,
      rowsMatched: 0,
    });
  });

  it('naive scales the oversell with concurrency — 4 attempts on 1 ticket end at -3', async () => {
    const res = await request(createApp()).post(`${MOUNT}/race?mode=naive&concurrency=4&stock=1`);

    expect(res.status).toBe(200);
    expect(res.body.finalStock).toBe(-3);
    expect(res.body.successCount).toBe(4);
  });

  it('rejects a bad mode, concurrency, or stock', async () => {
    const attempts = [
      'mode=bogus',
      'concurrency=9&mode=naive',
      'concurrency=abc&mode=naive',
      'stock=100&mode=naive',
      'stock=-1&mode=naive',
    ];
    for (const attempt of attempts) {
      const res = await request(createApp()).post(`${MOUNT}/race?${attempt}`);
      expect(res.status, `?${attempt}`).toBe(400);
      expect(res.body.error.code, `?${attempt}`).toBe('validation_failed');
    }

    const missingMode = await request(createApp()).post(`${MOUNT}/race`);
    expect(missingMode.status).toBe(400);
    expect(missingMode.body.error.parameter).toBe('mode');
  });
});

describe('GET /api/demo/db/uuid — v4 vs v7 key strategy', () => {
  it('v7 sorts exactly as generated while v4 scatters', async () => {
    const res = await request(createApp()).get(`${MOUNT}/uuid?count=32`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(32);

    expect(res.body.v4.asGenerated).toHaveLength(32);
    expect(res.body.v7.asGenerated).toHaveLength(32);
    expect(res.body.v4.sorted).not.toEqual(res.body.v4.asGenerated); // 1/32! — scatter, in practice
    expect(res.body.v7.sorted).toEqual(res.body.v7.asGenerated); // always — that is the design
    expect(res.body.v7.sortsAsGenerated).toBe(true);

    for (const id of res.body.v7.asGenerated) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    for (const id of res.body.v4.asGenerated) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('rejects a count outside 1..64', async () => {
    for (const count of ['0', '65', 'abc']) {
      const res = await request(createApp()).get(`${MOUNT}/uuid?count=${count}`);
      expect(res.status, `count=${count}`).toBe(400);
      expect(res.body.error.parameter).toBe('count');
    }
  });
});

describe('PATCH /api/demo/db/audit/post — update + audit row in one transaction', () => {
  it('updates a seeded post and writes its audit row atomically', async () => {
    const res = await request(createApp())
      .patch(`${MOUNT}/audit/post`)
      .send({ title: 'Layers keep concerns apart, revised', changedBy: 'the reviewer' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.rolledBack).toBe(false);
    expect(res.body.before.title).toBe(FIRST_POST.title);
    expect(res.body.after.title).toBe('Layers keep concerns apart, revised');
    expect(res.body.after.body).toBe(FIRST_POST.body); // PATCH semantics: untouched fields stay

    expect(res.body.auditRowCount).toBe(1);
    const entry = res.body.auditRows[0];
    expect(entry).toMatchObject({
      entity: 'post',
      entityId: FIRST_POST.id,
      action: 'update',
      changedBy: 'the reviewer',
    });
    expect(entry.oldValues).toEqual({ title: FIRST_POST.title, body: FIRST_POST.body });
    expect(entry.newValues.title).toBe('Layers keep concerns apart, revised');
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('crash=1 rolls back BOTH the post update and the audit row, staying 200', async () => {
    const res = await request(createApp())
      .patch(`${MOUNT}/audit/post`)
      .query('crash=1')
      .send({ body: 'this body must never persist' });

    expect(res.status).toBe(200); // observing the rollback IS the successful outcome
    expect(res.body.crash).toBe(true);
    expect(res.body.updated).toBe(false);
    expect(res.body.rolledBack).toBe(true);
    // Atomicity: the post is unchanged and no audit row survived.
    expect(res.body.before).toEqual(res.body.after);
    expect(res.body.after.body).toBe(FIRST_POST.body);
    expect(res.body.auditRowCount).toBe(0);
    expect(res.body.auditRows).toEqual([]);
  });

  it('rejects malformed input: no fields, blank title, bad crash, unknown post', async () => {
    const noFields = await request(createApp()).patch(`${MOUNT}/audit/post`).send({});
    expect(noFields.status).toBe(400);
    expect(noFields.body.error.code).toBe('validation_failed');

    const blankTitle = await request(createApp()).patch(`${MOUNT}/audit/post`).send({ title: '   ' });
    expect(blankTitle.status).toBe(400);

    const badCrash = await request(createApp())
      .patch(`${MOUNT}/audit/post?crash=yes`)
      .send({ title: 'x' });
    expect(badCrash.status).toBe(400);
    expect(badCrash.body.error.parameter).toBe('crash');

    const unknownPost = await request(createApp())
      .patch(`${MOUNT}/audit/post`)
      .query('postId=nope')
      .send({ title: 'x' });
    expect(unknownPost.status).toBe(404);
    expect(unknownPost.body.error.code).toBe('not_found');
  });
});

describe('GET /api/demo/db/audit/post — the trail read', () => {
  it('returns the scripted two-step history, oldest first', async () => {
    const res = await request(createApp()).get(`${MOUNT}/audit/post`);

    expect(res.status).toBe(200);
    expect(res.body.postId).toBe(FIRST_POST.id);
    expect(res.body.sql).toContain('WHERE entity = ? AND entity_id = ?');

    expect(res.body.rows).toHaveLength(2);
    const [edit, clarify] = res.body.rows;
    expect(edit).toMatchObject({ action: 'update', changedBy: 'the editor' });
    expect(edit.oldValues.title).toBe(FIRST_POST.title);
    expect(edit.newValues.title).toBe(`${FIRST_POST.title} (2nd edition)`);

    expect(clarify).toMatchObject({ action: 'update', changedBy: 'the author' });
    expect(clarify.oldValues.body).toBe(FIRST_POST.body);
    expect(clarify.newValues.body).toBe(`${FIRST_POST.body} Updated for clarity.`);
    expect(clarify.id).toBeGreaterThan(edit.id); // ORDER BY id — oldest first
  });

  it('404s an unknown post id', async () => {
    const res = await request(createApp()).get(`${MOUNT}/audit/post?postId=nope`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('the sql-depth demo endpoints never touch the real guide.db', () => {
  it('uses :memory: handles only — the guide database file is unchanged', async () => {
    const before = existsSync(GUIDE_DB_PATH) ? statSync(GUIDE_DB_PATH).mtimeMs : null;

    const app = createApp();
    await request(app).get(`${MOUNT}/sql-lab/org-chart`);
    await request(app).get(`${MOUNT}/sql-lab/salary-window`);
    await request(app).get(`${MOUNT}/sql-lab/department-rollup`);
    await request(app).get(`${MOUNT}/sql-lab/plan-comparison`);
    await request(app).get(`${MOUNT}/search?q=layers`);
    await request(app).post(`${MOUNT}/race?mode=naive`);
    await request(app).post(`${MOUNT}/race?mode=safe`);
    await request(app).get(`${MOUNT}/uuid`);
    await request(app).patch(`${MOUNT}/audit/post`).send({ title: 'x' });
    await request(app).get(`${MOUNT}/audit/post`);

    const after = existsSync(GUIDE_DB_PATH) ? statSync(GUIDE_DB_PATH).mtimeMs : null;
    expect(after).toBe(before); // not created, not modified
  });
});
