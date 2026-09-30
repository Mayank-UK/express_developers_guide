import type { Topic } from '../types.js';

/**
 * The SQL with Node topic: the layers between TypeScript and the database —
 * drivers (why better-sqlite3 is synchronous and why that is fine here), the
 * DAO + repository pattern this repo actually runs, parameterized queries,
 * transactions, a real hand-rolled migration runner, and an honest ORM
 * comparison (none of which are installed — the idioms are illustrative).
 * Snippets marked verbatim are this app's running source.
 */
export const topicSqlNode: Topic = {
  id: 'sql-node',
  title: 'SQL with Node',
  subtitle:
    'SQLite as the primary database in this repo, plus Prisma, Sequelize, and Knex; migrations and the DAO layer.',
  group: 'data',
  order: 2,
  sections: [
    {
      id: 'db-node-drivers',
      title: 'Drivers: the layers under your code',
      lead: 'Every database library in npm is three layers: the wire protocol (or file format), native bindings, and the JavaScript API you actually call. Picking a driver is picking a tradeoff on those layers — and the first surprise is that this guide\'s driver is synchronous, on purpose.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-drivers:layers',
          body: `THE SQLITE PAIR, and why this repo chose the weird one. node-sqlite3 (the npm "sqlite3" package) is ASYNCHRONOUS — every call takes a callback (or returns a promise) because it ships work to a thread pool that talks to the database file. better-sqlite3 is SYNCHRONOUS — prepare() and .all() BLOCK the event loop until SQLite answers, and it can afford to because there is no network and no other process: SQLite is a LIBRARY in your process reading a local file, and the same query that takes 40ms of round-trip latency against Postgres over a socket takes MICROSECONDS against a local b-tree. "Synchronous blocks the event loop" is a real cost (see the Node.js topic's blocking demo) but a bounded one: for a local app like this guide — one process, fast disk, queries measured in microseconds — the simplicity is worth more than the concurrency, and better-sqlite3 is also FASTER in benchmarks precisely because it skips the thread-pool hop. The honest rule: better-sqlite3 is excellent for local-first apps, CLIs, desktop tools, and teaching (this repo); the moment queries are slow by nature (big scans) or the database is elsewhere, you need the async world. THE SERVER DATABASES: pg (Postgres) and mysql2 speak REAL wire protocols over TCP — which changes three things. Each CONNECTION is a socket owned by one query at a time (run two queries on one connection and the protocol interleaves into garbage), so you POOL: the pg Pool keeps N warm connections and lends them per query, and NOT pooling is the classic production killer (a connection per request exhausts Postgres's default 100-connection limit long before you exhaust memory). Connections FAIL and need health checks and reconnects. And every call is genuinely ASYNC because the network says so — which is why the repository port in this repo is async (Promise<Result<Post, Failure>>) even though the SQLite implementation underneath is synchronous code: the domain layer stays honest about what a database is, so swapping the sqlite repository (makeSqlitePostRepository) for a Postgres implementation changes NOTHING above it.`,
        },
        {
          kind: 'code',
          id: 'db-node-drivers:verbatim',
          language: 'ts',
          source: 'server/src/data/posts/sqlite_client.ts',
          caption: 'Verbatim — this guide\'s lazy singleton handle (data/posts/sqlite_client.ts), then the pooled pg idiom a server deployment grows into (illustrative — pg is NOT installed in this repo)',
          code: `// better-sqlite3, as this repo really opens it — lazy, so fake-mode runs
// never pay for a connection, and :memory: under test so nothing touches disk:
import Database from 'better-sqlite3';

let db: Database.Database | undefined;

export function getSqlite(): Database.Database {
  db ??= bootstrap(openDatabase());   // ONE handle per process: SQLite
  return db;                          //   serializes writers itself
}

function openDatabase(): Database.Database {
  if (appConfig.dbPath !== ':memory:') {
    mkdirSync(path.dirname(appConfig.dbPath), { recursive: true }); // parent dir
  }
  return new Database(appConfig.dbPath);
}

// The pg idiom this would grow into on a server (illustrative, not installed):
// import { Pool } from 'pg';
// const pool = new Pool({ connectionString, max: 10 });  // N warm sockets,
// pool.query('SELECT id FROM posts WHERE id = $1', [id]); //  lent per query
//   — a connection per REQUEST is the production killer a pool exists to fix.`,
        },
      ],
    },
    {
      id: 'db-node-dao',
      title: 'The DAO pattern in this repo',
      lead: 'This app splits "talks to SQLite" into TWO modules with one job each: the DAO (a small class) speaks raw SQL and rows; the repository (a make* factory) speaks the domain\'s language and translates. The dependency rule does the rest — and it is visible in which folder imports which.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-dao:split',
          body: `THE DAO (data access object) is the mechanical half: one class per table-ish concern, raw SQL strings as close to the metal as the app gets, methods named after ROWS (list, findById, insert), returning ROW SHAPES (PostRow with snake_case columns — the table\'s shape, not the domain\'s). It has no opinions: no business rules, no Failure mapping, no HTTP awareness — it throws whatever better-sqlite3 throws and lets the layer above decide what that means. THE REPOSITORY is the translating half: it is the data layer\'s implementation of the domain\'s PostRepositoryPort (an interface the DOMAIN owns — that is the dependency rule pointing the right way), exported as a make* factory returning a FROZEN object; it maps PostRow ↔ Post (snake_case columns ↔ camelCase fields — rowToPost below is the entire ceremony), mints ids and timestamps on create, and translates sqlite errors into the app's ONE Failure taxonomy (a UNIQUE violation becomes a typed conflict; everything else an internal failure with the cause attached). WHY THE SPLIT EARNS ITS SEAM: rows never leak (a route handler importing PostRow would be a visible architecture violation — PostRow's interface is exported but only the repository imports it); SQL lives in ONE findable place (every query this app runs is in a 50-line file you can read in one sitting); and the fake/live toggle this guide demos elsewhere works because the USE CASE calls the port, not the DAO — the in-memory fake repository reimplements the port with zero SQL and the layers above cannot tell the difference. THE ASYMMETRY worth noticing: the DAO is synchronous (better-sqlite3 all the way down) while the repository's methods are async — because the PORT (the domain interface) is async, for exactly the driver story above: a Postgres repository would be async by necessity, and the domain should not have to change when the database does.`,
        },
        {
          kind: 'code',
          id: 'db-node-dao:verbatim',
          language: 'ts',
          source: 'server/src/data/posts/post_dao.ts',
          caption: 'Verbatim — the real DAO (data/posts/post_dao.ts): raw SQL, row shapes, no opinions',
          code: `// The DAO — raw SQL, row shapes, no opinions:
export interface PostRow {           // the TABLE's shape; never leaves src/data
  id: string;
  title: string;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
}

export class PostDao {
  constructor(db: Database.Database) {
    this.db = db;
  }

  findById(id: string): PostRow | undefined {
    return this.db
      .prepare(
        'SELECT id, title, body, author, created_at, updated_at FROM posts WHERE id = ?',
      )
      .get(id) as PostRow | undefined;      // positional ? — see the next section
  }
  // …list() and insert(), same shape — insert uses named @id, @title… params…
}`,
        },
        {
          kind: 'code',
          id: 'db-node-dao:verbatim-repository',
          language: 'ts',
          source: 'server/src/data/posts/sqlite_post_repository.ts',
          caption: 'Verbatim — the repository\'s mapping + error translation (data/posts/sqlite_post_repository.ts)',
          code: `// The repository — mapping at the boundary, errors into the one taxonomy:
function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    author: row.author,
    createdAt: row.created_at,     // snake → camel: the entire ceremony
    updatedAt: row.updated_at,
  };
}

function toRepositoryFailure(operation: string, cause: unknown): Failure {
  if (cause instanceof Database.SqliteError && cause.code.startsWith('SQLITE_CONSTRAINT')) {
    return failure('conflict', \`\${operation} violated a database constraint\`, { operation }, cause);
  }
  return failure('internal', \`\${operation} failed in sqlite\`, { operation }, cause);
}

// …inside makeSqlitePostRepository — the lazy memoized DAO thunk, then:
const activeDao = (): PostDao => (daoInstance ??= dao());

async findById(id: string): Promise<Result<Post, Failure>> {
  try {
    const row = activeDao().findById(id);
    if (row === undefined) {
      return fail(failure('not_found', \`no post with id "\${id}"\`, { postId: id }));
    }
    return ok(rowToPost(row));           // a Post crosses the boundary — never a row
  } catch (cause) {
    return fail(toRepositoryFailure('fetching a post', cause));
  }
}`,
        },
      ],
    },
    {
      id: 'db-node-parameters',
      title: 'Parameterized queries or else',
      lead: 'SQL injection is not a hack you defend against with cleverness — it is what happens when DATA and CODE travel in the same string. The defense is structural: send them separately. Every driver in this guide makes that the easy path; the live demo below proves the classic payload fails, harmlessly.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-parameters:mechanics',
          body: `THE ATTACK in one line: build SQL by concatenation — \`SELECT … WHERE title = '\${attempt}'\` — and a user-supplied attempt of ' OR '1'='1 closes your quote, appends a tautology, and the WHERE matches EVERY ROW (the friendlier payloads then UNION in a users table or flip the WHERE into an UPDATE — injection is arbitrary SQL, not just over-reading). The root cause is category confusion: the string you EXECUTE contains both the QUERY (code) and the VALUE (data) in one channel, so anything that can reach the value can reach the code. THE DEFENSE, structural: bind parameters — the query travels with PLACEHOLDERS (WHERE title = ?), the values travel SEPARATELY through the driver's bind mechanism, and the database parses the query BEFORE any value is substituted. Not "escaped cleverly so it's safe inside quotes" — never substituted into the text at all. better-sqlite3 offers POSITIONAL ? (this repo's findById) and NAMED @title / :title / $title (its insert uses @id, @title…), both first-class. THE DEMO BELOW makes it empirical: you fire the classic payload at a real parameterized lookup and watch it match ZERO rows — because the database is comparing the literal nine-character string "' OR '1'='1" against post titles, exactly as it would compare "hello". THE HONEST FINE PRINT, two clauses. Escaping-by-replacing-quotes is a bug factory (encoding, multi-byte tricks — do not); and parameters only work for VALUES: you cannot bind a table or column name (? has no syntax for identifiers), so dynamic IDENTIFIERS need an allowlist you write yourself — \`if (!['title','author'].includes(sortBy)) throw\` — never interpolation. LIKE's wildcards are data, not injection, but deserve the same respect (% and _ in user input match more than intended); the fix is like-anywhere logic in your code, not string surgery.`,
        },
        {
          kind: 'code',
          id: 'db-node-parameters:naive-vs-safe',
          language: 'ts',
          source: 'server/src/presentation/routes/db_demo_routes.ts',
          caption: 'The naive form shown INERT (it is the live demo\'s response STRING, never executed) against the safe forms this repo runs — then the real endpoint\'s proof',
          code: `// The SAFE lookup's one constant, and the parameterized call that runs it:
const INJECTION_LOOKUP = 'SELECT id, title, author FROM posts WHERE title = ?';
const matchedRows = db.prepare(INJECTION_LOOKUP).all(attempt) as {
  id: string;
  title: string;
  author: string;
}[];   // → [] for the classic payload — it is just a title now

// WHAT NOT TO DO — displayed as a string in the demo response, never run:
const naiveQuery = \`SELECT id, title, author FROM posts WHERE title = '\${attempt}'\`;
//   attempt = "' OR '1'='1"  →  WHERE title = '' OR '1'='1'   ← matches EVERY row

// SAFE, named — this repo's INSERT style (@id, @title… — see post_dao.ts's
// insert(): the named twin of the positional ? above).

// The live proof (this file's routes):
//   GET /api/demo/db/injection?attempt=' OR '1'='1
//   → { matchedCount: 0, boundParameter: "' OR '1'='1",
//       naiveQuery: "SELECT … WHERE title = '' OR '1'='1'",  ← INERT display
//       verdict: "the payload was compared as a literal title — nothing matched" }`,
        },
      ],
    },
    {
      id: 'db-node-transactions',
      title: 'Transactions',
      lead: 'A transaction is the database\'s promise that a GROUP of writes lands all-or-nothing — the unit of atomicity every multi-write invariant needs. better-sqlite3 makes the syntax a one-liner; the live demo crashes one on purpose so you can watch it keep the promise.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-transactions:atomicity',
          body: `THE PROMISE: BEGIN, write, write, COMMIT — and either every write is durable or none is; anything thrown before COMMIT triggers ROLLBACK, restoring the database to the instant before BEGIN. WITHOUT that promise, every multi-write operation is a RACE against crashes: "remove the tag from post A, then add it to post B" done as two bare writes is two moments where the data is WRONG (tag on neither post after a crash between them, tag on both if the order were reversed) — and every invariant you declared in the schema topic ("comment_count equals COUNT(comments)") is unenforceable across statements. WITH it, the two writes become ONE fact. WHEN TRANSACTIONS MATTER: any multi-write invariant (move X between rows — the demo; insert order + order_items; update a counter and its audit row), any read-modify-write over multiple statements that must not interleave, and bulk loads (one transaction per few hundred rows is orders of magnitude faster than per-row commits, because each commit is an fsync). WHEN THEY DO NOT: a single INSERT/UPDATE/DELETE is already atomic by itself — wrapping one statement in a transaction buys nothing. better-sqlite3'S API is the friendliest in the ecosystem: db.transaction(fn) returns a wrapped function; call it and the fn's statements run inside BEGIN…COMMIT, and if fn THROWS, the wrapper rolls back and re-throws — which is why the transfer demo can simulate a crash by simply throwing between its two writes (below, live: crash=1 rolls back the DELETE too, and the before/after counts come back IDENTICAL, which is atomicity made visible). Two SQLite specifics worth knowing: the handle is one connection, so a transaction HOLDS the write lock — keep them short; and nested db.transaction() calls are supported via savepoints, but in this repo's size of code the flat kind is all you need.`,
        },
        {
          kind: 'code',
          id: 'db-node-transactions:verbatim',
          language: 'ts',
          source: 'server/src/presentation/routes/db_demo_routes.ts',
          caption: 'Verbatim — the demo transfer (db_demo_routes.ts): two writes, ONE transaction, a deliberate crash between them',
          code: `// Two writes, ONE transaction: remove the tag from alpha, add it to beta.
// better-sqlite3's .transaction() rolls back EVERYTHING if anything throws.
const moveTag = db.transaction((fromPost: string, toPost: string): void => {
  db.prepare('DELETE FROM posts_tags WHERE post_id = ? AND tag_id = ?').run(fromPost, DEMO_TAG_ID);
  if (crash) {
    // Deliberately between the two writes — the exact moment atomicity exists for.
    throw new Error('simulated crash between the DELETE and the INSERT');
  }   // ↑ the throw rolls the transaction back — the DELETE is undone too
  db.prepare('INSERT INTO posts_tags (post_id, tag_id) VALUES (?, ?)').run(toPost, DEMO_TAG_ID);
});

// …the endpoint calls moveTag inside a try — the throw is CAUGHT there, the
// response stays HTTP 200, and both writes are already rolled back…`,
        },
        {
          kind: 'code',
          id: 'db-node-transactions:verbatim-seed',
          language: 'ts',
          source: 'server/src/data/posts/sqlite_client.ts',
          caption: 'Verbatim — the guide\'s real seed write (data/posts/sqlite_client.ts): same construct, production clothing — every seed row lands or none does',
          code: `const insertSeed = database.prepare(INSERT_SEED_POST);
database.transaction(() => {
  for (const post of SEED_POSTS) {
    insertSeed.run({
      id: post.id,
      // …title, body, author, created_at, updated_at — the full row…
    });
  }
})();`,
        },
      ],
    },
    {
      id: 'db-node-migrations',
      title: 'Migrations',
      lead: 'The schema-history pattern from the schema topic, running for real: eight ordered .sql files (0001…0008 — the tags schema the demo quotes below, plus the staff dataset, salary index, posts full-text search, inventory, audit log, and outbox the later topics use), a schema_migrations table, per-file transactions, idempotent boot. The whole runner is one readable file — and the demo below drives it over HTTP.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-migrations:runner',
          body: `WHAT YOU'RE READING: the guide's REAL migration runner — server/src/data/migrations/migration_runner.ts — in the same shape Knex/Sequelize/Prisma migrate ship, minus the framework. THE MOVING PARTS, each one small: DISCOVERY reads the directory beside the runner (resolved from import.meta.url, never cwd, so it works under tsx, vitest, and the compiled dist/ alike) and keeps files matching ^\\d{4}_…\\.sql, sorted — the number IS the order. STATE comes from the schema_migrations table (created if absent): applied names from the table, pending = files minus applied. APPLY loops the pending files; each runs INSIDE ITS OWN TRANSACTION that also records the file's name — a crash mid-file leaves neither the DDL nor the record, so the next boot retries it cleanly instead of choking on half a schema. IDEMPOTENT BOOT falls out: running the runner on an up-to-date database applies nothing, which is why openMigratedDatabase() can open + migrate + return in one call, and why the demo's apply endpoint runs the runner a SECOND time just to show an empty appliedThisRun. THE FILES ARE PLAIN SQL — no DSL, no up/down machinery for this guide's size: 0001 creates the tags many-to-many (demo_posts, tags with its UNIQUE + CHECK, posts_tags with the composite primary key and two ON DELETE CASCADE FKs — every idea from the schema topic, in DDL), 0002 adds the indexes as their own append-only step, and 0003 through 0008 append the later exhibits' slices the same way (staff dataset + salary index, posts full-text search with its sync triggers, the booking race's inventory, the audit trail, the transactional outbox). Write migrations as the SQL you would run by hand, and the runner is the discipline that runs them in order, exactly once, everywhere.`,
        },
        {
          kind: 'code',
          id: 'db-node-migrations:verbatim-first',
          language: 'sql',
          source: 'server/src/data/migrations/0001_create_tags_tables.sql',
          caption: 'Verbatim — the first real migration file (server/src/data/migrations/0001_create_tags_tables.sql)',
          code: `CREATE TABLE demo_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 40)
);

CREATE TABLE posts_tags (
  post_id TEXT NOT NULL REFERENCES demo_posts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);`,
        },
        {
          kind: 'code',
          id: 'db-node-migrations:verbatim-second',
          language: 'sql',
          source: 'server/src/data/migrations/0002_add_indexes.sql',
          caption: 'Verbatim — the second (server/src/data/migrations/0002_add_indexes.sql): indexes arrive as their OWN ordered step, never as edits to 0001',
          code: `CREATE INDEX idx_posts_tags_tag_id ON posts_tags(tag_id);
CREATE INDEX idx_tags_name ON tags(name);`,
        },
      ],
    },
    {
      id: 'db-node-orm',
      title: 'The ORM comparison',
      lead: 'Prisma, Sequelize, Knex, Drizzle — none of them are installed in this repo, and that is deliberate: this guide teaches raw SQL + a DAO so every line is yours. But the comparison is honest, with real code idioms, because a senior answer names the tradeoffs instead of a brand.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-orm:survey',
          body: `THE LANDSCAPE, honestly. PRISMA is schema-first with CODEGEN: you write schema.prisma, prisma generate mints a fully-typed client, and a typo'd field is a COMPILE error before it is a runtime one — the strongest typing in the field, at the cost of a build step, generated artifacts in CI/Docker, and a query engine binary that makes the dependency distinctly heavier. SEQUELIZE is the classic ACTIVE-RECORD-style ORM: classes with methods, eager loading, migrations, a decade of Stack Overflow answers — mature and battle-tested, with the classic ORM costs at their fullest: the object-relational impedance mismatch is real (N+1 queries behind innocent-looking associations, hydration overhead, SQL that surfaces only in logs). KNEX is NOT an ORM and calling it one is the survey's one correction worth making: it is a QUERY BUILDER — SQL's shape in TypeScript method chains, no entities, no identity map, plus a solid migration runner; it is the middle ground (and Sequelize's query layer underneath). DRIZZLE is the young TS-first option: SQL-shaped syntax, light, no codegen in the Prisma sense — the one to watch for this guide's tastes. THE DECISION FRAMEWORK this guide actually applies: RAW SQL + DAO (this repo) buys FULL control — every query reviewable in one file, zero magic between intent and SQL, no codegen step — at the cost of hand-writing the mapping layer you just read; a QUERY BUILDER (Knex/Drizzle) buys composability (dynamic WHEREs without string surgery) and typed results while staying SQL-shaped — usually the smallest step up from raw; a FULL ORM buys velocity on CRUD-heavy domains and type-safe relations out of the box, at the cost of the abstraction leaking exactly when performance matters (every team eventually writes rawQuery somewhere). The senior move is not a brand — it is matching the weight: a local-first teaching guide, raw SQL; a product with dynamic filters and five tables, a query builder; a large team shipping CRUD against Postgres with types as a contract, Prisma. Whatever you pick, the schema topic's rules survive it: keys, constraints, indexes, and migrations-as-history are engine-level facts that every layer above must respect.`,
        },
        {
          kind: 'code',
          id: 'db-node-orm:idioms',
          language: 'ts',
          source: 'server/src/domain/teaching/exhibit_b_sql_node_orm_idioms.ts',
          caption: 'The same "find a post by id" in each idiom, quoted from the teaching exhibit server/src/domain/teaching/exhibit_b_sql_node_orm_idioms.ts. None of these packages are installed here; the raw-DAO version at the bottom is the one this repo runs',
          code: `// Prisma (schema-first + codegen): types come from schema.prisma
// model Post { id String @id  title String  createdAt DateTime }
// const post = await prisma.post.findUnique({ where: { id }, include: { comments: true } });
//   + fully typed, relations included on demand
//   − generate step in CI/Docker, query-engine binary dependency

// Sequelize (classic active-record): classes, finders, eager loading
// const post = await Post.findByPk(id, { include: [{ model: Comment, as: 'comments' }] });
//   + a decade of maturity, everything built in
//   − N+1 traps, hydration cost, SQL visible only in logs

// Knex (query builder — NOT an ORM): SQL's shape, method-chained
// const rows = await knex('posts').select('*').where({ id }); // no entities — rows
//   + dynamic queries compose without string surgery; solid migrations
//   − you still map rows to domain shapes yourself (a DAO, basically)

// Drizzle (TS-first, SQL-shaped — the modern light option):
// const post = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
//   + SQL-shaped, light, types without a codegen step
//   − younger ecosystem than the others

// Raw SQL + DAO — what this repo actually runs (data/posts/post_dao.ts):
export function rawDaoFindById(db: Database.Database, id: string): unknown {
  return db
    .prepare(
      'SELECT id, title, body, author, created_at, updated_at FROM posts WHERE id = ?',
    )
    .get(id);
}
//   + zero magic: the SQL you see is the SQL that runs; no build step
//   − the mapping layer is yours to write (you just read it, in the DAO section)`,
        },
      ],
    },
    {
      id: 'db-node-sql-by-hand',
      title: 'SQL by hand: CTEs, window functions, aggregates',
      lead: 'Joins are the floor, not the ceiling. A recursive CTE walks a tree in one query, window functions aggregate WITHOUT collapsing rows, and aggregate-then-join keeps every count honest — three named queries against the seeded staff table, each returned with the exact SQL that ran so you read the query beside its result.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-sql-by-hand:queries',
          body: `THE RECURSIVE CTE is SQL's tree walker. The staff table carries a self-referencing manager FK, and "the whole team under one manager" is a query the schema already knows how to answer: WITH RECURSIVE defines a named subquery in two halves — the ANCHOR (SELECT the chosen root at depth 0) and the RECURSIVE STEP (JOIN staff to the chart built so far, appending everyone whose manager is already in it), and UNION ALL repeats the step until nobody new reports in; that is the termination condition, implicit and safe. The trick worth internalizing: depth and path are not computed after the fact, they are CARRIED THROUGH the recursion — each row is born knowing o.depth + 1 and o.path || ' > ' || s.name, so the query returns the org chart pre-annotated. The manager id is bound as a ? parameter (the injection section's rule, practiced). WINDOW FUNCTIONS are "GROUP BY that keeps your rows". RANK() OVER (PARTITION BY department ORDER BY salary_cents DESC) ranks every salary INSIDE its department while every individual row survives — GROUP BY department would give you the same ordering information only by throwing the people away. SUM(...) OVER (PARTITION BY department ORDER BY hired_at) is a RUNNING TOTAL: each row carries the department's salary sum SO FAR in hire order — the shape financial dashboards actually want, and one a plain aggregate cannot express because its result depends on the row's POSITION, not just its group. AGGREGATE-THEN-JOIN is the ordering discipline that keeps rollups true: the dept subquery groups staff into one row per department FIRST, and only then does the outer query LEFT JOIN staff again to fetch each department's manager. Join FIRST and group after, and the join multiplies rows before the aggregate sees them — COUNT(*) counts join duplicates, SUM double-bills — the classic fan-out bug. The LEFT (not INNER) JOIN is deliberate: each department's manager is "the member its own people report to", and executive has none because the CEO reports to nobody — LEFT keeps that row with a null manager name instead of silently dropping a department. And note the money stays integer end to end: CAST(ROUND(AVG(salary_cents)) AS INTEGER) — the schema topic's rule, kept in the query layer.`,
        },
        {
          kind: 'code',
          id: 'db-node-sql-by-hand:org-window',
          language: 'sql',
          source: 'server/src/data/sql_depth/staff_queries.ts',
          caption: 'Verbatim — queries 1 and 2 (data/sql_depth/staff_queries.ts): the recursive org chart, then rank + running total per department',
          code: `-- Query 1 — the recursive CTE: a manager's whole subtree, with depth:
WITH RECURSIVE org_chart (depth, id, name, manager_id, path) AS (
    SELECT 0, id, name, manager_id, name          -- anchor: the chosen root
    FROM staff
    WHERE id = ?
  UNION ALL
    SELECT                                       -- recursive step: everyone reporting into the chart so far
      o.depth + 1, s.id, s.name, s.manager_id, o.path || ' > ' || s.name
    FROM staff s
    JOIN org_chart o ON s.manager_id = o.id
)
SELECT depth, id, name, manager_id, path
FROM org_chart
ORDER BY depth, name

-- Query 2 — window functions: rank and running totals WITHOUT collapsing rows:
SELECT
  name,
  department,
  salary_cents,
  RANK() OVER (PARTITION BY department ORDER BY salary_cents DESC) AS salary_rank_in_department,
  SUM(salary_cents) OVER (PARTITION BY department ORDER BY hired_at) AS running_salary_total_cents,
  hired_at
FROM staff
ORDER BY department, hired_at`,
        },
        {
          kind: 'code',
          id: 'db-node-sql-by-hand:rollup',
          language: 'sql',
          source: 'server/src/data/sql_depth/staff_queries.ts',
          caption: 'Verbatim — query 3 (same file): aggregate FIRST in the dept subquery, join AFTER; LEFT JOIN finds each department\'s manager',
          code: `SELECT
  dept.department,
  dept.headcount,
  dept.total_salary_cents,
  dept.avg_salary_cents,
  mgr.name AS manager_name
FROM (
  SELECT
    department,
    COUNT(*) AS headcount,
    SUM(salary_cents) AS total_salary_cents,
    CAST(ROUND(AVG(salary_cents)) AS INTEGER) AS avg_salary_cents
  FROM staff
  GROUP BY department
) dept
LEFT JOIN staff mgr
  ON mgr.department = dept.department
 AND mgr.id IN (                      -- the department's manager: the member its own people report to
     SELECT manager_id FROM staff
     WHERE department = dept.department AND manager_id IS NOT NULL
   )
ORDER BY dept.department`,
        },
        {
          kind: 'demo',
          id: 'db-node-sql-by-hand:demo',
          demoId: 'db:sql-lab',
          title: 'The SQL lab: org chart, windows, rollup, plans',
          description:
            'Four exhibits over the seeded staff table (12 rows, 3 levels, self-referencing manager FK), each answering with its rows AND the exact SQL that ran: the recursive CTE org chart with depth and path, RANK() + running totals per department, the aggregate-then-join department rollup, and the plan comparison from the next section.',
        },
        {
          kind: 'code',
          id: 'db-node-sql-by-hand:curl',
          language: 'bash',
          caption: 'The lab from a terminal (boot the server first: npm run dev in server/)',
          code: `# the org chart under the seeded CEO (or pass ?manager=staff-004 for a subtree):
curl -s 'localhost:4000/api/demo/db/sql-lab/org-chart' \\
  | jq '{root, maxDepth, first: .rows[0], last: .rows[-1]}'

# windows: every salary still visible, ranked per department, running total by hire date:
curl -s localhost:4000/api/demo/db/sql-lab/salary-window \\
  | jq '.rows[:3] | map({name, salary_rank_in_department, running_salary_total_cents})'

# the rollup: one row per department, headcount + totals beside the manager's name:
curl -s localhost:4000/api/demo/db/sql-lab/department-rollup | jq '.rows'`,
        },
      ],
    },
    {
      id: 'db-node-query-plans',
      title: 'Reading query plans',
      lead: 'EXPLAIN QUERY PLAN is how you SEE an index work instead of believing in it: SEARCH means the engine descended a B-tree to candidate rows, SCAN means it read every one. The demo below runs one salary predicate written two mathematically-identical ways — one seeks the index, the other defeats it.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-query-plans:verbs',
          body: `THE VERBS ARE THE WHOLE SKILL. A plan step saying SEARCH staff USING INDEX idx_… means tree descent: the engine jumped to candidate rows through a sorted structure (the schema topic's phone book). SCAN staff means a full table read — every row, every page, at every scale — fine at twelve rows, a page-storm at twelve million. SQLite prints these as human-readable detail lines, and EXPLAIN QUERY PLAN in front of any SELECT returns them without running the query: it is the optimizer EXPLAINING ITSELF, costs included ("SEARCH … USING COVERING INDEX" — the query never touched the table at all). THE INDEX-DEFEATING PREDICATE, the one lesson to keep: compare salary_cents > 12_000_000 against salary_cents * 12 > 144_000_000. SAME filter, same rows — but the index is a B-tree over the BARE COLUMN salary_cents, and the moment you wrap the column in ANY expression the engine can no longer walk that tree (no index on salary_cents * anything exists), so it scans and multiplies every row. The optimizer plans around the SHAPE you wrote, not the math you meant — which is why the classic fixes are rewriting the predicate so the bare column sits alone on one side (bind 12_000_000 * 12 as the parameter instead), or indexing the expression itself when you truly need it. Everything else that hides a column from an index is the same sin in costume: functions around it (LOWER(email) = ?), implicit type coercion (a TEXT column compared to a number), and LIKE with a LEADING wildcard ('%term%' has no prefix to seek — the full-text search section's whole motivation). The habit this section installs: when a query matters, paste it into EXPLAIN QUERY PLAN and read the verb; treat a SCAN on a hot path as a question — either the path deserves an index, or the query deserves a rewrite.`,
        },
        {
          kind: 'code',
          id: 'db-node-query-plans:verbatim-helpers',
          language: 'ts',
          source: 'server/src/data/sql_depth/query_plans.ts',
          caption: 'Verbatim — the shared plan helpers every sql-depth exhibit reports through (data/sql_depth/query_plans.ts)',
          code: `/** The optimizer's chosen steps, e.g. 'SEARCH staff USING INDEX ...'. */
export function explainQueryPlan(
  db: Database.Database,
  sql: string,
  ...params: readonly unknown[]
): readonly string[] {
  return (
    db.prepare(\`EXPLAIN QUERY PLAN \${sql}\`).all(...params) as { detail: string }[]
  ).map((row) => row.detail);
}

export function planUsesIndex(steps: readonly string[]): boolean {
  // 'USING INDEX' is the B-tree form; 'VIRTUAL TABLE INDEX 0:M…' is how an
  // FTS5 match reports walking its inverted index instead of the content.
  return steps.some(
    (step) => /USING (COVERING )?INDEX|VIRTUAL TABLE INDEX/i.test(step),
  );
}`,
        },
        {
          kind: 'code',
          id: 'db-node-query-plans:verbatim-pair',
          language: 'ts',
          source: 'server/src/data/sql_depth/staff_queries.ts',
          caption: 'Verbatim — the same filter twice (staff_queries.ts): the bare column seeks the salary index; the wrapped column cannot',
          code: `const INDEX_FRIENDLY_SALARY_SQL = 'SELECT id, name FROM staff WHERE salary_cents > ?';
const INDEX_DEFEATING_SALARY_SQL = 'SELECT id, name FROM staff WHERE salary_cents * 12 > ?';`,
        },
        {
          kind: 'code',
          id: 'db-node-query-plans:curl',
          language: 'bash',
          caption: 'One predicate, two plans — from a terminal',
          code: `curl -s localhost:4000/api/demo/db/sql-lab/plan-comparison \\
  | jq '.variants[] | {label, verb, usedIndex, steps}'
#   index-friendly:   verb SEARCH, usedIndex true  — "SEARCH staff USING INDEX …"
#   index-defeating:  verb SCAN,   usedIndex false — "SCAN staff"`,
        },
      ],
    },
    {
      id: 'db-node-full-text-search',
      title: 'Full-text search',
      lead: 'LIKE \'%term%\' cannot use an index — a leading wildcard has no prefix to seek — so it scans every row and matches raw substrings. SQLite\'s FTS5 builds an inverted index over WORDS: bm25-ranked results, inline hit snippets, and a plan that walks the index instead of the table.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-full-text-search:mechanics',
          body: `THE TWO QUERIES, side by side (the demo runs both and shows both plans). LIKE '%' || ? || '%' matches raw substrings anywhere in title or body — flexible, familiar, and structurally unable to use a B-tree index: a leading wildcard has no PREFIX to seek, so the plan is a full SCAN of posts, at every scale (the query-plans section's lesson, now load-bearing). FTS5 MATCH searches an INVERTED INDEX: for every indexed word, the list of rows containing it — so "which posts contain 'sqlite'" is a lookup, not a scan, and the plan says so (VIRTUAL TABLE INDEX — the FTS5 module walking its own index, which is exactly what planUsesIndex above treats as index use). Ranking comes with it for free: ORDER BY rank returns bm25 relevance, where scores are NEGATIVE and more negative is better (a bm25 quirk worth knowing before you sort it the wrong way), and the snippet() function returns each hit's sentence with the matched words marked inline — the excerpt a search UI actually wants. THE EXTERNAL-CONTENT PATTERN is how FTS5 indexes a table without duplicating it: posts_fts is declared with content='posts', so the index stores only the inverted index and reads column VALUES back from posts itself (the JOIN on rowid) — one source of truth, no second copy to keep in step. But FTS5 has no idea when posts changes, so the migration ships three TRIGGERS that keep the index synchronized on INSERT, UPDATE, and DELETE — and the delete case has a quirk worth reading: an external-content index cannot be told "remove rowid X" directly, it must be shown the OLD values through FTS5's special 'delete' command so it can un-index exactly what was indexed. Triggers are the standard answer in SQLite; Postgres (this guide's honest recommendation for real deployments) does the same job with generated tsvector columns plus triggers, and you graduate to Elasticsearch/OpenSearch only when you outgrow the database — ranking at scale, faceting, typo tolerance. Both queries bind the user's term as a ? parameter: the term never becomes SQL text, and the LIKE variants concatenate the wildcards AROUND the placeholder in SQL, not around the value.`,
        },
        {
          kind: 'code',
          id: 'db-node-full-text-search:verbatim-sql',
          language: 'sql',
          source: 'server/src/data/sql_depth/fts_search.ts',
          caption: 'Verbatim — both search queries (data/sql_depth/fts_search.ts): FTS5 MATCH with bm25 rank and snippet, vs LIKE over the same columns',
          code: `-- FTS5: the inverted index answers, bm25 ranks, snippet marks the hits:
SELECT
  p.id,
  p.title,
  snippet(posts_fts, 1, '[', ']', '…', 8) AS excerpt,   -- column 1 = body, hits marked inline
  rank                                                 -- bm25: negative score, more negative = better
FROM posts_fts
JOIN posts p ON p.rowid = posts_fts.rowid               -- external content: fetch id/title from posts
WHERE posts_fts MATCH ?
ORDER BY rank

-- LIKE: substring matching a B-tree cannot serve — leading wildcard, full SCAN:
SELECT id, title
FROM posts
WHERE title LIKE '%' || ? || '%' OR body LIKE '%' || ? || '%'
ORDER BY created_at DESC`,
        },
        {
          kind: 'code',
          id: 'db-node-full-text-search:verbatim-migration',
          language: 'sql',
          source: 'server/src/data/migrations/0005_create_posts_fts.sql',
          caption: 'Verbatim — the real migration (data/migrations/0005_create_posts_fts.sql): external-content FTS5 table + the three sync triggers',
          code: `CREATE VIRTUAL TABLE posts_fts USING fts5(
  title,
  body,
  content='posts',
  content_rowid='rowid'
);

CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER posts_fts_update AFTER UPDATE OF title, body ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;`,
        },
        {
          kind: 'demo',
          id: 'db-node-full-text-search:demo',
          demoId: 'db:search',
          title: 'FTS5 vs LIKE, plans side by side',
          description:
            "Type a term (try 'sqlite') and watch both engines answer the same question: FTS5 returns bm25-ranked rows with a marked-up snippet and a plan walking the inverted index; LIKE returns raw substring matches with a full SCAN plan. Same answer on twelve seeded posts — wildly different work on twelve million.",
        },
        {
          kind: 'code',
          id: 'db-node-full-text-search:curl',
          language: 'bash',
          caption: 'The comparison from a terminal',
          code: `curl -s 'localhost:4000/api/demo/db/search?q=sqlite' \\
  | jq '{fts: {verb: .fts.verb, usedIndex: .fts.usedIndex, first: .fts.rows[0]},
         like: {verb: .like.verb, usedIndex: .like.usedIndex, count: (.like.rows | length)}}'
#   fts:  verb SEARCH, usedIndex true   — ranked, snippeted, index-walked
#   like: verb SCAN,   usedIndex false  — every row read, substrings matched`,
        },
      ],
    },
    {
      id: 'db-node-races',
      title: 'Isolation levels, locking, and the check-then-act race',
      lead: 'The most common concurrency bug in a single-threaded runtime: SELECT the state, await something, then UPDATE — two requests interleave inside the gap and both act on the same stale read. SQL-standard isolation levels NAME the phenomena; the fix for this bug is smaller and better: put the guard INSIDE the write.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-races:check-then-act',
          body: `THE RACE, CONCRETELY. "Book the last ticket" as check-then-act: SELECT the stock, do some work (an external call, a cache hop — anything you AWAIT), then UPDATE stock = stock - 1 guarded by nothing. Two concurrent requests both read stock=1, both decide "there is room", both decrement — final stock -1, a ticket sold twice. The window is the await: better-sqlite3 calls are SYNCHRONOUS, so on one connection nothing interleaves — but the moment your handler awaits between the read and the write, the event loop runs OTHER work, and that other work includes the sibling request doing the same read. SINGLE-THREADED IS NOT RACE-FREE: Node removes parallel execution but not INTERLEAVING, and every await is a yield point. The reliability topic makes this the same lesson from the distributed side; here the database is the fix. ISOLATION LEVELS, the SQL-standard vocabulary in one breath: READ UNCOMMITTED sees other transactions' uncommitted writes (dirty reads — rarely offered today), READ COMMITTED (Postgres's default) sees only committed data but not the same row twice inside one transaction, REPEATABLE READ keeps one transaction's reads stable, and SERIALIZABLE makes concurrent transactions behave as if run one at a time — at the price of the engine aborting transactions that would violate it. The phenomena the ladder names (dirty read, non-repeatable read, phantom read, lost update) are worth knowing as vocabulary; in practice most application races are fixed not by cranking isolation to SERIALIZABLE but by making the contentious step ATOMIC. SQLITE'S REALITY, stated honestly: one writer at a time, always — writers serialize, and a deferred transaction that starts reading can fail to PROMOTE to a write lock mid-flight (SQLITE_BUSY) when another writer got there first. So when you truly must read-then-write across statements, take the write lock up front: BEGIN IMMEDIATE, which SQLite offers exactly for this (the better-sqlite3 equivalent is db.transaction with the immediate option). THE ATOMIC GUARDED UPDATE is the fix the demo runs, and it needs no lock ceremony at all: ONE statement — UPDATE inventory SET stock = stock - 1 WHERE item = ? AND stock > 0 — makes read-decide-write indivisible, because SQLite serializes writers, exactly one attempt can match the row while stock is still positive, and the loser observes changes === 0 and reports a clean 409 instead of a negative shelf. In SQL-standard terms this is OPTIMISTIC concurrency — no locks held, the write itself detects the conflict — and its sibling is guarding with a VERSION column (UPDATE … WHERE id = ? AND version = ?, same zero-changes signal, retry on conflict). PESSIMISTIC is the other family: take the lock first (SELECT … FOR UPDATE in Postgres) and hold it across the read and the write — the right tool when contention is high or the critical section is genuinely long, at the cost of waiting and of deadlocks. The decision rule this guide teaches: reach for the atomic guarded statement FIRST (it is one line, deadlock-free, and composes); use transactions + BEGIN IMMEDIATE when multiple rows must agree; reserve pessimistic locking for the measured hot spot.`,
        },
        {
          kind: 'code',
          id: 'db-node-races:verbatim-sql',
          language: 'ts',
          source: 'server/src/data/sql_depth/inventory_booking.ts',
          caption: 'Verbatim — the booking race\'s three statements (data/sql_depth/inventory_booking.ts): the unguarded decrement vs the guarded one',
          code: `export const SELECT_STOCK_SQL = 'SELECT stock FROM inventory WHERE item = ?';
export const NAIVE_DECREMENT_SQL = 'UPDATE inventory SET stock = stock - 1 WHERE item = ?';
export const SAFE_DECREMENT_SQL =
  'UPDATE inventory SET stock = stock - 1 WHERE item = ? AND stock > 0';`,
        },
        {
          kind: 'code',
          id: 'db-node-races:verbatim-booking',
          language: 'ts',
          source: 'server/src/data/sql_depth/inventory_booking.ts',
          caption: 'Verbatim — both implementations (same file): the deliberate await that opens the window, and the one-statement guard that closes it',
          code: `// naive — the window is REAL because it is awaited:
export async function bookNaive(
  db: Database.Database,
  item: string,
  delayMs = 50,
): Promise<BookingOutcome> {
  const row = db.prepare(SELECT_STOCK_SQL).get(item) as { stock: number } | undefined;
  // …the not-found 404, then the yield — any async work opens the window…
  await sleep(delayMs);
  db.prepare(NAIVE_DECREMENT_SQL).run(item);   // guards NOTHING: stock can go negative
  return {
    succeeded: true,
    stockObserved: row.stock,
    message: \`booked against a read of stock=\${row.stock} — by the time this wrote, that read was already stale\`,
  };
}

// safe — read-decide-write as ONE statement:
export function bookSafe(db: Database.Database, item: string): BookingOutcome {
  const result = db.prepare(SAFE_DECREMENT_SQL).run(item);
  if (result.changes === 1) {
    return {
      succeeded: true,
      rowsMatched: 1,
      message: 'booked — the stock > 0 guard and the decrement were one atomic statement',
    };
  }
  // …the not-found 404, then the guard's clean conflict:
  return {
    succeeded: false,
    failureKind: 'conflict',
    httpStatus: 409,
    rowsMatched: 0,
    message: \`sold out (stock=\${row.stock}) — the WHERE stock > 0 guard matched 0 rows, so this booking cleanly failed instead of overselling\`,
  };
}`,
        },
        {
          kind: 'demo',
          id: 'db-node-races:demo',
          demoId: 'db:race',
          title: 'The booking race: naive oversells, the guard 409s',
          description:
            'Pick a mode and fire N concurrent bookings at 1 ticket. Naive: every attempt read stock=1 before any write ran — the final stock goes negative and the oversold flag lights up (a 200 observation, because watching the bug IS the demo). Safe: the guarded UPDATE makes surplus attempts match 0 rows and fail cleanly with 409s — same concurrency, no oversell.',
        },
        {
          kind: 'code',
          id: 'db-node-races:curl',
          language: 'bash',
          caption: 'The race from a terminal — run it twice, one mode each',
          code: `# naive: 3 concurrent bookings against 1 ticket — stock ends at -2:
curl -s -X POST 'localhost:4000/api/demo/db/race?mode=naive&concurrency=3&stock=1' \\
  | jq '{mode, initialStock, successCount, finalStock, oversold}'

# safe: same 3 against the same 1 — one books, stock never below 0:
curl -s -X POST 'localhost:4000/api/demo/db/race?mode=safe&concurrency=3&stock=1' \\
  | jq '{mode, initialStock, successCount, finalStock, oversold}'
#   and the two losers report clean 409 conflicts — the guard matched 0 rows:
curl -s -X POST 'localhost:4000/api/demo/db/race?mode=safe&concurrency=3&stock=1' \\
  | jq '.attempts[] | {attempt, succeeded, httpStatus}'`,
        },
      ],
    },
    {
      id: 'db-node-audit-writes',
      title: 'Audit logging: the write-in-transaction trail',
      lead: 'An audit trail that can disagree with the data it describes is worse than no trail — a regulator reads it as evidence and it is wrong. The pattern is one rule: the trail row is written INSIDE the same transaction as the change it describes, so a row in audit_log exists if and only if its change committed.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-audit-writes:pattern',
          body: `WHAT THE TRAIL ROW CARRIES, and why each column: the ENTITY and its id (which table, which row — generic, so every table can share one trail), the ACTION (update here; insert/delete in the obvious extension), CHANGED_BY (the human or service identity — an audit row without an actor answers "what" but not "who", which is the question incident reviews actually ask), OLD_VALUES and NEW_VALUES as JSON snapshots of the changed columns (object literals in a FIXED key order, so the serialization is stable and diffs read cleanly), and a UTC ISO-8601 created_at minted ONCE per update and shared by both writes — the post row's updated_at and the trail row's created_at are the same instant, because they are the same event. THE TRANSACTION IS THE PATTERN: db.transaction() wraps the post UPDATE and the audit INSERT as one unit — commit both or neither — and the demo's crash flag proves it by throwing from BETWEEN the two writes on purpose: better-sqlite3 rolls back both, the post is unchanged, and no orphan audit row survives. That is the whole value proposition: without the transaction, a crash after the UPDATE leaves a changed row with no trail, and a crash after the INSERT leaves a trail describing a change that never happened — both are integrity failures, and the second is a lie in your compliance artifact. The schema topic's audit section covers the TABLE side (the audit_log migration and its (entity, entity_id) index — the "show me this row's history" read); this section owns the WRITE path. Two honest production notes: the snapshot columns grow with the row (cap what you snapshot — titles and statuses, not bodies and blobs), and the trail is APPEND-ONLY by policy if not by mechanism — an audit_log that can be UPDATEd is a suggestion, not a record.`,
        },
        {
          kind: 'code',
          id: 'db-node-audit-writes:verbatim-writer',
          language: 'ts',
          source: 'server/src/data/sql_depth/audit_writer.ts',
          caption: 'Verbatim — the audited update (data/sql_depth/audit_writer.ts): both writes, ONE transaction, the crash flag between them',
          code: `const UPDATE_POST_SQL = 'UPDATE posts SET title = ?, body = ?, updated_at = ? WHERE id = ?';
const INSERT_AUDIT_SQL = \`
  INSERT INTO audit_log (entity, entity_id, action, changed_by, old_values, new_values, created_at)
  VALUES (?, ?, 'update', ?, ?, ?, ?)
\`;

export function updatePostWithAudit(
  db: Database.Database,
  input: AuditedUpdateInput,
): AuditedUpdateResult | undefined {
  const updateWithAudit = db.transaction((): AuditedUpdateResult | undefined => {
    const before = db.prepare(SELECT_POST_SQL).get(input.postId) as PostRow | undefined;
    if (before === undefined) return undefined;

    const now = new Date().toISOString();        // ONE stamp, shared by both writes
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
}`,
        },
        {
          kind: 'demo',
          id: 'db-node-audit-writes:demo',
          demoId: 'db:audit',
          title: 'The transactional audit trail',
          description:
            'Update a post and watch its audit row land in the same transaction (before/after snapshots paired with who changed it), then flip the crash switch: the simulated crash hits between the post UPDATE and the audit INSERT, both roll back, and the response proves the post is unchanged with zero partial audit rows. The trail view reads the history oldest-first through the (entity, entity_id) index.',
        },
        {
          kind: 'code',
          id: 'db-node-audit-writes:curl',
          language: 'bash',
          caption: 'The audited update and its crash, from a terminal',
          code: `# an audited PATCH — one transaction, two writes, one shared timestamp:
curl -s -X PATCH 'localhost:4000/api/demo/db/audit/post' \\
  -H 'content-type: application/json' \\
  -d '{"title":"A retitled post","changedBy":"you"}' \\
  | jq '{updated, auditRowCount, last: .auditRows[-1] | {changedBy, newValues}}'

# now with the crash between the writes — BOTH roll back:
curl -s -X PATCH 'localhost:4000/api/demo/db/audit/post?crash=1' \\
  -H 'content-type: application/json' \\
  -d '{"title":"never lands","changedBy":"you"}' \\
  | jq '{crash, rolledBack, updated, auditRowCount}'

# the trail for one post, oldest first:
curl -s 'localhost:4000/api/demo/db/audit/post' | jq '.rows | length'`,
        },
      ],
    },
    {
      id: 'db-node-live',
      title: 'See it live',
      lead: 'Three real proofs over real in-memory handles: the migration runner\'s pending → applied → idempotent replay state machine, a parameterized lookup shrugging off the classic injection payload, and a transaction that crashes between its two writes and rolls back both.',
      blocks: [
        {
          kind: 'text',
          id: 'db-node-live:intro',
          body: `Every demo below runs against a FRESH :memory: SQLite handle built per request — the guide's real guide.db is never opened by these endpoints. THE MIGRATION DEMO drives the real runner from server/src/data/migrations: a fresh handle first shows all eight .sql files PENDING (applied is empty); APPLY runs them in name order, and the response carries before/after plus a SECOND run whose appliedThisRun is empty — the idempotency proof that lets boot call the runner unconditionally — alongside the tables and indexes the DDL actually created. THE INJECTION PANEL fires whatever payload you type (prefilled with the classic ' OR '1'='1) at a real parameterized lookup: the attempt is bound as the ? parameter, comes back echoed as boundParameter, and matches ZERO rows — while the response also displays the NAIVE concatenated query as inert text, the thing the parameterization made impossible. Type a real post title instead and it matches exactly that row: the lookup is real, the injection is not. THE TRANSACTION PANEL runs the tag move from the transactions section: TRANSFER commits both writes (the tag visibly moves from post-alpha to post-beta in the before/after counts); TRANSFER WITH CRASH throws between the DELETE and the INSERT on purpose, the endpoint catches it, and both writes roll back — before and after counts IDENTICAL, transferred: false, rolledBack: true, HTTP 200, because observing a rollback is the successful outcome of the experiment. The curl block drives all three from a terminal.`,
        },
        {
          kind: 'demo',
          id: 'db-node-live:migrations-demo',
          demoId: 'db:migrations',
          title: 'The migration runner',
          description:
            'A fresh demo handle, the real runner, and the full state machine: all eight .sql files pending, APPLY running them in order, and a second apply that does nothing — plus the tables and indexes each step really created.',
        },
        {
          kind: 'demo',
          id: 'db-node-live:safety-demo',
          demoId: 'db:sql-safety',
          title: 'Injection and atomicity',
          description:
            "Two proofs side by side: fire the classic SQL-injection payload at a parameterized lookup (zero rows, the naive form shown inert), and run the tag transfer with and without a crash between its two writes — crash rolls both back, and before/after counts prove atomicity.",
        },
        {
          kind: 'code',
          id: 'db-node-live:curl',
          language: 'bash',
          caption: 'All three demos, from a terminal (boot the server first: npm run dev in server/)',
          code: `# 1. migrations — pending first, then apply, then the idempotent replay:
curl -s localhost:4000/api/demo/db/migrations | jq '{applied, pending}'
#   {"applied":[],"pending":["0001_create_tags_tables.sql","0002_add_indexes.sql",
#     "0003_create_staff.sql","0004_add_staff_salary_index.sql","0005_create_posts_fts.sql",
#     "0006_create_inventory.sql","0007_create_audit_log.sql","0008_create_outbox.sql"]}
curl -s -X POST localhost:4000/api/demo/db/migrations/apply \\
  | jq '{appliedThisRun, secondRunApplied, after, tables, indexes}'

# 2. injection — the classic payload, bound as DATA (urlencoded):
curl -s "localhost:4000/api/demo/db/injection?attempt=%27%20OR%20%271%27%3D%271" \\
  | jq '{attempt, boundParameter, matchedCount, naiveQuery, verdict}'
#   matchedCount: 0 — and the endpoint 200s because nothing was injected

# 3. transactions — the happy move, then the crash that rolls both writes back:
curl -s -X POST localhost:4000/api/demo/db/transfer        | jq '{transferred, before, after}'
curl -s -X POST 'localhost:4000/api/demo/db/transfer?crash=1' \\
  | jq '{transferred, rolledBack, before, after, explain}'
#   crash: before == after — the DELETE was rolled back with the INSERT`,
        },
      ],
    },
  ],
};
