import { useCallback, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `msg:stream` — the Redis Streams console. A sequenced
 * control panel over the real stream-lab endpoints: every button IS a Redis
 * command in HTTP clothing — produce (XADD, MAXLEN-trimmed), consume as a
 * worker (XREADGROUP '>' with the ack knob and a simulated failure that drives
 * requeue → DLQ), inspect the pending-entries list (XPENDING with idle and
 * delivery counts), reclaim stale pending work (XAUTOCLAIM — the visibility
 * timeout), list the dead-letter stream, and XINFO stats. Every call appends
 * an entry to the event log with its evidence — newest first, like watching a
 * worker's console.
 */

const BASE = '/api/demo/msg/stream';

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
const STEP_ROW = 'flex flex-wrap items-center gap-xs rounded-md border border-outline p-xs';
const STEP_NUM = 'font-mono text-caption font-bold text-on-surface-variant';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const MALFORMED = 'malformed payload';

type ConsumeOutcome = 'acked' | 'requeued' | 'left-pending' | 'dead-lettered';

interface StreamFields {
  payload?: unknown;
  retryCount?: number;
  originalId?: string;
  reason?: string;
}

interface ProduceBody {
  id: string;
  streamLength: number;
  maxlen?: string;
  note: string;
  fields: StreamFields | null;
}

interface ConsumeMessage {
  outcome: ConsumeOutcome;
  fields: StreamFields | null;
}

interface ConsumeBody {
  consumer: string;
  empty: boolean;
  attempts: number;
  messages: ConsumeMessage[];
  note: string;
}

interface PendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveries: number;
}

interface PendingBody {
  note: string;
  summary: { total: number; perConsumer: { consumer: string; count: number }[] };
  entries: PendingEntry[];
}

interface ReclaimBody {
  note: string;
  reclaimed: { acked: boolean; fields: StreamFields | null }[];
}

interface DlqEntry {
  id?: string;
  fields: StreamFields;
}

interface DlqBody {
  note: string;
  entries: DlqEntry[];
}

interface InfoBody {
  note: string;
  streamLength: number;
  dlqLength: number;
  groups: { name: string; pending: number; consumers: number }[];
}

type LogDetail =
  | { kind: 'produce'; body: ProduceBody }
  | { kind: 'consume'; body: ConsumeBody }
  | { kind: 'pending'; body: PendingBody }
  | { kind: 'reclaim'; body: ReclaimBody }
  | { kind: 'dlq'; body: DlqBody }
  | { kind: 'info'; body: InfoBody }
  | { kind: 'plain'; note: string };

interface LogEntry {
  seq: number;
  clock: string;
  action: string;
  summary: string;
  failed: boolean;
  detail: LogDetail;
}

const OUTCOME_CHIP: Record<ConsumeOutcome, string> = {
  acked: 'rounded-md border border-secondary bg-secondary px-xs py-xxs font-mono text-caption font-semibold text-on-secondary',
  requeued: 'rounded-md border border-warning bg-warning px-xs py-xxs font-mono text-caption font-bold text-on-surface',
  'left-pending': 'rounded-md border border-warning px-xs py-xxs font-mono text-caption font-semibold text-on-surface',
  'dead-lettered': 'rounded-md border border-error bg-error px-xs py-xxs font-mono text-caption font-bold text-on-error',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNote(raw: unknown): string {
  return isRecord(raw) && typeof raw.note === 'string' ? raw.note : '';
}

function parseFields(raw: unknown): StreamFields | null {
  if (!isRecord(raw)) return null;
  const fields: StreamFields = {};
  if ('payload' in raw) fields.payload = raw.payload;
  if (typeof raw.retryCount === 'number') fields.retryCount = raw.retryCount;
  if (typeof raw.originalId === 'string') fields.originalId = raw.originalId;
  if (typeof raw.reason === 'string') fields.reason = raw.reason;
  return fields;
}

function parseProduce(raw: unknown): ProduceBody | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.streamLength !== 'number') return null;
  return {
    id: raw.id,
    streamLength: raw.streamLength,
    maxlen: typeof raw.maxlen === 'string' ? raw.maxlen : undefined,
    note: readNote(raw),
    fields: parseFields(raw.fields),
  };
}

