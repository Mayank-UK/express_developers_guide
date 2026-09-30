import type Database from 'better-sqlite3';
import { openMigratedDatabase } from '../migrations/migration_runner.js';
import { SEED_POSTS } from '../posts/seed_posts.js';

/**
 * The sql-depth demos' dedicated in-memory handle. The REAL migration runner
 * builds the schema (staff + seed, the salary index, posts + posts_fts +
 * sync triggers, inventory, audit_log), then posts are seeded here from the
 * shared SEED_POSTS constant — the guide's single source of post truth, so
 * the search and audit exhibits run against the same rows every other demo
 * shows. The staff dataset, by contrast, is migration-owned fixture data:
 * it exists on every migrated handle, demo or not.
 *
 * Nothing here ever touches data/guide.db — every request gets a fresh
 * :memory: database and closes it in the route's finally block.
 */

/** The inventory row the booking race contends for (seeded by migration 0006). */
export const DEMO_INVENTORY_ITEM = 'workshop-ticket';

const INSERT_SEED_POST = `
  INSERT INTO posts (id, title, body, author, created_at, updated_at)
  VALUES (@id, @title, @body, @author, @created_at, @updated_at)
`;

function seedPosts(db: Database.Database): void {
  const insertSeed = db.prepare(INSERT_SEED_POST);
  db.transaction((): void => {
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

export function openSqlDepthDatabase(): Database.Database {
  const db = openMigratedDatabase(':memory:');
  db.pragma('foreign_keys = ON');
  seedPosts(db);
  return db;
}
