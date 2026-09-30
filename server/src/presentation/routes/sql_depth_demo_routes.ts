import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import { NotFoundException, ValidationException } from '../../core/error_handling/exceptions.js';
import { SEED_POSTS } from '../../data/posts/seed_posts.js';
import { DEMO_INVENTORY_ITEM, openSqlDepthDatabase } from '../../data/sql_depth/sql_depth_database.js';
import {
  STAFF_CEO_ID,
  departmentSalaryRollup,
  orgChartUnder,
  salaryIndexComparison,
  salaryWindowByDepartment,
} from '../../data/sql_depth/staff_queries.js';
import { searchPostsWithComparison } from '../../data/sql_depth/fts_search.js';
import {
  NAIVE_DECREMENT_SQL,
  SAFE_DECREMENT_SQL,
  SELECT_STOCK_SQL,
  bookNaive,
  bookSafe,
} from '../../data/sql_depth/inventory_booking.js';
import { auditTrailFor, findPost, updatePostWithAudit } from '../../data/sql_depth/audit_writer.js';
import { uuidV7 } from '../../data/sql_depth/uuid_v7.js';

/**
 * The advanced-SQL topics' live demo endpoints — the deep end of the db
 * surface (db_demo_routes covers schema/migrations/injection/transactions).
 * Every endpoint runs against a DEDICATED in-memory handle built in-file from
 * the REAL migration runner (migrations 0003-0007 create the staff dataset,
 * the salary index, posts + posts_fts + sync triggers, inventory, audit_log);
 * the real guide.db is never opened here.
 *
 * - GET   /api/demo/db/sql-lab/org-chart?manager=     → recursive CTE: a manager's subtree with depth + path
 * - GET   /api/demo/db/sql-lab/salary-window          → RANK() + SUM() OVER (...): aggregation without collapsing rows
 * - GET   /api/demo/db/sql-lab/department-rollup      → join + aggregate: headcount/salary totals beside the manager's name
 * - GET   /api/demo/db/sql-lab/plan-comparison        → EXPLAIN QUERY PLAN: one predicate using the index vs defeating it
 * - GET   /api/demo/db/search?q=                      → FTS5 MATCH (bm25-ranked, snippet) vs LIKE '%…%', both plans
 * - POST  /api/demo/db/race?mode=&concurrency=&stock= → the check-then-act booking race: naive oversells, the atomic guard 409s
 * - GET   /api/demo/db/uuid?count=                    → v4 vs v7 key batches in generation order and sorted order
 * - PATCH /api/demo/db/audit/post                     → post update + audit row in ONE transaction (crash=1 rolls back both)
 * - GET   /api/demo/db/audit/post?postId=             → the audit trail for a post, after two scripted audited updates
 *
 * Dependency-rule note (deliberate teaching exception, the documented one the
 * other data-exhibit routers use): these routes import the data layer because
 * the SQL ITSELF is the artifact being taught — the queries, the guarded
 * UPDATE, the transactional audit write are the lesson. The posts pipeline
 * (routes → controller → use case → repository → DAO) stays untouched.
 *
 * Error policy (same as db_demo_routes): a deliberately failing outcome —
 * the oversold naive race, a rejected guarded booking, crash=1's rollback —
 * is a SUCCESSFUL observation and answers HTTP 200 with the evidence; only
 * malformed input is a 400/404 error envelope.
 */

export const SQL_DEPTH_DEMO_MOUNT_PATH = '/api/demo/db';

// --- shared input parsing ---------------------------------------------------------

/** Reads one optional string query param; repeated params (?a=1&a=2) are rejected. */
function readOptionalStringParam(query: Request['query'], name: string): string | undefined {
  const raw = query[name];
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new ValidationException(`"${name}" must be a single query string`, {
      parameter: name,
      received: raw,
    });
  }
  return raw;
}

