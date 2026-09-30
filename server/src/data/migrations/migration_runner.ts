import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * A real (teaching-sized) migration runner — the "schema as ordered history"
 * pattern in ~60 honest lines, powering the sql-node topic's live demo.
 *
 * The pattern, deliberately the same one Knex/Sequelize/Prisma migrate ship:
 *   1. ordered, append-only .sql files live beside this runner;
 *   2. a schema_migrations table records which ones have been applied;
 *   3. boot applies the pending files in order, each inside a transaction,
 *      and records its name — so a crashed apply leaves NO half steps.
 *
 * The runner is data-layer code (it owns database bootstrap), and the demo
 * routes that demonstrate it are its ONLY consumer — the one deliberate
 * presentation→data teaching exception in this repo, because the runner IS
 * the artifact being taught (same spirit as the routing topic serving its
 * own route catalog).
 */

/** Migration file names: exactly four digits, a slug, .sql — sorted = order. */
export const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Where the .sql files live. tsc does not copy .sql files into dist/, so the
 * runner resolves from import.meta.url — under tsx/vitest the files sit in
 * the SAME directory as this module; under compiled dist/ (where the sibling
 * directory holds only .js output) it falls back to the repository's src/
 * copy. Never resolved from cwd: the runner must work from any working dir.
 */
const MIGRATIONS_DIR_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL('.', import.meta.url)),
  fileURLToPath(new URL('../../../src/data/migrations/', import.meta.url)),
];

export interface MigrationFile {
  /** File name including the order prefix — the identity recorded on apply. */
  readonly name: string;
  readonly sql: string;
}

export interface MigrationState {
  /** Applied migration names, in file order. */
  readonly applied: readonly string[];
  /** Files on disk not yet applied, in file order. */
  readonly pending: readonly string[];
  /** Every migration file found on disk, in file order. */
  readonly files: readonly string[];
}

/** One failed migration, rolled back — surfaced to the caller, never swallowed. */
export class MigrationError extends Error {
  constructor(
    readonly name: string,
    readonly cause: unknown,
  ) {
    super(`migration "${name}" failed and was rolled back: ${String(cause)}`);
    this.name = 'MigrationError';
  }
}

function resolveMigrationsDir(): string {
  for (const candidate of MIGRATIONS_DIR_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    const hasSql = readdirSync(candidate).some((entry) => MIGRATION_FILE_PATTERN.test(entry));
    if (hasSql) return candidate;
  }
  throw new Error(
    `migration runner: no directory with ${MIGRATION_FILE_PATTERN.source} files among [${MIGRATIONS_DIR_CANDIDATES.join(', ')}]`,
  );
}

/** Reads every migration file from disk, in name (= order) order. */
export function readMigrationFiles(): readonly MigrationFile[] {
  const dir = resolveMigrationsDir();
  return readdirSync(dir)
    .filter((entry) => MIGRATION_FILE_PATTERN.test(entry))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`;

const SELECT_APPLIED = 'SELECT name FROM schema_migrations';
const RECORD_APPLIED = 'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)';

/**
 * Snapshot of a database's migration state. Ensures the schema_migrations
 * table exists (creating it is idempotent), then diffs disk files against it.
 */
export function getMigrationState(db: Database.Database): MigrationState {
  db.exec(CREATE_MIGRATIONS_TABLE);
  const files = readMigrationFiles().map((file) => file.name);
  const appliedOnDisk = new Set(
    (db.prepare(SELECT_APPLIED).all() as { name: string }[]).map((row) => row.name),
  );
  return {
    applied: files.filter((name) => appliedOnDisk.has(name)),
    pending: files.filter((name) => !appliedOnDisk.has(name)),
    files,
  };
}

/**
 * Applies every pending migration, one file per transaction: a file's DDL and
 * its schema_migrations record commit TOGETHER or not at all. Running it on
 * an up-to-date database applies nothing — boot can call it unconditionally.
 */
export function applyPendingMigrations(db: Database.Database): readonly string[] {
  db.exec(CREATE_MIGRATIONS_TABLE);
  const record = db.prepare(RECORD_APPLIED);
  const appliedThisRun: string[] = [];

  for (const file of readMigrationFiles()) {
    const already = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?')
      .get(file.name) as { n: number };
    if (already.n > 0) continue;

    try {
      db.transaction((): void => {
        db.exec(file.sql);
        record.run(file.name, new Date().toISOString());
      })();
    } catch (cause) {
      // better-sqlite3 rolls the transaction back on throw; rethrow typed so
      // callers (and the demo) can show WHICH step failed.
      throw new MigrationError(file.name, cause);
    }
    appliedThisRun.push(file.name);
  }

  return appliedThisRun;
}

/**
 * Opens a sqlite handle (injectable path — ':memory:' for demos and tests)
 * and migrates it to head before returning. The file case mirrors the real
 * sqlite_client: the parent directory is created first, because better-sqlite3
 * creates the database FILE but never its parent directory.
 */
export function openMigratedDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  try {
    applyPendingMigrations(db);
  } catch (cause) {
    db.close();
    throw cause;
  }
  return db;
}
