import { Router, type Request, type Response } from 'express';
import { NotFoundException, ValidationException, failureToException } from '../../core/error_handling/exceptions.js';
import {
  MAX_AMOUNT_CENTS,
  SNAPSHOT_EVERY,
  accountView,
  deposit,
  getDemoEventStore,
  openAccount,
  resetDemoEventStore,
  withdraw,
} from '../../domain/patterns/event_store.js';
import {
  SAGA_FORWARD_STEPS,
  findDemoSaga,
  listDemoSagas,
  resetDemoSagaManager,
  startOrderSaga,
} from '../../domain/patterns/order_saga.js';

/**
 * The advanced-architecture topics' live demo endpoints — the two self-contained
 * exhibits domain/patterns/ implements (same spirit as the testing topic's
 * mini-suite: in-memory, deterministic, no infrastructure).
 *
 * Event store (demoId: arch:eventstore):
 * - POST /api/demo/patterns/eventstore/accounts                {owner?}        → 201, stream at version 0
 * - POST /api/demo/patterns/eventstore/accounts/:id/deposit    {amountCents, expectedVersion?}
 * - POST /api/demo/patterns/eventstore/accounts/:id/withdraw   {amountCents, expectedVersion?}
 *     → 200 when it landed; an overdraft answers the canonical 409 (the store's
 *       typed conflict) AND the refusal is recorded as a withdrawal-rejected
 *       event; a stale expectedVersion answers 409 too (optimistic concurrency).
 * - GET  /api/demo/patterns/eventstore/accounts/:id            → events + fold + load metadata
 *                                                                (snapshot? tail? consistent?) + projection slice
 * - GET  /api/demo/patterns/eventstore/stats                   → streams/events/snapshots/projection stats
 * - POST /api/demo/patterns/eventstore/project                 → rebuild the read model from scratch
 * - POST /api/demo/patterns/eventstore/reset                   → empty store (spec isolation)
 *
 * Order saga (demoId: arch:saga):
 * - POST /api/demo/patterns/saga/start  {orderId?, failAt?}    → 201, saga running (failAt injects a
 *                                                                permanently-failing forward step)
 * - GET  /api/demo/patterns/saga                                → all sagas
 * - GET  /api/demo/patterns/saga/:id                            → one saga — poll until the state is
 *                                                                'completed' or 'compensated'
 * - POST /api/demo/patterns/saga/reset                          → fresh manager (spec isolation)
 *
 * These controllers stay thin (parse/validate → domain Result → HTTP), and the
 * domain exhibits import nothing from data — they are pure teaching artifacts.
 */

export const PATTERNS_DEMO_MOUNT_PATH = '/api/demo/patterns';

const OWNER_MAX_LENGTH = 60;
const ORDER_ID_MAX_LENGTH = 64;

// --- input helpers ---------------------------------------------------------------------

function readObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationException('the body must be a JSON object', {
      errors: [{ field: '$', message: 'must be a JSON object' }],
    });
  }
  return body as Record<string, unknown>;
}

function readAmountCents(body: Record<string, unknown>): number {
  const raw = body.amountCents;
  if (raw === undefined || raw === '') {
    throw new ValidationException('"amountCents" is required', { parameter: 'amountCents' });
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > MAX_AMOUNT_CENTS) {
    throw new ValidationException(
      `"amountCents" must be a whole number of cents between 1 and ${String(MAX_AMOUNT_CENTS)}`,
      { parameter: 'amountCents', received: String(raw) },
    );
  }
  return raw;
}

/** The optimistic-concurrency knob: omit it and the command reads the current version itself. */
function readExpectedVersion(body: Record<string, unknown>): number | undefined {
  const raw = body.expectedVersion;
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < -1) {
    throw new ValidationException('"expectedVersion" must be a whole number >= -1 (an empty stream is -1)', {
      parameter: 'expectedVersion',
      received: String(raw),
    });
  }
  return raw;
}

// --- the event-store controllers -------------------------------------------------------

function openAccountController(req: Request, res: Response): void {
  const body = readObjectBody(req.body);
  const ownerRaw = body.owner ?? 'the demo student';
  if (typeof ownerRaw !== 'string' || ownerRaw.trim() === '' || ownerRaw.trim().length > OWNER_MAX_LENGTH) {
    throw new ValidationException(
      `"owner" must be a non-blank string of at most ${String(OWNER_MAX_LENGTH)} characters`,
      { parameter: 'owner', received: typeof ownerRaw },
    );
  }
  const result = openAccount(ownerRaw.trim());
  if (!result.ok) throw failureToException(result.error);
  res.status(201).json({
    streamId: result.value.streamId,
    version: result.value.append.version,
    events: result.value.append.appended,
    note: 'account-opened appended at expectedVersion -1 (the empty-stream convention). The aggregate is NOT stored — every later read folds the events.',
  });
}

function depositController(req: Request, res: Response): void {
  const streamId = String(req.params.id);
  const body = readObjectBody(req.body);
  const result = deposit(streamId, readAmountCents(body), readExpectedVersion(body));
  if (!result.ok) throw failureToException(result.error);
  res.json({
    streamId,
    version: result.value.version,
    appended: result.value.appended,
    balanceCents: result.value.balanceCents,
    snapshot: result.value.snapshot,
    note:
      result.value.snapshot !== null
        ? `money-deposited appended and the stream crossed a multiple of ${String(SNAPSHOT_EVERY)} — a snapshot was minted; the next load folds snapshot + tail.`
        : 'money-deposited appended; the balance you see is the fold of the whole history.',
  });
}

