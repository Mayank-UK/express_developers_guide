import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:sql-lab` — the SQL-by-hand lab over the seeded staff
 * dataset (a real in-memory handle, never the guide's db): a preset picker
 * that runs the recursive-CTE org chart (any manager id as the anchor), the
 * RANK()/running-total window query, the join+aggregate department rollup and
 * the EXPLAIN index-vs-no-index pair — always showing the exact SQL that ran
 * beside its result table, because reading the query beside its rows IS the
 * lesson.
 */

const ORG_CHART_URL = '/api/demo/db/sql-lab/org-chart';
const SALARY_WINDOW_URL = '/api/demo/db/sql-lab/salary-window';
const ROLLUP_URL = '/api/demo/db/sql-lab/department-rollup';
const PLANS_URL = '/api/demo/db/sql-lab/plan-comparison';

const DEFAULT_MANAGER = 'staff-001';

interface OrgChartRow {
  depth: number;
  id: string;
  name: string;
  manager_id: string | null;
  path: string;
}

interface OrgChartPayload {
  dataset: string;
  root: string;
  sql: string;
  rows: OrgChartRow[];
  maxDepth: number;
  note: string;
}

interface SalaryWindowRow {
  name: string;
  department: string;
  salary_cents: number;
  salary_rank_in_department: number;
  running_salary_total_cents: number;
  hired_at: string;
}

interface SalaryWindowPayload {
  dataset: string;
  sql: string;
  rows: SalaryWindowRow[];
  note: string;
}

interface RollupRow {
  department: string;
  headcount: number;
  total_salary_cents: number;
  avg_salary_cents: number;
  manager_name: string | null;
}

interface RollupPayload {
  dataset: string;
  sql: string;
  rows: RollupRow[];
  note: string;
}

interface PlanVariant {
  label: string;
  sql: string;
  boundValue: number;
  steps: string[];
  verb: string;
  usedIndex: boolean;
  note: string;
}

interface PlansPayload {
  thresholdCents: number;
  annualThresholdCents: number;
  variants: [PlanVariant, PlanVariant];
  verdict: string;
}

type LabPayload =
  | { preset: 'org-chart'; data: OrgChartPayload }
  | { preset: 'salary-window'; data: SalaryWindowPayload }
  | { preset: 'department-rollup'; data: RollupPayload }
  | { preset: 'plan-comparison'; data: PlansPayload };

type PresetId = LabPayload['preset'];

type LabState =
  | { kind: 'loading'; preset: PresetId }
  | { kind: 'ready'; payload: LabPayload }
  | { kind: 'failed'; preset: PresetId; problem: string };

const PRESETS = [
  {
    id: 'org-chart',
    label: 'recursive CTE · org chart',
    blurb: 'WITH RECURSIVE walks the reporting tree, carrying depth and path through the recursion',
  },
  {
    id: 'salary-window',
    label: 'window functions · rank + running total',
    blurb: 'RANK() and SUM() OVER (…) aggregate without collapsing the rows',
  },
  {
    id: 'department-rollup',
    label: 'join + aggregate · department rollup',
    blurb: 'aggregate FIRST in the dept subquery, join the manager AFTER',
  },
  {
    id: 'plan-comparison',
    label: 'EXPLAIN QUERY PLAN · index vs no index',
    blurb: 'the same filter twice — bare column seeks the index, wrapped column scans',
  },
] as const;

const PRESET_URLS: Record<PresetId, string> = {
  'org-chart': ORG_CHART_URL,
  'salary-window': SALARY_WINDOW_URL,
  'department-rollup': ROLLUP_URL,
  'plan-comparison': PLANS_URL,
};

const BUTTON_ACTIVE =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary disabled:opacity-50';
const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
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
const CELL = 'border-b border-outline px-xs py-xs';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** Deterministic cents → "$1,234.56" (money stays integer in SQL; only the display formats). */
function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = (abs % 100).toString().padStart(2, '0');
  return `${sign}$${whole}.${rest}`;
}

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseOrgChart(value: unknown): OrgChartPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.sql !== 'string' || !Array.isArray(value.rows)) return null;
  return {
    dataset: asString(value.dataset, ''),
    root: asString(value.root),
    sql: value.sql,
    rows: value.rows.filter(isRecord).map((row) => ({
      depth: asNumber(row.depth),
      id: asString(row.id),
      name: asString(row.name),
      manager_id: asNullableString(row.manager_id),
      path: asString(row.path),
    })),
    maxDepth: asNumber(value.maxDepth),
    note: asString(value.note, ''),
  };
}

function parseSalaryWindow(value: unknown): SalaryWindowPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.sql !== 'string' || !Array.isArray(value.rows)) return null;
  return {
    dataset: asString(value.dataset, ''),
    sql: value.sql,
    rows: value.rows.filter(isRecord).map((row) => ({
      name: asString(row.name),
      department: asString(row.department),
      salary_cents: asNumber(row.salary_cents),
      salary_rank_in_department: asNumber(row.salary_rank_in_department),
      running_salary_total_cents: asNumber(row.running_salary_total_cents),
      hired_at: asString(row.hired_at),
    })),
    note: asString(value.note, ''),
  };
}

function parseRollup(value: unknown): RollupPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.sql !== 'string' || !Array.isArray(value.rows)) return null;
  return {
    dataset: asString(value.dataset, ''),
    sql: value.sql,
    rows: value.rows.filter(isRecord).map((row) => ({
      department: asString(row.department),
      headcount: asNumber(row.headcount),
      total_salary_cents: asNumber(row.total_salary_cents),
      avg_salary_cents: asNumber(row.avg_salary_cents),
      manager_name: asNullableString(row.manager_name),
    })),
    note: asString(value.note, ''),
  };
}

function parsePlans(value: unknown): PlansPayload | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.variants) || value.variants.length < 2) return null;
  const variants = value.variants.filter(isRecord).map((row) => ({
    label: asString(row.label),
    sql: asString(row.sql),
    boundValue: asNumber(row.boundValue),
    steps: Array.isArray(row.steps) ? row.steps.map((step) => String(step)) : [],
    verb: asString(row.verb),
    usedIndex: row.usedIndex === true,
    note: asString(row.note, ''),
  }));
  if (variants.length < 2) return null;
  return {
    thresholdCents: asNumber(value.thresholdCents),
    annualThresholdCents: asNumber(value.annualThresholdCents),
    variants: [variants[0]!, variants[1]!],
    verdict: asString(value.verdict, ''),
  };
}

/** Dispatches to the preset's parser and wraps the data in its union member. */
function parsePresetPayload(preset: PresetId, value: unknown): LabPayload | null {
  switch (preset) {
    case 'org-chart': {
      const data = parseOrgChart(value);
      return data === null ? null : { preset: 'org-chart', data };
    }
    case 'salary-window': {
      const data = parseSalaryWindow(value);
      return data === null ? null : { preset: 'salary-window', data };
    }
    case 'department-rollup': {
      const data = parseRollup(value);
      return data === null ? null : { preset: 'department-rollup', data };
    }
    case 'plan-comparison': {
      const data = parsePlans(value);
      return data === null ? null : { preset: 'plan-comparison', data };
    }
  }
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

/** The lab's result table — headers are the SQL column names, on purpose. */
function ExhibitTable({
  testId,
  columns,
  rows,
}: {
  testId: string;
  columns: string[];
  rows: ReactNode[][];
}): ReactNode {
  return (
    <table data-testid={testId} className="w-full border-collapse text-body-sm">
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column}
              className={`${CELL} font-mono text-caption font-semibold text-on-surface-variant`}
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="text-on-surface">
        {rows.map((row, index) => (
          <tr key={index} data-testid={`${testId}-row`}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className={`${CELL} font-mono align-top break-all`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SqlLabDemo(): ReactNode {
  const [manager, setManager] = useState<string>(DEFAULT_MANAGER);
  const [labState, setLabState] = useState<LabState>({ kind: 'loading', preset: 'org-chart' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const runPreset = (preset: PresetId): void => {
    const trimmed = manager.trim();
    const url =
      preset === 'org-chart' && trimmed.length > 0
        ? `${ORG_CHART_URL}?manager=${encodeURIComponent(trimmed)}`
        : PRESET_URLS[preset];
    setLabState({ kind: 'loading', preset });
    void (async () => {
      try {
        const response = await fetch(url);
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parsePresetPayload(preset, parsed.value) : null;
        if (shaped === null) {
          setLabState({
            kind: 'failed',
            preset,
            problem: `status ${String(response.status)} — the answer was not a lab exhibit:\n${text}`,
          });
          return;
        }
        setLabState({ kind: 'ready', payload: shaped });
      } catch {
        if (aliveRef.current) {
          setLabState({
            kind: 'failed',
            preset,
            problem: 'could not reach the server — is the guide running on :4000?',
          });
        }
      }
    })();
  };

  // The lab opens on the org chart — the seed's CEO root, no click needed.
  useEffect(() => {
    runPreset('org-chart');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = labState.kind === 'ready' ? labState.payload : null;
  // The preset currently on stage (or loading) — not highlighted on failure.
  const activePreset =
    labState.kind === 'ready' ? labState.payload.preset : labState.kind === 'loading' ? labState.preset : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="sql-lab-summary" className="text-body-sm text-on-surface">
        The SQL-by-hand lab: four named queries against the seeded staff dataset, run live on an
        in-memory handle. Every exhibit shows the exact SQL that ran beside its result table — the
        recursive CTE, the window functions, the join+aggregate rollup, and the EXPLAIN pair where
        one expression defeats an index the other one uses.
      </p>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-testid={`sql-lab-preset-${preset.id}`}
              onClick={() => runPreset(preset.id)}
              disabled={labState.kind === 'loading'}
              className={activePreset === preset.id ? BUTTON_ACTIVE : BUTTON}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-xs sm:flex-row sm:items-end">
          <label className="flex flex-col gap-xxs">
            <span className={LABEL}>root manager id — the recursive anchor (org chart only)</span>
            <input
              data-testid="sql-lab-manager"
              value={manager}
              onChange={(event) => setManager(event.target.value)}
              spellCheck={false}
              className={INPUT}
            />
          </label>
        </div>
        <p className="text-caption text-on-surface-variant">
          {PRESETS.find((preset) => preset.id === activePreset)?.blurb ?? 'pick a query to run'}
        </p>
      </div>

      {labState.kind === 'loading' && (
        <p data-testid="sql-lab-loading" className="text-body-sm text-on-surface-variant">
          running the query on the demo handle…
        </p>
      )}
      {labState.kind === 'failed' && (
        <pre data-testid="sql-lab-failed" className={PRE}>
          {labState.problem}
        </pre>
      )}

      {ready?.preset === 'org-chart' && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">WITH RECURSIVE</h3>
            <span data-testid="sql-lab-root" className={CHIP}>
              root: {ready.data.root}
            </span>
            <span data-testid="sql-lab-shape" className={CHIP}>
              {String(ready.data.rows.length)} staff · max depth {String(ready.data.maxDepth)}
            </span>
            <span className={CHIP}>{ready.data.dataset}</span>
          </div>
          <pre data-testid="sql-lab-sql" className={PRE}>
            {ready.data.sql}
          </pre>
          <ExhibitTable
            testId="sql-lab-rows"
            columns={['depth', 'id', 'name', 'manager_id', 'path']}
            rows={ready.data.rows.map((row) => [
              String(row.depth),
              row.id,
              row.name,
              row.manager_id ?? '—',
              row.path,
            ])}
          />
          <p data-testid="sql-lab-note" className="text-body-sm text-on-surface">
            {ready.data.note}
          </p>
        </section>
      )}

      {ready?.preset === 'salary-window' && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">RANK() + SUM() OVER</h3>
            <span data-testid="sql-lab-shape" className={CHIP}>
              {String(ready.data.rows.length)} rows, windows kept every one
            </span>
            <span className={CHIP}>{ready.data.dataset}</span>
          </div>
          <pre data-testid="sql-lab-sql" className={PRE}>
            {ready.data.sql}
          </pre>
          <ExhibitTable
            testId="sql-lab-rows"
            columns={[
              'name',
              'department',
              'salary_cents',
              'salary_rank_in_department',
              'running_salary_total_cents',
              'hired_at',
            ]}
            rows={ready.data.rows.map((row) => [
              row.name,
              row.department,
              `${formatCents(row.salary_cents)} (${row.salary_cents.toLocaleString('en-US')}¢)`,
              String(row.salary_rank_in_department),
              `${formatCents(row.running_salary_total_cents)} (${row.running_salary_total_cents.toLocaleString('en-US')}¢)`,
              row.hired_at,
            ])}
          />
          <p data-testid="sql-lab-note" className="text-body-sm text-on-surface">
            {ready.data.note}
          </p>
        </section>
      )}

      {ready?.preset === 'department-rollup' && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">join + aggregate</h3>
            <span data-testid="sql-lab-shape" className={CHIP}>
              {String(ready.data.rows.length)} departments
            </span>
            <span className={CHIP}>{ready.data.dataset}</span>
          </div>
          <pre data-testid="sql-lab-sql" className={PRE}>
            {ready.data.sql}
          </pre>
          <ExhibitTable
            testId="sql-lab-rows"
            columns={['department', 'headcount', 'total_salary_cents', 'avg_salary_cents', 'manager_name']}
            rows={ready.data.rows.map((row) => [
              row.department,
              String(row.headcount),
              formatCents(row.total_salary_cents),
              formatCents(row.avg_salary_cents),
              row.manager_name ?? '—',
            ])}
          />
          <p data-testid="sql-lab-note" className="text-body-sm text-on-surface">
            {ready.data.note}
          </p>
        </section>
      )}

      {ready?.preset === 'plan-comparison' && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">EXPLAIN QUERY PLAN</h3>
            <span data-testid="sql-lab-threshold" className={CHIP}>
              threshold: {formatCents(ready.data.thresholdCents)} ({ready.data.thresholdCents.toLocaleString('en-US')}¢)
            </span>
            <span className={CHIP}>
              annual: {formatCents(ready.data.annualThresholdCents)}
            </span>
          </div>
          <div className="grid gap-sm sm:grid-cols-2">
            {ready.data.variants.map((variant, index) => (
              <div key={variant.label} data-testid={`sql-lab-variant-${index}`} className="flex flex-col gap-xs">
                <div className="flex flex-wrap items-center gap-sm">
                  <span className={CHIP}>{variant.label}</span>
                  <span
                    data-testid={`sql-lab-variant-verdict-${index}`}
                    className={variant.usedIndex ? CHIP_OK : CHIP_ERROR}
                  >
                    {variant.verb}
                    {variant.usedIndex ? ' · USING INDEX' : ' · NO INDEX'}
                  </span>
                </div>
                <pre className={PRE}>
                  {`${variant.sql}   -- bound: ${variant.boundValue.toLocaleString('en-US')}

${variant.steps.join('\n')}`}
                </pre>
                <p className="text-caption text-on-surface-variant">{variant.note}</p>
              </div>
            ))}
          </div>
          <p data-testid="sql-lab-note" className="text-body-sm text-on-surface">
            {ready.data.verdict}
          </p>
        </section>
      )}
    </div>
  );
}
