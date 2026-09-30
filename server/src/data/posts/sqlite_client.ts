import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appConfig } from '../../core/config/app_config.js';
import { SEED_POSTS } from './seed_posts.js';

/**
 * Lazy singleton sqlite handle. Nothing here opens a database until the first
 * repository call in live mode — fake-mode runs (and every test using them)
 * never pay for a connection. Under vitest appConfig.dbPath is ':memory:', so
 * tests can't touch a real file.
 */

const CREATE_POSTS_TABLE = `
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const INSERT_SEED_POST = `
  INSERT INTO posts (id, title, body, author, created_at, updated_at)
  VALUES (@id, @title, @body, @author, @created_at, @updated_at)
`;

function bootstrap(database: Database.Database): Database.Database {
  // Empty result = the table does not exist yet → this run is "just created"
  // and must seed. An existing table (restart with a persistent db file) keeps
  // its data untouched.
  const tableInfo = database.pragma('table_info(posts)') as unknown[];
  database.exec(CREATE_POSTS_TABLE);
  if (tableInfo.length === 0) {
    const insertSeed = database.prepare(INSERT_SEED_POST);
    database.transaction(() => {
      for (const post of SEED_POSTS) {
        insertSeed.run({
          id: post.id,
          title: post.title,
          body: post.body,
          author: post.author,
          created_at: post.createdAt,
          updated_at: post.updatedAt,
        });
      }
    })();
  }
  return database;
}

let db: Database.Database | undefined;

export function getSqlite(): Database.Database {
  db ??= bootstrap(openDatabase());
  return db;
}

/**
 * Graceful shutdown: close the singleton handle if it was ever opened and
 * drop it, so a later getSqlite() reopens fresh (a persistent db file keeps
 * its data — bootstrap only seeds a table it just created; a :memory: handle
 * starts empty and reseeds). Idempotent, safe when nothing ever connected —
 * the sqlite twin of closeRedis.
 */
export function closeSqlite(): void {
  // The handle drops even when close() itself throws (an open transaction,
  // say): like closeRedis, the slot is cleared unconditionally so the next
  // getSqlite() can never hand back a half-closed connection — the caller
  // (the shutdown drain) owns the failure.
  try {
    db?.close();
  } finally {
    db = undefined;
  }
}

function openDatabase(): Database.Database {
  // better-sqlite3 creates the db FILE but never its parent directory, and a
  // fresh checkout has no server/data/ — create it before opening (never for
  // the in-memory test database).
  if (appConfig.dbPath !== ':memory:') {
    mkdirSync(path.dirname(appConfig.dbPath), { recursive: true });
  }
  return new Database(appConfig.dbPath);
}