function withdrawController(req: Request, res: Response): void {
  const streamId = String(req.params.id);
  const body = readObjectBody(req.body);
  const result = withdraw(streamId, readAmountCents(body), readExpectedVersion(body));
  if (!result.ok) throw failureToException(result.error);
  if (result.value.withdrawn) {
    res.json({
      streamId,
      withdrawn: true,
      version: result.value.append!.version,
      appended: result.value.append!.appended,
      balanceCents: result.value.append!.balanceCents,
      note: 'money-withdrawn appended — the fold ALLOWED it (balance stayed >= 0), so it is now an immutable fact.',
    });
    return;
  }
  // The overdraft refusal: a typed 409 whose envelope carries the evidence,
  // and the refusal itself is recorded as an event (visible via GET history).
  throw failureToException(result.value.rejection!);
}

function accountController(req: Request, res: Response): void {
  const result = accountView(String(req.params.id));
  if (!result.ok) throw failureToException(result.error);
  res.json({
    ...result.value,
    note: result.value.load.usedSnapshot
      ? `loaded via snapshot + tail (replayed ${String(result.value.load.replayedEvents)} of ${String(result.value.load.totalEvents)} events) — and the full-history fold was computed too: consistent=${String(result.value.load.consistent)}.`
      : 'loaded by folding the full history (no snapshot yet). history[] is the projection\'s slice — the read model, derived from the write model.',
  });
}

function statsController(_req: Request, res: Response): void {
  const stats = getDemoEventStore().stats();
  res.json({
    ...stats,
    snapshotEvery: SNAPSHOT_EVERY,
    note: `snapshots mint every ${String(SNAPSHOT_EVERY)} events per stream; projection.rebuilds counts the project() calls that re-derived the read model from scratch.`,
  });
}

function projectController(_req: Request, res: Response): void {
  const { rebuilt, stats } = getDemoEventStore().project();
  res.json({
    rebuilt: true,
    stats,
    entries: rebuilt,
    note: 'the read model was thrown away and re-derived from every stream\'s events in global order — CQRS: writes are facts, reads are disposable derivations.',
  });
}

function eventStoreResetController(_req: Request, res: Response): void {
  resetDemoEventStore();
  res.json({ reset: true, note: 'fresh store — no streams, no snapshots, an empty projection.' });
}

// --- the saga controllers ----------------------------------------------------------------

function sagaStartController(req: Request, res: Response): void {
  const body = readObjectBody(req.body);
  const orderIdRaw = body.orderId;
  if (orderIdRaw !== undefined && (typeof orderIdRaw !== 'string' || orderIdRaw.trim() === '' || orderIdRaw.trim().length > ORDER_ID_MAX_LENGTH)) {
    throw new ValidationException(`"orderId" must be a non-blank string of at most ${String(ORDER_ID_MAX_LENGTH)} characters`, {
      parameter: 'orderId',
    });
  }
  const failAtRaw = body.failAt ?? 'none';
  if (typeof failAtRaw !== 'string' || (failAtRaw !== 'none' && !SAGA_FORWARD_STEPS.includes(failAtRaw as (typeof SAGA_FORWARD_STEPS)[number]))) {
    throw new ValidationException(`"failAt" must be one of the saga's forward steps or "none"`, {
      parameter: 'failAt',
      received: String(failAtRaw),
      supported: [...SAGA_FORWARD_STEPS, 'none'],
    });
  }
  const result = startOrderSaga({
    ...(orderIdRaw !== undefined && { orderId: (orderIdRaw as string).trim() }),
    failAt: failAtRaw as 'none' | (typeof SAGA_FORWARD_STEPS)[number],
  });
  if (!result.ok) throw failureToException(result.error);
  res.status(201).json({
    saga: result.value,
    note: 'the saga runs in the background on real queue jobs (retries + backoff included) — poll GET /api/demo/patterns/saga/:id until the state is completed or compensated.',
  });
}

function sagaListController(_req: Request, res: Response): void {
  res.json({ sagas: listDemoSagas() });
}

function sagaDetailController(req: Request, res: Response): void {
  const saga = findDemoSaga(String(req.params.id));
  if (saga === undefined) {
    throw new NotFoundException(`no saga with id "${String(req.params.id)}"`, { sagaId: String(req.params.id) });
  }
  res.json({ saga });
}

function sagaResetController(_req: Request, res: Response): void {
  resetDemoSagaManager();
  res.json({ reset: true, note: 'fresh saga manager and queue — no sagas, no step jobs.' });
}

export const patternsDemoRouter = Router();
// Event store (demoId: arch:eventstore)
patternsDemoRouter.post('/demo/patterns/eventstore/accounts', openAccountController);
patternsDemoRouter.post('/demo/patterns/eventstore/accounts/:id/deposit', depositController);
patternsDemoRouter.post('/demo/patterns/eventstore/accounts/:id/withdraw', withdrawController);
patternsDemoRouter.get('/demo/patterns/eventstore/accounts/:id', accountController);
patternsDemoRouter.get('/demo/patterns/eventstore/stats', statsController);
patternsDemoRouter.post('/demo/patterns/eventstore/project', projectController);
// Unauthenticated reset of shared demo state — a deliberate DEMO affordance so
// any visitor can restore the fixture; production resets demand credentials.
// Never copy this into prod.
patternsDemoRouter.post('/demo/patterns/eventstore/reset', eventStoreResetController);
// Order saga (demoId: arch:saga)
patternsDemoRouter.post('/demo/patterns/saga/start', sagaStartController);
patternsDemoRouter.get('/demo/patterns/saga', sagaListController);
patternsDemoRouter.get('/demo/patterns/saga/:id', sagaDetailController);
// Unauthenticated reset of the saga log — same deliberate DEMO affordance as
// the event-store reset above; never copy into prod.
patternsDemoRouter.post('/demo/patterns/saga/reset', sagaResetController);
