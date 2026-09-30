import type Database from 'better-sqlite3';
import { classifyPlanVerb, explainQueryPlan, planUsesIndex } from './query_plans.js';

/**
 * Full-text search over posts, both ways at once, so the plans can be read
 * side by side:
 *
 *  - FTS5 MATCH against the posts_fts index (external-content, kept in step
 *    by the migration's triggers). `rank` is bm25 — NEGATIVE scores where
 *    more negative = better match — and ORDER BY rank lets the FTS5 module
 *    sort by relevance directly.
 *  - LIKE '%…%' on the same two columns: substring matching over a B-tree
 *    table can use no index at all (a leading wildcard has no prefix to seek),
 *    so the plan is a full SCAN of posts.
 *
 * Both queries bind the user's term as a ? parameter. The LIKE variants
 * concatenate the wildcards AROUND the placeholder in SQL — the term itself
 * never becomes SQL text.
 */

export const FTS_SEARCH_SQL = `
SELECT
  p.id,
  p.title,
  snippet(posts_fts, 1, '[', ']', '…', 8) AS excerpt,   -- column 1 = body, hits marked inline
  rank                                                 -- bm25: negative score, more negative = better
FROM posts_fts
JOIN posts p ON p.rowid = posts_fts.rowid               -- external content: fetch id/title from posts
WHERE posts_fts MATCH ?
ORDER BY rank
`;

export const LIKE_SEARCH_SQL = `
SELECT id, title
FROM posts
WHERE title LIKE '%' || ? || '%' OR body LIKE '%' || ? || '%'
ORDER BY created_at DESC
`;

export interface FtsSearchRow {
  id: string;
  title: string;
  excerpt: string;
  rank: number;
}

export interface LikeSearchRow {
  id: string;
  title: string;
}

export interface SearchPlanSide {
  readonly sql: string;
  readonly rows: readonly unknown[];
  readonly planSteps: readonly string[];
  readonly verb: 'SEARCH' | 'SCAN' | 'OTHER';
  readonly usedIndex: boolean;
}

export interface SearchComparison {
  readonly query: string;
  readonly fts: SearchPlanSide;
  readonly like: SearchPlanSide;
}

export function searchPostsWithComparison(db: Database.Database, term: string): SearchComparison {
  const ftsRows = db.prepare(FTS_SEARCH_SQL).all(term) as FtsSearchRow[];
  const likeRows = db.prepare(LIKE_SEARCH_SQL).all(term, term) as LikeSearchRow[];

  const side = (sql: string, rows: readonly unknown[], planParams: readonly unknown[]): SearchPlanSide => {
    const planSteps = explainQueryPlan(db, sql, ...planParams);
    return {
      sql,
      rows,
      planSteps,
      verb: classifyPlanVerb(planSteps),
      usedIndex: planUsesIndex(planSteps),
    };
  };

  return {
    query: term,
    fts: side(FTS_SEARCH_SQL, ftsRows, [term]),
    like: side(LIKE_SEARCH_SQL, likeRows, [term, term]),
  };
}
