import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `redis:playground` — the Redis topic's playground over
 * the real endpoints (redis_demo_routes.ts): live status of the OPTIONAL
 * connection (state + target + server version), the structure tour rendered
 * as a command→reply transcript, a TTL key you set and then WATCH count down
 * to nothing, and pub/sub proving delivery through the server's own second
 * connection. With Redis off it degrades to the exact command that turns it
 * on — never an error panel.
 */

const STATUS_URL = '/api/demo/redis/status';
const TOUR_URL = '/api/demo/redis/tour';
const TTL_URL = '/api/demo/redis/ttl';
const PUBLISH_URL = '/api/demo/redis/publish';
const MESSAGES_URL = '/api/demo/redis/messages';

const WATCH_INTERVAL_MS = 1000;

interface RedisStatus {
  configured: boolean;
  connected: boolean;
  host: string;
  serverInfo: { version: string } | null;
  note: string;
}

interface TourStep {
  structure: string;
  command: string;
  reply: string;
  note: string;
}

interface TtlSetResult {
  key: string;
  value: string;
  seconds: number;
  setAt: string;
}

interface TtlPollResult {
  key: string;
  exists: boolean;
  ttlSecondsRemaining: number | null;
  value: string | null;
}

interface ReceivedMessage {
  channel: string;
  message: string;
  receivedAt: string;
}

interface PublishResult {
  channel: string;
  message: string;
  receivers: number;
  received: boolean;
  messages: ReceivedMessage[];
}

type StatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: RedisStatus }
  | { kind: 'failed'; problem: string };

type TourState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; steps: TourStep[] }
  | { kind: 'failed'; problem: string };

type TtlSetState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'failed'; problem: string };

type TtlWatchState =
  | { kind: 'idle' }
  | { kind: 'watching'; poll: TtlPollResult | null }
  | { kind: 'expired' }
  | { kind: 'failed'; problem: string };

type PublishState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'published'; result: PublishResult }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const OFF_COMMAND = 'docker compose -f .docker/docker-compose.yml up -d redis';

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseStatus(value: unknown): RedisStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.note !== 'string') return null;
  return {
    configured: record.configured === true,
    connected: record.connected === true,
    host: typeof record.host === 'string' ? record.host : '',
    serverInfo:
      typeof record.serverInfo === 'object' && record.serverInfo !== null
        ? { version: String((record.serverInfo as { version?: unknown }).version ?? '?') }
        : null,
    note: record.note,
  };
}

function parseTour(value: unknown): TourStep[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const steps = (value as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return null;
  return steps.filter(
    (raw): raw is TourStep =>
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { command?: unknown }).command === 'string' &&
      typeof (raw as { reply?: unknown }).reply === 'string',
  );
}

function parseTtlSet(value: unknown): TtlSetResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== 'string' || typeof record.value !== 'string') return null;
  return {
    key: record.key,
    value: record.value,
    seconds: typeof record.seconds === 'number' ? record.seconds : 10,
    setAt: typeof record.setAt === 'string' ? record.setAt : new Date().toISOString(),
  };
}

function parseTtlPoll(value: unknown): TtlPollResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.exists !== 'boolean') return null;
  return {
    key: typeof record.key === 'string' ? record.key : '?',
    exists: record.exists,
    ttlSecondsRemaining: typeof record.ttlSecondsRemaining === 'number' ? record.ttlSecondsRemaining : null,
    value: typeof record.value === 'string' ? record.value : null,
  };
}

function parseMessages(value: unknown): ReceivedMessage[] {
  if (typeof value !== 'object' || value === null) return [];
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (raw): raw is ReceivedMessage =>
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { channel?: unknown }).channel === 'string' &&
      typeof (raw as { message?: unknown }).message === 'string',
  );
}

