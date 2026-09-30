import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SqlLabDemo from './sql_lab_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ORG_CHART_URL = '/api/demo/db/sql-lab/org-chart';
const SALARY_WINDOW_URL = '/api/demo/db/sql-lab/salary-window';
const ROLLUP_URL = '/api/demo/db/sql-lab/department-rollup';
const PLANS_URL = '/api/demo/db/sql-lab/plan-comparison';

const ORG_CHART_BODY = {
  dataset: 'staff — 12 rows, 3 levels, self-referencing manager FK',
  root: 'staff-001',
  sql: 'WITH RECURSIVE org_chart (depth, id, name, manager_id, path) AS (\n  SELECT 0, id, name, manager_id, name\n  …',
  rows: [
    { depth: 0, id: 'staff-001', name: 'Ada Lovelace (CEO)', manager_id: null, path: 'Ada Lovelace (CEO)' },
    { depth: 1, id: 'staff-002', name: 'Ben Bitdiddle (VP)', manager_id: 'staff-001', path: 'Ada Lovelace (CEO) > Ben Bitdiddle (VP)' },
    { depth: 2, id: 'staff-005', name: 'Cy Fiend (eng)', manager_id: 'staff-002', path: 'Ada Lovelace (CEO) > Ben Bitdiddle (VP) > Cy Fiend (eng)' },
  ],
  maxDepth: 2,
  note: 'WITH RECURSIVE: the anchor selects the root, the recursive step joins staff to the chart built so far.',
};

const SALARY_WINDOW_BODY = {
  dataset: 'staff — 12 rows, 4 departments',
  sql: 'SELECT name, department, salary_cents, RANK() OVER (…) AS salary_rank_in_department, …',
  rows: [
    {
      name: 'Ben Bitdiddle',
      department: 'engineering',
      salary_cents: 18000000,
      salary_rank_in_department: 1,
      running_salary_total_cents: 18000000,
      hired_at: '2021-03-01',
    },
    {
      name: 'Cy Fiend',
      department: 'engineering',
      salary_cents: 14000000,
      salary_rank_in_department: 2,
      running_salary_total_cents: 32000000,
      hired_at: '2022-06-15',
    },
  ],
  note: 'RANK() ranks salaries INSIDE each department without collapsing the rows.',
};

const ROLLUP_BODY = {
  dataset: 'staff — 12 rows, 4 departments',
  sql: 'SELECT dept.department, dept.headcount, … FROM ( SELECT department, COUNT(*) … ) dept LEFT JOIN staff mgr …',
  rows: [
    { department: 'engineering', headcount: 5, total_salary_cents: 70000000, avg_salary_cents: 14000000, manager_name: 'Ben Bitdiddle' },
    { department: 'executive', headcount: 1, total_salary_cents: 24000000, avg_salary_cents: 24000000, manager_name: null },
  ],
  note: 'aggregate FIRST, join AFTER — the LEFT JOIN keeps executive with a null manager name.',
};

const PLANS_BODY = {
  thresholdCents: 12000000,
  annualThresholdCents: 144000000,
  variants: [
    {
      label: 'index-friendly',
      sql: 'SELECT id, name FROM staff WHERE salary_cents > ?',
      boundValue: 12000000,
      steps: ['SEARCH staff USING INDEX idx_staff_salary (salary_cents>?)'],
      verb: 'SEARCH',
      usedIndex: true,
      note: 'the bare column compared to a bound value — the B-tree answers it directly.',
    },
    {
      label: 'index-defeating',
      sql: 'SELECT id, name FROM staff WHERE salary_cents * 12 > ?',
      boundValue: 144000000,
      steps: ['SCAN staff'],
      verb: 'SCAN',
      usedIndex: false,
      note: 'the same filter wrapped around the column — every row must be read and multiplied.',
    },
  ],
  verdict: 'same filter, two plans: wrapping the column in ANY expression hides it from the index.',
};

