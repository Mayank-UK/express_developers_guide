import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';

/**
 * A hand-rolled EVENT STORE — the event-sourcing lesson in one readable
 * module, in the same self-contained spirit as domain/testing/mini_suite.ts:
 * in-memory, deterministic, no infrastructure. Every concept is real:
 *
 *   append(streamId, events, expectedVersion) — optimistic concurrency: the
 *     writer states the version it believes; if a concurrent writer's append
 *     moved it, the store REJECTS with a typed conflict. Version convention
 *     (fixed once, used everywhere): an EMPTY stream's version is -1, and each
 *     stored event's seq IS the stream version after storing it (0, 1, 2, …).
 *   loadStream — snapshot + tail when a snapshot exists, full history
 *     otherwise. The result carries BOTH folds' balances so the demo (and the
 *     spec) can PROVE the shortcut computes what the full replay computes — a
 *     wrong snapshot is silent corruption, so it is verified, not assumed.
 *   the FOLD — `foldAccount` is a PURE function from events to state. Replay
 *     IS fold: the aggregate is not stored, it is derived, every time.
 *   the invariant at APPEND time — the store folds history + the incoming
 *     events and rejects an append that would overdraw. This is the
 *     event-sourcing lesson proper: with a database-first design the CHECK
 *     constraint guards a column; here the fold IS the constraint, and it
 *     must run BEFORE the events become immutable facts. A rejected append
 *     stores NOTHING — the caller may then record the rejection itself as an
 *     event (withdrawal-rejected), because "the customer tried, was refused"
 *     is history too.
 *   the PROJECTION — a read model (per-account transaction history) derived
 *     by replaying events, updated on append, and REBUILDABLE from scratch
 *     via project() — the CQRS lesson: the write model is the events; the
 *     read model is a disposable derivation; eventual consistency is by
 *     construction (this exhibit updates it in-process; across a process
 *     boundary it would lag, and that lag is the design, not a bug).
 */

// --- the Account aggregate's events ---------------------------------------------------

export type AccountEventData =
  | { readonly type: 'account-opened'; readonly owner: string }
  | { readonly type: 'money-deposited'; readonly amountCents: number }
  | { readonly type: 'money-withdrawn'; readonly amountCents: number }
  | {
      readonly type: 'withdrawal-rejected';
      readonly amountCents: number;
      readonly reason: string;
    };

export interface StoredEvent {
  /** Stream-local sequence — the stream's version once this event landed. */
  readonly seq: number;
  readonly data: AccountEventData;
  /** UTC ISO stamp of the append. */
  readonly recordedAt: string;
  /** Global append order — the projection's replay ordering across streams. */
  readonly globalSeq: number;
}

export interface StreamSnapshot {
  readonly streamId: string;
  /** The stream version this snapshot folds events up to (inclusive). */
  readonly version: number;
  readonly balanceCents: number;
  readonly createdAt: string;
}

/** A snapshot is minted every time a stream's version crosses a multiple of this. */
export const SNAPSHOT_EVERY = 5;

// --- the fold (pure) -------------------------------------------------------------------

export interface AccountFold {
  readonly opened: boolean;
  readonly owner: string | null;
  readonly balanceCents: number;
}

const EMPTY_FOLD: AccountFold = { opened: false, owner: null, balanceCents: 0 };

/**
 * Events → aggregate, purely. No input mutation, no side effects, no clock:
 * the same events always fold to the same state — which is exactly why
 * replay works, and why a snapshot must reproduce it. withdrawal-rejected
 * events are history; they change nothing about the balance.
 */
export function foldAccount(events: readonly AccountEventData[]): AccountFold {
  let fold = EMPTY_FOLD;
  for (const event of events) {
    switch (event.type) {
      case 'account-opened':
        fold = { opened: true, owner: event.owner, balanceCents: 0 };
        break;
      case 'money-deposited':
        fold = { ...fold, balanceCents: fold.balanceCents + event.amountCents };
        break;
      case 'money-withdrawn':
        fold = { ...fold, balanceCents: fold.balanceCents - event.amountCents };
        break;
      case 'withdrawal-rejected':
        break; // the attempt left the balance untouched
    }
  }
  return fold;
}

// --- the projection (read model) --------------------------------------------------------

export interface TransactionEntry {
  readonly streamId: string;
  readonly seq: number;
  readonly type: AccountEventData['type'];
  /** Signed movement: +deposit, −withdrawal, 0 for opened/rejected. */
  readonly amountCents: number;
  readonly balanceAfterCents: number;
  readonly at: string;
  readonly note: string;
}