function parsePublish(value: unknown): PublishResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.channel !== 'string' || typeof record.message !== 'string') return null;
  return {
    channel: record.channel,
    message: record.message,
    receivers: typeof record.receivers === 'number' ? record.receivers : 0,
    received: record.received === true,
    messages: parseMessages(record),
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') return response.text();
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

/** Reads an error envelope body: code + message (the 503 degradation path). */
async function readErrorEnvelope(response: Response): Promise<string> {
  const text = await readBodyText(response);
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const error = (parsed.value as Record<string, unknown>).error;
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return `${record.code}: ${record.message}`;
    }
  }
  return text;
}

/** The graceful "Redis is off" panel — guidance, never an error. */
function OffPanel({ testId, note }: { testId: string; note: string }): ReactNode {
  return (
    <section
      data-testid={testId}
      className="flex flex-col gap-sm rounded-md border border-outline p-sm"
    >
      <p className="text-body-sm text-on-surface">
        This demo needs the optional redis service — the rest of the guide works without it,
        which is exactly the point of the connection module this topic teaches.
      </p>
      <pre className={PRE}>{OFF_COMMAND}</pre>
      <p className="text-caption text-on-surface-variant">{note}</p>
    </section>
  );
}

export default function RedisPlaygroundDemo(): ReactNode {
  const [statusState, setStatusState] = useState<StatusState>({ kind: 'loading' });
  const [tourState, setTourState] = useState<TourState>({ kind: 'idle' });
  const [ttlSetState, setTtlSetState] = useState<TtlSetState>({ kind: 'idle' });
  const [ttlSeconds, setTtlSeconds] = useState('10');
  const [ttlWatch, setTtlWatch] = useState<TtlWatchState>({ kind: 'idle' });
  const [watching, setWatching] = useState(false);
  const [channel, setChannel] = useState('guide:demo:channel');
  const [message, setMessage] = useState('hello from the playground');
  const [publishState, setPublishState] = useState<PublishState>({ kind: 'idle' });
  const [messageList, setMessageList] = useState<ReceivedMessage[]>([]);
  const aliveRef = useRef(true);
  const watchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (watchTimerRef.current !== null) clearInterval(watchTimerRef.current);
    };
  }, []);

  const loadStatus = (): void => {
    void (async () => {
      try {
        const response = await fetch(STATUS_URL);
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseStatus(parsed.value) : null;
        if (shaped === null) {
          setStatusState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a redis status payload:\n${text}`,
          });
          return;
        }
        setStatusState({ kind: 'ready', status: shaped });
      } catch {
        if (aliveRef.current) {
          setStatusState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // --- structures tour -----------------------------------------------------------

  const runTour = (): void => {
    setTourState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(TOUR_URL);
        if (!aliveRef.current) return;
        if (response.status === 503) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setTourState({ kind: 'failed', problem: envelope });
          return;
        }
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const steps = parsed.ok ? parseTour(parsed.value) : null;
        if (steps === null) {
          setTourState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a tour transcript:\n${text}`,
          });
          return;
        }
        setTourState({ kind: 'ready', steps });
      } catch {
        if (aliveRef.current) {
          setTourState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  // --- TTL set + watch ------------------------------------------------------------

  const stopWatch = (): void => {
    setWatching(false);
    if (watchTimerRef.current !== null) {
      clearInterval(watchTimerRef.current);
      watchTimerRef.current = null;
    }
  };

  const setTtlKey = (): void => {
    stopWatch();
    setTtlWatch({ kind: 'idle' });
    setTtlSetState({ kind: 'sending' });
    void (async () => {
      try {
        const response = await fetch(TTL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seconds: Number(ttlSeconds) || 10 }),
        });
        if (!aliveRef.current) return;
        if (response.status === 503) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setTtlSetState({ kind: 'failed', problem: envelope });
          return;
        }
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseTtlSet(parsed.value) : null;
        if (shaped === null) {
          setTtlSetState({
            kind: 'failed',
            problem: `status ${String(response.status)} — unexpected body:\n${text}`,
          });
          return;
        }
        setTtlSetState({ kind: 'idle' });
        setTtlWatch({ kind: 'watching', poll: { key: shaped.key, exists: true, ttlSecondsRemaining: shaped.seconds, value: shaped.value } });
      } catch {
        if (aliveRef.current) {
          setTtlSetState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const pollTtl = (key: string): void => {
    void (async () => {
      try {
        const response = await fetch(`${TTL_URL}?key=${encodeURIComponent(key)}`);
        if (!aliveRef.current) return;
        if (response.status === 503) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setTtlWatch({ kind: 'failed', problem: envelope });
          return;
        }
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseTtlPoll(parsed.value) : null;
        if (shaped === null) {
          setTtlWatch({ kind: 'failed', problem: `status ${String(response.status)} — unexpected body:\n${text}` });
          return;
        }
        // The moment the server says -2: the key is GONE (the server evicted
        // it; no code of ours ran) — the whole TTL lesson in one flip.
        setTtlWatch(shaped.exists ? { kind: 'watching', poll: shaped } : { kind: 'expired' });
      } catch {
        if (aliveRef.current) {
          setTtlWatch({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const toggleWatch = (): void => {
    if (watching) {
      stopWatch();
      return;
    }
    const key = ttlWatch.kind === 'watching' && ttlWatch.poll !== null ? ttlWatch.poll.key : 'guide:demo:ttl:watch';
    setWatching(true);
    pollTtl(key);
    watchTimerRef.current = setInterval(() => pollTtl(key), WATCH_INTERVAL_MS);
  };

  // --- pub/sub ---------------------------------------------------------------------

  const sendMessage = (): void => {
    setPublishState({ kind: 'sending' });
    void (async () => {
      try {
        const response = await fetch(PUBLISH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: channel.trim(), message: message.trim() }),
        });
        if (!aliveRef.current) return;
        if (response.status === 503) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setPublishState({ kind: 'failed', problem: envelope });
          return;
        }
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parsePublish(parsed.value) : null;
        if (shaped === null) {
          setPublishState({
            kind: 'failed',
            problem: `status ${String(response.status)} — unexpected body:\n${text}`,
          });
          return;
        }
        setPublishState({ kind: 'published', result: shaped });
        setMessageList(shaped.messages);
        // Then poll the messages endpoint — the same list a second consumer
        // would read (the ring of what the server's OWN subscriber received).
        void refreshMessages(shaped.channel);
      } catch {
        if (aliveRef.current) {
          setPublishState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const refreshMessages = (forChannel: string): void => {
    void (async () => {
      try {
        const response = await fetch(`${MESSAGES_URL}?channel=${encodeURIComponent(forChannel)}`);
        if (!aliveRef.current) return;
        if (response.status === 503) return; // the publish result already carries the truth
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        // Only replace the list when the answer really is a messages payload
        // (an envelope or a proxy error must not wipe what publish rendered).
        if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
          const messages = (parsed.value as Record<string, unknown>).messages;
          if (Array.isArray(messages)) setMessageList(parseMessages(parsed.value));
        }
      } catch {
        // The publish result already rendered — a failed refresh is silent.
      }
    })();
  };

  const ready = statusState.kind === 'ready' ? statusState.status : null;
  const redisOff = ready !== null && !ready.connected;
  const tourReady = tourState.kind === 'ready' ? tourState.steps : null;
  const published = publishState.kind === 'published' ? publishState.result : null;
  const watchPoll = ttlWatch.kind === 'watching' ? ttlWatch.poll : null;
  const watchInitial = watchPoll?.ttlSecondsRemaining ?? (Number(ttlSeconds) || 10);
  const watchFraction =
    watchPoll !== null && watchPoll.ttlSecondsRemaining !== null
      ? Math.max(0, Math.min(1, watchPoll.ttlSecondsRemaining / Math.max(1, watchInitial)))
      : 0;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="redis-summary" className="text-body-sm text-on-surface">
        The optional-service playground: live connection state, the structure tour as a real
        command→reply transcript, a key you can watch expire, and pub/sub delivered through the
        server&apos;s own second connection.
      </p>

      {statusState.kind === 'loading' && (
        <p data-testid="redis-status-loading" className="text-body-sm text-on-surface-variant">
          asking the redis connection for its status…
        </p>
      )}
      {statusState.kind === 'failed' && (
        <pre data-testid="redis-status-failed" className={PRE}>
          {statusState.problem}
        </pre>
      )}

      {ready !== null && (
        <div
          data-testid="redis-status"
          className="flex flex-wrap items-center gap-sm rounded-md border border-outline p-sm"
        >
          <span data-testid="redis-status-chip" className={ready.connected ? CHIP_OK : CHIP_ERROR}>
            {ready.connected
              ? 'connected'
              : ready.configured
                ? 'configured but unreachable'
                : 'off — REDIS_URL not set'}
          </span>
          {ready.host !== '' && <span className={CHIP}>{ready.host}</span>}
          {ready.serverInfo !== null && <span className={CHIP}>redis {ready.serverInfo.version}</span>}
          <span className={CHIP}>two connections: commands + subscriber</span>
        </div>
      )}

      {redisOff && <OffPanel testId="redis-off" note={ready?.note ?? ''} />}

      {ready?.connected === true && (
        <>
          <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
            <div className="flex flex-wrap items-center gap-sm">
              <h3 className="font-mono text-body-sm font-semibold text-on-surface">structures — the tour</h3>
              <button
                type="button"
                data-testid="redis-tour-run"
                onClick={runTour}
                disabled={tourState.kind === 'loading'}
                className={BUTTON_PRIMARY}
              >
                {tourState.kind === 'loading' ? 'running…' : 'run the tour'}
              </button>
              <span className="text-caption text-on-surface-variant">
                every command with its REAL reply — run it twice, the transcripts match
              </span>
            </div>

            {tourState.kind === 'loading' && (
              <p data-testid="redis-tour-loading" className="text-body-sm text-on-surface-variant">
                executing SET / INCR / HSET / LPUSH / SADD / ZADD against the live server…
              </p>
            )}
            {tourState.kind === 'failed' && (
              <pre data-testid="redis-tour-failed" className={PRE}>
                {tourState.problem}
              </pre>
            )}

            {tourReady !== null && (
              <div data-testid="redis-tour-table" className="flex flex-col gap-xs">
                {tourReady.map((step) => (
                  <p
                    key={`${step.command}-${step.reply}`}
                    data-testid="redis-tour-row"
                    className="flex flex-wrap items-center gap-xs font-mono text-caption"
                  >
                    <span data-testid="redis-tour-structure" className={CHIP_OK}>
                      {step.structure}
                    </span>
                    <span data-testid="redis-tour-command" className={CHIP}>
                      {step.command}
                    </span>
                    <span data-testid="redis-tour-reply" className="break-all text-on-surface">
                      → {step.reply}
                    </span>
                  </p>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
            <div className="flex flex-wrap items-end gap-sm">
              <h3 className="font-mono text-body-sm font-semibold text-on-surface">TTL — watch a key die</h3>
              <label className="flex flex-col gap-xxs">
                <span className={LABEL}>seconds</span>
                <input
                  data-testid="redis-ttl-seconds"
                  value={ttlSeconds}
                  onChange={(event) => setTtlSeconds(event.target.value)}
                  inputMode="numeric"
                  className={`${INPUT} w-24`}
                />
              </label>
              <button
                type="button"
                data-testid="redis-ttl-set"
                onClick={setTtlKey}
                disabled={ttlSetState.kind === 'sending'}
                className={BUTTON_PRIMARY}
              >
                {ttlSetState.kind === 'sending' ? 'setting…' : 'SET with TTL'}
              </button>
              <button
                type="button"
                data-testid="redis-ttl-watch"
                onClick={toggleWatch}
                disabled={ttlWatch.kind === 'idle'}
                className={BUTTON}
              >
                {watching ? 'stop watching' : 'watch'}
              </button>
              <span className="text-caption text-on-surface-variant">
                the SERVER evicts it — no code of ours runs when it goes
              </span>
            </div>

            {ttlSetState.kind === 'failed' && (
              <pre data-testid="redis-ttl-failed" className={PRE}>
                {ttlSetState.problem}
              </pre>
            )}

            {ttlWatch.kind === 'failed' && (
              <pre data-testid="redis-ttl-watch-failed" className={PRE}>
                {ttlWatch.problem}
              </pre>
            )}

            {watchPoll !== null && (
              <div data-testid="redis-ttl-live" className="flex flex-col gap-xs">
                <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
                  <span className={CHIP}>{watchPoll.key}</span>
                  {watchPoll.value !== null && <span className="text-on-surface">value {watchPoll.value}</span>}
                </p>
                <div
                  data-testid="redis-ttl-bar"
                  className="h-3 w-full overflow-hidden rounded-md border border-outline bg-surface-variant"
                >
                  <div
                    className="h-full bg-primary transition-[width] duration-1000 ease-linear"
                    style={{ width: `${String(Math.round(watchFraction * 100))}%` }}
                  />
                </div>
                <p data-testid="redis-ttl-remaining" className="font-mono text-caption text-on-surface">
                  TTL {watchPoll.ttlSecondsRemaining === null ? '—' : `${String(watchPoll.ttlSecondsRemaining)}s`} remaining
                </p>
              </div>
            )}

            {ttlWatch.kind === 'expired' && (
              <p data-testid="redis-ttl-expired" className="font-mono text-caption font-semibold text-error">
                key expired — TTL returned -2, the key is gone
              </p>
            )}
          </section>

          <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">pub/sub — publish and receive</h3>
            <div className="flex flex-col gap-xs sm:flex-row">
              <label className="flex flex-1 flex-col gap-xxs">
                <span className={LABEL}>channel</span>
                <input
                  data-testid="redis-publish-channel"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                  spellCheck={false}
                  className={INPUT}
                />
              </label>
              <label className="flex flex-1 flex-col gap-xxs">
                <span className={LABEL}>message</span>
                <input
                  data-testid="redis-publish-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  spellCheck={false}
                  className={INPUT}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-sm">
              <button
                type="button"
                data-testid="redis-publish-send"
                onClick={sendMessage}
                disabled={publishState.kind === 'sending' || channel.trim() === '' || message.trim() === ''}
                className={BUTTON_PRIMARY}
              >
                {publishState.kind === 'sending' ? 'publishing…' : 'PUBLISH'}
              </button>
              <span className="text-caption text-on-surface-variant">
                the server&apos;s own second connection (the subscriber) is listening — it proves delivery
              </span>
            </div>

            {publishState.kind === 'failed' && (
              <pre data-testid="redis-publish-failed" className={PRE}>
                {publishState.problem}
              </pre>
            )}

            {published !== null && (
              <div data-testid="redis-publish-result" className="flex flex-wrap items-center gap-xs font-mono text-caption">
                <span className={published.received ? CHIP_OK : CHIP_ERROR}>
                  {String(published.receivers)} receiver{published.receivers === 1 ? '' : 's'}
                </span>
                <span className={published.received ? CHIP_OK : CHIP_ERROR}>
                  {published.received ? 'our subscriber got it' : 'our subscriber did NOT get it'}
                </span>
              </div>
            )}

            {published !== null && (
              <div data-testid="redis-messages" className="flex flex-col gap-xs">
                {messageList.map((entry, index) => (
                  <p
                    key={`${entry.channel}-${entry.message}-${String(index)}`}
                    data-testid="redis-message-entry"
                    className="flex flex-wrap items-center gap-xs font-mono text-caption"
                  >
                    <span className={CHIP_OK}>{entry.channel}</span>
                    <span className="text-on-surface">{entry.message}</span>
                    <span className="text-on-surface-variant">received {entry.receivedAt}</span>
                  </p>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
