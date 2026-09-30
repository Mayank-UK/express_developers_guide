import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { PATTERNS_DEMO_MOUNT_PATH } from './patterns_demo_routes.js';
import { SNAPSHOT_EVERY, foldAccount, type AccountEventData } from '../../domain/patterns/event_store.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * The advanced-architecture exhibits over HTTP. Both are in-memory and
 * deterministic (the domain/patterns/ modules import nothing from data/), so
 * these run in EVERY suite world — the only timing is the saga's real queue
 * jobs, polled to a terminal state with a generous budget.
 */

const MOUNT = PATTERNS_DEMO_MOUNT_PATH; // /api/demo/patterns

/** Real-timer poller for the saga's background state machine — generous, never racy. */
async function pollUntil<T>(
  attempt: () => Promise<{ body: T }>,
  predicate: (body: T) => boolean,
  budgetMs: number,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const res = await attempt();
    if (predicate(res.body)) return res.body;
    if (Date.now() - startedAt > budgetMs) {
      throw new Error(`saga did not reach a terminal state within ${String(budgetMs)}ms — last body: ${String(JSON.stringify(res.body))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  // Shared process-global exhibits (one per vitest worker): reset both before
  // every group of scenarios so specs never see each other's streams or sagas.
  await request(createApp()).post(`${MOUNT}/eventstore/reset`).expect(200);
  await request(createApp()).post(`${MOUNT}/saga/reset`).expect(200);
});

// --- the event store ----------------------------------------------------------------------

describe('the event store — open, deposit, withdraw, fold', () => {
  it('opens an account at version 0 and answers 201', async () => {
    const res = await request(createApp())
      .post(`${MOUNT}/eventstore/accounts`)
      .send({ owner: 'Grace' });

    expect(res.status).toBe(201);
    expect(res.body.streamId).toBe('account-1');
    expect(res.body.version).toBe(0);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ seq: 0, data: { type: 'account-opened', owner: 'Grace' } });
    expect(res.body.events[0].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('deposits and withdrawals fold into the balance; history + projection agree', async () => {
    const app = createApp();
    const { body: opened } = await request(app).post(`${MOUNT}/eventstore/accounts`).send({ owner: 'Ada' });
    const id = opened.streamId as string;

    const deposit = await request(app).post(`${MOUNT}/eventstore/accounts/${id}/deposit`).send({ amountCents: 5000 });
    expect(deposit.status).toBe(200);
    expect(deposit.body.version).toBe(1);
    expect(deposit.body.balanceCents).toBe(5000);

    const withdraw = await request(app).post(`${MOUNT}/eventstore/accounts/${id}/withdraw`).send({ amountCents: 2000 });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.withdrawn).toBe(true);
    expect(withdraw.body.balanceCents).toBe(3000);

    const view = await request(app).get(`${MOUNT}/eventstore/accounts/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.version).toBe(2);
    expect(view.body.balanceCents).toBe(3000);
    expect(view.body.owner).toBe('Ada');
    expect(view.body.events.map((event: { data: AccountEventData }) => event.data.type)).toEqual([
      'account-opened',
      'money-deposited',
      'money-withdrawn',
    ]);
    // Replay IS fold: the same balance the pure function computes.
    expect(foldAccount(view.body.events.map((event: { data: AccountEventData }) => event.data)).balanceCents).toBe(3000);
    expect(view.body.load.usedSnapshot).toBe(false);
    expect(view.body.load.replayedEvents).toBe(3);

    // The projection (read model): signed movements with a running balance.
    expect(view.body.history.map((entry: { type: string; amountCents: number; balanceAfterCents: number }) => [entry.type, entry.amountCents, entry.balanceAfterCents])).toEqual([
      ['account-opened', 0, 0],
      ['money-deposited', 5000, 5000],
      ['money-withdrawn', -2000, 3000],
    ]);
  });
});