/**
 * Derives the transaction-history read model from events — the computation a
 * projection worker performs: replay in global append order, carrying each
 * stream's running balance as it goes. This is the list statement a UI wants
 * and the event store itself can never answer without folding.
 *
 * `startingBalances` seeds each stream's running balance (the incremental path
 * hands in the balances the projection already holds; a rebuild passes none).
 * The input map is copied, never mutated — the function stays pure.
 */
export function projectTransactionHistory(
  events: readonly { streamId: string; event: StoredEvent }[],
  startingBalances: ReadonlyMap<string, number> = new Map(),
): readonly TransactionEntry[] {
  const balances = new Map(startingBalances);
  const entries: TransactionEntry[] = [];
  for (const { streamId, event } of events) {
    const before = balances.get(streamId) ?? 0;
    let amount = 0;
    let note = '';
    switch (event.data.type) {
      case 'account-opened':
        note = `account opened for ${event.data.owner}`;
        break;
      case 'money-deposited':
        amount = event.data.amountCents;
        note = 'deposit';
        break;
      case 'money-withdrawn':
        amount = -event.data.amountCents;
        note = 'withdrawal';
        break;
      case 'withdrawal-rejected':
        note = `withdrawal rejected — ${event.data.reason}`;
        break;
    }
    const after = before + amount;
    balances.set(streamId, after);
    entries.push({
      streamId,
      seq: event.seq,
      type: event.data.type,
      amountCents: amount,
      balanceAfterCents: after,
      at: event.recordedAt,
      note,
    });
  }
  return entries;
}

// --- the store --------------------------------------------------------------------------

export interface LoadResult {
  readonly streamId: string;
  /** Current version: -1 for a stream that does not exist / has no events. */
  readonly version: number;
  readonly events: readonly StoredEvent[];
  readonly balanceCents: number;
  readonly load: {
    /** True when a snapshot carried the fold and only the tail was replayed. */
    readonly usedSnapshot: boolean;
    /** How many events the fold actually replayed (0 with a fresh snapshot). */
    readonly replayedEvents: number;
    readonly totalEvents: number;
    /** The full-history fold — equal to balanceCents, or the snapshot lies. */
    readonly fullReplayBalanceCents: number;
    readonly consistent: boolean;
  };
}

export interface AppendResult {
  readonly streamId: string;
  readonly version: number;
  readonly appended: readonly StoredEvent[];
  readonly balanceCents: number;
  /** The snapshot minted by this append, when one was due. */
  readonly snapshot: StreamSnapshot | null;
}

export interface ProjectionStats {
  readonly entries: number;
  readonly lastRebuiltAt: string | null;
  readonly rebuilds: number;
}

export interface StoreStats {
  readonly streams: number;
  readonly events: number;
  readonly snapshots: readonly StreamSnapshot[];
  readonly projection: ProjectionStats;
}

interface StreamRecord {
  readonly streamId: string;
  readonly events: StoredEvent[];
  snapshot: StreamSnapshot | null;
}

export class AccountEventStore {
  private readonly streams = new Map<string, StreamRecord>();
  /** The projection's running balances — what the INCREMENTAL path seeds from. */
  private readonly projectionBalances = new Map<string, number>();
  private projectionEntries: readonly TransactionEntry[] = [];
  private projectionRebuilds = 0;
  private projectionLastRebuiltAt: string | null = null;
  private nextGlobalSeq = 0;
  private nextStreamNumber = 0;

  /** Mints the next stream id — the demo's accounts are account-1, account-2, … */
  nextStreamId(): string {
    this.nextStreamNumber += 1;
    return `account-${String(this.nextStreamNumber)}`;
  }

