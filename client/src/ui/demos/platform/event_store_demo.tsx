import { useCallback, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `arch:eventstore` — the event-sourced account. Commands
 * only APPEND: open (expectedVersion -1, the empty-stream convention), deposit,
 * withdraw. The overdraft invariant is enforced AT APPEND TIME — the typed 409
 * carries balance vs requested, and the refusal itself is recorded as a
 * withdrawal-rejected event the next fold still refuses to apply. A stale
 * expectedVersion is the optimistic-concurrency conflict: 409, nothing stored.
 * Every read folds the events; the projection shows the transaction history
 * with running balances, and snapshots (every 5 events) prove snapshot+tail
 * folds equal the full-history fold.
 */

const BASE = '/api/demo/patterns/eventstore';

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_DANGER =
  'w-fit rounded-md border border-error px-sm py-xs text-body-sm text-error hover:bg-error hover:text-on-error disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const MALFORMED = 'malformed payload';

interface EventDataLite {
  type: string;
  owner?: string;
  amountCents?: number;
  reason?: string;
}

interface StoredEvent {
  seq: number;
  data: EventDataLite;
}

interface HistoryRow {
  type: string;
  amountCents: number;
  balanceAfterCents: number;
  note?: string;
}

interface AccountView {
  streamId: string;
  version: number;
  balanceCents: number;
  owner: string;
  events: StoredEvent[];
  history: HistoryRow[];
  load: {
    usedSnapshot: boolean;
    replayedEvents: number;
    totalEvents: number;
    consistent?: boolean;
    fullReplayBalanceCents?: number;
  };
}

interface CommandBody {
  version: number;
  balanceCents: number;
  snapshot: { version: number; balanceCents: number } | null;
}

interface StatsBody {
  streams: number;
  events: number;
  snapshotEvery: number;
  snapshots: { version: number; balanceCents: number }[];
  projection: { rebuilds: number; entries: number };
}

interface Rejection {
  kind: 'overdraft' | 'conflict';
  message: string;
  balanceCents?: number;
  requestedCents?: number;
  expectedVersion?: number;
  actualVersion?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEventData(raw: unknown): EventDataLite | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  return {
    type: raw.type,
    owner: typeof raw.owner === 'string' ? raw.owner : undefined,
    amountCents: typeof raw.amountCents === 'number' ? raw.amountCents : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}

function parseOpen(raw: unknown): { streamId: string; version: number } | null {
  if (!isRecord(raw) || typeof raw.streamId !== 'string' || typeof raw.version !== 'number') {
    return null;
  }
  return { streamId: raw.streamId, version: raw.version };
}

function parseCommand(raw: unknown): CommandBody | null {
  if (!isRecord(raw) || typeof raw.version !== 'number' || typeof raw.balanceCents !== 'number') {
    return null;
  }
  const snapshot =
    isRecord(raw.snapshot) &&
    typeof raw.snapshot.version === 'number' &&
    typeof raw.snapshot.balanceCents === 'number'
      ? { version: raw.snapshot.version, balanceCents: raw.snapshot.balanceCents }
      : null;
  return { version: raw.version, balanceCents: raw.balanceCents, snapshot };
}

function parseView(raw: unknown): AccountView | null {
  if (!isRecord(raw) || !isRecord(raw.load)) return null;
  if (
    typeof raw.streamId !== 'string' ||
    typeof raw.version !== 'number' ||
    typeof raw.balanceCents !== 'number' ||
    typeof raw.owner !== 'string' ||
    !Array.isArray(raw.events) ||
    !Array.isArray(raw.history)
  ) {
    return null;
  }
  const events = raw.events
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.seq === 'number')
    .map((entry) => ({ seq: entry.seq as number, data: parseEventData(entry.data) ?? { type: '?' } }));
  const history = raw.history.filter(
    (entry): entry is HistoryRow =>
      isRecord(entry) &&
      typeof entry.type === 'string' &&
      typeof entry.amountCents === 'number' &&
      typeof entry.balanceAfterCents === 'number',
  );
  return {
    streamId: raw.streamId,
    version: raw.version,
    balanceCents: raw.balanceCents,
    owner: raw.owner,
    events,
    history,
    load: {
      usedSnapshot: raw.load.usedSnapshot === true,
      replayedEvents: typeof raw.load.replayedEvents === 'number' ? raw.load.replayedEvents : 0,
      totalEvents: typeof raw.load.totalEvents === 'number' ? raw.load.totalEvents : events.length,
      consistent: typeof raw.load.consistent === 'boolean' ? raw.load.consistent : undefined,
      fullReplayBalanceCents:
        typeof raw.load.fullReplayBalanceCents === 'number' ? raw.load.fullReplayBalanceCents : undefined,
    },
  };
}

function parseStats(raw: unknown): StatsBody | null {
  if (!isRecord(raw) || !isRecord(raw.projection) || !Array.isArray(raw.snapshots)) return null;
  if (typeof raw.streams !== 'number' || typeof raw.events !== 'number') return null;
  return {
    streams: raw.streams,
    events: raw.events,
    snapshotEvery: typeof raw.snapshotEvery === 'number' ? raw.snapshotEvery : 0,
    snapshots: raw.snapshots.filter(
      (entry): entry is { version: number; balanceCents: number } =>
        isRecord(entry) && typeof entry.version === 'number' && typeof entry.balanceCents === 'number',
    ),
    projection: {
      rebuilds: typeof raw.projection.rebuilds === 'number' ? raw.projection.rebuilds : 0,
      entries: typeof raw.projection.entries === 'number' ? raw.projection.entries : 0,
    },
  };
}

function parseProjection(raw: unknown): { rebuilds: number; entries: number } | null {
  if (!isRecord(raw) || !isRecord(raw.stats)) return null;
  if (typeof raw.stats.rebuilds !== 'number' || typeof raw.stats.entries !== 'number') return null;
  return { rebuilds: raw.stats.rebuilds, entries: raw.stats.entries };
}

function formatCents(cents: number): string {
  return `${String(cents)}¢`;
}

async function callEndpoint(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `HTTP ${String(response.status)}`;
    try {
      const body = (await response.json()) as unknown;
      if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
        message = `${message} — ${body.error.message}`;
      }
    } catch {
      // the status-only message stands
    }
    throw new Error(message);
  }
  return response.json();
}