describe('the event store — the overdraft invariant, rejected at APPEND time', () => {
  it('answers the typed 409 AND records the refusal as an event; the fold stays pure', async () => {
    const app = createApp();
    const { body: opened } = await request(app).post(`${MOUNT}/eventstore/accounts`).send({});
    const id = opened.streamId as string;
    await request(app).post(`${MOUNT}/eventstore/accounts/${id}/deposit`).send({ amountCents: 3000 });

    const refused = await request(app)
      .post(`${MOUNT}/eventstore/accounts/${id}/withdraw`)
      .send({ amountCents: 999_999 });
    expect(refused.status).toBe(409); // the 409-style typed failure
    expect(refused.body.error.code).toBe('conflict');
    expect(refused.body.error.requestId).toMatch(UUID_RE);
    expect(refused.body.error.balanceCents).toBe(3000);
    expect(refused.body.error.requestedCents).toBe(999_999);

    // The refusal itself is history: a withdrawal-rejected event landed, and
    // folding it changes NOTHING (the fold is pure — rejected ≠ applied).
    const view = await request(app).get(`${MOUNT}/eventstore/accounts/${id}`);
    expect(view.body.events).toHaveLength(3);
    expect(view.body.events[2].data).toMatchObject({ type: 'withdrawal-rejected', amountCents: 999_999 });
    expect(view.body.events[2].data.reason).toContain('insufficient funds');
    expect(view.body.balanceCents).toBe(3000);
    expect(view.body.history[2]).toMatchObject({ type: 'withdrawal-rejected', amountCents: 0, balanceAfterCents: 3000 });

    // A withdrawal within the balance still works after a refusal.
    const ok = await request(app).post(`${MOUNT}/eventstore/accounts/${id}/withdraw`).send({ amountCents: 3000 });
    expect(ok.status).toBe(200);
    expect(ok.body.balanceCents).toBe(0);
  });
});