  /**
   * The write side. Three gates, in order:
   *   1. optimistic concurrency — expectedVersion must equal the current
   *      version (-1 while the stream is empty, so "must be new" is just
   *      expectedVersion -1);
   *   2. shape — every stream must BEGIN with account-opened, exactly once;
   *   3. the domain invariant — folding history + incoming events may never
   *      drive the balance negative.
   * A rejected append writes NOTHING: events are immutable, so there is no
   * "undo" — the only safe moment to enforce an invariant is before storing.
   */
  append(
    streamId: string,
    events: readonly AccountEventData[],
    expectedVersion: number,
  ): Result<AppendResult, Failure> {
    if (events.length === 0) {
      return fail(failure('validation', 'append requires at least one event', { streamId }));
    }
    const record = this.streams.get(streamId);
    const currentVersion = record === undefined ? -1 : record.events.length - 1;

    if (expectedVersion !== currentVersion) {
      return fail(
        failure(
          'conflict',
          `optimistic-concurrency conflict on "${streamId}": expected version ${String(expectedVersion)} but the stream is at ${String(currentVersion)} — someone appended first; reload and retry`,
          { streamId, expectedVersion, actualVersion: currentVersion },
        ),
      );
    }

    // Validate the WHOLE resulting history — stored events + incoming ones.
    const resultingEvents: readonly AccountEventData[] = [
      ...(record?.events ?? []).map((event) => event.data),
      ...events,
    ];
    const first = resultingEvents[0]!;
    if (first.type !== 'account-opened') {
      return fail(
        failure('conflict', `a stream must begin with account-opened (got "${first.type}")`, { streamId }),
      );
    }
    if (resultingEvents.filter((event) => event.type === 'account-opened').length > 1) {
      return fail(failure('conflict', 'account-opened may only occur once per stream', { streamId }));
    }

    // The invariant, at append time, against the fold of the whole history.
    let running = 0;
    for (const event of resultingEvents) {
      if (event.type === 'money-deposited') running += event.amountCents;
      if (event.type === 'money-withdrawn') running -= event.amountCents;
      if (running < 0) {
        const balanceBefore =
          event.type === 'money-withdrawn' ? running + event.amountCents : running;
        const attemptedChangeCents =
          event.type === 'money-deposited'
            ? event.amountCents
            : event.type === 'money-withdrawn'
              ? -event.amountCents
              : 0;
        return fail(
          failure(
            'conflict',
            'domain invariant rejected the append: this event would overdraw the account (the balance cannot go negative)',
            {
              streamId,
              invariant: 'no-overdraft',
              event: event.type,
              balanceCents: balanceBefore,
              attemptedChangeCents,
            },
          ),
        );
      }
    }

    // Commit: seq numbers continue the stream; the global order stamp is what
    // the projection replays by. The in-process read model updates in the
    // same breath — across a process boundary this exact moment is where
    // eventual consistency begins (a projection worker applies the same
    // events, later).
    const at = new Date().toISOString();
    const stamped: StoredEvent[] = events.map((data, index) => ({
      seq: currentVersion + 1 + index,
      data,
      recordedAt: at,
      globalSeq: (this.nextGlobalSeq += 1) - 1,
    }));

    const target: StreamRecord = record ?? { streamId, events: [], snapshot: null };
    target.events.push(...stamped);
    this.streams.set(streamId, target);

    // Snapshot when this append lands ON a SNAPSHOT_EVERY boundary (version
    // 5, 10, …): replay after that folds the snapshot + tail, not history.
    const newVersion = target.events.length - 1;
    let snapshot: StreamSnapshot | null = null;
    if (newVersion > 0 && newVersion % SNAPSHOT_EVERY === 0) {
      snapshot = {
        streamId,
        version: newVersion,
        balanceCents: foldAccount(target.events.map((event) => event.data)).balanceCents,
        createdAt: at,
      };
      target.snapshot = snapshot;
    }

    // The INCREMENTAL read-model update: the new entries fold forward FROM the
    // balance the projection already holds for this stream (seeding with 0
    // here would corrupt every balanceAfterCents after the first append —
    // the classic incremental-projection bug, caught by the spec).
    const newBalance = foldAccount(target.events.map((event) => event.data)).balanceCents;
    this.projectionEntries = [
      ...this.projectionEntries,
      ...projectTransactionHistory(
        stamped.map((event) => ({ streamId, event })),
        new Map([[streamId, this.projectionBalances.get(streamId) ?? 0]]),
      ),
    ];
    this.projectionBalances.set(streamId, newBalance);

    return ok({
      streamId,
      version: newVersion,
      appended: stamped,
      balanceCents: newBalance,
      snapshot,
    });
  }

