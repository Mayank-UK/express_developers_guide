import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `api:graphql-playground` — the GraphQL topic's mini
 * playground over the REAL POST /api/graphql endpoint (the ~40-line handler
 * from graphql_demo_routes.ts). An editable document + variables panel, two
 * presets (the posts query; the createPost mutation with variables), a RUN
 * button, and a response panel that renders data and errors SEPARATELY —
 * with each error's extensions.code as a chip, so partial-data-plus-errors
 * answers are legible at a glance.
 */

const GRAPHQL_URL = '/api/graphql';

const PRESET_POSTS_QUERY = '{ posts { id title } }';
const PRESET_MUTATION_QUERY =
  'mutation Create($title: String!, $body: String!, $author: String!) {\n' +
  '  createPost(title: $title, body: $body, author: $author) { id title createdAt }\n' +
  '}';
const PRESET_MUTATION_VARIABLES = JSON.stringify(
  { title: 'One endpoint, client-shaped', body: 'The client asked for exactly this.', author: 'you' },
  null,
  2,
);

interface GraphqlErrorEntry {
  message: string;
  path?: readonly unknown[];
  extensions?: { code?: unknown };
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'responded'; status: number; data: unknown; hasData: boolean; errors: GraphqlErrorEntry[] }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const TEXTAREA =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none disabled:opacity-50';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const PRE =
  'max-h-72 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';
