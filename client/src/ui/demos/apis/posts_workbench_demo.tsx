import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `api:posts-workbench` — the REST API design topic's
 * compact workbench over the REAL posts pipeline (route → use case →
 * repository). Panels:
 *
 * - the LIST (GET /api/posts) rendered as a table, with a per-response
 *   "design critique": which status-code FAMILY answered and why it is the
 *   right one, from the small map below;
 * - a CREATE form (title/body/author) → POST /api/posts: the 201 result is
 *   appended to the collection, and a validation failure renders the 400
 *   envelope with its field-level messages;
 * - SCENARIO toggles (PATCH /api/demo/scenario): fake/live data and failure
 *   injection — the SAME resource across data modes, plus the 503 envelope;
 * - a REQUEST LOG (method path status elapsed, newest first, capped at 10).
 */

const POSTS_PATH = '/api/posts';
const SCENARIO_PATH = '/api/demo/scenario';
const LOG_CAP = 10;

interface Post {
  id: string;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

interface ScenarioState {
  dataMode: 'fake' | 'live';
  injectFailure: boolean;
}

interface LogEntry {
  seq: number;
  method: string;
  path: string;
  status: number | null;
  elapsedMs: number;
}

/** One fired request's observable outcome (status null = network failure). */
interface Fired {
  status: number | null;
  ok: boolean;
  value: unknown;
  text: string;
  elapsedMs: number;
}

type ListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; posts: Post[]; status: number }
  | { kind: 'failed'; status: number | null; envelopeText: string };

type CreateState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; post: Post }
  | { kind: 'rejected'; status: number; envelopeText: string; fields: Record<string, string> | null }
  | { kind: 'failed'; status: number | null; envelopeText: string };

// --- the design critique: status family + why (the topic's table, miniaturized)

const STATUS_NOTES: Readonly<Record<number, string>> = {
  200: 'the resource answered with a complete representation — GET did its one job.',
  201: 'a resource now exists. The classic finishing touch is a Location header pointing at it; this endpoint ships the representation in the body instead — the body is the address.',
  400: 'the REQUEST failed validation — the envelope names the fields. Fix the request; retrying it unchanged will fail identically.',
  404: 'the route matched but the resource does not exist — a well-formed address for nothing.',
  503: 'the service is unavailable — injected on purpose here. Nothing the client sent is wrong; the correct client move is backoff, then retry.',
};

interface Critique {
  family: string;
  tone: 'success' | 'client' | 'server' | 'network';
  note: string;
}

function critiqueFor(status: number | null): Critique {
  if (status === null) {
    return {
      family: 'network failure',
      tone: 'network',
      note: 'no HTTP answer at all — the request never reached an API. Not a status code: the absence of one.',
    };
  }
  if (status >= 500) {
    return { family: '5xx — server-error family', tone: 'server', note: STATUS_NOTES[503] ?? '' };
  }
  if (status >= 400) {
    return {
      family: '4xx — client-error family',
      tone: 'client',
      note: STATUS_NOTES[status] ?? 'a client error — the request, not the server, is what needs to change.',
    };
  }
  return {
    family: '2xx — success family',
    tone: 'success',
    note: STATUS_NOTES[status] ?? 'a success — the operation worked.',
  };
}

function critiqueChip(critique: Critique): string {
  if (critique.tone === 'success') {
    return 'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption text-on-primary';
  }
  if (critique.tone === 'client' || critique.tone === 'server') {
    return 'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption text-on-error';
  }
  return 'rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface-variant';
}

// --- defensive parsing (the API layer's house rule: validate before use) ------

function isPost(value: unknown): value is Post {
  if (typeof value !== 'object' || value === null) return false;
  const post = value as Record<string, unknown>;
  return (
    typeof post.id === 'string' &&
    typeof post.title === 'string' &&
    typeof post.body === 'string' &&
    typeof post.author === 'string' &&
    typeof post.createdAt === 'string' &&
    typeof post.updatedAt === 'string'
  );
}

function parsePost(value: unknown): Post | null {
  return isPost(value) ? value : null;
}

