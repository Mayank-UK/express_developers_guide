import { useCallback, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `perf:bench` — the performance topic's benchmark pair.
 *
 * Two experiments over the SAME deterministic telemetry payload:
 * 1. THE WIRE — fetch it compressed (the browser negotiates br/gzip; the body
 *    arrives decompressed, but Content-Encoding and the server-reported gzip
 *    size tell the wire story) vs raw (?noCompress=1: identity, exact
 *    Content-Length). Same bytes both times, by construction.
 * 2. THE LEDGER — GET /benchmark: medians the server measured in-process
 *    (stringify alone vs stringify + gzip), byte counts, ratio — the honest
 *    CPU-for-bytes trade as a table.
 *
 * House honesty note: browsers decompress transparently, so the wire size for
 * the compressed fetch is the server-computed gzip size of the exact bytes it
 * served (x-payload-gzip-bytes) — labelled as such, never guessed.
 */

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

type PayloadSize = 'small' | 'medium' | 'large';

const SIZES: { id: PayloadSize; label: string; hint: string }[] = [
  { id: 'small', label: 'small', hint: '≈ 2 KB' },
  { id: 'medium', label: 'medium', hint: '≈ 50 KB' },
  { id: 'large', label: 'large', hint: '≈ 500 KB' },
];

interface WireResult {
  encoding: string; // 'gzip' | 'br' | 'identity'
  wireBytes: number; // exact for identity; server-computed gzip size when compressed
  wireSource: 'content-length' | 'gzip-header';
  decodedBytes: number;
  elapsedMs: number;
}

interface BenchResult {
  size: string;
  runs: number;
  bytesRaw: number;
  bytesCompressed: number;
  ratio: number;
  msRaw: number;
  msCompressed: number;
  note: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1000 * 1000) return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${String(Math.round(bytes))} B`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBenchmark(raw: unknown): BenchResult {
  if (
    !isRecord(raw) ||
    typeof raw.bytesRaw !== 'number' ||
    typeof raw.bytesCompressed !== 'number' ||
    typeof raw.ratio !== 'number' ||
    typeof raw.msRaw !== 'number' ||
    typeof raw.msCompressed !== 'number'
  ) {
    throw new Error('malformed benchmark report');
  }
  return {
    size: typeof raw.size === 'string' ? raw.size : '?',
    runs: typeof raw.runs === 'number' ? raw.runs : 0,
    bytesRaw: raw.bytesRaw,
    bytesCompressed: raw.bytesCompressed,
    ratio: raw.ratio,
    msRaw: raw.msRaw,
    msCompressed: raw.msCompressed,
    note: typeof raw.note === 'string' ? raw.note : '',
  };
}

async function fetchPayload(size: PayloadSize, noCompress: boolean): Promise<WireResult> {
  const url = `/api/demo/perf/payload?size=${size}${noCompress ? '&noCompress=1' : ''}`;
  const startedAt = performance.now();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const text = await response.text();
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;

  const encoding = response.headers.get('content-encoding') ?? 'identity';
  const rawReported = Number(response.headers.get('x-payload-raw-bytes') ?? '0');
  const decodedBytes = rawReported > 0 ? rawReported : text.length;

  if (encoding === 'identity') {
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    return {
      encoding,
      wireBytes: contentLength > 0 ? contentLength : decodedBytes,
      wireSource: 'content-length',
      decodedBytes,
      elapsedMs,
    };
  }
  const gzipBytes = Number(response.headers.get('x-payload-gzip-bytes') ?? '0');
  return {
    encoding,
    wireBytes: gzipBytes > 0 ? gzipBytes : decodedBytes,
    wireSource: 'gzip-header',
    decodedBytes,
    elapsedMs,
  };
}

function WireCard({
  title,
  testId,
  result,
  pending,
}: {
  title: string;
  testId: string;
  result: WireResult | null;
  pending: boolean;
}): ReactNode {
  return (
    <div data-testid={testId} className="flex flex-col gap-xxs rounded-md border border-outline p-sm">
      <div className="flex flex-wrap items-center gap-xs">
        <span className="text-body-sm font-semibold text-on-surface">{title}</span>
        {result !== null && (
          <span
            className={
              result.encoding === 'identity'
                ? CHIP
                : 'rounded-md border border-outline bg-secondary px-xs py-xxs font-mono text-caption font-semibold text-on-secondary'
            }
          >
            {result.encoding}
          </span>
        )}
      </div>
      {pending && <p className="text-caption text-on-surface-variant">fetching…</p>}
      {!pending && result === null && (
        <p className="text-caption text-on-surface-variant">not fetched yet</p>
      )}
      {!pending && result !== null && (
        <div className="flex flex-wrap gap-xs">
          <span className={CHIP_STRONG}>
            wire {result.wireSource === 'gzip-header' ? '≈' : '='} {formatBytes(result.wireBytes)}
          </span>
          <span className={CHIP}>decoded {formatBytes(result.decodedBytes)}</span>
          <span className={CHIP}>{String(result.elapsedMs)} ms</span>
        </div>
      )}
      {!pending && result !== null && result.wireSource === 'gzip-header' && (
        <p className="text-caption text-on-surface-variant">
          browsers decompress transparently — this is the gzip size of the exact bytes served
          (server-computed); br negotiates a little smaller still.
        </p>
      )}
      {!pending && result !== null && result.encoding === 'identity' && (
        <p className="text-caption text-on-surface-variant">
          identity: exact Content-Length, zero extra CPU — the before picture.
        </p>
      )}
    </div>
  );
}

export default function PerfBenchDemo(): ReactNode {
  const [size, setSize] = useState<PayloadSize>('medium');
  const [compressed, setCompressed] = useState<WireResult | null>(null);
  const [raw, setRaw] = useState<WireResult | null>(null);
  const [fetching, setFetching] = useState<'compressed' | 'raw' | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runFetch = useCallback(async (noCompress: boolean): Promise<void> => {
    setError(null);
    setFetching(noCompress ? 'raw' : 'compressed');
    try {
      const result = await fetchPayload(size, noCompress);
      if (noCompress) setRaw(result);
      else setCompressed(result);
    } catch {
      setError(`could not fetch the ${noCompress ? 'identity' : 'compressed'} payload — is the server running?`);
    } finally {
      setFetching(null);
    }
  }, [size]);

  const runBenchmark = useCallback(async (): Promise<void> => {
    setError(null);
    setBenchRunning(true);
    try {
      const response = await fetch(`/api/demo/perf/benchmark?size=${size}&runs=10`);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      setBench(parseBenchmark(await response.json()));
    } catch {
      setError('could not run the benchmark — is the server running?');
    } finally {
      setBenchRunning(false);
    }
  }, [size]);

  const barScale = bench === null || bench.bytesRaw === 0 ? 0 : 100;
  const compressedBarWidth =
    bench === null || bench.bytesRaw === 0 ? 0 : Math.max(1, (bench.bytesCompressed / bench.bytesRaw) * 100);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="perf-summary" className="text-body-sm text-on-surface">
        The same deterministic telemetry payload, two wire stories: fetch it compressed (the
        middleware negotiates br/gzip) and raw (<code className="font-mono">?noCompress=1</code>,
        identity with an exact Content-Length) — then run the server-side benchmark for the
        CPU-for-bytes ledger.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs" data-testid="perf-size-picker">
          {SIZES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-testid={`perf-size-${entry.id}`}
              onClick={() => setSize(entry.id)}
              className={size === entry.id ? BUTTON_PRIMARY : BUTTON}
            >
              {entry.label} ({entry.hint})
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-xs">
          <button
            type="button"
            data-testid="perf-fetch-compressed"
            className={BUTTON_PRIMARY}
            disabled={fetching !== null}
            onClick={() => void runFetch(false)}
          >
            {fetching === 'compressed' ? 'fetching…' : `fetch compressed (${size})`}
          </button>
          <button
            type="button"
            data-testid="perf-fetch-raw"
            className={BUTTON}
            disabled={fetching !== null}
            onClick={() => void runFetch(true)}
          >
            {fetching === 'raw' ? 'fetching…' : `fetch raw (${size})`}
          </button>
          <button
            type="button"
            data-testid="perf-run-benchmark"
            className={BUTTON_PRIMARY}
            disabled={benchRunning}
            onClick={() => void runBenchmark()}
          >
            {benchRunning ? 'running…' : 'run benchmark'}
          </button>
        </div>
        {error !== null && (
          <p data-testid="perf-error" className="text-caption text-error">
            {error}
          </p>
        )}
      </section>

      <div className="grid gap-sm sm:grid-cols-2">
        <WireCard title="compressed" testId="perf-wire-compressed" result={compressed} pending={fetching === 'compressed'} />
        <WireCard title="raw (identity)" testId="perf-wire-raw" result={raw} pending={fetching === 'raw'} />
      </div>

      {bench !== null && (
        <section data-testid="perf-benchmark" className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="text-body-sm font-semibold text-on-surface">
              the ledger — {String(bench.runs)} runs at {bench.size}
            </span>
            <span className={CHIP}>
              {formatBytes(bench.bytesRaw)} → {formatBytes(bench.bytesCompressed)}
            </span>
            <span className={CHIP_STRONG}>
              {String(Math.round((1 / bench.ratio) * 10) / 10)}× fewer bytes
            </span>
          </div>

          <div className="flex flex-col gap-xxs" data-testid="perf-ratio-bar">
            <div className="flex items-center gap-xs">
              <span className="w-16 font-mono text-caption text-on-surface-variant">raw</span>
              <div className="h-3 flex-1 rounded-sm bg-surface-variant">
                <div className="h-3 rounded-sm bg-error" style={{ width: `${String(barScale)}%` }} />
              </div>
              <span className="w-16 text-right font-mono text-caption text-on-surface">
                {formatBytes(bench.bytesRaw)}
              </span>
            </div>
            <div className="flex items-center gap-xs">
              <span className="w-16 font-mono text-caption text-on-surface-variant">gzip</span>
              <div className="h-3 flex-1 rounded-sm bg-surface-variant">
                <div className="h-3 rounded-sm bg-secondary" style={{ width: `${String(compressedBarWidth)}%` }} />
              </div>
              <span className="w-16 text-right font-mono text-caption text-on-surface">
                {formatBytes(bench.bytesCompressed)}
              </span>
            </div>
          </div>

          <table data-testid="perf-ms-table" className="w-fit font-mono text-caption text-on-surface">
            <tbody>
              <tr>
                <td className="pr-sm">msRaw</td>
                <td>{String(bench.msRaw)} ms</td>
                <td className="pl-sm text-on-surface-variant">JSON.stringify alone (median)</td>
              </tr>
              <tr>
                <td className="pr-sm">msCompressed</td>
                <td>{String(bench.msCompressed)} ms</td>
                <td className="pl-sm text-on-surface-variant">stringify + gzipSync (median)</td>
              </tr>
            </tbody>
          </table>

          <p data-testid="perf-verdict" className="text-caption text-on-surface">
            verdict: compression spent{' '}
            <strong>{String(Math.round((bench.msCompressed - bench.msRaw) * 1000) / 1000)} ms</strong>{' '}
            of CPU per response to move{' '}
            <strong>{String(Math.round((1 / bench.ratio) * 10) / 10)}× fewer bytes</strong> — a
            trade worth making for text this size, and worth measuring before making for payloads
            that are tiny or already compressed.
          </p>
        </section>
      )}
    </div>
  );
}