  /**
   * The read side. Folds snapshot + tail when a snapshot exists — the
   * shortcut that keeps replay O(tail) instead of O(history) — and computes
   * the full-history fold TOO, reporting `consistent` so a lying snapshot can
   * never hide. An unknown stream is version -1 with no events (the caller
   * decides whether that is a 404).
   */
  loadStream(streamId: string): LoadResult {
    const record = this.streams.get(streamId);
    if (record === undefined) {
      return {
        streamId,
        version: -1,
        events: [],
        balanceCents: 0,
        load: {
          usedSnapshot: false,
          replayedEvents: 0,
          totalEvents: 0,
          fullReplayBalanceCents: 0,
          consistent: true,
        },
      };
    }

    const events = [...record.events];
    const total = events.length;
    const snapshot = record.snapshot;
    if (snapshot !== null && snapshot.version < total) {
      const tail = events.filter((event) => event.seq > snapshot.version);
      const fromSnapshot = snapshot.balanceCents + foldAccount(tail.map((event) => event.data)).balanceCents;
      const fullReplay = foldAccount(events.map((event) => event.data)).balanceCents;
      return {
        streamId,
        version: total - 1,
        events,
        balanceCents: fromSnapshot,
        load: {
          usedSnapshot: true,
          replayedEvents: tail.length,
          totalEvents: total,
          fullReplayBalanceCents: fullReplay,
          consistent: fromSnapshot === fullReplay,
        },
      };
    }

    const balance = foldAccount(events.map((event) => event.data)).balanceCents;
    return {
      streamId,
      version: total - 1,
      events,
      balanceCents: balance,
      load: {
        usedSnapshot: false,
        replayedEvents: total,
        totalEvents: total,
        fullReplayBalanceCents: balance,
        consistent: true,
      },
    };
  }

  /** The derived read model, as it stands right now. */
  projection(): readonly TransactionEntry[] {
    return this.projectionEntries;
  }

  /**
   * CQRS's other half, on demand: throw the read model away and DERIVE it
   * again from the write model (every stream's events, in global append
   * order). A "projection" that cannot be rebuilt from the events is not a
   * projection — it is a second source of truth, which is a bug.
   */
  project(): { rebuilt: readonly TransactionEntry[]; stats: ProjectionStats } {
    const allEvents = [...this.streams.values()]
      .flatMap((record) => record.events.map((event) => ({ streamId: record.streamId, event })))
      .sort((a, b) => a.event.globalSeq - b.event.globalSeq);
    const rebuilt = projectTransactionHistory(allEvents);
    this.projectionEntries = [...rebuilt];
    // The rebuild re-derives the running balances too — the incremental path
    // and the from-scratch path must stay interchangeable.
    this.projectionBalances.clear();
    for (const entry of rebuilt) this.projectionBalances.set(entry.streamId, entry.balanceAfterCents);
    this.projectionRebuilds += 1;
    this.projectionLastRebuiltAt = new Date().toISOString();
    return { rebuilt: this.projectionEntries, stats: this.projectionStats() };
  }

  stats(): StoreStats {
    const snapshots: StreamSnapshot[] = [];
    let eventCount = 0;
    for (const record of this.streams.values()) {
      eventCount += record.events.length;
      if (record.snapshot !== null) snapshots.push(record.snapshot);
    }
    return { streams: this.streams.size, events: eventCount, snapshots, projection: this.projectionStats() };
  }

  private projectionStats(): ProjectionStats {
    return {
      entries: this.projectionEntries.length,
      lastRebuiltAt: this.projectionLastRebuiltAt,
      rebuilds: this.projectionRebuilds,
    };
  }

  /** Demo/spec reset: no streams, no snapshots, an empty projection. */
  clear(): void {
    this.streams.clear();
    this.projectionBalances.clear();
    this.projectionEntries = [];
    this.projectionRebuilds = 0;
    this.projectionLastRebuiltAt = null;
    this.nextGlobalSeq = 0;
    this.nextStreamNumber = 0;
  }
}

// --- the demo singleton -------------------------------------------------------------------

let demoStore: AccountEventStore | undefined;

/** The process-global store the demo routes talk to. */
export function getDemoEventStore(): AccountEventStore {
  demoStore ??= new AccountEventStore();
  return demoStore;
}

/** Test/demo reset: a fresh store, so specs never share streams. */
export function resetDemoEventStore(): void {
  demoStore?.clear();
  demoStore = new AccountEventStore();
}

// --- the command layer the routes call -----------------------------------------------------

export const MAX_AMOUNT_CENTS = 100_000_000; // 1M in major units — a teaching bound

function amountFailure(amountCents: number): Failure {
  return failure(
    'validation',
    `"amountCents" must be a whole number of cents between 1 and ${String(MAX_AMOUNT_CENTS)}`,
    { parameter: 'amountCents', received: amountCents },
  );
}

