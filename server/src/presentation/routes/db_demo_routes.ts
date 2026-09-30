import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import { ValidationException } from '../../core/error_handling/exceptions.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import {
  applyPendingMigrations,
  getMigrationState,
  openMigratedDatabase,
} from '../../data/migrations/migration_runner.js';

/**
 * The SQL topics' live demo endpoints (sql-schema + sql-node). Every endpoint
 * runs against a DEDICATED in-memory sqlite handle built in-file — the real
 * guide.db (data/posts/sqlite_client) is never opened here, so nothing a
 * visitor does can touch the guide's actual data.
 *
 * - GET  /api/demo/db/schema            → the schema explorer's tables/columns/indexes/FKs
 * - GET  /api/demo/db/plan?preset|sql   → EXPLAIN QUERY PLAN on whitelisted presets or a validated SELECT
 * - GET  /api/demo/db/migrations        → migration state on a fresh handle (pending first)
 * - POST /api/demo/db/migrations/apply  → run the REAL migration runner, before/after + idempotency proof
 * - GET  /api/demo/db/injection?attempt → a parameterized lookup that refuses to inject
 * - POST /api/demo/db/transfer?crash=1  → two writes in one transaction; crash=1 rolls both back
 *
 * Dependency-rule note (deliberate teaching exception, same spirit as the
 * routing topic serving its own catalog): these routes import the migration
 * runner and the shared seed posts because the DATA LAYER ITSELF is the
 * artifact being taught. The posts pipeline (routes → controller → use case →
 * repository → DAO) stays untouched by this file.
 *
 * Error policy (deliberate): a transaction demo that crashes ON PURPOSE is a
 * successful observation of a rollback, so /transfer?crash=1 answers HTTP 200
 * with { transferred: false, rolledBack: true } — exactly like the gRPC
 * bridge renders a failed CALL as a successful invoke. Only malformed input
 * (non-SELECT plan SQL, injection payloads that are not a single string, a
 * bad crash flag) is a 400 error envelope.
 */

export const DB_DEMO_MOUNT_PATH = '/api/demo/db';

// --- the in-memory demo database (schema explorer + plan + injection) --------

/**
 * The demo posts table — deliberately the SAME DDL as the real posts table in
 * data/posts/sqlite_client.ts, so the explorer shows the schema this guide
 * actually runs, plus the richer relations around it below.
 */
const CREATE_DEMO_POSTS_TABLE = `
  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/** The richer demo schema: a child table with FK → posts, a CHECK, a DEFAULT. */
const CREATE_DEMO_COMMENTS_TABLE = `
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(body) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

const CREATE_COMMENTS_INDEX = 'CREATE INDEX idx_comments_post_id ON comments(post_id)';

const SEED_COMMENTS: readonly { postIndex: number; author: string; body: string }[] = [
  { postIndex: 0, author: 'a reader', body: 'The layering sketch finally made the dependency rule click for me.' },
  { postIndex: 1, author: 'another reader', body: 'Good schema design is just the dependency rule for data.' },
  { postIndex: 2, author: 'a third reader', body: 'Result values over throws — same argument as constraints over hope.' },
];

/**
 * A fresh in-memory handle with the demo schema, FK enforcement ON (the
 * per-connection PRAGMA this topic teaches), and the shared seed data — so
 * plan and injection demos run against rows that really exist.
 */
function openSchemaDemoDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_DEMO_POSTS_TABLE);
  db.exec(CREATE_DEMO_COMMENTS_TABLE);
  db.exec(CREATE_COMMENTS_INDEX);
  db.transaction((): void => {
    const insertPost = db.prepare(
      `INSERT INTO posts (id, title, body, author, created_at, updated_at)
       VALUES (@id, @title, @body, @author, @created_at, @updated_at)`,
    );
    for (const post of SEED_POSTS) {
      insertPost.run({
        id: post.id,
        title: post.title,
        body: post.body,
        author: post.author,
        created_at: post.createdAt,
        updated_at: post.updatedAt,
      });
    }
    const insertComment = db.prepare(
      'INSERT INTO comments (post_id, author, body) VALUES (?, ?, ?)',
    );
    for (const comment of SEED_COMMENTS) {
      insertComment.run(SEED_POSTS[comment.postIndex]!.id, comment.author, comment.body);
    }
  })();
  return db;
}