/** Reads one required string query param (trimmed, non-empty, within a length cap). */
function readRequiredStringParam(
  query: Request['query'],
  name: string,
  maxLength: number,
): string {
  const raw = query[name];
  if (raw === undefined) {
    throw new ValidationException(`"${name}" is required`, { parameter: name });
  }
  if (typeof raw !== 'string') {
    throw new ValidationException(`"${name}" must be a single query string`, {
      parameter: name,
      received: raw,
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationException(`"${name}" must not be blank`, { parameter: name });
  }
  if (trimmed.length > maxLength) {
    throw new ValidationException(`"${name}" must be at most ${maxLength} characters`, {
      parameter: name,
    });
  }
  return trimmed;
}

/** Reads an optional whole-number query param with a default and an inclusive range. */
function readIntParam(
  query: Request['query'],
  name: string,
  { default: defaultValue, min, max }: { default: number; min: number; max: number },
): number {
  const raw = readOptionalStringParam(query, name);
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new ValidationException(`"${name}" must be a whole number between ${min} and ${max}`, {
      parameter: name,
      received: raw,
    });
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ValidationException(`"${name}" must be between ${min} and ${max}`, {
      parameter: name,
      received: value,
    });
  }
  return value;
}

/** The absent-or-1 flag convention (same contract as the transfer demo's crash). */
function readCrashFlag(query: Request['query']): boolean {
  const raw = query.crash;
  if (raw === undefined || raw === '') return false;
  if (raw !== '1') {
    throw new ValidationException('"crash" may only be absent or ?crash=1', {
      parameter: 'crash',
      received: raw,
    });
  }
  return true;
}

// --- sql-lab: the three named queries + the EXPLAIN comparison --------------------

function orgChartController(req: Request, res: Response): void {
  const manager = readOptionalStringParam(req.query, 'manager') ?? STAFF_CEO_ID;
  const db = openSqlDepthDatabase();
  try {
    const exhibit = orgChartUnder(db, manager);
    if (exhibit.rows.length === 0) {
      throw new NotFoundException(
        `no staff member with id "${manager}" — the org chart needs a seeded root`,
        { parameter: 'manager', received: manager },
      );
    }
    res.json({
      dataset: 'staff — 12 rows, 3 levels, self-referencing manager FK',
      root: manager,
      ...exhibit,
      maxDepth: Math.max(...exhibit.rows.map((row) => row.depth)),
      note: 'WITH RECURSIVE: the anchor selects the root, the recursive step joins staff '
        + 'to the chart built so far, UNION ALL appends until nobody new reports in. '
        + 'Depth and path are carried THROUGH the recursion — SQL does the tree walk.',
    });
  } finally {
    db.close();
  }
}

function salaryWindowController(_req: Request, res: Response): void {
  const db = openSqlDepthDatabase();
  try {
    res.json({
      dataset: 'staff — 12 rows, 4 departments',
      ...salaryWindowByDepartment(db),
      note: 'RANK() OVER (PARTITION BY department ...) ranks salaries INSIDE each department '
        + 'without collapsing the rows; SUM(...) OVER (ORDER BY hired_at) accumulates a running '
        + 'total per department in hire order. GROUP BY makes these same numbers by throwing '
        + 'away every individual row — windows keep both.',
    });
  } finally {
    db.close();
  }
}

function departmentRollupController(_req: Request, res: Response): void {
  const db = openSqlDepthDatabase();
  try {
    res.json({
      dataset: 'staff — 12 rows, 4 departments',
      ...departmentSalaryRollup(db),
      note: 'aggregate FIRST (the dept subquery), join AFTER — joining before grouping '
        + "would multiply rows and corrupt every count. The LEFT JOIN picks each "
        + "department's manager: the member its own people report to. Executive has none "
        + '(the CEO reports to nobody) — LEFT keeps that row with a null name. avg is '
        + 'CAST(ROUND(AVG(salary_cents)) AS INTEGER): money stays integer.',
    });
  } finally {
    db.close();
  }
}

function planComparisonController(_req: Request, res: Response): void {
  const db = openSqlDepthDatabase();
  try {
    res.json({
      ...salaryIndexComparison(db),
      verdict: 'same filter, two plans: wrapping the column in ANY expression (here '
        + 'salary_cents * 12) hides it from the index on salary_cents, and the optimizer '
        + 'falls back to reading every row. Indexes serve the SHAPE you wrote, not the math you meant.',
    });
  } finally {
    db.close();
  }
}

// --- full-text search: FTS5 vs LIKE, plans side by side ----------------------------

const SEARCH_TERM_MAX_LENGTH = 100;

function searchController(req: Request, res: Response): void {
  const term = readRequiredStringParam(req.query, 'q', SEARCH_TERM_MAX_LENGTH);
  const db = openSqlDepthDatabase();
  try {
    let comparison;
    try {
      comparison = searchPostsWithComparison(db, term);
    } catch (cause) {
      // The term becomes an FTS5 MATCH expression — a lone quote, say, is not
      // a valid one. That is a bad request, not a server error.
      if (cause instanceof Database.SqliteError) {
        throw new ValidationException(
          `"q" is not a valid FTS5 query: ${cause.message} — plain words, "phrases", and OR work`,
          { parameter: 'q', received: term },
          cause,
        );
      }
      throw cause;
    }
    res.json({
      ...comparison,
      verdict: "FTS5 walks its inverted index (VIRTUAL TABLE INDEX in the plan) and returns "
        + "bm25-ranked rows with a snippet; LIKE '%…%' has no prefix to seek, so SQLite "
        + 'SCANs posts and matches raw substrings. Same answer on this tiny table — '
        + 'wildly different work on a big one.',
    });
  } finally {
    db.close();
  }
}

// --- the booking race ---------------------------------------------------------------

const RACE_CONCURRENCY_MAX = 8;
const RACE_STOCK_MAX = 99;

async function raceController(req: Request, res: Response): Promise<void> {
  const mode = readRequiredStringParam(req.query, 'mode', 10);
  if (mode !== 'naive' && mode !== 'safe') {
    throw new ValidationException('"mode" must be "naive" or "safe"', {
      parameter: 'mode',
      received: mode,
    });
  }
  const concurrency = readIntParam(req.query, 'concurrency', {
    default: 2,
    min: 1,
    max: RACE_CONCURRENCY_MAX,
  });
  const initialStock = readIntParam(req.query, 'stock', {
    default: 1,
    min: 0,
    max: RACE_STOCK_MAX,
  });

  const db = openSqlDepthDatabase();
  try {
    // Deterministic start line on every call: reset the seeded row, then race.
    const reset = db
      .prepare('UPDATE inventory SET stock = ? WHERE item = ?')
      .run(initialStock, DEMO_INVENTORY_ITEM);
    if (reset.changes !== 1) {
      throw new NotFoundException(`no inventory row for "${DEMO_INVENTORY_ITEM}"`, {
        item: DEMO_INVENTORY_ITEM,
      });
    }

    // Fire all bookings "at once": Promise.all starts each attempt, and the
    // naive attempts await between their read and their write — the event
    // loop interleaves them exactly like concurrent requests would.
    const outcomes = await Promise.all(
      Array.from({ length: concurrency }, () =>
        mode === 'naive'
          ? bookNaive(db, DEMO_INVENTORY_ITEM)
          : Promise.resolve(bookSafe(db, DEMO_INVENTORY_ITEM)),
      ),
    );
    const attempts = outcomes.map((outcome, index) => ({ attempt: index + 1, mode, ...outcome }));
    const finalStock = (
      db.prepare('SELECT stock FROM inventory WHERE item = ?').get(DEMO_INVENTORY_ITEM) as {
        stock: number;
      }
    ).stock;
    const successCount = attempts.filter((attempt) => attempt.succeeded).length;

    res.json({
      handle: ':memory:',
      item: DEMO_INVENTORY_ITEM,
      mode,
      concurrency,
      initialStock,
      attempts,
      successCount,
      finalStock,
      oversold: finalStock < 0,
      sql: {
        readStock: SELECT_STOCK_SQL,
        naiveDecrement: NAIVE_DECREMENT_SQL,
        safeDecrement: SAFE_DECREMENT_SQL,
      },
      explain:
        mode === 'naive'
          ? `every attempt SELECTed stock=${initialStock} BEFORE any UPDATE ran — the 50ms `
            + 'await between read and write yields the event loop, so each booking acted on '
            + `a stale read and decremented anyway: ${initialStock} → ${finalStock}. `
            + '"check, then later act" is two statements, and two statements are not atomic.'
          : 'the WHERE stock > 0 guard lives INSIDE the decrement, making read-decide-write '
            + 'one statement — SQLite serializes writers, so the surplus attempts matched 0 '
            + 'rows and failed cleanly (changes=0 → 409) instead of overselling.',
    });
  } finally {
    db.close();
  }
}

// --- UUIDv7 vs v4 key strategy --------------------------------------------------------

const UUID_BATCH_DEFAULT = 12;
const UUID_BATCH_MAX = 64;

const sortsAsGenerated = (ids: readonly string[]): boolean =>
  [...ids].every((id, index) => index === 0 || ids[index - 1]! <= id);

function uuidController(req: Request, res: Response): void {
  const count = readIntParam(req.query, 'count', {
    default: UUID_BATCH_DEFAULT,
    min: 1,
    max: UUID_BATCH_MAX,
  });
  const v4 = Array.from({ length: count }, () => randomUUID());
  const v7 = Array.from({ length: count }, () => uuidV7());

  res.json({
    count,
    v4: { asGenerated: v4, sorted: [...v4].sort(), sortsAsGenerated: sortsAsGenerated(v4) },
    v7: { asGenerated: v7, sorted: [...v7].sort(), sortsAsGenerated: sortsAsGenerated(v7) },
    explain: 'v7 = 48-bit unix-ms prefix + a per-ms monotonic counter (RFC 9562), so ids '
      + 'compare in generation order — appends into B-trees, natural sort keys, no '
      + 'coordinate-before-write. v4 = 122 random bits: same uniqueness, uniform scatter. '
      + 'sorted === asGenerated for v7 on every batch; v4 only by coincidence.',
  });
}

// --- the transactional audit trail ------------------------------------------------------

const DEFAULT_AUDIT_POST_ID = SEED_POSTS[0]!.id;
const AUDIT_TITLE_MAX_LENGTH = 200;
const AUDIT_BODY_MAX_LENGTH = 5000;
const AUDIT_CHANGED_BY_MAX_LENGTH = 60;

interface AuditPatchInput {
  postId: string;
  title?: string;
  body?: string;
  changedBy: string;
  crash: boolean;
}

function readAuditPatch(req: Request): AuditPatchInput {
  const raw = req.body;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationException('the body must be a JSON object', { body: raw });
  }
  const { postId, title, body, changedBy } = raw as Record<string, unknown>;

  const readOptionalTextField = (
    name: string,
    value: unknown,
    maxLength: number,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationException(`"${name}" must be a non-blank string`, { field: name });
    }
    if (value.length > maxLength) {
      throw new ValidationException(`"${name}" must be at most ${maxLength} characters`, {
        field: name,
      });
    }
    return value;
  };

  const titleField = readOptionalTextField('title', title, AUDIT_TITLE_MAX_LENGTH);
  const bodyField = readOptionalTextField('body', body, AUDIT_BODY_MAX_LENGTH);
  if (titleField === undefined && bodyField === undefined) {
    throw new ValidationException('nothing to update — send at least "title" or "body"', {
      fields: ['title', 'body'],
    });
  }

  return {
    postId:
      readOptionalStringParam(req.query, 'postId') ??
      (typeof postId === 'string' && postId !== '' ? postId : DEFAULT_AUDIT_POST_ID),
    title: titleField,
    body: bodyField,
    changedBy: readOptionalTextField('changedBy', changedBy, AUDIT_CHANGED_BY_MAX_LENGTH) ?? 'demo reviewer',
    crash: readCrashFlag(req.query),
  };
}

