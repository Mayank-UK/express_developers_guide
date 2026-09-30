import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:mongo-console` — the MongoDB topic's console over
 * the real endpoints (mongo_demo_routes.ts): live status of the OPTIONAL
 * connection (state + host/db target + the index list read from the server),
 * an event form proving schema validation and Mixed meta through HTTP, the
 * newest-first list with per-event AGE (making the 60-second TTL index
 * visible), stats, and a clear button. With Mongo off it degrades to the
 * exact command that turns it on — never an error panel.
 */

const STATUS_URL = '/api/demo/mongo/status';
const EVENTS_URL = '/api/demo/mongo/events';

const KINDS = ['visit', 'click', 'error', 'custom'] as const;

interface MongoStatus {
  configured: boolean;
  connected: boolean;
  connectionState: string;
  uri: string;
  model: string;
  indexes: { name: string; key: Record<string, unknown>; expireAfterSeconds?: number }[];
  note: string;
}

interface EventItem {
  id: string;
  kind: string;
  page: string;
  visitor: string;
  meta: unknown;
  createdAt: string;
  updatedAt: string;
}

interface EventStats {
  count: number;
  oldest: string | null;
  newest: string | null;
  ttlSeconds: number;
  ttlIndex: string | null;
}

type StatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: MongoStatus }
  | { kind: 'failed'; problem: string };

type ListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; events: EventItem[]; stats: EventStats }
  | { kind: 'failed'; problem: string };

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'created'; event: EventItem }
  | { kind: 'invalid'; message: string; errors: { field: string; message: string }[] }
  | { kind: 'unavailable'; message: string }
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
const OFF_COMMAND = 'docker compose -f .docker/docker-compose.yml up -d mongo';

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseStatus(value: unknown): MongoStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== 'string' || typeof record.note !== 'string') return null;
  return {
    configured: record.configured === true,
    connected: record.connected === true,
    connectionState: typeof record.connectionState === 'string' ? record.connectionState : '?',
    uri: typeof record.uri === 'string' ? record.uri : '',
    model: record.model,
    indexes: Array.isArray(record.indexes)
      ? record.indexes.filter(
          (raw): raw is MongoStatus['indexes'][number] =>
            typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string',
        )
      : [],
    note: record.note,
  };
}

function parseEvent(value: unknown): EventItem | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.kind !== 'string' ||
    typeof record.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id: record.id,
    kind: record.kind,
    page: typeof record.page === 'string' ? record.page : '?',
    visitor: typeof record.visitor === 'string' ? record.visitor : '?',
    meta: record.meta,
    createdAt: record.createdAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : record.createdAt,
  };
}

function parseList(value: unknown): { events: EventItem[]; stats: EventStats } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.events)) return null;
  const events = record.events
    .map(parseEvent)
    .filter((event): event is EventItem => event !== null);

  const rawStats =
    typeof record.stats === 'object' && record.stats !== null
      ? (record.stats as Record<string, unknown>)
      : null;
  const stats: EventStats = {
    count: typeof rawStats?.count === 'number' ? rawStats.count : events.length,
    oldest: typeof rawStats?.oldest === 'string' ? rawStats.oldest : null,
    newest: typeof rawStats?.newest === 'string' ? rawStats.newest : null,
    ttlSeconds: typeof rawStats?.ttlSeconds === 'number' ? rawStats.ttlSeconds : 60,
    ttlIndex: typeof rawStats?.ttlIndex === 'string' ? rawStats.ttlIndex : null,
  };
  return { events, stats };
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

/** Reads an error envelope body: code/message plus the optional errors[] details. */
async function readErrorEnvelope(
  response: Response,
): Promise<{ code: string; message: string; errors: { field: string; message: string }[] }> {
  const text = await readBodyText(response);
  const parsed = tryParseJson(text);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return { code: `status ${String(response.status)}`, message: text, errors: [] };
  }
  const error = (parsed.value as Record<string, unknown>).error;
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  return {
    code: typeof record.code === 'string' ? record.code : `status ${String(response.status)}`,
    message: typeof record.message === 'string' ? record.message : text,
    errors: Array.isArray(record.errors)
      ? record.errors.filter(
          (raw): raw is { field: string; message: string } =>
            typeof raw === 'object' && raw !== null && typeof (raw as { field?: unknown }).field === 'string',
        )
      : [],
  };
}

function ageSeconds(createdAtIso: string, now: number): number {
  const parsed = Date.parse(createdAtIso);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((now - parsed) / 1000));
}

function previewMeta(meta: unknown): string {
  const text = JSON.stringify(meta);
  if (text === undefined) return 'undefined';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** The graceful "Mongo is off" panel — guidance, never an error. */
function OffPanel({ testId, note }: { testId: string; note: string }): ReactNode {
  return (
    <section
      data-testid={testId}
      className="flex flex-col gap-sm rounded-md border border-outline p-sm"
    >
      <p className="text-body-sm text-on-surface">
        This demo needs the optional mongo service — the rest of the guide works without it,
        which is exactly the point of the connection module this topic teaches.
      </p>
      <pre className={PRE}>{OFF_COMMAND}</pre>
      <p className="text-caption text-on-surface-variant">{note}</p>
    </section>
  );
}

export default function MongoConsoleDemo(): ReactNode {
  const [statusState, setStatusState] = useState<StatusState>({ kind: 'loading' });
  const [listState, setListState] = useState<ListState>({ kind: 'idle' });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });
  const [kind, setKind] = useState<(typeof KINDS)[number]>('visit');
  const [page, setPage] = useState('/topics/mongodb');
  const [visitor, setVisitor] = useState('you');
  const [meta, setMeta] = useState('{\n  "from": "console"\n}');
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
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
            problem: `status ${String(response.status)} — the answer was not a mongo status payload:\n${text}`,
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

  const loadEvents = (): void => {
    setListState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(EVENTS_URL);
        if (!aliveRef.current) return;
        if (response.status === 503) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setListState({ kind: 'failed', problem: `${envelope.code}: ${envelope.message}` });
          return;
        }
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseList(parsed.value) : null;
        if (shaped === null) {
          setListState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not an events payload:\n${text}`,
          });
          return;
        }
        setListState({ kind: 'ready', events: shaped.events, stats: shaped.stats });
      } catch {
        if (aliveRef.current) {
          setListState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const refreshAll = (): void => {
    loadStatus();
    loadEvents();
  };

  useEffect(() => {
    // Mount: status first; only chase the list when the connection is live.
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
            problem: `status ${String(response.status)} — the answer was not a mongo status payload:\n${text}`,
          });
          return;
        }
        setStatusState({ kind: 'ready', status: shaped });
        if (shaped.connected) loadEvents();
      } catch {
        if (aliveRef.current) {
          setStatusState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  }, []);

  const submitEvent = (): void => {
    setSubmitState({ kind: 'sending' });
    void (async () => {
      // meta is Mixed: parsed JSON when it parses, otherwise the raw string —
      // the server accepts either, and seeing both is part of the lesson.
      const parsedMeta = tryParseJson(meta.trim());
      const metaValue = parsedMeta.ok ? parsedMeta.value : meta.trim();
      try {
        const response = await fetch(EVENTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, page, visitor, meta: metaValue }),
        });
        if (!aliveRef.current) return;

        if (response.status === 503) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setSubmitState({ kind: 'unavailable', message: `${envelope.code}: ${envelope.message}` });
          return;
        }
        if (response.status === 400) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setSubmitState({ kind: 'invalid', message: envelope.message, errors: envelope.errors });
          return;
        }

        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const event =
          parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
            ? parseEvent((parsed.value as Record<string, unknown>).event)
            : null;
        if (event === null) {
          setSubmitState({
            kind: 'failed',
            problem: `status ${String(response.status)} — unexpected body:\n${text}`,
          });
          return;
        }
        setSubmitState({ kind: 'created', event });
        loadEvents(); // show the new event at the top of the list
      } catch {
        if (aliveRef.current) {
          setSubmitState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const clearEvents = (): void => {
    void (async () => {
      try {
        const response = await fetch(EVENTS_URL, { method: 'DELETE' });
        if (!aliveRef.current) return;
        if (response.status === 503) {
          const envelope = await readErrorEnvelope(response);
          if (!aliveRef.current) return;
          setListState({ kind: 'failed', problem: `${envelope.code}: ${envelope.message}` });
          return;
        }
        loadEvents();
      } catch {
        if (aliveRef.current) {
          setListState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const ready = statusState.kind === 'ready' ? statusState.status : null;
  const mongoOff = ready !== null && !ready.connected;
  const now = Date.now();
  const listReady = listState.kind === 'ready' ? listState : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="mongo-console-summary" className="text-body-sm text-on-surface">
        The optional-service console: live connection state, real schema validation through HTTP, the
        newest-first query, and a 60-second TTL index you can watch delete your documents.
      </p>

      {statusState.kind === 'loading' && (
        <p data-testid="mongo-console-loading" className="text-body-sm text-on-surface-variant">
          asking the mongo connection for its status…
        </p>
      )}
      {statusState.kind === 'failed' && (
        <pre data-testid="mongo-console-status-failed" className={PRE}>
          {statusState.problem}
        </pre>
      )}

      {ready !== null && (
        <div
          data-testid="mongo-console-status"
          className="flex flex-wrap items-center gap-sm rounded-md border border-outline p-sm"
        >
          <span data-testid="mongo-console-connection-chip" className={ready.connected ? CHIP_OK : CHIP_ERROR}>
            {ready.connected
              ? `connected · ${ready.connectionState}`
              : ready.configured
                ? 'configured but unreachable'
                : 'off — MONGO_URI not set'}
          </span>
          {ready.uri !== '' && <span className={CHIP}>{ready.uri}</span>}
          <span className={CHIP}>model: {ready.model}</span>
          {ready.connected &&
            ready.indexes.map((index) => (
              <span
                key={index.name}
                data-testid="mongo-console-index-chip"
                className={index.expireAfterSeconds !== undefined ? CHIP_OK : CHIP}
              >
                {index.name}
                {index.expireAfterSeconds !== undefined
                  ? ` · TTL ${String(index.expireAfterSeconds)}s`
                  : ''}
              </span>
            ))}
        </div>
      )}

      {mongoOff && <OffPanel testId="mongo-console-off" note={ready?.note ?? ''} />}

      {ready?.connected === true && (
        <>
          <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">insert an event</h3>

            <div className="flex flex-col gap-xs sm:flex-row sm:items-end">
              <label className="flex flex-col gap-xxs">
                <span className={LABEL}>kind (schema enum)</span>
                <select
                  data-testid="mongo-console-kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}
                  className={INPUT}
                >
                  {KINDS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-xxs">
                <span className={LABEL}>page (required)</span>
                <input
                  data-testid="mongo-console-page"
                  value={page}
                  onChange={(event) => setPage(event.target.value)}
                  spellCheck={false}
                  className={INPUT}
                />
              </label>
              <label className="flex flex-1 flex-col gap-xxs">
                <span className={LABEL}>visitor (required)</span>
                <input
                  data-testid="mongo-console-visitor"
                  value={visitor}
                  onChange={(event) => setVisitor(event.target.value)}
                  spellCheck={false}
                  className={INPUT}
                />
              </label>
            </div>

            <label className="flex flex-col gap-xxs">
              <span className={LABEL}>meta — Mixed: any JSON the BSON wire can carry</span>
              <textarea
                data-testid="mongo-console-meta"
                value={meta}
                onChange={(event) => setMeta(event.target.value)}
                rows={4}
                spellCheck={false}
                className={INPUT}
              />
            </label>

            <div className="flex flex-wrap items-center gap-sm">
              <button
                type="button"
                data-testid="mongo-console-submit"
                onClick={submitEvent}
                disabled={submitState.kind === 'sending' || page.trim() === '' || visitor.trim() === ''}
                className={BUTTON_PRIMARY}
              >
                {submitState.kind === 'sending' ? 'inserting…' : 'POST /api/demo/mongo/events'}
              </button>
              <span className="text-caption text-on-surface-variant">
                validation happens in the driver — a bad kind comes back as the canonical 400
              </span>
            </div>

            {submitState.kind === 'created' && (
              <p data-testid="mongo-console-created" className="font-mono text-caption text-on-surface">
                201 · created {submitState.event.id} — watch its age below; the TTL index deletes it ~60s after createdAt
              </p>
            )}
            {submitState.kind === 'invalid' && (
              <div data-testid="mongo-console-validation" className="flex flex-col gap-xxs">
                <p className="font-mono text-caption font-semibold text-error">400 · {submitState.message}</p>
                {submitState.errors.map((error) => (
                  <p key={error.field} className="font-mono text-caption text-on-surface">
                    <span className={CHIP_ERROR}>{error.field}</span> {error.message}
                  </p>
                ))}
              </div>
            )}
            {submitState.kind === 'unavailable' && (
              <div data-testid="mongo-console-submit-unavailable" className="flex flex-col gap-xxs">
                <p className="font-mono text-caption font-semibold text-error">
                  503 · {submitState.message}
                </p>
              </div>
            )}
            {submitState.kind === 'failed' && (
              <pre data-testid="mongo-console-submit-failed" className={PRE}>
                {submitState.problem}
              </pre>
            )}
          </section>

          <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
            <div className="flex flex-wrap items-center gap-sm">
              <h3 className="font-mono text-body-sm font-semibold text-on-surface">
                events — newest first
              </h3>
              {listReady !== null && (
                <span data-testid="mongo-console-stats" className={CHIP}>
                  {String(listReady.stats.count)} docs · ttl {String(listReady.stats.ttlSeconds)}s
                  {listReady.stats.ttlIndex !== null ? ` (${listReady.stats.ttlIndex})` : ''}
                </span>
              )}
              <button
                type="button"
                data-testid="mongo-console-refresh"
                onClick={refreshAll}
                disabled={listState.kind === 'loading'}
                className={BUTTON}
              >
                refresh
              </button>
              <button
                type="button"
                data-testid="mongo-console-clear"
                onClick={clearEvents}
                disabled={listState.kind === 'loading'}
                className={BUTTON}
              >
                clear collection
              </button>
            </div>
            <p className="text-caption text-on-surface-variant">
              age is seconds since createdAt — each document expires ~60s after creation (mongod's
              deleter sweeps lazily, so expect 60–120s); refresh to watch them vanish
            </p>

            {listState.kind === 'loading' && (
              <p data-testid="mongo-console-list-loading" className="text-body-sm text-on-surface-variant">
                listing events…
              </p>
            )}
            {listState.kind === 'failed' && (
              <div data-testid="mongo-console-list-failed" className="flex flex-col gap-xxs">
                <pre className={PRE}>{listState.problem}</pre>
              </div>
            )}
            {listState.kind === 'failed' && listState.problem.includes('service_unavailable') && (
              <OffPanel testId="mongo-console-off" note="The connection was live a moment ago — the service went away, and the endpoints now answer 503." />
            )}

            {listReady !== null && listReady.events.length === 0 && (
              <p data-testid="mongo-console-empty" className="text-body-sm text-on-surface-variant">
                the collection is empty (or the TTL index already deleted everything) — insert an event above
              </p>
            )}

            {listReady !== null &&
              listReady.events.map((event) => (
                <p
                  key={event.id}
                  data-testid="mongo-console-event"
                  className="flex flex-wrap items-center gap-xs font-mono text-caption"
                >
                  <span className={CHIP_OK}>{event.kind}</span>
                  <span className="text-on-surface">{event.page}</span>
                  <span className="text-on-surface-variant">by {event.visitor}</span>
                  <span
                    data-testid="mongo-console-event-age"
                    className={ageSeconds(event.createdAt, now) >= 60 ? CHIP_ERROR : CHIP}
                  >
                    age {String(ageSeconds(event.createdAt, now))}s
                  </span>
                  <span className="text-on-surface-variant">meta {previewMeta(event.meta)}</span>
                </p>
              ))}
          </section>
        </>
      )}
    </div>
  );
}
