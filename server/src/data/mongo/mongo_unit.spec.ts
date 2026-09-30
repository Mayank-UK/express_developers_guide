import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appConfig } from '../../core/config/app_config.js';
import { describeMongoTarget, getMongoConnection, isMongoConfigured } from './mongo_client.js';
import { buildEventModel, EVENT_KINDS, EVENT_TTL_SECONDS, EventSchema } from './event_model.js';
import { clearEvents, eventStats, listEvents, recordEvent } from './event_repository.js';

/**
 * The one lever the failed-connect spec needs: appConfig is Object.freeze'd,
 * so flipping the feature on for one spec requires a module-level seam. The
 * mocked config keeps every other value 100% real (spread off the actual
 * module) — only `mongoUri` reads through to the spec's mutable holder.
 * Default '' is exactly the real default-suite world, so every other spec in
 * this file is unaffected.
 */
const specConfig = vi.hoisted(() => ({ mongoUri: '' }));
vi.mock('../../core/config/app_config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/config/app_config.js')>();
  return {
    ...actual,
    appConfig: Object.freeze({
      ...actual.appConfig,
      get mongoUri(): string {
        return specConfig.mongoUri;
      },
    }),
  };
});

/**
 * ALWAYS-RUN unit specs (no server, no network): the EventSchema validation
 * matrix is proven OFFLINE — mongoose validators run client-side in the
 * driver, so compiling the model on a never-connected connection and calling
 * validateSync() exercises exactly the code that guards every save.
 *
 * The repository-off specs describe the suite's default world (MONGO_URI
 * forced '' under test unless MONGO_TEST_URI opts in) and are therefore
 * skipped only in the MONGO_TEST_URI run, where the live-connection specs in
 * presentation/routes/mongo_demo_routes.spec.ts take over.
 */

/** A connection object that never connects — models validate fine offline. */
const offlineConnection = mongoose.createConnection();
const OfflineEvent = buildEventModel(offlineConnection);

/**
 * Runs the document's validators and COLLECTS the ValidationError instead of
 * letting it throw (undefined when the document is valid). doc.validate() is
 * used rather than the deprecated validateSync() — both run fully offline.
 */
async function collectValidation(
  input: Record<string, unknown>,
): Promise<mongoose.Error.ValidationError | undefined> {
  try {
    await new OfflineEvent(input).validate();
    return undefined;
  } catch (err) {
    if (err instanceof mongoose.Error.ValidationError) return err;
    throw err;
  }
}

describe('EventSchema — the offline validation matrix', () => {
  it('accepts a well-formed event and defaults meta to a fresh object', async () => {
    const doc = new OfflineEvent({ kind: 'visit', page: '/topics/mongodb', visitor: 'v-1' });
    // validate() resolves undefined when every validator passes.
    await expect(doc.validate()).resolves.toBeUndefined();

    // Mixed default via factory: present, an object, and not shared with the
    // schema or any other document.
    expect(doc.meta).toEqual({});
    const other = new OfflineEvent({ kind: 'visit', page: '/x', visitor: 'v-2' });
    other.meta = { nested: true };
    expect(doc.meta).toEqual({}); // untouched by the sibling's mutation
  });

  it('missing required fields → one field detail per missing path', async () => {
    const error = await collectValidation({});
    expect(error).toBeDefined();
    const fields = Object.keys(error?.errors ?? {});
    expect(fields).toEqual(expect.arrayContaining(['kind', 'page', 'visitor']));
    expect(fields).toHaveLength(3);
    expect(error?.errors.page?.message).toBe('Path `page` is required.');
  });

  it('a bad enum value → the kind field names the rejected value and path', async () => {
    const error = await collectValidation({ kind: 'scroll', page: '/x', visitor: 'v' });
    expect(error?.errors.kind).toBeDefined();
    expect(error?.errors.kind?.message).toBe('`scroll` is not a valid enum value for path `kind`.');
    // page/visitor were fine: the error is scoped to the enum field alone.
    expect(Object.keys(error?.errors ?? {})).toEqual(['kind']);
  });

  it('meta is Mixed: any BSON-able shape passes without schema friction', async () => {
    const shapes = [
      { duration: 42, tags: ['a', 'b'] },
      ['an', 'array'],
      'a plain string',
      7,
      null,
    ];
    for (const meta of shapes) {
      expect(await collectValidation({ kind: 'custom', page: '/x', visitor: 'v', meta })).toBeUndefined();
    }
  });

  it('declares the compound page+createdAt index and the TTL index', () => {
    const indexes = EventSchema.indexes() as [
      Record<string, unknown>,
      Record<string, unknown>,
    ][];
    const definitions = indexes.map(([keys]) => JSON.stringify(keys));

    expect(definitions).toContain(JSON.stringify({ page: 1, createdAt: -1 }));
    expect(definitions).toContain(JSON.stringify({ createdAt: 1 }));

    const ttl = indexes.find(([keys]) => 'createdAt' in keys && Object.keys(keys).length === 1);
    expect(ttl?.[1]?.expireAfterSeconds).toBe(EVENT_TTL_SECONDS);
    expect(EVENT_TTL_SECONDS).toBe(60);
  });

  it('exposes exactly the four demo kinds', () => {
    expect(EVENT_KINDS).toEqual(['visit', 'click', 'error', 'custom']);
  });
});