// --- schema explorer ----------------------------------------------------------

export interface DemoColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface DemoIndexInfo {
  name: string;
  unique: boolean;
  origin: 'c' | 'u' | 'pk' | string;
  columns: readonly string[];
}

export interface DemoForeignKeyInfo {
  referencesTable: string;
  column: string;
  referencesColumn: string;
  onDelete: string;
  onUpdate: string;
}

export interface DemoTableInfo {
  name: string;
  ddl: string;
  rowCount: number;
  columns: readonly DemoColumnInfo[];
  indexes: readonly DemoIndexInfo[];
  foreignKeys: readonly DemoForeignKeyInfo[];
}

interface TableRowInfo {
  name: string;
  sql: string | null;
}

function describeTable(db: Database.Database, name: string): DemoTableInfo {
  const columns = (db.pragma(`table_info("${name}")`) as unknown[]).map(
    (raw): DemoColumnInfo => {
      const row = raw as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
      return {
        name: row.name,
        type: row.type,
        notNull: row.notnull === 1,
        defaultValue: row.dflt_value,
        primaryKey: row.pk > 0,
      };
    },
  );

  const indexes = (db.pragma(`index_list("${name}")`) as unknown[]).map(
    (raw): DemoIndexInfo => {
      const row = raw as { name: string; unique: number; origin: string };
      const columns = (db.pragma(`index_info("${row.name}")`) as unknown[]).map(
        (colRaw) => (colRaw as { name: string | null }).name ?? '(expression)',
      );
      return { name: row.name, unique: row.unique === 1, origin: row.origin, columns };
    },
  );

  const foreignKeys = (db.pragma(`foreign_key_list("${name}")`) as unknown[]).map(
    (raw): DemoForeignKeyInfo => {
      const row = raw as { table: string; from: string; to: string | null; on_delete: string; on_update: string };
      return {
        referencesTable: row.table,
        column: row.from,
        referencesColumn: row.to ?? '(primary key)',
        onDelete: row.on_delete,
        onUpdate: row.on_update,
      };
    },
  );

  const rowCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
  ).n;

  const ddl = (
    db
      .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', name) as { sql: string | null }
  ).sql;

  return { name, ddl: ddl ?? '', rowCount, columns, indexes, foreignKeys };
}

function schemaController(_req: Request, res: Response): void {
  const db = openSchemaDemoDatabase();
  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
        .all() as { name: string }[]
    ).map((row) => describeTable(db, row.name));

    const foreignKeysEnforced = (db.pragma('foreign_keys', { simple: true }) as number) === 1;

    res.json({
      handle: ':memory:',
      foreignKeysEnforced,
      note: 'This handle turns the FK PRAGMA on per connection — SQLite ships it OFF, '
        + 'so referential integrity is opt-in on EVERY connection that wants it.',
      tables,
    });
  } finally {
    db.close();
  }
}

// --- query plan (EXPLAIN QUERY PLAN on whitelisted presets / validated SELECTs)

/** The two presets the client renders as buttons — one indexed, one not. */
export const PLAN_PRESETS = Object.freeze({
  indexed: Object.freeze({
    label: 'indexed lookup',
    sql: `SELECT id, body FROM comments WHERE post_id = '${SEED_POSTS[0]!.id}'`,
    note: 'post_id carries idx_comments_post_id — the plan SEARCHes the index instead of reading the table.',
  }),
  scan: Object.freeze({
    label: 'full scan',
    sql: `SELECT id, body FROM comments WHERE body LIKE '%dependency%'`,
    note: 'body has NO index — SQLite must SCAN every row of comments to answer.',
  }),
});

