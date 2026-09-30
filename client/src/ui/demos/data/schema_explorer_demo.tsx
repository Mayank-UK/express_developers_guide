import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:schema-explorer` — the sql-schema topic's live
 * introspection of a real (in-memory) SQLite handle: every table, column,
 * constraint, index and foreign key rendered from SQLite's own PRAGMAs,
 * plus an EXPLAIN QUERY PLAN panel contrasting an indexed SEARCH with a
 * full SCAN (with a custom single-SELECT input for exploration).
 */

const SCHEMA_URL = '/api/demo/db/schema';
const PLAN_URL = '/api/demo/db/plan';

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

interface IndexInfo {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
}

interface ForeignKeyInfo {
  referencesTable: string;
  column: string;
  referencesColumn: string;
  onDelete: string;
  onUpdate: string;
}

interface TableInfo {
  name: string;
  ddl: string;
  rowCount: number;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

interface SchemaPayload {
  handle: string;
  foreignKeysEnforced: boolean;
  tables: TableInfo[];
}

interface PlanPayload {
  source: string;
  sql: string;
  steps: string[];
  usedIndex: boolean;
  verb: string;
}

type SchemaState =
  | { kind: 'loading' }
  | { kind: 'ready'; schema: SchemaPayload }
  | { kind: 'failed'; problem: string };

type PlanState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; plan: PlanPayload; label: string }
  | { kind: 'failed'; problem: string };

const INDEX_ORIGIN_LABELS: Record<string, string> = {
  c: 'CREATE INDEX',
  u: 'UNIQUE constraint',
  pk: 'PRIMARY KEY',
};

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

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseSchema(value: unknown): SchemaPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tables)) return null;

  const tables: TableInfo[] = [];
  for (const rawTable of record.tables) {
    if (typeof rawTable !== 'object' || rawTable === null) continue;
    const table = rawTable as Record<string, unknown>;
    if (typeof table.name !== 'string') continue;

    const columns = Array.isArray(table.columns)
      ? table.columns.filter(
          (raw): raw is ColumnInfo =>
            typeof raw === 'object' &&
            raw !== null &&
            typeof (raw as ColumnInfo).name === 'string' &&
            typeof (raw as ColumnInfo).type === 'string',
        )
      : [];
    const indexes = Array.isArray(table.indexes)
      ? table.indexes.filter(
          (raw): raw is IndexInfo =>
            typeof raw === 'object' &&
            raw !== null &&
            typeof (raw as IndexInfo).name === 'string' &&
            Array.isArray((raw as IndexInfo).columns),
        )
      : [];
    const foreignKeys = Array.isArray(table.foreignKeys)
      ? table.foreignKeys.filter(
          (raw): raw is ForeignKeyInfo =>
            typeof raw === 'object' &&
            raw !== null &&
            typeof (raw as ForeignKeyInfo).referencesTable === 'string' &&
            typeof (raw as ForeignKeyInfo).column === 'string',
        )
      : [];

    tables.push({
      name: table.name,
      ddl: typeof table.ddl === 'string' ? table.ddl : '',
      rowCount: typeof table.rowCount === 'number' ? table.rowCount : 0,
      columns,
      indexes,
      foreignKeys,
    });
  }

  return {
    handle: typeof record.handle === 'string' ? record.handle : '?',
    foreignKeysEnforced: record.foreignKeysEnforced === true,
    tables,
  };
}

function parsePlan(value: unknown): PlanPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sql !== 'string' || !Array.isArray(record.steps)) return null;
  return {
    source: typeof record.source === 'string' ? record.source : '?',
    sql: record.sql,
    steps: record.steps.map((step) => String(step)),
    usedIndex: record.usedIndex === true,
    verb: typeof record.verb === 'string' ? record.verb : '?',
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

function columnBadges(column: ColumnInfo): ReactNode[] {
  const badges: ReactNode[] = [];
  if (column.primaryKey) badges.push(<span key="pk" className={CHIP}>PK</span>);
  if (column.notNull) badges.push(<span key="nn" className={CHIP}>NOT NULL</span>);
  if (column.defaultValue !== null) {
    badges.push(
      <span key="def" className={CHIP}>
        DEFAULT {column.defaultValue}
      </span>,
    );
  }
  return badges;
}

export default function SchemaExplorerDemo(): ReactNode {
  const [schemaState, setSchemaState] = useState<SchemaState>({ kind: 'loading' });
  const [planState, setPlanState] = useState<PlanState>({ kind: 'idle' });
  const [customSql, setCustomSql] = useState('SELECT id FROM posts WHERE author = \'the guide\'');
  const [openDdl, setOpenDdl] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(SCHEMA_URL);
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseSchema(parsed.value) : null;
        if (shaped === null) {
          setSchemaState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a schema payload:\n${text}`,
          });
          return;
        }
        setSchemaState({ kind: 'ready', schema: shaped });
      } catch {
        if (aliveRef.current) {
          setSchemaState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  }, []);

  const runPlan = (label: string, query: string): void => {
    setPlanState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`${PLAN_URL}?${query}`);
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parsePlan(parsed.value) : null;
        if (shaped === null) {
          setPlanState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a plan:\n${text}`,
          });
          return;
        }
        setPlanState({ kind: 'answered', plan: shaped, label });
      } catch {
        if (aliveRef.current) {
          setPlanState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const runPreset = (preset: 'indexed' | 'scan'): void => {
    runPlan(preset === 'indexed' ? 'indexed lookup' : 'full scan', `preset=${preset}`);
  };

  const runCustom = (): void => {
    runPlan('custom', `sql=${encodeURIComponent(customSql.trim())}`);
  };

  const answeredPlan = planState.kind === 'answered' ? planState : null;
  const plan = answeredPlan?.plan ?? null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="schema-explorer-summary" className="text-body-sm text-on-surface">
        Introspection of the demo handle (never the real guide.db): tables, columns, constraints, indexes and
        foreign keys read live from SQLite's own PRAGMAs — then EXPLAIN QUERY PLAN on the same handle, where an
        indexed SEARCH and an unindexed SCAN are one button apart.
      </p>

      <div className="flex flex-wrap items-center gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">the schema</h3>
        {schemaState.kind === 'ready' && (
          <>
            <span data-testid="schema-explorer-handle" className={CHIP}>
              handle: {schemaState.schema.handle}
            </span>
            <span
              data-testid="schema-explorer-fk-pragma"
              className={schemaState.schema.foreignKeysEnforced ? CHIP_OK : CHIP_ERROR}
            >
              {schemaState.schema.foreignKeysEnforced ? 'PRAGMA foreign_keys: ON' : 'PRAGMA foreign_keys: OFF'}
            </span>
            <span className="text-caption text-on-surface-variant">
              SQLite ships FK enforcement OFF — the demo handle turns it on, per connection
            </span>
          </>
        )}
      </div>

      {schemaState.kind === 'loading' && (
        <p data-testid="schema-explorer-loading" className="text-body-sm text-on-surface-variant">
          introspecting the demo handle…
        </p>
      )}
      {schemaState.kind === 'failed' && (
        <pre data-testid="schema-explorer-failed" className={PRE}>
          {schemaState.problem}
        </pre>
      )}

      {schemaState.kind === 'ready' &&
        schemaState.schema.tables.map((table) => (
          <section
            key={table.name}
            data-testid={`schema-explorer-table-${table.name}`}
            className="flex flex-col gap-sm rounded-md border border-outline p-sm"
          >
            <div className="flex flex-wrap items-center gap-sm">
              <h4 className="font-mono text-body-sm font-semibold text-on-surface">{table.name}</h4>
              <span className={CHIP}>{table.rowCount} rows</span>
              <button
                type="button"
                data-testid={`schema-explorer-ddl-toggle-${table.name}`}
                onClick={() => setOpenDdl((open) => (open === table.name ? null : table.name))}
                className={BUTTON}
              >
                {openDdl === table.name ? 'hide' : 'show'} DDL
              </button>
            </div>

            {openDdl === table.name && (
              <pre data-testid={`schema-explorer-ddl-${table.name}`} className={PRE}>
                {table.ddl}
              </pre>
            )}

            <div className="flex flex-col gap-xxs">
              {table.columns.map((column) => (
                <p key={column.name} className="flex flex-wrap items-center gap-xs font-mono text-caption">
                  <span className="text-on-surface">{column.name}</span>
                  <span className="text-on-surface-variant">{column.type}</span>
                  {columnBadges(column)}
                </p>
              ))}
            </div>

            {table.indexes.length > 0 && (
              <div className="flex flex-col gap-xxs">
                <p className="text-caption font-semibold text-on-surface-variant">indexes</p>
                {table.indexes.map((index) => (
                  <p key={index.name} className="flex flex-wrap items-center gap-xs font-mono text-caption">
                    <span className="text-on-surface">{index.name}</span>
                    <span className={CHIP}>{INDEX_ORIGIN_LABELS[index.origin] ?? `origin ${index.origin}`}</span>
                    {index.unique && <span className={CHIP}>UNIQUE</span>}
                    <span className="text-on-surface-variant">({index.columns.join(', ')})</span>
                  </p>
                ))}
              </div>
            )}

            {table.foreignKeys.length > 0 && (
              <div className="flex flex-col gap-xxs">
                <p className="text-caption font-semibold text-on-surface-variant">foreign keys</p>
                {table.foreignKeys.map((fk) => (
                  <p
                    key={`${fk.column}-to-${fk.referencesTable}`}
                    data-testid={`schema-explorer-fk-${table.name}`}
                    className="flex flex-wrap items-center gap-xs font-mono text-caption"
                  >
                    <span className="text-on-surface">{fk.column}</span>
                    <span className="text-on-surface-variant">→</span>
                    <span className="text-on-surface">
                      {fk.referencesTable}.{fk.referencesColumn}
                    </span>
                    <span className={CHIP_OK}>ON DELETE {fk.onDelete}</span>
                  </p>
                ))}
              </div>
            )}
          </section>
        ))}

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">EXPLAIN QUERY PLAN</h3>

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            data-testid="schema-plan-preset-indexed"
            onClick={() => runPreset('indexed')}
            disabled={planState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            indexed lookup
          </button>
          <button
            type="button"
            data-testid="schema-plan-preset-scan"
            onClick={() => runPreset('scan')}
            disabled={planState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            full scan
          </button>
          <span className="text-caption text-on-surface-variant">
            WHERE post_id = ? (indexed) vs WHERE body LIKE ? (no index)
          </span>
        </div>

        <label className="flex flex-col gap-xxs">
          <span className="font-mono text-caption text-on-surface-variant">
            or your own single SELECT (validated server-side: SELECT-only, no semicolons)
          </span>
          <div className="flex flex-col gap-xs sm:flex-row">
            <input
              data-testid="schema-plan-custom-sql"
              value={customSql}
              onChange={(event) => setCustomSql(event.target.value)}
              spellCheck={false}
              className={INPUT}
            />
            <button
              type="button"
              data-testid="schema-plan-run-custom"
              onClick={runCustom}
              disabled={planState.kind === 'loading' || customSql.trim().length === 0}
              className={BUTTON}
            >
              explain it
            </button>
          </div>
        </label>

        {planState.kind === 'loading' && (
          <p data-testid="schema-plan-loading" className="text-body-sm text-on-surface-variant">
            asking the planner…
          </p>
        )}
        {planState.kind === 'failed' && (
          <pre data-testid="schema-plan-failed" className={PRE}>
            {planState.problem}
          </pre>
        )}

        {plan !== null && (
          <div data-testid="schema-plan-result" className="flex flex-col gap-xs">
            <div className="flex flex-wrap items-center gap-sm">
              <span className="font-mono text-caption text-on-surface-variant">{answeredPlan?.label}</span>
              <span
                data-testid="schema-plan-verdict"
                className={plan.usedIndex ? CHIP_OK : CHIP_ERROR}
              >
                {plan.verb}
                {plan.usedIndex ? ' · USING INDEX' : ' · NO INDEX'}
              </span>
            </div>
            <pre data-testid="schema-plan-steps" className={PRE}>
              {plan.sql}

{'\n'}

{plan.steps.join('\n')}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