/**
 * POST an account command; a non-2xx is CLASSIFIED, not thrown: the overdraft
 * refusal and the optimistic-concurrency conflict are both canonical 409s the
 * UI renders as teaching outcomes.
 */
async function postCommand(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; raw: unknown } | { ok: false; rejection: Rejection; other: string | null }> {
  let raw: unknown;
  try {
    const response = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    raw = await response.json();
    if (!response.ok) {
      const err = isRecord(raw) && isRecord(raw.error) ? raw.error : {};
      if (typeof err.balanceCents === 'number' && typeof err.requestedCents === 'number') {
        return {
          ok: false,
          other: null,
          rejection: {
            kind: 'overdraft',
            message: typeof err.message === 'string' ? err.message : 'overdraft refused',
            balanceCents: err.balanceCents,
            requestedCents: err.requestedCents,
          },
        };
      }
      if (typeof err.expectedVersion === 'number' && typeof err.actualVersion === 'number') {
        return {
          ok: false,
          other: null,
          rejection: {
            kind: 'conflict',
            message: typeof err.message === 'string' ? err.message : 'stale expectedVersion',
            expectedVersion: err.expectedVersion,
            actualVersion: err.actualVersion,
          },
        };
      }
      return {
        ok: false,
        other: typeof err.message === 'string' ? err.message : `HTTP ${String(response.status)}`,
        rejection: { kind: 'conflict', message: '' },
      };
    }
    return { ok: true, raw };
  } catch {
    throw new Error('unreachable');
  }
}