export type PlanPreset = keyof typeof PLAN_PRESETS;

const PLAN_SQL_MAX_LENGTH = 400;

/**
 * Plan SQL whitelist — airtight by construction: exactly one statement that
 * must START with SELECT, contain no semicolons (so no second statement can
 * ride along, trailing or smuggled), and fit the length cap. prepare() itself
 * is the second guard: it refuses multi-statement strings outright.
 */
function readPlanQuery(query: Request['query']): { source: 'preset' | 'custom'; preset?: PlanPreset; sql: string; note?: string } {
  const { preset, sql } = query;

  if (preset !== undefined) {
    if (sql !== undefined) {
      throw new ValidationException('choose either ?preset= or ?sql=, not both', { parameter: 'preset' });
    }
    if (typeof preset !== 'string' || !(preset in PLAN_PRESETS)) {
      throw new ValidationException(
        `"preset" must be one of ${Object.keys(PLAN_PRESETS).map((key) => `"${key}"`).join(', ')}`,
        { parameter: 'preset', received: preset },
      );
    }
    const chosen = PLAN_PRESETS[preset as PlanPreset];
    return { source: 'preset', preset: preset as PlanPreset, sql: chosen.sql, note: chosen.note };
  }

  if (sql === undefined) {
    throw new ValidationException('a query plan needs ?preset=indexed|scan or ?sql=<a single SELECT statement>', {
      parameter: 'sql',
    });
  }
  if (typeof sql !== 'string') {
    throw new ValidationException('"sql" must be a single query string', { parameter: 'sql', received: sql });
  }
  const trimmed = sql.trim();
  if (trimmed.length === 0 || trimmed.length > PLAN_SQL_MAX_LENGTH) {
    throw new ValidationException(
      `"sql" must be between 1 and ${PLAN_SQL_MAX_LENGTH} characters`,
      { parameter: 'sql' },
    );
  }
  if (!/^select\b/i.test(trimmed)) {
    throw new ValidationException(
      'the plan endpoint only explains SELECT statements — reads only, against the demo handle',
      { parameter: 'sql', received: trimmed.slice(0, 80) },
    );
  }
  if (trimmed.includes(';')) {
    throw new ValidationException(
      '"sql" must be exactly one statement — semicolons are rejected so nothing can ride along',
      { parameter: 'sql' },
    );
  }
  return { source: 'custom', sql: trimmed };
}

