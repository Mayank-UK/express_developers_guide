import type Database from 'better-sqlite3';

/**
 * Small EXPLAIN QUERY PLAN helpers shared by the sql-depth exhibits, so every
 * demo reports plans in the same shape: the raw optimizer steps plus the two
 * derived facts the UI highlights (which access verb ran, whether an index
 * served the query).
 */

/** The optimizer's chosen steps, e.g. 'SEARCH staff USING INDEX ...'. */
export function explainQueryPlan(
  db: Database.Database,
  sql: string,
  ...params: readonly unknown[]
): readonly string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
  ).map((row) => row.detail);
}

export type PlanVerb = 'SEARCH' | 'SCAN' | 'OTHER';

/** SEARCH = the engine jumped straight to candidate rows; SCAN = it read them all. */
export function classifyPlanVerb(steps: readonly string[]): PlanVerb {
  if (steps.some((step) => /\bSEARCH\b/.test(step))) return 'SEARCH';
  if (steps.some((step) => /\bSCAN\b/.test(step))) return 'SCAN';
  return 'OTHER';
}

export function planUsesIndex(steps: readonly string[]): boolean {
  // 'USING INDEX' is the B-tree form; 'VIRTUAL TABLE INDEX 0:M…' is how an
  // FTS5 match reports walking its inverted index instead of the content.
  return steps.some(
    (step) => /USING (COVERING )?INDEX|VIRTUAL TABLE INDEX/i.test(step),
  );
}