async function auditPatchController(req: Request, res: Response): Promise<void> {
  const input = readAuditPatch(req);
  const db = openSqlDepthDatabase();
  try {
    const target = findPost(db, input.postId);
    if (target === undefined) {
      throw new NotFoundException(`no post with id "${input.postId}"`, { postId: input.postId });
    }

    let result;
    if (input.crash) {
      try {
        result = updatePostWithAudit(db, { ...input, crashBetweenWrites: true });
      } catch {
        // The deliberate throw INSIDE the transaction already rolled both
        // writes back — observing that rollback IS this endpoint's job.
      }
    } else {
      result = updatePostWithAudit(db, input);
    }

    const updated = result !== undefined;
    const after = findPost(db, input.postId)!; // the row existed moments ago
    const trail = auditTrailFor(db, 'post', input.postId);

    res.json({
      handle: ':memory:',
      postId: input.postId,
      changedBy: input.changedBy,
      crash: input.crash,
      updated,
      rolledBack: input.crash && !updated,
      before: result !== undefined ? result.before : after,
      after,
      auditRowCount: trail.rows.length,
      auditRows: trail.rows,
      note: updated
        ? 'the posts UPDATE and the audit_log INSERT ran inside ONE better-sqlite3 '
          + 'transaction — a trail row exists if and only if its change committed.'
        : 'the simulated crash hit BETWEEN the post UPDATE and the audit INSERT; the '
          + 'transaction rolled back both, so the post is unchanged and no partial '
          + "audit row survived. That is the pattern's whole value.",
    });
  } finally {
    db.close();
  }
}