function notFoundFailure(streamId: string): Failure {
  return failure('not_found', `no account stream "${streamId}" — open one first`, { streamId });
}

/** The version the caller believes the stream is at (optional: defaults to current). */
function currentVersionOf(streamId: string): number {
  return getDemoEventStore().loadStream(streamId).version;
}

export interface OpenedAccount {
  readonly streamId: string;
  readonly append: AppendResult;
}

/** Opens a fresh account: stream id minted, account-opened appended at version -1. */
export function openAccount(owner: string): Result<OpenedAccount, Failure> {
  const store = getDemoEventStore();
  const streamId = store.nextStreamId();
  const appended = store.append(streamId, [{ type: 'account-opened', owner }], -1);
  if (!appended.ok) return appended;
  return ok({ streamId, append: appended.value });
}

export function deposit(
  streamId: string,
  amountCents: number,
  expectedVersion?: number,
): Result<AppendResult, Failure> {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    return fail(amountFailure(amountCents));
  }
  if (currentVersionOf(streamId) === -1) return fail(notFoundFailure(streamId));
  return getDemoEventStore().append(
    streamId,
    [{ type: 'money-deposited', amountCents }],
    expectedVersion ?? currentVersionOf(streamId),
  );
}

export interface WithdrawResult {
  readonly withdrawn: boolean;
  /** Present when withdrawn: the append that landed. */
  readonly append?: AppendResult;
  /** Present when refused: the typed conflict the route maps onto HTTP 409. */
  readonly rejection?: Failure;
  /** Present when refused: the withdrawal-rejected event recorded instead. */
  readonly rejectedEvent?: StoredEvent;
}

/**
 * Withdraws — or refuses. The refusal is a FIRST-CLASS outcome, not an error:
 * the store rejected the append at the invariant gate, and the refusal itself
 * is recorded as a withdrawal-rejected event (the attempt is history). The
 * route converts `rejection` into the canonical 409 envelope. An
 * optimistic-concurrency conflict (stale expectedVersion) is NOT a refusal —
 * it propagates as its own typed failure.
 */
export function withdraw(
  streamId: string,
  amountCents: number,
  expectedVersion?: number,
): Result<WithdrawResult, Failure> {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    return fail(amountFailure(amountCents));
  }
  const store = getDemoEventStore();
  const current = store.loadStream(streamId);
  if (current.version === -1) return fail(notFoundFailure(streamId));
  const version = expectedVersion ?? current.version;

  const attempted = store.append(streamId, [{ type: 'money-withdrawn', amountCents }], version);
  if (attempted.ok) return ok({ withdrawn: true, append: attempted.value });
  if (attempted.error.details?.invariant !== 'no-overdraft') {
    return fail(attempted.error); // version conflict / shape problem — surface as-is
  }

  // Overdraft refusal: record the rejection as an event (the rejected append
  // changed nothing, so the stream is still at `version`), then hand the
  // route the typed conflict for the 409.
  const reason = `insufficient funds: balance ${String(current.balanceCents)}c < requested ${String(amountCents)}c`;
  const rejection = store.append(streamId, [{ type: 'withdrawal-rejected', amountCents, reason }], version);
  if (!rejection.ok) return fail(rejection.error);
  return ok({
    withdrawn: false,
    rejection: failure('conflict', `overdraft rejected at append time — ${reason}`, {
      streamId,
      balanceCents: current.balanceCents,
      requestedCents: amountCents,
      reason,
    }),
    rejectedEvent: rejection.value.appended[0],
  });
}

export interface AccountView {
  readonly streamId: string;
  readonly version: number;
  readonly balanceCents: number;
  readonly owner: string | null;
  readonly events: readonly StoredEvent[];
  readonly load: LoadResult['load'];
  /** This account's slice of the projection — the read model, derived. */
  readonly history: readonly TransactionEntry[];
}

/** One account's full view: events, fold, load metadata, projection slice. */
export function accountView(streamId: string): Result<AccountView, Failure> {
  const store = getDemoEventStore();
  const loaded = store.loadStream(streamId);
  if (loaded.version === -1) return fail(notFoundFailure(streamId));
  return ok({
    streamId: loaded.streamId,
    version: loaded.version,
    balanceCents: loaded.balanceCents,
    owner: foldAccount(loaded.events.map((event) => event.data)).owner,
    events: loaded.events,
    load: loaded.load,
    history: store.projection().filter((entry) => entry.streamId === streamId),
  });
}
