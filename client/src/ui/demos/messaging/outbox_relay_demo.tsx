import { useCallback, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `msg:outbox` — the transactional outbox, end to end.
 *
 * 1. ENQUEUE commits the business write (a post title UPDATE) and the outbox
 *    row in ONE sqlite transaction. The crash checkbox kills the process
 *    BETWEEN the two writes and the transaction rolls back both — the
 *    dual-write problem, solved.
 * 2. THE RELAY polls due rows, XADDs each to the stream, and only then marks
 *    it published — in that order. crashAfterPublish leaves the row due with
 *    the entry already shipped, so the recovery run ships it AGAIN: the
 *    at-least-once duplicate, made visible in panel 3.
 * 3. THE EVIDENCE — the sqlite ledger (published_at / attempts / backoff) and
 *    the relay's output stream, where two entries sharing an outbox id are
 *    flagged as the duplicate the consumer must survive.
 */

const BASE = '/api/demo/msg/outbox';

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
const CHIP_WARNING =
  'rounded-md border border-warning bg-warning px-xs py-xxs font-mono text-caption font-bold text-on-surface';
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const MALFORMED = 'malformed payload';

interface OutboxRow {
  topic: string;
  publishedAt: string | null;
  attempts: number;
  nextAttemptAt?: string;
  payload: { title?: string };
}

interface RelayBody {
  crashedAfterPublish: { outboxId: number } | null;
  published: { topic: string; entryId: string; markedPublished: boolean; alreadyDelivered: boolean }[];
  failedRetries: { attempts: number; nextAttemptAt?: string }[];
  skippedNotDue: number;
  rows: OutboxRow[];
}

interface EnqueueBody {
  crash: boolean;
  enqueued: boolean;
  rolledBack: boolean;
  post: { id: string; title: string };
  outboxRowCount: number;
  outboxRows: OutboxRow[];
}

interface StreamEntry {
  outboxId: number;
  id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clockOf(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

function parseOutboxRow(raw: Record<string, unknown>): OutboxRow {
  return {
    topic: typeof raw.topic === 'string' ? raw.topic : '?',
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    nextAttemptAt: typeof raw.nextAttemptAt === 'string' ? raw.nextAttemptAt : undefined,
    payload:
      isRecord(raw.payload) && typeof raw.payload.title === 'string' ? { title: raw.payload.title } : {},
  };
}

function parseRows(raw: unknown): OutboxRow[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is Record<string, unknown> => isRecord(entry)).map(parseOutboxRow);
}

function parseEnqueue(raw: unknown): EnqueueBody | null {
  if (!isRecord(raw) || !isRecord(raw.post)) return null;
  if (typeof raw.post.id !== 'string' || typeof raw.post.title !== 'string') return null;
  const rows = parseRows(raw.outboxRows);
  if (rows === null) return null;
  return {
    crash: raw.crash === true,
    enqueued: raw.enqueued === true,
    rolledBack: raw.rolledBack === true,
    post: { id: raw.post.id, title: raw.post.title },
    outboxRowCount: typeof raw.outboxRowCount === 'number' ? raw.outboxRowCount : rows.length,
    outboxRows: rows,
  };
}

function parseRelay(raw: unknown): RelayBody | null {
  if (!isRecord(raw)) return null;
  const rows = parseRows(raw.rows);
  if (rows === null) return null;
  const published = Array.isArray(raw.published)
    ? raw.published
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => ({
          topic: typeof entry.topic === 'string' ? entry.topic : '?',
          entryId: typeof entry.entryId === 'string' ? entry.entryId : '?',
          markedPublished: entry.markedPublished === true,
          alreadyDelivered: entry.alreadyDelivered === true,
        }))
    : [];
  const failedRetries = Array.isArray(raw.failedRetries)
    ? raw.failedRetries
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => ({
          attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
          nextAttemptAt: typeof entry.nextAttemptAt === 'string' ? entry.nextAttemptAt : undefined,
        }))
    : [];
  const crashedAfterPublish =
    isRecord(raw.crashedAfterPublish) && typeof raw.crashedAfterPublish.outboxId === 'number'
      ? { outboxId: raw.crashedAfterPublish.outboxId }
      : null;
  return {
    crashedAfterPublish,
    published,
    failedRetries,
    skippedNotDue: typeof raw.skippedNotDue === 'number' ? raw.skippedNotDue : 0,
    rows,
  };
}

