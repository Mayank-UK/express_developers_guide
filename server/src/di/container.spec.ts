import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scenarioStore } from '../core/scenario/scenario.js';
import { closeSqlite } from '../data/posts/sqlite_client.js';
import { SEED_POSTS } from '../data/posts/seed_posts.js';
import type { Post } from '../domain/posts/post.js';
import { UUID_RE } from '../test_support/index.js';
import { getContainer, resetContainer } from './container.js';

/**
 * The composition root's wiring contract — grown from the original
 * memoization-only spec: the full member matrix, the fake/live repository
 * switch, and what a resetContainer() rebuild does (and deliberately does
 * NOT) rebuild.
 *
 * Reset discipline (mirrors posts_routes.spec.ts): hermetic scenario defaults
 * per test, and after every test the memoized container is dropped, the
 * scenario store is reset, and the sqlite singleton is closed — so a
 * live-mode test's ':memory:' database never bleeds into the next test or
 * another spec. Under vitest appConfig.dbPath is ':memory:', so no test here
 * can touch a real file.
 */

beforeEach(() => {
  // Hermetic defaults regardless of ambient SCENARIO_* environment values.
  scenarioStore.set({ dataMode: 'fake', injectFailure: false });
});

afterEach(() => {
  resetContainer();
  scenarioStore.reset();
  closeSqlite();
});

/** Mirrors the repositories' list order: createdAt DESC, then id DESC. */
function byListOrder(a: Post, b: Post): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

const seedIdsInListOrder = [...SEED_POSTS].sort(byListOrder).map((post) => post.id);

describe('getContainer', () => {
  it('is a memoized singleton until reset', () => {
    const first = getContainer();
    expect(getContainer()).toBe(first);

    resetContainer();
    expect(getContainer()).not.toBe(first);
  });

  it('resolves every member of the wiring matrix', () => {
    const container = getContainer();

    expect(Object.keys(container).sort()).toEqual(
      ['contentService', 'demoService', 'emailService', 'postsUseCase', 'scenarioStore'].sort(),
    );
    for (const member of Object.values(container)) {
      expect(member).toBeDefined();
    }
  });

  it('exposes the LIVE scenario store itself, not a snapshot of its state', () => {
    const container = getContainer();

    expect(container.scenarioStore).toBe(scenarioStore);
    expect(container.scenarioStore.get()).toEqual({ dataMode: 'fake', injectFailure: false });
  });

  it('wires demoService to the scenario store — status reflects the CURRENT state', async () => {
    scenarioStore.set({ injectFailure: true });
    const injected = await getContainer().demoService.status();
    expect(injected.ok).toBe(false);
    if (!injected.ok) expect(injected.error.kind).toBe('unavailable');

    scenarioStore.set({ injectFailure: false });
    const healthy = await getContainer().demoService.status();
    expect(healthy.ok).toBe(true);
    if (healthy.ok) {
      expect(healthy.value).toMatchObject({
        app: 'express_developers_guide',
        scenario: { dataMode: 'fake', injectFailure: false },
      });
      expect(healthy.value.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('wires contentService to the real topic registry', () => {
    const { contentService } = getContainer();

    const list = contentService.listTopics();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.topics.length).toBeGreaterThan(0);
      const firstId = list.value.topics[0].id;
      const detail = contentService.getTopic(firstId);
      expect(detail.ok).toBe(true);
      if (detail.ok) expect(detail.value.id).toBe(firstId);
    }
  });

  it('wires emailService to a working transport (jsonTransport — no network)', async () => {
    const result = await getContainer().emailService.send({
      to: 'reader@example.com',
      subject: 'container wiring check',
      text: 'sent by the container spec through the composition root',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messageId).toMatch(/@/);
      expect(result.value.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe('container — fake mode (default)', () => {
  it('postsUseCase serves the seeded fake repository', async () => {
    const result = await getContainer().postsUseCase.list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((post) => post.id)).toEqual(seedIdsInListOrder);
    }
  });

  it('creates through the fake repository and reads the post back by id', async () => {
    const { postsUseCase } = getContainer();

    const created = await postsUseCase.create({
      title: 'Fake-mode post',
      body: 'Created against the in-memory repository.',
      author: 'vitest',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.id).toMatch(UUID_RE);

    const byId = await postsUseCase.getById(created.value.id);
    expect(byId.ok).toBe(true);
    if (byId.ok) expect(byId.value.title).toBe('Fake-mode post');
  });
});

describe('container — the fake/live switch', () => {
  it('toggling dataMode to live swaps postsUseCase onto the sqlite repository', async () => {
    const { postsUseCase } = getContainer();

    // A post that must exist ONLY in the fake repository's state.
    const fakeOnly = await postsUseCase.create({
      title: 'Fake-only marker',
      body: 'Never visible in live mode.',
      author: 'vitest',
    });
    expect(fakeOnly.ok).toBe(true);

    scenarioStore.set({ dataMode: 'live' });

    // Live mode answers from sqlite (:memory: under test), bootstrapped with
    // the SAME seed posts — and the fake-only marker is not there.
    const liveList = await postsUseCase.list();
    expect(liveList.ok).toBe(true);
    if (liveList.ok && fakeOnly.ok) {
      const liveIds = liveList.value.map((post) => post.id);
      expect(liveIds).toEqual(seedIdsInListOrder);
      expect(liveIds).not.toContain(fakeOnly.value.id);
    }

    // Create/read works through sqlite…
    const liveOnly = await postsUseCase.create({
      title: 'Live-only marker',
      body: 'Never visible in fake mode.',
      author: 'vitest',
    });
    expect(liveOnly.ok).toBe(true);
    if (!liveOnly.ok) return;
    expect(liveOnly.value.id).toMatch(UUID_RE);
    const liveRead = await postsUseCase.getById(liveOnly.value.id);
    expect(liveRead.ok).toBe(true);
    if (liveRead.ok) expect(liveRead.value.title).toBe('Live-only marker');

    // …and switching back seals fake mode off from the live state again.
    scenarioStore.set({ dataMode: 'fake' });
    const backInFake = await postsUseCase.getById(liveOnly.value.id);
    expect(backInFake.ok).toBe(false);
    if (!backInFake.ok) expect(backInFake.error.kind).toBe('not_found');
    const fakeList = await postsUseCase.list();
    expect(fakeList.ok).toBe(true);
    if (fakeList.ok && fakeOnly.ok) {
      const fakeIds = fakeList.value.map((post) => post.id);
      expect(fakeIds).toContain(fakeOnly.value.id);
      expect(fakeIds).not.toContain(liveOnly.value.id);
    }
  });
});

describe('resetContainer', () => {
  it('rebuilds the wiring fresh — repositories reborn, the shared scenario store survives', async () => {
    const first = getContainer();
    const created = await first.postsUseCase.create({
      title: 'Dies with the reset',
      body: 'The next container rebuilds from the seed.',
      author: 'vitest',
    });
    expect(created.ok).toBe(true);

    resetContainer();
    const second = getContainer();

    expect(second).not.toBe(first);
    // The scenario store is a module singleton shared across rebuilds — new
    // wiring reads the store's CURRENT state, never a stale copy of it.
    expect(second.scenarioStore).toBe(first.scenarioStore);

    const list = await second.postsUseCase.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      // The fake repository was reborn from the seed: the created post is gone.
      expect(list.value.map((post) => post.id)).toEqual(seedIdsInListOrder);
    }
  });
});