function parsePosts(value: unknown): Post[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const posts = (value as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return null;
  const out: Post[] = [];
  for (const entry of posts) {
    if (!isPost(entry)) return null;
    out.push(entry);
  }
  return out;
}

function parseScenario(value: unknown): ScenarioState | null {
  if (typeof value !== 'object' || value === null) return null;
  const scenario = value as Record<string, unknown>;
  if (scenario.dataMode !== 'fake' && scenario.dataMode !== 'live') return null;
  if (typeof scenario.injectFailure !== 'boolean') return null;
  return { dataMode: scenario.dataMode, injectFailure: scenario.injectFailure };
}

/** The envelope's fields map (field → message), when the failure carries one. */
function envelopeFields(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null) return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const fields = (error as { fields?: unknown }).fields;
  if (typeof fields !== 'object' || fields === null) return null;
  const out: Record<string, string> = {};
  for (const [field, message] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof message === 'string') out[field] = message;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads the body as text when the environment provides text() (real fetch),
 * falling back to json() (minimal test doubles) — the same defensive reader
 * the other demos use.
 */
async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') {
    return response.text();
  }
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

function prettyBody(fired: Fired): string {
  const parsed = tryParseJson(fired.text);
  if (!parsed.ok) return fired.text === '' ? '(empty body)' : fired.text;
  return JSON.stringify(parsed.value, null, 2);
}

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const INPUT =
  'rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none disabled:opacity-50';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const PRE =
  'max-h-60 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

/** The critique line one panel renders under its latest response. */
function CritiqueLine({ testId, status }: { testId: string; status: number | null }): ReactNode {
  const critique = critiqueFor(status);
  return (
    <p data-testid={testId} className="flex flex-wrap items-center gap-xs text-body-sm text-on-surface">
      <span className={critiqueChip(critique)}>{critique.family}</span>
      <span>
        {status === null ? 'no answer' : `${String(status)} —`} {critique.note}
      </span>
    </p>
  );
}

