import type { Topic } from '../types.js';

/**
 * The SQL & schema design topic: concept-first relational modeling — tables,
 * keys, types and constraints, normalization and when to undo it, indexes,
 * and migrations as ordered history. Snippets marked verbatim are this app's
 * running source (or the live demo handle's real DDL); illustrative sketches
 * say so. The Node side (better-sqlite3, the DAO layer, the runner itself)
 * lives in the sql-node topic — this one designs the schema it runs on.
 */
export const topicSqlSchema: Topic = {
  id: 'sql-schema',
  title: 'SQL and Schema Design',
  subtitle:
    'Tables, keys, indexes, and normalization — designing a schema before reaching for an ORM.',
  group: 'data',
  order: 1,
  sections: [
    {
      id: 'db-schema-relational',
      title: 'Relational thinking',
      lead: 'A relational database is three ideas and everything else is consequence: data lives in TABLES of like ROWS, each row is identified by a KEY, and rows in different tables point at each other by those keys. Design a schema before you touch an ORM — the schema outlives every framework decision above it.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-relational:model',
          body: `THE MODEL, in one breath: a TABLE is a typed bag of ROWS (posts, comments, tags), every row of a table has the same COLUMNS, one column (or a few, rarely) is the PRIMARY KEY that names the row, and a column holding another table's key is a FOREIGN KEY — the "relation" that gives the model its name. THAT LAST IDEA is the whole trick: instead of nesting a list of comments inside a post document, you store comments in their OWN table, each carrying post_id — and "a post's comments" becomes a question you ASK (WHERE post_id = ?) instead of a shape you MAINTAIN. WHY THIS MODELS DURABLE STATE WELL: tables are SETS with identity and no order, so they survive every reshuffle of the code above them; relationships are VALUES (keys), so they can be validated, indexed, and traversed in any direction (post → comments today, comment → post tomorrow, no migration); and the whole thing is CONSTRAINT-DECLARATIVE — you state what must be true (every comment belongs to an existing post) and the engine enforces it on every write, in every code path, forever. Applications change their shapes every sprint; the relations underneath them change every few years.\n\nWHEN NOT TO REACH FOR A DATABASE — the honest half of the lesson. If the data is CONFIGURATION, a checked-in file beats a table (version control, code review, diffs are free). If it is EPHEMERAL by design — session state, rate-limit counters, a cache — a store like Redis (its own topic here) is the right shape: keys with TTLs, not rows with constraints. If it is a STREAM of events you append and never edit, a log file or a queue serves better than UPDATE-able rows. And if it is a handful of values read at boot, the filesystem IS a database. The test this guide applies: does the data need to SURVIVE a restart, be QUERIED by something other than the code that wrote it, and stay CONSISTENT under concurrent writers? Three yeses → a relational database. This guide's posts pipeline earns its table: it persists, the fake/live demos and the REST/GraphQL/gRPC surfaces all query it, and SQLite serializes the writers.`,
        },
        {
          kind: 'code',
          id: 'db-schema-relational:ddl-verbatim',
          language: 'sql',
          source: 'server/src/data/posts/sqlite_client.ts',
          caption: 'Verbatim — the real posts table this app runs (data/posts/sqlite_client.ts); the live demo below serves this exact shape plus a comments child table',
          code: `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,      -- surrogate key: a uuid minted by the app,
    title TEXT NOT NULL,      --   not derived from the data (next sections)
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL, -- ISO 8601 strings: sortable, debuggable,
    updated_at TEXT NOT NULL  --   and honest about SQLite's date story
)

-- Six columns, every one NOT NULL: a row either IS a complete post or it
-- does not exist. No nullable "maybe we never set this" columns anywhere.`,
        },
      ],
    },
    {
      id: 'db-schema-types',
      title: 'Types and constraints',
      lead: 'SQLite will happily store the string "banana" in a column declared INTEGER — type declarations are AFFINITY hints, not enforcement. Knowing what your database actually guarantees (and what it does not) is the difference between constraints-as-safety-net and constraints-as-theater.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-types:affinity',
          body: `SQLITE'S FLEXIBLE TYPING is the gotcha worth learning FIRST because it is the opposite of what Postgres and MySQL do. A column's declared type is an AFFINITY — a coercion preference, not a rule: declare a column REAL and insert the integer 5, it is stored as 5.0; declare TEXT and insert 42, it comes back as the STRING '42'; declare a bare "DATETIME" (not a real SQLite type name) and you get NUMERIC affinity, where '2026-01-01' stays text but '123' silently becomes the number 123. The classic REAL-affinity trap: money in a REAL column — 0.1 is not representable in binary floating point, so 0.1 + 0.2 = 0.30000000000000004, and SUM() over a million such rows drifts. This is why this guide stores money-adjacent values as INTEGER cents (or TEXT) in SQLite and leaves REAL for measurements where epsilon is fine. POSTGRES AND MYSQL are STRICT: insert 'banana' into an INTEGER column and the write FAILS — the type is a contract, and a schema ported from SQLite's leniency to Postgres's enforcement is where the differences surface (usually as suddenly-failing inserts that were silently coercing for years). The portable habit: pick types as if the engine were strict, so the schema means the same thing everywhere.\n\nCONSTRAINTS are the schema's last line of defense, and the word LAST is doing work: in this app validation lives in the USE CASE (the PostsUseCase rejects an empty title with a typed 400 before any SQL runs) — the constraint exists for everything validation cannot see, the bug deployed at 2am, the migration script with a typo, the second service writing to the same database. NOT NULL (every column of posts carries it above) kills the billion-dollar mistake of nullable-everything. UNIQUE rejects duplicates at the only layer that sees ALL writers (this guide's tags.name is UNIQUE — two processes can race past an application-level check; they cannot race past the index). CHECK states a row-level invariant in the data's own language — length(body) > 0 on the demo comments table below. DEFAULT fills values the writer forgot (comments.created_at defaults to strftime('now') — the DATABASE knows the time, ask it). And a PRIMARY KEY is the constraint family's keystone: not just unique, but the row's identity, discussed next.`,
        },
        {
          kind: 'code',
          id: 'db-schema-types:affinity-transcript',
          language: 'txt',
          caption: 'Illustrative — a sqlite3 CLI session showing affinity behavior you can reproduce against any SQLite database (including this guide\'s demo handle)',
          code: `sqlite> CREATE TABLE demo (n INTEGER, r REAL, t TEXT, d DATETIME);
sqlite> INSERT INTO demo VALUES (42, 5, 42, '123'), ('banana', 0.1, 3.14, '2026-01-01');

sqlite> SELECT typeof(n), typeof(r), typeof(t), typeof(d) FROM demo;
text|real|text|integer        -- row 1: INTEGER column took 'banana' AS TEXT,
                              --   d's NUMERIC affinity coerced '123' → 123!
text|real|text|text           -- row 2: t's TEXT affinity turned 3.14 into '3.14'

sqlite> SELECT SUM(x) FROM (SELECT 0.1 AS x UNION ALL SELECT 0.2);
0.30000000000000004           -- REAL arithmetic is binary floating point:
                              --   money belongs in INTEGER cents or TEXT

-- The same writes against Postgres:
--   ERROR: invalid input syntax for type integer: "banana"
--   (the write FAILS — a strict type is a contract, an affinity is a hint)`,
        },
      ],
    },
    {
      id: 'db-schema-keys',
      title: 'Primary and foreign keys',
      lead: 'Two decisions shape every query you will ever write against a table: what IDENTIFIES a row, and how rows in other tables POINT at it. This repo picks a TEXT uuid surrogate for posts and a FK with ON DELETE CASCADE for comments — and SQLite adds a plot twist you must know: foreign keys ship OFF.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-keys:choices',
          body: `SURROGATE VS NATURAL KEYS. A NATURAL key is identity derived from the data — a username, an email, an ISBN. It feels elegant and occasionally IS right (immutable, unique, meaningful — country codes), but the failures are famous: emails CHANGE (and now every FK in the system cascades), usernames get recycled, ISBNs get reprinted with corrections. A SURROGATE key is identity the system mints and the data does not care about — this repo's posts.id is a TEXT uuid (crypto.randomUUID() in the repository), which is why the seeded ids look like 0f1c2b3a-0000-4000-8000-000000000001. The tradeoffs, honestly: surrogates are STABLE (rename a post, the id — and every FK, and every cached URL — survives), MEANINGLESS (they leak nothing, join indifferently), and UNIVERSAL (every table gets the same story); natural keys save a join and a column when they genuinely never change — rare enough that the default posture is surrogate + a UNIQUE constraint on any natural identifier that matters. SQLite's one bonus rule: INTEGER PRIMARY KEY is the table's ROWID ALIAS — the fastest possible key in the engine, which is why the demo comments table (below, live) uses it while posts, which mints ids in application code, uses TEXT.\n\nFOREIGN KEYS make the relation REAL instead of aspirational: comments.post_id TEXT NOT NULL REFERENCES posts(id) is the database PROMISING that no comment row exists without its post. The ON DELETE clause is a policy decision you are making for future-you: CASCADE deletes the comments with their post (comments ARE the post's, in every sense — this guide's choice), SET NULL orphans them deliberately (only with a nullable FK — contradicts the NOT NULL above), RESTRICT/NO ACTION refuse the delete until the children are gone (the conservative default when children outlive parents — think users and their invoices). ONE REAL SQLITE TRAP, the kind that eats an afternoon: SQLite ships FOREIGN KEY ENFORCEMENT OFF, PER CONNECTION. The REFERENCES clause sits happily in the DDL doing NOTHING until a connection runs PRAGMA foreign_keys = ON — you can insert a comment for a post that does not exist and SQLite will not blink. (Postgres and MySQL enforce FKs always; SQLite makes it opt-in because enforcement costs a little on every write and the library refuses to spend it unasked.) This guide's demo handle turns the PRAGMA on and the live explorer below reports it — the habit to copy: enable it on EVERY connection, the moment you open it.`,
        },
        {
          kind: 'code',
          id: 'db-schema-keys:comments-ddl',
          language: 'sql',
          source: 'server/src/presentation/routes/db_demo_routes.ts',
          caption: 'Verbatim — the demo handle\'s comments table (served live by the schema explorer below): a child table done by the book, plus the PRAGMA every connection needs',
          code: `CREATE TABLE comments (   -- the demo handle's DDL, quoted from the
    id INTEGER PRIMARY KEY,            -- TS template literals that build it;
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,   -- the relation, made real
    author TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(body) > 0),  -- a row-level invariant
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))  -- ask the clock here
)

-- the FK's read side: "a post's comments" is THE query this table exists
-- for, so its access path gets an index (the indexes section explains why).
-- In the real file the index is one line, assigned to a constant:
const CREATE_COMMENTS_INDEX = 'CREATE INDEX idx_comments_post_id ON comments(post_id)';

-- The per-connection switch — run it on EVERY open, or the REFERENCES
-- clause above is decoration (better-sqlite3 spells the PRAGMA as a method):
db.pragma('foreign_keys = ON');`,
        },
      ],
    },
    {
      id: 'db-schema-normalization',
      title: 'Normalization, then denormalization',
      lead: 'Normalization is one question asked three times: does this column describe the KEY of its table — the whole key, and nothing but the key? Ask it once per schema and you get to third normal form without memorizing a single numbered rule. Then, deliberately and on purpose, undo a little of it for reads.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-normalization:pass',
          body: `THE PRAGMATIC PASS. 1NF — atomic values, no lists hiding in columns: not tags='sql,node,express' but a posts_tags table (the demo migrations in the next topic build exactly that many-to-many). 2NF/3NF in practice collapse into ONE question per column: WHICH row does this fact describe? post_title in a comments table describes the POST, not the comment — it belongs in posts, and the comment carries post_id instead. That question, asked honestly about every column, gets you to 3NF: every table is facts about its own key, and nothing else. WHY IT PAYS: no contradictions (a title changed in one place is changed everywhere, because it EXISTS in one place), no deletion surprises (deleting a comment cannot take the post's title with it), and every future query has a home (comment→post, post→comments, both directions, no re-shaping). THE posts→comments SKETCH IS THE WHOLE CURRICULUM IN MINIATURE: a spreadsheet would repeat the post's title and author on every comment row — normalize, and the comment keeps exactly the facts about comments (author, body, created_at) plus the KEY of the post it belongs to.\n\nDENORMALIZATION, the deliberate undo. Normalized schemas are WRITE-easy and READ-sometimes-expensive: "the post with its comment COUNT" is a JOIN + GROUP BY every time, and a front page runs it per request. The mature move is to normalize FIRST (you cannot denormalize your way back to correctness from a mess), measure where reads actually hurt, then DENORMALIZE the measured spot: a comment_count column on posts maintained in the same transaction as the comment insert, or a materialized "recent comments with post titles" table refreshed on write. The costs are exactly the normalization benefits, spent knowingly: every denormalized copy is WRITE-TIME BOOKKEEPING (a second thing to update, atomically — this is what transactions are for, next topic), an eventual-consistency surface (or a bigger transaction), and a bug magnet when the copy drifts from the truth. The rule this guide teaches: denormalize a QUERY you can name, after you can prove it hurts — never speculatively.`,
        },
        {
          kind: 'code',
          id: 'db-schema-normalization:sketch',
          language: 'txt',
          caption: 'Illustrative — one spreadsheet, normalized to the posts + comments (+ tags) shape the live demo serves',
          code: `THE SPREADSHEET (before — everything in one flat sheet):
┌────────────────────────────┬──────────────┬──────────────────────────────┐
│ post_title                 │ comment      │ tags (a LIST in a column!    │
│                            │ author       │       three sins in one cell)│
├────────────────────────────┼──────────────┼──────────────────────────────┤
│ Layers keep concerns apart │ a reader     │ sql,node,express            │
│ Layers keep concerns apart │ another      │ sql,node,express   ← repeated│
│ The dependency rule, …     │ a third      │ architecture                │
└────────────────────────────┴──────────────┴──────────────────────────────┘
Sins: the post's title repeats (rename = N edits, they WILL diverge);
a comment row cannot exist without dragging its post along; a comment
carrying tag list is a fact about the POST stored on the COMMENT.

NORMALIZED (after — each table is facts about its own key):
posts(id PK, title, body, author, created_at, updated_at)
comments(id PK, post_id FK → posts.id ON DELETE CASCADE, author, body, created_at)
tags(id PK, name UNIQUE)                      ┐ the list cell becomes a
posts_tags(post_id FK, tag_id FK, PRIMARY KEY(post_id, tag_id)) ┘ many-to-many

"the post's comments"  → SELECT … FROM comments WHERE post_id = ?
"a post's tags"        → posts JOIN posts_tags JOIN tags
rename the post        → UPDATE posts — ONE row, and every comment sees it`,
        },
      ],
    },
    {
      id: 'db-schema-indexes',
      title: 'Indexes',
      lead: 'An index is a sorted copy of part of your table, kept sorted on every write, so lookups go from O(n) page-reads to O(log n). That sentence is also the entire tradeoff: reads get fast, writes get more expensive, and the only question is which columns deserve the copies.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-indexes:mechanics',
          body: `WHAT AN INDEX IS: a B-TREE keyed on the indexed column(s), whose leaves point at the table's rows — a phone book for your table. Look up by indexed column and SQLite descends a small balanced tree (a million-row table is ~3 hops) instead of scanning every page; SQLite's plan verb for that is SEARCH, and the verb for reading the whole table is SCAN. WHEN TO ADD ONE — the query-shaped test: columns in WHERE equality clauses (comments.post_id — "a post's comments"), columns driving JOINs (both FK sides; the child's FK column especially, since joins filter on it), and columns in ORDER BY when you sort more than you write. COMPOSITE INDEXES follow leftmost-prefix order: index (post_id, created_at) serves WHERE post_id = ? AND WHERE post_id = ? ORDER BY created_at — but NOT a WHERE on created_at alone; column order is a design decision, most-selective-first is the usual heuristic. A COVERING INDEX adds the SELECT's columns so the query never touches the table at all (its plan says USING COVERING INDEX — SQLite even promotes indexes to covering automatically when it can). THE WRITE COST, stated without flinching: every index is a second (third, fourth…) sorted structure updated on every INSERT/UPDATE of its columns — the tags demo adds two indexes and pays for them on every tag write. Indexes also cost SPACE and they make the OPTIMIZER's job harder in numbers. So the discipline this guide practices: index for the queries you can NAME (the demo names two and shows their plans live), measure before adding the speculative fifth, and remember the automatic ones — every PRIMARY KEY and UNIQUE constraint IS an index, which is why UNIQUE rejects duplicates atomically: the check is a tree lookup.\n\nREADING EXPLAIN QUERY PLAN is the skill this section exists to teach — it is how you SEE indexes working instead of believing in them. The demo panel below runs EXPLAIN QUERY PLAN on the demo handle: the indexed preset filters comments by post_id and the plan answers "SEARCH comments USING INDEX idx_comments_post_id" — tree descent, done. The scan preset filters by body (no index there) and the plan answers "SCAN comments" — every row read, every time, at every scale. Same table, same query shape, one indexed column apart. The habit: paste your real query, read the verb, and treat a SCAN on a hot path as a question — either the path deserves an index, or the query deserves a rewrite.`,
        },
        {
          kind: 'code',
          id: 'db-schema-indexes:plans-verbatim',
          language: 'txt',
          caption: 'Verbatim — the two plans the live demo below serves from the demo handle (EXPLAIN QUERY PLAN, the only honest way to argue about indexes)',
          code: `-- Preset 1 — indexed lookup: filter on the column that carries a tree:
sqlite> EXPLAIN QUERY PLAN SELECT id, body FROM comments WHERE post_id = '0f1c…0001';
┌──┬────────────────────────────────────────────────────────────┐
│id│detail                                                      │
├──┼────────────────────────────────────────────────────────────┤
│3 │SEARCH comments USING INDEX idx_comments_post_id (post_id=?)│
└──┴────────────────────────────────────────────────────────────┘
   SEARCH = descend the b-tree, touch ~log(n) pages, read matching rows.

-- Preset 2 — full scan: same table, same shape, but body has NO index:
sqlite> EXPLAIN QUERY PLAN SELECT id, body FROM comments WHERE body LIKE '%rule%';
┌──┬────────────────────┐
│id│detail              │
├──┼────────────────────┤
│3 │SCAN comments       │
└──┴────────────────────┘
   SCAN = read EVERY row, always — fine at 6 rows, a page-storm at 6 million.`,
        },
        {
          kind: 'demo',
          id: 'db-schema-indexes:explorer-demo',
          demoId: 'db:schema-explorer',
          title: 'The schema explorer',
          description:
            'Live introspection of the demo handle: posts + comments with columns/constraints, index badges (origin: explicit, unique, or pk), the FK with its ON DELETE CASCADE, and a query-plan panel contrasting an indexed SEARCH with a full SCAN via EXPLAIN QUERY PLAN.',
        },
      ],
    },
    {
      id: 'db-schema-migrations',
      title: 'Migrations as schema history',
      lead: 'A schema is not a file you edit — it is a HISTORY you append to. The database sitting on disk is the sum of ordered steps, every deployed instance has run a prefix of that history, and the artifacts that track it (numbered files + a table recording which ran) are simple enough to build yourself. This guide did, and the next topic runs it live.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-migrations:history',
          body: `THE RULES FIRST. Schema changes are APPEND-ONLY steps in a fixed ORDER: numbered files, applied in name order, each applied AT MOST ONCE per database — this guide's migration directory holds eight today (0001_create_tags_tables.sql through 0008_create_outbox.sql: the tags many-to-many, its indexes, the staff dataset, a salary index, posts full-text search, an inventory, an audit log, and a transactional outbox), and the next topic quotes the first two verbatim. An applied migration is FROZEN — you never edit history, because every deployed database already ran it; a fix is a NEW numbered file (0009_…) that repairs what 0008 got wrong, exactly like a git commit you amend by adding a commit, never by rewriting the old one. UP AND DOWN, the fuller form: each step ships an up (apply) and a down (revert) so a deployment can roll back its schema with the same discipline it rolls back code — in practice downs are written for the risky early steps and skipped for destructive ones (no honest DOWN for DROP TABLE that lost data). THE MIGRATION TABLE is the whole bookkeeping trick: one table, schema_migrations, holding the names of applied steps; boot asks "which files are not in the table?", applies exactly those, IN ORDER, EACH INSIDE A TRANSACTION that also records its own name — so a power cut mid-step leaves either the whole step or none of it, never half. That is the pattern Knex, Sequelize, and Prisma migrate all ship; it is also ~60 lines of TypeScript, which is why this guide's real runner (next topic, and the live demo) is hand-rolled and readable end to end — you should run migrations you can read.\n\nWHY NEVER EDIT IN PLACE, made concrete: your laptop's database has 0001…0005 applied; production has 0001…0003. Edit 0002's file and nothing happens anywhere (both databases recorded it under its old meaning), while a FRESH checkout gets your edited 0002 and a schema that matches NO existing database — three databases, three schemas, one codebase pretending they agree. Append 0009 instead and every instance converges on the same history by running its own missing prefix. The demo in the next topic shows exactly this: a fresh handle reports all eight files PENDING, one apply runs them in order, and a second apply does NOTHING — idempotent boot, which is what lets startup code run the runner unconditionally.`,
        },
        {
          kind: 'code',
          id: 'db-schema-migrations:pattern',
          language: 'ts',
          source: 'server/src/data/migrations/migration_runner.ts',
          caption: 'The pattern in miniature — abridged from the REAL runner at server/src/data/migrations/migration_runner.ts (built out in the SQL with Node topic; the live demo there runs it)',
          code: `// The bookkeeping table — the database's own record of its history:
const CREATE_MIGRATIONS_TABLE = \`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,     // the file name, e.g. '0002_add_indexes.sql'
    applied_at TEXT NOT NULL
  )
\`;

// The runner's core loop, abridged to its honest minimum:
for (const file of readMigrationFiles()) {        // 0001…0008, in name order
  // …the already-applied COUNT check, abridged…
  if (already.n > 0) continue;                    // idempotent: skip history
  try {
    db.transaction((): void => {                  // DDL + record commit TOGETHER
      db.exec(file.sql);
      record.run(file.name, new Date().toISOString());
    })();                                         // a throw rolls back BOTH
  } catch (cause) {
    // …rethrown as a typed MigrationError naming the failed file…
  }
}

// Boot then becomes one unconditional call — fresh databases run everything,
// up-to-date databases run nothing, crashed ones resume at their prefix.`,
        },
      ],
    },
    {
      id: 'db-schema-uuid-strategy',
      title: 'Key strategy: UUIDv7 vs sequential',
      lead: 'Random UUIDv4 keys are unique everywhere and scatter like confetti inside a B-tree — every insert lands in a random page, the index fragments, the cache misses. UUIDv7 (RFC 9562) puts a timestamp in the front: same uniqueness, but keys arrive roughly sorted, so indexes APPEND instead of shuffling. Sequential integers do that too — the trade is who can mint them.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-uuid-strategy:trade',
          body: `THE THREE OPTIONS, honestly. SEQUENTIAL INTEGER keys (this guide's comments table) are the engine's favorite: INTEGER PRIMARY KEY is SQLite's rowid alias — the fastest possible key, perfectly ordered inserts, tiny. The costs are operational, not technical: ids are guessable (an enumerator walks /orders/101, /orders/102 — mitigate with a second public slug, never by obfuscating), and minting them across MULTIPLE writers needs coordination — the classic "get the next id" race is exactly why AUTOINCREMENT/IDENTITY columns exist (the database IS the coordinator). UUIDV4 (this guide's posts table today) is 122 random bits: mintable by anyone, anywhere, with no coordination and no central authority — two offline clients can each create rows that merge later without a collision ceremony. The cost is the scatter: a B-tree index over random keys has every insert land in a RANDOM page — page splits, fragmentation, cold pages constantly faulting into the buffer pool as the table grows. At thousands of rows nobody notices; at hundreds of millions it is real money. UUIDV7 is the reconciliation: a 48-bit unix-millisecond timestamp prefix + a per-millisecond monotonic counter + random bits (62 here). Ids minted in sequence compare in sequence lexicographically — EVEN within one millisecond, because of the counter — so inserts append to the right edge of the index like sequential keys, while remaining globally mintable with zero coordination like v4. You keep v4's "any node can mint", you gain v-sequential's locality. THE HONEST CAVEATS: v7 ids leak their CREATION TIME (usually acceptable; sometimes a business problem — bid timestamps, user signup order), and they are still bigger than a 64-bit integer (16 bytes, TEXT here), so every FK and every index entry carries the width. THE COUNTER'S EDGE CASES are where hand-rolling earns its keep: if the counter passes its 12-bit ceiling inside one millisecond it borrows the next millisecond and reseeds low (ids stay ordered AND unique), and if the clock steps BACKWARDS the generator keeps using the highest timestamp seen — never emit out-of-order ids to protect a broken clock. And the whole module is safe under Node's single-threaded event loop precisely because uuidV7() contains no await: the read-increment-write of the counter cannot interleave (the concurrency section of the SQL with Node topic is the full story of that sentence). The decision rule this guide teaches: internal, single-writer tables → integer; anything minted in distributed places or exposed in URLs → v7; v4 only where you truly cannot order (rare, and usually a legacy default).`,
        },
        {
          kind: 'code',
          id: 'db-schema-uuid-strategy:verbatim-layout',
          language: 'ts',
          source: 'server/src/data/sql_depth/uuid_v7.ts',
          caption: 'Verbatim — the RFC 9562 ordering argument, from the header of the real generator (data/sql_depth/uuid_v7.ts)',
          code: ` * The counter is RFC 9562's "monotonic random" method: seeded randomly at
 * each new millisecond, then incremented for every further id minted in that
 * same millisecond. Result: ids generated in sequence ALWAYS compare in
 * sequence lexicographically — even within one millisecond — which v4 (122
 * random bits) never does. That orderliness is why v7 is the key strategy of
 * choice for B-tree-backed stores: appends instead of random-insert scatters.`,
        },
        {
          kind: 'code',
          id: 'db-schema-uuid-strategy:verbatim-mint',
          language: 'ts',
          source: 'server/src/data/sql_depth/uuid_v7.ts',
          caption: "Verbatim — the mint itself, abridged (same file): timestamp floor, monotonic-clock guard, the per-ms counter, and the version/variant bits",
          code: `export function uuidV7(timestampMs: number = Date.now()): string {
  // …the range guard on the 48-bit ms field…
  let ts = Math.floor(timestampMs);
  if (ts < lastTimestampMs) {
    ts = lastTimestampMs; // clock stepped backwards — stay monotonic
  }
  if (ts > lastTimestampMs) {
    lastTimestampMs = ts;
    counterWithinMs = randomInt(0, RAND_A_MAX + 1);   // new ms: reseed the counter
  } else {
    counterWithinMs += 1;
    if (counterWithinMs > RAND_A_MAX) {
      // Counter overflow — borrow the next millisecond and reseed low.
      lastTimestampMs += 1;
      ts = lastTimestampMs;
      counterWithinMs = randomInt(0, 16);
    }
  }

  const bytes = randomBytes(16);

  bytes[0] = (ts / 2 ** 40) & 0xff;
  // …bytes 1-5: the rest of the 48-bit timestamp, same shape…
  bytes[6] = 0x70 | (counterWithinMs >> 8); // version 7 + counter's high 4 bits
  bytes[7] = counterWithinMs & 0xff; // counter's low 8 bits
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10 + rand_b's top 6 bits

  const hex = bytes.toString('hex');
  return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(12, 16)}-\${hex.slice(16, 20)}-\${hex.slice(20)}\`;
}`,
        },
        {
          kind: 'demo',
          id: 'db-schema-uuid-strategy:demo',
          demoId: 'db:uuid',
          title: 'v4 vs v7: watch the sort decide',
          description:
            'Mint a batch of each and compare them three ways: as generated, sorted, and the sortsAsGenerated verdict. v7 batches come back already in generation order (the timestamp prefix plus the per-ms counter); v4 batches sort into a random shuffle that matches nothing. The explain line names the B-tree consequence: appends vs scatter.',
        },
        {
          kind: 'code',
          id: 'db-schema-uuid-strategy:curl',
          language: 'bash',
          caption: 'The key-strategy comparison from a terminal',
          code: `curl -s 'localhost:4000/api/demo/db/uuid?count=12' \\
  | jq '{v4: .v4.sortsAsGenerated, v7: .v7.sortsAsGenerated}'
#   { "v4": false, "v7": true }   — v7 ids compare in mint order, v4 do not`,
        },
      ],
    },
    {
      id: 'db-schema-audit-pattern',
      title: 'Audit logging as a schema pattern',
      lead: 'Who changed what, when — as a TABLE, not a log file. One generic audit_log row per change, JSON before/after snapshots, and an index for the one query it exists to serve: "show me this row\'s history". The schema is the easy half; the discipline is writing the row in the same transaction as the change.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-audit-pattern:table',
          body: `WHY A TABLE AND NOT A LOG LINE: application logs tell you what the SERVER did; an audit table tells you what HAPPENED TO THE DATA — and it lives next to the data, queryable with SQL, joinable to it, and inside the same transaction boundary. The shape this guide runs is deliberately GENERIC: entity + entity_id (which table, which row) instead of one audit table per business table — every table in the app can share one trail, and "everything that happened to THIS row across tables" is one query instead of a UNION per table. action records the verb (update; insert/delete in the obvious extension), changed_by records the ACTOR — the human or service identity, the column incident reviews exist for. old_values/new_values are JSON TEXT snapshots of the changed columns rather than a column-per-field explosion: schemas evolve, and a trail whose shape breaks on every migration is a trail you stop trusting. created_at is the UTC ISO-8601 TEXT stamp this guide uses everywhere (sortable, debuggable, honest about SQLite's date story). THE ONE INDEX is (entity, entity_id) — the "show me this row's history" read the trail exists for; a trail you cannot cheaply query per row is a write-only archive, which is a compliance cost with no investigative payoff. THE WRITE-PATH DISCIPLINE, in one sentence because the SQL with Node topic owns the demonstration: the trail row is written INSIDE THE SAME TRANSACTION as the change it describes, so a row in audit_log exists if and only if its change committed — this guide's db:audit demo (in that topic's sections) runs the audited update with a crash flag between the two writes and watches both roll back together. Two schema-level policy notes: the trail is APPEND-ONLY (no UPDATE grants, no delete path — see the security topic's PII section for the retention tension that creates), and the trail itself becomes PII-adjacent the moment old_values snapshot personal data, so retention policy must cover it explicitly.`,
        },
        {
          kind: 'code',
          id: 'db-schema-audit-pattern:verbatim-migration',
          language: 'sql',
          source: 'server/src/data/migrations/0007_create_audit_log.sql',
          caption: 'Verbatim — the real audit-log migration (data/migrations/0007_create_audit_log.sql): generic trail table + the history index',
          code: `CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  old_values TEXT NOT NULL,
  new_values TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);`,
        },
      ],
    },
    {
      id: 'db-schema-live',
      title: 'The schema endpoints from a terminal',
      lead: 'The terminal companion to the schema explorer (now in the Indexes section above): the posts table this guide runs plus a comments child table with a foreign key, a CHECK, a DEFAULT, and an explicit index — introspected live from sqlite_master and SQLite\'s own PRAGMAs — and the query-plan endpoints that show SEARCH vs SCAN, replayed here from a terminal.',
      blocks: [
        {
          kind: 'text',
          id: 'db-schema-live:intro',
          body: `The explorer (in the Indexes section above) introspects a DEDICATED in-memory SQLite handle (never the guide's real guide.db — the demo builds its own, seeded with the real posts). Everything it renders comes from SQLite itself: tables and their DDL from sqlite_master, columns and nullability and defaults from PRAGMA table_info, indexes and their origin (explicit 'c', UNIQUE 'u', primary-key 'pk') from PRAGMA index_list + index_info, foreign keys with their ON DELETE policy from PRAGMA foreign_key_list, and live row counts. Read the COMMENTS card against everything above: the INTEGER PRIMARY KEY rowid alias, the post_id FK with CASCADE, the CHECK on body, the strftime DEFAULT, and idx_comments_post_id — then compare it with the POSTS card's automatic pk-origin index. The FK ENFORCEMENT chip reports the per-connection PRAGMA state this topic warned about — ON here, because the demo handle turns it on when it opens. The query-plan endpoints run EXPLAIN QUERY PLAN against the same handle: INDEXED LOOKUP filters by post_id (SEARCH … USING INDEX — tree descent) and FULL SCAN filters by body (SCAN — every row); the preset reads the plan so you do not have to, and a custom single SELECT is accepted (validated: SELECT-only, no semicolons — it is a read-only demo handle). The curl block below replays both endpoints from a terminal.`,
        },
        {
          kind: 'code',
          id: 'db-schema-live:curl',
          language: 'bash',
          caption: 'The same explorer and plans, from a terminal (boot the server first: npm run dev in server/)',
          code: `# the schema: tables, columns, constraints, indexes, FKs, row counts
curl -s localhost:4000/api/demo/db/schema | jq '.tables[].name'
#   ["posts", "comments"]

# the comments table's foreign key, straight from SQLite's own pragma:
curl -s localhost:4000/api/demo/db/schema \\
  | jq '.tables[] | select(.name=="comments") | .foreignKeys'
#   [{"referencesTable":"posts","column":"post_id","referencesColumn":"id",
#     "onDelete":"CASCADE","onUpdate":"NO ACTION"}]

# the two plans — SEARCH via the index vs SCAN without one:
curl -s 'localhost:4000/api/demo/db/plan?preset=indexed' | jq '.steps, .verb'
curl -s 'localhost:4000/api/demo/db/plan?preset=scan'     | jq '.steps, .verb'

# a custom single SELECT (validated read-only; semicolons are rejected):
curl -s 'localhost:4000/api/demo/db/plan?sql=SELECT%20id%20FROM%20posts%20WHERE%20author%20=%20%27the%20guide%27' \\
  | jq '{sql, steps, usedIndex}'`,
        },
      ],
    },
  ],
};
