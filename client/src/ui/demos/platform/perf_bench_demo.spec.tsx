import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PerfBenchDemo from './perf_bench_demo';
import { stubApiFetch, stubNetworkFailure, type StubRoute } from '../../../test/fetch_stub';

/**
 * The benchmark pair over a STUBBED API: the compressed fetch renders the
 * negotiated-encoding chip and the smaller (server-reported) wire size beside
 * the identity fetch's exact Content-Length; the benchmark renders the ratio
 * bars, the ms table, and the verdict. Wire bodies are stubbed as text with
 * headers — exactly the response surface the component reads.
 */

const PAYLOAD_COMPRESSED_URL = '/api/demo/perf/payload?size=medium';
const PAYLOAD_RAW_URL = '/api/demo/perf/payload?size=medium&noCompress=1';
const BENCHMARK_URL = '/api/demo/perf/benchmark?size=medium&runs=10';

const RAW_BYTES = 50_600;
const GZIP_BYTES = 1_800;

const BODY_TEXT = '{"kind":"telemetry-batch","size":"medium","readings":[/* … */]}';

function routes(overrides: StubRoute[] = []): StubRoute[] {
  return [
    {
      url: PAYLOAD_COMPRESSED_URL,
      text: BODY_TEXT,
      headers: {
        'content-encoding': 'gzip',
        'transfer-encoding': 'chunked',
        'x-payload-raw-bytes': String(RAW_BYTES),
        'x-payload-gzip-bytes': String(GZIP_BYTES),
      },
    },
    {
      url: PAYLOAD_RAW_URL,
      text: BODY_TEXT,
      headers: {
        'content-length': String(RAW_BYTES),
        'x-payload-raw-bytes': String(RAW_BYTES),
        'x-payload-gzip-bytes': String(GZIP_BYTES),
      },
    },
    {
      url: BENCHMARK_URL,
      body: {
        size: 'medium',
        runs: 10,
        bytesRaw: RAW_BYTES,
        bytesCompressed: GZIP_BYTES,
        ratio: 0.036,
        msRaw: 0.212,
        msCompressed: 0.981,
        note: 'medians of 10 in-process runs',
      },
    },
    ...overrides,
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PerfBenchDemo — the wire pair', () => {
  it('the compressed fetch shows the negotiated chip and the SMALLER wire size', async () => {
    stubApiFetch(routes());
    render(<PerfBenchDemo />);

    fireEvent.click(screen.getByTestId('perf-fetch-compressed'));
    const card = await screen.findByTestId('perf-wire-compressed', {}, { timeout: 4000 });
    expect(card).toHaveTextContent('gzip');
    expect(card).toHaveTextContent('wire ≈ 1.8 KB');
    expect(card).toHaveTextContent('decoded 50.6 KB');
    // The honesty note: the wire size is server-computed, not measured here.
    expect(card).toHaveTextContent('gzip size of the exact bytes served');
  });

  it('the raw fetch shows identity with the exact Content-Length', async () => {
    stubApiFetch(routes());
    render(<PerfBenchDemo />);

    fireEvent.click(screen.getByTestId('perf-fetch-raw'));
    const card = await screen.findByTestId('perf-wire-raw', {}, { timeout: 4000 });
    expect(card).toHaveTextContent('identity');
    expect(card).toHaveTextContent('wire = 50.6 KB');
    expect(card).toHaveTextContent('zero extra CPU');
  });

  it('the size picker switches the fetch URLs', async () => {
    stubApiFetch(
      routes([
        {
          url: '/api/demo/perf/payload?size=large',
          text: BODY_TEXT,
          headers: { 'content-encoding': 'br', 'x-payload-raw-bytes': '508000', 'x-payload-gzip-bytes': '16200' },
        },
      ]),
    );
    render(<PerfBenchDemo />);

    fireEvent.click(screen.getByTestId('perf-size-large'));
    expect(screen.getByTestId('perf-fetch-compressed')).toHaveTextContent('fetch compressed (large)');

    fireEvent.click(screen.getByTestId('perf-fetch-compressed'));
    const card = await screen.findByTestId('perf-wire-compressed', {}, { timeout: 4000 });
    expect(card).toHaveTextContent('br');
    expect(card).toHaveTextContent('wire ≈ 16.2 KB');
  });
});

