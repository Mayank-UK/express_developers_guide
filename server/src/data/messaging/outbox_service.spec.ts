import { describe, expect, it } from 'vitest';
import {
  closeOutboxDatabase,
  getOutboxDatabase,
  resetOutboxDatabase,
  runRelay,
} from './outbox_service.js';
import { SEED_POSTS } from '../posts/seed_posts.js';

/**
 * The outbox exhibit's lifecycle + concurrency units (the HTTP surface lives
 * in presentation/routes/messaging_demo_routes.spec.ts): the shutdown closer's
 * idempotence and the relay's single-flight guard.
 *
 * Redis-optional by design: the single-flight proof works in BOTH worlds,
 * because the guard fires synchronously — before runRelay's first await — so
 * a second call made before the first settles takes the early return whether
 * the winner then relays live (REDIS_TEST_URI set) or degrades to the
 * canonical unavailable failure (the default suite). No timer races.
 */

describe('closeOutboxDatabase', () => {
  it('closes without throwing when the demo handle was never opened', () => {
    // Virgin module per spec file (each runs in its own worker): demoDb is
    // undefined, so this must be the plain no-op, like closeRedis.
    expect(() => closeOutboxDatabase()).not.toThrow();
  });

  it('closes an open handle; the next getOutboxDatabase() reopens fresh', () => {
    const open = getOutboxDatabase();
    closeOutboxDatabase();
    expect(open.open).toBe(false);

    const reopened = getOutboxDatabase();
    expect(reopened).not.toBe(open);
    expect(reopened.open).toBe(true);
    // The reopen is a full bootstrap: migrated schema plus the seed posts.
    const count = (reopened.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
    expect(count).toBe(SEED_POSTS.length); // the shared seed, via the sql-depth factory
  });
});

describe('runRelay single-flight', () => {
  it('a pass launched while one is in flight returns early and ships nothing', async () => {
    resetOutboxDatabase(); // no due rows: even a live-redis winner ships nothing

    // Two concurrent passes, no awaits between the calls: the first sets the
    // in-flight flag synchronously, so the second must take the early return.
    const first = runRelay(getOutboxDatabase());
    const second = runRelay(getOutboxDatabase());
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // The loser reports the overlap instead of racing the winner's rows.
    expect(secondResult.ok).toBe(true);
    if (secondResult.ok) {
      expect(secondResult.value.published).toEqual([]);
      expect(secondResult.value.failedRetries).toEqual([]);
      expect(secondResult.value.crashedAfterPublish).toBeNull();
      expect(secondResult.value.note).toContain('in flight');
    }

    // The winner ran the real body — unavailable in the default suite (no
    // redis), a dry run under REDIS_TEST_URI — either way NOT the early return.
    const winnerNote = firstResult.ok ? firstResult.value.note : firstResult.error.message;
    expect(winnerNote).not.toContain('in flight');

    // The guard RELEASES when the pass settles: a later call runs the body
    // again rather than the early return (unavailable or dry, per the world).
    const third = await runRelay(getOutboxDatabase());
    const thirdNote = third.ok ? third.value.note : third.error.message;
    expect(thirdNote).not.toContain('in flight');
  });
});
