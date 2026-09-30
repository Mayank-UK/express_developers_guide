import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyPendingMigrations,
  getMigrationState,
  MIGRATION_FILE_PATTERN,
  MigrationError,
  openMigratedDatabase,
  readMigrationFiles,
} from './migration_runner.js';

/**
 * The migration runner's lifecycle contract on ISOLATED databases — a fresh
 * ':memory:' handle per test, or a file under a mkdtemp tmp dir. Never the
 * real data/guide.db.
 *
 * Testability boundary (a property of the runner's design, documented here):
 * the migration SOURCE is the shared src/data/migrations directory, resolved
 * from import.meta.url — there is no seam for injecting a crafted migrations
 * dir or file list, because that dir IS the repo's real schema history. Two
 * deliberate consequences:
 *   1. Expectations are DERIVED from readMigrationFiles() instead of a
 *      hardcoded list — the dir is shared state that grows, and a newly
 *      appended numbered file must not turn this spec red.
 *   2. The partial-failure path cannot be provoked by injecting a bad file.
 *      It is provoked through the runner's real behavior instead: a trigger
 *      name that collides MID-FILE with 0005's third statement (its table and
 *      virtual table already exist by then), so the per-file transaction
 *      genuinely has partial work to roll back.
 */

/** The multi-statement file used for the mid-file rollback proof. Shared
 * state: if the FTS migration is ever renamed, update this constant. */
const FTS_MIGRATION = '0005_create_posts_fts.sql';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fileNames = (): string[] => readMigrationFiles().map((file) => file.name);

describe('readMigrationFiles', () => {
  it('discovers the shared migration files, ordered by filename', () => {
    const files = readMigrationFiles();

    expect(files.length).toBeGreaterThan(0);
    const names = files.map((file) => file.name);
    expect(names).toEqual([...names].sort()); // filename order IS apply order
    for (const file of files) {
      expect(file.name, file.name).toMatch(MIGRATION_FILE_PATTERN);
      expect(file.sql.trim().length, file.name).toBeGreaterThan(0);
    }
  });
});

describe('getMigrationState — fresh database', () => {
  it('reports everything as pending and nothing as applied', () => {
    const db = new Database(':memory:');

    const state = getMigrationState(db); // also bootstraps the schema_migrations table

    expect(state.applied).toEqual([]);
    expect(state.pending).toEqual(fileNames());
    expect(state.files).toEqual(fileNames());
    db.close();
  });
});

describe('applyPendingMigrations', () => {
  it('applies the whole history in filename order and records every step', () => {
    const db = new Database(':memory:');

    const applied = applyPendingMigrations(db);

    const names = fileNames();
    expect(applied).toEqual(names);
    const state = getMigrationState(db);
    expect(state.applied).toEqual(names);
    expect(state.pending).toEqual([]);

    // The RECORD is real rows, not just the returned diff: every applied name
    // sits in schema_migrations with a parseable timestamp.
    const rows = db
      .prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name')
      .all() as { name: string; applied_at: string }[];
    expect(rows.map((row) => row.name)).toEqual([...names].sort());
    for (const row of rows) {
      expect(Number.isNaN(new Date(row.applied_at).getTime()), row.name).toBe(false);
    }

    // And the DDL really ran: the base schema of the FIRST migration exists
    // (0001 is the append-only history's fixed foundation).
    const base = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'demo_posts'")
      .get() as { n: number };
    expect(base.n).toBe(1);

    db.close();
  });

  it('is a no-op on an up-to-date database (boot may call it unconditionally)', () => {
    const db = new Database(':memory:');
    applyPendingMigrations(db);

    expect(applyPendingMigrations(db)).toEqual([]);
    const state = getMigrationState(db);
    expect(state.applied).toEqual(fileNames());
    expect(state.pending).toEqual([]);

    db.close();
  });

  it('a mid-file failure rolls the WHOLE file back and surfaces a MigrationError', () => {
    const db = new Database(':memory:');
    // Sabotage: occupy the trigger name 0005 creates as its THIRD statement —
    // its posts table and posts_fts index already exist by then, so the
    // transaction has real partial work to undo when the trigger collides.
    db.exec(`
      CREATE TABLE sabotage_sink (payload TEXT);
      CREATE TRIGGER posts_fts_insert AFTER INSERT ON sabotage_sink BEGIN SELECT 1; END;
    `);

    const names = fileNames();
    const failingAt = names.indexOf(FTS_MIGRATION);
    expect(failingAt, `expected ${FTS_MIGRATION} in the shared dir`).toBeGreaterThan(0);

    let thrown: unknown;
    try {
      applyPendingMigrations(db);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MigrationError);
    const migrationError = thrown as MigrationError;
    expect(migrationError.name).toBe('MigrationError');
    expect(migrationError.message).toMatch(
      new RegExp(`migration "${FTS_MIGRATION}" failed and was rolled back`),
    );
    expect(migrationError.cause).toBeInstanceOf(Error);

    // NO half steps — earlier files STAY applied (one transaction per file)…
    const state = getMigrationState(db);
    expect(state.applied).toEqual(names.slice(0, failingAt));
    expect(state.pending).toEqual(names.slice(failingAt));
    // …the failed file left neither its record…
    const recorded = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?')
      .get(FTS_MIGRATION) as { n: number };
    expect(recorded.n).toBe(0);
    // …nor its DDL (the file's first statements ran, then rolled back with it).
    const leftover = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('posts', 'posts_fts')")
      .get() as { n: number };
    expect(leftover.n).toBe(0);

    // Recovery: with the collision gone, one rerun completes the history —
    // exactly the "boot calls it unconditionally" story after a crashed apply.
    db.exec('DROP TRIGGER posts_fts_insert');
    expect(applyPendingMigrations(db)).toEqual(names.slice(failingAt));
    expect(getMigrationState(db).pending).toEqual([]);
    const recovered = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('posts', 'posts_fts')")
      .get() as { n: number };
    expect(recovered.n).toBe(2);

    db.close();
  });
});

describe('openMigratedDatabase', () => {
  it('returns an open, fully migrated in-memory handle', () => {
    const db = openMigratedDatabase(':memory:');

    expect(db.open).toBe(true);
    expect(getMigrationState(db).pending).toEqual([]);
    db.close();
  });

  it('persists the history in the FILE — a reopened database is already at head', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'migration-runner-spec-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'guide.db');

    const first = openMigratedDatabase(dbPath);
    expect(first.open).toBe(true);
    expect(getMigrationState(first).applied).toEqual(fileNames());
    first.close();

    // A second handle (the "next process") finds the work done and applied
    // nothing on its own boot.
    const reopened = new Database(dbPath);
    const state = getMigrationState(reopened);
    expect(state.applied).toEqual(fileNames());
    expect(state.pending).toEqual([]);
    expect(applyPendingMigrations(reopened)).toEqual([]);
    reopened.close();
  });
});