function parseConsume(raw: unknown): ConsumeBody | null {
  if (!isRecord(raw) || !Array.isArray(raw.messages)) return null;
  const messages = raw.messages
    .filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        (entry.outcome === 'acked' ||
          entry.outcome === 'requeued' ||
          entry.outcome === 'left-pending' ||
          entry.outcome === 'dead-lettered'),
    )
    .map((entry) => ({
      outcome: entry.outcome as ConsumeOutcome,
      fields: parseFields(entry.fields),
    }));
  return {
    consumer: typeof raw.consumer === 'string' ? raw.consumer : '?',
    empty: typeof raw.empty === 'boolean' ? raw.empty : messages.length === 0,
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    messages,
    note: readNote(raw),
  };
}

function parsePending(raw: unknown): PendingBody | null {
  if (!isRecord(raw) || !isRecord(raw.summary) || !Array.isArray(raw.entries)) return null;
  const perConsumerRaw = raw.summary.perConsumer;
  const perConsumer = Array.isArray(perConsumerRaw)
    ? perConsumerRaw.filter(
        (entry): entry is { consumer: string; count: number } =>
          isRecord(entry) && typeof entry.consumer === 'string' && typeof entry.count === 'number',
      )
    : [];
  const entries = raw.entries.filter(
    (entry): entry is PendingEntry =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.consumer === 'string' &&
      typeof entry.idleMs === 'number' &&
      typeof entry.deliveries === 'number',
  );
  return {
    note: readNote(raw),
    summary: {
      total: typeof raw.summary.total === 'number' ? raw.summary.total : entries.length,
      perConsumer,
    },
    entries,
  };
}

function parseReclaim(raw: unknown): ReclaimBody | null {
  if (!isRecord(raw) || !Array.isArray(raw.reclaimed)) return null;
  const reclaimed = raw.reclaimed
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => ({ acked: entry.acked === true, fields: parseFields(entry.fields) }));
  return { note: readNote(raw), reclaimed };
}

function parseDlq(raw: unknown): DlqBody | null {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return null;
  const entries = raw.entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && isRecord(entry.fields))
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : undefined,
      fields: parseFields(entry.fields) ?? {},
    }));
  return { note: readNote(raw), entries };
}

function parseInfo(raw: unknown): InfoBody | null {
  if (!isRecord(raw) || !isRecord(raw.stream) || !isRecord(raw.dlq) || !Array.isArray(raw.groups)) {
    return null;
  }
  const groups = raw.groups.filter(
    (entry): entry is { name: string; pending: number; consumers: number } =>
      isRecord(entry) &&
      typeof entry.name === 'string' &&
      typeof entry.pending === 'number' &&
      typeof entry.consumers === 'number',
  );
  return {
    note: readNote(raw),
    streamLength: typeof raw.stream.length === 'number' ? raw.stream.length : 0,
    dlqLength: typeof raw.dlq.length === 'number' ? raw.dlq.length : 0,
    groups,
  };
}

function clockNow(): string {
  return new Date().toISOString().slice(11, 19);
}

function payloadText(payload: unknown): string {
  if (payload === undefined) return '(no payload)';
  const text = typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? 'null');
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
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

function Note({ text }: { text: string }): ReactNode {
  return <p className="text-caption text-on-surface-variant">{text}</p>;
}