/**
 * The trail read, made self-contained like every demo here: a fresh handle,
 * two scripted audited updates (a title change by the editor, a body change
 * by the author), then the indexed trail read for that post.
 */
function auditTrailController(req: Request, res: Response): void {
  const postId = readOptionalStringParam(req.query, 'postId') ?? DEFAULT_AUDIT_POST_ID;
  const db = openSqlDepthDatabase();
  try {
    const post = findPost(db, postId);
    if (post === undefined) {
      throw new NotFoundException(`no post with id "${postId}"`, { postId });
    }

    updatePostWithAudit(db, {
      postId,
      title: `${post.title} (2nd edition)`,
      changedBy: 'the editor',
    });
    updatePostWithAudit(db, {
      postId,
      body: `${post.body} Updated for clarity.`,
      changedBy: 'the author',
    });

    res.json({
      handle: ':memory:',
      postId,
      ...auditTrailFor(db, 'post', postId),
      note: 'oldest first (ORDER BY id), read through idx_audit_entity — each entry pairs '
        + 'old_values/new_values JSON snapshots and who made the change. Both entries were '
        + 'written inside the same transaction as their UPDATE.',
    });
  } finally {
    db.close();
  }
}

export const sqlDepthDemoRouter = Router();
sqlDepthDemoRouter.get('/demo/db/sql-lab/org-chart', orgChartController);
sqlDepthDemoRouter.get('/demo/db/sql-lab/salary-window', salaryWindowController);
sqlDepthDemoRouter.get('/demo/db/sql-lab/department-rollup', departmentRollupController);
sqlDepthDemoRouter.get('/demo/db/sql-lab/plan-comparison', planComparisonController);
sqlDepthDemoRouter.get('/demo/db/search', searchController);
sqlDepthDemoRouter.post('/demo/db/race', raceController);
sqlDepthDemoRouter.get('/demo/db/uuid', uuidController);
sqlDepthDemoRouter.patch('/demo/db/audit/post', auditPatchController);
sqlDepthDemoRouter.get('/demo/db/audit/post', auditTrailController);