describe('SqlLabDemo — the preset picker', () => {
  it('loads the recursive-CTE org chart on mount, with SQL beside the rows', async () => {
    stubApiFetch([{ url: `${ORG_CHART_URL}?manager=staff-001`, body: ORG_CHART_BODY }]);

    render(<SqlLabDemo />);

    const rows = await screen.findByTestId('sql-lab-rows');
    expect(rows).toHaveTextContent('Ada Lovelace (CEO)');
    expect(rows).toHaveTextContent('Ben Bitdiddle (VP)');
    expect(rows).toHaveTextContent('Ada Lovelace (CEO) > Ben Bitdiddle (VP) > Cy Fiend (eng)');
    expect(screen.getByTestId('sql-lab-sql')).toHaveTextContent('WITH RECURSIVE');
    expect(screen.getByTestId('sql-lab-root')).toHaveTextContent('root: staff-001');
    expect(screen.getByTestId('sql-lab-shape')).toHaveTextContent('max depth 2');
    expect(screen.getByTestId('sql-lab-note')).toHaveTextContent('the anchor selects the root');
  });

  it('an edited manager id is urlencoded into the org-chart query', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: `${ORG_CHART_URL}?manager=staff-001`, body: ORG_CHART_BODY },
        { url: `${ORG_CHART_URL}?manager=staff-002`, body: { ...ORG_CHART_BODY, root: 'staff-002', rows: ORG_CHART_BODY.rows.slice(1) } },
      ]);
      return vi.mocked(fetch);
    })();

    render(<SqlLabDemo />);
    await screen.findByTestId('sql-lab-rows');

    fireEvent.change(screen.getByTestId('sql-lab-manager'), { target: { value: 'staff-002' } });
    fireEvent.click(screen.getByTestId('sql-lab-preset-org-chart'));

    expect(await screen.findByTestId('sql-lab-rows')).toHaveTextContent('Cy Fiend (eng)');
    expect(screen.getByTestId('sql-lab-root')).toHaveTextContent('root: staff-002');
    expect(fetchMock).toHaveBeenLastCalledWith(`${ORG_CHART_URL}?manager=staff-002`);
  });

  it('the window preset renders rank and the running total beside formatted cents', async () => {
    stubApiFetch([
      { url: `${ORG_CHART_URL}?manager=staff-001`, body: ORG_CHART_BODY },
      { url: SALARY_WINDOW_URL, body: SALARY_WINDOW_BODY },
    ]);

    render(<SqlLabDemo />);
    await screen.findByTestId('sql-lab-rows');

    fireEvent.click(screen.getByTestId('sql-lab-preset-salary-window'));

    const rows = await screen.findByTestId('sql-lab-rows');
    expect(rows).toHaveTextContent('salary_rank_in_department');
    expect(rows).toHaveTextContent('running_salary_total_cents');
    expect(rows).toHaveTextContent('$140,000.00');
    expect(rows).toHaveTextContent('$320,000.00');
    expect(screen.getByTestId('sql-lab-sql')).toHaveTextContent('RANK() OVER');
  });

  it('the rollup preset renders a null manager as an em dash', async () => {
    stubApiFetch([
      { url: `${ORG_CHART_URL}?manager=staff-001`, body: ORG_CHART_BODY },
      { url: ROLLUP_URL, body: ROLLUP_BODY },
    ]);

    render(<SqlLabDemo />);
    await screen.findByTestId('sql-lab-rows');

    fireEvent.click(screen.getByTestId('sql-lab-preset-department-rollup'));

    const rows = await screen.findByTestId('sql-lab-rows');
    expect(rows).toHaveTextContent('engineering');
    expect(rows).toHaveTextContent('Ben Bitdiddle');
    expect(rows).toHaveTextContent('—'); // executive: the CEO reports to nobody
    expect(screen.getByTestId('sql-lab-note')).toHaveTextContent('aggregate FIRST, join AFTER');
  });

  it('the EXPLAIN preset renders both verdicts — seek vs full scan', async () => {
    stubApiFetch([
      { url: `${ORG_CHART_URL}?manager=staff-001`, body: ORG_CHART_BODY },
      { url: PLANS_URL, body: PLANS_BODY },
    ]);

    render(<SqlLabDemo />);
    await screen.findByTestId('sql-lab-rows');

    fireEvent.click(screen.getByTestId('sql-lab-preset-plan-comparison'));

    expect(await screen.findByTestId('sql-lab-variant-verdict-0')).toHaveTextContent('SEARCH · USING INDEX');
    expect(screen.getByTestId('sql-lab-variant-verdict-1')).toHaveTextContent('SCAN · NO INDEX');
    expect(screen.getByTestId('sql-lab-variant-0')).toHaveTextContent('salary_cents > ?');
    expect(screen.getByTestId('sql-lab-variant-1')).toHaveTextContent('salary_cents * 12 > ?');
    expect(screen.getByTestId('sql-lab-note')).toHaveTextContent('same filter, two plans');
  });

  it('degrades to a failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<SqlLabDemo />);

    const failed = await screen.findByTestId('sql-lab-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});
