import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import UuidStrategyDemo from './uuid_strategy_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const UUID_URL = '/api/demo/db/uuid';

const V4_AS_GENERATED = [
  '9f8e7d6c-1234-4a5b-8c9d-0a1b2c3d4e5f',
  '1a2b3c4d-5678-4e9f-abcd-ef0123456789',
  'f0e1d2c3-4567-498a-bcde-f1234567890a',
];
const V4_SORTED = [...V4_AS_GENERATED].sort();

const V7_AS_GENERATED = [
  '0192a7f0-3f2a-7abc-8def-0123456789ab',
  '0192a7f0-3f2b-7abc-8def-0123456789ab',
  '0192a7f0-3f2c-7abc-8def-0123456789ab',
];

function uuidBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    count: 3,
    v4: {
      asGenerated: V4_AS_GENERATED,
      sorted: V4_SORTED,
      sortsAsGenerated: false,
    },
    v7: {
      asGenerated: V7_AS_GENERATED,
      sorted: [...V7_AS_GENERATED], // identical — the whole point
      sortsAsGenerated: true,
    },
    explain: 'v7 = 48-bit unix-ms prefix + a per-ms monotonic counter, so ids compare in generation order.',
    ...overrides,
  };
}

describe('UuidStrategyDemo', () => {
  it('renders both batches with the order verdicts — v7 sorts as generated, v4 does not', async () => {
    stubApiFetch([{ url: `${UUID_URL}?count=12`, body: uuidBody() }]);

    render(<UuidStrategyDemo />);

    fireEvent.click(screen.getByTestId('uuid-strategy-generate'));

    await screen.findByTestId('uuid-strategy-v4');
    expect(screen.getByTestId('uuid-strategy-v4-order-chip')).toHaveTextContent('sorted ≠ generated');
    expect(screen.getByTestId('uuid-strategy-v4-as-generated')).toHaveTextContent(V4_AS_GENERATED[0]!);
    expect(screen.getByTestId('uuid-strategy-v4-as-generated')).toHaveTextContent(
      '9f8e7d6c-1234-4a5b-8c9d-0a1b2c3d4e5f',
    );
    // the sorted list leads with the smallest key, not the first-generated one
    expect(screen.getByTestId('uuid-strategy-v4-sorted')).toHaveTextContent(V4_SORTED[0]!);
    expect(V4_SORTED[0]).not.toBe(V4_AS_GENERATED[0]);

    expect(screen.getByTestId('uuid-strategy-v7-order-chip')).toHaveTextContent('sorted === generated');
    // whitespace-normalized textContent: assert each id, not the newline-joined block
    for (const id of V7_AS_GENERATED) {
      expect(screen.getByTestId('uuid-strategy-v7-as-generated')).toHaveTextContent(id);
      expect(screen.getByTestId('uuid-strategy-v7-sorted')).toHaveTextContent(id);
    }
    expect(screen.getByTestId('uuid-strategy-explain')).toHaveTextContent('48-bit unix-ms prefix');
  });

  it('a changed batch size is sent as ?count=', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: `${UUID_URL}?count=24`, body: uuidBody({ count: 24 }) }]);
      return vi.mocked(fetch);
    })();

    render(<UuidStrategyDemo />);

    fireEvent.change(screen.getByTestId('uuid-strategy-count'), { target: { value: '24' } });
    fireEvent.click(screen.getByTestId('uuid-strategy-generate'));

    expect(await screen.findByTestId('uuid-strategy-v7')).toBeInTheDocument();
    expect(screen.getByTestId('uuid-strategy-count-chip')).toHaveTextContent('24 ids per side');
    expect(fetchMock).toHaveBeenLastCalledWith(`${UUID_URL}?count=24`);
  });

  it('renders the failure panel when the server answers a non-uuid payload', async () => {
    stubApiFetch([
      {
        url: `${UUID_URL}?count=12`,
        status: 400,
        body: { error: { code: 'validation_failed', message: '"count" must be between 1 and 64' } },
      },
    ]);

    render(<UuidStrategyDemo />);

    fireEvent.click(screen.getByTestId('uuid-strategy-generate'));

    const failed = await screen.findByTestId('uuid-strategy-failed');
    expect(failed).toHaveTextContent('400');
    expect(failed).toHaveTextContent('validation_failed');
  });

  it('degrades to a failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<UuidStrategyDemo />);

    fireEvent.click(screen.getByTestId('uuid-strategy-generate'));

    const failed = await screen.findByTestId('uuid-strategy-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});