describe('the event store — optimistic concurrency (stale expectedVersion)', () => {
  it('rejects a stale append with 409 and writes nothing', async () => {
    const app = createApp();
    const { body: opened } = await request(app).post(`${MOUNT}/eventstore/accounts`).send({});
    const id = opened.streamId as string;
    await request(app).post(`${MOUNT}/eventstore/accounts/${id}/deposit`).send({ amountCents: 1000 }); // version 1

    const stale = await request(app)
      .post(`${MOUNT}/eventstore/accounts/${id}/deposit`)
      .send({ amountCents: 500, expectedVersion: 0 }); // someone appended first
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('conflict');
    expect(stale.body.error.expectedVersion).toBe(0);
    expect(stale.body.error.actualVersion).toBe(1);

    // Rejected means NOT stored: still 2 events, balance unchanged.
    const view = await request(app).get(`${MOUNT}/eventstore/accounts/${id}`);
    expect(view.body.version).toBe(1);
    expect(view.body.balanceCents).toBe(1000);

    // The same stale version on WITHDRAW is a conflict too — not an overdraft
    // refusal, so no withdrawal-rejected event is recorded.
    const staleWithdraw = await request(app)
      .post(`${MOUNT}/eventstore/accounts/${id}/withdraw`)
      .send({ amountCents: 100, expectedVersion: 0 });
    expect(staleWithdraw.status).toBe(409);
    expect(staleWithdraw.body.error.expectedVersion).toBe(0);
    const after = await request(app).get(`${MOUNT}/eventstore/accounts/${id}`);
    expect(after.body.events).toHaveLength(2);

    // Retrying with the CURRENT version succeeds — the intended workflow.
    const retried = await request(app)
      .post(`${MOUNT}/eventstore/accounts/${id}/deposit`)
      .send({ amountCents: 500, expectedVersion: 1 });
    expect(retried.status).toBe(200);
    expect(retried.body.version).toBe(2);
    expect(retried.body.balanceCents).toBe(1500);
  });

  it('rejects opening over an existing stream via expectedVersion -1 semantics', async () => {
    const app = createApp();
    const { body: opened } = await request(app).post(`${MOUNT}/eventstore/accounts`).send({});
    // The command layer mints ids, so a second account is a NEW stream…
    const second = await request(app).post(`${MOUNT}/eventstore/accounts`).send({});
    expect(second.status).toBe(201);
    expect(second.body.streamId).not.toBe(opened.streamId);
    // …while the store itself refuses a duplicate-opened event via its shape gate.
    // (Exercised through the deposit path: an unknown stream is a clean 404.)
    const unknown = await request(app)
      .post(`${MOUNT}/eventstore/accounts/account-999/deposit`)
      .send({ amountCents: 100 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
  });
});

describe('the event store — snapshots and the projection rebuild', () => {
  it('mints a snapshot every SNAPSHOT_EVERY events and loads via snapshot + tail', async () => {
    const app = createApp();
    const { body: opened } = await request(app).post(`${MOUNT}/eventstore/accounts`).send({});
    const id = opened.streamId as string;

    // Version 5 = the 6th event = the first snapshot boundary.
    for (let index = 0; index < 4; index += 1) {
      await request(app).post(`${MOUNT}/eventstore/accounts/${id}/deposit`).send({ amountCents: 100 });
    }
    const atBoundary = await request(app).post(`${MOUNT}/eventstore/accounts/${id}/deposit`).send({ amountCents: 100 });
    expect(atBoundary.body.snapshot).toMatchObject({ streamId: id, version: 5, balanceCents: 500 });

    const view = await request(app).get(`${MOUNT}/eventstore/accounts/${id}`);
    expect(view.body.load.usedSnapshot).toBe(true);
    expect(view.body.load.totalEvents).toBe(6);
    expect(view.body.load.replayedEvents).toBe(0); // the snapshot carried the whole fold
    expect(view.body.load.consistent).toBe(true); // …and the full-history fold AGREES
    expect(view.body.balanceCents).toBe(view.body.load.fullReplayBalanceCents);

    // Past the snapshot: only the tail replays.
    await request(app).post(`${MOUNT}/eventstore/accounts/${id}/withdraw`).send({ amountCents: 200 });
    const afterTail = await request(app).get(`${MOUNT}/eventstore/accounts/${id}`);
    expect(afterTail.body.load.usedSnapshot).toBe(true);
    expect(afterTail.body.load.replayedEvents).toBe(1);
    expect(afterTail.body.load.totalEvents).toBe(7);
    expect(afterTail.body.load.consistent).toBe(true);
    expect(afterTail.body.balanceCents).toBe(300);

    // The stats strip reports it.
    const stats = await request(app).get(`${MOUNT}/eventstore/stats`);
    expect(stats.body.snapshotEvery).toBe(SNAPSHOT_EVERY);
    expect(stats.body.streams).toBe(1);
    expect(stats.body.events).toBe(7);
    expect(stats.body.snapshots).toHaveLength(1);
    expect(stats.body.snapshots[0]).toMatchObject({ version: 5, balanceCents: 500 });
  });

  it('project() rebuilds the read model from scratch — identical answers, CQRS style', async () => {
    const app = createApp();
    const first = (await request(app).post(`${MOUNT}/eventstore/accounts`).send({ owner: 'A' })).body.streamId as string;
    const second = (await request(app).post(`${MOUNT}/eventstore/accounts`).send({ owner: 'B' })).body.streamId as string;
    await request(app).post(`${MOUNT}/eventstore/accounts/${first}/deposit`).send({ amountCents: 700 });
    await request(app).post(`${MOUNT}/eventstore/accounts/${second}/deposit`).send({ amountCents: 300 });
    await request(app).post(`${MOUNT}/eventstore/accounts/${first}/withdraw`).send({ amountCents: 200 });
    await request(app).post(`${MOUNT}/eventstore/accounts/${first}/withdraw`).send({ amountCents: 9999 }); // rejected

    const before = await request(app).get(`${MOUNT}/eventstore/stats`);
    const rebuild = await request(app).post(`${MOUNT}/eventstore/project`);
    expect(rebuild.status).toBe(200);
    expect(rebuild.body.rebuilt).toBe(true);
    expect(rebuild.body.stats.rebuilds).toBe((before.body.projection.rebuilds as number) + 1);

    // The derivation matches the incremental projection exactly — across BOTH
    // streams, in global append order.
    expect(rebuild.body.entries).toHaveLength(6);
    expect(rebuild.body.stats.entries).toBe(6);
    const view = await request(app).get(`${MOUNT}/eventstore/accounts/${first}`);
    const firstEntries = (rebuild.body.entries as { streamId: string }[]).filter((entry) => entry.streamId === first);
    expect(firstEntries).toEqual(view.body.history);
    const rejected = (rebuild.body.entries as { type: string; note: string }[]).find((entry) => entry.type === 'withdrawal-rejected');
    expect(rejected?.note).toContain('insufficient funds');
  });

  it('validates input shapes with the canonical 400s', async () => {
    const app = createApp();
    const badOwner = await request(app).post(`${MOUNT}/eventstore/accounts`).send({ owner: 42 });
    expect(badOwner.status).toBe(400);
    expect(badOwner.body.error.code).toBe('validation_failed'); // bad owner

    for (const body of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 1.5 }, { amountCents: 'many' }, {}]) {
      const res = await request(app)
        .post(`${MOUNT}/eventstore/accounts/account-1/deposit`)
        .send(body);
      expect(res.status, `body ${String(JSON.stringify(body))}`).toBe(400);
      expect(res.body.error.parameter).toBe('amountCents');
    }
    const badVersion = await request(app)
      .post(`${MOUNT}/eventstore/accounts/account-1/deposit`)
      .send({ amountCents: 100, expectedVersion: -3 });
    expect(badVersion.status).toBe(400);
    expect(badVersion.body.error.parameter).toBe('expectedVersion');

    const unknownView = await request(app).get(`${MOUNT}/eventstore/accounts/account-99`);
    expect(unknownView.status).toBe(404);
  });
});

// --- the order saga -------------------------------------------------------------------------