function planController(req: Request, res: Response): void {
  const requested = readPlanQuery(req.query);
  const db = openSchemaDemoDatabase();
  try {
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${requested.sql}`);
    // EXPLAIN QUERY PLAN never evaluates the query, but better-sqlite3 still
    // requires every bind parameter to be satisfied — nulls are perfect: the
    // optimizer's plan does not depend on values, only on schema and indexes.
    const positionalCount = (requested.sql.match(/\?/g) ?? []).length;
    let planRows: { detail: string }[];
    try {
      planRows =
        positionalCount > 0
          ? (stmt.all(...Array.from({ length: positionalCount }, () => null)) as { detail: string }[])
          : (stmt.all() as { detail: string }[]);
    } catch (cause) {
      if (cause instanceof Database.SqliteError && /parameter/i.test(cause.message)) {
        throw new ValidationException(
          'plan queries take no bind parameters here — write literal values (a plan never depends on them)',
          { parameter: 'sql' },
        );
      }
      throw cause;
    }
    const steps = planRows.map((row) => row.detail);
    const usedIndex = steps.some((step) => /USING (COVERING )?INDEX/i.test(step));
    const verb = steps.some((step) => /\bSEARCH\b/.test(step))
      ? 'SEARCH'
      : steps.some((step) => /\bSCAN\b/.test(step))
        ? 'SCAN'
        : 'OTHER';

    res.json({
      source: requested.source,
      ...(requested.preset !== undefined && { preset: requested.preset }),
      sql: requested.sql,
      steps,
      usedIndex,
      verb,
      ...(requested.note !== undefined && { note: requested.note }),
    });
  } finally {
    db.close();
  }
}

// --- migrations (the REAL runner from src/data/migrations) --------------------

function migrationsController(_req: Request, res: Response): void {
  const db = new Database(':memory:');
  try {
    const state = getMigrationState(db);
    res.json({
      handle: ':memory:',
      ...state,
      note: 'A fresh demo handle before the runner runs: every ordered .sql file on disk '
        + 'is pending. POST /apply replays this state machine.',
    });
  } finally {
    db.close();
  }
}

function migrationsApplyController(_req: Request, res: Response): void {
  const db = new Database(':memory:');
  try {
    const before = getMigrationState(db);
    const appliedThisRun = applyPendingMigrations(db);
    const after = getMigrationState(db);
    // The idempotency proof: running the runner AGAIN on the same database
    // must apply nothing — boot code can call it unconditionally.
    const secondRunApplied = applyPendingMigrations(db);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);

    res.json({
      handle: ':memory:',
      ...after, // top-level applied/pending/files = the state AFTER this run
      before,
      appliedThisRun,
      secondRunApplied,
      tables,
      indexes,
      note: 'Each file applied inside one transaction — its DDL and its schema_migrations '
        + 'record commit together. The second run applied nothing: applied files never replay.',
    });
  } finally {
    db.close();
  }
}

// --- injection (parameterized lookup vs the naive string, shown inert) --------

const INJECTION_LOOKUP = 'SELECT id, title, author FROM posts WHERE title = ?';
const DEFAULT_INJECTION_ATTEMPT = `' OR '1'='1`;
const INJECTION_ATTEMPT_MAX_LENGTH = 200;

function injectionController(req: Request, res: Response): void {
  const raw = req.query.attempt;
  let attempt = DEFAULT_INJECTION_ATTEMPT;
  if (raw !== undefined && raw !== '') {
    if (typeof raw !== 'string') {
      throw new ValidationException('"attempt" must be a single query string', {
        parameter: 'attempt',
        received: raw,
      });
    }
    if (raw.length > INJECTION_ATTEMPT_MAX_LENGTH) {
      throw new ValidationException(
        `"attempt" must be at most ${INJECTION_ATTEMPT_MAX_LENGTH} characters`,
        { parameter: 'attempt' },
      );
    }
    attempt = raw;
  }

  const db = openSchemaDemoDatabase();
  try {
    // THE WHOLE LESSON: the payload is BOUND as data for the ? placeholder —
    // the driver sends it as a value, so it can never become SQL text.
    const matchedRows = db.prepare(INJECTION_LOOKUP).all(attempt) as {
      id: string;
      title: string;
      author: string;
    }[];

    // The naive query is built as an INERT STRING for the response — it is
    // never prepared, never run. Displaying it is the "what not to do" half.
    const naiveQuery = `SELECT id, title, author FROM posts WHERE title = '${attempt}'`;

    res.json({
      attempt,
      safeQuery: INJECTION_LOOKUP,
      boundParameter: attempt,
      parameterStyle: 'positional ? — better-sqlite3 also offers named @title / :title params',
      matchedCount: matchedRows.length,
      matchedRows,
      naiveQuery,
      naiveNote: 'INERT — a string in this response, never executed. Concatenated like this, '
        + "the classic payload closes the quote ('' OR '1'='1') and the WHERE matches EVERY row.",
      verdict:
        matchedRows.length === 0
          ? 'the payload was compared as a literal title — no row has that exact title, so nothing matched'
          : 'the attempt happened to equal a real title — still just a literal equality match',
    });
  } finally {
    db.close();
  }
}

// --- transaction demo (move a tag between posts; crash=1 rolls both back) -----

const DEMO_POST_ALPHA = 'post-alpha';
const DEMO_POST_BETA = 'post-beta';
const DEMO_TAG = 'sqlite';
const DEMO_TAG_ID = 1;

/** Tag counts per demo post — the observable state the atomicity proof reads. */
function tagCounts(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare('SELECT post_id, COUNT(*) AS n FROM posts_tags GROUP BY post_id')
    .all() as { post_id: string; n: number }[];
  return {
    [DEMO_POST_ALPHA]: rows.find((row) => row.post_id === DEMO_POST_ALPHA)?.n ?? 0,
    [DEMO_POST_BETA]: rows.find((row) => row.post_id === DEMO_POST_BETA)?.n ?? 0,
  };
}

function readCrashFlag(query: Request['query']): boolean {
  const raw = query.crash;
  if (raw === undefined || raw === '') return false;
  if (raw !== '1') {
    throw new ValidationException('"crash" may only be absent or ?crash=1', { parameter: 'crash', received: raw });
  }
  return true;
}

function transferController(req: Request, res: Response): void {
  const crash = readCrashFlag(req.query);

  // The REAL runner from src/data/migrations builds the tags schema — the
  // transfer demo runs on the same migration history the migrations demo shows.
  const db = openMigratedDatabase(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.transaction((): void => {
      db.prepare('INSERT INTO demo_posts (id, title) VALUES (?, ?)').run(DEMO_POST_ALPHA, 'Post alpha');
      db.prepare('INSERT INTO demo_posts (id, title) VALUES (?, ?)').run(DEMO_POST_BETA, 'Post beta');
      db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(DEMO_TAG_ID, DEMO_TAG);
      db.prepare('INSERT INTO posts_tags (post_id, tag_id) VALUES (?, ?)').run(DEMO_POST_ALPHA, DEMO_TAG_ID);
    })();

    const before = tagCounts(db);

    // Two writes, ONE transaction: remove the tag from alpha, add it to beta.
    // better-sqlite3's .transaction() rolls back EVERYTHING if anything throws.
    const moveTag = db.transaction((fromPost: string, toPost: string): void => {
      db.prepare('DELETE FROM posts_tags WHERE post_id = ? AND tag_id = ?').run(fromPost, DEMO_TAG_ID);
      if (crash) {
        // Deliberately between the two writes — the exact moment atomicity exists for.
        throw new Error('simulated crash between the DELETE and the INSERT');
      }
      db.prepare('INSERT INTO posts_tags (post_id, tag_id) VALUES (?, ?)').run(toPost, DEMO_TAG_ID);
    });

    let transferred = true;
    if (crash) {
      try {
        moveTag(DEMO_POST_ALPHA, DEMO_POST_BETA);
      } catch {
        // The demo's point: the throw is CAUGHT HERE, the endpoint stays 200,
        // and both writes are already rolled back.
        transferred = false;
      }
    } else {
      moveTag(DEMO_POST_ALPHA, DEMO_POST_BETA);
    }

    const after = tagCounts(db);

    res.json({
      crash,
      transferred,
      rolledBack: crash && !transferred,
      moved: { tag: DEMO_TAG, from: DEMO_POST_ALPHA, to: DEMO_POST_BETA },
      writes: [
        'DELETE FROM posts_tags WHERE post_id = ? AND tag_id = ?',
        'INSERT INTO posts_tags (post_id, tag_id) VALUES (?, ?)',
      ],
      before,
      after,
      explain: transferred
        ? 'both writes committed together — beta now carries the tag and alpha does not'
        : 'the throw inside the transaction rolled back the DELETE too — before and after are identical, which is atomicity',
    });
  } finally {
    db.close();
  }
}

export const dbDemoRouter = Router();
dbDemoRouter.get('/demo/db/schema', schemaController);
dbDemoRouter.get('/demo/db/plan', planController);
dbDemoRouter.get('/demo/db/migrations', migrationsController);
dbDemoRouter.post('/demo/db/migrations/apply', migrationsApplyController);
dbDemoRouter.get('/demo/db/injection', injectionController);
dbDemoRouter.post('/demo/db/transfer', transferController);
