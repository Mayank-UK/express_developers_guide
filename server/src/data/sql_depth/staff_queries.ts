import type Database from 'better-sqlite3';
import { classifyPlanVerb, explainQueryPlan, planUsesIndex } from './query_plans.js';

/**
 * The SQL-by-hand lab: three named queries against the seeded staff table,
 * each returned WITH the exact SQL that ran — the teaching point is reading
 * the query beside its result. Every value is bound through a ? parameter;
 * no string ever gets concatenated into SQL here (the injection topic's rule,
 * practiced, not just preached).
 *
 * Query 1 — recursive CTE: a manager's whole reporting subtree, with depth.
 * Query 2 — window functions: per-department salary RANK plus a running
 *           salary total by hire date, both computed OVER the rows instead of
 *           by collapsing them (that is the difference vs GROUP BY).
 * Query 3 — join + aggregate: one rollup row per department. Aggregate FIRST
 *           in the dept subquery, join AFTER — joining before grouping would
 *           multiply rows and corrupt every count. The LEFT JOIN finds each
 *           department's manager (the member its own people report to);
 *           executive has none — the CEO reports to nobody — and LEFT keeps
 *           that row with a null name instead of dropping it.
 */

/** Every query result carries its own SQL so the UI can display both. */
export interface SqlExhibit<T> {
  readonly sql: string;
  readonly rows: readonly T[];
}

/** The org chart's root — the seeded CEO. */
export const STAFF_CEO_ID = 'staff-001';

// --- query 1: the recursive CTE ------------------------------------------------

export const ORG_CHART_SQL = `
WITH RECURSIVE org_chart (depth, id, name, manager_id, path) AS (
    SELECT 0, id, name, manager_id, name          -- anchor: the chosen root
    FROM staff
    WHERE id = ?
  UNION ALL
    SELECT                                       -- recursive step: everyone reporting into the chart so far
      o.depth + 1, s.id, s.name, s.manager_id, o.path || ' > ' || s.name
    FROM staff s
    JOIN org_chart o ON s.manager_id = o.id
)
SELECT depth, id, name, manager_id, path
FROM org_chart
ORDER BY depth, name
`;

export interface OrgChartRow {
  depth: number;
  id: string;
  name: string;
  manager_id: string | null;
  path: string;
}

/**
 * The subtree under one manager. Rows are empty exactly when the id matches
 * nobody — the caller turns that into a 404.
 */
export function orgChartUnder(db: Database.Database, managerId: string): SqlExhibit<OrgChartRow> {
  return {
    sql: ORG_CHART_SQL,
    rows: db.prepare(ORG_CHART_SQL).all(managerId) as OrgChartRow[],
  };
}

// --- query 2: window functions ---------------------------------------------------

export const SALARY_WINDOW_SQL = `
SELECT
  name,
  department,
  salary_cents,
  RANK() OVER (PARTITION BY department ORDER BY salary_cents DESC) AS salary_rank_in_department,
  SUM(salary_cents) OVER (PARTITION BY department ORDER BY hired_at) AS running_salary_total_cents,
  hired_at
FROM staff
ORDER BY department, hired_at
`;

export interface SalaryWindowRow {
  name: string;
  department: string;
  salary_cents: number;
  salary_rank_in_department: number;
  running_salary_total_cents: number;
  hired_at: string;
}

export function salaryWindowByDepartment(db: Database.Database): SqlExhibit<SalaryWindowRow> {
  return {
    sql: SALARY_WINDOW_SQL,
    rows: db.prepare(SALARY_WINDOW_SQL).all() as SalaryWindowRow[],
  };
}

// --- query 3: join + aggregate ---------------------------------------------------

export const DEPARTMENT_ROLLUP_SQL = `
SELECT
  dept.department,
  dept.headcount,
  dept.total_salary_cents,
  dept.avg_salary_cents,
  mgr.name AS manager_name
FROM (
  SELECT
    department,
    COUNT(*) AS headcount,
    SUM(salary_cents) AS total_salary_cents,
    CAST(ROUND(AVG(salary_cents)) AS INTEGER) AS avg_salary_cents
  FROM staff
  GROUP BY department
) dept
LEFT JOIN staff mgr
  ON mgr.department = dept.department
 AND mgr.id IN (                      -- the department's manager: the member its own people report to
     SELECT manager_id FROM staff
     WHERE department = dept.department AND manager_id IS NOT NULL
   )
ORDER BY dept.department
`;

export interface DepartmentRollupRow {
  department: string;
  headcount: number;
  total_salary_cents: number;
  avg_salary_cents: number;
  manager_name: string | null;
}

export function departmentSalaryRollup(db: Database.Database): SqlExhibit<DepartmentRollupRow> {
  return {
    sql: DEPARTMENT_ROLLUP_SQL,
    rows: db.prepare(DEPARTMENT_ROLLUP_SQL).all() as DepartmentRollupRow[],
  };
}

// --- the EXPLAIN lab: one predicate, two plans -----------------------------------

const INDEX_FRIENDLY_SALARY_SQL = 'SELECT id, name FROM staff WHERE salary_cents > ?';
const INDEX_DEFEATING_SALARY_SQL = 'SELECT id, name FROM staff WHERE salary_cents * 12 > ?';

/** A salary band deep enough to be selective over the 12-row seed. */
export const SALARY_THRESHOLD_CENTS = 12_000_000;

export interface PlanVariant {
  readonly label: string;
  readonly sql: string;
  readonly boundValue: number;
  readonly steps: readonly string[];
  readonly verb: 'SEARCH' | 'SCAN' | 'OTHER';
  readonly usedIndex: boolean;
  readonly note: string;
}

export interface PlanComparison {
  readonly thresholdCents: number;
  readonly annualThresholdCents: number;
  readonly variants: readonly [PlanVariant, PlanVariant];
}

/**
 * The same predicate twice: `salary_cents > 12M` can seek the salary index,
 * while `salary_cents * 12 > 144M` — mathematically the same filter — forces
 * a full scan, because applying ANY function to the column means the index on
 * the bare column can no longer be walked. The optimizer plans around the
 * expression you wrote, not the math you meant.
 */
export function salaryIndexComparison(db: Database.Database): PlanComparison {
  const planVariant = (
    label: string,
    sql: string,
    boundValue: number,
    note: string,
  ): PlanVariant => {
    const steps = explainQueryPlan(db, sql, boundValue);
    return {
      label,
      sql,
      boundValue,
      steps,
      verb: classifyPlanVerb(steps),
      usedIndex: planUsesIndex(steps),
      note,
    };
  };

  return {
    thresholdCents: SALARY_THRESHOLD_CENTS,
    annualThresholdCents: SALARY_THRESHOLD_CENTS * 12,
    variants: [
      planVariant(
        'index-friendly',
        INDEX_FRIENDLY_SALARY_SQL,
        SALARY_THRESHOLD_CENTS,
        'the bare column compared to a bound value — the B-tree over salary_cents answers it directly.',
      ),
      planVariant(
        'index-defeating',
        INDEX_DEFEATING_SALARY_SQL,
        SALARY_THRESHOLD_CENTS * 12,
        'the same filter wrapped around the column — no index on salary_cents * anything exists, so every row must be read and multiplied.',
      ),
    ],
  };
}