export default function PostsWorkbenchDemo() {
  const [scenario, setScenario] = useState<ScenarioState | null>(null);
  const [listState, setListState] = useState<ListState>({ kind: 'idle' });
  const [form, setForm] = useState({ title: '', body: '', author: '' });
  const [createState, setCreateState] = useState<CreateState>({ kind: 'idle' });
  const [log, setLog] = useState<LogEntry[]>([]);
  const aliveRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** Fire one request, measure it, and record it in the capped log. */
  const run = (method: string, path: string, body?: unknown): Promise<Fired> => {
    const startedAt = Date.now();
    const attempt: Promise<Fired> = (async () => {
      try {
        const response = await fetch(path, {
          method,
          ...(body !== undefined && {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        });
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        return {
          status: response.status,
          ok: response.ok,
          value: parsed.ok ? parsed.value : undefined,
          text,
          elapsedMs: Date.now() - startedAt,
        };
      } catch {
        return {
          status: null,
          ok: false,
          value: undefined,
          text: 'could not reach the server',
          elapsedMs: Date.now() - startedAt,
        };
      }
    })();
    return attempt.then((fired) => {
      if (aliveRef.current) {
        const entry: LogEntry = {
          seq: seqRef.current++,
          method,
          path,
          status: fired.status,
          elapsedMs: fired.elapsedMs,
        };
        // Newest first, capped — the log is a window, not a history.
        setLog((entries) => [entry, ...entries].slice(0, LOG_CAP));
      }
      return fired;
    });
  };

  const loadList = (): void => {
    setListState({ kind: 'loading' });
    void run('GET', POSTS_PATH).then((fired) => {
      if (!aliveRef.current) return;
      if (fired.status !== null && fired.ok) {
        const posts = parsePosts(fired.value);
        if (posts !== null) {
          setListState({ kind: 'ready', posts, status: fired.status });
          return;
        }
      }
      setListState({
        kind: 'failed',
        status: fired.status,
        envelopeText: fired.status === null ? fired.text : prettyBody(fired),
      });
    });
  };

  const createPost = (): void => {
    setCreateState({ kind: 'creating' });
    void run('POST', POSTS_PATH, { ...form }).then((fired) => {
      if (!aliveRef.current) return;
      if (fired.status !== null && fired.ok) {
        const post = parsePost(fired.value);
        if (post !== null) {
          setCreateState({ kind: 'created', post });
          // The collection is newest-first: the created post lands on top.
          setListState((current) =>
            current.kind === 'ready' ? { ...current, posts: [post, ...current.posts] } : current,
          );
          return;
        }
      }
      if (fired.status === 400) {
        setCreateState({
          kind: 'rejected',
          status: 400,
          envelopeText: prettyBody(fired),
          fields: envelopeFields(fired.value),
        });
        return;
      }
      setCreateState({
        kind: 'failed',
        status: fired.status,
        envelopeText: fired.status === null ? fired.text : prettyBody(fired),
      });
    });
  };

  const patchScenario = (patch: Record<string, unknown>): Promise<ScenarioState | null> =>
    run('PATCH', SCENARIO_PATH, patch).then((fired) => {
      if (!aliveRef.current) return null;
      if (fired.status !== null && fired.ok) {
        const next = parseScenario(fired.value);
        if (next !== null) {
          setScenario(next);
          return next;
        }
      }
      return null;
    });

  const toggleMode = (): void => {
    if (scenario === null) return;
    void patchScenario({ dataMode: scenario.dataMode === 'fake' ? 'live' : 'fake' }).then((next) => {
      if (next !== null) loadList();
    });
  };

  const toggleFailure = (): void => {
    if (scenario === null) return;
    void patchScenario({ injectFailure: !scenario.injectFailure }).then((next) => {
      if (next !== null) loadList();
    });
  };

  // Read the scenario once, then load the collection — like any client would.
  useEffect(() => {
    void run('GET', SCENARIO_PATH).then((fired) => {
      if (aliveRef.current && fired.status !== null && fired.ok) {
        const next = parseScenario(fired.value);
        if (next !== null) setScenario(next);
      }
    });
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (field: keyof typeof form, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const listStatus: number | null =
    listState.kind === 'ready' ? listState.status : listState.kind === 'failed' ? listState.status : null;
  const createStatus: number | null =
    createState.kind === 'created'
      ? 201
      : createState.kind === 'rejected'
        ? createState.status
        : createState.kind === 'failed'
          ? createState.status
          : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="posts-workbench-summary" className="text-body-sm text-on-surface">
        One resource (<span className="font-mono">/api/posts</span>), the real pipeline behind it, and
        the scenario toggles that change what the pipeline answers: fake in-memory data, live sqlite,
        or an injected 503. Every request lands in the log — the workbench is just a client with
        opinions.
      </p>

      {/* scenario controls */}
      <div
        data-testid="posts-workbench-scenario"
        className="flex flex-wrap items-center gap-sm rounded-md border border-outline p-sm"
      >
        <span className="text-body-sm text-on-surface-variant">
          scenario: data mode{' '}
          <span data-testid="posts-workbench-mode" className="font-mono font-semibold text-on-surface">
            {scenario?.dataMode ?? '…'}
          </span>
          , failure injection{' '}
          <span
            data-testid="posts-workbench-inject"
            className="font-mono font-semibold text-on-surface"
          >
            {scenario === null ? '…' : scenario.injectFailure ? 'on' : 'off'}
          </span>
        </span>
        <button
          type="button"
          data-testid="posts-workbench-toggle-mode"
          onClick={toggleMode}
          disabled={scenario === null}
          className={BUTTON}
        >
          switch to {scenario?.dataMode === 'fake' ? 'live sqlite' : 'fake'} data
        </button>
        <button
          type="button"
          data-testid="posts-workbench-toggle-failure"
          onClick={toggleFailure}
          disabled={scenario === null}
          className={BUTTON}
        >
          {scenario?.injectFailure ? 'stop failure injection' : 'inject failure (503)'}
        </button>
      </div>

      {/* list panel */}
      <div className="flex flex-col gap-xs rounded-md border border-outline p-sm">
        <div className="flex items-center justify-between gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">GET /api/posts</h3>
          <button type="button" data-testid="posts-workbench-reload" onClick={loadList} className={BUTTON}>
            reload
          </button>
        </div>

        {listState.kind === 'loading' && (
          <p data-testid="posts-workbench-loading" className="text-body-sm text-on-surface-variant">
            fetching the collection…
          </p>
        )}

        {listState.kind === 'ready' && (
          <table data-testid="posts-workbench-list" className="w-full border-collapse text-left">
            <thead>
              <tr className="text-caption text-on-surface-variant">
                <th className="py-xxs pr-sm font-medium">title</th>
                <th className="py-xxs pr-sm font-medium">author</th>
                <th className="py-xxs pr-sm font-medium">created</th>
                <th className="py-xxs font-medium">id</th>
              </tr>
            </thead>
            <tbody>
              {listState.posts.map((post) => (
                <tr key={post.id} data-testid="posts-workbench-post-row" className="border-t border-outline">
                  <td className="py-xxs pr-sm text-body-sm font-medium text-on-surface">{post.title}</td>
                  <td className="py-xxs pr-sm text-body-sm text-on-surface-variant">{post.author}</td>
                  <td className="py-xxs pr-sm font-mono text-caption text-on-surface-variant">
                    {post.createdAt.slice(0, 10)}
                  </td>
                  <td className="py-xxs font-mono text-caption text-on-surface-variant">
                    {post.id.slice(0, 8)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {listState.kind === 'failed' && (
          <pre data-testid="posts-workbench-list-envelope" className={PRE}>
            {listState.envelopeText}
          </pre>
        )}

        {listState.kind !== 'idle' && listState.kind !== 'loading' && (
          <CritiqueLine testId="posts-workbench-list-critique" status={listStatus} />
        )}
      </div>

      {/* create panel */}
      <div className="flex flex-col gap-xs rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">POST /api/posts</h3>
        <div className="grid gap-sm sm:grid-cols-3">
          {(['title', 'body', 'author'] as const).map((field) => (
            <label key={field} className="flex flex-col gap-xxs">
              <span className={LABEL}>
                {field}
                {field === 'title' ? ' · 1–120 chars' : field === 'body' ? ' · 1–5000 chars' : ' · 1–80 chars'}
              </span>
              <input
                data-testid={`posts-workbench-field-${field}`}
                value={form[field]}
                onChange={(event) => update(field, event.target.value)}
                className={INPUT}
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          data-testid="posts-workbench-create"
          onClick={createPost}
          disabled={createState.kind === 'creating'}
          className={BUTTON}
        >
          {createState.kind === 'creating' ? 'creating…' : 'create the post'}
        </button>

        {createState.kind === 'created' && (
          <p data-testid="posts-workbench-create-result" className="text-body-sm text-on-surface">
            201 Created —{' '}
            <span className="font-mono">{createState.post.title}</span> by{' '}
            <span className="font-mono">{createState.post.author}</span>, appended to the collection
            (newest first). The representation rode the body; the classic Location header is the
            finishing touch this endpoint skips.
          </p>
        )}

        {createState.kind === 'rejected' && (
          <div data-testid="posts-workbench-create-envelope" className="flex flex-col gap-xs">
            <p className="text-body-sm text-error">400 — validation failed; the envelope says:</p>
            {createState.fields !== null && (
              <ul className="flex flex-col gap-xxs">
                {Object.entries(createState.fields).map(([field, message]) => (
                  <li
                    key={field}
                    data-testid="posts-workbench-create-field-error"
                    className="text-body-sm text-on-surface"
                  >
                    <span className="font-mono font-semibold">{field}</span> — {message}
                  </li>
                ))}
              </ul>
            )}
            <pre className={PRE}>{createState.envelopeText}</pre>
          </div>
        )}

        {createState.kind === 'failed' && (
          <div data-testid="posts-workbench-create-failed" className="flex flex-col gap-xs">
            <p role="alert" className="text-body-sm text-error">
              {createState.status === null
                ? 'could not reach the server'
                : `unexpected ${String(createState.status)} —`}
            </p>
            <pre className={PRE}>{createState.envelopeText}</pre>
          </div>
        )}

        {createStatus !== null && (
          <CritiqueLine testId="posts-workbench-create-critique" status={createStatus} />
        )}
      </div>

      {/* request log */}
      <div className="flex flex-col gap-xs rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">request log</h3>
        {log.length === 0 ? (
          <p data-testid="posts-workbench-log-empty" className="text-body-sm text-on-surface-variant">
            no requests fired yet.
          </p>
        ) : (
          <ol data-testid="posts-workbench-log" className="flex flex-col gap-xxs">
            {log.map((entry, index) => (
              <li
                key={entry.seq}
                data-testid={`posts-workbench-log-row-${String(index)}`}
                className="font-mono text-caption text-on-surface-variant"
              >
                <span className="font-semibold text-on-surface">{entry.method}</span> {entry.path}{' '}
                {entry.status === null ? (
                  <span className="text-error">ERR</span>
                ) : (
                  <span
                    className={
                      entry.status >= 500 || entry.status >= 400
                        ? 'font-semibold text-error'
                        : 'font-semibold text-on-surface'
                    }
                  >
                    {String(entry.status)}
                  </span>
                )}{' '}
                · {String(entry.elapsedMs)}ms
              </li>
            ))}
          </ol>
        )}
        <p className="text-caption text-on-surface-variant">
          newest first, last {String(LOG_CAP)} requests — a client-side window onto your own traffic.
        </p>
      </div>
    </div>
  );
}