export default function EventStoreDemo(): ReactNode {
  const [streamId, setStreamId] = useState<string | null>(null);
  const [view, setView] = useState<AccountView | null>(null);
  const [stats, setStats] = useState<StatsBody | null>(null);
  const [command, setCommand] = useState<{ text: string; snapshotMinted: boolean } | null>(null);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [rebuilt, setRebuilt] = useState<{ rebuilds: number; entries: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [owner, setOwner] = useState('');
  const [amountText, setAmountText] = useState('1000');
  const [versionText, setVersionText] = useState('');

  const refreshAll = useCallback(async (id: string): Promise<void> => {
    try {
      const [viewRaw, statsRaw] = await Promise.all([
        callEndpoint(`${BASE}/accounts/${id}`),
        callEndpoint(`${BASE}/stats`),
      ]);
      const parsedView = parseView(viewRaw);
      const parsedStats = parseStats(statsRaw);
      if (parsedView === null || parsedStats === null) throw new Error(MALFORMED);
      setView(parsedView);
      setStats(parsedStats);
    } catch {
      setError('the account view could not be refreshed — is the server running?');
    }
  }, []);

  const run = useCallback(async (key: string, execute: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await execute();
    } catch (cause) {
      setError(
        cause instanceof Error && (cause.message === MALFORMED || cause.message === 'unreachable')
          ? cause.message === MALFORMED
            ? 'the event store answered with a malformed payload'
            : 'the event store is unreachable — is the server running?'
          : 'the event store call failed',
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const openAccount = useCallback((): Promise<void> => {
    const trimmed = owner.trim();
    return run('open', async () => {
      const outcome = await postCommand(`${BASE}/accounts`, trimmed === '' ? {} : { owner: trimmed });
      if (!outcome.ok) {
        setError(outcome.other ?? 'the account could not be opened');
        return;
      }
      const parsed = parseOpen(outcome.raw);
      if (parsed === null) throw new Error(MALFORMED);
      setStreamId(parsed.streamId);
      setRejection(null);
      setCommand({
        text: `${parsed.streamId} opened — account-opened appended at expectedVersion -1 (the empty-stream convention)`,
        snapshotMinted: false,
      });
      await refreshAll(parsed.streamId);
    });
  }, [owner, refreshAll, run]);

  const sendCommand = useCallback(
    (kind: 'deposit' | 'withdraw'): Promise<void> => {
      if (streamId === null) return Promise.resolve();
      const amount = Number(amountText.trim());
      if (!Number.isInteger(amount) || amount <= 0) {
        setError('amount must be a whole number of cents ≥ 1');
        return Promise.resolve();
      }
      const versionTrimmed = versionText.trim();
      const expected = versionTrimmed === '' ? undefined : Number(versionTrimmed);
      if (expected !== undefined && (!Number.isInteger(expected) || expected < -1)) {
        setError('expectedVersion must be a whole number ≥ -1 (an empty stream is -1)');
        return Promise.resolve();
      }
      return run(kind, async () => {
        const outcome = await postCommand(`${BASE}/accounts/${streamId}/${kind}`, {
          amountCents: amount,
          ...(expected !== undefined && { expectedVersion: expected }),
        });
        if (!outcome.ok) {
          if (outcome.other !== null) {
            setError(outcome.other);
            return;
          }
          setRejection(outcome.rejection);
          setCommand(null);
          // The overdraft refusal IS recorded as an event — refresh shows it.
          await refreshAll(streamId);
          return;
        }
        const parsed = parseCommand(outcome.raw);
        if (parsed === null) throw new Error(MALFORMED);
        setRejection(null);
        setCommand({
          text: `money-${kind === 'deposit' ? 'deposited' : 'withdrawn'} appended — version ${String(parsed.version)}, balance ${formatCents(parsed.balanceCents)}`,
          snapshotMinted: parsed.snapshot !== null,
        });
        await refreshAll(streamId);
      });
    },
    [amountText, refreshAll, run, streamId, versionText],
  );

  const loadStats = useCallback((): Promise<void> => {
    return run('stats', async () => {
      const parsed = parseStats(await callEndpoint(`${BASE}/stats`));
      if (parsed === null) throw new Error(MALFORMED);
      setStats(parsed);
    });
  }, [run]);

  const rebuildProjection = useCallback((): Promise<void> => {
    return run('project', async () => {
      const raw = await callEndpoint(`${BASE}/project`, { method: 'POST' });
      const parsed = parseProjection(raw);
      if (parsed === null) throw new Error(MALFORMED);
      setRebuilt(parsed);
      const asStats = parseStats(raw);
      if (asStats !== null) setStats(asStats);
    });
  }, [run]);

  const resetStore = useCallback((): Promise<void> => {
    return run('reset', async () => {
      await callEndpoint(`${BASE}/reset`, { method: 'POST' });
      setStreamId(null);
      setView(null);
      setStats(null);
      setCommand(null);
      setRejection(null);
      setRebuilt(null);
    });
  }, [run]);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="eventstore-summary" className="text-body-sm text-on-surface">
        An account that stores only events. Commands append (never update); every read{' '}
        <span className="font-mono">fold</span>s the history to a balance. Overdrafts are refused at
        APPEND time — the 409 carries the evidence and the refusal itself becomes a{' '}
        <span className="font-mono">withdrawal-rejected</span> event — and a stale{' '}
        <span className="font-mono">expectedVersion</span> is the optimistic-concurrency conflict:
        nothing written.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            1 · the command console — append-only writes
          </span>
          {streamId !== null && view !== null && (
            <span data-testid="eventstore-stream" className={CHIP_STRONG}>
              {view.streamId} · v{String(view.version)} · {formatCents(view.balanceCents)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-sm">
          <label className="flex w-56 flex-col gap-xxs">
            <span className={LABEL}>owner (optional)</span>
            <input
              data-testid="eventstore-owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              spellCheck={false}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="eventstore-open"
            className={BUTTON_PRIMARY}
            disabled={busy !== null}
            onClick={() => void openAccount()}
          >
            open account
          </button>
          <label className="flex w-32 flex-col gap-xxs">
            <span className={LABEL}>amount (cents)</span>
            <input
              data-testid="eventstore-amount"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              inputMode="numeric"
              className={INPUT}
            />
          </label>
          <label className="flex w-40 flex-col gap-xxs">
            <span className={LABEL}>expectedVersion (optional)</span>
            <input
              data-testid="eventstore-version"
              value={versionText}
              onChange={(event) => setVersionText(event.target.value)}
              inputMode="numeric"
              placeholder="current"
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="eventstore-deposit"
            className={BUTTON_PRIMARY}
            disabled={busy !== null || streamId === null}
            onClick={() => void sendCommand('deposit')}
          >
            deposit
          </button>
          <button
            type="button"
            data-testid="eventstore-withdraw"
            className={BUTTON_PRIMARY}
            disabled={busy !== null || streamId === null}
            onClick={() => void sendCommand('withdraw')}
          >
            withdraw
          </button>
        </div>

        {error !== null && (
          <p data-testid="eventstore-error" className="text-caption text-error">
            {error}
          </p>
        )}
        {command !== null && (
          <p data-testid="eventstore-command" className="text-caption text-on-surface">
            {command.text}
            {command.snapshotMinted && ' — snapshot minted (every 5 events per stream)'}
          </p>
        )}
        {rejection?.kind === 'overdraft' && (
          <div data-testid="eventstore-rejection" className="flex flex-col gap-xxs rounded-md border border-error p-xs">
            <p className="text-caption font-semibold text-error">overdraft refused AT APPEND TIME</p>
            <p className="text-caption text-on-surface">
              requested {formatCents(rejection.requestedCents ?? 0)} — balance{' '}
              {formatCents(rejection.balanceCents ?? 0)}. No money-withdrawn was stored; the refusal
              itself is recorded as a withdrawal-rejected event (see the stream below), and the fold
              still applies nothing.
            </p>
          </div>
        )}
        {rejection?.kind === 'conflict' && (
          <div data-testid="eventstore-conflict" className="flex flex-col gap-xxs rounded-md border border-error p-xs">
            <p className="text-caption font-semibold text-error">
              optimistic-concurrency conflict — nothing written
            </p>
            <p className="text-caption text-on-surface">
              you expected version {String(rejection.expectedVersion ?? '?')} but the stream is at{' '}
              {String(rejection.actualVersion ?? '?')} — someone appended first. No event was stored;
              retry with the current version.
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            2 · the stream, the fold, and the projection
          </span>
        </div>
        {view === null ? (
          <p data-testid="eventstore-empty" className="text-caption text-on-surface-variant">
            no account yet — open one above; every read below folds its events.
          </p>
        ) : (
          <>
            <div data-testid="eventstore-fold" className="flex flex-wrap items-center gap-xs">
              <span className={CHIP_STRONG}>owner: {view.owner}</span>
              <span className={CHIP_STRONG}>balance: {formatCents(view.balanceCents)}</span>
              <span className={CHIP}>version {String(view.version)}</span>
              <span className={CHIP}>
                {view.load.usedSnapshot
                  ? `loaded via snapshot + tail (${String(view.load.replayedEvents)}/${String(view.load.totalEvents)} replayed)`
                  : `full-history fold (${String(view.load.replayedEvents)}/${String(view.load.totalEvents)} events)`}
              </span>
              {view.load.consistent !== undefined && (
                <span className={CHIP}>snapshot consistent: {String(view.load.consistent)}</span>
              )}
            </div>
            <div data-testid="eventstore-events" className="flex flex-col gap-xxs">
              {view.events.map((event) => (
                <p key={event.seq} data-testid="eventstore-event" className="font-mono text-caption text-on-surface">
                  v{String(event.seq)} · {event.data.type}
                  {event.data.amountCents !== undefined && ` ${formatCents(event.data.amountCents)}`}
                  {event.data.owner !== undefined && ` — ${event.data.owner}`}
                </p>
              ))}
            </div>
            <div data-testid="eventstore-history" className="flex flex-col gap-xxs">
              <span className="font-mono text-caption font-semibold text-on-surface">
                the projection — transaction history with running balances
              </span>
              {view.history.map((row, index) => (
                <div key={index} data-testid="eventstore-history-row" className="flex flex-wrap items-center gap-xs">
                  <span className={CHIP}>{row.type}</span>
                  <span className="font-mono text-caption text-on-surface">
                    {String(row.amountCents)}¢
                  </span>
                  <span className="font-mono text-caption text-on-surface-variant">
                    balance {String(row.balanceAfterCents)}¢
                  </span>
                  {row.note !== undefined && <span className="text-caption text-error">{row.note}</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            3 · snapshots + the disposable read model
          </span>
          <button
            type="button"
            data-testid="eventstore-stats-button"
            className={BUTTON}
            disabled={busy !== null}
            onClick={() => void loadStats()}
          >
            load stats
          </button>
          <button
            type="button"
            data-testid="eventstore-project"
            className={BUTTON}
            disabled={busy !== null}
            onClick={() => void rebuildProjection()}
          >
            rebuild the projection
          </button>
          <button
            type="button"
            data-testid="eventstore-reset"
            className={BUTTON_DANGER}
            disabled={busy !== null}
            onClick={() => void resetStore()}
          >
            reset
          </button>
        </div>
        {rebuilt !== null && (
          <p data-testid="eventstore-rebuilt" className="text-caption text-on-surface">
            read model thrown away and re-derived: {String(rebuilt.entries)} entries (rebuild #
            {String(rebuilt.rebuilds)}) — CQRS: writes are facts, reads are disposable derivations.
          </p>
        )}
        {stats === null ? (
          <p data-testid="eventstore-stats-idle" className="text-caption text-on-surface-variant">
            not loaded — press load stats (it also refreshes after every command).
          </p>
        ) : (
          <div data-testid="eventstore-stats" className="flex flex-col gap-xxs">
            <div className="flex flex-wrap items-center gap-xs">
              <span className={CHIP_STRONG}>streams {String(stats.streams)}</span>
              <span className={CHIP}>events {String(stats.events)}</span>
              <span className={CHIP}>snapshot every {String(stats.snapshotEvery)}</span>
              <span className={CHIP}>
                projection: {String(stats.projection.entries)} entries · {String(stats.projection.rebuilds)}{' '}
                rebuilds
              </span>
            </div>
            {stats.snapshots.length === 0 && (
              <p className="text-caption text-on-surface-variant">
                no snapshots yet — they mint every 5 events per stream.
              </p>
            )}
            {stats.snapshots.map((snapshot, index) => (
              <p key={index} data-testid="eventstore-snapshot" className="font-mono text-caption text-on-surface">
                snapshot at v{String(snapshot.version)} — balance {formatCents(snapshot.balanceCents)}
              </p>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