function renderDetail(detail: LogDetail): ReactNode {
  switch (detail.kind) {
    case 'produce': {
      const body = detail.body;
      return (
        <div className="flex flex-col gap-xxs">
          <div className="flex flex-wrap items-center gap-xs">
            <span className={CHIP_STRONG}>{body.id}</span>
            <span className={CHIP}>stream length {String(body.streamLength)}</span>
            {body.maxlen !== undefined && <span className={CHIP}>MAXLEN {body.maxlen}</span>}
          </div>
          {body.fields !== null && (
            <p className="font-mono text-caption text-on-surface-variant break-all">
              payload: {payloadText(body.fields.payload)}
            </p>
          )}
          {body.note !== '' && <Note text={body.note} />}
        </div>
      );
    }
    case 'consume': {
      const body = detail.body;
      return (
        <div className="flex flex-col gap-xxs">
          <div className="flex flex-wrap items-center gap-xs">
            <span className={CHIP}>worker {body.consumer}</span>
            <span className={CHIP}>retry budget {String(body.attempts)}</span>
          </div>
          {body.empty && (
            <p className="text-caption text-on-surface">
              nothing new — {'>'} only hands out first deliveries, and this group already had them.
            </p>
          )}
          {body.messages.map((message, index) => (
            <div key={index} className="flex flex-wrap items-center gap-xs">
              <span className={OUTCOME_CHIP[message.outcome]}>{message.outcome}</span>
              <span className="font-mono text-caption text-on-surface-variant break-all">
                {payloadText(message.fields?.payload)}
              </span>
              {message.fields?.retryCount !== undefined && (
                <span className={CHIP}>retryCount {String(message.fields.retryCount)}</span>
              )}
            </div>
          ))}
          {body.note !== '' && <Note text={body.note} />}
        </div>
      );
    }
    case 'pending': {
      const body = detail.body;
      return (
        <div className="flex flex-col gap-xxs">
          <div className="flex flex-wrap items-center gap-xs">
            <span className={CHIP_STRONG}>PEL total {String(body.summary.total)}</span>
            {body.summary.perConsumer.map((entry) => (
              <span key={entry.consumer} className={CHIP}>
                {entry.consumer} ×{String(entry.count)}
              </span>
            ))}
          </div>
          {body.entries.length === 0 && (
            <p className="text-caption text-on-surface">
              no pending entries — every delivered message was acknowledged (or reclaimed).
            </p>
          )}
          {body.entries.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-xs">
              <span className="font-mono text-caption text-on-surface break-all">{entry.id}</span>
              <span className={CHIP}>held by {entry.consumer}</span>
              <span className={CHIP}>idle {String(entry.idleMs)}ms</span>
              <span className={CHIP}>delivered ×{String(entry.deliveries)}</span>
            </div>
          ))}
          {body.note !== '' && <Note text={body.note} />}
        </div>
      );
    }
    case 'reclaim': {
      const body = detail.body;
      return (
        <div className="flex flex-col gap-xxs">
          {body.reclaimed.length === 0 && (
            <p className="text-caption text-on-surface">
              nothing was idle long enough — consume with ack unchecked first, or lower the threshold.
            </p>
          )}
          {body.reclaimed.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-xs">
              <span className={OUTCOME_CHIP.acked}>{row.acked ? 'claimed + acked' : 'claimed'}</span>
              <span className="font-mono text-caption text-on-surface-variant break-all">
                {payloadText(row.fields?.payload)}
              </span>
            </div>
          ))}
          {body.note !== '' && <Note text={body.note} />}
        </div>
      );
    }
    case 'dlq': {
      const body = detail.body;
      return (
        <div className="flex flex-col gap-xxs">
          {body.entries.length === 0 && (
            <p className="text-caption text-on-surface">
              the DLQ is empty — no message has spent its retry budget yet.
            </p>
          )}
          {body.entries.map((entry, index) => (
            <div
              key={entry.id ?? index}
              className="flex flex-col gap-xxs rounded-md border border-outline p-xs"
            >
              <div className="flex flex-wrap items-center gap-xs">
                <span className={CHIP_STRONG}>{entry.id ?? 'dlq entry'}</span>
                {entry.fields.retryCount !== undefined && (
                  <span className={CHIP}>attempts {String(entry.fields.retryCount)}</span>
                )}
              </div>
              <p className="font-mono text-caption text-on-surface break-all">
                {payloadText(entry.fields.payload)}
              </p>
              {entry.fields.originalId !== undefined && (
                <p className="font-mono text-caption text-on-surface-variant break-all">
                  original id {entry.fields.originalId}
                </p>
              )}
              {entry.fields.reason !== undefined && (
                <p className="text-caption text-error">{entry.fields.reason}</p>
              )}
            </div>
          ))}
          {body.note !== '' && <Note text={body.note} />}
        </div>
      );
    }
    case 'info': {
      const body = detail.body;
      return (
        <div className="flex flex-col gap-xxs">
          <div className="flex flex-wrap items-center gap-xs">
            <span className={CHIP_STRONG}>stream length {String(body.streamLength)}</span>
            <span className={CHIP}>dlq length {String(body.dlqLength)}</span>
            {body.groups.map((group) => (
              <span key={group.name} className={CHIP}>
                group {group.name} · pending {String(group.pending)} · consumers{' '}
                {String(group.consumers)}
              </span>
            ))}
          </div>
          {body.note !== '' && <Note text={body.note} />}
        </div>
      );
    }
    case 'plain':
      return detail.note !== '' ? <Note text={detail.note} /> : null;
  }
}