describe('PerfBenchDemo — the ledger', () => {
  it('renders the ratio bars, the ms table, and the verdict with both trades named', async () => {
    stubApiFetch(routes());
    render(<PerfBenchDemo />);

    fireEvent.click(screen.getByTestId('perf-run-benchmark'));
    const bench = await screen.findByTestId('perf-benchmark', {}, { timeout: 4000 });

    expect(bench).toHaveTextContent('10 runs at medium');
    expect(screen.getByTestId('perf-ratio-bar')).toHaveTextContent('50.6 KB');
    expect(screen.getByTestId('perf-ratio-bar')).toHaveTextContent('1.8 KB');
    expect(screen.getByTestId('perf-ratio-bar').textContent?.includes('raw')).toBe(true);

    const msTable = screen.getByTestId('perf-ms-table');
    expect(msTable).toHaveTextContent('msRaw');
    expect(msTable).toHaveTextContent('0.212 ms');
    expect(msTable).toHaveTextContent('msCompressed');
    expect(msTable).toHaveTextContent('0.981 ms');

    const verdict = screen.getByTestId('perf-verdict');
    expect(verdict).toHaveTextContent('27.8×'); // 1 / 0.036, one decimal
    expect(verdict).toHaveTextContent('CPU');
  });

  it('the ratio bar widths shrink with the compressed bytes (the visual pair)', async () => {
    stubApiFetch(routes());
    render(<PerfBenchDemo />);

    fireEvent.click(screen.getByTestId('perf-run-benchmark'));
    await screen.findByTestId('perf-benchmark', {}, { timeout: 4000 });

    const bars = document.querySelectorAll('[data-testid="perf-ratio-bar"] div.h-3.rounded-sm.bg-secondary');
    const rawBars = document.querySelectorAll('[data-testid="perf-ratio-bar"] div.h-3.rounded-sm.bg-error');
    expect(rawBars[0]).toBeDefined();
    expect(bars[0]).toBeDefined();
    // The compressed bar is a FRACTION of the raw bar's width.
    const rawWidth = Number(rawBars[0]?.getAttribute('style')?.match(/width:\s*([\d.]+)%/)?.[1] ?? '0');
    const compressedWidth = Number(bars[0]?.getAttribute('style')?.match(/width:\s*([\d.]+)%/)?.[1] ?? '0');
    expect(rawWidth).toBe(100);
    expect(compressedWidth).toBeGreaterThan(1);
    expect(compressedWidth).toBeLessThan(10);
  });
});

describe('PerfBenchDemo — failure states', () => {
  it('degrades to the error strip when the server is unreachable', async () => {
    stubNetworkFailure();
    render(<PerfBenchDemo />);

    fireEvent.click(screen.getByTestId('perf-fetch-compressed'));
    const error = await screen.findByTestId('perf-error', {}, { timeout: 4000 });
    expect(error).toHaveTextContent('could not fetch the compressed payload');
  });

  it('a malformed benchmark report degrades instead of rendering nonsense', async () => {
    stubApiFetch([{ url: BENCHMARK_URL, body: { bytesRaw: 'not-a-number' } }]);
    render(<PerfBenchDemo />);

    fireEvent.click(screen.getByTestId('perf-run-benchmark'));
    const error = await screen.findByTestId('perf-error', {}, { timeout: 4000 });
    expect(error).toHaveTextContent('could not run the benchmark');
    expect(screen.queryByTestId('perf-benchmark')).toBeNull();
  });
});
