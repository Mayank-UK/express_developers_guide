import { useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:search` — full-text search both ways at once: one
 * term, fired at the posts FTS5 index (bm25-ranked matches with a snippet,
 * hits marked inline) and at LIKE '%…%' on the same columns, side by side
 * with both query plans so the inverted-index SEARCH and the leading-wildcard
 * SCAN can be read next to each other.
 */

const SEARCH_URL = '/api/demo/db/search';

const DEFAULT_TERM = 'database';

interface FtsRow {
  id: string;
  title: string;
  excerpt: string;
  rank: number;
}

interface LikeRow {
  id: string;
  title: string;
}

interface SearchSide {
  sql: string;
  rows: Array<Record<string, unknown>>;
  planSteps: string[];
  verb: string;
  usedIndex: boolean;
}

interface SearchOutcome {
  query: string;
  fts: SearchSide;
  ftsRows: FtsRow[];
  like: SearchSide;
  likeRows: LikeRow[];
  verdict: string;
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: SearchOutcome }
  | { kind: 'failed'; problem: string };

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseSearch(value: unknown): SearchOutcome | null {
  if (!isRecord(value)) return null;
  const fts = isRecord(value.fts) ? value.fts : null;
  const like = isRecord(value.like) ? value.like : null;
  if (fts === null || like === null) return null;
  if (typeof fts.sql !== 'string' || typeof like.sql !== 'string') return null;

  const parseSide = (side: Record<string, unknown>): SearchSide => ({
    sql: asString(side.sql),
    rows: Array.isArray(side.rows) ? side.rows.filter(isRecord) : [],
    planSteps: Array.isArray(side.planSteps) ? side.planSteps.map((step) => String(step)) : [],
    verb: asString(side.verb),
    usedIndex: side.usedIndex === true,
  });

  const ftsSide = parseSide(fts);
  const likeSide = parseSide(like);
  return {
    query: asString(value.query),
    fts: ftsSide,
    ftsRows: ftsSide.rows.map((row) => ({
      id: asString(row.id),
      title: asString(row.title),
      excerpt: asString(row.excerpt, ''),
      rank: asNumber(row.rank),
    })),
    like: likeSide,
    likeRows: likeSide.rows.map((row) => ({
      id: asString(row.id),
      title: asString(row.title),
    })),
    verdict: asString(value.verdict, ''),
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

/** The plan chip every side carries: what the planner chose to do. */
function planChipClass(side: SearchSide): string {
  return side.usedIndex ? CHIP_OK : CHIP_ERROR;
}

function planChipText(side: SearchSide): string {
  return `${side.verb}${side.usedIndex ? ' · USING INDEX' : ' · NO INDEX'}`;
}

export default function FtsSearchDemo(): ReactNode {
  const [term, setTerm] = useState<string>(DEFAULT_TERM);
  const [searchState, setSearchState] = useState<SearchState>({ kind: 'idle' });

  const fireSearch = (): void => {
    setSearchState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(term.trim())}`);
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseSearch(parsed.value) : null;
        if (shaped === null) {
          setSearchState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a search comparison:\n${text}`,
          });
          return;
        }
        setSearchState({ kind: 'answered', outcome: shaped });
      } catch {
        setSearchState({
          kind: 'failed',
          problem: 'could not reach the server — is the guide running on :4000?',
        });
      }
    })();
  };

  const outcome = searchState.kind === 'answered' ? searchState.outcome : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="fts-search-summary" className="text-body-sm text-on-surface">
        One term, two search engines: FTS5 MATCH walks the inverted index and answers bm25-ranked
        rows with a snippet around the hits, while LIKE '%…%' has no prefix to seek and scans every
        row. Both SQL strings and both query plans come back side by side.
      </p>

      <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-col gap-xs sm:flex-row">
          <input
            data-testid="fts-search-term"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            spellCheck={false}
            className={INPUT}
          />
          <button
            type="button"
            data-testid="fts-search-fire"
            onClick={fireSearch}
            disabled={searchState.kind === 'loading' || term.trim().length === 0}
            className={BUTTON_PRIMARY}
          >
            {searchState.kind === 'loading' ? 'searching…' : 'search both ways'}
          </button>
        </div>
        <p className="text-caption text-on-surface-variant">
          plain words, "phrases", and OR work — a lone quote is not a valid FTS5 query and comes
          back as a 400
        </p>

        {searchState.kind === 'idle' && (
          <p data-testid="fts-search-idle" className="text-body-sm text-on-surface-variant">
            nothing searched yet — fire a term to race the index against the scan
          </p>
        )}
        {searchState.kind === 'failed' && (
          <pre data-testid="fts-search-failed" className={PRE}>
            {searchState.problem}
          </pre>
        )}
      </div>

      {outcome !== null && (
        <>
          <div className="grid gap-sm sm:grid-cols-2">
            <section
              data-testid="fts-search-fts-side"
              className="flex flex-col gap-sm rounded-md border border-outline p-sm"
            >
              <div className="flex flex-wrap items-center gap-sm">
                <h3 className="font-mono text-body-sm font-semibold text-on-surface">FTS5 MATCH</h3>
                <span data-testid="fts-search-fts-plan" className={planChipClass(outcome.fts)}>
                  {planChipText(outcome.fts)}
                </span>
                <span className={CHIP}>{String(outcome.ftsRows.length)} rows · bm25-ranked</span>
              </div>
              {outcome.ftsRows.length === 0 ? (
                <p data-testid="fts-search-fts-empty" className="text-body-sm text-on-surface-variant">
                  no matches — the index answered instantly anyway
                </p>
              ) : (
                <div className="flex flex-col gap-xs">
                  {outcome.ftsRows.map((row) => (
                    <p
                      key={row.id}
                      data-testid="fts-search-fts-row"
                      className="flex flex-col gap-xxs font-mono text-caption"
                    >
                      <span className="flex flex-wrap items-center gap-xs">
                        <span className={CHIP}>{row.rank.toFixed(3)}</span>
                        <span className="text-on-surface">{row.title}</span>
                      </span>
                      <span data-testid="fts-search-fts-excerpt" className="break-words text-on-surface-variant">
                        {row.excerpt}
                      </span>
                    </p>
                  ))}
                </div>
              )}
              <pre data-testid="fts-search-fts-sql" className={PRE}>
                {`${outcome.fts.sql}

-- plan
${outcome.fts.planSteps.join('\n')}`}
              </pre>
            </section>

            <section
              data-testid="fts-search-like-side"
              className="flex flex-col gap-sm rounded-md border border-outline p-sm"
            >
              <div className="flex flex-wrap items-center gap-sm">
                <h3 className="font-mono text-body-sm font-semibold text-on-surface">LIKE '%…%'</h3>
                <span data-testid="fts-search-like-plan" className={planChipClass(outcome.like)}>
                  {planChipText(outcome.like)}
                </span>
                <span className={CHIP}>{String(outcome.likeRows.length)} rows · substring match</span>
              </div>
              {outcome.likeRows.length === 0 ? (
                <p data-testid="fts-search-like-empty" className="text-body-sm text-on-surface-variant">
                  no matches — it still read every row to find that out
                </p>
              ) : (
                <div className="flex flex-col gap-xxs">
                  {outcome.likeRows.map((row) => (
                    <p key={row.id} data-testid="fts-search-like-row" className="font-mono text-caption">
                      <span className="text-on-surface">{row.title}</span>
                    </p>
                  ))}
                </div>
              )}
              <pre data-testid="fts-search-like-sql" className={PRE}>
                {`${outcome.like.sql}

-- plan
${outcome.like.planSteps.join('\n')}`}
              </pre>
            </section>
          </div>
          <p data-testid="fts-search-verdict" className="text-body-sm text-on-surface">
            {outcome.verdict}
          </p>
        </>
      )}
    </div>
  );
}
