import type Database from 'better-sqlite3';

/**
 * The booking race, both implementations of "decrement the last ticket".
 *
 * naive — check, then act, with real work in between:
 *   SELECT the stock, await a ~50ms delay (any async work yields the event
 *   loop — that is the whole lesson), then UPDATE stock = stock - 1 guarded
 *   by NOTHING. Two concurrent calls both read the same stock and both write,
 *   overselling below zero.
 *
 * safe — the guard lives in the write itself:
 *   ONE statement, UPDATE ... SET stock = stock - 1 WHERE item = ? AND
 *   stock > 0. SQLite serializes writers, so exactly one attempt can match
 *   the row while stock is still positive; the loser sees changes === 0 and
 *   reports a clean conflict (409) instead of a negative shelf.
 */

export const SELECT_STOCK_SQL = 'SELECT stock FROM inventory WHERE item = ?';
export const NAIVE_DECREMENT_SQL = 'UPDATE inventory SET stock = stock - 1 WHERE item = ?';
export const SAFE_DECREMENT_SQL =
  'UPDATE inventory SET stock = stock - 1 WHERE item = ? AND stock > 0';

export interface BookingOutcome {
  readonly succeeded: boolean;
  /** naive only: the stock this attempt read BEFORE its delay. */
  readonly stockObserved?: number;
  /** safe only: rows the guarded UPDATE matched (0 = guard rejected it). */
  readonly rowsMatched?: number;
  readonly failureKind?: 'conflict' | 'not_found';
  readonly httpStatus?: number;
  readonly message: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The deliberate yield: better-sqlite3 calls are synchronous, so the ONLY way
 * two bookings interleave is an await between the read and the write — which
 * is exactly what real handlers have (an external call, a cache hop, work).
 */
export async function bookNaive(
  db: Database.Database,
  item: string,
  delayMs = 50,
): Promise<BookingOutcome> {
  const row = db.prepare(SELECT_STOCK_SQL).get(item) as { stock: number } | undefined;
  if (row === undefined) {
    return {
      succeeded: false,
      failureKind: 'not_found',
      httpStatus: 404,
      message: `no inventory row for "${item}"`,
    };
  }
  await sleep(delayMs);
  db.prepare(NAIVE_DECREMENT_SQL).run(item);
  return {
    succeeded: true,
    stockObserved: row.stock,
    message: `booked against a read of stock=${row.stock} — by the time this wrote, that read was already stale`,
  };
}

export function bookSafe(db: Database.Database, item: string): BookingOutcome {
  const result = db.prepare(SAFE_DECREMENT_SQL).run(item);
  if (result.changes === 1) {
    return {
      succeeded: true,
      rowsMatched: 1,
      message: 'booked — the stock > 0 guard and the decrement were one atomic statement',
    };
  }
  const row = db.prepare(SELECT_STOCK_SQL).get(item) as { stock: number } | undefined;
  if (row === undefined) {
    return {
      succeeded: false,
      failureKind: 'not_found',
      httpStatus: 404,
      rowsMatched: 0,
      message: `no inventory row for "${item}"`,
    };
  }
  return {
    succeeded: false,
    failureKind: 'conflict',
    httpStatus: 409,
    rowsMatched: 0,
    message: `sold out (stock=${row.stock}) — the WHERE stock > 0 guard matched 0 rows, so this booking cleanly failed instead of overselling`,
  };
}
