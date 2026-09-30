import { describe, expect, it } from 'vitest';
import { closeSqlite, getSqlite } from './sqlite_client.js';
import { SEED_POSTS } from './seed_posts.js';

/**
 * The lazy singleton handle's lifecycle contract — the sqlite twin of
 * closeRedis's idempotent-shutdown behavior. Under vitest appConfig.dbPath is
 * ':memory:', so nothing here can touch a real file, and the bootstrap under
 * test is the same seeding a live boot runs.
 *
 * The handle is MODULE state, so the "never opened" case only exists before
 * the first getSqlite() of this worker — that test is first on purpose.
 */

describe('getSqlite/closeSqlite — the lazy singleton handle', () => {
  it('closeSqlite() does nothing (and does not throw) when the handle was never opened', () => {
    expect(() => closeSqlite()).not.toThrow(); // virgin module: db is undefined
  });

  it('getSqlite() opens lazily, seeds the posts table, and memoizes one handle', () => {
    const first = getSqlite();
    expect(first.open).toBe(true);

    const count = (first.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
    expect(count).toBe(SEED_POSTS.length); // the bootstrap seeded, not an empty shell

    expect(getSqlite()).toBe(first); // memoized: ONE handle per process
  });

  it('closeSqlite() closes the open handle, and a later getSqlite() reopens a WORKING fresh one', () => {
    const closed = getSqlite();
    closeSqlite();
    expect(closed.open).toBe(false);

    const fresh = getSqlite();
    expect(fresh).not.toBe(closed); // a genuinely new handle, not the memoized one
    expect(fresh.open).toBe(true);
    // …and it WORKS: the reopen bootstraps again — a :memory: database starts
    // empty, so the seed must land a second time for this query to answer.
    const count = (fresh.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
    expect(count).toBe(SEED_POSTS.length);
  });

  it('closeSqlite() is idempotent — a second close on the reopened handle is calm', () => {
    getSqlite(); // the previous test left a fresh handle memoized
    closeSqlite();
    expect(() => closeSqlite()).not.toThrow();
  });
});