export default function StreamConsoleDemo(): ReactNode {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('hello from the stream lab');
  const [consumer, setConsumer] = useState('w1');
  const [ack, setAck] = useState(true);
  const [fail, setFail] = useState(false);
  const [minIdleMs, setMinIdleMs] = useState('10');
  const seqRef = useRef(0);

  const appendLog = useCallback(
    (action: string, summary: string, detail: LogDetail, failed: boolean): void => {
      seqRef.current += 1;
      setLog((previous) => [
        { seq: seqRef.current, clock: clockNow(), action, summary, failed, detail },
        ...previous,
      ]);
    },
    [],
  );

  const run = useCallback(
    async (key: string, action: string, execute: () => Promise<{ summary: string; detail: LogDetail }>): Promise<void> => {
      setBusy(key);
      setError(null);
      try {
        const outcome = await execute();
        appendLog(action, outcome.summary, outcome.detail, false);
      } catch (cause) {
        const malformed = cause instanceof Error && cause.message === MALFORMED;
        setError(
          malformed
            ? 'the lab answered with a malformed payload'
            : 'the stream lab is unreachable — is redis up and the server running?',
        );
        appendLog(
          action,
          'the call failed',
          { kind: 'plain', note: malformed ? 'malformed response payload' : 'the request never completed' },
          true,
        );
      } finally {
        setBusy(null);
      }
    },
    [appendLog],
  );

  const consumerName = consumer.trim();

  const produce = useCallback((): Promise<void> => {
    const trimmed = message.trim();
    return run('produce', 'XADD — produce', async () => {
      const raw = await callEndpoint(`${BASE}/produce`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(trimmed === '' ? {} : { message: trimmed }),
      });
      const parsed = parseProduce(raw);
      if (parsed === null) throw new Error(MALFORMED);
      return {
        summary: `appended ${parsed.id} (stream length ${String(parsed.streamLength)})`,
        detail: { kind: 'produce', body: parsed },
      };
    });
  }, [message, run]);

  const consume = useCallback((): Promise<void> => {
    return run('consume', "XREADGROUP '>' — consume", async () => {
      const raw = await callEndpoint(`${BASE}/consume`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ consumer: consumerName === '' ? 'w1' : consumerName, ack, fail }),
      });
      const parsed = parseConsume(raw);
      if (parsed === null) throw new Error(MALFORMED);
      return {
        summary:
          parsed.empty || parsed.messages.length === 0
            ? 'nothing new to deliver'
            : `${String(parsed.messages.length)} message(s): ${parsed.messages
                .map((entry) => entry.outcome)
                .join(', ')}`,
        detail: { kind: 'consume', body: parsed },
      };
    });
  }, [ack, consumerName, fail, run]);

  const inspectPending = useCallback((): Promise<void> => {
    return run('pending', 'XPENDING — inspect', async () => {
      const url =
        consumerName === '' ? `${BASE}/pending` : `${BASE}/pending?consumer=${encodeURIComponent(consumerName)}`;
      const raw = await callEndpoint(url);
      const parsed = parsePending(raw);
      if (parsed === null) throw new Error(MALFORMED);
      return {
        summary: `${String(parsed.summary.total)} pending entr${parsed.summary.total === 1 ? 'y' : 'ies'}`,
        detail: { kind: 'pending', body: parsed },
      };
    });
  }, [consumerName, run]);

  const reclaim = useCallback((): Promise<void> => {
    return run('reclaim', 'XAUTOCLAIM — reclaim', async () => {
      const idle = Number(minIdleMs.trim());
      const raw = await callEndpoint(`${BASE}/reclaim`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          minIdleMs: Number.isInteger(idle) && idle >= 1 ? idle : 1,
          ...(consumerName !== '' && { consumer: consumerName }),
        }),
      });
      const parsed = parseReclaim(raw);
      if (parsed === null) throw new Error(MALFORMED);
      return {
        summary: `reclaimed ${String(parsed.reclaimed.length)} stale entr${parsed.reclaimed.length === 1 ? 'y' : 'ies'}`,
        detail: { kind: 'reclaim', body: parsed },
      };
    });
  }, [consumerName, minIdleMs, run]);

  const listDlq = useCallback((): Promise<void> => {
    return run('dlq', 'XRANGE — the DLQ', async () => {
      const raw = await callEndpoint(`${BASE}/dlq`);
      const parsed = parseDlq(raw);
      if (parsed === null) throw new Error(MALFORMED);
      return {
        summary: `${String(parsed.entries.length)} dead-lettered entr${parsed.entries.length === 1 ? 'y' : 'ies'}`,
        detail: { kind: 'dlq', body: parsed },
      };
    });
  }, [run]);

  const info = useCallback((): Promise<void> => {
    return run('info', 'XINFO — stats', async () => {
      const raw = await callEndpoint(`${BASE}/info`);
      const parsed = parseInfo(raw);
      if (parsed === null) throw new Error(MALFORMED);
      return {
        summary: `stream ${String(parsed.streamLength)} · dlq ${String(parsed.dlqLength)} · ${String(parsed.groups.length)} group(s)`,
        detail: { kind: 'info', body: parsed },
      };
    });
  }, [run]);

  const reset = useCallback((): Promise<void> => {
    return run('reset', 'DEL + XGROUP — reset', async () => {
      const raw = await callEndpoint(`${BASE}/reset`, { method: 'POST' });
      const note = readNote(raw);
      setLog([]);
      return { summary: 'the lab is virgin again', detail: { kind: 'plain', note } };
    });
  }, [run]);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="stream-summary" className="text-body-sm text-on-surface">
        A real Redis stream and a real consumer group. Produce with{' '}
        <span className="font-mono">XADD</span>, work entries with{' '}
        <span className="font-mono">XREADGROUP &apos;&gt;&apos;</span> — and when a worker dies before{' '}
        <span className="font-mono">XACK</span>, XPENDING names the orphan and XAUTOCLAIM reclaims it
        after its idle threshold. A poison message spends its retry budget and moves to the DLQ —
        moved, not lost.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            the control panel — one button per Redis command
          </span>
          <span className={CHIP}>{BASE}</span>
        </div>

        <label className="flex w-72 flex-col gap-xxs">
          <span className={LABEL}>worker identity (the consumer name)</span>
          <input
            data-testid="stream-consumer"
            value={consumer}
            onChange={(event) => setConsumer(event.target.value)}
            spellCheck={false}
            className={INPUT}
          />
        </label>

        <ol className="flex flex-col gap-xs">
          <li className={STEP_ROW}>
            <span className={STEP_NUM}>1</span>
            <span className="text-body-sm text-on-surface">produce — XADD appends to the log</span>
            <input
              data-testid="stream-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              spellCheck={false}
              className={`${INPUT} w-72`}
            />
            <button
              type="button"
              data-testid="stream-produce"
              className={BUTTON_PRIMARY}
              disabled={busy !== null}
              onClick={() => void produce()}
            >
              produce
            </button>
          </li>
          <li className={STEP_ROW}>
            <span className={STEP_NUM}>2</span>
            <span className="text-body-sm text-on-surface">
              consume — XREADGROUP &apos;&gt;&apos; as that worker
            </span>
            <label className="flex items-center gap-xs text-body-sm text-on-surface">
              <input
                data-testid="stream-ack"
                type="checkbox"
                checked={ack}
                onChange={(event) => setAck(event.target.checked)}
              />
              ack
            </label>
            <label className="flex items-center gap-xs text-body-sm text-on-surface">
              <input
                data-testid="stream-fail"
                type="checkbox"
                checked={fail}
                onChange={(event) => setFail(event.target.checked)}
              />
              fail processing
            </label>
            <button
              type="button"
              data-testid="stream-consume"
              className={BUTTON_PRIMARY}
              disabled={busy !== null}
              onClick={() => void consume()}
            >
              consume
            </button>
          </li>
          <li className={STEP_ROW}>
            <span className={STEP_NUM}>3</span>
            <span className="text-body-sm text-on-surface">
              pending — XPENDING, the group&apos;s pending-entries list
            </span>
            <button
              type="button"
              data-testid="stream-pending"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => void inspectPending()}
            >
              inspect pending
            </button>
          </li>
          <li className={STEP_ROW}>
            <span className={STEP_NUM}>4</span>
            <span className="text-body-sm text-on-surface">
              reclaim — XAUTOCLAIM takes over entries idle long enough
            </span>
            <label className="flex w-44 flex-col gap-xxs">
              <span className={LABEL}>min idle (ms)</span>
              <input
                data-testid="stream-min-idle"
                value={minIdleMs}
                onChange={(event) => setMinIdleMs(event.target.value)}
                inputMode="numeric"
                className={INPUT}
              />
            </label>
            <button
              type="button"
              data-testid="stream-reclaim"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => void reclaim()}
            >
              reclaim stale
            </button>
          </li>
          <li className={STEP_ROW}>
            <span className={STEP_NUM}>5</span>
            <span className="text-body-sm text-on-surface">DLQ — XRANGE over the dead-letter stream</span>
            <button
              type="button"
              data-testid="stream-dlq"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => void listDlq()}
            >
              list the DLQ
            </button>
          </li>
          <li className={STEP_ROW}>
            <span className={STEP_NUM}>6</span>
            <span className="text-body-sm text-on-surface">
              info — XINFO STREAM + XINFO GROUPS
            </span>
            <button
              type="button"
              data-testid="stream-info"
              className={BUTTON}
              disabled={busy !== null}
              onClick={() => void info()}
            >
              stream stats
            </button>
          </li>
        </ol>

        {error !== null && (
          <p data-testid="stream-error" className="text-caption text-error">
            {error}
          </p>
        )}

        <button
          type="button"
          data-testid="stream-reset"
          className={BUTTON_DANGER}
          disabled={busy !== null}
          onClick={() => void reset()}
        >
          reset the lab
        </button>
      </section>

      <section
        data-testid="stream-log"
        className="flex max-h-72 flex-col gap-sm overflow-y-auto rounded-md border border-outline bg-surface p-sm"
      >
        <span className="text-caption font-semibold text-on-surface">the event log (newest first)</span>
        {log.length === 0 && (
          <p data-testid="stream-idle" className="text-caption text-on-surface-variant">
            no commands yet — every call you make lands here with its evidence.
          </p>
        )}
        {log.map((entry) => (
          <div
            key={entry.seq}
            data-testid="stream-log-entry"
            className={`flex flex-col gap-xxs rounded-md border p-xs ${entry.failed ? 'border-error' : 'border-outline'}`}
          >
            <div className="flex flex-wrap items-baseline gap-xs">
              <span className="font-mono text-caption text-on-surface-variant">{entry.clock}Z</span>
              <span
                className={`font-mono text-caption font-semibold ${entry.failed ? 'text-error' : 'text-on-surface'}`}
              >
                {entry.action}
              </span>
              <span className="text-caption text-on-surface-variant">{entry.summary}</span>
            </div>
            {renderDetail(entry.detail)}
          </div>
        ))}
      </section>
    </div>
  );
}