function parseStreamEntries(raw: unknown): StreamEntry[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return null;
  return raw.entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.outboxId === 'number')
    .map((entry) => ({
      outboxId: entry.outboxId as number,
      id: typeof entry.id === 'string' ? entry.id : undefined,
    }));
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

function OutboxRows({ rows }: { rows: OutboxRow[] }): ReactNode {
  return (
    <div className="flex flex-col gap-xxs">
      {rows.map((row, index) => (
        <div key={index} data-testid="outbox-row" className="flex flex-wrap items-center gap-xs">
          <span className={CHIP_STRONG}>{row.topic}</span>
          <span className="font-mono text-caption text-on-surface break-all">
            {row.payload.title ?? '?'}
          </span>
          <span className={CHIP}>
            {row.publishedAt === null
              ? 'queued — not published yet'
              : `published ${clockOf(row.publishedAt)}Z`}
          </span>
          <span className={CHIP}>attempts {String(row.attempts)}</span>
          {row.nextAttemptAt !== undefined && row.publishedAt === null && (
            <span className={CHIP}>next try {clockOf(row.nextAttemptAt)}Z</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function OutboxRelayDemo(): ReactNode {
  const [title, setTitle] = useState('Layers keep concerns apart (revised)');
  const [crash, setCrash] = useState(false);
  const [enqueueResult, setEnqueueResult] = useState<EnqueueBody | null>(null);
  const [relay, setRelay] = useState<RelayBody | null>(null);
  const [ledger, setLedger] = useState<{ loaded: boolean; rows: OutboxRow[] }>({ loaded: false, rows: [] });
  const [stream, setStream] = useState<{ loaded: boolean; entries: StreamEntry[] }>({
    loaded: false,
    entries: [],
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, execute: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await execute();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === MALFORMED
          ? 'the outbox lab answered with a malformed payload'
          : 'the outbox lab is unreachable — is the server running (redis for the relay)?',
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const enqueue = useCallback((): Promise<void> => {
    const trimmed = title.trim();
    return run('enqueue', async () => {
      const raw = await callEndpoint(`${BASE}/enqueue`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...(trimmed !== '' && { title: trimmed }), crash }),
      });
      const parsed = parseEnqueue(raw);
      if (parsed === null) throw new Error(MALFORMED);
      setEnqueueResult(parsed);
      setLedger({ loaded: true, rows: parsed.outboxRows });
    });
  }, [crash, run, title]);

  const relayRun = useCallback(
    (mode: 'normal' | 'crashAfterPublish' | 'failPublish'): Promise<void> => {
      return run(`relay-${mode}`, async () => {
        const raw = await callEndpoint(`${BASE}/relay`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(
            mode === 'crashAfterPublish'
              ? { crashAfterPublish: true }
              : mode === 'failPublish'
                ? { failPublish: true }
                : {},
          ),
        });
        const parsed = parseRelay(raw);
        if (parsed === null) throw new Error(MALFORMED);
        setRelay(parsed);
        setLedger({ loaded: true, rows: parsed.rows });
      });
    },
    [run],
  );

  const refreshLedger = useCallback((): Promise<void> => {
    return run('ledger', async () => {
      const raw = await callEndpoint(BASE);
      const rows = isRecord(raw) ? parseRows(raw.rows) : null;
      if (rows === null) throw new Error(MALFORMED);
      setLedger({ loaded: true, rows });
    });
  }, [run]);

  const refreshStream = useCallback((): Promise<void> => {
    return run('stream', async () => {
      const entries = parseStreamEntries(await callEndpoint(`${BASE}/stream`));
      if (entries === null) throw new Error(MALFORMED);
      setStream({ loaded: true, entries });
    });
  }, [run]);

  const reset = useCallback((): Promise<void> => {
    return run('reset', async () => {
      await callEndpoint(`${BASE}/reset`, { method: 'POST' });
      setEnqueueResult(null);
      setRelay(null);
      setLedger({ loaded: false, rows: [] });
      setStream({ loaded: false, entries: [] });
    });
  }, [run]);

  // The duplicate detector: two stream entries sharing an outbox id.
  const duplicates = Object.entries(
    stream.entries.reduce<Record<string, number>>((counts, entry) => {
      const key = String(entry.outboxId);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  ).filter(([, count]) => count > 1);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="outbox-summary" className="text-body-sm text-on-surface">
        Two writes, one transaction: the post update and the{' '}
        <span className="font-mono">post.updated</span> outbox row commit together — crash between
        them and BOTH roll back. The relay then ships due rows to the stream and marks them
        published in that order, so a crash after the publish proves at-least-once: the recovery
        run ships the row AGAIN, and the stream shows the same outbox id twice.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            1 · enqueue — the business write + the outbox row, atomically
          </span>
          <span className={CHIP}>POST {BASE}/enqueue</span>
        </div>
        <div className="flex flex-wrap items-end gap-sm">
          <label className="flex w-72 flex-col gap-xxs">
            <span className={LABEL}>new post title</span>
            <input
              data-testid="outbox-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              spellCheck={false}
              className={INPUT}
            />
          </label>
          <label className="flex items-center gap-xs text-body-sm text-on-surface">
            <input
              data-testid="outbox-crash-checkbox"
              type="checkbox"
              checked={crash}
              onChange={(event) => setCrash(event.target.checked)}
            />
            crash between the writes
          </label>
          <button
            type="button"
            data-testid="outbox-enqueue"
            className={BUTTON_PRIMARY}
            disabled={busy !== null}
            onClick={() => void enqueue()}
          >
            enqueue
          </button>
        </div>

        {enqueueResult !== null &&
          (enqueueResult.rolledBack ? (
            <div data-testid="outbox-rollback" className="flex flex-col gap-xxs rounded-md border border-error p-xs">
              <p className="text-caption font-semibold text-error">
                the crash rolled back BOTH writes — no change, no message queued
              </p>
              <p className="text-caption text-on-surface">
                the post kept its title &quot;{enqueueResult.post.title}&quot; and the ledger still has{' '}
                {String(enqueueResult.outboxRowCount)} row(s) — the dual-write problem, solved by the
                transaction.
              </p>
            </div>
          ) : (
            <div data-testid="outbox-enqueued" className="flex flex-col gap-xxs">
              <div className="flex flex-wrap items-center gap-xs">
                <span className={CHIP_STRONG}>enqueued</span>
                <span className={CHIP}>post title now: {enqueueResult.post.title}</span>
                <span className={CHIP}>ledger rows: {String(enqueueResult.outboxRowCount)}</span>
              </div>
              <OutboxRows rows={enqueueResult.outboxRows} />
            </div>
          ))}
      </section>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            2 · run the relay — poll, XADD, mark (in that order)
          </span>
          <span className={CHIP}>POST {BASE}/relay</span>
        </div>
        <div className="flex flex-wrap items-center gap-xs">
          <button
            type="button"
            data-testid="outbox-relay-run"
            className={BUTTON_PRIMARY}
            disabled={busy !== null}
            onClick={() => void relayRun('normal')}
          >
            run the relay
          </button>
          <button
            type="button"
            data-testid="outbox-relay-crash"
            className={BUTTON}
            disabled={busy !== null}
            onClick={() => void relayRun('crashAfterPublish')}
          >
            crash after publish
          </button>
          <button
            type="button"
            data-testid="outbox-relay-fail"
            className={BUTTON}
            disabled={busy !== null}
            onClick={() => void relayRun('failPublish')}
          >
            fail the publish
          </button>
        </div>

        {relay !== null && (
          <div data-testid="outbox-relay-result" className="flex flex-col gap-xxs">
            {relay.crashedAfterPublish !== null && (
              <p data-testid="outbox-crash" className="text-caption text-error">
                crashed AFTER publishing outbox id{' '}
                {String(relay.crashedAfterPublish.outboxId)} — the XADD happened, the mark did not.
                The row is still due, so the next run ships it AGAIN.
              </p>
            )}
            {relay.published.map((entry, index) => (
              <div key={index} data-testid="outbox-published" className="flex flex-wrap items-center gap-xs">
                <span className={CHIP_STRONG}>{entry.entryId}</span>
                <span className={CHIP}>{entry.topic}</span>
                {entry.alreadyDelivered && (
                  <span className={CHIP_WARNING}>already delivered — the duplicate</span>
                )}
                {entry.markedPublished && <span className={CHIP}>marked published</span>}
              </div>
            ))}
            {relay.failedRetries.map((entry, index) => (
              <div key={index} data-testid="outbox-retry" className="flex flex-wrap items-center gap-xs">
                <span className={CHIP_WARNING}>publish failed</span>
                <span className={CHIP}>attempts {String(entry.attempts)}</span>
                {entry.nextAttemptAt !== undefined && (
                  <span className={CHIP}>backs off to {clockOf(entry.nextAttemptAt)}Z</span>
                )}
              </div>
            ))}
            <span className={CHIP}>skipped, not due: {String(relay.skippedNotDue)}</span>
            <OutboxRows rows={relay.rows} />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            3 · the evidence — the ledger and the stream
          </span>
        </div>

        {error !== null && (
          <p data-testid="outbox-error" className="text-caption text-error">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-xxs">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="font-mono text-caption font-semibold text-on-surface">
              the outbox ledger (sqlite — works with no broker at all)
            </span>
            <button
              type="button"
              data-testid="outbox-refresh-ledger"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => void refreshLedger()}
            >
              refresh
            </button>
          </div>
          {!ledger.loaded && (
            <p data-testid="outbox-ledger-idle" className="text-caption text-on-surface-variant">
              not loaded — enqueue something, or refresh.
            </p>
          )}
          {ledger.loaded && ledger.rows.length === 0 && (
            <p className="text-caption text-on-surface-variant">empty — no outbox rows.</p>
          )}
          {ledger.loaded && ledger.rows.length > 0 && <OutboxRows rows={ledger.rows} />}
        </div>

        <div className="flex flex-col gap-xxs">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="font-mono text-caption font-semibold text-on-surface">
              the relay&apos;s stream (where the duplicate shows)
            </span>
            <button
              type="button"
              data-testid="outbox-refresh-stream"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => void refreshStream()}
            >
              refresh
            </button>
          </div>
          {!stream.loaded && (
            <p data-testid="outbox-stream-idle" className="text-caption text-on-surface-variant">
              not loaded — refresh to see what the relay actually shipped.
            </p>
          )}
          {stream.loaded && stream.entries.length === 0 && (
            <p className="text-caption text-on-surface-variant">empty — the relay has shipped nothing.</p>
          )}
          {stream.loaded && stream.entries.length > 0 && (
            <>
              {duplicates.map(([outboxId, count]) => (
                <p
                  key={outboxId}
                  data-testid="outbox-duplicates"
                  className="rounded-md border border-warning bg-warning p-xs text-caption font-semibold text-on-surface"
                >
                  at-least-once, visible: outbox id {outboxId} delivered ×{String(count)} — the same
                  event, twice. Consumers must deduplicate (or be idempotent).
                </p>
              ))}
              {stream.entries.map((entry, index) => (
                <div key={index} data-testid="outbox-stream-entry" className="flex flex-wrap items-center gap-xs">
                  <span className={CHIP_STRONG}>outbox id {String(entry.outboxId)}</span>
                  {entry.id !== undefined && (
                    <span className="font-mono text-caption text-on-surface-variant break-all">
                      {entry.id}
                    </span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        <button
          type="button"
          data-testid="outbox-reset"
          className={BUTTON_DANGER}
          disabled={busy !== null}
          onClick={() => void reset()}
        >
          reset the lab
        </button>
      </section>
    </div>
  );
}