describe.skipIf(process.env.MONGO_TEST_URI !== undefined)(
  'repository with the feature off (MONGO_URI is empty — the default test world)',
  () => {
    it('config reports the feature off', () => {
      expect(appConfig.mongoUri).toBe('');
      expect(isMongoConfigured()).toBe(false);
    });

    it('every repository call returns an unavailable failure — without attempting a connection', async () => {
      const started = Date.now();

      const results = await Promise.all([
        recordEvent({ kind: 'visit', page: '/x', visitor: 'v' }),
        listEvents({ limit: 10 }),
        eventStats(),
        clearEvents(),
      ]);

      // Sub-second answers prove no 1.5s server-selection timeout was burned:
      // the off path never creates a mongoose object at all.
      expect(Date.now() - started).toBeLessThan(1000);

      for (const result of results) {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('unavailable');
        expect(result.error.message).toContain('docker compose');
      }
    });
  },
);

describe('describeMongoTarget — host/db only, never credentials', () => {
  it('strips userinfo from a credential-bearing URI', () => {
    const label = describeMongoTarget('mongodb://akira:s3cret@mongo.internal:27017/events?replicaSet=r');
    expect(label).toBe('mongo.internal:27017/events');
    expect(label).not.toContain('akira');
    expect(label).not.toContain('s3cret');
  });

  it('returns the host/db label for the plain dev URI and empty for empty', () => {
    expect(describeMongoTarget('mongodb://127.0.0.1:27017/express_guide_dev')).toBe(
      '127.0.0.1:27017/express_guide_dev',
    );
    expect(describeMongoTarget('')).toBe('');
  });

  it('degrades honestly on an unparseable URI instead of throwing', () => {
    expect(describeMongoTarget('not a uri')).toBe('(unparseable MONGO_URI)');
  });
});

describe('getMongoConnection — a failed attempt is torn down, not abandoned', () => {
  afterEach(() => {
    specConfig.mongoUri = ''; // every other spec sees the default '' world again
    vi.restoreAllMocks();
  });

  it('destroy()s the half-open connection and does not cache the failure (the mongo twin of the redis client catch-path disconnect)', async () => {
    specConfig.mongoUri = 'mongodb://spec-unreachable:27017/guide';
    const destroy = vi.fn().mockResolvedValue(undefined);
    const failing = Object.assign(new EventEmitter(), {
      asPromise: () => Promise.reject(new Error('Server selection timed out after 1500 ms')),
      destroy,
    });
    const createConnection = vi
      .spyOn(mongoose, 'createConnection')
      .mockReturnValue(failing as unknown as mongoose.Connection);

    await expect(getMongoConnection()).resolves.toBe(null);

    // Fail-fast options intact, and the failed handshake's topology/timers were
    // destroyed with force — not left for GC to find after serverSelectionTimeout.
    expect(createConnection).toHaveBeenCalledWith('mongodb://spec-unreachable:27017/guide', {
      serverSelectionTimeoutMS: 1500,
    });
    expect(destroy).toHaveBeenCalledWith(true);

    // The failure was NOT cached: a second call re-attempts (and re-tears-down)
    // — booting the service later recovers the demo without a restart.
    await expect(getMongoConnection()).resolves.toBe(null);
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