const CODE_CHIP =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseGraphqlResponse(value: unknown): { hasData: boolean; data: unknown; errors: GraphqlErrorEntry[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const hasData = 'data' in record;
  const rawErrors = Array.isArray(record.errors) ? record.errors : [];
  const errors: GraphqlErrorEntry[] = [];
  for (const entry of rawErrors) {
    if (typeof entry !== 'object' || entry === null) continue;
    const error = entry as Record<string, unknown>;
    if (typeof error.message !== 'string') continue;
    errors.push({
      message: error.message,
      ...(Array.isArray(error.path) && { path: error.path }),
      ...(typeof error.extensions === 'object' &&
        error.extensions !== null && {
          extensions: error.extensions as { code?: unknown },
        }),
    });
  }
  return { hasData, data: record.data, errors };
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

export default function GraphqlPlaygroundDemo(): ReactNode {
  const [query, setQuery] = useState(PRESET_POSTS_QUERY);
  const [variables, setVariables] = useState('');
  const [runState, setRunState] = useState<RunState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** POST { query, variables } — variables parsed locally, never interpolated. */
  const run = (): void => {
    const trimmed = variables.trim();
    let variablesValue: Record<string, unknown> | null = null;
    if (trimmed !== '') {
      const parsed = tryParseJson(trimmed);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
        setRunState({
          kind: 'failed',
          problem: 'variables must be a JSON object (or empty) — the query was not sent.',
        });
        return;
      }
      variablesValue = parsed.value as Record<string, unknown>;
    }

    setRunState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, ...(variablesValue !== null && { variables: variablesValue }) }),
        });
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped =
          parsed.ok ? parseGraphqlResponse(parsed.value) : null;
        if (shaped === null) {
          setRunState({ kind: 'failed', problem: `status ${String(response.status)} — the answer was not a GraphQL response:\n${text}` });
          return;
        }
        setRunState({
          kind: 'responded',
          status: response.status,
          data: shaped.data,
          hasData: shaped.hasData,
          errors: shaped.errors,
        });
      } catch {
        if (aliveRef.current) {
          setRunState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  // Run the prefilled query once on mount, like any client would.
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPresetPosts = (): void => {
    setQuery(PRESET_POSTS_QUERY);
    setVariables('');
    setRunState({ kind: 'idle' });
  };

  const loadPresetMutation = (): void => {
    setQuery(PRESET_MUTATION_QUERY);
    setVariables(PRESET_MUTATION_VARIABLES);
    setRunState({ kind: 'idle' });
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="graphql-playground-summary" className="text-body-sm text-on-surface">
        One endpoint, your shape: edit the document and variables and RUN them against{' '}
        <span className="font-mono">POST /api/graphql</span> — the same handler, schema, and posts use case the REST
        surface uses. Break it on purpose: misspell a field (a validation 400 quotes the real schema), leave a brace
        open (a syntax 400 with a location), or flip failure injection on in the REST workbench and re-run — the 503
        arrives as an <span className="font-mono">errors[]</span> entry with{' '}
        <span className="font-mono">extensions.code</span>.
      </p>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <button type="button" data-testid="graphql-playground-preset-posts" onClick={loadPresetPosts} className={BUTTON}>
            preset: posts query
          </button>
          <button
            type="button"
            data-testid="graphql-playground-preset-mutation"
            onClick={loadPresetMutation}
            className={BUTTON}
          >
            preset: createPost mutation + variables
          </button>
        </div>

        <label className="flex flex-col gap-xxs">
          <span className={LABEL}>query document</span>
          <textarea
            data-testid="graphql-playground-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            rows={4}
            spellCheck={false}
            className={TEXTAREA}
          />
        </label>

        <label className="flex flex-col gap-xxs">
          <span className={LABEL}>variables (JSON object, optional)</span>
          <textarea
            data-testid="graphql-playground-variables"
            value={variables}
            onChange={(event) => setVariables(event.target.value)}
            rows={3}
            spellCheck={false}
            className={TEXTAREA}
          />
        </label>

        <button
          type="button"
          data-testid="graphql-playground-run"
          onClick={run}
          disabled={runState.kind === 'loading'}
          className={BUTTON_PRIMARY}
        >
          {runState.kind === 'loading' ? 'running…' : 'run query'}
        </button>
      </div>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex items-center gap-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">response</h3>
          {runState.kind === 'responded' && (
            <span
              data-testid="graphql-playground-status"
              className={
                runState.status >= 400
                  ? 'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption text-on-error'
                  : 'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption text-on-primary'
              }
            >
              {String(runState.status)}
            </span>
          )}
        </div>

        {runState.kind === 'loading' && (
          <p data-testid="graphql-playground-loading" className="text-body-sm text-on-surface-variant">
            running the document…
          </p>
        )}

        {runState.kind === 'failed' && (
          <pre data-testid="graphql-playground-failed" className={PRE}>
            {runState.problem}
          </pre>
        )}

        {runState.kind === 'responded' && (
          <div className="flex flex-col gap-sm">
            {runState.errors.length > 0 ? (
              <div data-testid="graphql-playground-response-errors" className="flex flex-col gap-xs">
                <p className="text-body-sm font-semibold text-error">errors</p>
                <ul className="flex flex-col gap-xs">
                  {runState.errors.map((error, index) => (
                    <li
                      key={`${error.message}-${String(index)}`}
                      data-testid="graphql-playground-error-row"
                      className="flex flex-col gap-xxs rounded-md border border-outline p-xs"
                    >
                      <span className="flex flex-wrap items-center gap-xs">
                        {typeof error.extensions?.code === 'string' && (
                          <span data-testid="graphql-playground-error-code" className={CODE_CHIP}>
                            {error.extensions.code}
                          </span>
                        )}
                        {error.path !== undefined && (
                          <span className="font-mono text-caption text-on-surface-variant">
                            path: {JSON.stringify(error.path)}
                          </span>
                        )}
                      </span>
                      <span className="text-body-sm text-on-surface">{error.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p data-testid="graphql-playground-no-errors" className="text-body-sm text-on-surface-variant">
                no errors — data answered exactly the shape you asked for.
              </p>
            )}

            {runState.hasData && (
              <div data-testid="graphql-playground-response-data" className="flex flex-col gap-xxs">
                <p className="text-body-sm font-semibold text-on-surface">data</p>
                <pre className={PRE}>{JSON.stringify(runState.data, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
