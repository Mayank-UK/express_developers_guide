import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BookingRaceDemo from './booking_race_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const RACE_URL = '/api/demo/db/race';

const RACE_SQL = {
  readStock: 'SELECT stock FROM inventory WHERE item = ?',
  naiveDecrement: 'UPDATE inventory SET stock = stock - 1 WHERE item = ?',
  safeDecrement: 'UPDATE inventory SET stock = stock - 1 WHERE item = ? AND stock > 0',
};

function naiveOversellBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    handle: ':memory:',
    item: 'last-ticket',
    mode: 'naive',
    concurrency: 3,
    initialStock: 1,
    attempts: [
      {
        attempt: 1,
        mode: 'naive',
        succeeded: true,
        stockObserved: 1,
        message: 'booked against a read of stock=1 — by the time this wrote, that read was already stale',
      },
      {
        attempt: 2,
        mode: 'naive',
        succeeded: true,
        stockObserved: 1,
        message: 'booked against a read of stock=1 — by the time this wrote, that read was already stale',
      },
      {
        attempt: 3,
        mode: 'naive',
        succeeded: true,
        stockObserved: 1,
        message: 'booked against a read of stock=1 — by the time this wrote, that read was already stale',
      },
    ],
    successCount: 3,
    finalStock: -2,
    oversold: true,
    sql: RACE_SQL,
    explain: 'every attempt SELECTed stock=1 BEFORE any UPDATE ran — two statements are not atomic.',
    ...overrides,
  };
}

function safeGuardedBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    handle: ':memory:',
    item: 'last-ticket',
    mode: 'safe',
    concurrency: 3,
    initialStock: 1,
    attempts: [
      {
        attempt: 1,
        mode: 'safe',
        succeeded: true,
        rowsMatched: 1,
        message: 'booked — the stock > 0 guard and the decrement were one atomic statement',
      },
      {
        attempt: 2,
        mode: 'safe',
        succeeded: false,
        failureKind: 'conflict',
        httpStatus: 409,
        rowsMatched: 0,
        message: 'sold out (stock=0) — the WHERE stock > 0 guard matched 0 rows',
      },
      {
        attempt: 3,
        mode: 'safe',
        succeeded: false,
        failureKind: 'conflict',
        httpStatus: 409,
        rowsMatched: 0,
        message: 'sold out (stock=0) — the WHERE stock > 0 guard matched 0 rows',
      },
    ],
    successCount: 1,
    finalStock: 0,
    oversold: false,
    sql: RACE_SQL,
    explain: 'the WHERE stock > 0 guard lives INSIDE the decrement — the surplus attempts failed cleanly.',
    ...overrides,
  };
}

describe('BookingRaceDemo', () => {
  it('offers both modes and fires the exact naive query string as a POST', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: `${RACE_URL}?mode=naive&concurrency=3&stock=1`, method: 'POST', body: naiveOversellBody() },
      ]);
      return vi.mocked(fetch);
    })();

    render(<BookingRaceDemo />);

    const mode = screen.getByTestId('booking-race-mode') as HTMLSelectElement;
    expect(mode.options).toHaveLength(2);
    expect(mode.value).toBe('naive');

    fireEvent.click(screen.getByTestId('booking-race-fire'));

    expect(await screen.findByTestId('booking-race-result')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${RACE_URL}?mode=naive&concurrency=3&stock=1`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('the naive oversell is visually loud: OVERSOLD error chip, negative stock, stale reads', async () => {
    stubApiFetch([
      { url: `${RACE_URL}?mode=naive&concurrency=3&stock=1`, method: 'POST', body: naiveOversellBody() },
    ]);

    render(<BookingRaceDemo />);

    fireEvent.click(screen.getByTestId('booking-race-fire'));

    expect(await screen.findByTestId('booking-race-final-stock')).toHaveTextContent('final stock: -2 · OVERSOLD');
    expect(screen.getByTestId('booking-race-success-count')).toHaveTextContent('3/3 booked');
    const rows = screen.getAllByTestId('booking-race-attempt-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('#1');
    expect(rows[0]).toHaveTextContent('booked');
    expect(rows[0]).toHaveTextContent('read stock=1');
    expect(rows[0]).toHaveTextContent('that read was already stale');
    expect(screen.getByTestId('booking-race-sql')).toHaveTextContent(
      'UPDATE inventory SET stock = stock - 1 WHERE item = ?',
    );
    expect(screen.getByTestId('booking-race-explain')).toHaveTextContent('not atomic');
  });

  it('the safe mode rejects the surplus bookings with 409 and never oversells', async () => {
    stubApiFetch([
      { url: `${RACE_URL}?mode=safe&concurrency=3&stock=1`, method: 'POST', body: safeGuardedBody() },
    ]);

    render(<BookingRaceDemo />);

    fireEvent.change(screen.getByTestId('booking-race-mode'), { target: { value: 'safe' } });
    fireEvent.click(screen.getByTestId('booking-race-fire'));

    expect(await screen.findByTestId('booking-race-final-stock')).toHaveTextContent('final stock: 0');
    expect(screen.getByTestId('booking-race-final-stock')).not.toHaveTextContent('OVERSOLD');
    const rows = screen.getAllByTestId('booking-race-attempt-row');
    expect(rows[1]).toHaveTextContent('conflict · 409');
    expect(rows[1]).toHaveTextContent('rows matched=0');
    expect(rows[1]).toHaveTextContent('guard matched 0 rows');
    expect(rows[0]).toHaveTextContent('rows matched=1');
    expect(screen.getByTestId('booking-race-success-count')).toHaveTextContent('1/3 booked');
  });

  it('an out-of-range stock disables the fire button with a visible reason', async () => {
    stubApiFetch([]);

    render(<BookingRaceDemo />);

    fireEvent.change(screen.getByTestId('booking-race-stock'), { target: { value: '100' } });

    expect(screen.getByTestId('booking-race-stock-invalid')).toHaveTextContent('between 0 and 99');
    expect(screen.getByTestId('booking-race-fire')).toBeDisabled();
  });

  it('degrades to a failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<BookingRaceDemo />);

    fireEvent.click(screen.getByTestId('booking-race-fire'));

    const failed = await screen.findByTestId('booking-race-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});