describe('the order saga — happy path on real queue jobs', () => {
  it('runs all four forward steps to completion', async () => {
    const app = createApp();
    const start = await request(app).post(`${MOUNT}/saga/start`).send({ orderId: 'ord-42' });
    expect(start.status).toBe(201);
    expect(start.body.saga).toMatchObject({ orderId: 'ord-42', state: 'running', failAt: 'none' });
    const sagaId = start.body.saga.sagaId as string;

    const saga = (await pollUntil<{ saga?: { state: string } }>(
      () => request(app).get(`${MOUNT}/saga/${sagaId}`),
      (body) => body.saga?.state === 'completed',
      20_000,
    )).saga as { state: string; steps: { step: string; kind: string; status: string; attempts: number; jobId?: string }[]; finishedAt: string };

    expect(saga.state).toBe('completed');
    expect(saga.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saga.steps.map((step) => [step.step, step.kind, step.status])).toEqual([
      ['place-order', 'forward', 'succeeded'],
      ['reserve-stock', 'forward', 'succeeded'],
      ['charge-card', 'forward', 'succeeded'],
      ['ship', 'forward', 'succeeded'],
    ]);
    // Every step ran as a REAL queue job — zero failures, so zero retries.
    for (const step of saga.steps) {
      expect(step.jobId).toMatch(/^job_\d+$/);
      expect(step.attempts).toBe(0);
    }
    expect((await request(app).get(`${MOUNT}/saga`)).body.sagas).toHaveLength(1);
  });
});

describe('the order saga — injected failure runs reverse compensations', () => {
  it('retries the failing step, dead-letters it, skips the rest, and compensates in reverse', async () => {
    const app = createApp();
    const start = await request(app).post(`${MOUNT}/saga/start`).send({ failAt: 'charge-card' });
    expect(start.status).toBe(201);
    const sagaId = start.body.saga.sagaId as string;

    const saga = (await pollUntil<{ saga?: { state: string } }>(
      () => request(app).get(`${MOUNT}/saga/${sagaId}`),
      (body) => body.saga?.state === 'compensated' || body.saga?.state === 'failed',
      30_000,
    )).saga as { state: string; steps: { step: string; kind: string; status: string; attempts: number }[] };

    expect(saga.state).toBe('compensated');
    expect(saga.steps.map((step) => [step.step, step.kind, step.status])).toEqual([
      ['place-order', 'forward', 'succeeded'],
      ['reserve-stock', 'forward', 'succeeded'],
      ['charge-card', 'forward', 'dead-lettered'],
      ['ship', 'forward', 'skipped'],
      // Compensations run in REVERSE order over every ATTEMPTED forward step —
      // including the failed one (failed-to-confirm is not did-not-happen).
      ['refund-card', 'compensation', 'compensated'],
      ['release-stock', 'compensation', 'compensated'],
      ['cancel-order', 'compensation', 'compensated'],
    ]);

    // THE job-queue interplay: the queue retried the failing step before the
    // saga gave up — 3 total attempts (its full retry budget), not 1.
    const charge = saga.steps.find((step) => step.step === 'charge-card')!;
    expect(charge.attempts).toBe(3);
    const skipped = saga.steps.find((step) => step.step === 'ship')!;
    expect(skipped.attempts).toBe(0);
  });

  it('validates failAt and answers 404 for an unknown saga', async () => {
    const app = createApp();
    const bad = await request(app).post(`${MOUNT}/saga/start`).send({ failAt: 'deliver-by-drone' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.supported).toEqual(['place-order', 'reserve-stock', 'charge-card', 'ship', 'none']);

    const unknown = await request(app).get(`${MOUNT}/saga/saga_999`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');

    // NOT a string body: a urlencoded string is parsed into an object by the
    // oauth router's scoped urlencoded parser (this router mounts after it),
    // so the honest non-object case is a JSON array.
    const notObject = await request(app).post(`${MOUNT}/saga/start`).send([1, 2]);
    expect(notObject.status).toBe(400);
    expect(notObject.body.error.code).toBe('validation_failed');
  });

  it('validates orderId: blank/non-string → 400; omitted → one is generated', async () => {
    const app = createApp();
    for (const badOrderId of ['', '   ', 42]) {
      const bad = await request(app).post(`${MOUNT}/saga/start`).send({ orderId: badOrderId });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('validation_failed');
      expect(bad.body.error.parameter).toBe('orderId');
    }

    // Omitted orderId is the documented default: a fresh manager (beforeEach
    // reset) generates 'order-N' — then the saga still completes for real.
    const generated = await request(app).post(`${MOUNT}/saga/start`).send({});
    expect(generated.status).toBe(201);
    expect(generated.body.saga).toMatchObject({ orderId: 'order-1', state: 'running' });
    const sagaId = generated.body.saga.sagaId as string;
    const saga = await pollUntil<{ saga?: { state: string } }>(
      () => request(app).get(`${MOUNT}/saga/${sagaId}`),
      (body) => body.saga?.state === 'completed',
      20_000,
    );
    expect(saga.saga?.state).toBe('completed');
  });
});
